import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

interface AgentTask {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  mode: "wait" | "report";
  agent: { id: string; name: string };
  result: string | null;
  error: string | null;
}
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const RESULT_LIMIT = 20000;

export interface AskAgentOptions {
  /** How long `wait=true` blocks before the task is turned into a later report. */
  waitLimitMs?: number;
  conversation?: boolean;
  /** Long-poll window per request, in seconds. */
  pollSeconds?: number;
}

/** Hands work to another of the user's bots through the Server; the token is the run's proxy token. */
export function askAgentTool(baseUrl: string, token: () => string, runId: string, options: AskAgentOptions = {}): ToolDefinition {
  const root = baseUrl.replace(/\/+$/, "");
  const waitLimit = options.waitLimitMs ?? 10 * 60 * 1000;
  const poll = options.pollSeconds ?? 25;
  const call = async (method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 15000): Promise<AgentTask> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${root}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { detail?: unknown };
      throw new Error(typeof error.detail === "string" ? error.detail.slice(0, 300) : "委托失败，请稍后重试或自己完成");
    }
    return (await response.json()) as AgentTask;
  };
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
  return {
    name: "ask_agent",
    label: "委托智能体",
    description:
      "把问题或任务交给同一用户的另一个智能体。用 agent_directory 确认职责和知识主题，agent 优先填稳定 ID，也接受名字；task 要自包含（目标、已知信息、期望输出），对方看不到你的对话，会使用自己的记忆。继承当前任务的机器归属；电脑用 execution=device 并可指定 device_id，云端虚机用 remote，纯文字或搜索用 cloud。不能因离线自动切换机器。wait=true 等结果；wait=false 完成后回报。要求对方给出来源、时间和不确定性，没有依据时说明不知道。",
    parameters: Type.Object({
      agent: Type.String({ minLength: 1, maxLength: 100, description: "目标智能体稳定 ID（优先）或名字，从 agent_directory 获取" }),
      task: Type.String({ minLength: 1, maxLength: 8000, description: "自包含的任务描述" }),
      wait: Type.Optional(Type.Boolean({ description: "是否等待结果，默认 true" })),
      device_id:Type.Optional(Type.String({format:"uuid"})),
      execution: Type.Optional(Type.Union([Type.Literal("device"), Type.Literal("cloud"), Type.Literal("remote")])),
    }),
    execute: async (_id, args: any, signal) => {
      const wait = options.conversation ? false : args.wait !== false;
      let task = await call("POST", "/agent/tasks", { run_id: runId, agent: args.agent, task: args.task, wait, execution: args.execution, device_id:args.device_id, request_id: _id }, signal);
      const name = task.agent.name || String(args.agent);
      if (!wait) return text(`已转交给「${name}」。对方完成后你会收到回报，现在可以先告诉用户任务已经交出去了。`);
      const deadline = Date.now() + waitLimit;
      let mustWait = false;
      while (!TERMINAL.has(task.status)) {
        if (!mustWait && Date.now() >= deadline) {
          try {
            task = await call("POST", `/agent/tasks/${task.id}/report`, undefined, signal);
            if (task.mode === "report" && !TERMINAL.has(task.status))
              return text(`「${name}」还在进行，已改为完成后回报。先告诉用户任务仍在处理，结果回来后你会收到回报。`);
          } catch (error) {
            if (signal?.aborted) throw error;
            mustWait = true;
          }
          continue;
        }
        task = await call("GET", `/agent/tasks/${task.id}?wait=${poll}`, undefined, signal, (poll + 15) * 1000);
      }
      if (task.status === "failed") throw new Error(`「${name}」没能完成：${task.error ?? "运行失败"}`);
      if (task.status === "cancelled") throw new Error(`「${name}」的任务已被取消`);
      const result = task.result?.trim() || "（对方没有返回文字结果）";
      return text(`「${name}」的结果：\n${result.length > RESULT_LIMIT ? `${result.slice(0, RESULT_LIMIT)}\n…（结果过长，已截断）` : result}`);
    },
  };
}
