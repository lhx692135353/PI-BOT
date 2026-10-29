import test from "node:test";
import assert from "node:assert/strict";
import { applyConversationReasoning, effectiveModelCapabilities, reasoningTelemetry, BAILIAN_VOICE_MODEL, classifyModels, inferProvider, listCatalog, parseCatalog, providerBase, TOKEN_PLAN_BASE } from "../src/providers.js";

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
    for (const id of ["qwen3.8-max", "qwen3.8-flash"]) {
      const model = catalog.chat.find(model => model.id === id)!;
      assert.equal(model.capabilities?.reasoning, "configurable");
      assert.deepEqual(model.capabilities?.reasoning_off, { reasoning: { effort: "none" } });
    }
    assert.deepEqual(catalog.voice.map((model) => model.id), [BAILIAN_VOICE_MODEL]);
  } finally {
    globalThis.fetch = original;
  }
});

test("known Qwen chat defaults cover old rows without changing explicit capabilities or background requests", () => {
  const body = { input: "检查服务", max_output_tokens: 12000 };
  for (const id of ["qwen3.8-max", "qwen3.8-flash"]) {
    for (const capabilities of [undefined, null, { reasoning: "unknown" as const, vision: false }]) {
      const model = { provider: "bailian", provider_model: id, capabilities };
      const original = JSON.stringify(model);
      const selected = applyConversationReasoning(body, model, "conversation");
      assert.deepEqual(selected, { payload: { ...body, reasoning: { effort: "none" } }, source: "provider_preset" });
      assert.equal(effectiveModelCapabilities(model).vision, capabilities?.vision ?? true);
      assert.equal(JSON.stringify(model), original, "defaults must not mutate stored capabilities");
      for (const lane of ["task", undefined]) {
        assert.deepEqual(applyConversationReasoning(body, model, lane), { payload: body, source: "provider_default" });
      }
    }
  }
  for (const model of [
    { provider: "custom", provider_model: "qwen3.8-max" },
    { provider: "bailian", provider_model: "qwen3.8-2.4t-a95b" },
    { provider: "bailian", provider_model: "qwen3.8-max-other" },
    { provider: "xai", provider_model: "qwen3.8-max" },
  ]) assert.equal(applyConversationReasoning(body, model, "conversation").payload, body);
  for (const reasoning of ["required", "none"] as const) {
    const model = { provider: "bailian", provider_model: "qwen3.8-max", capabilities: { reasoning } };
    assert.equal(effectiveModelCapabilities(model).reasoning, reasoning);
    assert.equal(applyConversationReasoning(body, model, "conversation").payload, body);
  }
});

test("administrator and explicit request reasoning controls take precedence over presets", () => {
  const model = { provider: "bailian", provider_model: "qwen3.8-max", capabilities: {
    reasoning: "configurable" as const, reasoning_off: { enable_thinking: false },
  } };
  const body = { input: "你好" };
  assert.deepEqual(applyConversationReasoning(body, model, "conversation"), {
    payload: { ...body, enable_thinking: false }, source: "model_config",
  });
  for (const override of [{ reasoning: { effort: "low" } }, { enable_thinking: true }, { reasoning_effort: "high" }, { thinking_budget: 4096 }, { reasoning: null }]) {
    const input = { ...body, ...override };
    assert.deepEqual(applyConversationReasoning(input, model, "conversation"), { payload: input, source: "request" });
  }
  assert.deepEqual(effectiveModelCapabilities({ ...model, capabilities: { ...model.capabilities, reasoning_off: {} } }).reasoning_off, {});
  assert.equal(applyConversationReasoning(body, { ...model, capabilities: { ...model.capabilities, reasoning_off: {} } }, "conversation").payload, body);
  const custom = { ...model, provider: "custom" };
  assert.equal(applyConversationReasoning(body, custom, "conversation").source, "model_config");
});

test("reasoning diagnostics include only supported scalar controls", () => {
  assert.deepEqual(reasoningTelemetry({ reasoning: { effort: "none", secret: "sk-private" }, enable_thinking: false, thinking_budget: 0, input: "private prompt" }, "request"), {
    source: "request", effort: "none", enabled: false, budget: 0,
  });
  assert.deepEqual(reasoningTelemetry({ reasoning: { effort: "sk-private" }, enable_thinking: "secret", thinking_budget: Infinity }, "provider_default"), { source: "provider_default" });
  assert.deepEqual(reasoningTelemetry({ reasoning_effort: "low" }, "request"), { source: "request", flatEffort: "low" });
});
