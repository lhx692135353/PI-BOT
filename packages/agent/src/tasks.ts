import { routingParameters, routingDescription } from "./routing.js";
import { RuntimeError, errorInfo, httpErrorInfo } from "@pi-bot/runtime-contracts";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const TASK_TOOL_NAMES = new Set(["device_status", "endpoint_experience", "start_task", "task_status", "task_message", "cancel_task"]);

/** Conversation-only tools: every operation returns without waiting for work. */
export function taskTools(baseUrl: string, token: () => string, runId: string): ToolDefinition[] {
  const call = async (method: string, path: string, body?: object): Promise<any> => {
    const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/agent/tasks${path}`, {
      method, headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    if (!r.ok) throw new RuntimeError(errorInfo(data) ?? httpErrorInfo(r.status,typeof data.detail === "string" ? data.detail : "任务操作失败，请稍后重试","task"));
    return data;
  };
  const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data });
  return [
    {
      name: "device_status", label: "查询电脑实时连接",
      description: "只读查询当前账号电脑在服务器上的实时连接状态、检查时间和能力。用户问电脑现在是否在线时调用此工具，不用创建任务试探，不从历史任务失败或上下文快照推断当前状态。online 仅代表服务器当前持有连接，不保证文件权限、资源或命令可用；离线不代表已确认断线原因。",
      parameters: Type.Object({ device_id: Type.Optional(Type.String({ format: "uuid", description: "指定电脑；省略则列出当前账号的电脑。" })) }),
      execute: async (_id, args: any) => {
        const query = new URLSearchParams({ run_id: runId, ...(args.device_id ? { device_id: args.device_id } : {}) });
        const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/agent/devices?${query}`, {
          headers: { Authorization: `Bearer ${token()}` }, redirect: "error", signal: AbortSignal.timeout(15000),
        });
        const data = await response.json();
        if (!response.ok) throw new RuntimeError(errorInfo(data) ?? httpErrorInfo(response.status, data.detail ?? "电脑状态查询失败", "device"));
        return result(data);
      },
    },
    {
      name:"endpoint_experience",label:"核查执行端经验",
      description:"读取本智能体历史执行证据；经验不代表当前权限或文件仍存在。出现冲突先在原执行端核查，再用更新的成功证据解决冲突，旧证据保留。",
      parameters:Type.Object({resource_key:Type.Optional(Type.String({maxLength:2000})),action:Type.Union([Type.Literal("list"),Type.Literal("resolve")]),conflict_id:Type.Optional(Type.String({format:"uuid"})),confirmation_id:Type.Optional(Type.String({format:"uuid"}))}),
      execute:async(_id,args:any)=>{
        const response=await fetch(`${baseUrl.replace(/\/+$/,"")}/agent/endpoint-experience`,{method:"POST",headers:{Authorization:`Bearer ${token()}`,"Content-Type":"application/json"},body:JSON.stringify({...args,run_id:runId}),redirect:"error",signal:AbortSignal.timeout(15000)});
        const data=await response.json();if(!response.ok)throw new Error(data.detail??"经验核查失败");return result(data);
      },
    },
    {
      name: "start_task", label: "安排后台任务",
      description: "创建独立的后台任务并立即返回。先简短回应用户要核实什么，再安排任务。task 自包含但精简，保留目标、必要上下文、位置、约束和期望输出；详细执行计划交给后台，不复制历史全文，不省略关键条件，不重复创建已有任务。最多同时执行两个，其他排队。" + routingDescription,
      parameters: Type.Object({
        ...routingParameters,
        browser_test_origin: Type.Optional(Type.String({ maxLength: 2048, description: "端侧 Web 功能测试的 HTTP(S) origin，只含协议、主机和端口。服务端自动添加端侧浏览器能力要求。未指定电脑时省略 device_id。已知项目设备时保留 resources.target。" })),
        browser_test_visible: Type.Optional(Type.Boolean({ description: "已知需要用户登录、扫码，或用户要求观看时开启。从任务开始在执行电脑上显示独立浏览器窗口。默认后台运行。" })),
        coding: Type.Optional(Type.Boolean({ description: "任务需要修改或生成项目代码时填 true。" })),
        electron_test: Type.Optional(Type.Object({
          app: Type.Union([Type.Literal("pibot"), Type.Literal("electron")]),
          executable: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "已有 Electron 测试程序的可执行文件。测试 Pi Bot 用 app=pibot 并省略此字段。" })),
          entry: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "可选。指定 Electron 开发项目入口。" })),
        }, { description: "端侧 Electron 功能测试。已知项目在哪台电脑时使用 resources.target；其余情况先询问用户明确电脑。" })),
        title: Type.String({ minLength: 1, maxLength: 80, description: "用户能看懂的简短任务名称，通常 10–20 字，例如检查显存占用；不填内部代号、命令或参数" }),
        task: Type.String({ minLength: 1, maxLength: 8000 }),
      }),
      execute: async (id, args: any) => result(await call("POST", "", { ...args, run_id: runId, kind: "background", wait: false, request_id: id })),
    },
    {
      name: "task_status", label: "查看任务状态",
      description: "不等待任务完成，查询本 Bot 的任务状态、最近活动及更新时间。不传 task_id 只列出最近任务的摘要和结果开头；需要完整结果、检查点或工具记录时传 task_id。这不是对外部系统的实时核查。",
      parameters: Type.Object({ task_id: Type.Optional(Type.String({ format: "uuid" })) }),
      execute: async (_id, args: any) => result(await call("GET", args.task_id ? `/${args.task_id}?run_id=${runId}` : `?run_id=${runId}`)),
    },
    {
      name: "task_message", label: "补充任务要求",
      description: "向指定任务发送补充、问题或变更要求。运行中在当前工具结束后生效；排队任务启动时读取。delivery=queued/pending 只表示已保存待送达，不能说对方已收到；delivered 才表示执行器确认收到，不代表已执行或已回答。finished 表示任务已结束，本条消息未发送，应结合原结果用 ask_agent 重新提问或创建后续任务。",
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
