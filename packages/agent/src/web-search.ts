import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Both executors use the same authenticated Server endpoint, never a search-provider key. */
export function webSearchTool(baseUrl: string, token: () => string): ToolDefinition {
  return {
    name: "web_search",
    label: "联网搜索",
    description: "搜索互联网并返回标题、链接和摘要。可指定语言；重要结论请核对原始来源，不要把摘要当作网页全文。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2000 }),
      language: Type.Optional(Type.String({ maxLength: 20 })),
    }),
    execute: async (_id, args: any, signal) => {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/web/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: args.query, language: args.language ?? "auto" }),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { detail?: unknown };
        throw new Error(typeof error.detail === "string" ? error.detail.slice(0, 300) : "联网搜索失败，请稍后重试");
      }
      return { content: [{ type: "text", text: JSON.stringify(await response.json()) }], details: {} };
    },
  };
}
