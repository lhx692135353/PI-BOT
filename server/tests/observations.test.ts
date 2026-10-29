import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { Database } from "../src/db.js";
import { settings } from "../src/config.js";
import { issueLlmToken } from "../src/security.js";
import { buildContext, finishRun } from "../src/bots.js";
import { createRunner } from "../src/runner.js";
import { Executor } from "../../desktop/packages/service/src/executor.js";
import { handleRunEvent } from "../src/runs.js";
import { Hub } from "../src/hub.js";
import { ObservationExporter } from "../src/langfuse-exporter.js";
import {
  bounded,
  sanitize,
  recordObservation,
  stableId,
  spanId,
} from "../src/observations.js";
import {
  TEST_DB,
  resetDatabase,
  tempDir,
  vaultFile,
  mockProvider,
  eventually,
} from "./helpers.js";

const skip = !TEST_DB && "需要独立 PI_BOT_TEST_DATABASE_URL";
let app: Awaited<ReturnType<typeof createApp>>,
  db: Database,
  s: ReturnType<typeof settings>,
  dir: ReturnType<typeof tempDir>,
  provider: Awaited<ReturnType<typeof mockProvider>>;
let token: string, userId: string, bot: string, run: string;
async function api(
  path: string,
  body: object,
  bearer = token,
  headers: Record<string, string> = {},
) {
  const r = await app.inject({
    method: "POST",
    url: path,
    headers: { authorization: `Bearer ${bearer}`, ...headers },
    payload: body,
  });
  return { status: r.statusCode, data: r.json() };
}
before(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!);
  dir = tempDir();
  provider = await mockProvider();
  s = settings({
    PI_BOT_DATABASE_URL: TEST_DB,
    PI_BOT_ADMIN_PASSWORD: "admin-password",
    PI_BOT_JWT_SECRET: "j".repeat(40),
    PI_BOT_VAULT_FILE: vaultFile(dir.path),
    LANGFUSE_TRACING_ENABLED: "true",
  });
  db = new Database(TEST_DB!);
  app = await createApp(s, db);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const login = await api(
    "/auth/login",
    { username: "admin", password: "admin-password" },
    "",
  );
  token = login.data.access_token;
  userId = login.data.user.id;
  await api("/admin/api/models", {
    name: "test",
    base_url: provider.url,
    provider_model: "test",
    api_key: "sk-private-provider-value",
    context_window: 32000,
    max_tokens: 2000,
  });
  bot = (await api("/bots", { name: "追踪测试" })).data.id;
  run = (
    await api(`/bots/${bot}/messages`, {
      text: "模型追踪",
      request_id: randomUUID(),
    })
  ).data.run.id;
  await db.tx(async (tx) => buildContext(tx, s, await tx.get("bot_runs", run)));
});
after(async () => {
  if (skip) return;
  await app?.close();
  await provider?.close();
  dir?.cleanup();
});

test("cloud sanitizer removes credentials and binary data and bounds Chinese payloads", () => {
  const v = sanitize({
    authorization: "Bearer abc",
    secret_key: "private",
    input_tokens: 123,
    image: {
      type: "image",
      mimeType: "image/png",
      data: "RAW-IMAGE-BASE64",
      width: 100,
    },
    file: {
      type: "input_file",
      file_data: "RAW-FILE-BASE64",
      filename: "notes.pdf",
    },
    body: "password=abcdefgh sk-abcdefghijklmnopqrstuvwxyz data:image/png;base64,YWJjZA==",
  });
  const text = JSON.stringify(v);
  assert.ok(!text.includes("abcdefgh"));
  assert.ok(!text.includes("YWJjZA"));
  assert.equal((v as any).input_tokens, 123);
  assert.ok(!text.includes("RAW-IMAGE-BASE64"));
  assert.ok(!text.includes("RAW-FILE-BASE64"));
  assert.equal((v as any).image.width, 100);
  assert.equal((v as any).file.filename, "notes.pdf");
  assert.equal((bounded("中".repeat(80000)) as any).truncated, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(bounded("中".repeat(80000)))) < 66000,
  );
});

test(
  "proxy owns model spans, validates run identity and never forwards correlation headers",
  { skip },
  async () => {
    const bearer = await issueLlmToken({ sub: userId, src: "cloud", bot }, s);
    const model = (await db.tx((tx) =>
      tx.one("SELECT model_id FROM models LIMIT 1"),
    ))!.model_id;
    const generation = randomUUID();
    const r = await api(
      "/llm/v1/responses",
      { model, input: [{ role: "user", content: "回答问题" }], stream: false },
      bearer,
      { "x-pibot-run-id": run, "x-pibot-generation-id": generation },
    );
    assert.equal(r.status, 200, JSON.stringify(r));
    const upstream = provider.requests.at(-1)!;
    assert.equal(upstream.headers["x-pibot-run-id"], undefined);
    assert.equal(upstream.headers["x-pibot-generation-id"], undefined);
    const queued = await eventually(async () => {
      const rows = await db.tx((tx) =>
        tx.rows(
          "SELECT payload FROM observation_outbox WHERE payload->>'type'='generation-create'",
        ),
      );
      return rows.length ? rows : false;
    });
    assert.equal(queued.length, 1);
    assert.equal(
      queued[0].payload.body.id,
      spanId(`${run}:generation:${generation}`),
    );
    assert.ok(!JSON.stringify(queued).includes("sk-private-provider-value"));
    const other = (await api("/bots", { name: "另一 Bot" })).data.id;
    const wrong = await issueLlmToken(
      { sub: userId, src: "cloud", bot: other },
      s,
    );
    assert.equal(
      (
        await api("/llm/v1/responses", { model, input: "x" }, wrong, {
          "x-pibot-run-id": run,
          "x-pibot-generation-id": randomUUID(),
        })
      ).status,
      404,
    );
  },
);

test(
  "reordered/duplicate tools use stable IDs; parallel same-bot runs have independent spans and trace ancestry",
  { skip },
  async () => {
    const first = await db.tx((tx) => tx.get("bot_runs", run));
    const timestamp = new Date().toISOString();
    const event = {
      id: randomUUID(),
      name: "memory_manage",
      tool_call_id: "call-1",
      started_at: timestamp,
      ended_at: timestamp,
      input: { secret_key: "hidden" },
      output: { content: "safe" },
      phase: "end",
    };
    await db.tx(async (tx) => {
      await recordObservation(tx, first, event, true);
      await recordObservation(tx, first, event, true);
      await recordObservation(
        tx,
        first,
        { ...event, phase: "start", incomplete: true },
        true,
      );
    });
    const tools = await db.tx((tx) =>
      tx.rows(
        "SELECT * FROM observation_outbox WHERE payload->'body'->>'name'='Tool: memory_manage'",
      ),
    );
    assert.equal(tools.length, 1);
    await db.tx((tx) =>
      recordObservation(
        tx,
        first,
        {
          ...event,
          tool_call_id: "unfinished",
          phase: "start",
          incomplete: true,
        },
        true,
      ),
    );
    const bearer = await issueLlmToken({ sub: userId, src: "cloud", bot }, s);
    const jobs: Record<string, any>[] = [];
    for (const id of ["tool-start-a", "tool-start-b"]) {
      const r = await api(
        "/agent/tasks",
        {
          run_id: run,
          kind: "background",
          execution: "cloud",
          wait: false,
          task: "后台检查",
          request_id: id,
        },
        bearer,
      );
      assert.equal(r.status, 200);
      jobs.push(await db.tx((tx) => tx.get("agent_tasks", r.data.id)));
    }
    const children = await db.tx((tx) =>
      tx.rows("SELECT * FROM bot_runs WHERE run_id=ANY($1)", [
        jobs.map((x) => x.child_run_id),
      ]),
    );
    assert.equal(children.length, 2);
    assert.equal(children[0].trace_id, first.trace_id);
    assert.notEqual(spanId(children[0].run_id), spanId(children[1].run_id));
    await db.tx((tx) => finishRun(tx, run, "completed", null, "最终结果"));
    const root = await db.tx((tx) =>
      tx.one("SELECT payload FROM observation_outbox WHERE event_id=$1", [
        stableId(`run:${run}`),
      ]),
    );
    assert.equal(root?.payload.body.output, "最终结果");
    const incomplete = await db.tx((tx) =>
      tx.one("SELECT payload FROM observation_outbox WHERE event_id=$1", [
        stableId(`tool:${run}:unfinished`),
      ]),
    );
    assert.equal(incomplete?.payload.body.metadata.incomplete, true);
  },
);

test(
  "official SDK exports only from Worker, retries failures durably and survives restart",
  { skip },
  async () => {
    const failed = new ObservationExporter(db, s, {}, async () => {
      throw new Error("unavailable");
    });
    await failed.flush();
    let rows = await db.tx((tx) => tx.rows("SELECT * FROM observation_outbox"));
    assert.ok(rows.length > 0);
    assert.ok(rows.every((x) => x.attempts === 1));
    const captured: any[] = [];
    let authorization = "";
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const c of req) text += c;
      const body = JSON.parse(text);
      captured.push(body);
      authorization = String(req.headers.authorization);
      res.writeHead(207, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          successes: body.batch.map((x: any) => ({ id: x.id, status: 201 })),
          errors: [],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      await db.tx((tx) =>
        tx.rows("UPDATE observation_outbox SET next_attempt_at=now()"),
      );
      const exporter = new ObservationExporter(db, s, {
        LANGFUSE_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}`,
        LANGFUSE_PUBLIC_KEY: "pk-lf-test",
        LANGFUSE_SECRET_KEY: "sk-lf-test",
        LANGFUSE_TRACING_ENVIRONMENT: "test",
      });
      await exporter.flush();
      assert.equal(captured.length, 1);
      assert.match(authorization, /^Basic /);
      assert.equal(captured[0].batch[0].body.environment, "test");
      rows = await db.tx((tx) => tx.rows("SELECT * FROM observation_outbox"));
      assert.equal(rows.length, 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.throws(
      () => new ObservationExporter(db, s, {}),
      /LANGFUSE_BASE_URL/,
    );
    const disabled = new ObservationExporter(
      db,
      { ...s, tracingEnabled: false },
      {},
    );
    await disabled.flush();
  },
);

test(
  "real Pi extensions report internal tools from both cloud Runner and Mac Executor to our cloud only",
  { skip },
  async () => {
    const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
    const runner = await createRunner({ token: "r".repeat(40), dir: dir.path });
    const capturedRequests: string[] = [];
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      capturedRequests.push(url);
      assert.equal(
        new URL(url).hostname,
        "127.0.0.1",
        "no direct observability/vendor requests in executors",
      );
      return nativeFetch(input, init);
    };
    try {
      for (const executor of ["cloud", "device"] as const) {
        const id = (
          await api(`/bots/${bot}/messages`, {
            text: "创建能力链路测试",
            request_id: randomUUID(),
          })
        ).data.run.id;
        let deviceId: string | undefined;
        if (executor === "device") {
          deviceId = randomUUID();
          await db.tx(async (tx) => {
            await tx.insert("devices", {
              device_id: deviceId,
              user_id: userId,
              public_key: Buffer.alloc(32, 1).toString("base64"),
              label: "test Mac",
            });
            await tx.rows(
              "UPDATE bot_runs SET executor='device',device_id=$2 WHERE run_id=$1",
              [id, deviceId],
            );
          });
        }
        const context = await db.tx(async (tx) =>
          buildContext(tx, s, await tx.get("bot_runs", id)),
        );
        const token = await issueLlmToken(
          { sub: userId, src: executor, bot, did: deviceId },
          s,
        );
        if (executor === "cloud") {
          const response = await runner.inject({
            method: "POST",
            url: "/runs",
            headers: { authorization: `Bearer ${"r".repeat(40)}` },
            payload: { run: context, base_url: `${base}/llm/v1`, token },
          });
          assert.equal(response.statusCode, 200);
          const events = response.body
            .trim()
            .split("\n")
            .map((x) => JSON.parse(x));
          const observations = events.filter((e) => e.type === "observation");
          assert.ok(
            observations.some(
              (e) => e.name === "skill_manage" && e.phase === "end",
            ),
          );
          await db.tx(async (tx) => {
            const run = await tx.get("bot_runs", id);
            for (const e of observations) {
              const { type, ...event } = e;
              await recordObservation(tx, run, event, true);
            }
            await finishRun(tx, id, "completed", null, "云端完成");
          });
        } else {
          let delivery = Promise.resolve();
          const hub = new Hub();
          const computer = new Executor({
            libraryRoot: dir.path,
            agentDir: dir.path,
            proxyUrl: `${base}/llm/v1`,
            llmToken: async () => token,
            activity: () => {},
            send: (message) => {
              delivery = delivery.then(() =>
                handleRunEvent(
                  db,
                  s,
                  hub,
                  { deviceId, send: () => {} } as any,
                  message,
                ),
              );
            },
          });
          await computer.start(context);
          await delivery;
          const finished = await db.tx((tx) => tx.get("bot_runs", id));
          assert.equal(finished.status, "completed", finished.error);
        }
        const tools = await eventually(async () => {
          const r = await db.tx((tx) =>
            tx.rows(
              "SELECT payload FROM observation_outbox WHERE payload->'body'->'metadata'->>'run_id'=$1 AND payload->'body'->>'name'='Tool: skill_manage'",
              [id],
            ),
          );
          return r.length ? r : false;
        });
        assert.equal(tools.length, 1);
        const generations = await eventually(async () => {
          const r = await db.tx((tx) =>
            tx.rows(
              "SELECT payload FROM observation_outbox WHERE payload->'body'->'metadata'->>'run_id'=$1 AND payload->>'type'='generation-create'",
              [id],
            ),
          );
          return r.length >= 2 ? r : false;
        });
        assert.ok(generations.length >= 2);
      }
      assert.ok(capturedRequests.some((x) => x.endsWith("/llm/v1/responses")));
    } finally {
      globalThis.fetch = nativeFetch;
      await runner.close();
    }
  },
);

test("desktop/shared agent sources and manifests contain no Langfuse exporter or credentials", async () => {
  const manifests = await Promise.all(
    [
      "desktop/package.json",
      "desktop/packages/service/package.json",
      "packages/agent/package.json",
    ].map((p) => readFile(p, "utf8")),
  );
  for (const file of manifests) assert.ok(!file.includes("@langfuse/"));
  const files = [
    "desktop/packages/service/src/executor.ts",
    "packages/agent/src/observations.ts",
    "server/src/runner.ts",
  ];
  for (const file of files)
    assert.doesNotMatch(
      await readFile(file, "utf8"),
      /LANGFUSE_(?:BASE_URL|PUBLIC_KEY|SECRET_KEY)|from\s*['"]@langfuse/,
    );
});

test("old Qwen rows display effective capabilities and trace the actual reasoning controls and their source", { skip }, async () => {
  const model = (await db.tx(tx => tx.one("SELECT * FROM models ORDER BY created_at LIMIT 1")))!;
  const defaults = { chat: true, vision: true, voice: false, tools: true, reasoning: "unknown" };
  try {
    await db.tx(tx => tx.rows("UPDATE models SET provider='bailian',provider_model='qwen3.8-max',capabilities=$2 WHERE model_id=$1", [model.model_id, JSON.stringify(defaults)]));
    const listed = await app.inject({ method: "GET", url: "/admin/api/models", headers: { authorization: `Bearer ${token}` } });
    assert.equal(listed.statusCode, 200);
    const shown = listed.json().find((m: any) => m.id === model.model_id);
    assert.equal(shown.capabilities.reasoning, "configurable");
    assert.deepEqual(shown.capabilities.reasoning_off, { reasoning: { effort: "none" } });
    const stored = await db.tx(tx => tx.one("SELECT capabilities FROM models WHERE model_id=$1", [model.model_id]));
    assert.deepEqual(stored!.capabilities, defaults, "displaying defaults does not migrate the stored row");
    const id = (await api(`/bots/${bot}/messages`, { text: "首句延迟检查", request_id: randomUUID() })).data.run.id;
    await db.tx(async tx => buildContext(tx, s, await tx.get("bot_runs", id)));
    const bearer = await issueLlmToken({ sub: userId, src: "cloud", bot }, s);
    const cases = [
      { source: "provider_preset", controls: {}, expected: { "reasoning.effort": "none" } },
      { source: "request", controls: { reasoning: { effort: "low", summary: "PRIVATE-REQUEST-PARAMETER" } }, expected: { "reasoning.effort": "low" } },
      { source: "model_config", controls: {}, expected: { enable_thinking: false } },
    ];
    for (const scenario of cases) {
      if (scenario.source === "model_config") await db.tx(tx => tx.rows("UPDATE models SET capabilities=$2 WHERE model_id=$1", [model.model_id, JSON.stringify({ ...defaults, reasoning: "configurable", reasoning_off: { enable_thinking: false } })]));
      const generationId = randomUUID();
      const response = await api("/llm/v1/responses", {
        model: model.model_id, input: [{ role: "user", content: "PRIVATE-PROMPT" }], stream: false, ...scenario.controls,
      }, bearer, { "x-pibot-run-id": id, "x-pibot-generation-id": generationId });
      assert.equal(response.status, 200, JSON.stringify(response));
      const observation = await eventually(async () => {
        const row = await db.tx(tx => tx.one("SELECT payload FROM observation_outbox WHERE payload->'body'->>'id'=$1", [spanId(`${id}:generation:${generationId}`)]));
        return row?.payload.body ?? false;
      });
      assert.equal(observation.metadata.reasoning_source, scenario.source);
      assert.deepEqual(observation.modelParameters, scenario.expected);
      assert.ok(Object.values(observation.modelParameters).every(value => ["string", "number", "boolean"].includes(typeof value)));
      assert.doesNotMatch(JSON.stringify({ metadata: observation.metadata, parameters: observation.modelParameters }), /PRIVATE-PROMPT|PRIVATE-REQUEST-PARAMETER|sk-private-provider-value/);
      if (scenario.source === "provider_preset") assert.deepEqual(provider.requests.at(-1)!.body.reasoning, { effort: "none" });
      if (scenario.source === "request") assert.deepEqual(provider.requests.at(-1)!.body.reasoning, scenario.controls.reasoning);
      if (scenario.source === "model_config") assert.equal(provider.requests.at(-1)!.body.enable_thinking, false);
    }
    const created = await api("/admin/api/models", {
      name: "new fast chat", provider: "bailian", provider_model: "qwen3.8-flash", api_key: "sk-new-model-test", context_window: 32000, max_tokens: 2000,
    });
    assert.equal(created.status, 200, JSON.stringify(created));
    assert.deepEqual(created.data.capabilities.reasoning_off, { reasoning: { effort: "none" } });
    const patched = await app.inject({ method: "PATCH", url: `/admin/api/models/${created.data.id}`, headers: { authorization: `Bearer ${token}` }, payload: { capabilities: { ...defaults, reasoning: "required" } } });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().capabilities.reasoning, "required");
  } finally {
    await db.tx(tx => tx.rows("UPDATE models SET provider=$2,provider_model=$3,capabilities=$4 WHERE model_id=$1", [model.model_id, model.provider, model.provider_model, JSON.stringify(model.capabilities)]));
  }
});
