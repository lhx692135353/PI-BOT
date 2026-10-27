import { Type } from "typebox";
import type {
  ToolDefinition,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  MAX_REPORT_BYTES,
  RuntimeError,
  errorInfo,
  httpErrorInfo,
} from "@pi-bot/runtime-contracts";

export function reportTools(
  base: string,
  token: () => string,
  runId: string,
  writable = false,
): ToolDefinition[] {
  const call = async (path: string, data: object, signal?: AbortSignal) => {
    const r = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ run_id: runId, ...data }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
    const value = await r.json();
    if (!r.ok)
      throw new RuntimeError(
        errorInfo(value) ??
          httpErrorInfo(r.status, value.detail ?? "报告操作失败", "report"),
      );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      details: value,
    };
  };
  const read: ToolDefinition = {
    name: "report_read",
    label: "读取报告片段",
    description:
      "用户需要分析报告时按文件 ID 读取相关片段。打开文件预览不需要调用此工具，不要自动读取整份报告。",
    parameters: Type.Object({
      artifact_id: Type.String({ format: "uuid" }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })),
    }),
    execute: async (_id, args: any, signal) =>
      call(
        `/agent/reports/${args.artifact_id}/read`,
        { offset: args.offset, limit: args.limit },
        signal,
      ),
  };
  if (!writable) return [read];
  return [
    read,
    {
      name: "publish_report",
      label: "保存报告文件",
      description:
        "将需要独立阅读或保存的完整报告写成 Markdown 文件。content 是完整正文，summary 只写简短实际结论。返回文件引用后用简短结论结束，不再把正文复制到回答、记忆或检查点。适中解释可以直接回复，不按字数或关键词机械决定。",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 160 }),
        summary: Type.String({ minLength: 1, maxLength: 1500 }),
        content: Type.String({ minLength: 1, maxLength: MAX_REPORT_BYTES }),
      }),
      execute: async (id, args: any, signal) =>
        call("/agent/reports", { request_id: id, ...args }, signal),
    },
  ];
}

/** Remove file bytes from later provider requests, including the writer's next turn. */
export function reportContextMessages<T>(messages: T[]): T[] {
  return messages.map((value: any) => {
    if (value.role !== "assistant" || !Array.isArray(value.content))
      return value;
    return {
      ...value,
      content: value.content.map((part: any) =>
        part.type === "toolCall" && part.name === "publish_report"
          ? {
              ...part,
              arguments: {
                ...part.arguments,
                content:
                  "[报告正文已单独保存为文件；按需使用 report_read 读取片段]",
              },
            }
          : part,
      ),
    };
  });
}
export const reportContextExtension: ExtensionFactory = (pi) => {
  pi.on("context", (event) => ({
    messages: reportContextMessages(event.messages),
  }));
  pi.on("session_before_compact", (event) => {
    event.preparation.messagesToSummarize = reportContextMessages(
      event.preparation.messagesToSummarize,
    );
    event.preparation.turnPrefixMessages = reportContextMessages(
      event.preparation.turnPrefixMessages,
    );
  });
};
