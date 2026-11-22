import test from "node:test";
import assert from "node:assert/strict";
import { systemPrompt } from "../src/bots.js";
import { settings } from "../src/config.js";
import { applyWrapUp, taskBudget, TASK_WRAP_UP } from "../src/llm.js";
import { ProviderSearch, providerPage, selectBackend } from "../src/search.js";
import { providerSearchTools } from "../src/providers.js";
import { HttpError, type Database, type Row, type Tx } from "../src/db.js";
import { Vault } from "../src/security.js";
import { tempDir, vaultFile } from "./helpers.js";

const bot = { name: "助手", persona: "", slug: "helper" };
const config = (env: Record<string, string> = {}) => settings({ PI_BOT_DATABASE_URL: "unused", PI_BOT_JWT_SECRET: "j".repeat(40), ...env });
const model = { model_id: "m", provider: "xai", provider_search: true };

test("every search goes through one backend; Tavily wins in auto mode", () => {
  assert.equal(selectBackend(config({ PI_BOT_TAVILY_API_KEY: "tvly" }), model)?.name, "tavily");
  assert.equal(selectBackend(config(), model)?.name, "provider");
  assert.equal(selectBackend(config()), null);
  assert.equal(selectBackend(config({ PI_BOT_SEARCH_BACKEND: "tavily" }), model), null);
  assert.equal(selectBackend(config({ PI_BOT_SEARCH_BACKEND: "provider", PI_BOT_TAVILY_API_KEY: "tvly" }), model)?.name, "provider");
});

test("native search tools include custom Responses gateways without changing provider presets", () => {
  assert.deepEqual(providerSearchTools("custom"), [{ type: "web_search" }]);
  assert.deepEqual(providerSearchTools("bailian"), [{ type: "web_search" }]);
  assert.deepEqual(providerSearchTools("xai"), [{ type: "web_search" }, { type: "x_search" }]);
  assert.deepEqual(providerSearchTools("unknown"), []);
});

const nativeResult = () => ({ status: "completed", output: [
  { type: "web_search_call", status: "completed", action: { sources: [{ url: "https://example.com/" }] } },
  { type: "message", content: [{ type: "output_text", text: JSON.stringify({ results: [
    { title: "资料", url: "https://example.com/", content: "摘要" },
  ] }) }] },
], usage: { input_tokens: 20, output_tokens: 10 } });

function providerFixture() {
  const dir = tempDir();
  const s = config({ PI_BOT_VAULT_FILE: vaultFile(dir.path) });
  const model = { model_id: "custom-model", provider: "custom", provider_model: "gateway-model", base_url: "https://gateway.example/v1/", max_tokens: 2000,
    secret: new Vault(s.vaultFile).seal("fixture-provider-secret", "custom-model") };
  const usage: Row[] = [], requests: { url: string; init?: RequestInit }[] = [];
  const db = { tx: async (fn: (tx: Tx) => Promise<unknown>) => fn({ insert: async (_table: string, row: Row) => { usage.push(row); return row; } } as unknown as Tx) } as Database;
  const state = { status: 200, data: nativeResult() as unknown, now: 0, fail: false };
  const request: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    init?.signal?.throwIfAborted();
    if (state.fail) throw new Error("private connection details");
    return Response.json(state.data, { status: state.status });
  };
  return { dir, model, usage, requests, state, search: new ProviderSearch(db, s, request, () => state.now) };
}

test("custom search forwards native tools and language, records usage and caches bounded results", async t => {
  const f = providerFixture();
  t.after(() => f.dir.cleanup());
  const who = { sub: "user", src: "cloud" as const, bot: "bot" };
  const page = await f.search.search(f.model, "公开资料", "zh-CN", undefined, who);
  assert.deepEqual(page, { results: [{ title: "资料", url: "https://example.com/", content: "摘要" }], warnings: [] });
  const { url, init } = f.requests[0];
  assert.equal(url, "https://gateway.example/v1/responses");
  assert.equal(init?.method, "POST");
  assert.equal(init?.redirect, "error");
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-provider-secret");
  const body = JSON.parse(String(init?.body));
  assert.equal(body.model, "gateway-model");
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.input[1].content, "公开资料\n（结果语言：zh-CN）");
  assert.equal(body.max_output_tokens, 2000);
  assert.equal(body.stream, false);
  assert.equal(body.store, false);
  assert.equal("max_turns" in body, false);
  assert.equal(f.usage.length, 1);
  assert.equal(f.usage[0].model_id, f.model.model_id);
  assert.equal(f.usage[0].input_tokens, 20);
  assert.equal(f.usage[0].output_tokens, 10);
  assert.deepEqual(await f.search.search(f.model, "公开资料", "zh-CN", undefined, who), page);
  assert.equal(f.requests.length, 1);
  assert.equal(f.usage.length, 1);
  await f.search.search(f.model, "公开资料", "auto");
  assert.equal(JSON.parse(String(f.requests.at(-1)!.init?.body)).input[1].content, "公开资料");
  f.state.now = 300001;
  await f.search.search(f.model, "公开资料", "zh-CN");
  assert.equal(f.requests.length, 3);
});

test("custom search requires a completed native search, while successful empty searches remain warnings", async t => {
  const f = providerFixture();
  t.after(() => f.dir.cleanup());
  for (const status of [undefined, "in_progress", "failed"]) {
    f.state.data = { ...nativeResult(), output: nativeResult().output.map(item => item.type === "web_search_call" ? { ...item, status } : item) };
    await assert.rejects(f.search.search(f.model, "query", "auto"), /未完成原生联网搜索/);
  }
  f.state.data = { ...nativeResult(), output: nativeResult().output.filter(item => item.type !== "web_search_call") };
  await assert.rejects(f.search.search(f.model, "query", "auto"), /未完成原生联网搜索/);
  f.state.data = { status: "completed", output: [{ type: "web_search_call", status: "completed" }] };
  assert.deepEqual(await f.search.search(f.model, "query", "auto"), { results: [], warnings: ["搜索没有返回可用结果"] });
  await f.search.search(f.model, "query", "auto");
  assert.equal(f.requests.length, 6, "errors and empty results are not cached");
});

test("custom search reports sanitized rejection, failed responses, cancellation and connection errors", async t => {
  const f = providerFixture();
  t.after(() => f.dir.cleanup());
  for (const [status, expected] of [[400, /拒绝原生联网搜索/], [422, /拒绝原生联网搜索/], [401, /认证或访问被拒绝/], [403, /认证或访问被拒绝/], [429, /过于频繁/], [500, /暂时不可用/]] as const) {
    f.state.status = status;
    f.state.data = { error: { message: "fixture-provider-secret private body" } };
    await assert.rejects(f.search.search(f.model, "query", "auto"), error => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, status === 429 ? 503 : 502);
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /fixture-provider-secret|private body/);
      return true;
    });
  }
  f.state.status = 200;
  for (const status of ["failed", "incomplete", "cancelled"]) {
    f.state.data = { ...nativeResult(), status };
    await assert.rejects(f.search.search(f.model, "query", "auto"), /返回失败或未完成/);
  }
  f.state.data = { ...nativeResult(), error: { message: "private body" } };
  await assert.rejects(f.search.search(f.model, "query", "auto"), /返回失败或未完成/);
  f.state.data = null;
  await assert.rejects(f.search.search(f.model, "query", "auto"), /返回格式异常/);
  f.state.fail = true;
  await assert.rejects(f.search.search(f.model, "query", "auto"), /超时或连接失败/);
  f.state.fail = false;
  await assert.rejects(f.search.search(f.model, "query", "auto", AbortSignal.abort()), /超时或连接失败/);
  f.state.data = nativeResult();
  assert.equal((await f.search.search(f.model, "query", "auto")).results.length, 1);
});

test("existing provider requests keep their native search tools and turn limits", async t => {
  const f = providerFixture();
  t.after(() => f.dir.cleanup());
  for (const provider of ["xai", "bailian"]) {
    await f.search.search({ ...f.model, provider, model_id: f.model.model_id }, provider, "auto");
    const body = JSON.parse(String(f.requests.at(-1)!.init?.body));
    assert.deepEqual(body.tools, providerSearchTools(provider));
    assert.equal("tool_choice" in body, false);
    assert.equal(body.max_turns, provider === "xai" ? 3 : undefined);
  }
});

test("provider results are bounded and limited to pages the provider retrieved", () => {
  const page = providerPage({ output: [
    { type: "web_search_call", action: { type: "search", sources: [{ url: "https://a.example/1" }, { url: "https://b.example/2" }] } },
    { type: "message", content: [{ type: "output_text", text: "```json\n" + JSON.stringify({ results: [
      { title: "<b>A</b>", url: "https://a.example/1", content: "x".repeat(3000) },
      { title: "编造", url: "https://made-up.example/", content: "不存在" },
      { title: "重复", url: "https://a.example/1", content: "" },
      { title: "凭据", url: "https://user:pw@b.example/2", content: "" },
    ] }) + "\n```" }] },
  ] });
  assert.deepEqual(page.results.map(r => r.url), ["https://a.example/1"]);
  assert.equal(page.results[0].title, "A");
  assert.equal(page.results[0].content.length, 2000);
  assert.equal(page.summary, undefined);
});

test("provider text without JSON falls back to cited links with a bounded summary", () => {
  const page = providerPage({ output: [{ type: "message", content: [{ type: "output_text", text: "要点".repeat(2000), annotations: [
    { type: "url_citation", url: "https://c.example/", title: "C" }, { type: "url_citation", url: "javascript:alert(1)" },
  ] }] }] });
  assert.deepEqual(page.results, [{ title: "C", url: "https://c.example/", content: "" }]);
  assert.equal(page.summary?.length, 2000);
  assert.deepEqual(providerPage({ output: [] }).warnings, ["搜索没有返回可用结果"]);
});

test("search prompt is the same for every backend", () => {
  const task = systemPrompt(bot, "", "cloud", { search: true, lane: "task" });
  assert.match(task, /请优先使用 web_search/);
  const chat = systemPrompt(bot, "", "cloud", { search: true, lane: "conversation" });
  assert.match(chat, /start_task\(execution=cloud\)/);
  assert.doesNotMatch(chat, /请优先使用 web_search/);
  assert.doesNotMatch(systemPrompt(bot, "", "cloud", { search: false, lane: "task" }), /web_search/);
});

test("background tasks wrap up at their budget and stop well past it", () => {
  const s = { taskTokenBudget: 1000, taskModelCalls: 5 };
  assert.equal(taskBudget({ lane: "conversation", tokens_used: 99999, model_calls: 99 }, s), "ok");
  assert.equal(taskBudget({ lane: "task", tokens_used: 999, model_calls: 4 }, s), "ok");
  assert.equal(taskBudget({ lane: "task", tokens_used: 1000, model_calls: 0 }, s), "wrap_up");
  assert.equal(taskBudget({ lane: "task", tokens_used: 0, model_calls: 5 }, s), "wrap_up");
  assert.equal(taskBudget({ lane: "task", tokens_used: 1500, model_calls: 0 }, s), "stop");
  assert.equal(taskBudget({ lane: "task", tokens_used: 0, model_calls: 8 }, s), "stop");
  const body = applyWrapUp({ input: [{ role: "user", content: "查" }], tools: [{ type: "function", name: "web_search" }] });
  assert.equal(body.tool_choice, "none");
  assert.deepEqual(body.input.at(-1), { role: "user", content: TASK_WRAP_UP });
});
