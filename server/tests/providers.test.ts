import test from "node:test";
import assert from "node:assert/strict";
import { classifyModels, inferProvider, parseCatalog, providerBase } from "../src/providers.js";

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
