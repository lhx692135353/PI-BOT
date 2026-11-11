import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { Hub, type DeviceConnection } from "../src/hub.js";
import { settings } from "../src/config.js";
import { absoluteClientPath } from "../src/cli.js";
import { createBot, insertRun, buildContext, updateBot } from "../src/bots.js";
import { createTask } from "../src/agents.js";
import { dispatchDevice } from "../src/runs.js";
import { saveCliSession } from "../src/cli-sessions.js";
import { CLI_OFFLINE } from "../src/cli.js";
import { TEST_DB, resetDatabase } from "./helpers.js";

test("client paths accept the computer's own absolute form", () => {
  assert.equal(absoluteClientPath("/home/me/proj"), "/home/me/proj");
  assert.equal(absoluteClientPath("C:\\Users\\me\\proj"), "C:\\Users\\me\\proj");
  assert.equal(absoluteClientPath("\\\\server\\share\\proj"), "\\\\server\\share\\proj");
  assert.equal(absoluteClientPath("relative"), null);
  assert.equal(absoluteClientPath("/home/me/../etc"), null);
});

test("CLI bots stay on the computer that created them", { skip: !TEST_DB }, async () => {
  await resetDatabase(TEST_DB!);
  const db = new Database(TEST_DB!);
  await migrate(db);
  const hub = new Hub();
  const s = settings({
    PI_BOT_DATABASE_URL: TEST_DB,
    PI_BOT_JWT_SECRET: "j".repeat(40),
    PI_BOT_ADMIN_PASSWORD: "test-password",
    PI_BOT_RUNNER_TOKEN: "r".repeat(40),
    PI_BOT_REMOTE_BACKEND: "none",
  });
  const user = randomUUID();
  const device = randomUUID();
  const sent: any[] = [];
  const connect = () => {
    const connection: DeviceConnection = {
      deviceId: device, userId: user, capabilities: ["files", "shell"], close() {},
      send(message) { sent.push(message); },
    };
    hub.attach(connection);
    return connection;
  };
  await db.tx(async tx => {
    await tx.insert("users", { user_id: user, username: "cli-user", password_hash: "unused", role: "user" });
    await tx.insert("devices", { device_id: device, user_id: user, label: "desk", public_key: device, platform: "linux" });
    await tx.insert("models", { model_id: randomUUID(), name: "test", base_url: "https://example.com/v1", provider_model: "test", context_window: 32000, max_tokens: 1000, secret: {}, is_default: true });
  });

  const pi = await db.tx(tx => createBot(tx, user, { name: "Pi", persona: "普通" }));
  const piRun = await db.tx(tx => insertRun(tx, { userId: user, botId: pi.bot_id, requestId: randomUUID(), text: "你好", computer: null }));
  assert.equal(piRun.executor, "cloud");
  assert.equal(piRun.device_id, null);

  await assert.rejects(db.tx(tx => createBot(tx, user, { name: "裸", persona: "", runtime: "codex", cli_profile: "work", cli_directory: "/work" })), /绑定了 Cursor 或 Codex/);
  await assert.rejects(db.tx(tx => createBot(tx, user, { name: "坏", persona: "", runtime: "codex", cli_profile: "../x", cli_directory: "/work" }, device)), /Codex profile/);
  await assert.rejects(db.tx(tx => createBot(tx, user, { name: "相对", persona: "", runtime: "cursor", cli_profile: ".cursor", cli_directory: "work" }, device)), /绝对路径/);

  const cli = await db.tx(tx => createBot(tx, user, { name: "Codex", persona: "写代码", runtime: "codex", cli_profile: "work", cli_directory: "C:\\src\\app" }, device));
  assert.equal(cli.runtime, "codex");
  assert.equal(cli.cli_device_id, device);
  assert.equal(cli.execution_device_id, null);
  const chat = await db.tx(tx => insertRun(tx, { userId: user, botId: cli.bot_id, requestId: randomUUID(), text: "看一下", computer: null }));
  assert.equal(chat.executor, "device");
  assert.equal(chat.device_id, device);
  assert.equal(chat.operation_target, `device:${device}`);

  await dispatchDevice(db, s, hub, chat.run_id);
  const failed = await db.tx(tx => tx.get("bot_runs", chat.run_id));
  const reply = await db.tx(tx => tx.get("bot_messages", chat.assistant_message_id));
  assert.equal(failed.status, "failed");
  assert.equal(failed.executor, "device");
  assert.equal(failed.error, CLI_OFFLINE);
  assert.equal(reply.content, CLI_OFFLINE);
  assert.equal(sent.length, 0);

  const parent = await db.tx(async tx => {
    const run = await insertRun(tx, { userId: user, botId: pi.bot_id, requestId: randomUUID(), text: "请交给本机", computer: { deviceId: device }, sourceClient: "desktop", sourceDeviceId: device, operationTarget: "cloud" });
    return tx.update("bot_runs", run.run_id, { status: "running" });
  });
  const offline = await db.tx(tx => createTask(tx, hub, user, { sub: user, bot: pi.bot_id, src: "cloud" }, { run_id: parent.run_id, agent: "Codex", task: "修一下", wait: false, execution: "cloud" }, s));
  assert.equal(offline.run, null);
  const offlineTask = await db.tx(tx => tx.get("agent_tasks", offline.task.id));
  assert.equal(offlineTask.status, "failed");
  assert.equal(offlineTask.error, CLI_OFFLINE);

  connect();
  const delegated = await db.tx(tx => createTask(tx, hub, user, { sub: user, bot: pi.bot_id, src: "cloud" }, { run_id: parent.run_id, agent: "Codex", task: "再修一下", wait: false, execution: "cloud" }, s));
  const child = delegated.run;
  assert.ok(child);
  assert.equal(child.executor, "device");
  assert.equal(child.device_id, device);
  assert.equal(child.operation_target, `device:${device}`);
  assert.equal(child.lane, "task");
  await dispatchDevice(db, s, hub, child.run_id);
  const context = sent.find(message => message.type === "run")?.run;
  assert.equal(context.cli.runtime, "codex");
  assert.equal(context.cli.fresh, true);
  assert.equal(context.cli.directory, "C:\\src\\app");
  assert.equal(context.executor, "device");

  const indexed = await db.tx(tx => saveCliSession(tx, chat, { engine_session_id: "eng-2", title: "看一下", summary: "done", last_user_text: "看一下" }));
  const resumed = await db.tx(tx => saveCliSession(tx, chat, { session_id: indexed.session_id, engine_session_id: "eng-2", title: "继续", summary: "next", last_user_text: "继续" }));
  assert.equal(resumed.title, "看一下");
  assert.equal(resumed.last_user_text, "继续");
  await db.tx(tx => tx.insert("cli_sessions", {
    session_id: randomUUID(), bot_id: cli.bot_id, device_id: device, engine_session_id: "eng",
    title: "一段", summary: "", last_user_text: "看一下", origin: "user", status: "open",
  }));
  await db.tx(tx => updateBot(tx, user, cli.bot_id, { cli_profile: "other" }));
  const closed = await db.tx(tx => tx.rows("SELECT status FROM cli_sessions WHERE bot_id=$1", [cli.bot_id]));
  assert.equal(closed.every(row => row.status === "closed"), true);
  await db.close();
});
