import { resolveTaskTarget, RemotePreparationRequired } from "./targets.js";
import { finishRun } from "./bots.js";
import type { Hub } from "./hub.js";
import type { Row, Tx } from "./db.js";
import type { Settings } from "./config.js";

export const TASK_CONCURRENCY = 2;

/** Lock the bot before the run: all executors share the same capacity checks. */
export async function claimExecution(tx: Tx, id: string, s: Settings, workerId?: string, hub?:Hub): Promise<Row | null> {
  const candidate = await tx.get("bot_runs", id);
  if (!candidate || candidate.status !== "queued" || (workerId && candidate.execution_policy === "device_only" && !candidate.operation_target?.startsWith("remote:"))) return null;
  const bot = await tx.one("SELECT * FROM bots WHERE bot_id=$1 FOR NO KEY UPDATE SKIP LOCKED", [candidate.bot_id]);
  if (!bot || bot.archived_at) return null;
  if (candidate.execution_policy === "device_only" && await tx.one("SELECT 1 FROM bot_runs WHERE bot_id=$1 AND lane='task' AND execution_policy='any' AND status='queued' AND NOT cancel_requested", [candidate.bot_id])) return null;
  const run = await tx.one("SELECT * FROM bot_runs WHERE run_id=$1 AND status='queued' FOR NO KEY UPDATE SKIP LOCKED", [id]);
  if (!run || run.cancel_requested || (workerId ? run.executor !== "cloud" : run.executor !== "device")) return null;
  const { n } = (await tx.one(`SELECT count(*) AS n FROM bot_runs
    WHERE bot_id=$1 AND lane=$2 AND status IN ('running','waiting_approval') AND waiting_on_task_id IS NULL`, [run.bot_id, run.lane]))!;
  if (n >= (run.lane === "conversation" ? 1 : TASK_CONCURRENCY)) return null;
  if (run.lane === "conversation") {
    const first = await tx.one(`SELECT run_id FROM bot_runs WHERE bot_id=$1 AND lane='conversation' AND status='queued'
      ORDER BY (origin='report'), created_at, run_id LIMIT 1`, [run.bot_id]);
    if (first?.run_id !== id) return null;
  }
  if (workerId) {
    // A transaction lock serializes capacity claims made for the same worker.
    await tx.rows("SELECT pg_advisory_xact_lock(hashtext($1))", [workerId]);
    const { n: used } = (await tx.one(`SELECT count(*) AS n FROM bot_runs WHERE worker_id=$1 AND lane=$2
      AND status IN ('running','waiting_approval') AND waiting_on_task_id IS NULL`, [workerId, run.lane]))!;
    if (used >= (run.lane === "conversation" ? s.conversationConcurrency : s.workerConcurrency)) return null;
  }
  if (hub && run.lane === "task" && run.routing) {
    try {
      const location = await resolveTaskTarget(tx,s,hub,run.user_id,bot.slug,run.routing);
      const executor = location.execution === "device" ? "device" : "cloud";
      await tx.update("bot_runs",id,{executor,device_id:location.device_id,operation_target:location.operation_target});
      if (run.task_id) await tx.update("agent_tasks",run.task_id,location);
      await tx.rows("UPDATE bot_messages SET executor=$2 WHERE message_id=$1",[run.assistant_message_id,executor]);
      Object.assign(run,{executor,device_id:location.device_id,operation_target:location.operation_target});
      if (workerId ? executor !== "cloud" : executor !== "device") return null;
    } catch (error) {
      if (error instanceof RemotePreparationRequired) throw error;
      await finishRun(tx,id,"failed",error instanceof Error ? error.message : "没有可用执行资源");
      return null;
    }
  }
  if (run.lane === "task" && run.task_id) await tx.rows("UPDATE agent_tasks SET status='running', updated_at=now() WHERE task_id=$1", [run.task_id]);
  return (await tx.one(`UPDATE bot_runs SET status='running', started_at=coalesce(started_at,now()),
    worker_id=$2, lease_until=$3 WHERE run_id=$1 RETURNING *`,
  [id, workerId ?? null, workerId ? new Date(Date.now() + s.leaseSeconds * 1000) : null]))!;
}

/** A waiting parent resumes only after obtaining a slot, just like a new run. */
export async function resumeExecution(tx: Tx, run: Row, s: Settings): Promise<boolean> {
  if (!run.waiting_on_task_id) return true;
  if (!await tx.one("SELECT bot_id FROM bots WHERE bot_id=$1 FOR NO KEY UPDATE SKIP LOCKED", [run.bot_id])) return false;
  const { n } = (await tx.one(`SELECT count(*) AS n FROM bot_runs WHERE bot_id=$1 AND lane='task'
    AND status IN ('running','waiting_approval') AND waiting_on_task_id IS NULL`, [run.bot_id]))!;
  if (n >= TASK_CONCURRENCY) return false;
  if (run.worker_id) {
    await tx.rows("SELECT pg_advisory_xact_lock(hashtext($1))", [run.worker_id]);
    const { n: used } = (await tx.one(`SELECT count(*) AS n FROM bot_runs WHERE worker_id=$1 AND lane='task'
      AND status IN ('running','waiting_approval') AND waiting_on_task_id IS NULL`, [run.worker_id]))!;
    if (used >= s.workerConcurrency) return false;
  }
  await tx.rows("UPDATE bot_runs SET waiting_on_task_id=NULL WHERE run_id=$1", [run.run_id]);
  return true;
}
