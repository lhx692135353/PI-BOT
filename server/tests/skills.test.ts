import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp, openapi } from "../src/app.js";
import { Database } from "../src/db.js";
import { settings } from "../src/config.js";
import { issueLlmToken, type LlmClaims } from "../src/security.js";
import { buildContext, finishRun, markRunning, recordTool, messageOut } from "../src/bots.js";
import { createRunner } from "../src/runner.js";
import { skillRequest } from "../src/skills.js";
import { TEST_DB, resetDatabase, tempDir, vaultFile, mockProvider, deviceKeys } from "./helpers.js";

const skip = !TEST_DB && "需要 PI_BOT_TEST_DATABASE_URL";
let app: Awaited<ReturnType<typeof createApp>>, runner: Awaited<ReturnType<typeof createRunner>>;
let dir: ReturnType<typeof tempDir>, provider: Awaited<ReturnType<typeof mockProvider>>;
let base: string, runnerUrl: string, userId: string, userToken: string, botId: string, otherBot: string, runId: string, otherRun: string;
let s: ReturnType<typeof settings>;
let db: Database;
const runnerToken = "r".repeat(40);
async function api(method: "GET" | "POST", path: string, body?: unknown, token = userToken) {
  const response = await app.inject({ method, url: path, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
  return { status: response.statusCode, json: response.json() };
}
async function token(claims: Partial<LlmClaims> = {}) { return issueLlmToken({ sub: userId, src: "cloud", bot: botId, ...claims }, s); }
async function skill(body: object, bearer?: string, run = runId) { return api("POST", "/agent/skills", { run_id: run, ...body }, bearer ?? await token()); }
async function newRun(bot: string, text = "测试") {
  const response = await api("POST", `/bots/${bot}/messages`, { text, request_id: randomUUID() });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json.run.id as string;
}
before(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!);
  dir = tempDir(); provider = await mockProvider();
  s = settings({ PI_BOT_DATABASE_URL: TEST_DB, PI_BOT_ADMIN_PASSWORD: "admin-password", PI_BOT_JWT_SECRET: "j".repeat(40), PI_BOT_VAULT_FILE: vaultFile(dir.path) });
  db = new Database(TEST_DB!);
  app = await createApp(s, db); await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const login = await api("POST", "/auth/login", { username: "admin", password: "admin-password" }, "");
  userToken = login.json.access_token; userId = login.json.user.id;
  assert.equal((await api("POST", "/admin/api/models", { name: "test", base_url: provider.url, provider_model: "test", api_key: "sk-skills-test", context_window: 32000, max_tokens: 1000 })).status, 200);
  botId = (await api("POST", "/bots", { name: "A" })).json.id;
  otherBot = (await api("POST", "/bots", { name: "B" })).json.id;
  runId = await newRun(botId); otherRun = await newRun(otherBot);
  runner = await createRunner({ token: runnerToken, dir: dir.path });
  await runner.listen({ host: "127.0.0.1", port: 0 });
  runnerUrl = `http://127.0.0.1:${(runner.server.address() as any).port}`;
});
after(async () => { if (skip) return; await runner?.close(); await app?.close(); await provider?.close(); dir?.cleanup(); });

test("private skill payloads reject ownership overrides, malformed names and oversized references", () => {
  const create = { action: "create", run_id: randomUUID(), name: "weekly-report", description: "周报", instructions: "核实来源。" };
  assert.ok(skillRequest.safeParse(create).success);
  for (const patch of [{ bot_id: randomUUID() }, { name: "../other" }, { references: { "../file": "x" } }, { references: { "file.md": "x".repeat(16001) } }, { references: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`r${i}`, "x"])) }])
    assert.equal(skillRequest.safeParse({ ...create, ...patch }).success, false);
  assert.equal(skillRequest.safeParse({ action: "update", run_id: randomUUID(), name: "weekly-report", expected_version: 1 }).success, false);
});

test("skills persist by bot, load references lazily, and are absent from public APIs", { skip }, async () => {
  assert.equal((await skill({ action: "list" }, userToken)).status, 401);
  const created = await skill({ action: "create", name: "weekly-report", description: "编写周报时使用", instructions: "PRIVATE-A：核实来源。", references: { "format.md": "PRIVATE-REFERENCE：先结论后依据。" } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.version, 1);
  assert.equal((await skill({ action: "create", name: "weekly-report", description: "重复", instructions: "x" })).status, 409);
  const load = await skill({ action: "load", name: "weekly-report" });
  assert.equal(load.json.instructions, "PRIVATE-A：核实来源。");
  assert.deepEqual(load.json.references, ["format.md"]);
  assert.equal((await skill({ action: "load", name: "weekly-report", reference: "format.md" })).json.content, "PRIVATE-REFERENCE：先结论后依据。");
  assert.equal((await skill({ action: "load", name: "weekly-report", reference: "missing" })).status, 404);
  assert.equal((await skill({ action: "load", name: "weekly-report" }, await token({ bot: otherBot }), otherRun)).status, 404);
  assert.equal((await skill({ action: "create", name: "weekly-report", description: "B 的周报", instructions: "PRIVATE-B" }, await token({ bot: otherBot }), otherRun)).status, 200);
  assert.equal((await skill({ action: "load", name: "weekly-report" }, await token({ bot: otherBot }), otherRun)).json.instructions, "PRIVATE-B");
  const context = await db.tx(async tx => buildContext(tx, s, await tx.get("bot_runs", runId)));
  assert.deepEqual(context.skills, [{ name: "weekly-report", description: "编写周报时使用", version: 1 }]);
  assert.equal(JSON.stringify(context).includes("PRIVATE-A"), false, "run catalog contains metadata only");
  assert.equal(openapi().paths["/agent/skills"], undefined);
  const detail = await api("GET", `/bots/${botId}`);
  assert.equal(detail.json.skills, undefined);
  await db.tx(async tx => {
    const run = await tx.get("bot_runs", runId);
    await recordTool(tx, run, { id: "private", name: "skill_load", state: "completed", summary: "PRIVATE-A" });
    const message = await tx.get("bot_messages", run.assistant_message_id);
    assert.deepEqual(message.tools, []);
    assert.deepEqual(messageOut({ ...message, tools: [{ name: "skill_manage" }, { name: "read_file" }] }).tools, [{ name: "read_file" }]);
  });
});

test("version conflicts serialize concurrent writes and deleted skills can be restored with their references", { skip }, async () => {
  const updates = await Promise.all(["新流程一", "新流程二"].map(instructions => skill({ action: "update", name: "weekly-report", instructions, expected_version: 1 })));
  assert.deepEqual(updates.map(response => response.status).sort(), [200, 409]);
  assert.equal((await skill({ action: "disable", name: "weekly-report", expected_version: 2 })).json.version, 3);
  assert.equal((await skill({ action: "load", name: "weekly-report" })).status, 404);
  assert.deepEqual((await db.tx(async tx => buildContext(tx, s, await tx.get("bot_runs", runId)))).skills, []);
  assert.equal((await skill({ action: "enable", name: "weekly-report", expected_version: 3 })).json.version, 4);
  assert.equal((await skill({ action: "delete", name: "weekly-report", expected_version: 4 })).json.version, 5);
  assert.equal((await skill({ action: "load", name: "weekly-report" })).status, 404);
  assert.equal((await skill({ action: "update", name: "weekly-report", expected_version: 5, instructions: "x" })).status, 409);
  assert.equal((await skill({ action: "restore", name: "weekly-report", expected_version: 5, version: 100 })).status, 404);
  assert.equal((await skill({ action: "restore", name: "weekly-report", expected_version: 5, version: 5 })).status, 422);
  assert.equal((await skill({ action: "restore", name: "weekly-report", expected_version: 5, version: 1 })).json.version, 6);
  assert.equal((await skill({ action: "load", name: "weekly-report" })).json.instructions, "PRIVATE-A：核实来源。");
  assert.equal((await skill({ action: "load", name: "weekly-report", reference: "format.md" })).json.content, "PRIVATE-REFERENCE：先结论后依据。");
  const history = await skill({ action: "history", name: "weekly-report" });
  assert.deepEqual(history.json.versions.map((entry: any) => entry.operation), ["restore", "delete", "enable", "disable", "update", "create"]);
  assert.equal((await skill({ action: "list" })).json.skills[0].version, 6);
});

test("only a live owned run with the matching executor and device can manage skills", { skip }, async () => {
  assert.equal((await skill({ action: "list" }, await token({ bot: otherBot }))).status, 404);
  assert.equal((await skill({ action: "list" }, await token({ src: "memory" }))).status, 404);
  assert.equal((await skill({ action: "list" }, await token({ bot: undefined }))).status, 403);
  const other = await api("POST", "/admin/api/users", { username: "other", password: "other-password" });
  assert.equal((await skill({ action: "list" }, await token({ sub: other.json.id }))).status, 404);
  const keys = deviceKeys();
  const device = await api("POST", "/devices/register", { label: "test", public_key: keys.publicKey });
  const deviceId = device.json.device.id;
  await db.tx(tx => tx.rows("UPDATE bot_runs SET executor='device', device_id=$2 WHERE run_id=$1", [runId, deviceId]));
  assert.equal((await skill({ action: "list" }, await token())).status, 404);
  assert.equal((await skill({ action: "list" }, await token({ src: "device", did: randomUUID() }))).status, 401);
  assert.equal((await skill({ action: "list" }, await token({ src: "device", did: deviceId }))).status, 200);
  await db.tx(tx => tx.rows("UPDATE bot_runs SET executor='cloud', device_id=NULL, cancel_requested=true WHERE run_id=$1", [runId]));
  assert.equal((await skill({ action: "list" })).status, 404);
  await db.tx(async tx => { await finishRun(tx, runId, "cancelled", null); });
  assert.equal((await skill({ action: "list" })).status, 404);
});

test("cloud Runner uses the real extension to create and reuse skills without exposing internal NDJSON records", { skip }, async () => {
  for (const text of ["创建能力链路测试", "加载能力链路测试"]) {
    runId = await newRun(botId, text);
    const context = await db.tx(async tx => { await markRunning(tx, runId); return buildContext(tx, s, await tx.get("bot_runs", runId)); });
    const response = await fetch(`${runnerUrl}/runs`, { method: "POST", headers: { authorization: `Bearer ${runnerToken}`, "content-type": "application/json" }, body: JSON.stringify({ run: context, base_url: `${base}/llm/v1`, token: await token() }) });
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.doesNotMatch(raw, /PRIVATE-WORKFLOW/);
    const events = raw.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.at(-1).state, "completed", raw);
    assert.equal(events.at(-1).text, "已按方法完成任务。");
    if (text === "加载能力链路测试") {
      assert.ok(context.skills.some(skill => skill.name === "report-test"));
      assert.match(JSON.stringify(provider.requests.at(-1)!.body.input), /PRIVATE-WORKFLOW/);
    }
    await db.tx(tx => finishRun(tx, runId, "completed", null, events.at(-1).text));
  }
});
