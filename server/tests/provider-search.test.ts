import test from "node:test";
import assert from "node:assert/strict";
import { systemPrompt } from "../src/bots.js";
import { settings } from "../src/config.js";
import { applyWrapUp, taskBudget, TASK_WRAP_UP } from "../src/llm.js";
import { providerPage, selectBackend } from "../src/search.js";

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
