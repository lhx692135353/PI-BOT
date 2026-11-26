import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotAgent, replyAnswer, type ReplyEvent } from "../src/index.js";
import { ResponseStream, realToolOutputs } from "./responses.js";

test("explicit replies publish before the final response, redact secrets and survive an empty ending", async () => {
  const replies: ReplyEvent[] = [], text: string[] = [], progress: string[][] = [];
  let release!: () => void, opened!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const opening = new Promise<void>(r => { opened = r; });
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), rounds = realToolOutputs(body.input).length;
    const stream = new ResponseStream(res, body.model);
    if (rounds === 0) {
      stream.text("PRIVATE 内部技能管理说明");
      stream.tool("send_reply", { text: "先检查服务的显存占用。secret-token", phase: "opening" }, "open");
    } else if (rounds === 1) {
      await gate;
      stream.tool("send_reply", { text: "服务正常，显存占用 60%。", phase: "answer" }, "answer1");
    } else if (rounds === 2) {
      stream.tool("send_reply", { text: "下一步调到 85%，重启后再测。", phase: "answer" }, "answer2");
    }
    stream.end();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "pibot-replies-"));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const agent = await createBotAgent({
    model: { id: "reply-test", name: "test", baseUrl, modelId: "test", contextWindow: 32000, maxTokens: 1000 },
    apiKey: "secret-token", cwd: dir, agentDir: join(dir, "agent"), systemPrompt: "test", history: [], tools: [],
    skills: { baseUrl, token: () => "secret-token", runId: "test", catalog: [] },
    onReply: reply => { replies.push(reply); opened(); }, onProgress: lines => progress.push(lines),
  });
  try {
    let done = false;
    const result = agent.prompt("检查服务", t => text.push(t)).finally(() => { done = true; });
    await opening;
    assert.equal(done, false);
    assert.equal(replies[0].phase, "opening");
    assert.match(replies[0].text, /已隐藏凭据/);
    assert.ok(!text.some(t => /PRIVATE|secret-token/.test(t)));
    assert.deepEqual(progress, []);
    release();
    assert.equal(await result, "服务正常，显存占用 60%。\n\n下一步调到 85%，重启后再测。");
    assert.equal(replies.length, 3);
  } finally {
    release(); agent.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit answers are authoritative independently of final text", () => {
  const replies = [{ phase: "answer" as const, text: "完成了。" }, { phase: "opening" as const, text: "先检查。" }];
  assert.equal(replyAnswer(replies, "完成了。"), "完成了。");
  assert.equal(replyAnswer(replies, "下一步重测。"), "完成了。");
  assert.equal(replyAnswer([], "    print(1)\n"), "    print(1)\n", "Markdown indentation must survive publication");
});

for (const failPreview of [false, true]) test(`public send_reply streams safely and recovers preview failure=${failPreview}`, async () => {
  const { ResponseStream, isRealToolResult } = await import("./responses.js");
  const { createServer } = await import("node:http");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createBotAgent } = await import("../src/index.js");
  const events: ReplyEvent[] = [];
  let publishedBeforeDone = false;
  let previewFailed = false;
  const text = "先输出这一段公共回复，再继续输出后面的内容。".repeat(5);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    const stream = new ResponseStream(res, request.model);
    if (isRealToolResult(request.input)) { stream.end(); return; }
    stream.text("INTERNAL-NOT-PUBLIC");
    // Deliberately produce text before phase: provider argument ordering is not guaranteed.
    await stream.streamingTool("send_reply", {text, phase:"answer"}, "public-preview", () => {
      publishedBeforeDone = events.some(e => e.streaming);
    });
    stream.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "reply-stream-"));
  const agent = await createBotAgent({model: {id:"stream-test", name:"Stream test", baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`, modelId:"test", contextWindow:32000, maxTokens:1000}, apiKey:"secret-test-key", cwd:dir, agentDir:join(dir,"agent"), systemPrompt:"Only public replies via send_reply", history:[], tools:[], onReply: async e => {
    if (failPreview && e.streaming && !previewFailed) { previewFailed = true; throw new Error("transient preview failure"); }
    events.push(e);
  }});
  try {
    const deltas: string[] = [];
    assert.equal(await agent.prompt("reply", t => deltas.push(t)), text);
    assert.equal(publishedBeforeDone || previewFailed, true);
    assert.deepEqual(deltas.filter(Boolean), []);
    if (!failPreview) assert.ok(events.some(e => e.streaming && e.text.length < text.length));
    assert.equal(previewFailed, failPreview);
    assert.equal(events.at(-1)?.text, text);
    assert.equal(events.at(-1)?.phase, "answer");
    assert.equal(events.at(-1)?.streaming, undefined);
    assert.ok(events.every(e => !e.text.includes("INTERNAL")));
  } finally { agent.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir,{recursive:true,force:true}); }
});

test("reply previews withhold split credentials and ignore internal tools", async () => {
  const { ReplyPreview } = await import("../src/replies.js");
  const events: ReplyEvent[] = [];
  const secret = "secret-credential";
  const preview = new ReplyPreview(e => events.push(e), secret.length - 1, t => t.replaceAll(secret, "[redacted]"));
  preview.update({type:"toolCall", name:"codemode", id:"private", arguments:{text:"INTERNAL",phase:"answer"}});
  for (let i=1;i<secret.length;i++) preview.update({type:"toolCall",name:"send_reply",id:"reply",arguments:{phase:"answer",text:"public "+secret.slice(0,i)}});
  for (let i=0;i<30;i++) preview.update({type:"toolCall",name:"send_reply",id:"reply",arguments:{phase:"answer",text:"public "+secret+" trailing".repeat(i)}});
  assert.ok(events.every(e => !e.text.includes("secret")));
  assert.ok(events.every(e => e.id === "reply"));
});
