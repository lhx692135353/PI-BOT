import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { createRunner } from "../src/runner.js";
import { Worker } from "../src/worker.js";
import { Database } from "../src/db.js";
import { settings } from "../src/config.js";
import { Hub } from "../src/hub.js";
import { claimExecution } from "../src/scheduling.js";
import { AgentDispatcher, createTask, readTask, reportLater } from "../src/agents.js";
import { finishRun, insertRun } from "../src/bots.js";
import { issueLlmToken } from "../src/security.js";
import { EXAMPLE } from "@pi-bot/a2ui";
import type { AgentFactory } from "@pi-bot/agent";
import { deviceKeys, eventually, resetDatabase, socket, tempDir, TEST_DB, vaultFile } from "./helpers.js";

const skip = !TEST_DB && "需要 PI_BOT_TEST_DATABASE_URL";
const hub = new Hub();
const jobs = new Map<string, { finish(text: string): void; messages: string[] }>();
const factory: AgentFactory = async options => {
  let stop: (() => void) | undefined;
  let messages: string[] = [];
  const tool = async (name: string, args: object) => {
    const t = options.tools.find(t => t.name === name)!;
    assert.ok(t, `missing tool ${name}`);
    const result = await t.execute(randomUUID(), args, undefined, undefined, {} as any);
    return result.content.filter(c => c.type === "text").map(c => c.text).join("");
  };
  return {
    tools: options.tools.map(t => t.name), setApiKey: async () => {}, dispose() {},
    abort: async () => { stop?.(); }, steer: async text => { messages.push(text); },
    prompt: async (text, onText) => {
      if (text === "explicit replies") {
        await options.onReply?.({ id: "opening", phase: "opening", text: "先核对服务状态。", generated_at: new Date().toISOString() });
        return await new Promise<string>(resolve => {
          jobs.set("explicit-replies", { messages: [], finish: result => { void (async () => {
            const answer = { id: "answer", phase: "answer" as const, text: result, generated_at: new Date().toISOString() };
            await options.onReply?.(answer); await options.onReply?.(answer);
            resolve(result);
          })(); } });
        });
      }
      if (options.tools.some(t => t.name === "start_task")) {
        if (text.startsWith("launch ")) {
          const name = text.slice(7);
          return `已安排 ${name}：${JSON.parse(await tool("start_task", { execution: "cloud", title: name, task: `work:${name}` })).id}`;
        }
        if (text.startsWith("change ")) {
          const id = text.slice(7);
          await tool("task_message", { task_id: id, text: "请改为蓝色" }); return "补充已送达";
        }
        if (text.startsWith("cancel ")) { await tool("cancel_task", { task_id: text.slice(7) }); return "已请求取消"; }
        if (text === "status") return await tool("task_status", {});
        if (text.startsWith("这是")) return `完成回报：${text.slice(-100)}`;
        return "我在，后台工作继续。";
      }
      assert.ok(!options.tools.some(t => t.name === "start_task"));
      assert.ok(!options.tools.some(t => t.name === "write_file"), "cloud task has no Mac tools");
      const name = text.split("\n")[0].slice(5);
      options.onProgress?.([`PRIVATE task ${name}`]);
      onText(`PRIVATE intermediate ${name}`);
      return await new Promise<string>((resolve, reject) => {
        messages = [];
        jobs.set(name, { messages, finish: result => {
          if (name === "A") void tool("show_ui", { messages: EXAMPLE }).then(() => resolve(result), reject);
          else resolve(result);
        } });
        stop = () => reject(new Error("CANCELLED"));
      });
    },
  };
};

let app: Awaited<ReturnType<typeof createApp>>, runner: Awaited<ReturnType<typeof createRunner>>;
let db: Database, apiDb: Database, worker: Worker, loop: Promise<void>, base: string, token: string, bot: string;
let s: ReturnType<typeof settings>, dir: ReturnType<typeof tempDir>;
async function api(path: string, body?: object, bearer = token) {
  const response = await fetch(base + path, { method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data: any = await response.json();
  return { status: response.status, data };
}
async function send(text: string, request_id = randomUUID()) {
  const r = await api(`/bots/${bot}/messages`, { text, request_id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
async function settled(id: string) {
  return eventually(async () => {
    const r = await db.tx(tx => tx.get("bot_runs", id));
    if (!r || ["queued", "running", "waiting_approval"].includes(r.status)) return false;
    assert.equal(r.status, "completed", JSON.stringify(r));
    return db.tx(tx => tx.get("bot_messages", r.assistant_message_id));
  });
}
before(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!);
  dir = tempDir();
  const secret = "r".repeat(40);
  runner = await createRunner({ token: secret, dir: dir.path, factory });
  await runner.listen({ host: "127.0.0.1", port: 0 });
  const env = { PI_BOT_DATABASE_URL: TEST_DB, PI_BOT_ADMIN_PASSWORD: "test-password", PI_BOT_JWT_SECRET: "j".repeat(40),
    PI_BOT_VAULT_FILE: vaultFile(dir.path), PI_BOT_RUNNER_TOKEN: secret,
    PI_BOT_RUNNER_URL: `http://127.0.0.1:${(runner.server.address() as any).port}`,
    PI_BOT_WORKER_POLL_SECONDS: "0.02", PI_BOT_WORKER_CONCURRENCY: "2" };
  s = settings(env);
  apiDb = new Database(TEST_DB!);
  app = await createApp(s, apiDb, hub);
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  token = (await api("/auth/login", { username: "admin", password: "test-password" }, "")).data.access_token;
  await api("/admin/api/models", { name: "test", base_url: "http://127.0.0.1:1/v1", provider_model: "test", api_key: "test-secret", context_window: 32000, max_tokens: 1000 });
  bot = (await api("/bots")).data.bots[0].id;
  s = settings({ ...env, PI_BOT_INTERNAL_URL: base });
  db = new Database(TEST_DB!);
  worker = new Worker(db, s);
  loop = worker.runForever();
});
after(async () => {
  if (skip) return;
  worker?.stop();
  await loop;
  await runner?.close();
  await app?.close();
  await db?.close();
  dir?.cleanup();
});

test("Runner publishes and persists the opening before completion and deduplicates reply events and final echoes", { skip }, async () => {
  const sent = await send("explicit replies");
  await eventually(() => jobs.has("explicit-replies"));
  const early = await eventually(async () => (await api(`/bots/${bot}/messages`)).data.messages.find((m: any) => m.run_id === sent.run.id && m.role === "assistant" && m.reply_segments.length));
  assert.equal(early.status, "running"); assert.equal(early.reply_segments[0].text, "先核对服务状态。");
  jobs.get("explicit-replies")!.finish("服务正常。");
  const final = await settled(sent.run.id);
  assert.equal(final.reply_segments.length, 2); assert.equal(final.content, "服务正常。");
});

test("two background jobs keep dialogue available, queue a third, steer, cancel and report exactly once without leaking task records", { skip }, async () => {
  db.pushEnabled = apiDb.pushEnabled = true;
  const pushInstallation = randomUUID();
  const pushUser = (await api("/me")).data.user.id;
  await db.tx(tx => tx.rows(`INSERT INTO push_installations(installation_id,user_id,fcm_token,binding_id,session_expires_at,session_issued_at)
    VALUES($1,$2,'async-test-token',$3,now()+interval '1 day',0)`, [pushInstallation,pushUser,randomUUID()]));
  const events = socket(base.replace("http", "ws") + "/ws/events", { authorization: `Bearer ${token}` });
  await events.next(m => m.type === "hello");
  try {
    const requestId = randomUUID();
    const a = await send("launch A", requestId);
    const duplicate = await send("launch A", requestId);
    assert.equal(a.run.id, duplicate.run.id);
    const ack = await settled(a.run.id);
    await eventually(() => jobs.has("A"));
    const taskA = ack.content.split("：").at(-1);
    const chat = await send("你好");
    assert.equal((await settled(chat.run.id)).content, "我在，后台工作继续。");
    await settled((await send("launch B")).run.id);
    await eventually(() => jobs.has("B"));
    await settled((await send("launch C")).run.id);
    let state = (await api(`/bots/${bot}`)).data;
    assert.equal(state.active_tasks.filter((t: any) => t.status === "running").length, 2);
    assert.equal(state.active_tasks.filter((t: any) => t.status === "queued").length, 1);
    assert.equal(jobs.has("C"), false);
    assert.equal(state.activity.summary, "正在A，另有 1 个任务");
    await settled((await send(`change ${taskA}`)).run.id);
    await eventually(() => jobs.get("A")!.messages.length === 1);
    assert.deepEqual(jobs.get("A")!.messages, ["请改为蓝色"]);
    // Both results may race a new conversation: user input still gets a reply.
    jobs.get("A")!.finish("A 的蓝色结果");
    await eventually(() => jobs.has("C"));
    const after = await send("继续聊");
    await settled(after.run.id);
    const uiMessage = await eventually(async () => (await api(`/bots/${bot}/messages`)).data.messages.find((m: any) => m.task_id === taskA && m.ui && m.status === "completed"));
    const action = await api(`/bots/${bot}/messages/${uiMessage.id}/ui-actions`, {
      revision: uiMessage.ui.revision, states: [], request_id: randomUUID(),
      action: { name: "submit", surfaceId: "calculator", sourceComponentId: "submit", context: {} },
    });
    assert.equal(action.status, 200, "a completed UI remains usable while B and C are running");
    await settled(action.data.run.id);
    const taskB = state.active_tasks.find((t: any) => t.title === "B").id;
    await settled((await send(`cancel ${taskB}`)).run.id);
    await eventually(async () => (await db.tx(tx => tx.get("agent_tasks", taskB))).status === "cancelled");
    jobs.get("C")!.finish("C 的结果");
    await eventually(async () => {
      const tasks = await db.tx(tx => tx.rows("SELECT * FROM agent_tasks WHERE parent_bot_id=$1", [bot]));
      return tasks.length === 3 && tasks.every(t => t.report_run_id && t.delivered_at);
    });
    const reports = await db.tx(tx => tx.rows("SELECT * FROM bot_runs WHERE origin='report' AND bot_id=$1", [bot]));
    for (const report of reports) await settled(report.run_id);
    assert.equal(reports.length, 3);
    const reportDeliveries = await db.tx(tx => tx.rows("SELECT * FROM push_deliveries WHERE source_id=ANY($1::uuid[])", [reports.map(r => r.assistant_message_id)]));
    assert.equal(reportDeliveries.length, 3, "each public task result creates one notification");
    const privateDeliveries = await db.tx(tx => tx.rows(`SELECT d.* FROM push_deliveries d JOIN bot_messages m ON m.message_id=d.source_id WHERE m.visibility<>'public'`));
    assert.equal(privateDeliveries.length, 0, "private task output does not become a push preview");
    await new AgentDispatcher(db, s, hub).once();
    assert.equal((await db.tx(tx => tx.rows("SELECT * FROM bot_runs WHERE bot_id=$1 AND origin='report'", [bot]))).length, 3, "a fresh dispatcher does not redeliver acknowledged reports");
    const page = (await api(`/bots/${bot}/messages`)).data.messages;
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE/);
    assert.doesNotMatch(JSON.stringify(events.frames), /PRIVATE/);
    assert.ok(page.some((m: any) => m.task_id === taskA && m.ui), "A2UI is attached to a public report message");
    assert.equal((await db.tx(tx => tx.rows("SELECT * FROM agent_tasks WHERE parent_run_id=$1", [a.run.id]))).length, 1);
    state = (await api(`/bots/${bot}`)).data;
    assert.equal(state.active_tasks.length, 0);
    const taskRun = (await db.tx(tx => tx.get("agent_tasks", taskA))).child_run_id;
    const context = await db.tx(async tx => {
      const { buildContext } = await import("../src/bots.js");
      return buildContext(tx, s, await tx.get("bot_runs", chat.run.id));
    });
    assert.ok(!context.history.some(m => m.content.includes("PRIVATE")));
    assert.notEqual(taskRun, a.run.id);
  } finally {
    events.close();
    db.pushEnabled = apiDb.pushEnabled = false;
    await db.tx(tx => tx.rows("DELETE FROM push_installations WHERE installation_id=$1", [pushInstallation]));
  }
});

test("task endpoints validate run identity, user and bot ownership, and durable instruction retries are idempotent", { skip }, async () => {
  const user = (await api("/me")).data.user;
  const context = await db.tx(async tx => {
    const run = await insertRun(tx, { userId: user.id, botId: bot, requestId: randomUUID(), text: "control", computer: null });
    await tx.rows("UPDATE bot_runs SET status='running' WHERE run_id=$1", [run.run_id]);
    return run;
  });
  const llm = await issueLlmToken({ sub: user.id, src: "cloud", bot }, s);
  const wrongBot = (await api("/bots", { name: "other", persona: "" })).data.id;
  const wrong = await issueLlmToken({ sub: user.id, src: "cloud", bot: wrongBot }, s);
  const created = await api("/agent/tasks", { run_id: context.run_id, kind: "background", execution: "cloud", title: "D", task: "work:D", wait: false, request_id: "stable-call" }, llm);
  assert.equal(created.status, 200);
  const repeated = await api("/agent/tasks", { run_id: context.run_id, kind: "background", execution: "cloud", task: "work:D", wait: false, request_id: "stable-call" }, llm);
  assert.equal(repeated.data.id, created.data.id);
  assert.equal((await api(`/agent/tasks/${created.data.id}?run_id=${context.run_id}`, undefined, wrong)).status, 404);
  assert.equal((await api("/agent/tasks", { run_id: context.run_id, agent: "other", task: "x", wait: true }, llm)).status, 422);
  const instruction = { run_id: context.run_id, request_id: "stable-instruction", text: "补充条件" };
  for (let i = 0; i < 2; i++) assert.equal((await api(`/agent/tasks/${created.data.id}/messages`, instruction, llm)).status, 200);
  assert.equal((await db.tx(tx => tx.rows("SELECT * FROM agent_task_instructions WHERE task_id=$1", [created.data.id]))).length, 1);
  await db.tx(tx => finishRun(tx, context.run_id, "failed", "control failed"));
  await eventually(() => jobs.has("D"));
  jobs.get("D")!.finish("D completed after control failed");
  await eventually(async () => (await db.tx(tx => tx.get("agent_tasks", created.data.id))).status === "completed");
  // Drain the asynchronous report before the next test attaches a manual Mac executor.
  const report = await eventually(async () => (await db.tx(tx => tx.get("agent_tasks", created.data.id))).report_run_id);
  await settled(report);
});

test("Mac task events remain private, queued dialogue survives disconnect, and interrupted work is reported without re-executing", { skip }, async () => {
  const keys = deviceKeys();
  const registration = await api("/devices/register", { public_key: keys.publicKey, label: "async test Mac" });
  keys.setId(registration.data.device.id);
  const computer = socket(base.replace("http", "ws") + "/ws/device", keys.headers("GET", "/ws/device"));
  await computer.next(m => m.type === "hello");
  const events = socket(base.replace("http", "ws") + "/ws/events", { authorization: `Bearer ${token}` });
  await events.next(m => m.type === "hello");
  computer.send({type:"capabilities",features:["files","shell","always-on-v1"]});
  await eventually(()=>hub.device(registration.data.device.user_id,registration.data.device.id)?.capabilities?.includes("shell"));
  const user = (await api("/me")).data.user;
  const control = await db.tx(async tx => {
    const run=await insertRun(tx,{userId:user.id,botId:bot,requestId:randomUUID(),text:"manual control",computer:null,sourceClient:"desktop",sourceDeviceId:registration.data.device.id});
    return tx.update("bot_runs",run.run_id,{status:"running"});
  });
  const llm = await issueLlmToken({ sub: user.id, src: "cloud", bot }, s);
  const t = await api("/agent/tasks", { run_id: control.run_id, kind: "background", execution: "device",device_id:registration.data.device.id, title: "Mac work", task: "Mac files", wait: false }, llm);
  assert.equal(t.status, 200, JSON.stringify(t.data));
  const task = (await computer.next(m => m.type === "run" && m.run.lane === "task")).run;
  computer.send({ type: "run_event", run_id: task.run_id, event: { kind: "text", text: "PRIVATE Mac output" } });
  computer.send({ type: "run_event", run_id: task.run_id, event: { kind: "approval", request_id: "outside", path: "/tmp/specific", reason: "needed" } });
  await computer.next(m => m.type === "approval_created");
  const detail = (await api(`/bots/${bot}`)).data;
  assert.ok(detail.pending_approvals.some((a: any) => a.run_id === task.run_id));
  const message = await api(`/agent/tasks/${t.data.id}/messages`, { run_id: control.run_id, request_id: "computer-instruction", text: "please change" }, llm);
  assert.equal(message.status, 200);
  const forwarded = await computer.next(m => m.type === "task_message" && m.run_id === task.run_id);
  computer.send({ type: "run_event", run_id: task.run_id, event: { kind: "instruction_ack", id: forwarded.instruction_id } });
  await eventually(async () => (await db.tx(tx => tx.one("SELECT delivered_at FROM agent_task_instructions WHERE instruction_id=$1", [forwarded.instruction_id])))?.delivered_at);
  const queued = await send("queued conversation");
  assert.equal((await db.tx(tx => tx.get("bot_runs", queued.run.id))).status, "queued");
  assert.doesNotMatch(JSON.stringify(events.frames), /PRIVATE Mac/);
  computer.close();
  await computer.closed;
  await db.tx(tx=>finishRun(tx,control.run_id,"completed",null,"control finished"));
  await settled(queued.run.id);
  await eventually(async () => (await db.tx(tx => tx.get("agent_tasks", t.data.id))).status === "failed");
  const saved = await db.tx(tx => tx.get("agent_tasks", t.data.id));
  assert.equal(saved.child_run_id, task.run_id);
  await eventually(async () => (await db.tx(tx => tx.get("agent_tasks", t.data.id))).report_run_id);
  assert.equal((await api(`/bots/${bot}`)).data.pending_approvals.length, 0);
  assert.doesNotMatch(JSON.stringify((await api(`/bots/${bot}/messages`)).data), /PRIVATE Mac/);
  events.close();
});

test("waiting delegation releases its slot and resumes only when capacity is available", { skip }, async () => {
  // Stop automatic execution to make the capacity boundary deterministic.
  worker.stop();
  await loop;
  const user = (await api("/me")).data.user;
  const target = (await api("/bots", { name: "specialist", persona: "" })).data.id;
  const capacityWorker = randomUUID();
  await db.tx(async tx => {
    const parent = await insertRun(tx, { userId: user.id, botId: bot, requestId: randomUUID(), text: "parent", computer: null, lane: "task" });
    assert.ok(await claimExecution(tx, parent.run_id, s, capacityWorker));
    const task = await createTask(tx, hub, user.id, { sub: user.id, src: "cloud", bot } as any, { run_id: parent.run_id, agent: "specialist", task: "child", wait: true,execution:"cloud" });
    assert.equal((await tx.get("bot_runs", parent.run_id)).waiting_on_task_id, task.task.id);
    const a = await insertRun(tx, { userId: user.id, botId: bot, requestId: randomUUID(), text: "a", computer: null, lane: "task" });
    const b = await insertRun(tx, { userId: user.id, botId: bot, requestId: randomUUID(), text: "b", computer: null, lane: "task" });
    assert.ok(await claimExecution(tx, a.run_id, s, capacityWorker));
    assert.ok(await claimExecution(tx, b.run_id, s, capacityWorker));
    await finishRun(tx, task.run!.run_id, "completed", null, "child result");
    const claims = { sub: user.id, src: "cloud", bot } as any;
    assert.equal((await readTask(tx, user.id, claims, task.task.id, s, true)).status, "running");
    await assert.rejects(reportLater(tx, user.id, claims, task.task.id, s), /等待执行名额/);
    await finishRun(tx, a.run_id, "completed", null);
    assert.equal((await readTask(tx, user.id, claims, task.task.id, s, true)).status, "completed");
    assert.equal((await tx.get("bot_runs", parent.run_id)).waiting_on_task_id, null);
    await finishRun(tx, parent.run_id, "completed", null);
    await finishRun(tx, b.run_id, "completed", null);
  });
  assert.ok(target);
});

test("multiple workers share the Bot capacity limit and queued user turns precede reports", { skip }, async () => {
  const user = (await api("/me")).data.user;
  const dedicated = (await api("/bots", { name: "capacity boundary", persona: "" })).data.id;
  const runs = await db.tx(async tx => {
    const tasks = [];
    for (let i = 0; i < 3; i++) tasks.push(await insertRun(tx, { userId: user.id, botId: dedicated,
      requestId: randomUUID(), text: `task ${i}`, computer: null, lane: "task" }));
    const report = await insertRun(tx, { userId: user.id, botId: dedicated, requestId: randomUUID(), text: "report", computer: null, origin: "report" });
    const human = await insertRun(tx, { userId: user.id, botId: dedicated, requestId: randomUUID(), text: "human", computer: null });
    return { tasks, report, human };
  });
  const workers = runs.tasks.map(() => randomUUID());
  await Promise.all(runs.tasks.map((r, i) => db.tx(tx => claimExecution(tx, r.run_id, s, workers[i]))));
  for (let i = 0; i < runs.tasks.length; i++) await db.tx(tx => claimExecution(tx, runs.tasks[i].run_id, s, workers[i]));
  const active = await db.tx(tx => tx.rows("SELECT * FROM bot_runs WHERE bot_id=$1 AND lane='task' AND status='running'", [dedicated]));
  assert.equal(active.length, 2);
  await db.tx(async tx => {
    assert.equal(await claimExecution(tx, runs.report.run_id, s, randomUUID()), null);
    assert.ok(await claimExecution(tx, runs.human.run_id, s, randomUUID()), "dialogue still claims with both task slots in use");
    assert.equal(await claimExecution(tx, runs.report.run_id, s, randomUUID()), null);
    await finishRun(tx, runs.human.run_id, "completed", null, "human reply");
    assert.ok(await claimExecution(tx, runs.report.run_id, s, randomUUID()));
    for (const r of [...runs.tasks, runs.report]) await finishRun(tx, r.run_id, "completed", null);
  });
});
