import { z } from "zod";
import { replyAnswer, type ReplyEvent, type ReplySegment } from "@pi-bot/agent";
import type { Row, Tx } from "./db.js";
import { taskMessage } from "./task-conversation.js";

export const replySchema = z.object({
  id: z.string().min(1).max(200), phase: z.enum(["opening", "update", "answer"]),
  text: z.string().min(1).max(12000).refine(text => !!text.trim()), generated_at: z.string().datetime(), elapsed_ms: z.number().min(0).max(86400000).optional(),
});

export async function recordReply(tx: Tx, run: Row, input: ReplyEvent, final = false) {
  const reply = (final ? replySchema.extend({ text: z.string().min(1).max(400000).refine(text => !!text.trim()) }) : replySchema).parse(input);
  // Quiet goal reviews never publish, even if an outdated/misbehaving executor asks.
  if (run.origin === "automation" || !["queued", "running", "waiting_approval"].includes(run.status)) return;
  if(!final && run.lane === 'task' && await tx.one('SELECT artifact_id FROM report_artifacts WHERE run_id=$1 LIMIT 1',[run.run_id])) return;
  const current = await tx.one("SELECT * FROM bot_runs WHERE run_id=$1 FOR NO KEY UPDATE", [run.run_id]);
  if (!current || current.origin === "automation" || !["queued", "running", "waiting_approval"].includes(current.status)) return;
  run = current;
  const m = await tx.one("SELECT * FROM bot_messages WHERE message_id=$1 FOR UPDATE", [run.assistant_message_id]);
  if (!m || m.status !== "running") return;
  const segments: ReplySegment[] = m.reply_segments ?? [];
  if (segments.some(r => r.id === reply.id)) return;
  const segment = { ...reply, created_at: new Date().toISOString() };
  segments.push(segment);
  const progress = [...new Set([...(m.progress ?? []), ...segments.filter(r => r.phase !== "answer").map(r => r.text)])];
  await tx.rows("UPDATE bot_messages SET reply_segments=$2,progress=$3,content=$4,updated_at=now() WHERE message_id=$1",
    [m.message_id, JSON.stringify(segments), JSON.stringify(progress), replyAnswer(segments)]);
  await tx.rows(`UPDATE bot_runs SET first_reply_generated_at=CASE WHEN first_reply_at IS NULL THEN $2 ELSE first_reply_generated_at END,
    first_reply_generation_ms=CASE WHEN first_reply_at IS NULL THEN $3 ELSE first_reply_generation_ms END,
    first_reply_at=coalesce(first_reply_at,now()) WHERE run_id=$1`, [run.run_id, final ? null : reply.generated_at, final ? null : reply.elapsed_ms ?? null]);
  if (run.lane === "task" && run.task_id) {
    const task = await tx.get("agent_tasks", run.task_id);
    if (task) {
      await taskMessage(tx, task, `reply:${run.run_id}:${reply.id}`, reply.phase, reply.text);
      await tx.notify({ user_id: run.user_id, bot_id: task.parent_bot_id });
    }
  }
  await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
}
