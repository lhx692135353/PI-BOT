import test from "node:test";
import assert from "node:assert/strict";
import { BAILIAN_VOICE_MODEL, classifyModels, inferProvider, listCatalog, parseCatalog, providerBase, TOKEN_PLAN_BASE } from "../src/providers.js";

test("known providers have fixed endpoints and arbitrary hosts stay custom", () => {
  assert.equal(providerBase("xai"), "https://api.x.ai/v1");
  assert.equal(providerBase("bailian"), TOKEN_PLAN_BASE);
  assert.equal(providerBase("custom"), null);
  assert.equal(inferProvider("https://api.x.ai/v1"), "xai");
  assert.equal(inferProvider("https://dashscope.aliyuncs.com/compatible-mode/v1"), "bailian");
  assert.equal(inferProvider(TOKEN_PLAN_BASE), "bailian");
  assert.equal(inferProvider("http://127.0.0.1:9/v1"), "custom");
});

test("catalog splits chat and voice and keeps parameters the provider returned", () => {
  const catalog = classifyModels(parseCatalog({
    data: [
      { id: "grok-4", context_length: 256000, max_output_tokens: 32000 },
      { id: "grok-imagine-image", capabilities:{chat:false}, context_length: 1024 },
      { id: "grok-voice-latest", capabilities:{chat:false,voice:true}, context_length: 32000 },
    ],
    models: [{ id: "qwen3-max", context_window: 128000, max_tokens: 8192 }, { id: "qwen3.5-omni-flash-realtime", capabilities:{chat:false,voice:true} }, { id: "qwen3-asr-flash", capabilities:{chat:false} }],
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
        { model: "qwen3.5-omni-flash-realtime", capabilities:{chat:false,voice:true} },
        { model: "qwen-image-3.0-pro", capabilities:{chat:false} },
      ],
    },
  }));
  assert.deepEqual(catalog.chat.map((model) => model.id), ["qwen3.8-max"]);
  assert.equal(catalog.chat[0].context_window, 131072);
  assert.equal(catalog.chat[0].max_tokens, 16384);
  assert.deepEqual(catalog.voice.map((model) => model.id), ["qwen3.5-omni-flash-realtime"]);
});

test("token plan catalog is built in and voice uses qwen audio realtime", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (() => { called = true; throw new Error("token plan has no model list"); }) as typeof fetch;
  try {
    const catalog = await listCatalog("bailian", "sk-sp-test");
    assert.equal(called, false);
    assert.ok(catalog.chat.some((model) => model.id === "qwen3.8-max"));
    assert.deepEqual(catalog.voice.map((model) => model.id), [BAILIAN_VOICE_MODEL]);
  } finally {
    globalThis.fetch = original;
  }
});
