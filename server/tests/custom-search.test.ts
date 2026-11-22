import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { settings, type Settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Hub } from "../src/hub.js";
import { createRunner } from "../src/runner.js";
import { WebSearch, searchBackend } from "../src/search.js";
import { issueLlmToken } from "../src/security.js";
import { Worker } from "../src/worker.js";
import { eventually, mockProvider, resetDatabase, TEST_DB, tempDir, vaultFile } from "./helpers.js";

const skip = !TEST_DB && "需要 PI_BOT_TEST_DATABASE_URL";
let app: Awaited<ReturnType<typeof createApp>>, provider: Awaited<ReturnType<typeof mockProvider>>;
let runner: Awaited<ReturnType<typeof createRunner>>, db: Database, s: Settings, dir: ReturnType<typeof tempDir>;
let worker: Worker | undefined, workerLoop: Promise<void> | undefined;
let admin: string, user: string, userId: string, llm: string, primary: string, searchModel: string, base: string;
const requests: { url: string; body: any; authorization: string | null }[] = [];
let searchStatus = 200;

async function api(method: string, url: string, body?: unknown, token = admin) {
  const r = await app.inject({ method: method as "GET" | "POST" | "PATCH", url, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { payload: body as any }) });
  assert.ok(r.statusCode < 500, r.body);
  return { status: r.statusCode, json: r.json() };
}

before(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!);
  dir = tempDir();
  provider = await mockProvider();
  runner = await createRunner({ token: "r".repeat(40), dir: dir.path });
  await runner.listen({ host: "127.0.0.1", port: 0 });
  s = settings({ PI_BOT_DATABASE_URL: TEST_DB!, PI_BOT_ADMIN_PASSWORD: "admin-password", PI_BOT_JWT_SECRET: "j".repeat(40),
    PI_BOT_VAULT_FILE: vaultFile(dir.path), PI_BOT_RUNNER_TOKEN: "r".repeat(40),
    PI_BOT_RUNNER_URL: `http://127.0.0.1:${(runner.server.address() as any).port}`, PI_BOT_WORKER_POLL_SECONDS: "0.05" });
  db = new Database(TEST_DB!);
  const searchRequest: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json(searchStatus === 200 ? { status: "completed", output: [
      { type: "web_search_call", status: "completed", action: { sources: [{ url: "https://example.com/pi-bot" }] } },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify({ results: [{ title: "Pi Bot 官方资料", url: "https://example.com/pi-bot", content: "后台任务原生搜索验证" }] }) }] },
    ], usage: { input_tokens: 23, output_tokens: 17 } } : { error: { message: "fixture-secret must not escape" } }, { status: searchStatus });
  };
  app = await createApp(s, db, new Hub(), new WebSearch(s, searchRequest, Date.now, db));
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  admin = (await api("POST", "/auth/login", { username: "admin", password: "admin-password" }, "")).json.access_token;
  userId = (await api("POST", "/admin/api/users", { username: "search-user", password: "test-password" })).json.id;
  user = (await api("POST", "/auth/login", { username: "search-user", password: "test-password" }, "")).json.access_token;
  llm = await issueLlmToken({ sub: userId, src: "test" }, s);
  primary = (await api("POST", "/admin/api/models", { name: "Task model", provider: "custom", base_url: provider.url, provider_model: "task-model", api_key: "fixture-task-secret", context_window: 32000, max_tokens: 2000 })).json.id;
});

after(async () => {
  if (skip) return;
  worker?.stop();
  await workerLoop;
  await app?.close();
  await runner?.close();
  await provider?.close();
  dir?.cleanup();
});

test("custom model search configuration survives create, partial updates and reload; candidates respect flags and priority", { skip }, async () => {
  assert.equal((await db.tx(tx => searchBackend(tx, s))), null, "custom search stays opt-in");
  const created = await api("POST", "/admin/api/models", { name: "Custom search", provider: "custom", base_url: provider.url, provider_model: "search-model", api_key: "fixture-search-secret", provider_search: true, context_window: 32000, max_tokens: 2000 });
  assert.equal(created.status, 200);
  assert.equal(created.json.provider_search, true);
  searchModel = created.json.id;
  await api("PATCH", `/admin/api/models/${searchModel}`, { name: "Renamed search" });
  await api("PATCH", `/admin/api/models/${searchModel}`, { base_url: provider.url });
  const reloaded = (await api("GET", "/admin/api/models")).json.find((m: any) => m.id === searchModel);
  assert.equal(reloaded.provider_search, true);
  assert.equal(JSON.stringify(reloaded).includes("fixture-search-secret"), false);
  const selected = async () => { const b = await db.tx(tx => searchBackend(tx, s)); return b?.name === "provider" ? b.model.model_id : b?.name ?? null; };
  assert.equal(await selected(), searchModel);
  await api("PATCH", `/admin/api/models/${primary}`, { provider_search: true });
  assert.equal(await selected(), primary, "default model takes priority");
  await api("PATCH", `/admin/api/models/${primary}`, { provider_search: false });
  const later = (await api("POST", "/admin/api/models", { name: "Later search", provider: "bailian", provider_model: "fixture-bailian", api_key: "fixture-later-secret", provider_search: true, context_window: 32000, max_tokens: 2000 })).json.id;
  assert.equal(await selected(), searchModel, "oldest eligible model wins without a search-enabled default");
  await api("PATCH", `/admin/api/models/${searchModel}`, { enabled: false });
  assert.equal(await selected(), later, "existing providers remain eligible");
  await api("PATCH", `/admin/api/models/${later}`, { enabled: false });
  assert.equal(await selected(), null, "disabled model is excluded");
  await api("PATCH", `/admin/api/models/${searchModel}`, { enabled: true, provider_search: false });
  assert.equal(await selected(), null, "search-disabled model is excluded");
  await api("PATCH", `/admin/api/models/${searchModel}`, { provider_search: true });
  s.tavilyKey = "fixture-tavily";
  assert.equal(await selected(), "tavily");
  s.searchBackend = "provider";
  assert.equal(await selected(), searchModel);
  s.searchBackend = "tavily";
  s.tavilyKey = undefined;
  assert.equal(await selected(), null);
  s.searchBackend = "auto";
  const usage = await api("GET", "/admin/api/search/usage");
  assert.equal(usage.json.backend, "provider");
  assert.equal(usage.json.model, "Renamed search");
});

test("web search API forwards custom native search and attributes usage to the search model", { skip }, async () => {
  const r = await api("POST", "/web/search", { query: "公开查询", language: "zh-CN" }, llm);
  assert.equal(r.status, 200);
  assert.equal(r.json.results[0].title, "Pi Bot 官方资料");
  const request = requests.at(-1)!;
  assert.equal(request.url, `${provider.url}/responses`);
  assert.equal(request.authorization, "Bearer fixture-search-secret");
  assert.equal(request.body.model, "search-model");
  assert.deepEqual(request.body.tools, [{ type: "web_search" }]);
  assert.equal(request.body.tool_choice, "required");
  const usage = await db.tx(tx => tx.one("SELECT * FROM usage_logs WHERE model_id=$1", [searchModel]));
  assert.equal(usage!.user_id, userId);
  assert.equal(usage!.input_tokens, 23);
  assert.equal(usage!.output_tokens, 17);
});

test("web search API exposes a clear sanitized native-search rejection without switching backend", { skip }, async () => {
  searchStatus = 400;
  try {
    const r = await app.inject({ method: "POST", url: "/web/search", headers: { authorization: `Bearer ${llm}` }, payload: { query: "unsupported" } });
    assert.equal(r.statusCode, 502);
    assert.match(r.json().detail, /拒绝原生联网搜索.*HTTP 400/);
    assert.doesNotMatch(r.body, /fixture-secret/);
  } finally { searchStatus = 200; }
});

test("cloud task receives web_search and completes using the configured custom search model", { skip, timeout: 30000 }, async () => {
  const bot = (await api("POST", "/bots", { name: "搜索助手" }, user)).json;
  worker = new Worker(db, { ...s, internalUrl: base });
  workerLoop = worker.runForever();
  const sent = await api("POST", `/bots/${bot.id}/messages`, { text: "联网搜索链路测试", request_id: randomUUID() }, user);
  assert.equal(sent.status, 200);
  const result = await eventually(async () => {
    const messages = (await api("GET", `/bots/${bot.id}/messages`, undefined, user)).json.messages;
    return messages.findLast((m: any) => m.task_id && m.status !== "running");
  }, 20000);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.match(result.content, /Pi Bot 官方资料/);
  const usage = await db.tx(tx => tx.one("SELECT * FROM usage_logs WHERE model_id=$1 AND bot_id=$2 AND source='cloud'", [searchModel, bot.id]));
  assert.ok(usage, "background search usage is attributed to its bot and search model");
  assert.ok(requests.some(r => r.body.model === "search-model" && r.body.input[1].content.includes("Pi Bot 搜索测试")));
});
