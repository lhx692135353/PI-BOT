import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createBotAgent } from "../src/index.js";
import { ExecutionReceipts } from "../src/execution-receipts.js";
import { ResponseStream, realToolOutputs } from "./responses.js";

const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: {} });
test("creation receipts prove scheduling, not mutation; history and quoted explanations remain usable", () => {
  const receipts = new ExecutionReceipts();
  assert.equal(receipts.unsupported("已创建变更任务。"), true);
  assert.equal(receipts.unsupported("刚才查到的状态：patch 已下发，新 Pod 正在启动。"), true);
  assert.equal(receipts.unsupported('“已创建任务”是调度成功的意思。上次备份已完成。任务尚未启动。'), false);
  receipts.record("start_task", result({ id: "job", status: "queued" }));
  assert.equal(receipts.unsupported("任务已安排。"), false);
  assert.equal(receipts.unsupported("patch 已下发。"), true);
  receipts.record("task_status", result({ id: "job", status: "running", checkpoint: { completed: ["已备份"] } }));
  assert.equal(receipts.unsupported("刚才查到的状态：备份已完成。"), false);
});

async function scenario(kind: "recover" | "repeat" | "explicit" | "queued") {
  const requests: any[] = [], displayed: string[] = [], published: string[] = [];
  let launches = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const stream = new ResponseStream(res, body.model);
    const rounds = realToolOutputs(body.input).length;
    const correcting = body.input.some((m: any) => m.role === "user" && JSON.stringify(m.content).includes("系统校验"));
    if (kind === "recover") {
      if (!correcting) stream.text("已创建变更任务。patch 已下发，新 Pod 正在启动。");
      else if (!rounds) stream.tool("start_task", { title: "检查服务启动", task: "按原授权核对服务" }, "start");
      else stream.text("已安排检查任务。");
    } else if (kind === "repeat") stream.text("已创建变更任务。patch 已下发。");
    else if (kind === "explicit") {
      if (!rounds) stream.tool("send_reply", { phase: "answer", text: "刚才查到：patch 已下发。" }, "lie");
      else stream.text("任务尚未启动，我没有执行变更。");
    } else {
      if (!rounds) stream.tool("start_task", { title: "检查服务启动", task: "核对服务" }, "start");
      else if (!correcting) stream.text("patch 已下发，新 Pod 正在启动。");
      else stream.text("任务已安排。");
    }
    stream.end();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "receipt-"));
  const agent = await createBotAgent({
    model: { id: "receipt", name: "test", baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, modelId: "test", contextWindow: 32000, maxTokens: 1000 },
    apiKey: "test-secret", cwd: dir, agentDir: join(dir, "agent"), systemPrompt: "遵守真实执行回执", history: [], verifyExecutionClaims: true,
    tools: [{ name: "start_task", label: "安排任务", description: "test", parameters: Type.Object({ title: Type.String(), task: Type.String() }),
      execute: async () => { launches++; return result({ id: "job", status: "queued" }); } }],
    onReply: reply => { published.push(reply.text); },
  });
  try {
    let answer = "", error: unknown;
    try { answer = await agent.prompt("按原授权核对服务", text => displayed.push(text)); } catch (e) { error = e; }
    return { requests, displayed, published, launches, answer, error };
  } finally { agent.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
}

test("an unsupported final claim is withheld and the model must actually create the task before announcing it", async () => {
  const data = await scenario("recover");
  assert.equal(data.error, undefined); assert.equal(data.launches, 1);
  assert.equal(data.answer, "已安排检查任务。");
  assert.ok(data.displayed.every(text => !text.includes("patch 已下发")));
  assert.equal(data.requests.length, 3);
});
test("repeated claims without real execution fail after one correction and never reach visible deltas", async () => {
  const data = await scenario("repeat");
  assert.match(String(data.error), /未取得真实任务回执/);
  assert.equal(data.requests.length, 2); assert.equal(data.launches, 0);
  assert.ok(data.displayed.every(text => !text.includes("已创建")));
});
test("send_reply cannot bypass receipt checks; an honest correction remains a normal answer", async () => {
  const data = await scenario("explicit");
  assert.equal(data.error, undefined); assert.equal(data.published.length, 0);
  assert.equal(data.answer, "任务尚未启动，我没有执行变更。");
});
test("a queued task cannot be reported as an applied change, and correction never creates a duplicate job", async () => {
  const data = await scenario("queued");
  assert.equal(data.error, undefined); assert.equal(data.launches, 1);
  assert.equal(data.answer, "任务已安排。");
  assert.ok(data.displayed.every(text => !text.includes("patch 已下发")));
});
