import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/db.js";
import { classifyModels, inferProvider, listCatalog, parseCatalog, providerBase } from "../src/providers.js";

test("known providers have fixed endpoints and arbitrary hosts stay custom", () => {
  assert.equal(providerBase("xai"), "https://api.x.ai/v1");
  assert.equal(providerBase("bailian"), "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(providerBase("custom"), null);
  assert.equal(inferProvider("https://api.x.ai/v1"), "xai");
  assert.equal(inferProvider("https://dashscope.aliyuncs.com/compatible-mode/v1"), "bailian");
  assert.equal(inferProvider("http://127.0.0.1:9/v1"), "custom");
});

test("catalog splits chat and voice and keeps parameters the provider returned", () => {
  const catalog = classifyModels(parseCatalog({
    data: [
      { id: "grok-4", context_length: 256000, max_output_tokens: 32000 },
      { id: "grok-imagine-image", context_length: 1024 },
      { id: "grok-voice-latest", context_length: 32000 },
    ],
    models: [{ id: "qwen3-max", context_window: 128000, max_tokens: 8192 }, { id: "qwen3.5-omni-flash-realtime" }, { id: "qwen3-asr-flash" }],
  }));
  assert.deepEqual(catalog.chat.map((model) => model.id), ["grok-4", "qwen3-max"]);
  assert.equal(catalog.chat[0].context_window, 256000);
  assert.equal(catalog.chat[0].max_tokens, 32000);
  assert.deepEqual(catalog.voice.map((model) => model.id), ["grok-voice-latest", "qwen3.5-omni-flash-realtime"]);
  assert.equal(catalog.voice[1].context_window, null);
});

test("bailian catalog reads the native model id and nested limits", () => {
  const catalog = classifyModels(parseCatalog({
    output: {
      models: [
        { model: "qwen3.8-max", model_info: { context_window: 131072, max_output_tokens: 16384 } },
        { model: "qwen3.5-omni-flash-realtime" },
        { model: "qwen-image-3.0-pro" },
      ],
    },
  }));
  assert.deepEqual(catalog.chat.map((model) => model.id), ["qwen3.8-max"]);
  assert.equal(catalog.chat[0].context_window, 131072);
  assert.equal(catalog.chat[0].max_tokens, 16384);
  assert.deepEqual(catalog.voice.map((model) => model.id), ["qwen3.5-omni-flash-realtime"]);
});

test("bailian catalog uses the native list and does not surface provider 401", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const page = new URL(url).searchParams.get("page_no");
    const body = page === "1"
      ? { success: true, output: { total: 2, page_no: 1, page_size: 100, models: [{ model: "qwen-plus", model_info: { context_window: 128000, max_output_tokens: 8192 } }] } }
      : { success: true, output: { total: 2, page_no: 2, page_size: 100, models: [{ model: "qwen3.5-omni-flash-realtime" }] } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const catalog = await listCatalog("bailian", "sk-test");
    assert.equal(urls.length, 2);
    assert.match(urls[0], /^https:\/\/dashscope\.aliyuncs\.com\/api\/v1\/models\?/);
    assert.doesNotMatch(urls[0], /compatible-mode/);
    assert.deepEqual(catalog.chat.map((model) => model.id), ["qwen-plus"]);
    assert.equal(catalog.chat[0].max_tokens, 8192);
    assert.deepEqual(catalog.voice.map((model) => model.id), ["qwen3.5-omni-flash-realtime"]);

    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await assert.rejects(listCatalog("bailian", "sk-bad"), (error: unknown) => error instanceof HttpError && error.status === 422);
  } finally {
    globalThis.fetch = original;
  }
});
