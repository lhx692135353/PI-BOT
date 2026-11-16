import { createHash } from "node:crypto";
import { z } from "zod";
import { fail, HttpError, type Tx, type Row } from "./db.js";
import type { Settings } from "./config.js";
import type { Hub } from "./hub.js";

export const CAPABILITIES = ["files", "shell", "browser", "desktop", "phone", "always-on-v1", "preflight-v1", "browser-test", "browser-test-task-v1"] as const;
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
  browser_test_origin?: string;
  browser_test_authorization?: "user" | "prompt";
  requirements: string[];
  resources: { target: string; path?: string }[];
}
export class RemotePreparationRequired extends HttpError {
  constructor() { super(503, "云端执行环境正在准备"); }
}
export const targetDevice = (target?: string) => target?.startsWith("device:") ? target.slice(7) : null;

async function browserTestPreflight(hub: Hub, s: Settings | undefined, userId: string, deviceId: string, origin: string) {
  const result = await hub.rpc(userId, "browser-test.preflight", { origin }, s?.rpcTimeoutMs ?? 5000, deviceId) as { available?: boolean };
  return result.available === true;
}

export function browserTestOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
        url.pathname === "/" && !url.search && !url.hash) return url.origin;
  } catch { /* Invalid input. */ }
}

export function browserTestOriginInMessage(text: string, origin: string): boolean {
  // Consume the whole link so URLs embedded inside another URL never grant access.
  for (const [link] of text.matchAll(/\bhttps?:\/\/[^\s<>"'`）。，、；！？]+/gi)) {
    try {
      const url = new URL(link.replace(/[),;!}]+$/, ""));
      if (!url.username && !url.password && url.origin === origin) return true;
    } catch { /* Ignore malformed links. */ }
  }
  return false;
}

export async function browserTestRouting(tx: Tx, s: Settings | undefined, hub: Hub, userId: string,
  source: Row, input: Partial<Routing> & { browser_test_origin: string }): Promise<Routing> {
  const normalized = browserTestOrigin(input.browser_test_origin);
  if (!normalized) return fail(422, "测试站点只填 HTTP(S) 协议、主机和端口");
  const origin = new URL(normalized);
  if (input.execution === "cloud" || input.execution === "remote") fail(422, "端侧浏览器测试需要使用用户电脑");
  const routing = await taskRouting(tx, userId, source, { ...input, execution: "auto" });
  routing.execution = "device";
  routing.browser_test_origin = origin.origin;
  const message = source.origin === "user" && source.user_message_id ? await tx.get("bot_messages", source.user_message_id) : null;
  routing.browser_test_authorization = message?.role === "user" && message.visibility === "public" && !message.ui_action &&
    browserTestOriginInMessage(String(message.content ?? ""), normalized) ? "user" : "prompt";
  const requirements = input.requirements?.filter(capability => !["browser", "browser-test-task-v1"].includes(capability)) ?? [];
  routing.requirements = [...new Set([...requirements, "browser-test"])].sort();
  const knownTargets = [...new Set(routing.resources.map(resource => resource.target))];
  if (knownTargets.length > 1 || knownTargets.some(target => !targetDevice(target))) fail(422, "请确认测试项目所在的用户电脑");
  const projectDevice = targetDevice(knownTargets[0]);
  if (projectDevice && input.device_id && projectDevice !== input.device_id) fail(422, "指定电脑与项目所在电脑不同，请确认使用哪台");
  const pinned = input.device_id ?? projectDevice;
  if (pinned) return { ...routing, device_id: pinned };
  const rows = await tx.rows("SELECT device_id,label FROM devices WHERE user_id=$1 AND revoked_at IS NULL ORDER BY label,device_id", [userId]);
  const current = rows.find(device => device.device_id === source.source_device_id);
  const usable = async (device: Row) => {
    const conn = hub.device(userId, device.device_id);
    if (!conn || routing.requirements.some(capability => !conn.capabilities?.includes(capability))) return false;
    if (conn.capabilities?.includes("browser-test-task-v1")) return true;
    return browserTestPreflight(hub, s, userId, device.device_id, origin.origin)
      .then(allowed => allowed && hub.device(userId, device.device_id) === conn, () => false);
  };
  if (current && await usable(current)) return { ...routing, device_id: current.device_id };
  const suitable = (await Promise.all(rows.filter(device => device !== current).map(async device => await usable(device) ? device : null)))
    .filter(device => device !== null);
  const local = origin.hostname === "localhost" || origin.hostname.endsWith(".localhost") ||
    /^127\./.test(origin.hostname) && /^\d+\.\d+\.\d+\.\d+$/.test(origin.hostname) || origin.hostname === "[::1]";
  if (suitable.length === 1 && !(local && current)) return { ...routing, device_id: suitable[0].device_id };
  if (suitable.length) {
    const names = suitable.map(device => String(device.label).slice(0, 60)).slice(0, 4).join("、");
    fail(409, `请在聊天中确认使用哪台电脑。可用电脑：${names}`);
  }
  return fail(409, "没有可运行此浏览器测试的在线电脑，请检查连接或更新桌面端");
}

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
  if ((routing.browser_test_origin || required.includes("browser-test")) &&
      (!routing.browser_test_origin || routing.execution !== "device" || !routing.device_id))
    fail(422, "浏览器测试需要站点 origin 和已选定的用户电脑");
  const targets = new Set(resources.map(r => r.target));
  if (targets.size > 1) fail(422, "一个任务需要多台机器的资源，请先拆分任务或明确传输所需文件");
  const permits = (target: string) => !targets.size || targets.has(target);
  if (routing.execution === "cloud") {
    if (resources.length || required.length) fail(422, "纯云端处理不能访问机器文件或执行机器工具");
    return { execution: "cloud", device_id: null, operation_target: "cloud" };
  }
  const paths = resources.filter(r => r.path).map(r => r.path!);
  const remoteUsable = async (env: Row) => env.backend === s!.remoteBackend && env.status === "ready" && permits("remote:"+env.environment_id)
    && required.filter(c => c !== "always-on-v1").every(c => env.capabilities?.includes(c))
    && (!paths.length || (!!env.capabilities?.includes("preflight-v1") && !!hub.remotePreflight && await hub.remotePreflight(env,slug,paths).catch(() => false)));
  // The cloud computer is the default machine; a user's own computer is used when named or when it holds the resources.
  if (routing.execution === "auto" && s && s.remoteBackend !== "none" && ![...targets].some(t => t.startsWith("device:"))) {
    const env = await tx.one("SELECT * FROM remote_environments WHERE user_id=$1 AND status<>'retired'",[userId]);
    if (!env && s.remoteBackend === "local") throw new RemotePreparationRequired();
    if (env && await remoteUsable(env)) return { execution: "remote", device_id: null, operation_target: "remote:" + env.environment_id };
  }
  const rows = await tx.rows(`SELECT d.device_id,d.platform,count(r.run_id)::int AS load FROM devices d
    LEFT JOIN bot_runs r ON r.device_id=d.device_id AND r.status IN ('queued','running','waiting_approval')
    WHERE d.user_id=$1 AND d.revoked_at IS NULL GROUP BY d.device_id
    ORDER BY (d.device_id::text=$2) DESC,load,d.device_id`, [userId,routing.preferred_device_id ?? ""]);
  if (routing.execution === "device" && !rows.some(d => d.device_id === routing.device_id)) fail(422, "指定电脑不属于当前账号或已解绑");
  const rejected = new Map<string, string>();
  if (routing.execution !== "remote") for (const d of rows) {
    if (routing.execution === "device" && d.device_id !== routing.device_id) continue;
    const target = "device:" + d.device_id, conn = hub.device(userId,d.device_id);
    if (!permits(target)) continue;
    if (!conn) { rejected.set(d.device_id, "电脑已离线，本次操作未执行"); continue; }
    const missing = required.filter(c => !conn.capabilities?.includes(c));
    if (missing.length) { rejected.set(d.device_id, `电脑已连接，但未提供任务所需能力：${missing.join(", ")}；本次操作未执行`); continue; }
    if (routing.browser_test_origin && !(routing.browser_test_authorization && conn.capabilities?.includes("browser-test-task-v1"))) {
      const allowed = await browserTestPreflight(hub, s, userId, d.device_id, routing.browser_test_origin).catch(() => false);
      if (!allowed) { rejected.set(d.device_id, "指定电脑未允许该测试站点，或设备检查未响应；本次操作未执行"); continue; }
    }
    if (paths.length) {
      if (!conn.capabilities?.includes("preflight-v1")) { rejected.set(d.device_id, "电脑已连接，但客户端不支持资源检查，请更新该电脑客户端"); continue; }
      try {
        const result = await hub.rpc(userId,"tasks.preflight",{slug,paths},s?.rpcTimeoutMs ?? 5000,d.device_id) as {available?:boolean;reason?:string};
        if (result.available !== true) {
          const detail = result.reason === 'outside_library'
            ? "资源路径在此智能体资料库以外。请保留 resources.target、去掉 resources.path 启动访问授权任务，在执行电脑内调用 request_outside_access 申请具体路径的权限；获批前不要读取项目"
            : result.reason === 'missing'
              ? "资料库或资源路径不存在，请核实路径；不要省略资源检查或换用其他电脑上的同名文件"
              : "路径检查未通过，可能是路径不存在、资料库外访问或文件权限不足；请核实路径和访问权限";
          rejected.set(d.device_id, "电脑已连接，但任务资源检查未通过：" + detail);
          continue;
        }
      } catch {
        rejected.set(d.device_id, hub.device(userId,d.device_id) === conn ? "电脑资源检查未响应或返回错误，本次操作未执行；请稍后重试" : "电脑已离线，本次操作未执行");
        continue;
      }
    }
    if (!await tx.one("SELECT 1 FROM devices WHERE device_id=$1 AND user_id=$2 AND revoked_at IS NULL FOR SHARE",[d.device_id,userId])) continue;
    if (hub.device(userId,d.device_id) !== conn) continue;
    return { execution: "device", device_id: d.device_id, operation_target: target };
  }
  if (routing.execution === "device") fail(409, rejected.get(routing.device_id!) ?? "指定电脑连接已变化，本次操作未执行，请重试");
  if ([...targets].some(t => t.startsWith("device:"))) fail(409, "文件所在电脑不可用：" + (rejected.get(targetDevice([...targets][0])!) ?? "电脑连接已变化") + "；文件未复制到其他机器");
  if (!s || s.remoteBackend === "none") fail(422, "没有可用的电脑，云端执行环境未开启");
  const env = await tx.one("SELECT * FROM remote_environments WHERE user_id=$1 AND status<>'retired'",[userId]);
  if (env && !permits("remote:"+env.environment_id)) fail(409, "原文件所在云端环境不可用");
  if (env && env.backend !== s!.remoteBackend) fail(409, "原云端执行后端已变化");
  if (!env || env.status !== "ready") throw new RemotePreparationRequired();
  if (!required.filter(c => c !== "always-on-v1").every(c => env.capabilities?.includes(c))) fail(422, "云端环境缺少任务所需能力");
  if (paths.length && (!env.capabilities?.includes("preflight-v1") || !hub.remotePreflight || !await hub.remotePreflight(env,slug,paths))) fail(409, "云端任务资源不存在或无法访问");
  return { execution: "remote", device_id: null, operation_target: "remote:" + env.environment_id };
}

/** Compatibility wrapper for explicit continuation of a historical task. */
export async function taskTarget(tx: Tx, s: Settings | undefined, hub: Hub, userId: string, parent: Row, bot: Row, choice?: string, deviceId?: string) {
  return resolveTaskTarget(tx,s,hub,userId,bot.slug,await taskRouting(tx,userId,parent,{execution:choice as Routing["execution"],device_id:deviceId}));
}
export async function targetPrompt(tx: Tx, s: Settings, hub: Hub | undefined, userId: string, target: string, source: string) {
  const devices = await tx.rows("SELECT device_id,label,platform FROM devices WHERE user_id=$1 AND revoked_at IS NULL",[userId]);
  return `你是由云端统一管理的智能体，没有绑定的电脑。请求来源 ${source}；本次执行节点 ${target}（仅属于本次任务）。\n可用电脑：${JSON.stringify(devices.map(d => ({...d,online:hub ? !!hub.device(userId,d.device_id) : undefined,capabilities:hub?.device(userId,d.device_id)?.capabilities})))}；云端电脑启用：${s.remoteBackend !== "none"}。\n每个新任务默认 execution=auto，服务端优先选择始终在线的云端电脑，不可用时再按来源电脑、其他可用电脑选择；纯文字和搜索用 execution=cloud。需要用户电脑上的文件、应用，或用户明确指定电脑时，填写 execution=device 和 device_id。资料库以云端电脑上的文件为准；在用户电脑资料库中生成的文件会自动同步一份到云端，资料库以外的本地文件不会同步。不要把上次任务、受委托智能体或当前执行节点作为新任务的固定机器。requirements 声明所需能力；已有文件、项目或手机必须通过 resources 携带真实来源 target；path 仅用于此智能体资料库内已存在的资源，不要把资料库外的绝对项目路径放进 path。资料库外项目用 target 定位电脑、暂不填写 path，启动任务后先调用 request_outside_access 申请具体路径权限，获批后再访问。资源检查失败不等于电脑离线。相同路径不代表同一文件。一个任务开始后在同一节点完成，中断后先核实结果，不得重放未知外部操作。文件结果注明真实来源。`;
}
