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
