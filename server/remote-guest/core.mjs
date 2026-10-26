import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const inside = (root, value) =>
  value === root || value.startsWith(root + path.sep);
export async function realPath(input) {
  let ancestor = input;
  while (!(await fs.lstat(ancestor).catch(() => null))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return path.resolve(
    await fs.realpath(ancestor),
    path.relative(ancestor, input),
  );
}
export async function resolvePath(root, input = ".", approved = []) {
  const full = path.resolve(root, input),
    real = await realPath(full);
  if (![root, ...approved].some((r) => inside(r, real)))
    throw new Error("路径超出资料库，请先申请访问：" + full);
  return real;
}
export function command(command, cwd, timeout, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("操作已取消"));
    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      env: { ...process.env, PI_BOT_LIBRARY: cwd },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      timed_out = false;
    const append = (b) => {
      output = (output + b.toString("utf8")).slice(-30000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 1500).unref();
    };
    const timer = setTimeout(() => {
      timed_out = true;
      stop();
    }, timeout);
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(new Error("命令无法启动"));
    });
    child.once("close", (exit_code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({ exit_code, timed_out, cancelled: signal.aborted, output });
    });
  });
}
