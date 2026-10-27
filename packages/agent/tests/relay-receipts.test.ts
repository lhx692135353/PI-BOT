import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askAgentTool, createBotAgent, taskTools } from "../src/index.js";
import { ExecutionReceipts } from "../src/execution-receipts.js";
import { ResponseStream } from "./responses.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const falseClaim = "问了，刚发出去。我给他发了消息问为什么停、跑到哪一档。";
const queuedAnswer = "询问已提交，正在排队，尚不能确认对方已收到。";
const output = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const task = (status = "queued") => ({ id: TASK, status, mode: "report", agent: { id: "specialist", name: "压测智能体" }, result: null, error: status === "failed" ? "电脑已离线" : null });

test("relay claims require a send receipt, not a status lookup, reply to the user or unrelated task", () => {
  const receipts = new ExecutionReceipts();
  for (const claim of [falseClaim, "已转交给压测智能体。", "我已经问他了。", "消息发出去了。", "对方已收到消息。", "之前他停了，刚给他发送了追问。"])
    assert.equal(receipts.unsupported(claim), true, claim);
  for (const honest of ["我去问他为什么停了。", "还没发，我现在去问。", "尚未发送消息。", "我没有问过他。", "不能说对方已经收到。", "上次已经转发过消息。", "“问了，刚发出去”这句话没有依据。"])
    assert.equal(receipts.unsupported(honest), false, honest);
  receipts.record("task_status", output({ tasks: [task("running")] }));
  receipts.record("start_task", output(task("running")));
  receipts.record("send_reply", { content: [{ type: "text", text: "已发送，不要重复。" }] });
  assert.equal(receipts.unsupported(falseClaim), true);
  receipts.record("ask_agent", { content: [{ type: "text", text: "已转交给压测智能体。" }], details: { task: task() } });
  assert.equal(receipts.unsupported(falseClaim), false);
  assert.equal(receipts.unsupported("对方已经收到消息了。"), true, "queuing does not prove receipt");
  receipts.reset();
  assert.equal(receipts.unsupported(falseClaim), true, "a previous turn cannot prove a new send");
});

test("a finished task cannot receive a follow-up and pending instructions cannot prove delivery", () => {
  const receipts = new ExecutionReceipts();
  receipts.record("task_message", output({ task: task("completed"), delivery: "finished" }));
  assert.equal(receipts.unsupported(falseClaim), true);
  receipts.record("ask_agent", { details: { task: task("failed") } });
  assert.equal(receipts.unsupported(falseClaim), true);
  receipts.record("task_message", output({ task: task("running"), delivery: "pending" }));
  assert.equal(receipts.unsupported(falseClaim), false);
  assert.equal(receipts.unsupported("补充已送达。"), true);
  receipts.record("task_message", output({ task: task("running"), delivery: "delivered" }));
  assert.equal(receipts.unsupported("补充已送达。"), false);
});

type Scenario = "repeat" | "recover" | "explicit" | "finished" | "failed" | "queued-received";
async function scenario(kind: Scenario) {
  const published: string[] = [], displayed: string[] = [], calls: { path: string; body: any }[] = [];
  let modelCalls = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url?.startsWith("/agent/tasks")) {
      calls.push({ path: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(req.url.endsWith("/messages") ? { task: task("completed"), delivery: "finished" } : task(kind === "failed" ? "failed" : "queued")));
    }
    modelCalls++;
    const stream = new ResponseStream(res, body.model);
    const correcting = body.input.some((m: any) => m.role === "user" && JSON.stringify(m.content).includes("系统校验"));
    const invoked = (name: string) => body.input.some((m: any) => m.type === "function_call" && m.name === name);
    if (kind === "repeat") stream.text(falseClaim);
    else if (kind === "explicit" && !invoked("send_reply")) stream.tool("send_reply", { phase: "answer", text: falseClaim }, "unsupported-reply");
    else if (kind === "finished" && !invoked("task_message")) stream.tool("task_message", { task_id: TASK, text: "为什么停了？" }, "old-task");
    else if ((kind === "recover" || kind === "finished") && !correcting) stream.text(falseClaim);
    else if (!invoked("ask_agent")) stream.tool("ask_agent", { agent: "压测智能体", task: "请核实为什么停止，报告最后一轮的状态和已有数据。", wait: false, execution: "cloud" }, "ask-specialist");
    else if (kind === "queued-received" && !correcting) stream.text("对方已经收到消息了。");
    else if (kind === "failed") stream.text(correcting ? "消息没能发送，对方没有开始处理。" : "已转交给压测智能体。");
    else stream.text(queuedAnswer);
    stream.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "relay-receipts-"));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const agent = await createBotAgent({
    model: { id: "relay", name: "test", baseUrl: `${base}/v1`, modelId: "test", contextWindow: 32000, maxTokens: 1000 },
    apiKey: "test-secret", cwd: dir, agentDir: join(dir, "agent"), systemPrompt: "只能按真实回执确认传话。", history: [], verifyExecutionClaims: true,
    tools: [askAgentTool(base, () => "token", RUN, { conversation: true }), ...taskTools(base, () => "token", RUN)],
    onReply: reply => { published.push(reply.text); },
  });
  try {
    let answer = "", error: unknown;
    try { answer = await agent.prompt("他停了，你问问他为什么", text => displayed.push(text)); } catch (e) { error = e; }
    return { answer, error, calls, modelCalls, published, displayed };
  } finally {
    agent.dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the screenshot's repeated unbacked relay claim never reaches the chat", async () => {
  const data = await scenario("repeat");
  assert.match(String(data.error), /真实任务回执/);
  assert.equal(data.modelCalls, 2);
  assert.equal(data.calls.length, 0);
  assert.ok(data.displayed.every(text => !text.includes("发出去")));
});

for (const kind of ["recover", "explicit", "finished", "queued-received"] as const) {
  test(`real agent corrects ${kind} with a durable delegation receipt and no duplicate send`, async () => {
    const data = await scenario(kind);
    assert.equal(data.error, undefined);
    assert.equal(data.answer, queuedAnswer);
    assert.equal(data.calls.filter(c => c.path === "/agent/tasks").length, 1);
    assert.equal(data.calls.find(c => c.path === "/agent/tasks")!.body.agent, "压测智能体");
    assert.equal(data.calls.find(c => c.path === "/agent/tasks")!.body.wait, false);
    assert.ok([...data.displayed, ...data.published].every(text => !text.includes("刚发出去") && !text.includes("对方已经收到")));
    if (kind === "finished") assert.equal(data.calls.filter(c => c.path.endsWith("/messages")).length, 1);
  });
}

test("an immediately failed delegation is an error instead of a successful hand-off", async () => {
  const data = await scenario("failed");
  assert.equal(data.error, undefined);
  assert.equal(data.answer, "消息没能发送，对方没有开始处理。");
  assert.equal(data.calls.length, 1);
  assert.ok(data.displayed.every(text => !text.includes("已转交")));
});
