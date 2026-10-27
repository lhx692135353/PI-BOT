/** Real-model evaluation in an isolated harness. No production API or device tools. */
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { createBotAgent } from "../../packages/agent/src/index.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
const baseUrl = process.env.PI_BOT_EVAL_BASE_URL,
  apiKey = process.env.PI_BOT_EVAL_API_KEY,
  modelId = process.env.PI_BOT_EVAL_MODEL;
if (!baseUrl || !apiKey || !modelId)
  throw Error(
    "Set PI_BOT_EVAL_BASE_URL, PI_BOT_EVAL_API_KEY and PI_BOT_EVAL_MODEL. No production credentials are discovered.",
  );
const groups = [
  {
    tool: "ask_agent",
    prompts: [
      "问问分析助手为什么停了。",
      "把这件事交给分析助手核实。",
      "让分析助手给出已有的数据。",
      "向分析助手确认现在是否还在跑。",
      "联系分析助手，核对他刚才的结果。",
      "请分析助手检查结论，回来告诉我。",
    ],
  },
  {
    tool: "start_task",
    prompts: [
      "检查项目里的日志，找出失败原因。",
      "联网查一下这个问题的官方说明。",
      "帮我运行项目测试。",
      "看看资料库里有哪些报告。",
      "查一下当前服务器的状态。",
      "分析一下这份日志，需要时查文件。",
    ],
  },
  {
    tool: "task_message",
    prompts: [
      "给活动任务 task-1 补充：只检查日志。",
      "告诉 task-1 先别重启，继续核实。",
      "让当前任务 task-1 顺便看一下磁盘。",
      "给 task-1 追加问题：有没有错误码？",
      "把 task-1 的范围缩小到最近一小时。",
      "通知 task-1 结果要附原始数据。",
    ],
  },
  {
    tool: null,
    prompts: [
      "早上好。",
      "一加一是多少？",
      "谢谢，收到。",
      "用一句话解释缓存。",
      "你能做什么？简单说。",
      "刚才只是举例“问问分析助手”，现在不用执行。",
    ],
  },
  {
    tool: "cancel_task",
    prompts: [
      "取消活动任务 task-1。",
      "停掉 task-1。",
      "task-1 不用继续了。",
      "结束正在跑的 task-1。",
      "撤销 task-1。",
      "请停止 task-1 的执行。",
    ],
  },
];
const cases = groups.flatMap((group) =>
  group.prompts.map((prompt) => ({ prompt, expected: group.tool })),
);
const output = resolve(process.env.PI_BOT_EVAL_OUTPUT ?? "artifacts/evals");
await mkdir(output, { recursive: true });
const results: object[] = [];
for (let repeat = 0; repeat < 3; repeat++)
  for (const [index, item] of cases.entries()) {
    const dir = await mkdtemp(join(tmpdir(), "pi-bot-eval-"));
    const calls: string[] = [];
    const replies: object[] = [];
    const started = Date.now();
    const tools: ToolDefinition[] = [
      "ask_agent",
      "start_task",
      "task_message",
      "cancel_task",
    ].map((name) => ({
      name,
      label: name,
      description: (
        {
          ask_agent: "联系另一个智能体，创建委托并立即返回。",
          start_task:
            "创建后台执行任务；聊天中搜索、读写文件、执行命令都交后台。",
          task_message: "向已有活动任务补充要求。",
          cancel_task: "按用户要求停止任务。",
        } as Record<string, string>
      )[name],
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async () => {
        calls.push(name);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: randomUUID(),
                status: "queued",
                delivery: "queued",
              }),
            },
          ],
          details: {},
        };
      },
    }));
    let agent: Awaited<ReturnType<typeof createBotAgent>> | undefined;
    try {
      agent = await createBotAgent({
        model: {
          id: randomUUID(),
          name: modelId,
          baseUrl,
          modelId,
          contextWindow: 32000,
          maxTokens: 2000,
        },
        apiKey,
        cwd: dir,
        agentDir: join(dir, "agent"),
        tools,
        history: [],
        systemPrompt:
          "你是可靠的同事。简短、具体地回答，自主使用原生工具。聊天保持可用，执行工作交后台。当前有活动任务 task-1；分析助手可以接收委托。执行事实依据回执，不把计划说成结果。没有要求实际操作时直接交流。",
        onReply: (r) => {
          replies.push(r);
        },
      });
      const answer = await agent.prompt(item.prompt, () => {});
      results.push({
        repeat,
        index,
        prompt: item.prompt,
        expected: item.expected,
        calls,
        protocol_pass:
          item.expected === null
            ? calls.length === 0
            : calls.includes(item.expected),
        elapsed_ms: Date.now() - started,
        replies,
        answer,
      });
    } catch (error) {
      results.push({
        repeat,
        index,
        prompt: item.prompt,
        calls,
        error: error instanceof Error ? error.message : "error",
      });
    } finally {
      agent?.dispose();
      await rm(dir, { recursive: true, force: true });
    }
    await writeFile(
      join(output, "agent-behavior.json"),
      JSON.stringify(
        { model: modelId, cases: 30, repeats: 3, results },
        null,
        2,
      ),
    );
  }
// Structural checks are not a language-quality verdict. Review answer clarity,
// false claims, unnecessary questions, and useful progress separately.
console.log(`Saved ${results.length} real-model trials to ${output}`);
