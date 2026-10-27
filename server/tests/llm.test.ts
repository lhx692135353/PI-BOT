import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import Fastify from "fastify";
import { complete, proxyResponses, SseUsage, usageFrom } from "../src/llm.js";
import { Vault } from "../src/security.js";
import { settings } from "../src/config.js";
import type { Database } from "../src/db.js";
import { tempDir, vaultFile } from "./helpers.js";

test("Qwen chat and report requests explicitly disable default thinking without changing task requests", async () => {
  const requests: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "completed", output: [] }));
  });
  const dir = tempDir();
  const s = settings({ PI_BOT_DATABASE_URL: "unused", PI_BOT_JWT_SECRET: "j".repeat(40), PI_BOT_VAULT_FILE: vaultFile(dir.path) });
  const db = { tx: async (fn: any) => fn({ insert: async () => ({}) }) } as unknown as Database;
  const app = Fastify();
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const model = { model_id: "model", provider: "bailian", provider_model: "qwen3.8-flash", capabilities:{reasoning:"configurable",reasoning_off:{reasoning:{effort:"none"}}}, max_tokens: 1000,
    base_url: `http://127.0.0.1:${(provider.address() as any).port}/v1`, secret: new Vault(s.vaultFile).seal("sk-test", "model") };
  app.post<{ Params: { lane: string }; Body: Record<string, unknown> }>("/:lane", (req, reply) =>
    proxyResponses(db, s, { sub: "user", src: "device" }, model, req.body, reply, new AbortController().signal,
      { run: { lane: req.params.lane === "report" ? "conversation" : req.params.lane, origin: req.params.lane } }));
  const input = { input: "核对任务状态", tools: [{ type: "function", name: "task_status" }] };
  try {
    for (const lane of ["conversation", "report"]) {
      assert.equal((await app.inject({ method: "POST", url: `/${lane}`, payload: input })).statusCode, 200);
      assert.deepEqual(requests.at(-1).reasoning, { effort: "none" });
      assert.deepEqual(requests.at(-1).tools, input.tools);
    }
    await app.inject({ method: "POST", url: "/task", payload: input });
    assert.equal(requests.at(-1).reasoning, undefined);
    for (const override of [{ reasoning: { effort: "low" } }, { enable_thinking: true }]) {
      await app.inject({ method: "POST", url: "/conversation", payload: { ...input, ...override } });
      for (const [key, value] of Object.entries(override)) assert.deepEqual(requests.at(-1)[key], value);
      if (!("reasoning" in override)) assert.equal(requests.at(-1).reasoning, undefined);
    }
    model.capabilities.reasoning = "required";
    model.provider_model = "qwen3.8-2.4t-a95b";
    await app.inject({ method: "POST", url: "/conversation", payload: input });
    assert.equal(requests.at(-1).reasoning, undefined, "thinking-only models must keep their supported parameters");
    model.provider = "custom";
    model.provider_model = "other-model";
    await app.inject({ method: "POST", url: "/conversation", payload: input });
    assert.equal(requests.at(-1).reasoning, undefined);
  } finally {
    await app.close();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    dir.cleanup();
  }
});

test("Responses usage supports JSON and terminal events, including cached and reasoning tokens", () => {
  const usage = { input_tokens: 42, output_tokens: 12, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 8 } };
  assert.deepEqual(usageFrom({ usage }), { input: 42, output: 12, cached:20, reasoning:8 });
  for (const type of ["response.completed", "response.incomplete", "response.failed"])
    assert.deepEqual(usageFrom({ type, response: { usage } }), { input: 42, output: 12, cached:20, reasoning:8 });
  assert.equal(usageFrom({ usage: null }), null);
  assert.equal(usageFrom({ usage: { input_tokens: "bad" } }), null);
});

test("SSE usage survives CRLF, multiline frames, partial chunks and an unterminated final frame", () => {
  const parser = new SseUsage();
  const body = ': keepalive\r\nevent: response.created\r\ndata: {"response":{"usage":null}}\r\n\r\n'
    + 'event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":{"usage":{"input_tokens":42,"output_tokens":12}}}\r\n\r\n'
    + 'data: {"response":{"usage":{"input_tokens":50,"output_tokens":15}}}';
  for (let i = 0; i < body.length; i += 7) parser.push(body.slice(i, i + 7));
  assert.deepEqual(parser.usage, { input: 42, output: 12 });
  parser.end();
  assert.deepEqual(parser.usage, { input: 50, output: 15 });
});

test("one-shot Responses requests parse all output messages and reject failed or incomplete responses", async () => {
  const requests: any[] = [];
  let result: object = { status: "completed", output: [
    { type: "reasoning", summary: [] },
    { type: "message", content: [{ type: "output_text", text: "第一段" }, { type: "refusal", refusal: "ignored" }] },
    { type: "function_call", name: "ignored" },
    { type: "message", content: [{ type: "output_text", text: "第二段" }] },
  ], usage: { input_tokens: 30, output_tokens: 6 } };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: JSON.parse(raw), authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const model = { base_url: `http://127.0.0.1:${(server.address() as any).port}/v1///`, provider_model: "grok-test", max_tokens: 1000 };
  const input = [{ role: "system", content: "压缩记忆" }, { role: "user", content: "记住蓝鲸" }];
  try {
    assert.deepEqual(await complete(model, "sk-test", input, 2000), { text: "第一段第二段", usage: { input: 30, output: 6 } });
    assert.deepEqual(requests[0], { path: "/v1/responses", authorization: "Bearer sk-test", body: { model: "grok-test", input, max_output_tokens: 1000, stream: false, store: false } });
    result = { status: "failed", error: { message: "provider secret" } };
    await assert.rejects(complete(model, "sk-test", input, 16), /^Error: 模型生成失败$/);
    result = { status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } };
    await assert.rejects(complete(model, "sk-test", input, 16), /已达到输出 token 上限（思考内容也计入额度）/);
    result = { status: "incomplete", output: [], incomplete_details: { reason: "content_filter" } };
    await assert.rejects(complete(model, "sk-test", input, 16), /^Error: 模型输出不完整$/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
