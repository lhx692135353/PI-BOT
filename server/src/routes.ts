import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChatImage } from '@pi-bot/agent/images';
import { imagesSchema } from './images.js';
import { fail, type Database, type Row, type Tx } from "./db.js";
import type { Settings } from "./config.js";
import type { Hub } from "./hub.js";
import {
  decodeBase64,
  issueLlmToken,
  issueToken,
  passwordHash,
  passwordMatches,
  Vault,
  type LlmClaims,
} from "./security.js";
import {
  botInput,
  botOut,
  botPatch,
  createBot,
  ensureMainBot,
  messageOut,
  messagesPage,
  ownBot,
  postMessage,
  runOut,
  updateBot,
} from "./bots.js";
import { cancelRun, decideApproval, dispatchDevice, failDeviceRuns } from "./runs.js";
import { cancelTask, createTask, readTask, reportLater, TERMINAL, listTasks, messageTask, callerRun } from "./agents.js";
import { deviceOut, deviceList, botConnection } from './devices.js';
import { complete, findModel, proxyResponses, recordUsage } from "./llm.js";
import type { WebSearch } from "./search.js";
import { manageSkill, skillRequest } from "./skills.js";

import { automationRequest, automationFinishRequest, manageAutomation, saveAutomationDecision, recordAutomationEffect } from "./automations.js";
import {saveUiState,submitUiAction} from "./ui.js";
import { manageMemory, memoryRequest, searchHistory, directory, checkpoint, checkpointSchema, resumeTask } from "./memory.js";

export type Auth = "none" | "user" | "admin" | "device" | "actor" | "llm";
export interface Context {
  db: Database;
  tx: Tx;
  s: Settings;
  hub: Hub;
  webSearch: WebSearch;
  user: Row;
  device?: Row;
  llm?: LlmClaims;
  body: any;
  query: any;
  params: Record<string, string>;
  req: FastifyRequest;
  reply: FastifyReply;
  /** Runs after the transaction commits, e.g. pushing work to a socket. */
  after(fn: () => unknown): void;
}
export interface Route {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  auth: Auth;
  tag: string;
  summary: string;
  body?: z.ZodType;
  query?: z.ZodType;
  /** Long-running handlers manage their own transactions. */
  tx?: false;
  /** Internal agent operations are excluded from public API discovery. */
  internal?: boolean;
  handler(ctx: Context): Promise<unknown>;
}

const uuid = z.string().uuid();
const username = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.@-]{1,64}$/, "用户名只能包含字母、数字和 _ . @ -");
const password = z.string().min(8, "密码至少 8 位").max(200);
const httpUrl = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
  }, "需要 HTTP(S) 根地址，不包含账号、查询参数或片段");
const modelFields = z.object({
  name: z.string().trim().min(1).max(80),
  base_url: httpUrl,
  provider_model: z.string().trim().min(1).max(200),
  api_key: z.string().min(1).max(8192),
  context_window: z.number().int().min(1024).max(4000000),
  max_tokens: z.number().int().min(16).max(1000000),
  enabled: z.boolean().default(true),
  is_default: z.boolean().default(false),
});
const libraryPath = z.object({ path: z.string().max(2000).default("") });

export const userOut = (u: Row) => ({
  id: u.user_id,
  username: u.username,
  display_name: u.display_name || u.username,
  role: u.role,
  disabled: u.disabled,
  created_at: u.created_at,
});
const modelOut = (m: Row) => ({
  id: m.model_id,
  name: m.name,
  base_url: m.base_url,
  provider_model: m.provider_model,
  context_window: m.context_window,
  max_tokens: m.max_tokens,
  enabled: m.enabled,
  is_default: m.is_default,
  created_at: m.created_at,
  updated_at: m.updated_at,
});
async function computerStatus(tx: Tx, hub: Hub, userId: string) {
  const devices = await deviceList(tx, hub, userId);
  return { online: devices.some(d => d.online), device: devices.find(d => !d.revoked_at) ?? null };
}
async function setDefault(tx: Tx, id: string) {
  await tx.rows("UPDATE models SET is_default=false WHERE is_default AND model_id<>$1", [id]);
  await tx.rows("UPDATE models SET is_default=true, enabled=true WHERE model_id=$1", [id]);
}
async function ensureDefault(tx: Tx) {
  if (await tx.one("SELECT 1 FROM models WHERE is_default AND enabled")) return;
  await tx.rows("UPDATE models SET is_default=false WHERE is_default");
  const first = await tx.one("SELECT model_id FROM models WHERE enabled ORDER BY created_at LIMIT 1");
  if (first) await setDefault(tx, first.model_id);
}
async function deviceFiles(ctx: Context, method: "list" | "read") {
  const bot = await ctx.db.tx((tx) => ownBot(tx, ctx.user.user_id, ctx.params.id));
  return ctx.hub.rpc(
    ctx.user.user_id,
    `files.${method}`,
    { slug: bot.slug, path: ctx.query.path },
    ctx.s.rpcTimeoutMs,
    bot.execution_device_id,
  );
}

export const routes: Route[] = [
  {method:"POST",path:"/agent/automations/effect",auth:"llm",tag:"agents",summary:"自动工作操作日志",internal:true,
    body:z.object({run_id:uuid,tool_call_id:z.string().min(1).max(200),phase:z.enum(["start","end"]),confirmed:z.boolean().optional(),tool_name:z.enum(["write_file","edit_file","run_command"]).optional(),summary:z.string().max(2000).optional(),result:z.string().max(4000).optional()}).strict(),
    handler:async({tx,user,llm,body})=>recordAutomationEffect(tx,user.user_id,llm!,body)},
  { method:"POST",path:"/agent/automations",auth:"llm",tag:"agents",summary:"管理长期委托与自主巡检",internal:true,body:automationRequest,
    handler:async({tx,user,llm,body})=>manageAutomation(tx,user.user_id,llm!,body) },
  { method:"POST",path:"/agent/automations/finish",auth:"llm",tag:"agents",summary:"提交自动轮次结果",internal:true,body:automationFinishRequest,
    handler:async({tx,user,llm,body})=>saveAutomationDecision(tx,user.user_id,llm!,body) },
  {method:"POST",path:"/agent/memory",auth:"llm",tag:"memory",summary:"当前 Bot 的私有记忆",internal:true,body:memoryRequest,
    handler:async({tx,user,llm,body})=>manageMemory(tx,user.user_id,llm!,body)},
  {method:"POST",path:"/agent/history/search",auth:"llm",tag:"memory",summary:"检索当前 Bot 历史",internal:true,
    body:z.object({run_id:uuid,query:z.string().max(200)}).strict(),handler:async({tx,user,llm,body})=>searchHistory(tx,user.user_id,llm!,body.run_id,body.query)},
  {method:"POST",path:"/agent/directory",auth:"llm",tag:"agents",summary:"搜索协作者知识目录",internal:true,
    body:z.object({run_id:uuid,query:z.string().max(200).default("")}).strict(),handler:async({tx,user,llm,body})=>{
      const run=await callerRun(tx,user.user_id,llm!,body.run_id);return {agents:await directory(tx,user.user_id,run.bot_id,body.query)};}},
  {method:"POST",path:"/agent/checkpoint",auth:"llm",tag:"agents",summary:"保存当前任务检查点",internal:true,
    body:z.object({run_id:uuid,checkpoint:checkpointSchema,expected_version:z.number().int().min(0)}).strict(),
    handler:async({tx,user,llm,body})=>checkpoint(tx,user.user_id,llm!,body.run_id,body.checkpoint,body.expected_version)},
  {method:"POST",path:"/agent/tasks/resume",auth:"llm",tag:"agents",summary:"用户要求后续接已结束任务",internal:true,
    body:z.object({run_id:uuid,task_id:uuid,request_id:z.string().min(1).max(200),text:z.string().max(8000).optional()}).strict(),
    handler:async({tx,db,s,hub,user,llm,body,after})=>{const r=await resumeTask(tx,hub,user.user_id,llm!,body);if(r.run?.executor==="device") after(()=>dispatchDevice(db,s,hub,r.run!.run_id));return r.task;}},
  {
    method: "POST", path: "/agent/skills", auth: "llm", tag: "skills", summary: "智能体私有能力管理",
    internal: true,
    body: skillRequest,
    handler: async ({ tx, user, llm, body }) => manageSkill(tx, user.user_id, llm!, body),
  },
  {
    method: "POST", path: "/web/search", auth: "llm", tag: "web", summary: "联网搜索：电脑与云端共用（短期智能体令牌）",
    tx: false,
    body: z.object({ query: z.string().trim().min(1).max(2000), language: z.string().regex(/^(auto|all|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/).default("auto") }),
    handler: async ({ webSearch, body, reply }) => {
      const abort = new AbortController();
      const onClose = () => { if (!reply.raw.writableEnded) abort.abort(); };
      reply.raw.once("close", onClose);
      try { return await webSearch.search(body.query, body.language, abort.signal); }
      finally { reply.raw.off("close", onClose); }
    },
  },
  {
    method: "POST", path: "/agent/tasks", auth: "llm", tag: "agents", summary: "智能体把任务委托给同一用户的另一个 Bot（短期智能体令牌）",
    body: z.object({
      run_id: uuid,
      execution: z.enum(["device","cloud"]).optional(),
      agent: z.string().trim().min(1).max(100).optional(),
      kind: z.enum(["background", "delegation"]).default("delegation"),
      title: z.string().trim().min(1).max(80).optional(),
      request_id: z.string().min(1).max(200).optional(),
      task: z.string().trim().min(1).max(8000),
      wait: z.boolean().default(true),
    }),
    handler: async ({ db, tx, s, hub, user, llm, body, after }) => {
      const { task, run } = await createTask(tx, hub, user.user_id, llm!, body);
      if (run?.executor === "device") after(() => dispatchDevice(db, s, hub, run.run_id));
      return task;
    },
  },
  {
    method: "GET", path: "/agent/tasks", auth: "llm", tag: "agents", summary: "列出当前 Bot 的任务", internal: true,
    query: z.object({ run_id: uuid }),
    handler: async ({ tx, user, llm, query }) => listTasks(tx, user.user_id, llm!, query.run_id),
  },
  {
    method: "POST", path: "/agent/tasks/:id/messages", auth: "llm", tag: "agents", summary: "向后台任务追加要求", internal: true,
    body: z.object({ run_id: uuid, text: z.string().trim().min(1).max(8000), request_id: z.string().min(1).max(200) }),
    handler: async ({ tx, user, llm, params, body }) => messageTask(tx, user.user_id, llm!, params.id, body),
  },
  {
    method: "POST", path: "/agent/tasks/cancel", auth: "llm", tag: "agents", summary: "明确取消指定任务或全部任务", internal: true,
    body: z.object({ run_id: uuid, task_id: uuid.optional(), all: z.boolean().default(false) }),
    handler: async ({ tx, hub, user, llm, body, after }) => {
      await callerRun(tx, user.user_id, llm!, body.run_id);
      if (!body.task_id && !body.all) fail(422, "请指定 task_id 或明确 all=true");
      const tasks = body.all ? await tx.rows("SELECT task_id FROM agent_tasks WHERE user_id=$1 AND (parent_bot_id=$2 OR target_bot_id=$2) AND status IN ('queued','running','waiting_approval') ORDER BY created_at", [user.user_id, llm!.bot]) : [{ task_id: body.task_id }];
      const results = [];
      for (const t of tasks) {
        const { task, notify } = await cancelTask(tx, hub, user.user_id, llm!, t.task_id);
        if (notify) after(() => notify.send({ type: "cancel", run_id: notify.runId }));
        results.push(task);
      }
      return { tasks: results };
    },
  },
  {
    method: "GET", path: "/agent/tasks/:id", auth: "llm", tag: "agents", summary: "查询委托；wait>0 时长轮询直到完成或超时（秒）",
    query: z.object({ wait: z.coerce.number().int().min(0).max(30).default(0), run_id: uuid.optional() }),
    tx: false,
    handler: async ({ db, s, user, llm, params, query, reply }) => {
      const deadline = Date.now() + query.wait * 1000;
      let closed = false;
      const onClose = () => void (closed = true);
      reply.raw.once("close", onClose);
      try {
        for (;;) {
          const task = await db.tx(async tx => {
            if (query.run_id) await callerRun(tx, user.user_id, llm!, query.run_id);
            return readTask(tx, user.user_id, llm!, params.id, s, query.wait > 0);
          });
          if (TERMINAL.includes(task.status) || Date.now() >= deadline || closed) return task;
          await new Promise((r) => setTimeout(r, 500));
        }
      } finally {
        reply.raw.off("close", onClose);
      }
    },
  },
  {
    method: "POST", path: "/agent/tasks/:id/cancel", auth: "llm", tag: "agents", summary: "发起方停止等待并取消委托",
    handler: async ({ tx, hub, user, llm, params, after }) => {
      const { task, notify } = await cancelTask(tx, hub, user.user_id, llm!, params.id);
      if (notify) after(() => notify.send({ type: "cancel", run_id: notify.runId }));
      return task;
    },
  },
  {
    method: "POST", path: "/agent/tasks/:id/report", auth: "llm", tag: "agents", summary: "同步等待超时后改为完成后回报",
    handler: async ({ tx, s, user, llm, params }) => reportLater(tx, user.user_id, llm!, params.id, s),
  },
  {
    method: "GET", path: "/health", auth: "none", tag: "system", summary: "健康检查",
    handler: async () => ({ ok: true, name: "pi-bot" }),
  },
  {
    method: "POST", path: "/auth/login", auth: "none", tag: "auth", summary: "用户名密码登录",
    body: z.object({ username, password: z.string().min(1).max(200) }),
    handler: async ({ tx, s, body }) => {
      const u = await tx.one("SELECT * FROM users WHERE lower(username)=lower($1)", [body.username]);
      if (!u || u.disabled || !(await passwordMatches(u.password_hash, body.password)))
        fail(401, "用户名或密码错误");
      return { access_token: await issueToken(u!, s), expires_in: s.jwtTtl, user: userOut(u!) };
    },
  },
  {
    method: "POST", path: "/auth/password", auth: "user", tag: "auth", summary: "修改自己的密码",
    body: z.object({ old_password: z.string().max(200), new_password: password }),
    handler: async ({ tx, user, body }) => {
      if (!(await passwordMatches(user.password_hash, body.old_password))) fail(400, "原密码错误");
      await tx.update("users", user.user_id, { password_hash: await passwordHash(body.new_password), updated_at: new Date() });
      return { ok: true };
    },
  },
  {
    method: "GET", path: "/me", auth: "actor", tag: "auth", summary: "当前用户与电脑在线状态",
    handler: async ({ tx, hub, user }) => ({ user: userOut(user), computer: await computerStatus(tx, hub, user.user_id), devices: await deviceList(tx, hub, user.user_id) }),
  },
  {
    method: "POST", path: "/devices/register", auth: "user", tag: "device", summary: "注册或更新当前用户的一台执行电脑",
    body: z.object({ public_key: z.string(), label: z.string().trim().min(1).max(80), platform: z.enum(["darwin","linux"]).default("darwin") }),
    handler: async ({ tx, hub, user, body, after }) => {
      try {
        decodeBase64(body.public_key, 32);
      } catch {
        fail(422, "公钥必须是 32 字节 Ed25519 的标准 Base64");
      }
      await tx.one("SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE", [user.user_id]);
      const prior = await tx.one("SELECT * FROM devices WHERE user_id=$1 AND public_key=$2 AND revoked_at IS NULL", [user.user_id,body.public_key]);
      const first = !await tx.one("SELECT 1 FROM devices WHERE user_id=$1", [user.user_id]);
      const d = prior ? await tx.update("devices",prior.device_id,{label:body.label,platform:body.platform}) : await tx.insert("devices", { device_id: randomUUID(), user_id: user.user_id, public_key: body.public_key, label: body.label, platform: body.platform });
      if (first) await tx.rows("UPDATE bots SET execution_device_id=$2 WHERE user_id=$1 AND execution_device_id IS NULL", [user.user_id,d.device_id]);
      after(() => hub.publish(user.user_id, {type:'bots'}));
      return { device: deviceOut(d, false), user: userOut(user) };
    },
  },
  {
    method: 'GET', path: '/devices', auth: 'actor', tag: 'device', summary: '我的执行电脑',
    handler: ({tx,hub,user}) => deviceList(tx,hub,user.user_id),
  },
  {
    method: 'POST', path: '/devices/:id/revoke', auth: 'actor', tag: 'device', summary: '解绑自己的执行电脑',
    handler: async ({tx,db,hub,user,params,after}) => {
      const d = await tx.one('SELECT * FROM devices WHERE device_id=$1 AND user_id=$2 FOR UPDATE',[params.id,user.user_id]);
      if (!d) fail(404,'设备不存在');
      const updated = await tx.update('devices',params.id,{revoked_at:new Date()});
      after(async () => { hub.kick(params.id); await failDeviceRuns(db,params.id,'执行电脑已解绑',false); hub.publish(user.user_id,{type:'bots'}); });
      return deviceOut(updated,false);
    },
  },
  {
    method: "POST", path: "/device/llm-token", auth: "device", tag: "device", summary: "电脑换取访问模型代理的短期令牌",
    body: z.object({ bot_id: uuid.optional() }),
    handler: async ({ s, user, device, body }) => ({
      token: await issueLlmToken({ sub: user.user_id, src: "device", did: device!.device_id, bot: body.bot_id }, s),
      expires_in: s.llmTokenTtl,
      base_path: "/llm/v1",
    }),
  },
  {
    method: "GET", path: "/models", auth: "actor", tag: "bots", summary: "可选模型（管理员配置）",
    handler: async ({ tx }) =>
      (await tx.rows("SELECT * FROM models WHERE enabled ORDER BY is_default DESC, created_at")).map((m) => ({
        id: m.model_id, name: m.name, is_default: m.is_default, context_window: m.context_window,
      })),
  },
  {
    method: "GET", path: "/bots", auth: "actor", tag: "bots", summary: "我的 Bot 列表",
    handler: async ({ tx, hub, user }) => {
      await ensureMainBot(tx, user.user_id);
      const rows = await tx.rows("SELECT * FROM bots WHERE user_id=$1 AND archived_at IS NULL ORDER BY is_main DESC,last_active_at DESC", [user.user_id]);
      const bots = [];
      for (const b of rows) bots.push(await botOut(tx, b));
      return { bots, computer: await computerStatus(tx, hub, user.user_id), devices: await deviceList(tx, hub, user.user_id) };
    },
  },
  {
    method: "POST", path: "/bots", auth: "actor", tag: "bots", summary: "新建 Bot", body: botInput,
    handler: async ({ tx, user, device, body }) => {
      const b = await createBot(tx, user.user_id, { ...body, execution_device_id: body.execution_device_id === undefined ? device?.device_id : body.execution_device_id });
      await tx.notify({ user_id: user.user_id, bot_id: b.bot_id });
      return botOut(tx, b);
    },
  },
  {
    method: "GET", path: "/bots/:id", auth: "actor", tag: "bots", summary: "Bot 详情",
    handler: async ({ tx, user, params }) => botOut(tx, await ownBot(tx, user.user_id, params.id)),
  },
  {
    method: "PATCH", path: "/bots/:id", auth: "actor", tag: "bots", summary: "修改 Bot（名称、人设、模型、形象、执行电脑）", body: botPatch,
    handler: async ({ tx, user, params, body }) => {
      const b = await updateBot(tx, user.user_id, params.id, body);
      await tx.notify({ user_id: user.user_id, bot_id: b.bot_id });
      return botOut(tx, b);
    },
  },
  {
    method: "DELETE", path: "/bots/:id", auth: "actor", tag: "bots", summary: "归档 Bot（电脑上的资料库文件保留）",
    handler: async ({ tx, user, params }) => {
      const bot = await ownBot(tx, user.user_id, params.id);
      if (bot.is_main) fail(409, "主智能体不能删除");
      if (await tx.one("SELECT 1 FROM bot_runs WHERE bot_id=$1 AND execution_policy='any' AND status IN ('queued','running','waiting_approval')", [params.id]))
        fail(409, "请先停止正在进行的任务");
      await tx.rows("UPDATE bot_runs r SET cancel_requested=true FROM bot_automations a WHERE r.automation_id=a.automation_id AND (a.bot_id=$1 OR r.bot_id=$1) AND r.status IN ('queued','running','waiting_approval')", [params.id]);
      await tx.rows("UPDATE bot_automations SET status='stopped',version=version+1,next_wake_at=NULL WHERE bot_id=$1", [params.id]);
      await tx.rows("UPDATE automation_reports p SET discarded_at=now() FROM bot_automations a WHERE p.automation_id=a.automation_id AND a.bot_id=$1 AND p.delivered_at IS NULL", [params.id]);
      await tx.update("bots", params.id, { archived_at: new Date() });
      await tx.notify({ user_id: user.user_id, bot_id: params.id });
      return { ok: true };
    },
  },
  {
    method: "GET", path: "/bots/:id/messages", auth: "actor", tag: "bots", summary: "Bot 时间线（按 seq 倒序分页）",
    query: z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
    handler: async ({ tx, user, params, query }) => {
      await ownBot(tx, user.user_id, params.id);
      return messagesPage(tx, params.id, query.before, query.limit);
    },
  },
  {
    method: "POST", path: "/bots/:id/messages", auth: "actor", tag: "bots", summary: "给 Bot 发消息；电脑在线时在电脑上运行，否则在云端运行",
    body: z.object({ text: z.string().trim().max(100000).default(''), images: imagesSchema.default([]), request_id: z.string().min(8).max(80) }).refine(body => body.text.length > 0 || body.images.length > 0, '请填写消息或选择图片'),
    handler: async ({ db, tx, s, hub, user, params, body, after }) => {
      await ownBot(tx,user.user_id,params.id,true);
      const conn = await botConnection(tx,hub,user.user_id,params.id);
      const { run, created } = await postMessage(tx, user.user_id, params.id, body.text, body.request_id, conn ? { deviceId: conn.deviceId } : null, body.images);
      if (created && run.executor === "device") after(() => dispatchDevice(db, s, hub, run.run_id));
      const messages = await tx.rows("SELECT * FROM bot_messages WHERE message_id = ANY($1) ORDER BY seq", [[run.user_message_id, run.assistant_message_id]]);
      return { run: runOut(run), messages: messages.map((m) => messageOut(m)) };
    },
  },
  {
    method: 'GET', path: '/bots/:id/messages/:messageId/images/:imageId', auth: 'actor', tag: 'bots', summary: '读取消息图片',
    handler: async ({ tx, user, params }) => {
      await ownBot(tx, user.user_id, params.id);
      const message = await tx.one("SELECT images FROM bot_messages WHERE message_id=$1 AND bot_id=$2 AND visibility='public'", [params.messageId, params.id]);
      const image = message?.images.find((image: ChatImage & { id: string }) => image.id === params.imageId);
      if (!image) fail(404, '图片不存在');
      return image;
    },
  },
  {
    method:"POST",path:"/bots/:id/messages/:messageId/ui-state",auth:"actor",tag:"bots",summary:"保存交互界面状态（版本冲突返回 409）",
    body:z.object({revision:z.number().int().positive(),states:z.array(z.object({surfaceId:z.string().min(1).max(80),data:z.record(z.string(),z.unknown())})).max(4)}),
    handler:async({tx,user,params,body})=>messageOut(await saveUiState(tx,user.user_id,params.id,params.messageId,body.revision,body.states)),
  },
  {
    method:"POST",path:"/bots/:id/messages/:messageId/ui-actions",auth:"actor",tag:"bots",summary:"提交界面操作并启动下一次 Bot 任务",
    body:z.object({revision:z.number().int().positive(),request_id:z.string().uuid(),states:z.array(z.object({surfaceId:z.string().min(1).max(80),data:z.record(z.string(),z.unknown())})).max(4),action:z.object({name:z.string().min(1).max(80),surfaceId:z.string().min(1).max(80),sourceComponentId:z.string().min(1).max(80),context:z.record(z.string(),z.unknown())})}),
    handler:async({db,tx,s,hub,user,params,body,after})=>{
      await ownBot(tx,user.user_id,params.id,true);
      const conn=await botConnection(tx,hub,user.user_id,params.id);
      const {run,created}=await submitUiAction(tx,user.user_id,params.id,params.messageId,body,conn?{deviceId:conn.deviceId}:null);
      if(created&&run.executor==='device')after(()=>dispatchDevice(db,s,hub,run.run_id));
      const messages=await tx.rows("SELECT * FROM bot_messages WHERE message_id=ANY($1) ORDER BY seq",[[run.user_message_id,run.assistant_message_id]]);
      return {run:runOut(run),messages:messages.map(m=>messageOut(m))};
    },
  },
  {
    method: "POST", path: "/runs/:id/cancel", auth: "actor", tag: "bots", summary: "停止运行",
    handler: async ({ tx, hub, user, params, after }) => {
      const { run, notify } = await cancelRun(tx, hub, user.user_id, params.id);
      if (notify) after(() => notify.send({ type: "cancel", run_id: run.run_id }));
      return runOut(await tx.get("bot_runs", run.run_id));
    },
  },
  {
    method: "POST", path: "/approvals/:id", auth: "actor", tag: "bots", summary: "批准或拒绝 Bot 访问资料库以外的路径",
    body: z.object({ decision: z.enum(["approve", "reject"]) }),
    handler: async ({ tx, hub, user, params, body, after }) => {
      const { approval, send } = await decideApproval(tx, hub, user.user_id, params.id, body.decision);
      if (send) after(send);
      return approval;
    },
  },
  {
    method: "GET", path: "/bots/:id/files", auth: "actor", tag: "files", summary: "列出电脑上的 Bot 资料库目录（电脑离线时 503）",
    query: libraryPath, tx: false, handler: (ctx) => deviceFiles(ctx, "list"),
  },
  {
    method: "GET", path: "/bots/:id/files/content", auth: "actor", tag: "files", summary: "读取电脑上的资料库文件（文本或小图片）",
    query: libraryPath, tx: false, handler: (ctx) => deviceFiles(ctx, "read"),
  },
  {
    method: "GET", path: "/llm/v1/models", auth: "llm", tag: "llm", summary: "模型代理：可用模型",
    handler: async ({ tx }) => ({
      object: "list",
      data: (await tx.rows("SELECT model_id, name FROM models WHERE enabled ORDER BY created_at")).map((m) => ({ id: m.model_id, object: "model", owned_by: "pi-bot", name: m.name })),
    }),
  },
  {
    method: "POST", path: "/llm/v1/responses", auth: "llm", tag: "llm", summary: "模型代理：Responses API，model 填 Pi Bot 模型 ID",
    body: z.object({
      model: z.string().optional(),
      input: z.union([z.string(), z.array(z.unknown())]),
      max_output_tokens: z.number().int().positive().optional(),
      stream: z.boolean().optional(),
    }).passthrough(),
    tx: false,
    handler: async ({ db, s, llm, body, reply,req }) => {
      const model = await db.tx((tx) => findModel(tx, body.model));
      let correlation: {run:Row;generationId?:string;parentTool?:string}|undefined;
      if(req.headers['x-pibot-run-id']){
        const fields=z.object({runId:uuid,generationId:uuid,parentTool:z.string().max(200).optional()}).safeParse({runId:req.headers['x-pibot-run-id'],generationId:req.headers['x-pibot-generation-id'],parentTool:req.headers['x-pibot-parent-tool-id']});
        if(!fields.success)fail(422,'运行关联头无效');
        const {runId,generationId,parentTool}=fields.data!;
        const run=await db.tx(tx=>callerRun(tx,llm!.sub,llm!,runId));
        correlation={run,generationId,parentTool};
      }
      const abort = new AbortController();
      const onClose = () => abort.abort();
      reply.raw.once("close", onClose);
      try { await proxyResponses(db, s, llm!, model, body, reply, abort.signal,correlation); }
      finally { reply.raw.off("close", onClose); }
      return reply;
    },
  },
  {
    method: "GET", path: "/admin/api/overview", auth: "admin", tag: "admin", summary: "概览",
    handler: async ({ tx, hub }) => {
      const users = await tx.rows("SELECT user_id FROM users WHERE NOT disabled");
      const [counts] = await tx.rows(`SELECT
        (SELECT count(*) FROM users) AS users,
        (SELECT count(*) FROM bots WHERE archived_at IS NULL) AS bots,
        (SELECT count(*) FROM models WHERE enabled) AS models,
        (SELECT count(*) FROM bot_runs WHERE created_at > now() - interval '1 day') AS runs_today,
        (SELECT coalesce(sum(input_tokens+output_tokens),0) FROM usage_logs WHERE created_at > now() - interval '1 day') AS tokens_today`);
      return { ...counts, devices_online: hub.count() };
    },
  },
  {
    method: "GET", path: "/admin/api/users", auth: "admin", tag: "admin", summary: "用户列表",
    handler: async ({ tx, hub }) => {
      const rows = await tx.rows(`SELECT u.*, (SELECT count(*) FROM bots b WHERE b.user_id=u.user_id AND b.archived_at IS NULL) AS bot_count FROM users u ORDER BY u.created_at`);
      return Promise.all(rows.map(async u => ({ ...userOut(u), bot_count: u.bot_count, devices: await deviceList(tx,hub,u.user_id), computer: await computerStatus(tx,hub,u.user_id) })));

    },
  },
  {
    method: "POST", path: "/admin/api/users", auth: "admin", tag: "admin", summary: "创建用户",
    body: z.object({ username, password, display_name: z.string().trim().max(80).default(""), role: z.enum(["admin", "user"]).default("user") }),
    handler: async ({ tx, body }) => {
      if (await tx.one("SELECT 1 FROM users WHERE lower(username)=lower($1)", [body.username])) fail(409, "用户名已存在");
      return userOut(await tx.insert("users", { user_id: randomUUID(), username: body.username, display_name: body.display_name, password_hash: await passwordHash(body.password), role: body.role }));
    },
  },
  {
    method: "PATCH", path: "/admin/api/users/:id", auth: "admin", tag: "admin", summary: "修改用户（重置密码、角色、禁用）",
    body: z.object({ password: password.optional(), display_name: z.string().trim().max(80).optional(), role: z.enum(["admin", "user"]).optional(), disabled: z.boolean().optional() }),
    handler: async ({ tx, hub, user, params, body, after }) => {
      const target = await tx.get("users", params.id, true);
      if (target.user_id === user.user_id && (body.disabled || body.role === "user")) fail(400, "不能禁用自己或取消自己的管理员身份");
      const updated = await tx.update("users", params.id, {
        password_hash: body.password ? await passwordHash(body.password) : undefined,
        display_name: body.display_name, role: body.role, disabled: body.disabled, updated_at: new Date(),
      });
      if (body.disabled) {
        const devices = await tx.rows("SELECT device_id FROM devices WHERE user_id=$1 AND revoked_at IS NULL", [params.id]);
        after(() => devices.forEach(d => hub.kick(d.device_id)));
      }
      return userOut(updated);
    },
  },
  {
    method: "DELETE", path: "/admin/api/users/:id", auth: "admin", tag: "admin", summary: "删除用户及其 Bot 记录",
    handler: async ({ tx, hub, user, params, after }) => {
      if (params.id === user.user_id) fail(400, "不能删除自己");
      const devices = await tx.rows("SELECT device_id FROM devices WHERE user_id=$1 AND revoked_at IS NULL", [params.id]);
      await tx.get("users", params.id, true);
      await tx.rows("DELETE FROM users WHERE user_id=$1", [params.id]);
      after(() => devices.forEach(d => hub.kick(d.device_id)));
      return { ok: true };
    },
  },
  {
    method: "GET", path: "/admin/api/models", auth: "admin", tag: "admin", summary: "模型列表",
    handler: async ({ tx }) => (await tx.rows("SELECT * FROM models ORDER BY created_at")).map(modelOut),
  },
  {
    method: "POST", path: "/admin/api/models", auth: "admin", tag: "admin", summary: "添加模型", body: modelFields,
    handler: async ({ tx, s, body }) => {
      if (body.max_tokens >= body.context_window) fail(422, "输出上限必须小于上下文长度");
      const id = randomUUID();
      const m = await tx.insert("models", {
        model_id: id, name: body.name, base_url: body.base_url, provider_model: body.provider_model,
        context_window: body.context_window, max_tokens: body.max_tokens, secret: new Vault(s.vaultFile).seal(body.api_key, id),
        enabled: body.enabled, is_default: false,
      });
      if (body.is_default) await setDefault(tx, id);
      await ensureDefault(tx);
      return modelOut(await tx.get("models", m.model_id));
    },
  },
  {
    method: "PATCH", path: "/admin/api/models/:id", auth: "admin", tag: "admin", summary: "修改模型（api_key 留空则保持不变）",
    body: modelFields.partial(),
    handler: async ({ tx, s, params, body }) => {
      const m = await tx.get("models", params.id, true);
      const next = { ...m, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
      if (next.max_tokens >= next.context_window) fail(422, "输出上限必须小于上下文长度");
      await tx.update("models", params.id, {
        name: body.name, base_url: body.base_url, provider_model: body.provider_model, context_window: body.context_window,
        max_tokens: body.max_tokens, enabled: body.enabled, updated_at: new Date(),
        secret: body.api_key ? new Vault(s.vaultFile).seal(body.api_key, params.id) : undefined,
        is_default: body.enabled === false ? false : undefined,
      });
      if (body.is_default) await setDefault(tx, params.id);
      await ensureDefault(tx);
      return modelOut(await tx.get("models", params.id));
    },
  },
  {
    method: "DELETE", path: "/admin/api/models/:id", auth: "admin", tag: "admin", summary: "删除模型（使用它的 Bot 改用默认模型）",
    handler: async ({ tx, params }) => {
      await tx.get("models", params.id, true);
      await tx.rows("DELETE FROM models WHERE model_id=$1", [params.id]);
      await ensureDefault(tx);
      return { ok: true };
    },
  },
  {
    method: "POST", path: "/admin/api/models/:id/test", auth: "admin", tag: "admin", summary: "测试模型连通性", tx: false,
    handler: async ({ db, s, user, params }) => {
      const m = await db.tx((tx) => tx.get("models", params.id, true));
      const started = Date.now();
      try {
        // Reasoning models spend the output budget on thinking before replying.
        // Test with the configured budget, rather than truncating them at 16 tokens.
        const r = await complete(m, new Vault(s.vaultFile).open(m.secret, m.model_id), [{ role: "user", content: "Reply with OK." }], m.max_tokens, 30000);
        await recordUsage(db, { sub: user.user_id, src: "test" }, m.model_id, r.usage);
        return { ok: true, latency_ms: Date.now() - started, reply: r.text.slice(0, 200) };
      } catch (e) {
        return { ok: false, latency_ms: Date.now() - started, error: e instanceof Error ? e.message : "测试失败" };
      }
    },
  },
  {
    method: "GET", path: "/admin/api/devices", auth: "admin", tag: "admin", summary: "全部电脑设备",
    handler: async ({ tx, hub }) => {
      const rows = await tx.rows("SELECT d.*, u.username FROM devices d JOIN users u USING(user_id) ORDER BY d.revoked_at NULLS FIRST, d.created_at DESC LIMIT 500");
      return rows.map((d) => ({ ...deviceOut(d, !d.revoked_at && !!hub.device(d.user_id,d.device_id)), username: d.username }));
    },
  },
  {
    method: "POST", path: "/admin/api/devices/:id/revoke", auth: "admin", tag: "admin", summary: "吊销设备",
    handler: async ({ tx, db, hub, params, after }) => {
      const d = await tx.update("devices", params.id, { revoked_at: new Date() });
      after(async () => { hub.kick(d.device_id); await failDeviceRuns(db,d.device_id,"执行电脑已解绑",false); });
      return deviceOut(d, false);
    },
  },
  {
    method: "GET", path: "/admin/api/search/usage", auth: "admin", tag: "admin", summary: "Tavily 搜索剩余额度",
    tx: false,
    handler: async ({ webSearch }) => webSearch.usage(),
  },
  {
    method: "GET", path: "/admin/api/usage", auth: "admin", tag: "admin", summary: "用量统计",
    query: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
    handler: async ({ tx, query }) => {
      const since = new Date(Date.now() - query.days * 86400_000);
      const [byUser, byModel, byDay] = await Promise.all([
        tx.rows(`SELECT u.username, l.user_id, count(*) AS calls, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens
          FROM usage_logs l LEFT JOIN users u USING(user_id) WHERE l.created_at>=$1 GROUP BY 1,2 ORDER BY sum(input_tokens+output_tokens) DESC`, [since]),
        tx.rows(`SELECT m.name, l.model_id, count(*) AS calls, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens
          FROM usage_logs l LEFT JOIN models m USING(model_id) WHERE l.created_at>=$1 GROUP BY 1,2 ORDER BY sum(input_tokens+output_tokens) DESC`, [since]),
        tx.rows(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, source, count(*) AS calls, sum(input_tokens+output_tokens) AS tokens
          FROM usage_logs WHERE created_at>=$1 GROUP BY 1,2 ORDER BY 1`, [since]),
      ]);
      const num = (rows: Row[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^\d+$/.test(v) && k !== "day" ? Number(v) : v])));
      return { days: query.days, by_user: num(byUser), by_model: num(byModel), by_day: num(byDay) };
    },
  },
];
