import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Database, type Row } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { settings } from "../src/config.js";
import { Hub, type DeviceConnection } from "../src/hub.js";
import { createBot, insertRun, finishRun, botOut, messagesPage } from "../src/bots.js";
import { AutomationScheduler, goalRequest, listGoals, manageGoals, saveGoalDecision, checkpointAutomation, recordAutomationEffect } from "../src/automations.js";
import { failDeviceRuns, failOrphanedDeviceRuns } from "../src/runs.js";
import { claimExecution } from "../src/scheduling.js";
import { createTask } from "../src/agents.js";
import { nextWake, nextLocalDay, localDay, scheduleSchema, timezoneSchema } from "../src/automation-time.js";
import type { LlmClaims } from "../src/security.js";
import { TEST_DB, resetDatabase } from "./helpers.js";

const skip = !TEST_DB && "需要独立 PI_BOT_TEST_DATABASE_URL";
let db: Database, hub: Hub, user: string, bot: string, device: string, review: string, goalId: string, now: Date;
let sent: Row[], conn: DeviceConnection;
const config = () => settings({ PI_BOT_DATABASE_URL: TEST_DB ?? "test", PI_BOT_JWT_SECRET: "j".repeat(40) });
const scheduler = (options = config()) => new AutomationScheduler(db, options, hub, () => now);
const claims = (): LlmClaims => ({ sub: user, src: "device", bot, did: device });
before(() => { if (!skip) db = new Database(TEST_DB!); });
beforeEach(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!); await migrate(db);
  now = new Date(); hub = new Hub(); sent = [];
  user = randomUUID(); device = randomUUID();
  await db.tx(async tx => {
    await tx.insert("users", { user_id: user, username: "automation-user", role: "user", password_hash: "unused" });
    await tx.insert("devices", { device_id: device, user_id: user, label: "test Mac", public_key: "unused" });
    await tx.insert("models", { model_id: randomUUID(), name: "test", base_url: "http://127.0.0.1:1/v1", provider_model: "test", context_window: 32000, max_tokens: 1000, secret: {} });
    bot = (await createBot(tx, user, { name: "检查员", persona: "推进自己的目标" })).bot_id;
  });
  const dialog = await dialogue();
  const created = await control(dialog, { action: "create", title: "持续推进", goal: "把已授权的事项做到有进展再告诉我", authorization: "用户授权在自己的资料库里整理进度" }) as Row;
  goalId = created.id;
  await db.tx(async tx => {
    await finishRun(tx, dialog.run_id, "completed", null, "已建立");
    review = (await tx.one("SELECT automation_id FROM bot_automations WHERE bot_id=$1", [bot]))!.automation_id;
  });
  conn = { deviceId: device, userId: user, capabilities: ["always-on-v1"], send: m => sent.push(m), close() {} };
  hub.attach(conn);
});
after(async () => { await db?.close(); });
async function due(id = review) { await db.tx(tx => tx.rows("UPDATE bot_automations SET next_wake_at=$2 WHERE automation_id=$1", [id, now])); }
async function current(id = review) { return db.tx(tx => tx.get("bot_automations", id)); }
async function goal(id = goalId) { return db.tx(tx => tx.get("bot_goals", id)); }
async function active(id = review) { return db.tx(tx => tx.one("SELECT r.* FROM bot_runs r JOIN automation_rounds ar ON ar.run_id=r.run_id WHERE ar.automation_id=$1 AND ar.status='active'", [id])); }
async function dialogue() {
  return db.tx(tx => insertRun(tx, { userId: user, botId: bot, requestId: randomUUID(), text: "管理目标", computer: { deviceId: device } }));
}
async function control(run: Row, body: object) {
  return db.tx(tx => manageGoals(tx, user, claims(), goalRequest.parse({ run_id: run.run_id, request_id: randomUUID(), ...body }), now));
}
function asDecision(extra: Record<string, any> = {}) {
  const state = extra.state === "complete" || extra.state === "done" ? "done" : extra.state === "waiting_user" ? "waiting_user" : "continue";
  const item: Record<string, unknown> = {
    id: extra.id ?? goalId, state, progress: extra.progress ?? extra.summary ?? "没有值得打扰的新变化",
    notify: !!extra.notify, reason: extra.reason ?? "无变化",
  };
  if (item.notify) item.notification_key = extra.notification_key ?? "progress";
  if (extra.checkpoint) item.checkpoint = extra.checkpoint;
  return { goals: extra.goals ?? [item], ...(extra.next_wake_at ? { next_wake_at: extra.next_wake_at } : {}) };
}
async function done(run: Row, extra: Record<string, any> = {}) {
  await db.tx(tx => saveGoalDecision(tx, user, claims(), { run_id: run.run_id, decision: asDecision(extra) }, now));
  await db.tx(tx => finishRun(tx, run.run_id, "completed", null, "PRIVATE ordinary output", now));
}

test("schedule validation, timezone and real local daily occurrences including DST", () => {
  const t = new Date("2026-10-18T00:59:00Z");
  assert.equal(nextWake({ type: "daily", time: "09:00" }, "Asia/Shanghai", t)!.toISOString(), "2026-10-18T01:00:00.000Z");
  assert.equal(nextWake({ type: "daily", time: "09:00" }, "Asia/Shanghai", new Date("2026-10-18T01:00:00Z"))!.toISOString(), "2026-10-19T01:00:00.000Z");
  assert.equal(nextWake({ type: "daily", time: "02:30" }, "America/New_York", new Date("2026-03-08T06:00:00Z"))!.toISOString(), "2026-03-09T06:30:00.000Z");
  assert.equal(localDay(nextLocalDay(t, "Asia/Shanghai"), "Asia/Shanghai"), "2026-10-19");
  assert.equal(timezoneSchema.safeParse("invalid/timezone").success, false);
  assert.equal(scheduleSchema.safeParse({ type: "interval", minutes: 0 }).success, false);
  assert.deepEqual([0, 1, 2, 3, 9].map(n => (nextWake({ type: "adaptive" }, "UTC", t, n)!.getTime() - t.getTime()) / 3600000), [1, 2, 4, 6, 6]);
});

test("upgrading an existing database does not invent a goal or change public history", { skip }, async () => {
  await resetDatabase(TEST_DB!);
  const folder = new URL("../migrations/", import.meta.url);
  await db.tx(async tx => {
    await tx.rows("CREATE TABLE schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    for (const file of (await readdir(folder)).filter(f => f.endsWith(".sql") && f < "0009").sort()) {
      await tx.rows(await readFile(new URL(file, folder), "utf8"));
      await tx.rows("INSERT INTO schema_migrations(version) VALUES($1)", [file.slice(0, -4)]);
    }
    await tx.insert("users", { user_id: user, username: "existing-user", role: "user", password_hash: "unused" });
    await tx.insert("bots", { bot_id: bot, user_id: user, name: "已有 Bot", slug: "existing-bot", avatar: {}, next_seq: 2 });
    await tx.insert("bot_messages", { message_id: randomUUID(), bot_id: bot, seq: 1, role: "assistant", content: "原有对话", status: "completed", visibility: "public" });
  });
  await migrate(db); await migrate(db);
  assert.equal((await db.tx(tx => tx.rows("SELECT * FROM bot_automations WHERE bot_id=$1", [bot]))).length, 0);
  assert.equal((await db.tx(tx => tx.one("SELECT count(*) AS n FROM bot_goals WHERE bot_id=$1", [bot])))!.n, 0);
  assert.equal((await db.tx(tx => tx.get("bots", bot))).next_seq, 2);
  assert.deepEqual((await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.map(m => m.content), ["原有对话"]);
});

test("a commission becomes a goal and its patrol does not", { skip }, async () => {
  await resetDatabase(TEST_DB!);
  const folder = new URL("../migrations/", import.meta.url);
  const commission = randomUUID();
  await db.tx(async tx => {
    await tx.rows("CREATE TABLE schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    for (const file of (await readdir(folder)).filter(f => f.endsWith(".sql") && f < "0013").sort()) {
      await tx.rows(await readFile(new URL(file, folder), "utf8"));
      await tx.rows("INSERT INTO schema_migrations(version) VALUES($1)", [file.slice(0, -4)]);
    }
    await tx.insert("users", { user_id: user, username: "legacy-goals", role: "user", password_hash: "unused" });
    await tx.insert("bots", { bot_id: bot, user_id: user, name: "旧 Bot", slug: "legacy-goals", avatar: {}, next_seq: 2 });
    await tx.insert("bot_automations", { automation_id: randomUUID(), bot_id: bot, user_id: user, kind: "patrol", title: "自主巡检", goal: "到处看看", status: "enabled" });
    await tx.insert("bot_automations", { automation_id: commission, bot_id: bot, user_id: user, kind: "commission", title: "整理周报", goal: "把周报写进资料库", authorization_scope: "可以写周报文件", status: "enabled", checkpoint: { completed: ["已看过来源"] } });
  });
  await migrate(db);
  const goals = await db.tx(tx => tx.rows("SELECT * FROM bot_goals WHERE bot_id=$1", [bot]));
  assert.equal(goals.length, 1);
  assert.equal(goals[0].goal_id, commission);
  assert.equal(goals[0].statement, "把周报写进资料库");
  assert.equal(goals[0].status, "active");
  assert.deepEqual(goals[0].checkpoint, { completed: ["已看过来源"] });
  const loops = await db.tx(tx => tx.rows("SELECT * FROM bot_automations WHERE bot_id=$1", [bot]));
  assert.equal(loops.length, 1);
  assert.equal(loops[0].kind, "review");
});

test("a goal review waits offline and for a compatible computer, and never becomes a cloud job", { skip }, async () => {
  assert.equal((await db.tx(tx => tx.rows("SELECT * FROM bot_automations WHERE bot_id=$1", [bot]))).length, 1);
  hub.detach(conn); await due(); await scheduler().once();
  assert.equal((await current()).status, "waiting_device"); assert.equal(await active(), undefined);
  conn.capabilities = []; hub.attach(conn); await scheduler().once(); assert.equal(await active(), undefined);
  conn.capabilities = ["always-on-v1"]; await scheduler().once();
  const run = (await active())!;
  assert.equal(run.executor, "device"); assert.equal(run.execution_policy, "device_only");
  assert.equal(sent.filter(m => m.type === "run").length, 1);
  const ctx = sent.find(m => m.type === "run")!.run;
  assert.equal(ctx.automation.kind, "review"); assert.equal(ctx.automation_readonly, false); assert.equal(ctx.agents_enabled, false);
  assert.match(ctx.text, /持续推进/);
  assert.equal(await db.tx(tx => claimExecution(tx, run.run_id, config(), randomUUID())), null);
});

test("one computer's offline backlog cannot starve another computer's due work or reports on the same account", { skip }, async () => {
  const offlineDevice = randomUUID();
  await db.tx(async tx => {
    await tx.insert("devices", { device_id: offlineDevice, user_id: user, public_key: "offline-device", label: "Offline Linux", platform: "linux" });
    for (let i = 0; i < 101; i++) {
      const created = await createBot(tx, user, { name: `offline-${i}`, persona: "", execution_device_id: offlineDevice });
      await tx.insert("bot_automations", { automation_id: randomUUID(), bot_id: created.bot_id, user_id: user, operation_target:"device:"+offlineDevice, kind: "review", title: "目标检查", goal: "检查目标", next_wake_at: new Date(now.getTime() - 86400000) });
    }
    const offline = await tx.rows("SELECT a.automation_id FROM bot_automations a JOIN bots b USING(bot_id) WHERE b.execution_device_id=$1 LIMIT 51", [offlineDevice]);
    for (const a of offline) await tx.insert("automation_reports", { report_id: randomUUID(), automation_id: a.automation_id,
      version: 1, event_key: "offline-pending", category: "progress", content: "离线待回报", available_at: new Date(now.getTime() - 86400000) });
  });
  await due(); await scheduler().once();
  assert.ok(await active());
  const count = await db.tx(tx => tx.one("SELECT count(*) AS n FROM bot_automations a JOIN bots b USING(bot_id) WHERE b.execution_device_id=$1 AND a.status='waiting_device'", [offlineDevice]));
  assert.equal(count!.n, 101);
  await done((await active())!, { notify: true, summary: "在线用户的重要结果", notification_key: "online-result" });
  await scheduler().once();
  assert.equal((await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.at(-1)!.content, "在线用户的重要结果");
});

test("concurrent scans coalesce wakes and quiet rounds change neither timeline nor visible activity time", { skip }, async () => {
  const previous = await db.tx(tx => tx.get("bots", bot));
  await due(); await Promise.all([scheduler().once(), scheduler().once()]);
  const run = (await active())!;
  assert.ok(run);
  assert.equal(sent.filter(m => m.type === "run").length, 1);
  const view = await db.tx(tx => botOut(tx, previous)); assert.equal(view.activity.summary, "正在检查目标");
  await done(run);
  const page = await db.tx(tx => messagesPage(tx, bot, undefined, 50));
  assert.equal(page.messages.at(-1)!.content, "已建立");
  assert.equal((await db.tx(tx => tx.get("bots", bot))).last_active_at.getTime(), previous.last_active_at.getTime());
  assert.equal(new Date((await current()).next_wake_at).getTime() - now.getTime(), 2 * 3600000);
  await scheduler().once(); assert.equal(await active(), undefined);
});

test("important output is persisted, remains pending offline, and is published exactly once", { skip }, async () => {
  await due(); await scheduler().once();
  const run = (await active())!;
  await done(run, { notify: true, summary: "发现一个需要确认的新问题", notification_key: "issue:42:needs-decision" });
  hub.detach(conn); await scheduler().once();
  assert.equal((await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.at(-1)!.content, "已建立");
  hub.attach(conn); await Promise.all([scheduler().once(), scheduler().once()]);
  const page = await db.tx(tx => messagesPage(tx, bot, undefined, 50));
  assert.equal(page.messages.at(-1)!.content, "发现一个需要确认的新问题");
  assert.equal(page.messages.filter(m => m.content === "发现一个需要确认的新问题").length, 1);
  assert.ok(!JSON.stringify(page).includes("PRIVATE"));
  await due(); await scheduler().once(); await done((await active())!, { notify: true, summary: "同一问题", notification_key: "issue:42:needs-decision" });
  await scheduler().once();
  assert.equal((await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.filter(m => m.content === "发现一个需要确认的新问题").length, 1);
});

test("goal controls preserve checkpoints, reject stale decisions and cancel in-flight work", { skip }, async () => {
  await due(); await scheduler().once(); const run = (await active())!;
  await db.tx(tx => checkpointAutomation(tx, run, { completed: ["已查阅来源"] }, 0));
  await assert.rejects(db.tx(tx => checkpointAutomation(tx, run, {}, 0)), /版本/);
  const dialog = await dialogue();
  await control(dialog, { action: "pause", goal_id: goalId, expected_version: 1 });
  await assert.rejects(db.tx(tx => saveGoalDecision(tx, user, claims(), { run_id: run.run_id, decision: asDecision({ state: "done", summary: "stale", notify: true, notification_key: "stale" }) }, now)), /失效/);
  await scheduler().once();
  assert.equal((await current()).status, "paused"); assert.equal((await db.tx(tx => tx.get("bot_runs", run.run_id))).status, "cancelled");
  await control(dialog, { action: "resume", goal_id: goalId, expected_version: 2 });
  assert.deepEqual((await current()).checkpoint, { completed: ["已查阅来源"] });
  await control(dialog, { action: "stop", all: true });
  assert.equal((await current()).status, "stopped");
  assert.equal((await goal()).status, "stopped");
});

test("computer interruption preserves queued work and safely restarts a round without a failure charge", { skip }, async () => {
  await due(); await scheduler().once(); const first = (await active())!;
  hub.detach(conn); await failDeviceRuns(db, device);
  assert.equal((await current()).status, "waiting_device"); assert.equal((await current()).failures, 0);
  now = new Date(); hub.attach(conn); await scheduler().once(); const resumed = (await active())!;
  assert.notEqual(resumed.run_id, first.run_id); assert.equal(resumed.executor, "device");
  await done(resumed);
  await due(); await scheduler().once(); const queued = (await active())!;
  await db.tx(tx => tx.rows("UPDATE bot_runs SET status='queued' WHERE run_id=$1", [queued.run_id]));
  hub.detach(conn); await failOrphanedDeviceRuns(db);
  assert.equal((await db.tx(tx => tx.get("bot_runs", queued.run_id))).status, "queued");
  assert.equal((await db.tx(tx => tx.get("bot_runs", queued.run_id))).executor, "device");
  assert.equal((await current()).status, "waiting_device");
  const view = await db.tx(async tx => botOut(tx, await tx.get("bots", bot)));
  assert.equal(view.activity.running_count, 0); assert.equal(view.activity.queued_count, 0);
});

test("write-ahead journal prevents uncertain side effects from replaying after disconnect", { skip }, async () => {
  await due(); await scheduler().once(); const run = (await active())!;
  await db.tx(tx => recordAutomationEffect(tx, user, claims(), { run_id: run.run_id, tool_call_id: "write-1", phase: "start" }));
  await assert.rejects(db.tx(tx => recordAutomationEffect(tx, user, claims(), { run_id: run.run_id, tool_call_id: "write-1", phase: "start" })), /不得重复/);
  hub.detach(conn); await failDeviceRuns(db, device);
  assert.equal((await current()).status, "waiting_user");
  now = new Date(); hub.attach(conn); await scheduler().once(); assert.equal(await active(), undefined);
  assert.match((await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.at(-1)!.content, /避免重复执行/);
});

test("missing finish result retries at 1/5/15 minutes then asks the user only once", { skip }, async () => {
  for (let i = 0; i < 4; i++) {
    await due(); await scheduler().once(); const run = (await active())!;
    await db.tx(tx => finishRun(tx, run.run_id, "completed", null, "not a structured outcome", now));
    const state = await current();
    if (i < 3) assert.equal(new Date(state.next_wake_at).getTime() - now.getTime(), [1, 5, 15][i] * 60000);
    else assert.equal(state.status, "waiting_user");
    now = new Date(now.getTime() + 1000);
  }
  await scheduler().once(); await scheduler().once();
  const reports = await db.tx(tx => tx.rows("SELECT * FROM automation_reports WHERE category='failure'"));
  assert.equal(reports.length, 1); assert.ok(reports[0].delivered_at);
});

test("a finished goal stays finished and bulk resume does not resurrect it", { skip }, async () => {
  await due(); await scheduler().once(); await done((await active())!, { state: "done", summary: "本次完成" });
  assert.equal((await goal()).status, "done");
  assert.equal((await current()).next_wake_at, null);
  const dialog = await dialogue();
  await control(dialog, { action: "pause", all: true });
  await control(dialog, { action: "resume", all: true });
  assert.equal((await goal()).status, "done");
});

test("the daily review cap defers to the next local day without sending a budget message", { skip }, async () => {
  const limited = { ...config(), automationPatrolDailyRounds: 1 };
  await due(); await scheduler(limited).once(); await done((await active())!);
  await due(); await scheduler(limited).once(); await scheduler(limited).once();
  assert.equal(await active(), undefined);
  assert.equal(localDay(new Date((await current()).next_wake_at), "Asia/Shanghai"), localDay(nextLocalDay(now, "Asia/Shanghai"), "Asia/Shanghai"));
  assert.equal((await db.tx(tx => tx.rows("SELECT * FROM automation_reports WHERE category='budget'"))).length, 0);
});

test("a review can record one new goal but cannot change existing ones", { skip }, async () => {
  await due(); await scheduler().once(); const run = (await active())!;
  const listed = await db.tx(tx => manageGoals(tx, user, claims(), goalRequest.parse({ action: "list", run_id: run.run_id, request_id: "x" }))) as { goals: Row[] };
  assert.equal(listed.goals.length, 1);
  await assert.rejects(db.tx(tx => manageGoals(tx, user, claims(), goalRequest.parse({ action: "pause", run_id: run.run_id, request_id: "pause", goal_id: goalId }))), /查看或新建/);
  const created = await db.tx(tx => manageGoals(tx, user, claims(), goalRequest.parse({ action: "create", run_id: run.run_id, request_id: "review-goal", title: "补上遗漏", goal: "把资料里没做完的整理完", authorization: "在自己的资料库内推进" }))) as Row;
  assert.equal(created.goal, "把资料里没做完的整理完");
  assert.equal((await db.tx(tx => manageGoals(tx, user, claims(), goalRequest.parse({ action: "create", run_id: run.run_id, request_id: "review-goal", goal: "把资料里没做完的整理完", authorization: "在自己的资料库内推进" }))) as Row).id, created.id);
  await assert.rejects(db.tx(tx => manageGoals(tx, user, claims(), goalRequest.parse({ action: "create", run_id: run.run_id, request_id: "another", goal: "再加一个", authorization: "在自己的资料库内推进" }))), /只能新建一个/);
  assert.equal((await db.tx(tx => tx.get("bot_runs", run.run_id))).cancel_requested, false);
  assert.equal((await current()).version, 1);
  const visible = await db.tx(tx => listGoals(tx, user, bot));
  assert.equal(visible.goals.find(g => g.id === created.id)?.status, "active");
  assert.equal(visible.goals.find(g => g.id === created.id)?.progress, null);
  await db.tx(tx => recordAutomationEffect(tx, user, claims(), { run_id: run.run_id, phase: "start", tool_call_id: "write-ok" }));
  await assert.rejects(db.tx(tx => saveGoalDecision(tx, user, { ...claims(), bot: randomUUID() }, { run_id: run.run_id, decision: asDecision() })), /不存在/);
  await assert.rejects(db.tx(tx => saveGoalDecision(tx, user, claims(), { run_id: run.run_id, decision: asDecision({ next_wake_at: now.toISOString() }) }, now)), /一分钟/);
});

test("a persisted finish survives loss of the final socket event without repeating work", { skip }, async () => {
  await due(); await scheduler().once(); const run = (await active())!;
  const decision = asDecision({ summary: "已保存的成果", notify: true, notification_key: "saved-outcome" });
  await db.tx(tx => saveGoalDecision(tx, user, claims(), { run_id: run.run_id, decision }, now));
  await db.tx(tx => saveGoalDecision(tx, user, claims(), { run_id: run.run_id, decision }, now));
  hub.detach(conn); await failDeviceRuns(db, device); now = new Date();
  hub.attach(conn); await scheduler().once();
  assert.equal(await active(), undefined);
  assert.equal((await db.tx(tx => tx.rows("SELECT * FROM automation_rounds WHERE automation_id=$1", [review]))).length, 1);
  assert.equal((await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.at(-1)!.content, "已保存的成果");
});

test("new user input during a quiet review survives the end of that round", { skip }, async () => {
  await due(); await scheduler().once(); const run = (await active())!;
  const dialog = await dialogue();
  await db.tx(tx => finishRun(tx, dialog.run_id, "completed", null, "好的"));
  await done(run);
  const a = await current();
  assert.equal(a.idle_count, 0);
  assert.ok(new Date(a.next_wake_at).getTime() <= Date.now() + 61000);
});

test("a goal review cannot hand work to another bot", { skip }, async () => {
  await due(); await scheduler().once(); const root = (await active())!;
  const peer = await db.tx(tx => createBot(tx, user, { name: "协作者", persona: "研究" }));
  await assert.rejects(db.tx(tx => createTask(tx, hub, user, claims(), { run_id: root.run_id, agent: peer.bot_id, task: "核对资料", wait: true })), /其他智能体/);
});

test("a running user task keeps the review waiting, then the review starts when that task ends", { skip }, async () => {
  const dialog = await dialogue();
  const job = await db.tx(tx => createTask(tx, hub, user, claims(), { run_id: dialog.run_id, task: "一次性核查", kind: "background", wait: false }));
  await db.tx(tx => finishRun(tx, dialog.run_id, "completed", null, "已安排"));
  await due(); await scheduler().once(); assert.equal(await active(), undefined, "user work keeps the review waiting");
  await db.tx(tx => finishRun(tx, job.run!.run_id, "completed", null, "核查完成"));
  await scheduler().once(); assert.ok(await active());
});

test("each goal reports its own new progress once", { skip }, async () => {
  const dialog = await dialogue();
  const second = await control(dialog, { action: "create", title: "另一个目标", goal: "记下另一件事的进展", authorization: "只记录，不扩大范围" }) as Row;
  await db.tx(tx => finishRun(tx, dialog.run_id, "completed", null, "又建立了一个"));
  await due(); await scheduler().once();
  await done((await active())!, { goals: [
    { id: goalId, state: "continue", progress: "第一条有进展", notify: true, reason: "有变化", notification_key: "goal-a" },
    { id: second.id, state: "continue", progress: "第二条有进展", notify: true, reason: "有变化", notification_key: "goal-b" },
  ] });
  await scheduler().once();
  let contents = (await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.map(m => m.content);
  assert.ok(contents.includes("第一条有进展")); assert.ok(contents.includes("第二条有进展"));
  await due(); await scheduler().once();
  await done((await active())!, { goals: [
    { id: goalId, state: "continue", progress: "第一条又说一遍", notify: true, reason: "同一状态", notification_key: "goal-a" },
    { id: second.id, state: "continue", progress: "第二条又说一遍", notify: true, reason: "同一状态", notification_key: "goal-b" },
  ] });
  await scheduler().once();
  contents = (await db.tx(tx => messagesPage(tx, bot, undefined, 50))).messages.map(m => m.content);
  assert.equal(contents.filter(c => c === "第一条有进展").length, 1);
  assert.ok(!contents.includes("第一条又说一遍"));
});
