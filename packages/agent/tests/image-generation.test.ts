import test from "node:test";
import assert from "node:assert/strict";
import { imageGenerationTools } from "../src/image-generation.js";
import { toolDescriptor } from "@pi-bot/runtime-contracts";

test("image tools isolate provider credentials, bind run/call identity and propagate cancellation", async t => {
  const requests: { url: string; init?: RequestInit }[] = [];
  let status = 200;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url, init }); return Response.json(status === 200 ? { artifact: { id: "image", mime: "image/png" } } : { detail: "结果未确认" }, { status });
  });
  const tools = imageGenerationTools("https://server/prefix/", () => "scoped-agent-token", "run", true);
  assert.deepEqual(imageGenerationTools("https://server", () => "token", "run", false).map(tool => tool.name), ["image_models", "image_read"]);
  const generate = tools.find(tool => tool.name === "image_generate")!;
  const abort = new AbortController();
  const result = await generate.execute("call-one", { prompt: "robot", model: "gemini-3.1-flash-image", run_id: "forged", request_id: "forged" }, abort.signal, undefined, {} as any);
  assert.equal(requests[0].url, "https://server/prefix/agent/images/generate");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { run_id: "run", request_id: "call-one", prompt: "robot", model: "gemini-3.1-flash-image" });
  assert.equal(new Headers(requests[0].init?.headers).get("authorization"), "Bearer scoped-agent-token");
  assert.doesNotMatch(JSON.stringify(result), /base64|scoped-agent-token/);
  assert.equal(toolDescriptor("image_generate")?.fileOutput, true);
  assert.equal(toolDescriptor("image_generate")?.readonly, false);
  abort.abort(); assert.equal(requests[0].init?.signal?.aborted, true);
  status = 409; await assert.rejects(generate.execute("call-one", { prompt: "robot" }, undefined, undefined, {} as any), /结果未确认/);
});
