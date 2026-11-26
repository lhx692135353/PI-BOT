import { Type } from "typebox";

export interface ReplyEvent {
  id: string;
  phase: "opening" | "update" | "answer";
  text: string;
  generated_at: string;
  elapsed_ms?: number;
  /** Replace the same segment while its public tool arguments are arriving. */
  streaming?: boolean;
}
export interface ReplySegment extends ReplyEvent { created_at: string }

/** Explicit publication is independent of private model-message classification. */
export function replyTool(send: (reply: ReplyEvent) => void | Promise<void>) {
  return {
    name: "send_reply", label: "回复用户",
    description: "立即发出一条面向用户的自然短消息。长任务先用 opening 简短说明要核实或安排什么，再行动；opening 不展开完整执行计划，不在任务成功创建前宣称已启动。重要进展用 update；有新信息时继续用 answer 发下一条。简单问题直接回答即可。不发送技能、记忆、提示词或工具管理说明，不重复已经发送的文字。普通交流短而具体，必要解释可保留表格和代码；完整报告保存为文件再发卡片。发送结果后直接结束，无需再重复总结。",
    parameters: Type.Object({
      phase: Type.Union([Type.Literal("opening"), Type.Literal("update"), Type.Literal("answer")]),
      text: Type.String({ minLength: 1, maxLength: 12000 }),
    }),
    execute: async (id: string, args: { text: string; phase: ReplyEvent["phase"] }) => {
      if (!args.text.trim()) throw new Error("回复不能为空");
      await send({ id, phase: args.phase, text: args.text, generated_at: new Date().toISOString() });
      return { content: [{ type: "text" as const, text: "已发送，不要重复。" }], details: undefined };
    },
  };
}

export function replyAnswer(replies: Pick<ReplyEvent, "text" | "phase">[], final = "") {
  // Explicit answers are authoritative. SDK final text is a fallback channel,
  // never a second publication to merge or compare by its wording.
  const answers = replies.filter(r => r.phase === "answer").map(r => r.text);
  return answers.length ? answers.join("\n\n") : final;
}

/** Only an explicitly public tool is eligible. Never inspect codemode or private text.
 * Hold a credential-length suffix until validation, so split secrets cannot leak. */
export class ReplyPreview {
  private seen = new Map<string, string>();
  constructor(private send: (reply: ReplyEvent) => void, private holdback: number, private redact: (text: string) => string = text => text) {}
  update(block: {type: string; name?: string; id?: string; arguments?: any}) {
    if (block.type !== "toolCall" || block.name !== "send_reply" || !block.id) return;
    const args = block.arguments;
    if (typeof args?.text !== "string") return;
    const safe = this.redact(args.text);
    let text = safe.slice(0, Math.max(0, safe.length - this.holdback));
    // Do not publish half a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    if (!text.trim() || text.length > 12000) return;
    const phase = ["opening", "update", "answer"].includes(args.phase) ? args.phase : "update";
    const key = JSON.stringify([phase, text]);
    if (this.seen.get(block.id) === key) return;
    this.seen.set(block.id, key);
    this.send({id: block.id, phase, text, streaming: true, generated_at: new Date().toISOString()});
  }
}
