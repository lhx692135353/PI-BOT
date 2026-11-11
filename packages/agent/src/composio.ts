import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** The agent calls the API with its run token. The Composio key stays on the API. */
export function composioTools(baseUrl: string, token: () => string): ToolDefinition[] {
  const call = async (path: string, body: object, signal?: AbortSignal) => {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/agent/composio/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
    });
    const data = await response.json().catch(() => ({})) as { detail?: unknown; text?: string };
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail.slice(0, 300) : "连接器请求失败，请稍后重试");
    return { content: [{ type: "text" as const, text: data.text ?? JSON.stringify(data) }], details: {} };
  };
  return [
    {
      name: "composio_search",
      label: "查找应用动作",
      description: "按用途在已配置的 Composio 连接器里查找第三方应用动作和参数。先搜索，再连接或执行，不要猜测动作名。",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }) }),
      execute: async (_id, args: any, signal) => call("search", { query: args.query }, signal),
    },
    {
      name: "composio_connect",
      label: "连接应用账号",
      description: "为当前用户生成第三方应用的授权链接。把链接交给用户打开；用户完成前不要声称已经连接，也不要索取密码。",
      parameters: Type.Object({ toolkit: Type.String({ minLength: 1, maxLength: 64 }) }),
      execute: async (_id, args: any, signal) => call("connect", { toolkit: args.toolkit }, signal),
    },
    {
      name: "composio_execute",
      label: "执行应用动作",
      description: "执行 composio_search 返回的动作。tool_slug 和 arguments 必须来自搜索结果；未连接时先 composio_connect。",
      parameters: Type.Object({
        tool_slug: Type.String({ minLength: 1, maxLength: 128 }),
        arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      execute: async (_id, args: any, signal) => call("execute", { tool_slug: args.tool_slug, arguments: args.arguments ?? {} }, signal),
    },
  ];
}
