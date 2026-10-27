import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { settings, type Settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Worker } from "../src/worker.js";
import { createRunner } from "../src/runner.js";
import { SseUsage } from "../src/llm.js";
import { insertRun } from "../src/bots.js";
import { dispatchDevice } from "../src/runs.js";
import { createBotAgent } from "@pi-bot/agent";
import { WebSearch } from "../src/search.js";
import { Hub } from "../src/hub.js";
import { DEFAULT_AVATAR } from "@pi-bot/bot-face";
import { latestUserText } from "../../packages/agent/tests/responses.js";
import { deviceKeys, eventually, mockProvider, mockSearch, resetDatabase, socket, TEST_DB, tempDir, vaultFile } from "./helpers.js";

const skip = !TEST_DB && "需要 PI_BOT_TEST_DATABASE_URL";
let app: Awaited<ReturnType<typeof createApp>>, base: string, s: Settings;
let provider: Awaited<ReturnType<typeof mockProvider>>, dir: ReturnType<typeof tempDir>;
let search: Awaited<ReturnType<typeof mockSearch>>;
let runner: Awaited<ReturnType<typeof createRunner>>, worker: Worker, workerDb: Database, workerLoop: Promise<void>;
const RUNNER_TOKEN = "r".repeat(40);

async function api(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const r = await fetch(base + path, {
    method,
    headers: {
      ...(payload ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: payload,
  });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

before(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!);
  dir = tempDir();
  provider = await mockProvider();
  search = await mockSearch();
  runner = await createRunner({ token: RUNNER_TOKEN, dir: dir.path, factory: async options => {
    const agent = await createBotAgent(options);
    return { ...agent, tools: agent.tools, setApiKey: key => agent.setApiKey(key), abort: () => agent.abort(), dispose: () => agent.dispose(), prompt: async (text, onText, images) => {
      if (text === "进度链路测试") {
        onText("我先查查资料。");
        options.onProgress?.(["我先查查资料。"]);
        onText("");
        options.onProgress?.(["我先查查资料。", "信息已核对，开始整理。"]);
      }
      return agent.prompt(text, onText, images);
    } };
  } });
  await runner.listen({ port: 0, host: "127.0.0.1" });
  const runnerUrl = `http://127.0.0.1:${(runner.server.address() as any).port}`;
  const env = {
    PI_BOT_DATABASE_URL: TEST_DB,
    PI_BOT_ADMIN_PASSWORD: "admin-password",
    PI_BOT_JWT_SECRET: "j".repeat(40),
    PI_BOT_VAULT_FILE: vaultFile(dir.path),
    PI_BOT_RUNNER_TOKEN: RUNNER_TOKEN,
    PI_BOT_RUNNER_URL: runnerUrl,
    PI_BOT_MEMORY_THRESHOLD: "10",
    PI_BOT_WORKER_POLL_SECONDS: "0.05",
    PI_BOT_RPC_TIMEOUT_MS: "1500",
    PI_BOT_TAVILY_API_KEY: "tvly-test-key",
  };
  s = settings(env);
  app = await createApp(s, undefined, new Hub(), new WebSearch(s, search.fetch));
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  s = settings({ ...env, PI_BOT_INTERNAL_URL: base });
  workerDb = new Database(TEST_DB!);
  worker = new Worker(workerDb, s);
});
after(async () => {
  if (skip) return;
  worker?.stop();
  await workerLoop;
  await workerDb?.close();
  await app?.close();
  await runner?.close();
  await provider?.close();
  await search?.close();
  dir?.cleanup();
});

const state: Record<string, any> = {};

test("admin bootstraps from env, creates users and models; users cannot reach admin API", { skip }, async () => {
  const bad = await api("POST", "/auth/login", { body: { username: "admin", password: "wrong" } });
  assert.equal(bad.status, 401);
  const admin = await api("POST", "/auth/login", { body: { username: "admin", password: "admin-password" } });
  assert.equal(admin.status, 200);
  assert.equal(admin.json.user.role, "admin");
  state.admin = admin.json.access_token;

  const created = await api("POST", "/admin/api/users", { token: state.admin, body: { username: "alice", password: "alice-password", display_name: "Alice" } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const dup = await api("POST", "/admin/api/users", { token: state.admin, body: { username: "ALICE", password: "alice-password" } });
  assert.equal(dup.status, 409);
  const alice = await api("POST", "/auth/login", { body: { username: "alice", password: "alice-password" } });
  state.alice = alice.json.access_token;
  state.aliceId = alice.json.user.id;
  assert.equal((await api("GET", "/admin/api/users", { token: state.alice })).status, 403);

  const noModel = await api("POST", "/bots", { token: state.alice, body: { name: "早到的" } });
  const early = await api("POST", `/bots/${noModel.json.id}/messages`, { token: state.alice, body: { text: "hi", request_id: randomUUID() } });
  assert.equal(early.status, 503);
  await api("DELETE", `/bots/${noModel.json.id}`, { token: state.alice });

  const model = await api("POST", "/admin/api/models", {
    token: state.admin,
    body: { name: "测试模型", base_url: provider.url, provider_model: "upstream-model", api_key: "sk-provider-secret", context_window: 32000, max_tokens: 1000 },
  });
  assert.equal(model.status, 200, JSON.stringify(model.json));
  assert.equal(model.json.is_default, true, "first model becomes default");
  assert.equal(JSON.stringify(model.json).includes("sk-provider-secret"), false);
  state.model = model.json.id;
  const tested = await api("POST", `/admin/api/models/${state.model}/test`, { token: state.admin });
  assert.equal(tested.json.ok, true, JSON.stringify(tested.json));
  assert.equal(provider.requests.at(-1)!.headers.authorization, "Bearer sk-provider-secret");
  assert.equal(provider.requests.at(-1)!.body.max_output_tokens, 1000, "connectivity tests allow the configured reasoning/output budget");
  const models = await api("GET", "/models", { token: state.alice });
  assert.deepEqual(models.json.map((m: any) => m.name), ["测试模型"]);
  assert.equal("base_url" in models.json[0], false, "users never see provider details");
});

test("bots are per user with unique library slugs and a default avatar", { skip }, async () => {
  const a = await api("POST", "/bots", { token: state.alice, body: { name: "Research Bot", persona: "帮我整理资料" } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.slug, "research-bot");
  assert.ok(a.json.avatar.shape && a.json.avatar.color);
  const b = await api("POST", "/bots", { token: state.alice, body: { name: "Research Bot", avatar: { shape: "bean", color: "mint" } } });
  assert.equal(b.json.slug, "research-bot-2");
  const c = await api("POST", "/bots", { token: state.alice, body: { name: "小助手" } });
  assert.match(c.json.slug, /^bot(-\d+)?$/);
  const renamed = await api("PATCH", `/bots/${b.json.id}`, { token: state.alice, body: { name: "Notes" } });
  assert.equal(renamed.json.slug, "research-bot-2", "library folder never moves");
  const admin = await api("GET", `/bots/${a.json.id}`, { token: state.admin });
  assert.equal(admin.status, 404, "bots are private to their owner");
  state.bot = a.json.id;
  state.bot2 = c.json.id;
  const list = await api("GET", "/bots", { token: state.alice });
  assert.equal(list.json.bots.length, 4);
  assert.equal(list.json.computer.online, false);
});

test("each account gets one pinned main bot, including concurrent first loads and an existing Pi Bot slug", { skip }, async () => {
  const lists = await Promise.all(Array.from({ length: 4 }, () => api("GET", "/bots", { token: state.alice })));
  const main = lists[0].json.bots[0];
  assert.equal(main.is_main, true);
  assert.equal(main.name, "Pi Bot");
  assert.deepEqual(main.avatar, DEFAULT_AVATAR);
  assert.ok(lists.every(list => list.json.bots.filter((b: any) => b.is_main).length === 1 && list.json.bots[0].id === main.id));
  assert.equal((await api("DELETE", `/bots/${main.id}`, { token: state.alice })).status, 409);
  state.mainBot = main.id;

  await api("POST", "/admin/api/users", { token: state.admin, body: { username: "charlie", password: "charlie-password" } });
  const token = (await api("POST", "/auth/login", { body: { username: "charlie", password: "charlie-password" } })).json.access_token;
  const custom = await api("POST", "/bots", { token, body: { name: "Pi Bot" } });
  assert.equal(custom.json.slug, "pi-bot");
  const firstLoads = await Promise.all(Array.from({ length: 4 }, () => api("GET", "/bots", { token })));
  assert.ok(firstLoads.every(list => list.json.bots.length === 2 && list.json.bots[0].is_main && list.json.bots[0].slug === "pi-bot-2"));
  assert.ok(firstLoads.every(list => list.json.bots[0].id === firstLoads[0].json.bots[0].id));
});

test("the model proxy injects the provider key, rewrites the model and records usage", { skip }, async () => {
  const keys = deviceKeys();
  const reg = await api("POST", "/devices/register", { token: state.alice, body: { public_key: keys.publicKey, label: "Alice 的 MacBook" } });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  keys.setId(reg.json.device.id);
  state.keys = keys;
  const body = JSON.stringify({ bot_id: state.bot });
  const token = await api("POST", "/device/llm-token", { body: { bot_id: state.bot }, headers: keys.headers("POST", "/device/llm-token", body) });
  assert.equal(token.status, 200, JSON.stringify(token.json));
  const replay = await api("POST", "/device/llm-token", { body: { bot_id: state.bot }, headers: keys.headers("POST", "/device/llm-token", "{}") });
  assert.equal(replay.status, 401, "signature covers the body");
  const r = await fetch(`${base}/llm/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.json.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: state.model, stream: true, max_output_tokens: 5000, input: [{ role: "user", content: "你好" }] }),
  });
  assert.equal(r.status, 200);
  const sse = await r.text();
  assert.match(sse, /"delta":"收"/);
  assert.match(sse, /"input_tokens":42/);
  const forwarded = provider.requests.at(-1)!;
  assert.equal(forwarded.body.model, "upstream-model");
  assert.equal(forwarded.body.max_output_tokens, 1000);
  assert.equal(forwarded.body.store, false);
  assert.equal(forwarded.headers.authorization, "Bearer sk-provider-secret");
  const oneShot = await api("POST", "/llm/v1/responses", { token: token.json.token, body: { model: state.model, input: "你好", store: true } });
  assert.equal(oneShot.status, 200);
  assert.equal(oneShot.json.output[0].content[0].text, "收到：你好");
  assert.equal(provider.requests.at(-1)!.body.input, "你好");
  assert.equal(provider.requests.at(-1)!.body.max_output_tokens, 1000);
  assert.equal(provider.requests.at(-1)!.body.store, false);
  const requestCount = provider.requests.length;
  for (const body of [{ messages: [] }, { input: 42 }, { input: [], max_output_tokens: -1 }]) {
    assert.equal((await api("POST", "/llm/v1/responses", { token: token.json.token, body })).status, 422);
  }
  assert.equal(provider.requests.length, requestCount, "invalid Responses requests never reach the provider");
  const userToken = await fetch(`${base}/llm/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.alice}`, "content-type": "application/json" },
    body: JSON.stringify({ model: state.model, input: [] }),
  });
  assert.equal(userToken.status, 401, "user tokens cannot call the proxy");
  const count = search.queries.length;
  assert.equal((await api("POST", "/web/search", { body: { query: "未认证" } })).status, 401);
  assert.equal((await api("POST", "/web/search", { token: state.alice, body: { query: "普通令牌" } })).status, 401);
  assert.equal(search.queries.length, count, "unauthenticated requests never reach the search service");
  assert.equal((await api("POST", "/web/search", { token: token.json.token, body: { query: " " } })).status, 422);
  const searched = await api("POST", "/web/search", { token: token.json.token, body: { query: "原文 & site:gov.cn", language: "zh-CN" } });
  assert.equal(searched.status, 200);
  assert.equal(searched.json.results[0].title, "Pi Bot 官方资料");
  assert.equal(search.queries.at(-1)?.query, "原文 & site:gov.cn");
  assert.equal((await api("GET", "/admin/api/search/usage", { token: state.alice })).status, 403);
  const searchUsage = await api("GET", "/admin/api/search/usage", { token: state.admin });
  assert.equal(searchUsage.status, 200);
  assert.equal(searchUsage.json.remaining, 999);
  assert.equal(searchUsage.json.plan, "Researcher");
  assert.ok(!JSON.stringify(searchUsage.json).includes("tvly-test-key"));
  const usage = await eventually(async () => {
    const u = await api("GET", "/admin/api/usage", { token: state.admin });
    return u.json.by_user.find((x: any) => x.username === "alice" && x.input_tokens >= 42) && u.json;
  });
  assert.ok(usage.by_model.length);
});

test("Mac online: runs execute on the Mac with tools, approvals and file RPC", { skip }, async () => {
  const computer = socket(base.replace("http", "ws") + "/ws/device", state.keys.headers("GET", "/ws/device"));
  await computer.next((m) => m.type === "hello");
  const events = socket(base.replace("http", "ws") + "/ws/events", { authorization: `Bearer ${state.alice}` });
  await events.next((m) => m.type === "hello" && m.device_online === true);
  assert.equal((await api("GET", "/me", { token: state.alice })).json.computer.online, true);

  const requestId = randomUUID();
  const posted = await api("POST", `/bots/${state.bot}/messages`, { token: state.alice, body: { text: "整理一下桌面", request_id: requestId } });
  assert.equal(posted.status, 200, JSON.stringify(posted.json));
  assert.equal(posted.json.run.executor, "device");
  assert.deepEqual(posted.json.messages.at(-1).progress, [], "queued replies wait for model text instead of inserting a canned acknowledgement");
  const again = await api("POST", `/bots/${state.bot}/messages`, { token: state.alice, body: { text: "整理一下桌面", request_id: requestId } });
  assert.equal(again.json.run.id, posted.json.run.id, "request_id is idempotent");
  const busy = await api("POST", `/bots/${state.bot}/messages`, { token: state.alice, body: { text: "另一件事", request_id: randomUUID() } });
  assert.equal(busy.status, 200, "a second conversation is accepted and queued");
  await api("POST", `/runs/${busy.json.run.id}/cancel`, { token: state.alice });

  const { run } = await computer.next((m) => m.type === "run");
  assert.equal(run.bot.slug, "research-bot");
  assert.match(run.system, /~\/pi-bot\/research-bot/);
  assert.match(run.system, /帮我整理资料/);
  assert.doesNotMatch(run.system, /user_message/);
  assert.doesNotMatch(run.system, /最多三句/);
  assert.equal(run.text, "整理一下桌面");
  const runId = run.run_id;
  computer.send({ type: "run_event", run_id: runId, event: { kind: "started" } });
  computer.send({ type: "run_event", run_id: runId, event: { kind: "tool", id: "t1", name: "list_files", state: "running", summary: "." } });
  computer.send({ type: "run_event", run_id: runId, event: { kind: "text", text: "正在查看" } });
  const delta = await events.next((m) => m.event?.type === "delta");
  assert.equal(delta.event.content, "正在查看");
  computer.send({ type: "run_event", run_id: runId, event: { kind: "progress", lines: ["我先看看桌面上的文件。"] } });
  const progressPage = await eventually(async () => {
    const p = await api("GET", `/bots/${state.bot}/messages`, { token: state.alice });
    const m = p.json.messages.find((m: any) => m.run_id === runId && m.role === "assistant");
    return m.progress?.[0] === "我先看看桌面上的文件。" && m;
  });
  assert.deepEqual(progressPage.progress, ["我先看看桌面上的文件。"]);
  assert.equal(progressPage.content, "", "remarks move above the answer instead of remaining in its body");
  computer.send({ type: "run_event", run_id: runId, event: { kind: "approval", request_id: "q1", path: "/Users/alice/Desktop", reason: "需要整理桌面" } });
  const created = await computer.next((m) => m.type === "approval_created");
  const detail = await eventually(async () => {
    const b = await api("GET", `/bots/${state.bot}`, { token: state.alice });
    return b.json.pending_approvals?.length && b.json;
  });
  assert.equal(detail.latest_run.status, "waiting_approval");
  assert.equal(detail.pending_approvals[0].path, "/Users/alice/Desktop");
  const decided = await api("POST", `/approvals/${created.approval_id}`, { token: state.alice, body: { decision: "approve" } });
  assert.equal(decided.json.status, "approved");
  const decision = await computer.next((m) => m.type === "approval");
  assert.equal(decision.decision, "approve");
  assert.equal((await api("POST", `/approvals/${created.approval_id}`, { token: state.alice, body: { decision: "reject" } })).status, 409);

  const listing = api("GET", `/bots/${state.bot}/files?path=notes`, { token: state.alice });
  const rpc = await computer.next((m) => m.type === "rpc");
  assert.equal(rpc.method, "files.list");
  assert.deepEqual(rpc.params, { slug: "research-bot", path: "notes" });
  computer.send({ type: "rpc_result", id: rpc.id, ok: true, result: { entries: [{ name: "a.md", type: "file", size: 3 }] } });
  assert.deepEqual((await listing).json.entries[0].name, "a.md");
  const slow = await api("GET", `/bots/${state.bot}/files/content?path=a.md`, { token: state.alice });
  assert.equal(slow.status, 504);

  computer.send({ type: "run_event", run_id: runId, event: { kind: "tool", id: "t1", name: "list_files", state: "completed" } });
  computer.send({ type: "run_event", run_id: runId, event: { kind: "done", state: "completed", text: "桌面已整理好。" } });
  const page = await eventually(async () => {
    const p = await api("GET", `/bots/${state.bot}/messages`, { token: state.alice });
    return p.json.messages.find((m: any) => m.run_id === runId && m.role === "assistant")?.status === "completed" && p.json;
  });
  const reply = page.messages.find((m: any) => m.run_id === runId && m.role === "assistant");
  assert.equal(reply.content, "桌面已整理好。");
  assert.equal(reply.executor, "device");
  assert.deepEqual(reply.progress, ["我先看看桌面上的文件。"], "progress survives the final answer and reloading history");
  assert.deepEqual(reply.tools.map((t: any) => [t.name, t.state]), [["list_files", "completed"]]);

  await api("POST", `/bots/${state.bot}/messages`, { token: state.alice, body: { text: "再做一件事", request_id: randomUUID() } });
  const second = await computer.next((m) => m.type === "run");
  assert.deepEqual(second.run.history.filter((m: any) => m.role === "assistant").map((m: any) => m.content), ["我先看看桌面上的文件。", "桌面已整理好。"]);
  assert.ok(second.run.history.some((m: any) => m.role === "user" && m.content === "整理一下桌面"));
  assert.equal(JSON.stringify(second.run.history).includes("list_files"), false, "tool execution stays out of later context");
  computer.send({ type: "run_event", run_id: second.run.run_id, event: { kind: "started" } });
  const cancelled = await api("POST", `/runs/${second.run.run_id}/cancel`, { token: state.alice });
  assert.equal(cancelled.status, 200);
  await computer.next((m) => m.type === "cancel" && m.run_id === second.run.run_id);

  computer.close();
  await events.next((m) => m.event?.type === "presence" && m.event.online === false);
  const failed = await eventually(async () => {
    const b = await api("GET", `/bots/${state.bot}`, { token: state.alice });
    return b.json.latest_run.status !== "running" && b.json.latest_run;
  });
  assert.equal(failed.status, "cancelled", "cancel requested before the Mac dropped");
  const offline = await api("GET", `/bots/${state.bot}/files`, { token: state.alice });
  assert.equal(offline.status, 503);
  events.close();
});

test("Mac offline: runs fall back to the cloud runner through the proxy, with memory", { skip }, async () => {
  workerLoop = worker.runForever();
  const send = async (text: string) => {
    const r = await api("POST", `/bots/${state.bot2}/messages`, { token: state.alice, body: { text, request_id: randomUUID() } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.run.executor, "cloud");
    return eventually(async () => {
      const p = await api("GET", `/bots/${state.bot2}/messages`, { token: state.alice });
      const last = p.json.messages.at(-1);
      return last.status !== "running" && (text !== "联网搜索链路测试" || last.task_id) && last;
    }, 20000);
  };
  const first = await send("记住蓝鲸");
  assert.equal(first.status, "completed", JSON.stringify(first));
  assert.equal(first.content, "好的，我记住了蓝鲸。");
  const forwarded = provider.requests.findLast(r => r.body.stream && latestUserText(r.body.input).includes("记住蓝鲸"))!.body;
  assert.equal(forwarded.model, "upstream-model");
  assert.match(forwarded.input[0].content, /当前运行在云端，绑定电脑的资料库文件和终端在本次运行中不可用/);
  assert.deepEqual(forwarded.tools.map((t: any) => t.name), ["start_task", "task_status", "task_message", "cancel_task", "goal_manage", "ask_agent", "get_ui_catalog", "show_ui", "send_reply", "skill_manage", "skill_load", "memory_manage", "history_search", "agent_directory", "resume_task"], "cloud conversation runs get memory and collaboration, never file or shell tools");
  const second = await send("之前说了什么？");
  assert.equal(second.content, "你之前说的是蓝鲸。");
  assert.deepEqual(second.progress, [], "direct answers have no extra acknowledgement");
  const progressReply = await send("进度链路测试");
  assert.equal(progressReply.content, "收到：进度链路测试");
  assert.deepEqual(progressReply.progress, ["我先查查资料。", "信息已核对，开始整理。"], "Runner progress is persisted by the worker");
  const searched = await send("联网搜索链路测试");
  assert.equal(searched.status, "completed", JSON.stringify(searched));
  assert.match(searched.content, /Pi Bot 官方资料/);
  assert.deepEqual(searched.tools, [], "search tools execute privately and the result is a separate report");
  assert.equal(search.queries.at(-1)?.language, "zh-cn");

  for (let i = 0; i < 5; i++) await send(`第 ${i} 件事`);
  const memory = await eventually(async () => {
    const r = await workerDb.tx((tx) => tx.get("bot_memories", state.bot2));
    return r?.summary && r;
  }, 20000);
  assert.equal(memory.summary, "用户喜欢蓝鲸。");
  const after = await send("之前说了什么？");
  assert.equal(after.content, "你之前说的是蓝鲸。", "memory summary reaches the prompt");
});

test('image-only messages persist, load with authorization, replay and reach the cloud model', { skip }, async () => {
  const bot = await api('POST', '/bots', { token: state.alice, body: { name: '图片测试' } });
  const path = `/bots/${bot.json.id}/messages`;
  const image = { name: 'pixel.png', mime_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' };
  const body = { images: [image], request_id: randomUUID() };
  const posted = await api('POST', path, { token: state.alice, body });
  assert.equal(posted.status, 200, JSON.stringify(posted.json));
  const incoming = posted.json.messages[0];
  assert.equal(incoming.content, '');
  assert.equal(incoming.images.length, 1);
  assert.equal('data' in incoming.images[0], false);
  const again = await api('POST', path, { token: state.alice, body });
  assert.equal(again.json.run.id, posted.json.run.id);
  assert.equal(again.json.messages[0].images[0].id, incoming.images[0].id);
  const picturePath = `${path}/${incoming.id}/images/${incoming.images[0].id}`;
  assert.equal((await api('GET', picturePath, { token: state.alice })).json.data, image.data);
  const charlie = (await api('POST', '/auth/login', { body: { username: 'charlie', password: 'charlie-password' } })).json.access_token;
  assert.equal((await api('GET', picturePath, { token: charlie })).status, 404);
  assert.equal((await api('GET', `${path}/${incoming.id}/images/${randomUUID()}`, { token: state.alice })).status, 404);
  await eventually(async () => {
    const page = await api('GET', path, { token: state.alice });
    return page.json.messages.at(-1)?.status === 'completed';
  });
  const imageTurns = (body: any) => (Array.isArray(body.input) ? body.input : []).filter((m: any) => m.role === 'user').flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'input_image') : []);
  assert.ok(provider.requests.some(r => imageTurns(r.body).some((p: any) => /^data:image\/(png|jpeg|webp);base64,/.test(p.image_url))));
  const follow = await api('POST', path, { token: state.alice, body: { text: '继续分析图片', request_id: randomUUID() } });
  await eventually(async () => {
    const page = await api('GET', path, { token: state.alice });
    return page.json.messages.find((m: any) => m.id === follow.json.run.assistant_message_id)?.status === 'completed';
  });
  const request = provider.requests.findLast(r => latestUserText(r.body.input) === '继续分析图片')!;
  assert.equal(imageTurns(request.body).length, 1, 'image-only user history is replayed');
  assert.equal((await api('POST', path, { token: state.alice, body: { images: [{ ...image, mime_type: 'text/html' }], request_id: randomUUID() } })).status, 422);
});

test("the main bot can chat using the default model and stays pinned after other bots run", { skip }, async () => {
  const posted = await api("POST", `/bots/${state.mainBot}/messages`, { token: state.alice, body: { text: "你好主智能体", request_id: randomUUID() } });
  assert.equal(posted.status, 200);
  const reply = await eventually(async () => {
    const page = await api("GET", `/bots/${state.mainBot}/messages`, { token: state.alice });
    const last = page.json.messages.at(-1);
    return last.status !== "running" && last;
  });
  assert.equal(reply.status, "completed");
  assert.equal(reply.content, "收到：你好主智能体");
  assert.equal((await api("GET", "/bots", { token: state.alice })).json.bots[0].id, state.mainBot);
});

const userText = (r: any) => typeof r.body.input === "string" ? r.body.input : latestUserText(r.body.input);
const systemText = (r: any) => String(r.body.input[0]?.content ?? "");

test("conversation delegation is asynchronous and reports a private specialist result back later", { skip }, async () => {
  const writer = await api("POST", "/bots", { token: state.alice, body: { name: "写作助手", persona: "擅长写周报和总结" } });
  state.writer = writer.json.id;
  for (const text of ["委托链路测试", "转交链路测试"]) {
    const posted = await api("POST", `/bots/${state.mainBot}/messages`, { token: state.alice, body: { text, request_id: randomUUID() } });
    assert.equal(posted.json.run.executor, "cloud");
    const messages = await eventually(async () => {
      const p = await api("GET", `/bots/${state.mainBot}/messages`, { token: state.alice });
      return p.json.messages.find((m: any) => m.run_id === posted.json.run.id && m.role === "assistant")?.agent_tasks.some((t: any) => t.status === "completed") &&
        p.json.messages.at(-1)?.content === "回报已收到：周报写好了" && p.json.messages;
    }, 20000);
    const ack = messages.find((m: any) => m.run_id === posted.json.run.id && m.role === "assistant");
    assert.match(ack.content, /^综合：已转交给「写作助手」/);
    assert.deepEqual(ack.agent_tasks.map((t: any) => [t.bot_id, t.status, t.mode]), [[state.writer, "completed", "report"]]);
    assert.equal(messages.at(-1).role, "assistant");
    assert.ok(messages.at(-1).task_id);
    assert.equal(messages.filter((m: any) => m.role === "user" && m.from_bot?.kind === "report").length, 0, "internal reports never impersonate user messages");
  }
  const parent = provider.requests.find(r => userText(r) === "委托链路测试")!;
  assert.match(systemText(parent), /- 写作助手：擅长写周报和总结/);
  const child = provider.requests.find(r => userText(r).includes("你收到来自智能体「Pi Bot」的委托"))!;
  assert.match(systemText(child), /只能用 wait=true/);
  assert.deepEqual((await api("GET", `/bots/${state.writer}/messages`, { token: state.alice })).json.messages, [], "specialist execution records are private");
});

test("delegation rules: other users, cycles, depth, mutual waits, quotas and cascading cancels", { skip }, async () => {
  const computer = socket(base.replace("http", "ws") + "/ws/device", state.keys.headers("GET", "/ws/device"));
  await computer.next((m) => m.type === "hello");
  const bot = async (name: string) => (await api("POST", "/bots", { token: state.alice, body: { name } })).json.id as string;
  const [A, B, C, D] = [await bot("甲"), await bot("乙"), await bot("丙"), await bot("丁")];
  const charlie = (await api("POST", "/auth/login", { body: { username: "charlie", password: "charlie-password" } })).json.access_token;
  await api("POST", "/bots", { token: charlie, body: { name: "查理的秘书" } });
  const macToken = async (botId: string) => {
    const body = { bot_id: botId };
    return (await api("POST", "/device/llm-token", { body, headers: state.keys.headers("POST", "/device/llm-token", JSON.stringify(body)) })).json.token as string;
  };
  const delegate = (token: string, runId: string, agent: string, wait = true) =>
    api("POST", "/agent/tasks", { token, body: { run_id: runId, agent, task: `请${agent}帮忙`, wait } });
  const start = async (botId: string, text: string) => {
    const run = await workerDb.tx(async tx => {
      const b = await tx.get("bots", botId);
      const d = await tx.one("SELECT device_id FROM devices WHERE user_id=$1 AND revoked_at IS NULL", [b.user_id]);
      return insertRun(tx, { userId: b.user_id, botId, text, requestId: randomUUID(), computer: { deviceId: d!.device_id }, lane: "task" });
    });
    await dispatchDevice(workerDb, s, (app as any).hub, run.run_id);
    return (await computer.next((m) => m.type === "run" && m.run.run_id === run.run_id)).run;
  };
  const done = (runId: string, state: string, text?: string) =>
    computer.send({ type: "run_event", run_id: runId, event: { kind: "done", state, text } });

  const runA = await start(A, "开始协作");
  assert.equal(runA.agents_enabled, true);
  assert.match(runA.system, /- 乙/);
  const tA = await macToken(A), tB = await macToken(B), tC = await macToken(C), tD = await macToken(D);
  assert.equal((await delegate(tA, runA.run_id, "甲")).status, 422, "no self-delegation");
  const unknown = await delegate(tA, runA.run_id, "不存在的");
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.detail, /可以委托的有：.*乙/);
  assert.equal((await delegate(tA, runA.run_id, "查理的秘书")).status, 404, "other users' bots are invisible");
  assert.equal((await delegate(tB, runA.run_id, "乙")).status, 404, "a token only acts for its own bot's run");

  const ab = await delegate(tA, runA.run_id, "乙");
  assert.equal(ab.status, 200, JSON.stringify(ab.json));
  assert.equal(ab.json.status, "queued", "creation returns before execution starts");
  const runB = (await computer.next((m) => m.type === "run" && m.run.bot.id === B)).run;
  assert.match(runB.text, /你收到来自智能体「甲」的委托/);
  assert.equal(runB.agents_enabled, true);
  assert.equal((await delegate(tB, runB.run_id, "甲")).status, 422, "delegating back up the chain would be a cycle");
  assert.equal((await delegate(tB, runB.run_id, "丙", false)).status, 422, "nested delegation must wait");
  const bc = await delegate(tB, runB.run_id, "丙");
  assert.equal(bc.status, 200);
  const runC = (await computer.next((m) => m.type === "run" && m.run.bot.id === C)).run;
  assert.equal(runC.agents_enabled, false, "the deepest level gets no ask_agent tool");
  assert.doesNotMatch(runC.system, /ask_agent/);
  assert.equal((await delegate(tC, runC.run_id, "丁")).status, 422, "depth limit is enforced by the server too");
  assert.equal((await api("POST", `/agent/tasks/${bc.json.id}/report`, { token: tB })).status, 422);

  const before = Date.now();
  const polled = await api("GET", `/agent/tasks/${ab.json.id}?wait=1`, { token: tA });
  assert.equal(polled.json.status, "running");
  assert.ok(Date.now() - before >= 900, "long poll holds until the window ends");
  assert.equal((await api("GET", `/agent/tasks/${ab.json.id}`, { token: tD })).status, 404, "tasks are visible only to the delegating bot");

  const runD = await start(D, "丁的工作");
  const da = await delegate(tD, runD.run_id, "甲");
  assert.equal(da.json.status, "queued", "a busy target queues the task");
  assert.equal((await delegate(tA, runA.run_id, "丁")).status, 409, "waiting on a bot that waits on you would deadlock");
  for (let i = 0; i < 4; i++) assert.equal((await delegate(tA, runA.run_id, "丁", false)).json.status, "queued");
  assert.equal((await delegate(tA, runA.run_id, "丙", false)).status, 422, "five delegations per run");

  await api("POST", `/runs/${runA.run_id}/cancel`, { token: state.alice });
  await computer.next((m) => m.type === "cancel" && m.run_id === runA.run_id);
  done(runA.run_id, "cancelled");
  await computer.next((m) => m.type === "cancel" && m.run_id === runB.run_id);
  done(runB.run_id, "cancelled");
  await computer.next((m) => m.type === "cancel" && m.run_id === runC.run_id);
  done(runC.run_id, "cancelled");
  const extraChildren = await workerDb.tx(tx => tx.rows("SELECT t.child_run_id FROM agent_tasks t WHERE t.parent_run_id=$1 AND t.child_run_id IS NOT NULL AND t.child_run_id<>$2", [runA.run_id, runB.run_id]));
  for (const child of extraChildren) {
    const r = await workerDb.tx(tx => tx.get("bot_runs", child.child_run_id));
    if (r.status !== "cancelled") {
      await computer.next(m => m.type === "cancel" && m.run_id === child.child_run_id);
      done(child.child_run_id, "cancelled");
    }
  }
  const cancelled = await eventually(async () => {
    const tasks = await workerDb.tx(tx => tx.rows("SELECT t.*, b.name AS bot_name FROM agent_tasks t JOIN bots b ON b.bot_id=t.target_bot_id WHERE parent_run_id=$1 ORDER BY t.created_at", [runA.run_id]));
    return tasks.length === 5 && tasks.every((t: any) => t.status === "cancelled") && tasks;
  });
  assert.equal(cancelled[0].bot_name, "乙");

  const runA2 = (await computer.next((m) => m.type === "run" && m.run.bot.id === A)).run;
  assert.match(runA2.text, /来自智能体「丁」的委托/, "the queued task starts once its target is idle");
  done(runA2.run_id, "completed", "甲完成了");
  const finished = await api("GET", `/agent/tasks/${da.json.id}?wait=5`, { token: tD });
  assert.deepEqual([finished.json.status, finished.json.result, finished.json.agent.name], ["completed", "甲完成了", "甲"]);
  done(runD.run_id, "completed", "丁完成了");
  await eventually(async () => (await workerDb.tx(tx => tx.get("bot_runs", runD.run_id))).status === "completed");
  computer.close();
  await eventually(async () => !(await api("GET", "/me", { token: state.alice })).json.computer.online);
});

test("users only see their own bots and Mac; a Mac dropping mid-run fails the run", { skip }, async () => {
  await api("POST", "/admin/api/users", { token: state.admin, body: { username: "bob", password: "bob-password" } });
  const bob = (await api("POST", "/auth/login", { body: { username: "bob", password: "bob-password" } })).json.access_token;
  const computer = socket(base.replace("http", "ws") + "/ws/device", state.keys.headers("GET", "/ws/device"));
  await computer.next((m) => m.type === "hello");
  const bobEvents = socket(base.replace("http", "ws") + "/ws/events", { authorization: `Bearer ${bob}` });
  assert.equal((await bobEvents.next((m) => m.type === "hello")).device_online, false, "presence is per user");
  const bobBots = (await api("GET", "/bots", { token: bob })).json.bots;
  assert.equal(bobBots.length, 1);
  assert.equal(bobBots[0].is_main, true, "each user sees their own main bot");
  for (const [method, path] of [
    ["GET", `/bots/${state.bot}`],
    ["GET", `/bots/${state.bot}/messages`],
    ["GET", `/bots/${state.bot}/files`],
    ["PATCH", `/bots/${state.bot}`],
  ] as const) {
    const r = await api(method, path, { token: bob, body: method === "PATCH" ? { name: "偷来的" } : undefined });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  const posted = await api("POST", `/bots/${state.bot}/messages`, { token: bob, body: { text: "hi", request_id: randomUUID() } });
  assert.equal(posted.status, 404);

  const mine = await api("POST", `/bots/${state.bot}/messages`, { token: state.alice, body: { text: "长任务", request_id: randomUUID() } });
  assert.equal(mine.json.run.executor, "device");
  assert.equal((await api("POST", `/runs/${mine.json.run.id}/cancel`, { token: bob })).status, 404);
  const { run } = await computer.next((m) => m.type === "run");
  computer.send({ type: "run_event", run_id: run.run_id, event: { kind: "started" } });
  computer.send({ type: "run_event", run_id: run.run_id, event: { kind: "text", text: "做到一半" } });
  await eventually(async () => (await api("GET", `/bots/${state.bot}`, { token: state.alice })).json.latest_run.status === "running");
  computer.close();
  const failed = await eventually(async () => {
    const b = await api("GET", `/bots/${state.bot}`, { token: state.alice });
    return b.json.latest_run.status === "failed" && b.json.latest_run;
  });
  assert.equal(failed.error, "执行电脑已离线，本次运行已中断；请核实结果后重新安排任务");
  const page = await api("GET", `/bots/${state.bot}/messages`, { token: state.alice });
  assert.equal(page.json.messages.at(-1).content, "做到一半", "partial text is kept");
  bobEvents.close();
});

test("admin can disable users and revoke devices", { skip }, async () => {
  const devices = await api("GET", "/admin/api/devices", { token: state.admin });
  const d = devices.json.find((x: any) => x.username === "alice" && !x.revoked_at);
  const revoked = await api("POST", `/admin/api/devices/${d.id}/revoke`, { token: state.admin });
  assert.ok(revoked.json.revoked_at);
  const signed = await api("GET", "/me", { headers: state.keys.headers("GET", "/me") });
  assert.equal(signed.status, 401);
  await api("PATCH", `/admin/api/users/${state.aliceId}`, { token: state.admin, body: { disabled: true } });
  assert.equal((await api("GET", "/me", { token: state.alice })).status, 401);
  const overview = await api("GET", "/admin/api/overview", { token: state.admin });
  assert.equal(overview.json.users, 4);
});

test("SSE usage parser keeps the last usage block across chunk boundaries", () => {
  const p = new SseUsage();
  const line = `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 2 } } })}\n\n`;
  p.push(line.slice(0, 20));
  p.push(line.slice(20));
  assert.deepEqual(p.usage, { input: 7, output: 2 });
});
