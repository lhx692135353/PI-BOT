import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export function automationTools(baseUrl: string, token: () => string, runId: string, automatic = false): ToolDefinition[] {
  const call = async (path: string, body: object, signal?: AbortSignal) => {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/agent/automations${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, run_id: runId }), redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "目标操作失败");
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: {} };
  };
  const manage = (review: boolean): ToolDefinition => ({
    name: "goal_manage", label: "管理目标",
    description: review
      ? "发现明确且尚未完成的事时可以新建一个目标，本轮最多一个。先 list 避免重复。create 必须给 goal；没有新的授权时 authorization 写「在自己的资料库内推进」。不能修改、暂停或停止已有目标。若本轮新建了目标，goal_finish 必须带上它。"
      : "用户在追求一件会持续的事时自己记下目标，不要等用户说「建立目标」，立即返回。先 list 避免重复。create 必须给 goal 和已经允许做的范围 authorization。list 可查进度、检查点和 version；修改使用 expected_version。all=true 仅在用户明确要求全部时使用。暂停、完成或停止会使进行中的检查失效。目标检查等待绑定电脑在线，不在云端执行。",
    parameters: Type.Object({
      action: Type.Union((review ? ["list", "create"] : ["list", "create", "update", "pause", "resume", "complete", "stop"]).map(x => Type.Literal(x))),
      ...(review ? {} : { goal_id: Type.Optional(Type.String({ format: "uuid" })), all: Type.Optional(Type.Boolean()), expected_version: Type.Optional(Type.Integer({ minimum: 1 })) }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })), goal: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      authorization: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    }),
    execute: async (id, args: any, signal) => call("", { ...args, request_id: id }, signal),
  });
  if (automatic) return [{
    name: "goal_finish", label: "提交本轮目标检查",
    description: "目标检查结束前必须调用一次，然后立即结束本轮。goals 必须包含每一个进行中的目标，包括本轮新建的。没有新进展 notify=false；可交付成果、重要变化或需要用户决定才 notify=true，并使用稳定的 notification_key。同一目标同一状态不得换 key。waiting_user 必须回报。",
    parameters: Type.Object({
      goals: Type.Array(Type.Object({
        id: Type.String({ format: "uuid" }),
        state: Type.Union(["continue", "done", "waiting_user"].map(x => Type.Literal(x))),
        progress: Type.String({ minLength: 1, maxLength: 12000 }),
        notify: Type.Boolean(),
        reason: Type.String({ minLength: 1, maxLength: 1000 }),
        notification_key: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        checkpoint: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }), { minItems: 1, maxItems: 30 }),
      next_wake_at: Type.Optional(Type.String({ description: "至少一分钟后的 ISO 8601 时间，包含时区；不传则按空闲情况拉长间隔" })),
    }),
    execute: async (_id, args: any, signal) => call("/finish", { decision: args }, signal),
  }, manage(true)] as ToolDefinition[];
  return [manage(false)];
}
