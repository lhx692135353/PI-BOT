import test from "node:test";
import assert from "node:assert/strict";
import { systemPrompt } from "../src/bots.js";
import { applyProviderSearch } from "../src/providers.js";

const bot = { name: "助手", persona: "", slug: "helper" };
const tools = [{ type: "function", name: "web_search" }, { type: "function", name: "read_file" }];

test("provider search is attached only on task turns of an opted-in model", () => {
  const xai = applyProviderSearch({ tools }, { provider: "xai", provider_search: true }, "task");
  assert.deepEqual(xai.tools, [
    { type: "function", name: "read_file" },
    { type: "web_search" },
    { type: "x_search" },
  ]);
  assert.equal(applyProviderSearch({ tools }, { provider: "xai", provider_search: true }, "conversation").tools, tools);
  assert.equal(applyProviderSearch({ tools }, { provider: "xai", provider_search: false }, "task").tools, tools);
  assert.deepEqual(applyProviderSearch({ tools: [] }, { provider: "bailian", provider_search: true }, "task").tools, [{ type: "web_search" }]);
  assert.equal(applyProviderSearch({ tools }, { provider: "custom", provider_search: true }, "task").tools, tools);
});

test("provider search replaces the Tavily instruction", () => {
  const xai = systemPrompt(bot, "", "cloud", { search: true, providerSearch: "xai", lane: "task" });
  assert.match(xai, /检索网页和 X/);
  assert.doesNotMatch(xai, /请优先使用 web_search/);
  const chat = systemPrompt(bot, "", "cloud", { search: true, providerSearch: "bailian", lane: "conversation" });
  assert.match(chat, /服务商自己的搜索/);
  assert.doesNotMatch(chat, /请优先使用 web_search/);
  const tavily = systemPrompt(bot, "", "device", { search: true, lane: "task" });
  assert.match(tavily, /请优先使用 web_search/);
});
