import { RuntimeError } from "@pi-bot/runtime-contracts";
import { createReadStream, createWriteStream, promises as fs, realpath, rename, unlink } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SFTPWrapper } from "ssh2";
import { command, realPath, resolvePath } from "../../remote-guest/core.mjs";
import type { RemoteConnection } from "./transport.js";

export const LOCAL_CAPABILITIES = ["shell", "files", "preflight-v1"];
const inside = (root: string, value: string) => value === root || value.startsWith(root + path.sep);
/** Commands get a minimal environment so the API's own secrets never reach the agent shell. */
const commandEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: homedir(),
  LANG: process.env.LANG || "C.UTF-8",
  TZ: process.env.TZ,
  TERM: "dumb",
});

/** Runs the remote-guest action protocol in the API process, against the API host or its container. */
export function connectLocal(base: string): RemoteConnection {
  const active = new Map<string, { abort(): void; done: Promise<void> }>();
  let alive = true;
  async function action(q: any, signal: AbortSignal) {
    if (q.action === "health") {
      await fs.mkdir(base, { recursive: true });
      await fs.access(base, fs.constants.W_OK);
      return { version: 1, platform: process.platform === "darwin" ? "macos" : "linux", root: base, capabilities: LOCAL_CAPABILITIES };
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(q.slug || "")) throw new Error("无效资料库");
    if (q.action === "preflight") {
      try {
        const baseReal = await fs.realpath(base), folder = path.join(baseReal, q.slug);
        if ((await fs.lstat(folder)).isSymbolicLink()) return { available: false };
        const root = await fs.realpath(folder);
        if (!inside(baseReal, root)) return { available: false };
        const paths = q.args?.paths;
        if (!Array.isArray(paths) || paths.length > 20) return { available: false };
        for (const p of paths) await fs.stat(await resolvePath(root, p, []));
        return { available: true };
      } catch { return { available: false }; }
    }
    await fs.mkdir(base, { recursive: true });
    const root = await realPath(path.join(base, q.slug));
    if (!inside(await fs.realpath(base), root)) throw new Error("无效资料库");
    await fs.mkdir(root, { recursive: true });
    const a = q.args || {}, allowed = (q.approved || []).map((p: string) => path.resolve(p));
    const file = (input?: string) => resolvePath(root, input, allowed);
    switch (q.action) {
      case "validate_approval": {
        const p = await realPath(path.resolve(a.path));
        if (["/", path.dirname(base), homedir(), "/home", "/root"].includes(p)) throw new Error("不能授权整个磁盘或主目录");
        const info = await fs.stat(p).catch(() => null);
        if (a.access === "read" && !info) throw new Error("读取授权需要已存在的文件或目录");
        return { path: p, resource_type: info?.isDirectory() ? "directory" : "file" };
      }
      case "list_files": {
        const dir = await file(a.path), entries = [];
        for (const name of (await fs.readdir(dir)).slice(0, 1000)) {
          const p = await file(path.join(dir, name)).catch(() => null);
          if (!p) continue;
          const s = await fs.stat(p).catch(() => null);
          if (!s) continue;
          entries.push({ name, type: s.isDirectory() ? "dir" : "file", size: s.size, modified: s.mtime.toISOString() });
        }
        return { path: path.relative(root, dir), entries };
      }
      case "read_file": {
        const p = await file(a.path), s = await fs.stat(p);
        if (s.size > 4_000_000) throw new Error("文本过大，请下载后处理");
        const b = await fs.readFile(p);
        if (b.includes(0)) throw new Error("二进制文件请下载");
        const content = b.toString("utf8").split("\n").slice((a.offset || 1) - 1, (a.offset || 1) - 1 + (a.limit || 2000)).join("\n");
        return { content: content.slice(0, 262144), truncated: content.length > 262144 };
      }
      case "write_file": {
        const p = await file(a.path);
        await fs.mkdir(path.dirname(p), { recursive: true });
        const tmp = p + "." + randomUUID() + ".tmp";
        await fs.writeFile(tmp, a.content);
        await fs.rename(tmp, p);
        return { path: p };
      }
      case "edit_file": {
        const p = await file(a.path), content = await fs.readFile(p, "utf8");
        if (!a.old_text) throw new Error("old_text 不能为空");
        const count = content.split(a.old_text).length - 1;
        if (!count || (count > 1 && !a.replace_all)) throw new Error("原文不匹配或不唯一");
        await fs.writeFile(p, a.replace_all ? content.split(a.old_text).join(a.new_text) : content.replace(a.old_text, () => a.new_text));
        return { path: p };
      }
      case "run_command":
        return command(a.command, await file(a.cwd), Math.min(600, Math.max(1, a.timeout_seconds || 120)) * 1000, signal, commandEnv());
      case "upload": {
        const p = await file(a.path), b = Buffer.from(a.base64, "base64");
        if (b.length > 4_000_000) throw new Error("每次上传最多 4MB");
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, b);
        return { path: p, size: b.length };
      }
      case "download": {
        const p = await file(a.path), s = await fs.stat(p);
        if (!s.isFile() || s.size > 6_000_000) throw new Error("预览限 6MB，大文件请使用下载接口");
        return { path: p, base64: (await fs.readFile(p)).toString("base64"), size: s.size };
      }
      case "artifact": {
        const p = await file(a.path);
        if (!(await fs.stat(p)).isFile()) throw new Error("不是文件");
        return { path: p };
      }
      case "browser":
      case "desktop_screenshot":
      case "desktop_input":
        throw new Error("服务端本机环境没有浏览器和桌面，请改用文件与命令工具");
      default:
        throw new Error("未知操作");
    }
  }
  const call = async (q: any, signal?: AbortSignal) => {
    if (!alive) throw new RuntimeError({ code: "transport_closed", scope: "remote", retryable: false, outcome: "not_started", message: "本机执行环境已关闭" });
    if (q.action === "cancel") {
      const running = active.get(q.operation_id);
      running?.abort();
      await running?.done;
      return { ok: true };
    }
    if (signal?.aborted) throw new Error("操作已取消");
    if (active.has(q.operation_id)) throw new Error("操作已在执行，不能重放");
    const controller = new AbortController(), abort = () => controller.abort();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    active.set(q.operation_id, { abort, done });
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 620000);
    try {
      return await action(q, controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      active.delete(q.operation_id);
      finish();
    }
  };
  const sftp = {
    realpath: (p: string, cb: (error: Error | null, value?: string) => void) => realpath(p, (e, value) => cb(e, value)),
    createReadStream: (p: string) => createReadStream(p),
    createWriteStream: (p: string) => createWriteStream(p),
    ext_openssh_rename: (from: string, to: string, cb: (error: Error | null) => void) => rename(from, to, (e) => cb(e)),
    unlink: (p: string, cb: (error: Error | null) => void) => unlink(p, (e) => cb(e)),
    end: () => {},
  };
  return {
    alive: () => alive,
    call,
    sftp: async () => sftp as unknown as SFTPWrapper,
    forward: async () => { throw new Error("服务端本机环境没有云端桌面"); },
    close() {
      alive = false;
      for (const running of active.values()) running.abort();
    },
  };
}
