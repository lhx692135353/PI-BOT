import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const TASK_TOOL_NAMES = new Set(["start_task", "task_status", "task_message", "cancel_task"]);

/** Conversation-only tools: every operation returns without waiting for work. */
export function taskTools(baseUrl: string, token: () => string, runId: string): ToolDefinition[] {
  const call = async (method: string, path: string, body?: object): Promise<any> => {
    const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/agent/tasks${path}`, {
      method, headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : "任务操作失败，请稍后重试");
    return data;
  };
  const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: {} });
  return [
    {
      name: "start_task", label: "安排后台任务",
      description: "创建独立的后台任务并立即返回。task 包含目标、相关上下文、已有条件和期望输出；不要重复创建已有任务。最多同时执行两个，其他排队。操作电脑用 device，可用 device_id 指定电脑；操作云端虚机用 remote；纯文字或搜索用 cloud。默认遵守本轮操作位置和已有文件归属。原机器离线时说明，不自动换机器。",
      parameters: Type.Object({ execution: Type.Optional(Type.Union([Type.Literal("device"),Type.Literal("cloud"),Type.Literal("remote")])), device_id: Type.Optional(Type.String({format:"uuid"})), title: Type.String({ minLength: 1, maxLength: 80, description: "用户能看懂的简短任务名称，通常 10–20 字，例如检查显存占用；不填内部代号、命令或参数" }), task: Type.String({ minLength: 1, maxLength: 8000 }) }),
      execute: async (id, args: any) => result(await call("POST", "", { ...args, run_id: runId, kind: "background", wait: false, request_id: id })),
    },
    {
      name: "task_status", label: "查看任务状态",
      description: "不等待任务完成，查询本 Bot 的任务状态、最近活动及更新时间。可传 task_id 查详情，不传列出最近任务。这不是对外部系统的实时核查。",
      parameters: Type.Object({ task_id: Type.Optional(Type.String({ format: "uuid" })) }),
      execute: async (_id, args: any) => result(await call("GET", args.task_id ? `/${args.task_id}?run_id=${runId}` : `?run_id=${runId}`)),
    },
    {
      name: "task_message", label: "补充任务要求",
      description: "向指定任务发送补充或变更要求。运行中在当前工具结束后生效；排队任务启动时读取。返回 finished 时任务已结束，请根据原结果创建后续任务。",
      parameters: Type.Object({ task_id: Type.String({ format: "uuid" }), text: Type.String({ minLength: 1, maxLength: 8000 }) }),
      execute: async (id, args: any) => result(await call("POST", `/${args.task_id}/messages`, { run_id: runId, text: args.text, request_id: id })),
    },
    {
      name: "cancel_task", label: "取消任务",
      description: "用户明确要求时取消指定任务及其子任务。明确停止全部时用 all=true。多任务指代不明时先澄清。",
      parameters: Type.Object({ task_id: Type.Optional(Type.String({ format: "uuid" })), all: Type.Optional(Type.Boolean()) }),
      execute: async (_id, args: any) => result(await call("POST", "/cancel", { run_id: runId, ...args })),
    },
  ] as ToolDefinition[];
}
