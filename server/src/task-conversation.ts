import { fail, type Row, type Tx } from "./db.js";
import { z } from "zod";

export async function taskMessage(tx: Tx, task: Row, key: string, kind: string, content: string, outgoing = false) {
  if (task.kind !== "delegation" || !content.trim()) return;
  await tx.rows(`INSERT INTO agent_task_messages(task_id,event_key,from_bot_id,to_bot_id,kind,content,created_at)
    VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(task_id,event_key) DO NOTHING`,
    [task.task_id, key, outgoing ? task.parent_bot_id : task.target_bot_id,
      outgoing ? task.target_bot_id : task.parent_bot_id, kind, content]);
}

export async function conversation(tx: Tx, userId: string, botId: string, taskId: string, after = 0, limit = 50) {
  if (!z.string().uuid().safeParse(taskId).success) fail(404, "传话记录不存在");
  const task = await tx.one(`SELECT t.*,coalesce(r.status,t.status) AS status FROM agent_tasks t
    LEFT JOIN bot_runs r ON r.run_id=t.child_run_id WHERE t.task_id=$1 AND t.user_id=$2
    AND t.kind='delegation' AND (t.parent_bot_id=$3 OR t.target_bot_id=$3)`, [taskId, userId, botId]);
  if (!task) fail(404, "传话记录不存在");
  const bots = await tx.rows("SELECT bot_id AS id,name,avatar FROM bots WHERE bot_id=ANY($1) ORDER BY array_position($1::uuid[],bot_id)", [[task!.parent_bot_id, task!.target_bot_id]]);
  const rows = await tx.rows("SELECT * FROM agent_task_messages WHERE task_id=$1 AND seq>$2 ORDER BY seq LIMIT $3", [taskId, after, limit + 1]);
  const entries = rows.slice(0, limit).map(r => ({ id: String(r.seq), seq: r.seq, from_bot_id: r.from_bot_id, to_bot_id: r.to_bot_id, kind: r.kind, content: r.content, created_at: r.created_at }));
  const count = await tx.one("SELECT count(*) AS n FROM agent_task_messages WHERE task_id=$1", [taskId]);
  const device = task!.device_id ? await tx.get("devices",task!.device_id) : null;
  const executionLabel = device?.label ?? (task!.operation_target?.startsWith("remote:") ? "云端机器" : task!.operation_target === "pending" ? "等待调度" : "云端处理");
  return { task_id: taskId, execution_label:executionLabel, operation_target:task!.operation_target, status: task!.status, bots, messages: entries, total: count!.n, has_more: rows.length > limit, next_after: entries.at(-1)?.seq ?? after };
}
