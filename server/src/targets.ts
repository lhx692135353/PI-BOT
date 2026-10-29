import { createHash } from "node:crypto";
import { z } from "zod";
import { fail, HttpError, type Tx, type Row } from "./db.js";
import type { Settings } from "./config.js";
import type { Hub } from "./hub.js";

export const CAPABILITIES = ["files", "shell", "browser", "desktop", "phone", "always-on-v1", "preflight-v1"] as const;
export const resourceSchema = z.object({
  target: z.string().regex(/^(device|remote):[0-9a-f-]{36}$/).refine(value => z.string().uuid().safeParse(value.slice(7)).success,"资源机器 ID 无效"),
  path: z.string().min(1).max(2000).optional(),
}).strict();
export const routingFields = {
  execution: z.enum(["auto", "device", "cloud", "remote"]).optional(),
  device_id: z.string().uuid().optional(),
  requirements: z.array(z.enum(CAPABILITIES)).max(10).optional(),
  resources: z.array(resourceSchema).max(20).optional(),
};
export interface Routing {
  execution: "auto" | "device" | "cloud" | "remote";
  device_id?: string;
  preferred_device_id?: string;
  requirements: string[];
  resources: { target: string; path?: string }[];
}
export class RemotePreparationRequired extends HttpError {
  constructor() { super(503, "云端执行环境正在准备"); }
}
export const targetDevice = (target?: string) => target?.startsWith("device:") ? target.slice(7) : null;

export async function taskRouting(tx: Tx, userId: string, source: Row, input: Partial<Routing> = {}): Promise<Routing> {
  const execution = input.execution ?? (input.device_id ? "device" : "auto");
  if (input.device_id && !["auto", "device"].includes(execution)) fail(422, "电脑与云端目标不能同时指定");
  const preferred = source.source_device_id ?? source.preferred_device_id ?? (await tx.one(
    "SELECT source_device_id FROM bot_runs WHERE user_id=$1 AND source_client='desktop' AND origin IN ('user','voice') AND source_device_id IS NOT NULL ORDER BY created_at DESC,run_id DESC LIMIT 1", [userId],
  ))?.source_device_id;
  const routing: Routing = {
    execution: input.device_id ? "device" : execution,
    device_id: input.device_id,
    preferred_device_id: preferred ?? undefined,
    requirements: [...new Set(input.requirements ?? (execution === "cloud" ? [] : ["files", "shell"]))].sort(),
    resources: [...(input.resources ?? [])].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  if (routing.execution === "device" && !routing.device_id) {
    if (!preferred) fail(422, "请指定要使用的电脑");
    routing.device_id = preferred;
  }
  for (const resource of routing.resources) {
    const id = resource.target.slice(7), device = resource.target.startsWith("device:");
    if (!await tx.one(device
      ? "SELECT 1 FROM devices WHERE device_id=$1 AND user_id=$2 AND revoked_at IS NULL"
      : "SELECT 1 FROM remote_environments WHERE environment_id=$1 AND user_id=$2 AND status<>'retired'", [id,userId])) fail(422, "资源不属于当前账号或已不可用");
  }
  return routing;
}
export const routingKey = (routing: Routing) => "policy:" + createHash("sha256").update(JSON.stringify(routing)).digest("hex");

/** Select only at dispatch. A past execution node is never an automatic preference. */
export async function resolveTaskTarget(tx: Tx, s: Settings | undefined, hub: Hub, userId: string, slug: string, routing: Routing) {
  const resources = routing.resources ?? [], required = routing.requirements ?? [];
  const targets = new Set(resources.map(r => r.target));
  if (targets.size > 1) fail(422, "一个任务需要多台机器的资源，请先拆分任务或明确传输所需文件");
  const permits = (target: string) => !targets.size || targets.has(target);
  if (routing.execution === "cloud") {
    if (resources.length || required.length) fail(422, "纯云端处理不能访问机器文件或执行机器工具");
    return { execution: "cloud", device_id: null, operation_target: "cloud" };
  }
  const rows = await tx.rows(`SELECT d.device_id,d.platform,count(r.run_id)::int AS load FROM devices d
    LEFT JOIN bot_runs r ON r.device_id=d.device_id AND r.status IN ('queued','running','waiting_approval')
    WHERE d.user_id=$1 AND d.revoked_at IS NULL GROUP BY d.device_id
    ORDER BY (d.device_id::text=$2) DESC,load,d.device_id`, [userId,routing.preferred_device_id ?? ""]);
  if (routing.execution === "device" && !rows.some(d => d.device_id === routing.device_id)) fail(422, "指定电脑不属于当前账号或已解绑");
  if (routing.execution !== "remote") for (const d of rows) {
    if (routing.execution === "device" && d.device_id !== routing.device_id) continue;
    const target = "device:" + d.device_id, conn = hub.device(userId,d.device_id);
    if (!permits(target) || !conn || !required.every(c => conn.capabilities?.includes(c))) continue;
    const paths = resources.filter(r => r.path).map(r => r.path!);
    if (paths.length) {
      if (!conn.capabilities?.includes("preflight-v1")) continue;
      try {
        const result = await hub.rpc(userId,"tasks.preflight",{slug,paths},s?.rpcTimeoutMs ?? 5000,d.device_id) as {available?:boolean};
        if (result.available !== true) continue;
      } catch { continue; }
    }
    if (!await tx.one("SELECT 1 FROM devices WHERE device_id=$1 AND user_id=$2 AND revoked_at IS NULL FOR SHARE",[d.device_id,userId])) continue;
    if (hub.device(userId,d.device_id) !== conn) continue;
    return { execution: "device", device_id: d.device_id, operation_target: target };
  }
  if (routing.execution === "device") fail(409, "指定电脑离线、缺少所需能力或无法访问任务资源，本次操作未执行");
  if ([...targets].some(t => t.startsWith("device:"))) fail(409, "文件所在电脑不可用，本次操作未执行；文件未复制到其他机器");
  if (!s || s.remoteBackend === "none") fail(422, "没有可用的电脑，云端执行环境未开启");
  const env = await tx.one("SELECT * FROM remote_environments WHERE user_id=$1 AND status<>'retired'",[userId]);
  if (env && !permits("remote:"+env.environment_id)) fail(409, "原文件所在云端环境不可用");
  if (env && env.backend !== s!.remoteBackend) fail(409, "原云端执行后端已变化");
  if (!env || env.status !== "ready") throw new RemotePreparationRequired();
  if (!required.filter(c => c !== "always-on-v1").every(c => env.capabilities?.includes(c))) fail(422, "云端环境缺少任务所需能力");
  const paths = resources.filter(r => r.path).map(r => r.path!);
  if (paths.length && (!env.capabilities?.includes("preflight-v1") || !hub.remotePreflight || !await hub.remotePreflight(env,slug,paths))) fail(409, "云端任务资源不存在或无法访问");
  return { execution: "remote", device_id: null, operation_target: "remote:" + env.environment_id };
}

/** Compatibility wrapper for explicit continuation of a historical task. */
export async function taskTarget(tx: Tx, s: Settings | undefined, hub: Hub, userId: string, parent: Row, bot: Row, choice?: string, deviceId?: string) {
  return resolveTaskTarget(tx,s,hub,userId,bot.slug,await taskRouting(tx,userId,parent,{execution:choice as Routing["execution"],device_id:deviceId}));
}
export async function targetPrompt(tx: Tx, s: Settings, hub: Hub | undefined, userId: string, target: string, source: string) {
  const devices = await tx.rows("SELECT device_id,label,platform FROM devices WHERE user_id=$1 AND revoked_at IS NULL",[userId]);
  return `你是由云端统一管理的智能体，没有绑定的电脑。请求来源 ${source}；本次执行节点 ${target}（仅属于本次任务）。\n可用电脑：${JSON.stringify(devices.map(d => ({...d,online:hub ? !!hub.device(userId,d.device_id) : undefined})))}；云端机器启用：${s.remoteBackend !== "none"}。\n每个新任务默认 execution=auto，由服务端按来源电脑、其他可用电脑、云端的顺序选择；纯文字和搜索用 execution=cloud。只有用户明确指定机器时才填写 device_id 或 execution=remote。不要把上次任务、受委托智能体或当前执行节点作为新任务的固定机器。requirements 声明所需能力；已有文件、项目或手机必须通过 resources 携带真实来源 target，可带资料库内 path。相同路径不代表同一文件。一个任务开始后在同一节点完成，中断后先核实结果，不得重放未知外部操作。文件结果注明真实来源。`;
}
