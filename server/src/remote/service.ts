import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Duplex } from "node:stream";
import type { Database, Row } from "../db.js";
import { fail } from "../db.js";
import type { Settings } from "../config.js";
import { ownEnvironment, remoteVault } from "./environments.js";
import {
  connectSsh,
  sshConfig,
  sshSecret,
  type RemoteConnection,
} from "./transport.js";
import { Kubevirt } from "./kubevirt.js";
export const GUI_ACTIONS = new Set([
  "browser",
  "desktop_input",
  "desktop_screenshot",
  "run_command",
]);
interface State {
  connection?: RemoteConnection;
  connecting?: Promise<RemoteConnection>;
  active: Map<
    string,
    { controller: AbortController; done: Promise<unknown>; gui: boolean }
  >;
  guiRun?: string;
  control?: { id: string; expires: number; close?: () => void };
  epoch: number;
  seen: Map<string, number>;
}
export class RemoteService {
  private states = new Map<string, State>();
  constructor(
    readonly db: Database,
    readonly s: Settings,
    private connector?: (env: Row) => Promise<RemoteConnection>,
  ) {}
  state(id: string) {
    let x = this.states.get(id);
    if (!x) {
      x = { active: new Map(), epoch: 0, seen: new Map() };
      this.states.set(id, x);
    }
    return x;
  }
  async connect(env: Row) {
    const state = this.state(env.environment_id);
    if (state.connection?.alive?.() === false) {
      state.connection.close();
      state.connection = undefined;
    }
    if (state.connection) return state.connection;
    if (!state.connecting)
      state.connecting = (async () => {
        try {
          if (env.status !== "retired")
            await this.db.tx((tx) =>
              tx.update("remote_environments", env.environment_id, {
                status: "preparing",
                error: null,
              }),
            );
          const secret = JSON.parse(
            remoteVault(this.s).open(env.secret, env.environment_id),
          );
          const c = this.connector
            ? await this.connector(env)
            : env.backend === "ssh"
              ? await connectSsh(
                  sshConfig.parse(env.config),
                  sshSecret.parse(secret),
                )
              : await new Kubevirt(this.s.kubevirt).connect(env, secret);
          try {
            const health = await c.call({
              action: "health",
              operation_id: randomUUID(),
            });
            if (health.version !== 1) throw new Error("操作组件版本不兼容");
            if (
              health.root &&
              posix.normalize(health.root) !==
                posix.normalize(
                  env.config.work_root || "/home/pibot/workspaces",
                )
            )
              throw new Error("后台工作目录与远端组件配置不一致");
            if (env.status !== "retired")
              await this.db.tx((tx) =>
                tx.update("remote_environments", env.environment_id, {
                  status: "ready",
                  capabilities: health.capabilities,
                  error: null,
                  updated_at: new Date(),
                }),
              );
            state.connection = c;
            return c;
          } catch (e) {
            c.close();
            throw e;
          }
        } catch (e) {
          if (env.status !== "retired")
            await this.db.tx((tx) =>
              tx.update("remote_environments", env.environment_id, {
                status: "offline",
                error: "连接失败，请检查 SSH、虚机状态和组件健康检查",
                updated_at: new Date(),
              }),
            );
          throw e;
        } finally {
          state.connecting = undefined;
        }
      })();
    return state.connecting;
  }
  expire(state: State) {
    if (state.control && state.control.expires <= Date.now()) {
      state.control.close?.();
      state.control = undefined;
      state.epoch++;
    }
  }
  async releaseRun(runId: string) {
    for (const state of this.states.values())
      if (state.guiRun === runId) {
        state.guiRun = undefined;
        state.seen.delete(runId);
      }
  }
  async action(
    env: Row,
    run: Row,
    slug: string,
    callId: string,
    action: string,
    args: Row,
    signal?: AbortSignal,
    approved: string[] = [],
  ) {
    const state = this.state(env.environment_id);
    this.expire(state);
    const gui = GUI_ACTIONS.has(action);
    if (gui) {
      if ([...state.active.values()].some((a) => a.gui))
        fail(409, "云端界面操作正在执行，请等待完成");
      if (state.control)
        fail(409, "用户正在人工接管，云端浏览器、桌面和命令操作已暂停");
      if (state.guiRun && state.guiRun !== run.run_id) {
        const previous = await this.db.tx((tx) =>
          tx.get("bot_runs", state.guiRun!),
        );
        if (
          previous &&
          ["queued", "running", "waiting_approval"].includes(previous.status)
        )
          fail(409, "另一任务正在使用云端桌面，请稍后继续");
        state.guiRun = undefined;
      }
      const seen = state.seen.get(run.run_id);
      if (
        seen !== undefined &&
        seen !== state.epoch &&
        !["desktop_screenshot"].includes(action) &&
        !(
          action === "browser" &&
          ["read", "tabs", "screenshot"].includes(args.op)
        )
      )
        fail(409, "人工接管已改变界面，请先重新截图或读取页面后继续");
      state.guiRun = run.run_id;
      if (!state.seen.has(run.run_id)) state.seen.set(run.run_id, state.epoch);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const key = run.run_id + ":" + callId;
    let finish!: () => void;
    const done = new Promise<void>((r) => {
      finish = r;
    });
    state.active.set(key, { controller, done, gui });
    let busy = false;
    const poll = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.db
        .tx(async (tx) => {
          const r = await tx.one(
            "SELECT r.status,r.cancel_requested,u.disabled FROM bot_runs r JOIN users u USING(user_id) WHERE run_id=$1",
            [run.run_id],
          );
          if (
            !r ||
            r.disabled ||
            r.cancel_requested ||
            !["running", "waiting_approval"].includes(r.status)
          )
            controller.abort();
        })
        .catch(abort)
        .finally(() => {
          busy = false;
        });
    }, 1000);
    try {
      const connection = await new Promise<RemoteConnection>(
        (resolve, reject) => {
          const onAbort = () => reject(new Error("操作已取消"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          if (controller.signal.aborted) {
            onAbort();
            return;
          }
          this.connect(env)
            .then(resolve, reject)
            .finally(() =>
              controller.signal.removeEventListener("abort", onAbort),
            );
        },
      );
      const cancel = () => {
        void connection
          .call({ action: "cancel", operation_id: key })
          .catch(() => {});
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        if (controller.signal.aborted) throw new Error("操作已取消");
        const result = await connection.call(
          { operation_id: key, action, args, slug, approved },
          controller.signal,
        );
        if (gui) state.seen.set(run.run_id, state.epoch);
        return result;
      } finally {
        controller.signal.removeEventListener("abort", cancel);
      }
    } catch (e) {
      if (
        !controller.signal.aborted &&
        e instanceof Error &&
        /SSH|连接中断|组件连接/.test(e.message)
      ) {
        state.connection?.close();
        state.connection = undefined;
        await this.db
          .tx((tx) =>
            tx.update("remote_environments", env.environment_id, {
              status: "offline",
              error: "SSH 通道中断，请检查网络和虚机状态",
            }),
          )
          .catch(() => {});
      }
      throw e;
    } finally {
      clearInterval(poll);
      signal?.removeEventListener("abort", abort);
      state.active.delete(key);
      finish();
    }
  }
  async acquire(env: Row) {
    const state = this.state(env.environment_id);
    this.expire(state);
    if (state.control) fail(409, "已有人工接管会话");
    const control = { id: randomUUID(), expires: Date.now() + 45000 };
    state.control = control;
    state.epoch++;
    const active = [...state.active.entries()].filter(([, item]) => item.gui),
      connection = state.connection;
    for (const [, item] of active) item.controller.abort();
    try {
      if (connection)
        await Promise.all(
          active.map(([key]) =>
            connection.call(
              { action: "cancel", operation_id: key },
              AbortSignal.timeout(10000),
            ),
          ),
        );
      await Promise.all(active.map(([, item]) => item.done));
      control.expires = Date.now() + 45000;
    } catch {
      state.control = undefined;
      fail(
        409,
        "未能确认远端操作已停止，未授予控制；请先核实虚机进程状态和网络连接",
      );
    }
    return control;
  }
  renew(id: string, sessionId: string) {
    const state = this.state(id);
    this.expire(state);
    if (state.control?.id !== sessionId) fail(409, "接管会话已过期");
    state.control!.expires = Date.now() + 45000;
    return state.control;
  }
  release(id: string, sessionId: string) {
    const state = this.state(id);
    if (state.control?.id === sessionId) {
      state.control.close?.();
      state.control = undefined;
      state.epoch++;
    }
  }
  async desktop(
    env: Row,
    sessionId: string | undefined,
  ): Promise<{ stream: Duplex; check(): boolean }> {
    const state = this.state(env.environment_id);
    this.expire(state);
    if (sessionId) this.renew(env.environment_id, sessionId);
    const c = await this.connect(env);
    const stream = await c.forward(sessionId ? 5901 : 5902);
    if (sessionId) state.control!.close = () => stream.destroy();
    return {
      stream,
      check: () => {
        this.expire(state);
        return !sessionId || state.control?.id === sessionId;
      },
    };
  }
  async file(
    userId: string,
    botId: string,
    envId: string,
    path: string,
    writing = false,
  ) {
    const env = await this.db.tx((tx) =>
        ownEnvironment(tx, this.s, userId, envId, true),
      ),
      bot = await this.db.tx((tx) =>
        tx.one(
          "SELECT * FROM bots WHERE user_id=$1 AND bot_id=$2 AND archived_at IS NULL",
          [userId, botId],
        ),
      );
    if (!bot) fail(404, "Bot 不存在");
    const root = posix.join(
      env.config.work_root || "/home/pibot/workspaces",
      bot!.slug,
    );
    const full = posix.resolve(root, path);
    if (full !== root && !full.startsWith(root + "/"))
      fail(403, "文件超出资料库");
    const c = await this.connect(env),
      sftp = await c.sftp();
    const canonical = (path: string) =>
      new Promise<string>((resolve, reject) =>
        sftp.realpath(path, (error, value) =>
          error ? reject(error) : resolve(value),
        ),
      );
    try {
      const base = await canonical(
          env.config.work_root || "/home/pibot/workspaces",
        ),
        rootReal = await canonical(root);
      if (!rootReal.startsWith(base + "/")) fail(403, "资料库目录无效");
      const real = await canonical(full).catch(async (error) => {
        if (!writing) throw error;
        return posix.join(
          await canonical(posix.dirname(full)),
          posix.basename(full),
        );
      });
      if (real !== rootReal && !real.startsWith(rootReal + "/"))
        fail(403, "文件超出资料库");
      return { sftp, path: real };
    } catch (error) {
      sftp.end();
      throw error;
    }
  }

  async reset(id: string) {
    const state = this.states.get(id);
    if (state) {
      if (state.active.size || state.control || state.connecting)
        fail(409, "请先结束操作和人工接管，或等待环境准备完成");
      state.connection?.close();
      this.states.delete(id);
    }
  }
  close() {
    for (const state of this.states.values()) {
      for (const a of state.active.values()) a.controller.abort();
      state.control?.close?.();
      state.connection?.close();
    }
    this.states.clear();
  }
}
