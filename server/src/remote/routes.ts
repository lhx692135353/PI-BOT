import { z } from "zod";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { SignJWT, jwtVerify } from "jose";
import type { Route, Context } from "../routes.js";
import { fail, HttpError } from "../db.js";
import { callerRun } from "../agents.js";
import { recordAutomationEffect } from "../automations.js";
import { approvalScope, matchAuthorization, type Access } from '../authorizations.js';
import {
  ensureEnvironment,
  environmentOut,
  ownEnvironment,
  remoteVault,
} from "./environments.js";
import { sshConfig, sshSecret } from "./transport.js";
const uuid = z.string().uuid(),
  path = z.string().min(1).max(2000),
  empty = z.object({});
const args: Record<string, z.ZodType> = {
  list_files: z.object({ path: path.optional() }),
  read_file: z.object({
    path,
    offset: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  }),
  write_file: z.object({ path, content: z.string().max(2_000_000) }),
  edit_file: z.object({
    path,
    old_text: z.string().min(1),
    new_text: z.string(),
    replace_all: z.boolean().optional(),
  }),
  run_command: z.object({
    command: z.string().min(1).max(20000),
    cwd: path.optional(),
    timeout_seconds: z.number().int().min(1).max(600).optional(),
  }),
  desktop_screenshot: empty,
  desktop_input: z.object({
    type: z.enum(["click", "move", "drag", "key", "text", "scroll"]),
    x: z.number().int().min(0).max(10000).optional(),
    y: z.number().int().min(0).max(10000).optional(),
    x2: z.number().int().min(0).max(10000).optional(),
    y2: z.number().int().min(0).max(10000).optional(),
    button: z.number().int().min(1).max(3).optional(),
    key: z.string().min(1).max(100).optional(),
    text: z.string().max(20000).optional(),
    steps: z.number().int().min(1).max(30).optional(),
    direction: z.enum(["up", "down"]).optional(),
  }),
  browser: z.object({
    op: z.enum([
      "open",
      "read",
      "tabs",
      "click",
      "fill",
      "key",
      "upload",
      "download",
      "screenshot",
      "close",
    ]),
    url: z.string().url().optional(),
    selector: z.string().max(2000).optional(),
    role: z.string().max(100).optional(),
    name: z.string().max(500).optional(),
    text: z.string().max(20000).optional(),
    key: z.string().max(100).optional(),
    path: path.optional(),
    tab: z.number().int().min(0).max(30).optional(),
  }),
  artifact: z.object({ path }),
  request_outside_access: z.object({
    path,
    reason: z.string().min(1).max(1000),
    access: z.enum(['read','write','execute']).default('read'),
  }),
};
const mutation = (action: string, a: any) =>
  ["write_file", "edit_file", "run_command", "desktop_input"].includes(
    action,
  ) ||
  (action === "browser" && !["read", "tabs", "screenshot"].includes(a.op));
export async function remoteOperation(ctx: Context) {
  const body = ctx.body,
    schema = args[body.action];
  if (!schema) fail(422, "未知云端操作");
  const parsed = schema.safeParse(body.args);
  if (!parsed.success) fail(422, "操作参数无效");
  const a = parsed.data as any;
  const run = await ctx.db.tx((tx) =>
    callerRun(tx, ctx.user.user_id, ctx.llm!, body.run_id),
  );
  if (
    run.lane !== "task" ||
    !run.operation_target.startsWith("remote:") ||
    run.cancel_requested
  )
    fail(403, "本任务未授权云端机器操作");
  if (run.automation_readonly && mutation(body.action, a))
    fail(403, "当前检查只允许读取");
  const env = await ctx.db.tx((tx) =>
    ownEnvironment(tx, ctx.s, ctx.user.user_id, run.operation_target.slice(7)),
  );
  const bot = await ctx.db.tx((tx) => tx.get("bots", run.bot_id, true));
  const abort = new AbortController(),
    onClose = () => {
      if (!ctx.reply.raw.writableEnded) abort.abort();
    };
  ctx.reply.raw.once("close", onClose);
  try {
    const old = await ctx.db.tx((tx) =>
      tx.one("SELECT * FROM remote_operations WHERE run_id=$1 AND call_id=$2", [
        run.run_id,
        body.call_id,
      ]),
    );
    if (old) {
      if (old.status === "completed") return old.result;
      fail(409, "此操作已发起，结果需要核实，不能重放");
    }
    const added = await ctx.db.tx((tx) =>
      tx.one(
        "INSERT INTO remote_operations(run_id,call_id,action) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING call_id",
        [run.run_id, body.call_id, body.action],
      ),
    );
    if (!added) fail(409, "操作已发起");
    let result: any;
    if (body.action === "request_outside_access") {
      a.path = posix.normalize(a.path);
      if (
        !posix.isAbsolute(a.path) ||
        a.path === "/" ||
        /^\/home\/?$/.test(a.path) ||
        a.path === "/home/pibot"
      )
        fail(422, "请指定具体的绝对文件或目录路径");
      const validated = (
        await ctx.remote.action(
          env,
          run,
          bot.slug,
          body.call_id + "-validate",
          "validate_approval",
          a,
          abort.signal,
        )
      );
      a.path = validated.path;
      const matched = await ctx.db.tx(async tx => matchAuthorization(tx,await callerRun(tx,ctx.user.user_id,ctx.llm!,run.run_id),a.path,a.access));
      if (matched) result = {approved:true,path:a.path,access:a.access,remembered:true};
      else {
        const approval = await ctx.db.tx(async (tx) => {
          const v = await tx.insert("approvals", {
            approval_id: randomUUID(),
            run_id: run.run_id,
            bot_id: run.bot_id,
            user_id: run.user_id,
            kind: "outside_access",
            detail: {
              path: a.path,
              reason: a.reason,
              operation_target: run.operation_target,
              access: a.access,
              authorization_scope: await approvalScope(tx,run,a.path,a.access,validated.resource_type ?? 'unknown'),
            },
            status: "pending",
            expires_at: new Date(Date.now() + ctx.s.approvalTtl * 1000),
          });
          await tx.rows(
            "UPDATE bot_runs SET status='waiting_approval' WHERE run_id=$1",
            [run.run_id],
          );
          await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
          return v;
        });
        while (true) {
          if (abort.signal.aborted) throw new Error("操作已取消");
          const row = await ctx.db.tx(async (tx) => {
            const current = await tx.get("bot_runs", run.run_id);
            if (
              current.cancel_requested ||
              !["running", "waiting_approval"].includes(current.status)
            )
              throw new Error("任务已取消");
            return tx.get("approvals", approval.approval_id);
          });
          if (
            row.status !== "pending" ||
            new Date(row.expires_at).getTime() < Date.now()
          ) {
            result = { approved: row.status === "approved", path: a.path };
            await ctx.db.tx(async (tx) => {
              if (row.status === "pending")
                await tx.rows(
                  "UPDATE approvals SET status='expired' WHERE approval_id=$1",
                  [row.approval_id],
                );
              await tx.rows(
                "UPDATE bot_runs SET status='running' WHERE run_id=$1 AND status='waiting_approval' AND NOT EXISTS(SELECT 1 FROM approvals WHERE run_id=$1 AND status='pending')",
                [run.run_id],
              );
            });
            break;
          }
          await new Promise((r) => setTimeout(r, 750));
        }
      }
    } else {
      if (run.execution_policy === "device_only" && mutation(body.action, a))
        await ctx.db.tx((tx) =>
          recordAutomationEffect(tx, ctx.user.user_id, ctx.llm!, {
            run_id: run.run_id,
            tool_call_id: body.call_id,
            phase: "start",
            tool_name: body.action,
            summary: JSON.stringify(a).slice(0, 2000),
          }),
        );
      const operation: Access = ['read_file','list_files','artifact'].includes(body.action) ? 'read' : ['write_file','edit_file'].includes(body.action) ? 'write' : 'execute';
      const approved = await ctx.db.tx(async tx => {
        const current = await callerRun(tx,ctx.user.user_id,ctx.llm!,run.run_id);
        const once = await tx.rows("SELECT detail FROM approvals WHERE run_id=$1 AND status='approved' AND COALESCE(detail->>'remembered','false') <> 'true'",[run.run_id]);
        const paths = once.filter(x => !x.detail.access || x.detail.access === 'legacy' || x.detail.access === operation).map(x => x.detail.path);
        if (operation === 'read' && typeof a.path === 'string' && posix.isAbsolute(a.path)) {
          const rule = await matchAuthorization(tx,current,posix.normalize(a.path),operation);
          if (rule) paths.push(rule.resource);
        }
        return paths;
      });
      result = await ctx.remote.action(
        env,
        run,
        bot.slug,
        body.call_id,
        body.action,
        a,
        abort.signal,
        approved,
      );
      if (run.execution_policy === "device_only" && mutation(body.action, a))
        await ctx.db.tx((tx) =>
          recordAutomationEffect(tx, ctx.user.user_id, ctx.llm!, {
            run_id: run.run_id,
            tool_call_id: body.call_id,
            phase: "end",
            confirmed:
              body.action !== "run_command" ||
              (result.exit_code === 0 &&
                !result.timed_out &&
                !result.cancelled),
            result: JSON.stringify(result).slice(0, 4000),
          }),
        );
      if (
        result.path &&
        ["artifact", "desktop_screenshot", "browser"].includes(body.action)
      ) {
        const id = randomUUID();
        await ctx.db.tx((tx) =>
          tx.insert("remote_artifacts", {
            artifact_id: id,
            user_id: run.user_id,
            bot_id: bot.bot_id,
            environment_id: env.environment_id,
            path: result.path,
            name: posix.basename(result.path),
            mime: result.image?.mime ?? "application/octet-stream",
          }),
        );
        result.artifact = {
          id,
          name: posix.basename(result.path),
          url: `/remote/artifacts/${id}`,
          operation_target: run.operation_target,
        };
      }
    }
    await ctx.db.tx((tx) =>
      tx.rows(
        "UPDATE remote_operations SET status='completed',result=$3 WHERE run_id=$1 AND call_id=$2",
        [run.run_id, body.call_id, JSON.stringify(result)],
      ),
    );
    return result;
  } catch (e) {
    await ctx.db
      .tx((tx) =>
        tx.rows(
          "UPDATE remote_operations SET status='uncertain' WHERE run_id=$1 AND call_id=$2 AND status='started'",
          [run.run_id, body.call_id],
        ),
      )
      .catch(() => {});
    if (e instanceof HttpError) throw e;
    fail(502, e instanceof Error ? e.message.slice(0, 400) : "云端操作失败");
  } finally {
    ctx.reply.raw.off("close", onClose);
  }
}
export const remoteRoutes: Route[] = [
  {
    method: "POST",
    path: "/remote/artifacts/:id/open",
    auth: "actor",
    tag: "remote",
    summary: "打开自己的云端生成结果",
    tx: false,
    body: empty,
    handler: async (c) => {
      const artifact = await c.db.tx((tx) =>
        tx.one(
          "SELECT * FROM remote_artifacts WHERE artifact_id=$1 AND user_id=$2",
          [c.params.id, c.user.user_id],
        ),
      );
      if (!artifact) fail(404, "结果不存在");
      await c.db.tx((tx) =>
        ownEnvironment(tx, c.s, c.user.user_id, artifact!.environment_id, true),
      );
      const token = await new SignJWT({
        typ: "remote-launch",
        environment: artifact!.environment_id,
        bot: artifact!.bot_id,
        artifact: artifact!.path,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(c.user.user_id)
        .setExpirationTime("1h")
        .setJti(randomUUID())
        .sign(new TextEncoder().encode(c.s.jwtSecret));
      return {
        url:
          "/remote-desktop/#token=" +
          token +
          "&bot=" +
          artifact!.bot_id +
          "&artifact=" +
          encodeURIComponent(artifact!.path),
      };
    },
  },
  {
    method: "POST",
    path: "/remote/desktop/open",
    auth: "actor",
    tag: "remote",
    summary: "打开云端桌面",
    tx: false,
    body: z.object({ bot_id: uuid.optional() }),
    handler: async (c) => {
      if (
        c.body.bot_id &&
        !(await c.db.tx((tx) =>
          tx.one(
            "SELECT 1 FROM bots WHERE bot_id=$1 AND user_id=$2 AND archived_at IS NULL",
            [c.body.bot_id, c.user.user_id],
          ),
        ))
      )
        fail(404, "Bot 不存在");
      const env = await c.db.tx((tx) =>
        ensureEnvironment(tx, c.s, c.user.user_id),
      );
      void c.remote.connect(env).catch(() => {});
      const token = await new SignJWT({
        typ: "remote-launch",
        environment: env.environment_id,
        bot: c.body.bot_id,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(c.user.user_id)
        .setJti(randomUUID())
        .setExpirationTime("1h")
        .sign(new TextEncoder().encode(c.s.jwtSecret));
      return {
        url:
          "/remote-desktop/#token=" +
          token +
          (c.body.bot_id ? "&bot=" + c.body.bot_id : ""),
      };
    },
  },
  {
    method: "GET",
    path: "/remote/environment",
    auth: "actor",
    tag: "remote",
    summary: "查看自己的云端环境",
    handler: async (c) =>
      environmentOut(
        await c.tx.one(
          "SELECT * FROM remote_environments WHERE user_id=$1 AND status<>'retired'",
          [c.user.user_id],
        ),
        c.s.remoteBackend,
      ),
  },
  {
    method: "POST",
    path: "/remote/environment/prepare",
    auth: "actor",
    tag: "remote",
    summary: "准备自己的云端环境",
    tx: false,
    body: empty,
    handler: async (c) => {
      const e = await c.db.tx((tx) =>
        ensureEnvironment(tx, c.s, c.user.user_id),
      );
      await c.remote.connect(e);
      return c.db.tx(async (tx) =>
        environmentOut(
          await tx.get("remote_environments", e.environment_id),
          c.s.remoteBackend,
        ),
      );
    },
  },
  {
    method: "GET",
    path: "/admin/api/users/:id/environment",
    auth: "admin",
    tag: "remote",
    summary: "用户云端环境配置",
    handler: async (c) =>
      environmentOut(
        await c.tx.one(
          "SELECT * FROM remote_environments WHERE user_id=$1 AND status<>'retired'",
          [c.params.id],
        ),
        c.s.remoteBackend,
      ),
  },
  {
    method: "POST",
    path: "/admin/api/users/:id/environment",
    auth: "admin",
    tag: "remote",
    summary: "配置用户唯一 SSH 环境",
    body: z.object({ config: sshConfig, secret: sshSecret.optional() }),
    handler: async (c) => {
      if (c.s.remoteBackend !== "ssh") fail(422, "启动配置未启用 SSH 后端");
      await c.tx.get("users", c.params.id, true);
      await c.tx.one("SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE", [
        c.params.id,
      ]);
      let old = await c.tx.one(
        "SELECT * FROM remote_environments WHERE user_id=$1 AND status<>'retired'",
        [c.params.id],
      );
      if (
        old &&
        (await c.tx.one(
          "SELECT 1 FROM bot_runs WHERE user_id=$1 AND status IN ('queued','running','waiting_approval') AND operation_target=$2",
          [c.params.id, "remote:" + old.environment_id],
        ))
      )
        fail(409, "请先结束云端任务再更换配置");
      if (old) await c.remote.reset(old.environment_id);
      if (!old && !c.body.secret) fail(422, "首次配置需要认证凭据");
      if (
        old &&
        (old.backend !== "ssh" ||
          ["host", "port", "username", "work_root"].some(
            (key) => old!.config[key] !== c.body.config[key],
          ))
      ) {
        if (!c.body.secret) fail(422, "更换机器需要填写新认证凭据");
        await c.tx.update("remote_environments", old.environment_id, {
          status: "retired",
          updated_at: new Date(),
        });
        old = undefined;
      }
      const id = old?.environment_id ?? randomUUID(),
        secret = c.body.secret
          ? remoteVault(c.s).seal(JSON.stringify(c.body.secret), id)
          : old!.secret;
      const data = {
        config: c.body.config,
        secret,
        status: "unconfigured",
        error: null,
        capabilities: [],
        updated_at: new Date(),
        revision: (old?.revision ?? 0) + 1,
      };
      const saved = old
        ? await c.tx.update("remote_environments", id, data)
        : await c.tx.insert("remote_environments", {
            ...data,
            environment_id: id,
            user_id: c.params.id,
            backend: "ssh",
          });
      return environmentOut(saved, c.s.remoteBackend);
    },
  },
  {
    method: "POST",
    path: "/admin/api/users/:id/environment/test",
    auth: "admin",
    tag: "remote",
    summary: "检测连接和操作能力",
    tx: false,
    body: empty,
    handler: async (c) => {
      const e = await c.db.tx((tx) => ensureEnvironment(tx, c.s, c.params.id));
      await c.remote.reset(e.environment_id);
      await c.remote.connect(e);
      return c.db.tx(async (tx) =>
        environmentOut(
          await tx.get("remote_environments", e.environment_id),
          c.s.remoteBackend,
        ),
      );
    },
  },
  {
    method: "POST",
    path: "/agent/remote/action",
    auth: "llm",
    tag: "remote",
    summary: "当前任务的云端操作",
    internal: true,
    tx: false,
    body: z.object({
      run_id: uuid,
      call_id: z.string().min(1).max(200),
      action: z.string().max(80),
      args: z.record(z.string(), z.unknown()).default({}),
    }),
    handler: remoteOperation,
  },
  {
    method: "POST",
    path: "/agent/remote/release",
    auth: "llm",
    tag: "remote",
    summary: "释放任务桌面会话",
    internal: true,
    tx: false,
    body: z.object({ run_id: uuid }),
    handler: async (c) => {
      await c.db.tx((tx) =>
        callerRun(tx, c.user.user_id, c.llm!, c.body.run_id),
      );
      await c.remote.releaseRun(c.body.run_id);
      return { ok: true };
    },
  },
  {
    method: "GET",
    path: "/bots/:id/remote/files",
    auth: "actor",
    tag: "remote",
    summary: "浏览云端资料库",
    tx: false,
    query: z.object({ path: path.optional() }),
    handler: async (c) => {
      const bot = await c.db.tx((tx) =>
        tx.one(
          "SELECT * FROM bots WHERE bot_id=$1 AND user_id=$2 AND archived_at IS NULL",
          [c.params.id, c.user.user_id],
        ),
      );
      if (!bot) fail(404, "Bot 不存在");
      const env = await c.db.tx((tx) =>
        ensureEnvironment(tx, c.s, c.user.user_id),
      );
      return (await c.remote.connect(env)).call({
        operation_id: randomUUID(),
        slug: bot!.slug,
        action: "list_files",
        args: c.query,
      });
    },
  },
  {
    method: "GET",
    path: "/bots/:id/remote/artifacts",
    auth: "actor",
    tag: "remote",
    summary: "云端生成结果",
    handler: async (c) =>
      c.tx.rows(
        "SELECT artifact_id AS id,name,mime,environment_id,created_at FROM remote_artifacts WHERE user_id=$1 AND bot_id=$2 ORDER BY created_at DESC LIMIT 100",
        [c.user.user_id, c.params.id],
      ),
  },
  ...(["view", "acquire", "renew", "release"] as const).map((action) => ({
    method: "POST" as const,
    path: `/remote/desktop/${action}`,
    auth: "actor" as const,
    tag: "remote",
    summary: `云端桌面 ${action}`,
    tx: false as const,
    body: z.object({ session_id: uuid.optional() }),
    handler: async (c: Context) => {
      const env = await c.db.tx((tx) =>
        ensureEnvironment(tx, c.s, c.user.user_id),
      );
      let sessionId: string | undefined;
      if (action === "renew" || action === "release") {
        if (!c.body.session_id) fail(422, "缺少会话");
        if (action === "renew")
          return c.remote.renew(env.environment_id, c.body.session_id);
        c.remote.release(env.environment_id, c.body.session_id);
        return { ok: true };
      }
      await c.remote.connect(env);
      if (action === "acquire") sessionId = (await c.remote.acquire(env)).id;
      const ticket = await new SignJWT({
        typ: "remote-desktop",
        environment: env.environment_id,
        session: sessionId,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(c.user.user_id)
        .setIssuedAt()
        .setExpirationTime("60s")
        .setJti(randomUUID())
        .sign(new TextEncoder().encode(c.s.jwtSecret));
      return { ticket, session_id: sessionId, expires_in: 60 };
    },
  })),
];
export async function readDesktopTicket(ticket: string, secret: string) {
  const { payload } = await jwtVerify(
    ticket,
    new TextEncoder().encode(secret),
    { algorithms: ["HS256"] },
  );
  if (
    payload.typ !== "remote-desktop" ||
    typeof payload.sub !== "string" ||
    typeof payload.environment !== "string"
  )
    throw new Error("无效凭据");
  return payload as typeof payload & {
    sub: string;
    environment: string;
    session?: string;
  };
}
