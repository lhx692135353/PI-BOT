import { errorInfo } from "@pi-bot/runtime-contracts";
import { approvalScope, rememberAuthorization, authorizationLog } from './authorizations.js';
import { taskMessage } from "./task-conversation.js";
import { recordReply, replySchema } from "./replies.js";
import { randomUUID } from "node:crypto";
import { enqueueApproval } from "./push.js";
import { z } from "zod";
import { fail, type Database, type Row, type Tx } from "./db.js";
import type { Settings } from "./config.js";
import type { DeviceConnection, Hub } from "./hub.js";
import { CLI_OFFLINE, isCliRuntime } from "./cli.js";
import {
  ACTIVE,
  approvalOut,
  buildContext,
  finishRun,
  markRunning,
  recordTool,
  setContent,
  setProgress,
} from "./bots.js";

import { claimExecution } from "./scheduling.js";
import {recordUi} from "./ui.js";
import { observationSchema, recordObservation } from "./observations.js";
import { browserTestOrigin } from "./targets.js";
import { PROGRESS_CHARS, PROGRESS_SEGMENTS } from "@pi-bot/agent";

export const DEVICE_OFFLINE = "执行电脑已离线，本次运行已中断；请核实结果后重新安排任务";
export const SERVER_RESTARTED = "SERVER_RESTARTED：服务端重启，之前的电脑任务已中断；这不代表电脑当前离线，请核实结果和实时连接后重新安排";
export const DEVICE_CONNECTION_REPLACED = "DEVICE_CONNECTION_REPLACED：电脑连接被新连接替换，本次运行已中断；请核实结果，不要自动重放未知操作";

/** Recheck queued strategies before claiming; running and legacy task destinations stay fixed. */
export async function dispatchDevice(db: Database, s: Settings, hub: Hub, runId: string) {
  const job = await db.tx(async (tx) => {
    const run = await tx.one("SELECT * FROM bot_runs WHERE run_id=$1 FOR NO KEY UPDATE SKIP LOCKED", [runId]);
    if (!run || run.status !== "queued" || run.executor !== "device") return null;
    const conn = hub.device(run.user_id,run.device_id);
    const bot = await tx.get("bots", run.bot_id);
    if (isCliRuntime(bot?.runtime) && !conn) {
      await finishRun(tx, runId, "failed", CLI_OFFLINE, CLI_OFFLINE);
      return null;
    }
    if (run.execution_policy === "device_only") {
      if (!run.routing && !conn?.capabilities?.includes("always-on-v1")) return null;
      await tx.rows("UPDATE bot_automations SET status='enabled' WHERE automation_id=$1 AND status='waiting_device'", [run.automation_id]);
      await tx.rows("UPDATE bot_runs SET deadline_at=$2 WHERE run_id=$1", [runId, new Date(Date.now() + s.automationRoundSeconds * 1000)]);
    }
    if (!conn && !run.routing) {
      await finishRun(tx,runId,"failed",DEVICE_OFFLINE,DEVICE_OFFLINE);
      return null;
    }
    const claimed = await claimExecution(tx, runId, s,undefined,hub);
    if (!claimed) return null;
    await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
    const selected = hub.device(claimed.user_id, claimed.device_id);
    const context = await buildContext(tx, s, claimed);
    if (context.browser_test_authorization && selected?.capabilities?.includes("browser-test-handoff-v1")) context.browser_test_handoff = true;
    if (selected) await tx.rows("UPDATE bot_runs SET dispatched_at=clock_timestamp() WHERE run_id=$1", [runId]);
    return { conn: selected, context };
  });
  job?.conn?.send({ type: "run", run: job.context });
}

const live = new Map<string, { content: string; written: number }>();
const runEvent = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("manifest"),tools:z.array(z.string().max(100)).max(200)}),
  observationSchema.extend({kind:z.literal('observation')}),
  z.object({ kind: z.literal("started") }),
  z.object({ kind: z.literal("received"), at: z.string().datetime() }),
  z.object({ kind: z.literal("resource_wait"), id: z.string().max(160), reason: z.enum(['host_shell','file_resource','desktop_input']) }),
  z.object({ kind: z.literal("resource_clear"), id: z.string().max(160) }),
  z.object({ kind: z.literal("tool_started"), id: z.string().max(160), at: z.string().datetime() }),
  replySchema.extend({ kind: z.literal("reply") }),
  z.object({ kind: z.literal("instruction_ack"), id: z.string().uuid() }),
  z.object({ kind: z.literal("ui"), messages: z.array(z.record(z.string(),z.unknown())).min(1).max(20) }),
  z.object({ kind: z.literal("text"), text: z.string().max(400000) }),
  z.object({ kind: z.literal("progress"), lines: z.array(z.string().max(PROGRESS_CHARS)).max(PROGRESS_SEGMENTS) }),
  z.object({
    kind: z.literal("tool"),
    id: z.string().max(80),
    name: z.string().max(80),
    state: z.enum(["running", "completed", "failed"]),
    summary: z.string().max(2000).optional(),
    observed_path:z.string().min(1).max(2000).optional(),resource_id:z.string().max(200).optional(),target_id:z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal("approval"),
    request_id: z.string().max(80),
    path: z.string().min(1).max(4000),
    reason: z.string().max(2000),
    access: z.enum(['read','write','execute']).optional(),
    resource_type: z.enum(['file','directory']).optional(),
  }),
  z.object({
    kind: z.literal("browser_approval"),
    request_id: z.string().max(80),
    origins: z.array(z.string().max(2048)).min(1).max(8),
  }),
  z.object({
    kind: z.literal("browser_login"),
    request_id: z.string().max(80),
    origin: z.string().max(2048),
  }),
  z.object({
    kind: z.literal("electron_launch"),
    request_id: z.string().max(80),
    path: z.string().min(1).max(4000),
    reason: z.string().max(4000),
  }),
  z.object({
    kind: z.literal("electron_login"),
    request_id: z.string().max(80),
  }),
  z.object({
    kind: z.literal("done"),
    state: z.enum(["completed", "failed", "cancelled"]),
    error: z.string().max(500).nullish(),
    error_info:z.unknown().optional(),
    text: z.string().max(400000).optional(),
  }),
]);

export async function handleRunEvent(
  db: Database,
  s: Settings,
  hub: Hub,
  conn: DeviceConnection,
  message: Row,
) {
  const parsed = runEvent.safeParse(message.event);
  if (!parsed.success || typeof message.run_id !== "string") return;
  const e = parsed.data,
    runId = message.run_id;
  const own = async (tx: Tx) => {
    if (!await tx.one("SELECT 1 FROM devices WHERE device_id=$1 AND user_id=$2 AND revoked_at IS NULL AND key_version=$3 FOR SHARE",[conn.deviceId,conn.userId,conn.keyVersion??0])) return undefined;
    return tx.one("SELECT * FROM bot_runs WHERE run_id=$1 AND device_id=$2 AND executor='device'",[runId,conn.deviceId]);
  };
  if (e.kind === "text") {
    const state = live.get(runId) ?? { content: "", written: 0 };
    state.content = e.text;
    live.set(runId, state);
    const run = await db.tx(async (tx) => {
      const r = await own(tx);
      if (!r || !ACTIVE.includes(r.status)) return null;
      if (Date.now() - state.written > 1000) {
        state.written = Date.now();
        await setContent(tx, r, e.text);
      }
      return r;
    });
    if (!run) live.delete(runId);
    return;
  }
  if (e.kind === "instruction_ack") {
    await db.tx(async tx => {
      const r = await own(tx);
      if (r?.task_id) await tx.rows("UPDATE agent_task_instructions SET delivered_at=now() WHERE task_id=$1 AND instruction_id=$2", [r.task_id, e.id]);
    });
    return;
  }
  if(e.kind==='observation'){
    const {kind,...observation}=e;
    await db.tx(async tx=>{const run=await own(tx);if(run)await recordObservation(tx,run,observation,s.tracingEnabled);}).catch(()=>{});return;
  }
  if (e.kind === "done") {
    const content = e.text ?? live.get(runId)?.content;
    live.delete(runId);
    await db.tx(async (tx) => {
      if (!(await own(tx))) return;
      await finishRun(tx, runId, e.state, e.error ?? "电脑运行失败", content,new Date(),errorInfo(e));
    });
    return;
  }
  const reply = await db.tx(async (tx) => {
    const run = await own(tx);
    if (!run || !ACTIVE.includes(run.status)) return null;
    if (e.kind === 'received') {
      await tx.rows('UPDATE bot_runs SET device_received_at=coalesce(device_received_at,$2::timestamptz) WHERE run_id=$1', [runId,e.at]);
      await tx.notify({user_id:run.user_id,bot_id:run.bot_id});
      return null;
    }
    if (e.kind === 'resource_wait' || e.kind === 'resource_clear' || e.kind === 'tool_started') {
      if (e.kind === 'resource_wait') await tx.rows("UPDATE bot_runs SET resource_waits=resource_waits || jsonb_build_object($2::text,$3::text) WHERE run_id=$1", [runId,e.id,e.reason]);
      else if (e.kind === 'tool_started') await tx.rows("UPDATE bot_runs SET first_tool_started_at=coalesce(first_tool_started_at,$3::timestamptz), resource_waits=resource_waits - $2::text WHERE run_id=$1", [runId,e.id,e.at]);
      else await tx.rows("UPDATE bot_runs SET resource_waits=resource_waits - $2::text WHERE run_id=$1", [runId,e.id]);
      await tx.notify({user_id:run.user_id,bot_id:run.bot_id});
      return null;
    }
    if (e.kind === "started") {
      await markRunning(tx, runId);
      await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
      return null;
    }
    if (e.kind === "manifest") { await tx.rows("UPDATE bot_runs SET tool_manifest=$2 WHERE run_id=$1",[run.run_id,JSON.stringify(e.tools)]);return null; }
    if (e.kind === "reply") { await recordReply(tx, run, e); return null; }
    if (e.kind === "ui") { await recordUi(tx,run,e.messages); return null; }
    if (e.kind === "tool") {
      await recordTool(tx, run, e);
      await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
      return null;
    }
    if (e.kind === "progress") {
      live.delete(runId);
      await setProgress(tx, run, e.lines);
      await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
      return null;
    }
    if (run.automation_readonly || run.cancel_requested) return null;
    const browser = e.kind === "browser_approval" || e.kind === "browser_login" || e.kind === "electron_login";
    let detail: Row;
    if (e.kind === "electron_login") {
      if (run.lane !== "task" || !run.routing?.electron_test || !conn.capabilities?.includes("electron-test-v1")) return null;
      const device = await tx.get("devices", run.device_id);
      detail = { path: "Electron 应用测试窗口", origins: [], access: "browser", target_label: device?.label ?? "执行电脑",
        handoff: true, reason: "请在执行电脑的独立应用窗口完成操作，完成后回聊天继续。" };
    } else if (e.kind === "electron_launch") {
      if (run.lane !== "task" || !run.routing?.electron_test || !conn.capabilities?.includes("electron-test-v1")) return null;
      detail = { path: e.path, reason: e.reason, access: "execute", single_use: true,
        authorization_scope: await approvalScope(tx, run, e.path, "execute", "file") };
    } else if (browser) {
      if (!run.routing?.browser_test_authorization || run.lane !== "task") return null;
      const handoff = e.kind === "browser_login";
      if (handoff && !conn.capabilities?.includes("browser-test-handoff-v1")) return null;
      const origins = handoff ? [e.origin] : [...new Set(e.origins)];
      if (origins.some(origin => browserTestOrigin(origin) !== origin)) return null;
      const device = await tx.get("devices", run.device_id);
      detail = {
        path: origins.join("\n"), origins, access: "browser", target_label: device?.label ?? "执行电脑",
        handoff,
        reason: handoff ? "请在执行电脑上的测试窗口完成登录。遇到问题也可以返回聊天继续处理。" : "本次 Web 测试需要访问这些站点",
      };
    } else {
      detail = { path: e.path, reason: e.reason, access: e.access ?? 'legacy',
        authorization_scope: await approvalScope(tx, run, e.path, e.access ?? 'legacy', e.resource_type ?? 'unknown') };
    }
    const approval = await tx.insert("approvals", {
      approval_id: randomUUID(),
      run_id: runId,
      bot_id: run.bot_id,
      user_id: run.user_id,
      kind: browser ? "browser_access" : "outside_access",
      detail,
      status: "pending",
      expires_at: new Date(Date.now() + s.approvalTtl * 1000),
    });
    await enqueueApproval(tx, approval);
    await tx.rows(
      "UPDATE bot_runs SET status='waiting_approval' WHERE run_id=$1 AND status='running'",
      [runId],
    );
    if (run.task_id) await tx.rows("UPDATE agent_tasks SET status='waiting_approval', updated_at=now() WHERE task_id=$1", [run.task_id]);
    await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
    return {
      type: "approval_created",
      run_id: runId,
      request_id: e.request_id,
      approval_id: approval.approval_id,
      expires_at: approval.expires_at,
    };
  });
  if (reply) conn.send(reply);
}

export async function failDeviceRuns(db: Database, deviceId: string, reason = DEVICE_OFFLINE, keepQueued = true) {
  await db.tx(async (tx) => {
    {
      const tasks = await tx.rows(`UPDATE agent_tasks SET status='failed',error=$2,finished_at=now(),updated_at=now()
        WHERE (device_id=$1 OR routing->>'device_id'=($1::uuid)::text OR coalesce(routing->'resources','[]'::jsonb) @> jsonb_build_array(jsonb_build_object('target','device:'||($1::uuid)::text))) AND status='queued' AND child_run_id IS NULL RETURNING *`, [deviceId, reason]);
      for (const t of tasks) {
        await taskMessage(tx, t, "terminal", "error", reason);
        await tx.notify({user_id:t.user_id,bot_id:t.parent_bot_id});
        await tx.notify({user_id:t.user_id,bot_id:t.target_bot_id});
      }
    }
    const runs = await tx.rows(
      "SELECT run_id FROM bot_runs WHERE executor='device' AND device_id=$1 AND status = ANY($2)",
      [deviceId, ACTIVE],
    );


    for (const r of runs) {
      const current = await tx.get("bot_runs", r.run_id);
      if (current?.executor !== "device") continue;
      live.delete(r.run_id);

      if (keepQueued && current.status === "queued" && current.execution_policy === "device_only") {
        await tx.rows("UPDATE bot_automations SET status='waiting_device' WHERE automation_id=$1 AND status='enabled'", [current.automation_id]);
        continue;
      }
      await finishRun(tx, r.run_id, "failed", current.execution_policy === "device_only" ? "AUTOMATION_DEVICE_OFFLINE" : reason);
    }
  });
}
/** Preserve queued local work after a restart, and fail interrupted device runs. */
export async function failOrphanedDeviceRuns(db: Database) {
  await db.tx(async (tx) => {
    const tasks=await tx.rows("UPDATE agent_tasks SET status='failed',error=$1,finished_at=now(),updated_at=now() WHERE execution='device' AND status='queued' AND child_run_id IS NULL RETURNING *",[SERVER_RESTARTED]);
    for(const task of tasks){await taskMessage(tx,task,"terminal","error",SERVER_RESTARTED);await tx.notify({user_id:task.user_id,bot_id:task.parent_bot_id});}

    const runs = await tx.rows(
      "SELECT run_id FROM bot_runs WHERE executor='device' AND status = ANY($1)",
      [ACTIVE],
    );


    for (const r of runs) {
      const current = await tx.get("bot_runs", r.run_id);
      if (current?.executor === "device") {
        if (current.status === "queued" && current.execution_policy === "device_only") {
          await tx.rows("UPDATE bot_automations SET status='waiting_device' WHERE automation_id=$1 AND status='enabled'", [current.automation_id]);
          continue;
        }
        await finishRun(tx, r.run_id, "failed", current.execution_policy === "device_only" ? "AUTOMATION_DEVICE_OFFLINE" : SERVER_RESTARTED);
      }
    }
  });
}

export async function cancelRun(tx: Tx, hub: Hub, userId: string, runId: string) {
  const run = await tx.one(
    "SELECT * FROM bot_runs WHERE run_id=$1 AND user_id=$2 FOR UPDATE",
    [runId, userId],
  );
  if (!run) fail(404, "运行不存在");
  if (!ACTIVE.includes(run!.status)) return { run: run!, notify: null };
  await tx.rows("UPDATE bot_runs SET cancel_requested=true WHERE run_id=$1", [runId]);
  if (run!.status === "queued") {
    await finishRun(tx, runId, "cancelled", null);
    return { run: { ...run!, status: "cancelled" }, notify: null };
  }
  const conn = run!.executor === "device" ? hub.device(userId,run!.device_id) : undefined;
  if (run!.executor === "device" && conn?.deviceId === run!.device_id)
    return { run: run!, notify: conn };
  if (run!.executor === "cloud" && run!.status !== "queued")
    return { run: run!, notify: null };
  await finishRun(tx, runId, "cancelled", null);
  return { run: run!, notify: null };
}

export async function decideApproval(
  tx: Tx,
  hub: Hub,
  userId: string,
  approvalId: string,
  decision: "approve" | "approve_always" | "reject",
) {
  const snapshot = await tx.one('SELECT run_id FROM approvals WHERE approval_id=$1 AND user_id=$2',[approvalId,userId]);
  if (!snapshot) fail(404,'审批不存在');
  // Match finishRun/cancelRun: lock the run before its approval. This also
  // makes a concurrent cancellation visible before persisting a new grant.
  const run = await tx.one('SELECT * FROM bot_runs WHERE run_id=$1 FOR NO KEY UPDATE',[snapshot!.run_id]);
  const a = await tx.one(
    "SELECT * FROM approvals WHERE approval_id=$1 AND user_id=$2 FOR UPDATE",
    [approvalId, userId],
  );
  if (!a) fail(404, "审批不存在");
  if (a!.status !== "pending" || new Date(a!.expires_at) < new Date())
    fail(409, "审批已失效");
  if (!run || run.cancel_requested || !['running','waiting_approval'].includes(run.status)) return fail(409,'任务已结束，审批已失效');
  if (a!.detail.single_use && decision === 'approve_always') fail(422, '应用启动权限仅适用于本次任务');
  if (a!.kind === 'browser_access') {
    if (decision === 'approve_always') fail(422, '浏览器访问权限仅适用于本次任务');
    for (const origin of a!.detail.handoff ? [] : a!.detail.origins) await tx.insert('authorization_logs', {
      user_id: userId, target: `device:${run.device_id}`, operation: 'browser', resource: origin,
      action: decision === 'reject' ? 'reject' : 'allow_once', approval_id: approvalId, run_id: run.run_id,
    });
  } else if (decision === 'approve_always') await rememberAuthorization(tx, a!);
  else {
    const scope = a!.detail.authorization_scope ?? await approvalScope(tx,run!,a!.detail.path,'legacy','unknown');
    await authorizationLog(tx,userId,scope,decision === 'reject' ? 'reject' : 'allow_once',{approval_id:approvalId,run_id:a!.run_id});
  }
  const status = decision !== "reject" ? "approved" : "rejected";
  const updated = await tx.update("approvals", approvalId, {
    status,
    detail: decision === 'approve_always' ? {...a!.detail, remembered:true} : a!.detail,
    decided_at: new Date(),
  });
  const pending = await tx.one(
    "SELECT 1 FROM approvals WHERE run_id=$1 AND status='pending'",
    [a!.run_id],
  );
  if (!pending) {
    await markRunning(tx, a!.run_id);
    await tx.rows("UPDATE agent_tasks SET status='running', updated_at=now() WHERE child_run_id=$1 AND status='waiting_approval'", [a!.run_id]);
  }
  await tx.notify({ user_id: userId, bot_id: a!.bot_id });
  const conn = hub.device(userId,run?.device_id);
  return {
    approval: approvalOut(updated),
    send:
      conn && run?.device_id === conn.deviceId
        ? () =>
            conn.send({
              type: "approval",
              approval_id: approvalId,
              run_id: a!.run_id,
              decision,
            })
        : null,
  };
}
