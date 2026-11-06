import { CONTEXT_DEFAULTS } from "@pi-bot/runtime-contracts";
import type { ContextEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";

type Message = ContextEvent["messages"][number];

const WIDE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
/** CJK text costs about one token per character, several times the generic chars/4 estimate. */
export function textTokens(text: string) {
  const wide = text.match(WIDE)?.length ?? 0;
  return wide + Math.ceil((text.length - wide) / 4);
}

export function clipText(text: string, limit: number, hint: string) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.75);
  return `${text.slice(0, head)}\n…（中间省略 ${text.length - limit} 字。${hint}）…\n${text.slice(text.length - (limit - head))}`;
}

const TOOL_RESULT_HINT = "需要省略部分时按范围重新读取，例如 offset/limit、grep 或 head/tail";
const IMAGE_TOKENS = 1000;

function messageTokens(m: Message): number {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return textTokens(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce((n: number, c: any) => n + (
    c.type === "text" ? textTokens(c.text ?? "")
      : c.type === "thinking" ? textTokens(c.thinkingSignature ?? c.thinking ?? "")
        : c.type === "toolCall" ? textTokens(JSON.stringify(c.arguments ?? {}))
          : c.type === "image" ? IMAGE_TOKENS : 0), 0);
}

const resultText = (m: Message) =>
  ((m as any).content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");

/**
 * Pi only compacts after a run settles, so a long tool loop resends everything it has
 * seen on every call. Replayed reasoning and stale tool output dominate that growth.
 */
export function budgetContext(messages: Message[], omitted: Set<string>, budget: number = CONTEXT_DEFAULTS.runTokens): Message[] {
  const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
  let out = messages.flatMap((m, i): Message[] => {
    if (m.role !== "assistant" || i === lastAssistant || !m.content.some((c) => c.type === "thinking")) return [m];
    const content = m.content.filter((c) => c.type !== "thinking");
    return content.length ? [{ ...m, content }] : [];
  });
  const stub = (m: Message): Message => ({
    ...(m as any),
    content: [{ type: "text", text: `[为控制上下文，已省略这条较早的工具结果（${(m as any).toolName}，约 ${resultText(m).length} 字）。需要时重新调用工具获取。]` }],
  });
  out = out.map((m) => (m.role === "toolResult" && omitted.has(m.toolCallId) ? stub(m) : m));
  let total = out.reduce((n, m) => n + messageTokens(m), 0);
  if (total <= budget) return out;
  const results = out.flatMap((m, i) => (m.role === "toolResult" ? [i] : []));
  // Stop well below the trigger so one omission round keeps the cached prefix stable for several calls.
  for (const i of results.slice(0, Math.max(0, results.length - CONTEXT_DEFAULTS.keepToolResults))) {
    if (total <= budget * 0.6) break;
    const m = out[i];
    if (m.role !== "toolResult" || omitted.has(m.toolCallId)) continue;
    const before = messageTokens(m);
    if (before < 200) continue;
    out[i] = stub(m);
    omitted.add(m.toolCallId);
    total -= before - messageTokens(out[i]);
  }
  return out;
}

export function contextBudgetExtension(): ExtensionFactory {
  return (pi) => {
    const omitted = new Set<string>();
    pi.on("tool_result", (e) => {
      if (!e.content.some((c) => c.type === "text" && c.text.length > CONTEXT_DEFAULTS.toolResultChars)) return;
      return {
        content: e.content.map((c) =>
          c.type === "text" ? { ...c, text: clipText(c.text, CONTEXT_DEFAULTS.toolResultChars, TOOL_RESULT_HINT) } : c),
      };
    });
    pi.on("context", (e) => ({ messages: budgetContext(e.messages, omitted) }));
  };
}
