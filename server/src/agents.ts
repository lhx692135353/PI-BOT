import { randomUUID } from "node:crypto";
import { fail, type Database, type Row, type Tx } from "./db.js";
import type { Settings } from "./config.js";
import type { Hub } from "./hub.js";
import type { LlmClaims } from "./security.js";
import { ACTIVE, MAX_DELEGATION_DEPTH, delegationChain, insertRun, resolveModel } from "./bots.js";
import { botConnection, checkDevice } from './devices.js';
import { cancelRun, dispatchDevice } from "./runs.js";
import { AutomationScheduler } from "./automations.js";
import { TASK_CONCURRENCY, resumeExecution } from "./scheduling.js";

export const MAX_TASKS_PER_RUN = 5;
export const TERMINAL = ["completed", "failed", "cancelled"];
/** The live voice call speaks a finished task instead of posting a text report. */
export interface VoiceAnnouncer {
  announce(botId: string, task: Row): boolean;
}

export const agentTaskOut = (t: Row) => ({
  id: t.task_id,
  status: t.status,
  execution: t.execution,
  device_id: t.device_id,
  mode: t.mode,
  kind: t.kind,
  title: t.title,
  activity: t.progress?.at(-1) ?? null,
  tools: (t.tools ?? []).filter((x: Row) => !["skill_manage", "skill_load"].includes(x.name)),
  updated_at: t.activity_at ?? t.updated_at,
  agent: { id: t.target_bot_id, name: t.bot_name ?? "" },
  result: t.result,
  checkpoint: t.checkpoint,
  checkpoint_version: t.checkpoint_version,
  resumed_from: t.resumed_from,
  error: t.error,
  created_at: t.created_at,
  finished_at: t.finished_at,
});

/** The active run a bot-scoped proxy token is acting for. */
export async function callerRun(tx: Tx, userId: string, claims: LlmClaims, runId: string) {
  if (!claims.bot) fail(403, "令牌未绑定智能体");
  const run = await tx.one("SELECT * FROM bot_runs WHERE run_id=$1 FOR NO KEY UPDATE", [runId]);
  if (
    !run ||
    run.user_id !== userId ||
    run.bot_id !== claims.bot ||
    run.executor !== claims.src ||
    (claims.src === "device" && run.device_id !== claims.did) ||
    !ACTIVE.includes(run.status)
  )
    fail(404, "当前运行不存在或已结束");
  return run!;
}
async function ownTask(tx: Tx, userId: string, claims: LlmClaims, taskId: string, lock = false) {
  if (!claims.bot) fail(403, "令牌未绑定智能体");
  const t = await tx.one(
    `SELECT t.*, b.name AS bot_name, m.progress, m.tools, m.updated_at AS activity_at
     FROM agent_tasks t JOIN bots b ON b.bot_id=t.target_bot_id
     LEFT JOIN bot_runs r ON r.run_id=t.child_run_id
     LEFT JOIN bot_messages m ON m.message_id=r.assistant_message_id
     WHERE t.task_id=$1 AND t.user_id=$2 AND (t.parent_bot_id=$3 OR t.target_bot_id=$3)${lock ? " FOR NO KEY UPDATE OF t" : ""}`,
    [taskId, userId, claims.bot],
  );
  if (!t) fail(404, "委托不存在");
  return t!;
}
async function resolveTarget(tx: Tx, userId: string, name: string, selfId: string) {
  const bots = await tx.rows("SELECT * FROM bots WHERE user_id=$1 AND archived_at IS NULL ORDER BY is_main DESC, last_active_at DESC", [userId]);
  const key = name.trim(),
    lower = key.toLowerCase();
  const partial = bots.filter((b) => String(b.name).toLowerCase().includes(lower));
  const found =
    bots.find((b) => b.bot_id === key) ??
    bots.find((b) => String(b.name).toLowerCase() === lower) ??
    (partial.length === 1 ? partial[0] : undefined);
  if (!found) {
    const names = bots.filter((b) => b.bot_id !== selfId).map((b) => b.name);
    fail(404, `找不到智能体「${key}」。可以委托的有：${names.join("、") || "（没有其他智能体）"}`);
  }
  if (found!.bot_id === selfId) fail(422, "不能委托给自己，请直接完成");
  return found!;
}
/** Whether `botId`'s current run is (transitively) blocked waiting for `target`. */
async function waitsFor(tx: Tx, botId: string, target: string, seen = new Set<string>()): Promise<boolean> {
  if (seen.has(botId)) return false;
  seen.add(botId);
  const rows = await tx.rows(
    `SELECT t.target_bot_id FROM agent_tasks t JOIN bot_runs r ON r.run_id=t.parent_run_id
     WHERE r.bot_id=$1 AND r.status = ANY($2) AND t.mode='wait' AND t.status IN ('queued','running')`,
    [botId, ACTIVE],
  );
  for (const r of rows)
    if (r.target_bot_id === target || (await waitsFor(tx, r.target_bot_id, target, seen))) return true;
  return false;
}

export async function createTask(
  tx: Tx,
  hub: Hub,
  userId: string,
  claims: LlmClaims,
  body: { run_id: string; agent?: string; task: string; wait: boolean; kind?: "background" | "delegation"; title?: string; request_id?: string;resumed_from?:string; execution?: "device" | "cloud" },
) {
  const parent = await callerRun(tx, userId, claims, body.run_id);
  if (parent.automation_readonly) fail(403, "自主巡检不能创建任务或委托其他 Bot");
  if (parent.execution_policy === "device_only" && !body.wait) fail(422, "自动工作中的协作必须同步等待，不能另行向用户回报");
  const kind = body.kind ?? "delegation";
  if (body.request_id) {
    const old = await tx.one("SELECT t.*, b.name AS bot_name FROM agent_tasks t JOIN bots b ON b.bot_id=t.target_bot_id WHERE t.parent_run_id=$1 AND t.request_id=$2", [parent.run_id, body.request_id]);
    if (old) return { task: agentTaskOut(old), run: null };
  }
  const { bots, depth } = await delegationChain(tx, parent);
  if (kind === "delegation" && depth >= MAX_DELEGATION_DEPTH) fail(422, "你正在完成多层委托中的任务，不能再委托其他智能体，请自己完成");
  if (kind === "background" && parent.lane !== "conversation") fail(422, "后台任务不能再创建自己的后台任务，请直接完成或委托其他智能体");
  if (parent.lane === "conversation" && body.wait) fail(422, "对话调度不能等待任务，请使用 wait=false");
  if (!body.wait && depth > 0) fail(422, "被委托的任务里只能用 wait=true 同步等待结果");
  const resolved = kind === "background" ? await tx.get("bots", parent.bot_id) : await resolveTarget(tx, userId, body.agent ?? "", parent.bot_id);
  const target = (await tx.one("SELECT * FROM bots WHERE bot_id=$1 FOR NO KEY UPDATE",[resolved.bot_id]))!;
  if (kind === "delegation" && bots.includes(target.bot_id)) fail(422, `「${target.name}」正在等你的结果，不能再委托回去，否则会形成循环`);
  if (body.wait && (await waitsFor(tx, target.bot_id, parent.bot_id)))
    fail(409, `「${target.name}」正在等你完成另一项任务，同步等待会互相卡住${depth === 0 ? "；可以改用 wait=false" : "，请自己完成"}`);
  const { n } = (await tx.one("SELECT count(*) AS n FROM agent_tasks WHERE parent_run_id=$1", [parent.run_id]))!;
  if (n >= MAX_TASKS_PER_RUN) fail(422, `本次任务已委托 ${MAX_TASKS_PER_RUN} 次，达到上限，请自己完成剩余部分`);
  const execution = parent.execution_policy === "device_only" ? "device" : body.execution ?? (kind === "delegation" && !target.execution_device_id ? "cloud" : "device");
  if (execution === "device" && !target.execution_device_id) fail(422, "请先为这个 Bot 绑定执行电脑；纯联网任务可选择云端执行");
  if (execution === "device") await checkDevice(tx, userId, target.execution_device_id);
  const task = await tx.insert("agent_tasks", {
    execution,
    device_id: execution === "device" ? target.execution_device_id : null,
    task_id: randomUUID(),
    user_id: userId,
    parent_run_id: parent.run_id,
    parent_bot_id: parent.bot_id,
    target_bot_id: target.bot_id,
    mode: body.wait ? "wait" : "report",
    kind,
    title: body.title?.trim() || body.task.replace(/\s+/g, " ").slice(0, 80),
    request_id: body.request_id ?? null,
    depth: kind === "background" ? 0 : depth + 1,
    task: body.task,
    status: "queued",
    resumed_from:body.resumed_from??null,
  });
  if (body.wait) await tx.rows("UPDATE bot_runs SET waiting_on_task_id=$2 WHERE run_id=$1", [parent.run_id, task.task_id]);
  const run = await startTask(tx, hub, task);
  const saved = await tx.get("agent_tasks", task.task_id);
  return { task: agentTaskOut({ ...saved, bot_name: target.name }), run };
}

async function failQueued(tx: Tx, task: Row, error: string) {
  await tx.rows(
    "UPDATE agent_tasks SET status='failed', error=$2, finished_at=now() WHERE task_id=$1 AND status='queued'",
    [task.task_id, error],
  );
  await tx.notify({ user_id: task.user_id, bot_id: task.parent_bot_id });
}
/** Starts a queued task on its target if the target is idle; otherwise it stays queued. */
export async function startTask(tx: Tx, hub: Hub, task: Row) {
  if (task.child_run_id) return null;
  const target = await tx.one("SELECT * FROM bots WHERE bot_id=$1 FOR NO KEY UPDATE", [task.target_bot_id]);
  if (!target || target.archived_at) {
    await failQueued(tx, task, "目标智能体已归档");
    return null;
  }
  const { n } = (await tx.one(`SELECT count(*) AS n FROM bot_runs
    WHERE bot_id=$1 AND lane='task' AND status = ANY($2) AND waiting_on_task_id IS NULL
      AND NOT ($3='cloud' AND status='queued' AND executor='device')`, [target.bot_id, ACTIVE, task.execution]))!;
  if (n >= TASK_CONCURRENCY) return null;
  if (!(await resolveModel(tx, target))) {
    await failQueued(tx, task, "管理员尚未配置可用模型");
    return null;
  }
  const conn = hub.device(task.user_id,task.device_id);
  const parent = await tx.get("bot_runs", task.parent_run_id);
  if (parent?.execution_policy === "device_only" && (!conn?.capabilities?.includes("always-on-v1") || parent.cancel_requested || !ACTIVE.includes(parent.status))) return null;
  const run = await insertRun(tx, {
    userId: task.user_id,
    botId: target.bot_id,
    requestId: `task:${task.task_id}`,
    text: task.task,
    computer: task.execution === "device" && conn ? { deviceId: conn.deviceId } : null,
    targetDeviceId: task.execution === "device" ? task.device_id : null,
    origin: "agent",
    taskId: task.task_id,
    fromBotId: task.parent_bot_id,
    lane: "task",
  });
  await tx.rows("UPDATE agent_tasks SET child_run_id=$2, updated_at=now() WHERE task_id=$1", [task.task_id, run.run_id]);
  await tx.notify({ user_id: task.user_id, bot_id: task.parent_bot_id });
  return run;
}

export async function readTask(tx: Tx, userId: string, claims: LlmClaims, taskId: string, s?: Settings, waiting = false) {
  const task = await ownTask(tx, userId, claims, taskId);
  if (waiting && s && TERMINAL.includes(task.status)) {
    const parent = await tx.get("bot_runs", task.parent_run_id);
    if (parent?.waiting_on_task_id === taskId && !await resumeExecution(tx, parent, s))
      return agentTaskOut({ ...task, status: "running", result: null });
  }
  return agentTaskOut(task);
}

export async function listTasks(tx: Tx, userId: string, claims: LlmClaims, runId: string) {
  await callerRun(tx, userId, claims, runId);
  const rows = await tx.rows(`SELECT t.*, b.name AS bot_name, m.progress, m.tools, m.updated_at AS activity_at
    FROM agent_tasks t JOIN bots b ON b.bot_id=t.target_bot_id
    LEFT JOIN bot_runs r ON r.run_id=t.child_run_id
    LEFT JOIN bot_messages m ON m.message_id=r.assistant_message_id
    WHERE t.user_id=$1 AND (t.parent_bot_id=$2 OR t.target_bot_id=$2) ORDER BY (t.status IN ('running','waiting_approval')) DESC, (t.status='queued') DESC, t.created_at DESC LIMIT 30`, [userId, claims.bot]);
  return { tasks: rows.map(agentTaskOut) };
}

export async function messageTask(tx: Tx, userId: string, claims: LlmClaims, taskId: string, body: { run_id: string; text: string; request_id: string }) {
  await callerRun(tx, userId, claims, body.run_id);
  const task = await ownTask(tx, userId, claims, taskId, true);
  if (TERMINAL.includes(task.status)) return { task: agentTaskOut(task), delivery: "finished" };
  await tx.rows(`INSERT INTO agent_task_instructions(instruction_id,task_id,request_id,text)
    VALUES($1,$2,$3,$4) ON CONFLICT(task_id,request_id) DO NOTHING`, [randomUUID(), taskId, body.request_id, body.text]);
  await tx.notify({ user_id: userId, bot_id: task.target_bot_id });
  return { task: agentTaskOut(task), delivery: task.child_run_id ? "pending" : "queued" };
}
/** The delegating tool gave up (its run stopped); nothing is reported back afterwards. */
export async function cancelTask(tx: Tx, hub: Hub, userId: string, claims: LlmClaims, taskId: string) {
  const snapshot = await ownTask(tx, userId, claims, taskId);
  // Match finishRun's lock order: run first, then its task row.
  if (snapshot.child_run_id) await tx.one("SELECT run_id FROM bot_runs WHERE run_id=$1 FOR NO KEY UPDATE", [snapshot.child_run_id]);
  const t = await ownTask(tx, userId, claims, taskId, true);
  if (t.child_run_id !== snapshot.child_run_id) fail(409, "任务刚刚启动，请重新取消");
  let notify: { runId: string; send(m: Row): void } | null = null;
  if (t.status === "queued" && !t.child_run_id)
    await tx.rows("UPDATE agent_tasks SET status='cancelled', finished_at=now() WHERE task_id=$1", [taskId]);
  else if (["queued", "running", "waiting_approval"].includes(t.status) && t.child_run_id) {
    const r = await cancelRun(tx, hub, userId, t.child_run_id);
    if (r.notify) notify = { runId: t.child_run_id, send: (m) => r.notify!.send(m) };
  }
  await tx.notify({ user_id: userId, bot_id: t.parent_bot_id });
  return { task: agentTaskOut(await ownTask(tx, userId, claims, taskId)), notify };
}
/** A synchronous wait that ran too long becomes a hand-off reported back later. */
export async function reportLater(tx: Tx, userId: string, claims: LlmClaims, taskId: string, s: Settings) {
  const t = await ownTask(tx, userId, claims, taskId, true);
  const parent = await tx.get("bot_runs", t.parent_run_id);
  if (parent?.execution_policy === "device_only") fail(422, "自动工作中的协作只能返回本轮，不能改为公开回报");
  if (TERMINAL.includes(t.status) || t.mode === "report") {
    if (parent?.waiting_on_task_id && !await resumeExecution(tx, parent, s)) fail(409, "等待执行名额后继续");
    return agentTaskOut(t);
  }
  if (!parent || (await delegationChain(tx, parent)).depth > 0) fail(422, "被委托的任务里只能同步等待结果");
  if (parent.waiting_on_task_id && !await resumeExecution(tx, parent, s)) fail(409, "等待执行名额后继续");
  await tx.rows("UPDATE agent_tasks SET mode='report' WHERE task_id=$1", [taskId]);
  return agentTaskOut({ ...t, mode: "report" });
}

function reportText(t: Row) {
  const task = t.task.length > 500 ? `${t.task.slice(0, 499)}…` : t.task;
  if (t.status === "completed")
    return `「${t.bot_name}」完成了你委托的任务。\n\n任务：${task}\n\n结果：\n${String(t.result || "（没有文字结果）").slice(0, 20000)}`;
  if (t.status === "failed") return `「${t.bot_name}」没能完成你委托的任务：${t.error ?? "运行失败"}\n\n任务：${task}`;
  return `「${t.bot_name}」的任务已被取消。\n\n任务：${task}`;
}

/**
 * Lives in the API process because only it holds the device sockets. Starts queued
 * tasks once their target is idle, reports finished hand-offs back to the
 * delegating bot, and forwards cascaded cancels to the device.
 */
export class AgentDispatcher {
  private timer?: NodeJS.Timeout;
  private pending?: NodeJS.Timeout;
  private cycle?: Promise<void>;
  private again = false;
  private stopped = false;
  private cancelSent = new Set<string>();
  private announcer?: VoiceAnnouncer;
  constructor(
    private db: Database,
    private s: Settings,
    private hub: Hub,
    private intervalMs = 5000,
  ) {}
  setAnnouncer(announcer: VoiceAnnouncer) { this.announcer = announcer; }
  start() {
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.kick();
  }
  /** Coalesces bursts of change notifications into one pass. */
  kick() {
    if (this.stopped || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.run();
    }, 100);
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.pending);
    await this.cycle;
  }
  private run() {
    if (this.cycle) return void (this.again = true);
    this.cycle = this.once()
      .catch(() => console.error("agent dispatch failed"))
      .finally(() => {
        this.cycle = undefined;
        if (this.again && !this.stopped) {
          this.again = false;
          this.run();
        }
      });
  }
  async once() {
    await this.dispatchConversations();
    await this.startQueued();
    await this.deliverReports();
    await Promise.all([this.forwardCancels(), this.forwardInstructions()]);
    await new AutomationScheduler(this.db, this.s, this.hub).once();
  }
  private async startQueued() {
    const queued = await this.db.tx((tx) =>
      tx.rows(
        `SELECT t.task_id FROM agent_tasks t WHERE t.status='queued' AND t.child_run_id IS NULL
         AND (SELECT count(*) FROM bot_runs r WHERE r.bot_id=t.target_bot_id AND r.lane='task' AND r.status = ANY($1) AND r.waiting_on_task_id IS NULL
           AND NOT (t.execution='cloud' AND r.status='queued' AND r.executor='device'))<2
         ORDER BY t.created_at LIMIT 20`,
        [ACTIVE],
      ),
    );
    for (const { task_id } of queued) {
      if (this.stopped) return;
      try {
        const run = await this.db.tx(async (tx) => {
          const t = await tx.one("SELECT * FROM agent_tasks WHERE task_id=$1 AND status='queued' FOR NO KEY UPDATE SKIP LOCKED", [task_id]);
          return t ? startTask(tx, this.hub, t) : null;
        });
        if (run?.executor === "device") await dispatchDevice(this.db, this.s, this.hub, run.run_id);
      } catch {
        console.error("agent task start failed");
      }
    }
  }
  private async deliverReports() {
    const finished = await this.db.tx((tx) =>
      tx.rows(
        `SELECT t.task_id FROM agent_tasks t
         WHERE t.mode='report' AND t.delivered_at IS NULL AND t.status IN ('completed','failed','cancelled')
           AND NOT EXISTS (SELECT 1 FROM bot_runs p WHERE p.run_id=t.parent_run_id AND p.execution_policy='device_only')
           AND NOT EXISTS (SELECT 1 FROM bot_runs r WHERE r.bot_id=t.parent_bot_id AND r.lane='conversation' AND r.status = ANY($1) AND r.origin<>'voice')
         ORDER BY t.finished_at LIMIT 20`,
        [ACTIVE],
      ),
    );
    for (const { task_id } of finished) {
      if (this.stopped) return;
      try {
        const run = await this.db.tx(async (tx) => {
          const t = await tx.one(
            `SELECT t.*, b.name AS bot_name FROM agent_tasks t JOIN bots b ON b.bot_id=t.target_bot_id
             WHERE t.task_id=$1 AND t.delivered_at IS NULL FOR NO KEY UPDATE OF t SKIP LOCKED`,
            [task_id],
          );
          if (!t) return null;
          const bot = await tx.one("SELECT * FROM bots WHERE bot_id=$1 FOR NO KEY UPDATE", [t.parent_bot_id]);
          if (!bot || bot.archived_at) {
            await tx.rows("UPDATE agent_tasks SET delivered_at=now() WHERE task_id=$1", [task_id]);
            return null;
          }
          const activeConversation = await tx.one("SELECT origin FROM bot_runs WHERE bot_id=$1 AND lane='conversation' AND status = ANY($2)", [bot.bot_id, ACTIVE]);
          if (activeConversation?.origin === "voice") {
            this.announcer?.announce(bot.bot_id, t);
            return null;
          }
          if (activeConversation) return null;
          if (!(await resolveModel(tx, bot))) return null;
          await tx.rows("UPDATE agent_tasks SET delivered_at=now() WHERE task_id=$1", [task_id]);
          const conn = await botConnection(tx,this.hub,t.user_id,bot.bot_id);
          const report = await insertRun(tx, {
            userId: t.user_id,
            botId: bot.bot_id,
            requestId: `report:${t.task_id}`,
            text: reportText(t),
            computer: conn ? { deviceId: conn.deviceId } : null,
            origin: "report",
            taskId: t.task_id,
            fromBotId: t.kind === "background" ? undefined : t.target_bot_id,
          });
          await tx.rows("UPDATE agent_tasks SET report_run_id=$2 WHERE task_id=$1", [task_id, report.run_id]);
          if (t.child_run_id) {
            const output = await tx.one("SELECT m.ui FROM bot_messages m JOIN bot_runs r ON r.assistant_message_id=m.message_id WHERE r.run_id=$1", [t.child_run_id]);
            if (output?.ui) await tx.update("bot_messages", report.assistant_message_id, { ui: output.ui });
          }
          return report;
        });
        if (run?.executor === "device") await dispatchDevice(this.db, this.s, this.hub, run.run_id);
      } catch {
        console.error("agent report delivery failed");
      }
    }
  }
  private async forwardCancels() {
    const runs = await this.db.tx((tx) =>
      tx.rows(
        "SELECT run_id, user_id, device_id, executor FROM bot_runs WHERE cancel_requested AND origin='agent' AND status = ANY($1)",
        [ACTIVE],
      ),
    );
    const live = new Set(runs.map((r) => r.run_id));
    for (const id of this.cancelSent) if (!live.has(id)) this.cancelSent.delete(id);
    await Promise.all(runs.map(async r => {
      if (this.cancelSent.has(r.run_id)) return;
      if (r.executor === "cloud") {
        try {
          const response = await fetch(`${this.s.runnerUrl}/runs/${r.run_id}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${this.s.runnerToken}` }, signal: AbortSignal.timeout(5000) });
          if (response.ok) this.cancelSent.add(r.run_id);
        } catch { /* Retry on the next pass. */ }
        return;
      }
      const conn = this.hub.device(r.user_id,r.device_id);
      if (!conn || conn.deviceId !== r.device_id) return;
      conn.send({ type: "cancel", run_id: r.run_id });
      this.cancelSent.add(r.run_id);
    }));
  }

  private async dispatchConversations() {
    const runs = await this.db.tx(tx => tx.rows("SELECT run_id FROM bot_runs WHERE executor='device' AND status='queued' ORDER BY (execution_policy='device_only'), (origin='report'), created_at LIMIT 100"));
    for (const r of runs) await dispatchDevice(this.db, this.s, this.hub, r.run_id).catch(() => {});
  }
  private async forwardInstructions() {
    const pending = await this.db.tx(tx => tx.rows(`SELECT i.*, r.run_id, r.executor, r.device_id, r.user_id
      FROM agent_task_instructions i JOIN agent_tasks t USING(task_id)
      JOIN bot_runs r ON r.run_id=t.child_run_id
      WHERE i.delivered_at IS NULL AND r.status IN ('running','waiting_approval') AND NOT r.cancel_requested
      ORDER BY i.created_at LIMIT 100`));
    const byRun = new Map<string, Row[]>();
    for (const i of pending) byRun.set(i.run_id, [...byRun.get(i.run_id) ?? [], i]);
    // Preserve each run's instruction order without blocking other runs on a failed transport.
    await Promise.all([...byRun.values()].map(async instructions => {
      for (const i of instructions) {
        if (i.executor === "device") {
          const conn = this.hub.device(i.user_id,i.device_id);
          if (!conn || conn.deviceId !== i.device_id) return;
          conn.send({ type: "task_message", run_id: i.run_id, instruction_id: i.instruction_id, text: i.text });
        } else {
          try {
            const response = await fetch(`${this.s.runnerUrl}/runs/${i.run_id}/messages`, {
              method: "POST", headers: { Authorization: `Bearer ${this.s.runnerToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ id: i.instruction_id, text: i.text }), signal: AbortSignal.timeout(5000),
            });
            if (!response.ok) return;
            await this.db.tx(tx => tx.rows("UPDATE agent_task_instructions SET delivered_at=now() WHERE instruction_id=$1", [i.instruction_id]));
          } catch { return; /* Retry the durable inbox on the next pass. */ }
        }
      }
    }));
  }
}
