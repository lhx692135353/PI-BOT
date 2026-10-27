import { ERROR_CODES } from "./generated.js";
export { ERROR_CODES, type ArtifactRef } from "./generated.js";
/** Platform-owned contracts. Display text is never an input to these decisions. */
export const PROTOCOL_VERSION = 2;
export const ACTIVE_RUN_STATES = [
  "queued",
  "running",
  "waiting_approval",
] as const;
export const TERMINAL_RUN_STATES = [
  "completed",
  "failed",
  "cancelled",
] as const;
export type RunStatus =
  (typeof ACTIVE_RUN_STATES)[number] | (typeof TERMINAL_RUN_STATES)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];
export interface AppError {
  code: ErrorCode;
  scope: string;
  retryable: boolean;
  outcome: "not_started" | "failed" | "unknown";
  message: string;
}
export class RuntimeError extends Error {
  constructor(readonly info: AppError) {
    super(info.message);
    this.name = "RuntimeError";
  }
}
export function errorInfo(value: unknown): AppError | undefined {
  if (value instanceof RuntimeError) return value.info;
  if (!value || typeof value !== "object") return;
  const v = value as {
    error_info?: AppError;
    info?: AppError;
    code?: unknown;
    scope?: unknown;
    retryable?: unknown;
    outcome?: unknown;
    message?: unknown;
  };
  const info = v.error_info ?? v.info ?? v;
  if (
    typeof info.code === "string" &&
    typeof info.scope === "string" &&
    typeof info.retryable === "boolean" &&
    typeof info.outcome === "string" &&
    typeof info.message === "string"
  )
    return info as AppError;
}
export function httpErrorInfo(
  status: number,
  message: string,
  scope = "api",
): AppError {
  const code: ErrorCode =
    (
      {
        400: "invalid_request",
        401: "unauthorized",
        403: "forbidden",
        404: "not_found",
        409: "conflict",
        422: "invalid_request",
        429: "unavailable",
        501: "unsupported",
        503: "unavailable",
        504: "timeout",
      } as Record<number, ErrorCode>
    )[status] ?? "internal";
  return {
    code,
    scope,
    retryable: status === 429 || status === 503 || status === 504,
    outcome: "not_started",
    message,
  };
}
export interface ToolDescriptor {
  visibility: "public" | "internal";
  effect: "read" | "write" | "delegate" | "control";
  activity: "searching" | "working" | "waiting";
  label: string;
  readonly: boolean;
  platformOwned?: boolean;
  fileOutput?: boolean;
}
const tool = (
  label: string,
  effect: ToolDescriptor["effect"],
  visibility: ToolDescriptor["visibility"] = "public",
  activity: ToolDescriptor["activity"] = "working",
  platformOwned = false,
): ToolDescriptor => ({
  label,
  effect,
  visibility,
  activity,
  readonly: effect === "read",
  platformOwned,
});
/** Registration, not inference from names or model prose. Unknown tools get no permissions. */
export const TOOL_REGISTRY: Readonly<Record<string, ToolDescriptor>> =
  Object.freeze({
    list_files: tool("浏览文件", "read", "public", "searching"),
    read_file: tool("阅读文件", "read", "public", "searching"),
    search_files: tool("搜索文件", "read", "public", "searching"),
    web_search: tool("查找资料", "read", "public", "searching"),
    write_file: tool("写入文件", "write"),
    edit_file: tool("修改文件", "write"),
    run_command: tool("运行命令", "write"),
    request_outside_access: tool(
      "申请文件访问",
      "control",
      "public",
      "waiting",
    ),
    ask_agent: tool("联系智能体", "delegate", "public", "waiting"),
    start_task: tool("安排后台任务", "delegate", "internal"),
    task_status: tool("查看任务", "read", "internal"),
    task_message: tool("补充任务", "control", "internal"),
    cancel_task: tool("取消任务", "control", "internal"),
    skill_manage: tool("维护技能", "write", "internal", "working", true),
    skill_load: tool("读取技能", "read", "internal", "working", true),
    memory_manage: tool("维护记忆", "write", "internal", "working", true),
    history_search: tool("检索历史", "read", "internal", "searching", true),
    agent_directory: tool("查看协作者", "read", "internal", "searching", true),
    task_checkpoint: tool("保存检查点", "write", "internal", "working", true),
    resume_task: tool("继续任务", "delegate", "internal", "working", true),
    goal_manage: tool("管理目标", "control", "internal"),
    goal_finish: tool("提交目标结果", "control", "internal"),
    send_reply: tool("回复用户", "control", "internal", "working", true),
    get_ui_catalog: tool("读取界面组件", "read"),
    show_ui: tool("展示界面", "control"),
    publish_report: { ...tool("保存报告", "write"), fileOutput: true },
    report_read: tool("读取报告片段", "read", "internal", "searching"),
  });
export const toolDescriptor = (name: string): ToolDescriptor | undefined =>
  TOOL_REGISTRY[name];
export const internalTool = (name: string) =>
  toolDescriptor(name)?.visibility === "internal";

export interface ActionReceipt {
  id: string;
  run_id: string;
  tool_call_id: string;
  tool: string;
  status: "accepted" | "completed" | "failed" | "unknown";
  resource_id?: string;
  target_id?: string;
  error_info?: AppError;
  created_at: string;
}
export interface ModelCapabilities {
  chat: boolean;
  vision: boolean;
  voice: boolean;
  tools: boolean;
  reasoning: "none" | "configurable" | "required" | "unknown";
  reasoning_off?: Record<string, unknown>;
}
export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  chat: true,
  vision: true,
  voice: false,
  tools: true,
  reasoning: "unknown",
};
export const CONTEXT_DEFAULTS = {
  inputTokens: 16000,
  historyTokens: 4000,
  historyTurns: 6,
  memoryTokens: 1500,
  stateTokens: 1000,
} as const;
export const MAX_REPORT_BYTES = 10 * 1024 * 1024;
