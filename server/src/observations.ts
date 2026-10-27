import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database, Row, Tx } from "./db.js";
import type { Settings } from "./config.js";

export const stableId = (value: string) => {
  const h = createHash("sha256").update(value).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
export const spanId = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);
export const traceId = (value: string) => value.replaceAll("-", "");
const timestamp = z.string().datetime();
export const observationSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().max(100),
    tool_call_id: z.string().max(200),
    generation_id: z.string().uuid().optional(),
    started_at: timestamp,
    ended_at: timestamp,
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.boolean().optional(),
    incomplete: z.boolean().optional(),
    phase: z.enum(["start", "end"]).optional(),
  })
  .strict();
const SENSITIVE =
  /authorization|cookie|password|passwd|secret|(?:^|[_-])token$|api[_-]?key|access[_-]?key|credential/i;
export function sanitize(
  value: unknown,
  secrets: string[] = [],
  depth = 0,
): unknown {
  if (depth > 15) return "[depth limit]";
  if (typeof value === "string") {
    let text = value
      .replace(/data:[^\s"']+;base64,[A-Za-z0-9+/=]+/g, "[binary omitted]")
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .replace(/\b(?:sk-|pk-lf-|ghp_|xoxb-)[A-Za-z0-9_-]{8,}/g, "[redacted]")
      .replace(
        /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g,
        "[private key omitted]",
      )
      .replace(
        /((?:password|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*)[^\s,;"']+/gi,
        "$1[redacted]",
      );
    for (const secret of secrets)
      if (secret.length >= 6) text = text.replaceAll(secret, "[redacted]");
    const bytes = Buffer.from(text);
    return bytes.length > 65536
      ? bytes.subarray(0, 65536).toString("utf8") + "\n[truncated]"
      : text;
  }
  if (Array.isArray(value))
    return value.slice(0, 100).map((x) => sanitize(x, secrets, depth + 1));
  if (value && typeof value === "object") {
    const media = value as Row;
    const binary =
      /^(?:image|input_image|audio|input_audio|file|input_file|base64|buffer)$/i.test(
        String(media.type ?? ""),
      ) ||
      /^(?:image|audio|video|application)\//.test(
        String(media.mimeType ?? media.mime_type ?? media.media_type ?? ""),
      );
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([k, v]) => [
          k,
          SENSITIVE.test(k)
            ? "[redacted]"
            : /^(?:file_data|b64_json|bytes)$/.test(k) ||
                (binary && /^(?:data|buffer|audio)$/.test(k))
              ? "[binary omitted]"
              : sanitize(v, secrets, depth + 1),
        ]),
    );
  }
  return value;
}
export function bounded(value: unknown, secrets: string[] = []): unknown {
  const clean = sanitize(value, secrets);
  const text = JSON.stringify(clean ?? null);
  return Buffer.byteLength(text) > 65536
    ? {
        truncated: true,
        preview: Buffer.from(text).subarray(0, 65000).toString("utf8"),
      }
    : clean;
}
export async function enqueue(tx: Tx, id: string, payload: Row) {
  // Savepoints keep optional diagnostic failures from poisoning business transactions.
  await tx.rows("SAVEPOINT observation_write");
  try {
    await tx.rows(
      "INSERT INTO observation_outbox(event_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [id, JSON.stringify(payload)],
    );
    await tx.rows("RELEASE SAVEPOINT observation_write");
  } catch {
    await tx.rows("ROLLBACK TO SAVEPOINT observation_write");
    await tx.rows("RELEASE SAVEPOINT observation_write");
  }
}
export function observationBody(
  run: Row,
  id: string,
  name: string,
  start: Date,
  end: Date,
  input: unknown,
  output: unknown,
  extra: Row = {},
) {
  return {
    id,
    traceId: traceId(run.trace_id ?? run.run_id),
    name,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    input: bounded(input),
    output: bounded(output),
    metadata: {
      user_id: run.user_id,
      bot_id: run.bot_id,
      run_id: run.run_id,
      task_id: run.task_id ?? null,
      executor: run.executor,
      ...extra.metadata,
    },
    ...extra,
  };
}
export async function recordRun(tx: Tx, run: Row, enabled: boolean) {
  if (!enabled) return;
  await tx.rows("SAVEPOINT optional_run_observation");
  try {
    await recordRunData(tx, run);
    await tx.rows("RELEASE SAVEPOINT optional_run_observation");
  } catch {
    await tx.rows("ROLLBACK TO SAVEPOINT optional_run_observation");
    await tx.rows("RELEASE SAVEPOINT optional_run_observation");
  }
}
async function recordRunData(tx: Tx, run: Row) {
  const pending = await tx.rows(
    "SELECT payload FROM observation_tool_receipts WHERE run_id=$1 AND NOT terminal",
    [run.run_id],
  );
  for (const r of pending)
    await recordObservation(
      tx,
      run,
      {
        ...r.payload,
        phase: "end",
        ended_at: new Date(run.finished_at ?? Date.now()).toISOString(),
        incomplete: true,
        error: true,
      },
      true,
    );
  const question = await tx.get("bot_messages", run.user_message_id);
  const reply = await tx.get("bot_messages", run.assistant_message_id);
  const task = run.task_id ? await tx.get("agent_tasks", run.task_id) : null;
  const previous = task?.resumed_from
    ? await tx.one(
        "SELECT r.trace_id FROM agent_tasks t JOIN bot_runs r ON r.run_id=t.parent_run_id WHERE t.task_id=$1",
        [task.resumed_from],
      )
    : null;
  const body = observationBody(
    run,
    spanId(run.run_id),
    `Bot run (${run.lane})`,
    new Date(run.started_at ?? run.created_at),
    new Date(run.finished_at ?? Date.now()),
    question?.content,
    reply?.content,
    {
      parentObservationId: run.parent_run_id
        ? spanId(
            task?.request_id
              ? `${run.parent_run_id}:${task.request_id}`
              : run.parent_run_id,
          )
        : undefined,
      level:
        run.status === "failed"
          ? "ERROR"
          : run.status === "cancelled"
            ? "WARNING"
            : "DEFAULT",
      statusMessage: run.error ?? run.status,
      metadata: {
        user_id: run.user_id,
        bot_id: run.bot_id,
        run_id: run.run_id,
        task_id: run.task_id,
        executor: run.executor,
        resumed_from: task?.resumed_from ?? null,
        resumed_from_trace_id: previous?.trace_id
          ? traceId(previous.trace_id)
          : null,
        first_reply_ms: run.first_reply_at ? new Date(run.first_reply_at).getTime() - new Date(run.created_at).getTime() : null,
        reply_generation_ms: run.first_reply_generation_ms ?? null,
        reply_delivery_overhead_ms: run.first_reply_at && run.first_reply_generation_ms != null ? Math.max(0, new Date(run.first_reply_at).getTime() - new Date(run.started_at ?? run.created_at).getTime() - run.first_reply_generation_ms) : null,
        incomplete: run.status !== "completed",
      },
    },
  );
  await enqueue(tx, stableId(`run:${run.run_id}`), {
    type: "span-create",
    body,
  });
  if (run.trace_id === run.run_id)
    await enqueue(tx, stableId(`trace:${run.trace_id}`), {
      type: "trace-create",
      body: {
        id: traceId(run.trace_id),
        name: "Pi Bot",
        userId: run.user_id,
        sessionId: run.bot_id,
        input: bounded(question?.content),
        output: bounded(reply?.content),
        timestamp: run.created_at,
        metadata: { run_id: run.run_id },
      },
    });
}
export async function recordObservation(
  tx: Tx,
  run: Row,
  event: unknown,
  enabled: boolean,
) {
  if (!enabled) return;
  const parsed = observationSchema.safeParse(event);
  if (!parsed.success) return;
  const e = parsed.data;
  const start = new Date(e.started_at),
    end = new Date(e.ended_at);
  if (e.phase === "start") {
    await tx.rows(
      "INSERT INTO observation_tool_receipts(run_id,tool_call_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [
        run.run_id,
        e.tool_call_id,
        JSON.stringify({ ...e, input: bounded(e.input) }),
      ],
    );
    return;
  }
  const receipt = await tx.one(
    `INSERT INTO observation_tool_receipts(run_id,tool_call_id,terminal,payload) VALUES($1,$2,true,$3)
    ON CONFLICT(run_id,tool_call_id) DO UPDATE SET terminal=true,payload=EXCLUDED.payload WHERE NOT observation_tool_receipts.terminal RETURNING tool_call_id`,
    [run.run_id, e.tool_call_id, JSON.stringify({ name: e.name })],
  );
  if (!receipt) return;
  // The authenticated run supplies ownership/trace IDs; client metadata cannot override them.
  const body = observationBody(
    run,
    spanId(`${run.run_id}:${e.tool_call_id}`),
    `Tool: ${e.name}`,
    start,
    end,
    e.input,
    e.output,
    {
      parentObservationId: e.generation_id
        ? spanId(`${run.run_id}:generation:${e.generation_id}`)
        : spanId(run.run_id),
      level: e.error ? "ERROR" : "DEFAULT",
      statusMessage: e.incomplete
        ? "incomplete"
        : e.error
          ? "failed"
          : "completed",
      metadata: {
        user_id: run.user_id,
        bot_id: run.bot_id,
        run_id: run.run_id,
        task_id: run.task_id,
        executor: run.executor,
        incomplete: !!e.incomplete,
      },
    },
  );
  await enqueue(tx, stableId(`tool:${run.run_id}:${e.tool_call_id}`), {
    type: "span-create",
    body,
  });
}
export async function recordGeneration(
  db: Database,
  s: Settings,
  run: Row,
  data: {
    id: string;
    parentTool?: string;
    started: Date;
    firstToken?: Date;
    input: unknown;
    output: unknown;
    usage?: Row | null;
    error?: string;
    model: Row;
    secrets?: string[];
  },
) {
  if (!s.tracingEnabled) return;
  const body = observationBody(
    run,
    spanId(`${run.run_id}:generation:${data.id}`),
    "LLM Call",
    data.started,
    new Date(),
    bounded(data.input, data.secrets),
    bounded(data.output, data.secrets),
    {
      parentObservationId: spanId(
        data.parentTool ? `${run.run_id}:${data.parentTool}` : run.run_id,
      ),
      model: data.model.provider_model,
      completionStartTime: data.firstToken?.toISOString(),
      usage: data.usage
        ? { input: data.usage.input, output: data.usage.output }
        : undefined,
      level: data.error ? "ERROR" : "DEFAULT",
      statusMessage: data.error,
      metadata: {
        user_id: run.user_id,
        bot_id: run.bot_id,
        run_id: run.run_id,
        task_id: run.task_id,
        executor: run.executor,
        price_status: "unknown",
        cache_read_tokens: data.usage?.cached ?? null,
        reasoning_tokens: data.usage?.reasoning ?? null,
      },
    },
  );
  await db
    .tx((tx) =>
      enqueue(tx, stableId(`generation:${run.run_id}:${data.id}`), {
        type: "generation-create",
        body,
      }),
    )
    .catch(() => {});
}
export async function recordMaintenance(
  db: Database,
  s: Settings,
  data: {
    id: string;
    bot: Row;
    started: Date;
    name: string;
    input: unknown;
    output: unknown;
    error?: string;
    model: Row;
    usage?: Row | null;
  },
) {
  if (!s.tracingEnabled) return;
  const run = {
    run_id: data.id,
    trace_id: data.id,
    user_id: data.bot.user_id,
    bot_id: data.bot.bot_id,
    executor: "cloud",
  };
  await db
    .tx(async (tx) => {
      await enqueue(tx, stableId(`maintenance:${data.id}`), {
        type: "trace-create",
        body: {
          id: traceId(data.id),
          name: data.name,
          userId: run.user_id,
          sessionId: run.bot_id,
          timestamp: data.started.toISOString(),
          metadata: { bot_id: run.bot_id, job_type: data.name },
        },
      });
      await enqueue(tx, stableId(`maintenance-span:${data.id}`), {
        type: "span-create",
        body: observationBody(
          run,
          spanId(data.id),
          data.name,
          data.started,
          new Date(),
          data.input,
          data.output,
          { level: data.error ? "ERROR" : "DEFAULT" },
        ),
      });
    })
    .catch(() => {});
  await recordGeneration(db, s, run, {
    id: data.id,
    started: data.started,
    input: data.input,
    output: data.output,
    model: data.model,
    usage: data.usage,
    error: data.error,
  });
}
