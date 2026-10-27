import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database, type Row, type Tx } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { botOut, createBot, finishRun, insertRun } from "../src/bots.js";
import { conversation as transcript } from "../src/task-conversation.js";
import { AgentDispatcher, messageTask, readTask } from "../src/agents.js";
import { Hub } from "../src/hub.js";
import { settings } from "../src/config.js";
import { resetDatabase, TEST_DB } from "./helpers.js";

const skip = !TEST_DB;
let db: Database, user: string, a: Row, b: Row;
before(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!); db = new Database(TEST_DB!); await migrate(db);
  user = randomUUID();
  await db.tx(async tx => {
    await tx.insert("users", { user_id: user, username: "activity-user", password_hash: "unused", role: "user" });
    a = await createBot(tx, user, { name: "维护助手", persona: "" });
    b = await createBot(tx, user, { name: "检查助手", persona: "" });
  });
});
after(async () => { if (!skip) await db.close(); });

const view = (tx: Tx, bot: Row) => botOut(tx, bot);
async function conversation(tx: Tx) {
  const run = await insertRun(tx, { userId: user, botId: a.bot_id, requestId: randomUUID(), text: "现在什么进度", computer: null });
  await finishRun(tx, run.run_id, "completed", null, "服务还在启动。");
  return run;
}
async function task(tx: Tx, parent: Row, target: Row, title: string) {
  const t = await tx.insert("agent_tasks", { task_id: randomUUID(), user_id: user, parent_run_id: parent.run_id,
    parent_bot_id: parent.bot_id, target_bot_id: target.bot_id, mode: "wait", kind: parent.bot_id === target.bot_id ? "background" : "delegation",
    depth: parent.bot_id === target.bot_id ? 0 : 1, task: title, title, status: "running" });
  const child = await insertRun(tx, { userId: user, botId: target.bot_id, requestId: `task:${t.task_id}`, text: title,
    computer: null, origin: "agent", lane: "task", taskId: t.task_id, fromBotId: parent.bot_id });
  await tx.rows("UPDATE bot_runs SET status='running' WHERE run_id=$1", [child.run_id]);
  await tx.rows("UPDATE agent_tasks SET child_run_id=$2 WHERE task_id=$1", [t.task_id, child.run_id]);
  return { t, child };
}

test("a completed progress-query reply cannot hide a running background task, including stale terminal metadata", { skip }, async () => {
  await db.tx(async tx => {
    const original = await conversation(tx);
    const { t, child } = await task(tx, original, a, "检查服务启动");
    const query = await conversation(tx);
    await tx.rows("UPDATE bot_runs SET created_at=created_at+interval '1 second' WHERE run_id=$1", [query.run_id]);
    let state = await view(tx, a);
    assert.equal(state.latest_run!.id, query.run_id);
    assert.equal(state.latest_run!.status, "completed");
    assert.equal(state.activity.running_count, 1);
    assert.equal(state.activity.summary, "正在检查服务启动");
    await tx.rows("UPDATE agent_tasks SET status='completed',finished_at=now() WHERE task_id=$1", [t.task_id]);
    state = await view(tx, a);
    assert.equal(state.activity.running_count, 1, "the live executor overrides stale terminal metadata");
    assert.equal(state.active_tasks[0].status, "running");
    const recorded = await readTask(tx, user, { sub: user, bot: a.bot_id, src: "cloud" }, t.task_id);
    assert.equal(recorded.status, "running");
    assert.equal(recorded.result, null);
    await finishRun(tx, child.run_id, "completed", null, "服务已启动。");
    state = await view(tx, a);
    assert.equal(state.activity.running_count, 0);
    assert.equal(state.activity.summary, null);
    assert.equal(state.active_tasks.length, 0, "stale active/terminal metadata cannot resurrect a finished executor");
  });
});

test("only the executing bot is busy; synchronous waiting disappears from counts and returns when it resumes", { skip }, async () => {
  await db.tx(async tx => {
    const parent = await conversation(tx);
    const first = await task(tx, parent, a, "维护服务");
    const delegated = await task(tx, first.child, b, "检查服务启动");
    await tx.rows("UPDATE bot_runs SET waiting_on_task_id=$2 WHERE run_id=$1", [first.child.run_id, delegated.t.task_id]);
    assert.equal((await view(tx, a)).activity.running_count, 0);
    assert.equal((await view(tx, a)).activity.summary, null);
    assert.equal((await view(tx, b)).activity.running_count, 1);
    await tx.rows("UPDATE agent_tasks SET status='completed' WHERE task_id=$1", [delegated.t.task_id]);
    assert.equal((await transcript(tx, user, a.bot_id, delegated.t.task_id)).status, "running");
    await finishRun(tx, delegated.child.run_id, "completed", null, "已核对。");
    await tx.rows("UPDATE bot_runs SET waiting_on_task_id=NULL WHERE run_id=$1", [first.child.run_id]);
    assert.equal((await view(tx, a)).activity.running_count, 1);
    assert.equal((await view(tx, b)).activity.running_count, 0);
    await finishRun(tx, first.child.run_id, "completed", null, "维护完成。");
    assert.equal((await view(tx, a)).activity.summary, null);
  });
});

test("standalone and queued executors remain visible without double-counting missing task links", { skip }, async () => {
  await db.tx(async tx => {
    const parent = await conversation(tx);
    const { t, child } = await task(tx, parent, a, "等待电脑执行");
    await tx.rows("UPDATE agent_tasks SET child_run_id=NULL,status='queued' WHERE task_id=$1", [t.task_id]);
    await tx.rows("UPDATE bot_runs SET status='queued' WHERE run_id=$1", [child.run_id]);
    let state = await view(tx, a);
    assert.equal(state.activity.running_count, 0); assert.equal(state.activity.queued_count, 1);
    await tx.rows("UPDATE bot_runs SET status='running' WHERE run_id=$1", [child.run_id]);
    state = await view(tx, a);
    assert.equal(state.activity.running_count, 1); assert.equal(state.activity.queued_count, 0);
    await finishRun(tx, child.run_id, "cancelled", null);
    // Retire the metadata separately: a missing link is repaired by the dispatcher.
    await tx.rows("UPDATE agent_tasks SET status='cancelled' WHERE task_id=$1", [t.task_id]);
    const standalone = await insertRun(tx, { userId: user, botId: a.bot_id, requestId: randomUUID(), text: "旧版任务", computer: null, lane: "task" });
    await tx.rows("UPDATE bot_runs SET status='running' WHERE run_id=$1", [standalone.run_id]);
    state = await view(tx, a);
    assert.equal(state.activity.running_count, 1);
    assert.equal(state.activity.summary, "正在处理任务");
    await finishRun(tx, standalone.run_id, "failed", "执行中断");
    assert.equal((await view(tx, a)).activity.summary, null);
  });
});

test("reconciliation repairs a missing task link without failing a live executor", { skip }, async () => {
  const record = await db.tx(async tx => {
    const parent = await conversation(tx), record = await task(tx, parent, a, "检查服务启动");
    await tx.rows("UPDATE agent_tasks SET child_run_id=NULL,status='completed',finished_at=now() WHERE task_id=$1", [record.t.task_id]);
    return record;
  });
  const s = settings({ PI_BOT_DATABASE_URL: TEST_DB!, PI_BOT_JWT_SECRET: "j".repeat(40) });
  await new AgentDispatcher(db, s, new Hub()).once();
  await db.tx(async tx => {
    const saved = await tx.get("agent_tasks", record.t.task_id);
    assert.equal(saved.child_run_id, record.child.run_id);
    assert.equal(saved.status, "running"); assert.equal(saved.finished_at, null);
    assert.equal((await view(tx, a)).activity.running_count, 1);
    await finishRun(tx, record.child.run_id, "completed", null, "完成。");
    assert.equal((await view(tx, a)).activity.summary, null);
  });
});

test("delegation follow-ups distinguish queued, pending, acknowledged and finished delivery without duplicate messages", { skip }, async () => {
  await db.tx(async tx => {
    const original = await conversation(tx);
    const { t, child } = await task(tx, original, b, "核实压测停止原因");
    const control = await insertRun(tx, { userId: user, botId: a.bot_id, requestId: randomUUID(), text: "问问他为什么停了", computer: null });
    await tx.rows("UPDATE bot_runs SET status='running' WHERE run_id=$1", [control.run_id]);
    const claims = { sub: user, bot: a.bot_id, src: "cloud" as const };
    const instruction = { run_id: control.run_id, request_id: "relay-followup", text: "为什么停了，数据保存在哪？" };

    await tx.update("agent_tasks", t.task_id, { child_run_id: null, status: "queued" });
    const queued = await messageTask(tx, user, claims, t.task_id, instruction);
    assert.equal(queued.delivery, "queued");
    assert.ok(queued.instruction_id);
    await tx.update("agent_tasks", t.task_id, { child_run_id: child.run_id, status: "running" });
    const pending = await messageTask(tx, user, claims, t.task_id, instruction);
    assert.equal(pending.delivery, "pending");
    assert.equal(pending.instruction_id, queued.instruction_id);
    await tx.rows("UPDATE agent_task_instructions SET delivered_at=now() WHERE instruction_id=$1", [pending.instruction_id]);
    const delivered = await messageTask(tx, user, claims, t.task_id, instruction);
    assert.equal(delivered.delivery, "delivered");
    assert.equal(delivered.instruction_id, queued.instruction_id);
    assert.equal((await tx.rows("SELECT * FROM agent_task_instructions WHERE task_id=$1", [t.task_id])).length, 1);
    let messages = (await transcript(tx, user, a.bot_id, t.task_id)).messages;
    assert.equal(messages.filter(m => m.kind === "instruction" && m.content === instruction.text).length, 1);

    await finishRun(tx, child.run_id, "cancelled", null);
    const finished = await messageTask(tx, user, claims, t.task_id, { ...instruction, request_id: "after-stop" });
    assert.equal(finished.delivery, "finished");
    assert.equal((await tx.rows("SELECT * FROM agent_task_instructions WHERE task_id=$1", [t.task_id])).length, 1);
    messages = (await transcript(tx, user, a.bot_id, t.task_id)).messages;
    assert.equal(messages.filter(m => m.kind === "instruction").length, 1);
    await finishRun(tx, control.run_id, "completed", null, "原任务已结束，需要重新询问。");
  });
});
