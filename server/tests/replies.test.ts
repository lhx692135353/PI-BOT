import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { Database } from "../src/db.js";
import { settings } from "../src/config.js";
import { Hub } from "../src/hub.js";
import { insertRun, finishRun, buildContext, botOut, messagesPage } from "../src/bots.js";
import { AgentDispatcher, createTask, messageTask, cancelTask } from "../src/agents.js";
import { recordReply } from "../src/replies.js";
import { claimExecution } from "../src/scheduling.js";
import { resetDatabase, TEST_DB, tempDir, vaultFile } from "./helpers.js";

const skip = !TEST_DB && "需要 PI_BOT_TEST_DATABASE_URL";
let db: Database, app: Awaited<ReturnType<typeof createApp>>, s: ReturnType<typeof settings>, dir: ReturnType<typeof tempDir>;
let user: string, a: string, b: string, token: string;
const hub = new Hub();
const workerId = randomUUID();
before(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!); dir = tempDir(); db = new Database(TEST_DB!);
  s = settings({ PI_BOT_DATABASE_URL: TEST_DB!, PI_BOT_ADMIN_PASSWORD: "test-password", PI_BOT_JWT_SECRET: "j".repeat(40), PI_BOT_VAULT_FILE: vaultFile(dir.path), PI_BOT_RUNNER_TOKEN: "r".repeat(40) });
  app = await createApp(s, db, hub);
  const login = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "test-password" } })).json();
  token = login.access_token; user = login.user.id;
  const call = (url: string, payload?: object) => app.inject({ method: payload ? "POST" : "GET", url, payload, headers: { authorization: `Bearer ${token}` } });
  await call("/admin/api/models", { name: "test", base_url: "http://127.0.0.1:1/v1", provider_model: "test", api_key: "test-secret", context_window: 32000, max_tokens: 1000 });
  a = (await call("/bots")).json().bots[0].id;
  b = (await call("/bots", { name: "检查助手", persona: "" })).json().id;
});
after(async () => { if (!skip) { await app.close(); dir.cleanup(); } });

async function parent(bot = a) {
  return db.tx(async tx => {
    const r = await insertRun(tx, { userId: user, botId: bot, requestId: randomUUID(), text: "检查显存", computer: null });
    await claimExecution(tx, r.run_id, s, workerId);
    return r;
  });
}
const claims = (bot = a) => ({ sub: user, src: "cloud" as const, bot });

test("opening persists while running, retries do not duplicate, answers replay once and quiet reviews stay silent", { skip }, async () => {
  const run = await parent();
  const opening = { id: "open", text: "先检查显存占用。", phase: "opening" as const, generated_at: new Date().toISOString() };
  await db.tx(async tx => {
    const active = await tx.get("bot_runs", run.run_id);
    await recordReply(tx, active, opening); await recordReply(tx, active, opening);
    const m = await tx.get("bot_messages", run.assistant_message_id);
    assert.equal(m.status, "running"); assert.equal(m.reply_segments.length, 1); assert.deepEqual(m.progress, [opening.text]);
    assert.ok((await tx.get("bot_runs", run.run_id)).first_reply_at);
    assert.equal((await tx.get("bot_runs", run.run_id)).first_reply_generation_ms, null);
    await recordReply(tx, { ...active, origin: "automation" }, { ...opening, id: "quiet", text: "不能公开" });
    await recordReply(tx, active, { ...opening, id: "result", phase: "answer", text: "服务正常。" });
    await finishRun(tx, run.run_id, "completed", null, "服务正常。");
    const done = await tx.get("bot_messages", run.assistant_message_id);
    assert.equal(done.reply_segments.length, 2); assert.equal(done.content, "服务正常。");
  });
  const followup = await parent();
  await db.tx(async tx => {
    const context = await buildContext(tx, s, await tx.get("bot_runs", followup.run_id));
    assert.equal(context.verify_execution_claims, true);
    assert.equal(context.history.filter(h => h.content === "服务正常。").length, 1);
    assert.ok(!context.history.some(h => h.content.includes("不能公开")));
    await finishRun(tx, followup.run_id, "completed", null, "好。");
  });
});

test("delegation activity belongs to the executor; task transcript is scoped, paginated and deduplicated", { skip }, async () => {
  const run = await parent();
  const created = await db.tx(async tx => {
    const result = await createTask(tx, hub, user, claims(), { run_id: run.run_id, agent: b, task: "核对服务显存", title: "检查显存占用", execution: "cloud", wait: false }, s);
    await finishRun(tx, run.run_id, "completed", null, "已交给检查助手。");
    await claimExecution(tx, result.run!.run_id, s, workerId);
    return result;
  });
  await db.tx(async tx => {
    const from = await botOut(tx, await tx.get("bots", a)), to = await botOut(tx, await tx.get("bots", b));
    assert.equal(from.activity.running_count, 0); assert.equal(from.activity.summary, null);
    assert.equal(to.activity.running_count, 1); assert.equal(to.activity.summary, "正在检查显存占用");
    const message = { run_id: run.run_id, text: "再看一下测试机器", request_id: "more" };
    // A new live turn supplies supplemental instructions.
    const next = await insertRun(tx, { userId: user, botId: a, requestId: randomUUID(), text: "补充", computer: null });
    await claimExecution(tx, next.run_id, s, workerId); message.run_id = next.run_id;
    await messageTask(tx, user, claims(), created.task.id, message); await messageTask(tx, user, claims(), created.task.id, message);
    await finishRun(tx, next.run_id, "completed", null, "补充已送达。");
    await recordReply(tx, await tx.get("bot_runs", created.run!.run_id), { id: "update", text: "正在核对测试机器。", phase: "update", generated_at: new Date().toISOString() });
  });
  const get = (bot: string, after = 0, limit = 50) => app.inject({ method: "GET", url: `/bots/${bot}/tasks/${created.task.id}/conversation?after=${after}&limit=${limit}`, headers: { authorization: `Bearer ${token}` } });
  const first = (await get(a, 0, 2)).json(); assert.equal(first.total, 3); assert.equal(first.has_more, true);
  const second = (await get(b, first.next_after, 2)).json(); assert.equal(second.messages.length, 1); assert.equal(second.has_more, false);
  assert.equal(second.messages[0].from_bot_id, b);
  const other = (await app.inject({ method: "POST", url: "/bots", headers: { authorization: `Bearer ${token}` }, payload: { name: "无关助手", persona: "" } })).json();
  assert.equal((await get(other.id)).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/bots/${a}/tasks/${created.task.id}/conversation` })).statusCode, 401);
  await db.tx(async tx => {
    await finishRun(tx, created.run!.run_id, "completed", null, "显存占用正常。");
    assert.equal((await botOut(tx, await tx.get("bots", b))).activity.summary, null);
    const page = await messagesPage(tx, a, undefined, 50);
    const chip = page.messages.flatMap(m => m.agent_tasks).find(t => t.id === created.task.id)!;
    assert.equal(chip.message_count, 4);
  });
});

test("reconciliation clears terminal-task residue and expired runs while preserving legitimate queues", { skip }, async () => {
  const run = await parent();
  const created = await db.tx(async tx => {
    const result = await createTask(tx, hub, user, claims(), { run_id: run.run_id, kind: "background", task: "核对记录", title: "核对记录", execution: "cloud", wait: false }, s);
    await finishRun(tx, run.run_id, "completed", null, "安排好了。");
    await finishRun(tx, result.run!.run_id, "completed", null, "完成。");
    await tx.rows("UPDATE agent_tasks SET status='running' WHERE task_id=$1", [result.task.id]);
    return result;
  });
  await new AgentDispatcher(db, s, hub).once();
  const { pending, expired, orphan } = await db.tx(async tx => {
    assert.equal((await tx.get("agent_tasks", created.task.id)).status, "completed");
    const pending = await insertRun(tx, { userId: user, botId: b, requestId: randomUUID(), text: "排队", computer: null });
    const expired = await insertRun(tx, { userId: user, botId: a, requestId: randomUUID(), text: "超时", computer: null });
    await tx.rows("UPDATE bot_runs SET status='running',lease_until=now()-interval '1 minute' WHERE run_id=$1", [expired.run_id]);
    const orphan = await tx.insert("agent_tasks", { task_id: randomUUID(), user_id: user, parent_run_id: run.run_id,
      parent_bot_id: a, target_bot_id: b, mode: "wait", kind: "delegation", depth: 1, task: "缺失的执行记录", status: "running" });
    return { pending, expired, orphan };
  });
  await new AgentDispatcher(db, s, hub).once();
  await db.tx(async tx => {
    assert.equal((await tx.get("bot_runs", pending.run_id)).status, "queued");
    assert.equal((await tx.get("bot_runs", expired.run_id)).status, "failed");
    assert.equal((await tx.get("agent_tasks", orphan.task_id)).status, "failed");
  });
});
