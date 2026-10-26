import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { scanContent } from "../../packages/agent/src/hermes-memory/content-scanner.js";
import { normalizeMemoryLookupText } from "../../packages/agent/src/hermes-memory/memory-lookup.js";
import { fail, type Row, type Tx } from "./db.js";
import { checkpointAutomation } from "./automations.js";
import { callerRun, createTask } from "./agents.js";
import type { LlmClaims } from "./security.js";
import type { Hub } from "./hub.js";

export const memoryKey = (text: string) =>
  createHash("sha256")
    .update(
      normalizeMemoryLookupText(text)
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .toLowerCase(),
    )
    .digest("hex");
export const memoryRequest = z
  .object({
    run_id: z.string().uuid(),
    action: z.enum(["list", "search", "save", "correct", "delete"]),
    query: z.string().max(200).optional(),
    memory_id: z.string().uuid().optional(),
    content: z.string().trim().min(1).max(2000).optional(),
    kind: z.enum(["fact", "conclusion"]).default("fact"),
    certainty: z.enum(["explicit", "inference"]).default("inference"),
    expected_revision: z.number().int().positive().optional(),
  })
  .strict();
const view = (r: Row) => ({
  id: r.memory_id,
  kind: r.kind,
  content: r.content,
  certainty: r.certainty,
  revision: r.revision,
  source_message_id: r.source_message_id,
  source_task_id: r.source_task_id,
  updated_at: r.updated_at,
});
export const searchTerms = (q: string) =>
  q.trim().split(/\s+/).filter(Boolean).slice(0, 8);
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/** Tombstones are deliberately permanent: background learning cannot re-add forgotten facts. */
export async function saveMemory(
  tx: Tx,
  botId: string,
  data: {
    content: string;
    kind: "fact" | "conclusion";
    certainty: "explicit" | "inference";
    messageId?: string;
    taskId?: string;
    runId?: string;
    background?: boolean;
  },
) {
  const content = data.content.trim();
  if (!content || content.length > 2000 || scanContent(content)) return null;
  const key = memoryKey(content);
  const existing = await tx.one(
    "SELECT * FROM memory_entries WHERE bot_id=$1 AND memory_key=$2",
    [botId, key],
  );
  if (existing) return existing.deleted ? null : view(existing);
  const r = await tx.one(
    `INSERT INTO memory_entries(memory_id,bot_id,memory_key,kind,content,certainty,source_message_id,source_task_id,source_run_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(bot_id,memory_key) DO NOTHING RETURNING *`,
    [
      randomUUID(),
      botId,
      key,
      data.kind,
      content,
      data.certainty,
      data.messageId ?? null,
      data.taskId ?? null,
      data.runId ?? null,
    ],
  );
  if (r && !data.background)
    await tx.rows(
      "UPDATE bots SET knowledge_dirty=true,knowledge_revision=knowledge_revision+1 WHERE bot_id=$1",
      [botId],
    );
  return r ? view(r) : null;
}

export async function manageMemory(
  tx: Tx,
  userId: string,
  claims: LlmClaims,
  body: z.infer<typeof memoryRequest>,
) {
  const run = await callerRun(tx, userId, claims, body.run_id);
  if (run.automation_readonly && !["list", "search"].includes(body.action)) fail(403, "当前轮次只能读取记忆");
  await tx.one("SELECT bot_id FROM bots WHERE bot_id=$1 FOR NO KEY UPDATE", [
    run.bot_id,
  ]);
  if (body.action === "list" || body.action === "search") {
    const terms = searchTerms(body.query ?? "").map(
      (x) => `%${escapeLike(x)}%`,
    );
    return {
      memories: (
        await tx.rows(
          `SELECT * FROM memory_entries WHERE bot_id=$1 AND NOT deleted
      AND ($2::text[]='{}' OR content ILIKE ANY($2)) ORDER BY (certainty='explicit') DESC,updated_at DESC LIMIT 30`,
          [run.bot_id, terms],
        )
      ).map(view),
    };
  }
  if (body.action === "correct" || body.action === "delete") {
    if (!body.memory_id || !body.expected_revision)
      fail(422, "请提供 memory_id 和 expected_revision");
    const old = await tx.one(
      "SELECT * FROM memory_entries WHERE bot_id=$1 AND memory_id=$2 FOR UPDATE",
      [run.bot_id, body.memory_id],
    );
    if (!old || old.deleted) fail(404, "记忆不存在");
    if (old!.revision !== body.expected_revision)
      fail(409, "记忆已变化，请重新读取");
    if (body.action === "correct" && !body.content)
      fail(422, "请提供纠正后的内容");
    if (body.content && scanContent(body.content))
      fail(422, "记忆包含凭据或不安全内容");
    if (
      body.action === "correct" &&
      memoryKey(body.content!) === old!.memory_key
    )
      return view(old!);
    // Lock the bot above, then retire the old fact before inserting the replacement.
    await tx.rows(
      "UPDATE memory_entries SET deleted=true,revision=revision+1,updated_at=now() WHERE memory_id=$1",
      [old!.memory_id],
    );
    await tx.rows(
      "UPDATE bots SET knowledge_dirty=true,knowledge_revision=knowledge_revision+1 WHERE bot_id=$1",
      [run.bot_id],
    );
    // A cached summary may still contain the old fact. Rebuild from raw history instead.
    await tx.rows(
      "UPDATE bot_memories SET summary='',through_seq=0,lease_owner=NULL,lease_until=NULL,retry_after=now(),learn_lease_owner=NULL,learn_lease_until=NULL WHERE bot_id=$1",
      [run.bot_id],
    );
    if (body.action === "delete") return { deleted: true };
  }
  if (!body.content) fail(422, "请提供记忆内容");
  if (scanContent(body.content!)) fail(422, "记忆包含凭据或不安全内容");
  const question = await tx.get("bot_messages", run.user_message_id);
  const certainty =
    question.visibility === "public" && run.origin === "user"
      ? body.certainty
      : "inference";
  const saved = await saveMemory(tx, run.bot_id, {
    content: body.content!,
    kind: body.kind,
    certainty,
    messageId: run.user_message_id,
    taskId: run.task_id ?? undefined,
    runId: run.run_id,
  });
  if (!saved) fail(409, "该记忆已被遗忘，不能自动重新写入");
  return saved;
}

export async function privateMemoryContext(tx: Tx, botId: string) {
  const rows = await tx.rows(
    "SELECT * FROM memory_entries WHERE bot_id=$1 AND NOT deleted ORDER BY (certainty='explicit') DESC,updated_at DESC LIMIT 40",
    [botId],
  );
  return rows
    .map(
      (r) =>
        `[${r.memory_id}; ${r.certainty}; ${new Date(r.updated_at).toISOString()}] ${r.content}`,
    )
    .join("\n")
    .slice(0, 8000);
}
export async function forgottenContext(tx: Tx, botId: string) {
  return (
    await tx.rows(
      "SELECT content FROM memory_entries WHERE bot_id=$1 AND deleted ORDER BY updated_at DESC LIMIT 100",
      [botId],
    )
  ).map((r) => r.content);
}
export async function searchHistory(
  tx: Tx,
  userId: string,
  claims: LlmClaims,
  runId: string,
  query: string,
) {
  const run = await callerRun(tx, userId, claims, runId);
  const forgotten = await forgottenContext(tx, run.bot_id);
  const rows = await tx.rows(
    `SELECT m.message_id,m.run_id,m.role,m.content,m.created_at,r.task_id FROM bot_messages m
    LEFT JOIN bot_runs r USING(run_id) WHERE m.bot_id=$1 AND m.status IN ('completed','cancelled') AND m.content<>''
    AND (m.visibility='public' OR (m.visibility='task' AND r.lane='task'))
    AND NOT EXISTS(SELECT 1 FROM memory_entries e WHERE e.bot_id=m.bot_id AND e.deleted AND (e.source_message_id=m.message_id OR e.source_task_id=r.task_id))
    AND ($2::text[]='{}' OR m.content ILIKE ANY($2)) ORDER BY m.seq DESC LIMIT 30`,
    [run.bot_id, searchTerms(query).map((x) => `%${escapeLike(x)}%`)],
  );
  return {
    matches: rows.map((r) => ({
      ...r,
      content: maskForgotten(r.content, forgotten).slice(0, 4000),
    })),
  };
}
export function maskForgotten(content: string, forgotten: string[]) {
  for (const fact of forgotten)
    content = content.replaceAll(fact, "[已遗忘的记忆]");
  return content;
}

export async function directory(
  tx: Tx,
  userId: string,
  selfId: string,
  query = "",
  limit = 20,
) {
  const terms = searchTerms(query).map((x) => `%${escapeLike(x)}%`);
  return tx.rows(
    `SELECT b.bot_id AS id,b.name,left(b.persona,400) AS responsibility,b.knowledge_topics AS topics,b.knowledge_updated_at AS updated_at,
    coalesce((SELECT jsonb_agg(jsonb_build_object('name',s.name,'description',left(s.description,160))) FROM bot_skills s
      WHERE s.bot_id=b.bot_id AND s.enabled AND NOT s.deleted),'[]') AS skills
    FROM bots b WHERE b.user_id=$1 AND b.bot_id<>$2 AND b.archived_at IS NULL
    AND ($3::text[]='{}' OR concat_ws(' ',b.name,b.persona,array_to_string(b.knowledge_topics,' ')) ILIKE ANY($3)
      OR EXISTS(SELECT 1 FROM bot_skills s WHERE s.bot_id=b.bot_id AND s.enabled AND NOT s.deleted AND concat_ws(' ',s.name,s.description) ILIKE ANY($3)))
    ORDER BY (SELECT count(*) FROM unnest($3::text[]) term WHERE concat_ws(' ',b.name,b.persona,array_to_string(b.knowledge_topics,' ')) ILIKE term) DESC,
      b.knowledge_updated_at DESC NULLS LAST,b.last_active_at DESC,b.bot_id LIMIT $4`,
    [userId, selfId, terms, limit],
  );
}

const lines = z.array(z.string().max(1000)).max(20).default([]);
export const checkpointSchema = z
  .object({
    goal: z.string().max(2000),
    completed: lines,
    findings: lines,
    artifacts: lines,
    blockers: lines,
    next_steps: lines,
  })
  .strict();
export async function checkpoint(
  tx: Tx,
  userId: string,
  claims: LlmClaims,
  runId: string,
  data: z.infer<typeof checkpointSchema>,
  version: number,
) {
  const run = await callerRun(tx, userId, claims, runId);
  if (run.origin === "automation") return checkpointAutomation(tx, run, data, version);
  if (run.lane !== "task" || !run.task_id)
    fail(422, "只有任务执行方可以保存检查点");
  const r = await tx.one(
    `UPDATE agent_tasks SET checkpoint=$3,checkpoint_version=checkpoint_version+1,updated_at=now()
    WHERE task_id=$1 AND target_bot_id=$2 AND checkpoint_version=$4 RETURNING checkpoint_version`,
    [
      run.task_id,
      run.bot_id,
      JSON.stringify({
        ...data,
        run_id: runId,
        saved_at: new Date().toISOString(),
      }),
      version,
    ],
  );
  if (!r) fail(409, "检查点版本已变化，请先查询任务");
  return r;
}
export async function resumeTask(
  tx: Tx,
  hub: Hub,
  userId: string,
  claims: LlmClaims,
  body: { run_id: string; task_id: string; request_id: string; text?: string },
  settings?:import("./config.js").Settings,
) {
  const parent = await callerRun(tx, userId, claims, body.run_id);
  if (parent.lane !== "conversation") fail(422, "请由对话通道续接任务");
  const old = await tx.one(
    "SELECT * FROM agent_tasks WHERE task_id=$1 AND user_id=$2 AND parent_bot_id=$3 FOR NO KEY UPDATE",
    [body.task_id, userId, parent.bot_id],
  );
  if (!old) fail(404, "任务不存在");
  if (!["completed", "failed", "cancelled"].includes(old!.status))
    fail(409, "任务仍在运行，请追加要求");
  const instructions = await tx.rows(
    "SELECT text FROM agent_task_instructions WHERE task_id=$1 ORDER BY created_at,instruction_id",
    [old!.task_id],
  );
  const task = `继续原任务，先核实已完成操作和当前执行环境；未确认的外部操作状态未知，不得直接重复提交，旧审批不继承。\n原目标：${old!.task}\n最近检查点：${JSON.stringify(old!.checkpoint)}\n已有结果：${String(old!.result ?? "").slice(0, 12000)}\n补充要求：${instructions.map((x) => x.text).join("\n")}\n本次要求：${body.text ?? "继续完成"}`;
  return createTask(tx, hub, userId, claims, {
    run_id: parent.run_id,
    agent: old!.target_bot_id,
    kind: old!.kind,
    task: task.slice(0, 40000),
    wait: false,
    title: `续接：${old!.title}`.slice(0, 80),
    request_id: body.request_id,
    resumed_from: old!.task_id,
    execution: old!.execution,
    device_id:old!.device_id,
    operation_target:old!.operation_target,
  },settings);
}
