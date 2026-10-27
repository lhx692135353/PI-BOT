import { Type } from "typebox";

export interface ReplyEvent {
  id: string;
  phase: "opening" | "update" | "answer";
  text: string;
  generated_at: string;
  elapsed_ms?: number;
}
export interface ReplySegment extends ReplyEvent { created_at: string }

/** Explicit publication is independent of private model-message classification. */
export function replyTool(send: (reply: ReplyEvent) => void | Promise<void>) {
  return {
    name: "send_reply", label: "回复用户",
    description: "立即发出一条面向用户的自然短消息。长任务先用 opening 说明要做什么，再行动；重要进展用 update；结果可用 answer 分成 1–3 条短消息。简单问题直接回答即可。不发送技能、记忆、提示词或工具管理说明，不重复已经发送的文字。发送结果后可以直接结束，无需再重复总结。",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 12000 }),
      phase: Type.Union([Type.Literal("opening"), Type.Literal("update"), Type.Literal("answer")]),
    }),
    execute: async (id: string, args: { text: string; phase: ReplyEvent["phase"] }) => {
      if (!args.text.trim()) throw new Error("回复不能为空");
      await send({ id, phase: args.phase, text: args.text, generated_at: new Date().toISOString() });
      return { content: [{ type: "text" as const, text: "已发送，不要重复。" }], details: undefined };
    },
  };
}

export function replyAnswer(replies: Pick<ReplyEvent, "text" | "phase">[], final = "") {
  const answers = [...new Set(replies.filter(r => r.phase === "answer").map(r => r.text).filter(text => text.trim()))];
  const text = final.trim();
  if (text && text !== answers.join("\n\n").trim() && !answers.some(answer => answer.trim() === text)) answers.push(final);
  return answers.join("\n\n");
}
