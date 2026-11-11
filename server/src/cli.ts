export type CliRuntime = "cursor" | "codex";
export const CLI_OFFLINE = "这台电脑不在线，CLI 智能体无法在云端运行";

export function isCliRuntime(runtime: unknown): runtime is CliRuntime {
  return runtime === "cursor" || runtime === "codex";
}

/** Accepts a path from the user's computer. The API host's own platform is not the client's. */
export function absoluteClientPath(value: string) {
  const path = value.trim();
  const unix = path.startsWith("/");
  const windows = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  if (!path || path.length > 2000 || path.includes("\0") || /[\r\n]/.test(path) || (!unix && !windows))
    return null;
  if (path.split(/[\\/]/).includes("..")) return null;
  return path;
}
