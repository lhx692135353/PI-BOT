import { realPath, resolvePath, command } from "./core.mjs";
import http from "node:http";
import { createConnection } from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
const exec = promisify(execFile);
const base = process.env.PI_BOT_GUEST_ROOT || "/home/pibot/workspaces";
const socket =
  process.env.PI_BOT_GUEST_SOCKET ||
  `/tmp/pibot-remote-${process.getuid()}.sock`;
const browsers = new Map(),
  active = new Map();
const inside = (root, value) =>
  value === root || value.startsWith(root + path.sep);
async function action(q, signal) {
  if (q.action === "health") {
    await exec("xdotool", ["getdisplaygeometry"]);
    await fs.access(chromium.executablePath());
    await exec("scrot", ["--version"]);
    await Promise.all(
      [5901, 5902].map(
        (port) =>
          new Promise((resolve, reject) => {
            const socket = createConnection({ host: "127.0.0.1", port });
            socket.setTimeout(2000);
            socket.once("connect", () => {
              socket.destroy();
              resolve();
            });
            socket.once("error", () => reject(new Error("VNC 服务未就绪")));
            socket.once("timeout", () => {
              socket.destroy();
              reject(new Error("VNC 服务未就绪"));
            });
          }),
      ),
    );
    return {
      version: 1,
      platform: "linux",
      root: base,
      capabilities: ["shell", "files", "browser", "desktop", "vnc"],
    };
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(q.slug || ""))
    throw new Error("无效资料库");
  await fs.mkdir(base, { recursive: true });
  const root = await realPath(path.join(base, q.slug));
  if (!inside(await fs.realpath(base), root)) throw new Error("无效资料库");
  await fs.mkdir(root, { recursive: true });
  const a = q.args || {},
    allowed = await Promise.all((q.approved || []).map(realPath));
  const file = async (input) => resolvePath(root, input, allowed);
  const resultPath = async (ext) => {
    const out = path.join(root, "outputs");
    await fs.mkdir(out, { recursive: true });
    return path.join(out, randomUUID() + ext);
  };
  switch (q.action) {
    case "validate_approval": {
      const p = await realPath(path.resolve(a.path));
      if (["/", path.dirname(base), "/home", "/root"].includes(p))
        throw new Error("不能授权整个磁盘或主目录");
      return { path: p };
    }
    case "list_files": {
      const dir = await file(a.path);
      const entries = [];
      for (const name of (await fs.readdir(dir)).slice(0, 1000)) {
        const p = await file(path.join(dir, name)).catch(() => null);
        if (!p) continue;
        const s = await fs.stat(p);
        entries.push({
          name,
          type: s.isDirectory() ? "dir" : "file",
          size: s.size,
          modified: s.mtime.toISOString(),
        });
      }
      return { path: path.relative(root, dir), entries };
    }
    case "read_file": {
      const p = await file(a.path),
        s = await fs.stat(p);
      if (s.size > 4_000_000) throw new Error("文本过大，请下载后处理");
      const b = await fs.readFile(p);
      if (b.includes(0)) throw new Error("二进制文件请下载");
      const content = b
        .toString("utf8")
        .split("\n")
        .slice((a.offset || 1) - 1, (a.offset || 1) - 1 + (a.limit || 2000))
        .join("\n");
      return {
        content: content.slice(0, 262144),
        truncated: content.length > 262144,
      };
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
      const p = await file(a.path);
      const content = await fs.readFile(p, "utf8");
      if (!a.old_text) throw new Error("old_text 不能为空");
      const count = content.split(a.old_text).length - 1;
      if (!count || (count > 1 && !a.replace_all))
        throw new Error("原文不匹配或不唯一");
      await fs.writeFile(
        p,
        a.replace_all
          ? content.split(a.old_text).join(a.new_text)
          : content.replace(a.old_text, () => a.new_text),
      );
      return { path: p };
    }
    case "run_command":
      return command(
        a.command,
        await file(a.cwd),
        Math.min(600, Math.max(1, a.timeout_seconds || 120)) * 1000,
        signal,
      );
    case "upload": {
      const p = await file(a.path),
        b = Buffer.from(a.base64, "base64");
      if (b.length > 4_000_000) throw new Error("每次上传最多 4MB");
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, b);
      return { path: p, size: b.length };
    }
    case "download": {
      const p = await file(a.path);
      const s = await fs.stat(p);
      if (!s.isFile() || s.size > 6_000_000)
        throw new Error("预览限 6MB，大文件请使用下载接口");
      return {
        path: p,
        base64: (await fs.readFile(p)).toString("base64"),
        size: s.size,
      };
    }
    case "artifact": {
      const p = await file(a.path);
      if (!(await fs.stat(p)).isFile()) throw new Error("不是文件");
      return { path: p };
    }
    case "desktop_screenshot": {
      const p = await resultPath(".png");
      await exec("scrot", ["-o", p]);
      return {
        path: p,
        image: {
          mime: "image/png",
          data: (await fs.readFile(p)).toString("base64"),
        },
      };
    }
    case "desktop_input": {
      const n = (v) => String(Math.max(0, Math.min(10000, Number(v) || 0)));
      if (a.type === "click")
        await exec("xdotool", [
          "mousemove",
          n(a.x),
          n(a.y),
          "click",
          String(a.button || 1),
        ]);
      else if (a.type === "drag")
        await exec("xdotool", [
          "mousemove",
          n(a.x),
          n(a.y),
          "mousedown",
          "1",
          "sleep",
          "0.2",
          "mousemove",
          n(a.x2),
          n(a.y2),
          "mouseup",
          "1",
        ]);
      else if (a.type === "move")
        await exec("xdotool", ["mousemove", n(a.x), n(a.y)]);
      else if (a.type === "key") await exec("xdotool", ["key", "--", a.key]);
      else if (a.type === "text") {
        await new Promise((resolve, reject) => {
          const c = spawn("xclip", ["-selection", "clipboard"], {
            stdio: ["pipe", "ignore", "ignore"],
          });
          c.on("error", reject).on("close", (code) =>
            code === 0 ? resolve() : reject(new Error("剪贴板不可用")),
          );
          c.stdin.on("error", reject);
          c.stdin.end(a.text);
        });
        await exec("xdotool", ["key", "--clearmodifiers", "ctrl+v"]);
      } else if (a.type === "scroll")
        await exec("xdotool", [
          "click",
          "--repeat",
          String(Math.min(30, Math.max(1, a.steps || 1))),
          a.direction === "up" ? "4" : "5",
        ]);
      else throw new Error("未知输入");
      return { ok: true };
    }
    case "browser": {
      let context = browsers.get(q.slug);
      if (!context) {
        context = await chromium.launchPersistentContext(
          path.join(root, ".browser"),
          {
            headless: false,
            chromiumSandbox: true,
            viewport: { width: 1280, height: 800 },
            acceptDownloads: true,
          },
        );
        browsers.set(q.slug, context);
        context.on("close", () => browsers.delete(q.slug));
      }
      const page = context.pages()[a.tab || 0] || (await context.newPage());
      page.setDefaultTimeout(15000);
      const locator = () =>
        a.role
          ? page.getByRole(a.role, { name: a.name, exact: true })
          : page.locator(a.selector);
      if (a.op === "open") {
        const url = new URL(a.url);
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error("仅支持 HTTP(S)");
        await page.goto(url.href, { waitUntil: "domcontentloaded" });
      } else if (a.op === "click") await locator().click();
      else if (a.op === "fill") await locator().fill(a.text);
      else if (a.op === "key") await page.keyboard.press(a.key);
      else if (a.op === "upload")
        await locator().setInputFiles(await file(a.path));
      else if (a.op === "download") {
        const wait = page.waitForEvent("download");
        await locator().click();
        const d = await wait,
          p = await resultPath(path.extname(d.suggestedFilename()) || ".bin");
        await d.saveAs(p);
        return { path: p };
      } else if (a.op === "screenshot") {
        const p = await resultPath(".png");
        await page.screenshot({ path: p });
        return {
          path: p,
          image: {
            mime: "image/png",
            data: (await fs.readFile(p)).toString("base64"),
          },
        };
      } else if (a.op === "close") {
        await context.close();
        return { ok: true };
      } else if (!["read", "tabs"].includes(a.op))
        throw new Error("未知浏览器操作");
      return {
        url: page.url(),
        title: await page.title(),
        text: (await page.locator("body").innerText()).slice(0, 20000),
        snapshot: (await page.locator("body").ariaSnapshot()).slice(0, 20000),
        tabs: context.pages().map((p, index) => ({ index, url: p.url() })),
      };
    }
    default:
      throw new Error("未知操作");
  }
}
const server = http.createServer(async (req, res) => {
  let data = "";
  try {
    for await (const b of req) {
      data += b;
      if (data.length > 8_000_000) throw new Error("请求过大");
    }
    const q = JSON.parse(data);
    if (q.action === "cancel") {
      const running = active.get(q.operation_id);
      running?.abort();
      await running?.done;
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const controller = new AbortController();
    let closing, finish;
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    const abort = () => {
      controller.abort();
      if (q.action === "browser") {
        closing ??= browsers
          .get(q.slug)
          ?.close()
          .catch(() => {});
      }
    };
    res.on("close", abort);
    if (active.has(q.operation_id)) throw new Error("操作已在执行，不能重放");
    active.set(q.operation_id, { abort, done });
    const timer = setTimeout(abort, 620000);
    try {
      const result = await action(q, controller.signal);
      res.off("close", abort);
      res.end(JSON.stringify({ result }));
    } finally {
      await closing;
      clearTimeout(timer);
      active.delete(q.operation_id);
      finish();
      res.off("close", abort);
    }
  } catch (e) {
    res.end(JSON.stringify({ error: e.message }));
  }
});
await fs.unlink(socket).catch(() => {});
server.listen(socket, () => fs.chmod(socket, 0o600));
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    for (const c of active.values()) c.abort();
    for (const b of browsers.values()) await b.close();
    server.close(() => process.exit());
  });
