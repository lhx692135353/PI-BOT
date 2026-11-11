import { spawn, type ChildProcess } from "node:child_process";

export interface CliLaunch {
  runtime: "cursor" | "codex";
  profile: string;
  directory: string;
  prompt: string;
  resume?: string;
  mcp?: { node: string; script: string; configPath: string };
  bins?: { cursor?: string; codex?: string };
}

export function codexMcpArgs(node: string, script: string, configPath: string) {
  return [
    "-c", `mcp_servers.pi_bot.command=${JSON.stringify(node)}`,
    "-c", `mcp_servers.pi_bot.args=${JSON.stringify([script, configPath])}`,
  ];
}

/** Argv for one non-interactive CLI turn. Codex MCP is inline `-c` only; nothing is written into the workspace. */
export function cliLaunch(spec: CliLaunch) {
  if (spec.runtime === "cursor") {
    const args = ["--print", "--force", "--trust", "--workspace", spec.directory, "--output-format", "stream-json", "--stream-partial-output"];
    if (spec.resume) args.push("--resume", spec.resume);
    args.push(spec.prompt);
    return {
      command: spec.bins?.cursor || process.env.PI_BOT_CURSOR_BIN || "agent",
      args,
      cwd: spec.directory,
      env: { ...process.env, CURSOR_CONFIG_DIR: spec.profile },
      stdin: undefined as string | undefined,
    };
  }
  const args = ["exec"];
  if (spec.resume) args.push("resume", spec.resume);
  args.push("--json", "--skip-git-repo-check", "--cd", spec.directory, "--sandbox", "workspace-write", "--color", "never");
  if (spec.profile && spec.profile !== "default") args.push("--profile", spec.profile);
  if (spec.mcp) args.push(...codexMcpArgs(spec.mcp.node, spec.mcp.script, spec.mcp.configPath));
  args.push("-");
  return {
    command: spec.bins?.codex || process.env.PI_BOT_CODEX_BIN || "codex",
    args,
    cwd: spec.directory,
    env: { ...process.env },
    stdin: spec.prompt,
  };
}

export interface CliPiece {
  kind: "session" | "text" | "tool" | "error";
  id?: string;
  text?: string;
  mode?: "delta" | "snapshot" | "final";
  name?: string;
  state?: "running" | "completed" | "failed";
  summary?: string;
  message?: string;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as { text?: unknown; content?: unknown; message?: unknown };
  if (typeof record.text === "string") return record.text;
  if (Array.isArray(record.content)) return record.content.map(part => textOf(part)).join("");
  if (record.message) return textOf(record.message);
  return "";
}

/** Cursor stream-json and Codex JSONL, ignoring banner lines that are not JSON. */
export function parseCliLine(runtime: "cursor" | "codex", line: string): CliPiece[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];
  let event: Record<string, any>;
  try { event = JSON.parse(trimmed); } catch { return []; }
  const pieces: CliPiece[] = [];
  const session = event.session_id ?? event.thread_id ?? event.sessionId;
  if (typeof session === "string" && session) pieces.push({ kind: "session", id: session });
  if (runtime === "cursor") {
    if (event.type === "tool_call" || event.type === "tool") {
      const call = event.tool_call ?? event;
      const name = String(call.name ?? event.name ?? "tool").slice(0, 80);
      const summary = call.args?.command ?? call.arguments?.command ?? call.summary ?? event.summary;
      const state = event.subtype === "completed" || event.status === "completed" ? "completed" : event.subtype === "failed" || event.status === "failed" ? "failed" : "running";
      pieces.push({ kind: "tool", id: String(call.call_id ?? call.id ?? event.call_id ?? name).slice(0, 80), name, state, summary: summary ? String(summary).slice(0, 300) : undefined });
    }
    if (event.type === "assistant") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      const full = textOf(event.message ?? event);
      if (event.subtype === "delta" && delta) pieces.push({ kind: "text", text: delta, mode: "delta" });
      else if (full) pieces.push({ kind: "text", text: full, mode: "snapshot" });
    }
    if (event.type === "result") {
      if (typeof event.result === "string") pieces.push({ kind: "text", text: event.result, mode: "final" });
      if (event.is_error) pieces.push({ kind: "error", message: String(event.result ?? "CLI 运行失败").slice(0, 300) });
    }
    return pieces;
  }
  const item = event.item ?? {};
  if (event.type === "item.started" || event.type === "item.completed") {
    const done = event.type === "item.completed";
    if (item.type === "agent_message" || item.type === "message") {
      const text = textOf(item);
      if (text) pieces.push({ kind: "text", text, mode: done ? "final" : "snapshot" });
    } else if (item.type === "command_execution" || item.type === "function_call" || item.type === "tool_call") {
      const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
      pieces.push({
        kind: "tool",
        id: String(item.id ?? item.call_id ?? "tool").slice(0, 80),
        name: String(item.name ?? item.type ?? "tool").slice(0, 80),
        state: !done ? "running" : failed ? "failed" : "completed",
        summary: item.command ? String(item.command).slice(0, 300) : undefined,
      });
    }
  }
  if (event.type === "error" || event.type === "turn.failed") pieces.push({ kind: "error", message: String(event.message ?? event.error ?? "CLI 运行失败").slice(0, 300) });
  return pieces;
}

export function stopProcess(child: ChildProcess) {
  if (!child.pid) { child.kill(); return; }
  if (process.platform === "win32") child.kill();
  else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
}

export function runCliProcess(
  spec: CliLaunch,
  onLine: (line: string) => void,
  signal: AbortSignal,
): Promise<{ code: number | null; stderr: string }> {
  const launch = cliLaunch(spec);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stderr = "";
    let stdout = "";
    const abort = () => stopProcess(child);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    child.on("error", error => {
      signal.removeEventListener("abort", abort);
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      reject(new Error(missing ? (spec.runtime === "cursor" ? "未检测到 Cursor CLI（agent）" : "未检测到 Codex CLI（codex）") : error.message));
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      let index = stdout.indexOf("\n");
      while (index >= 0) {
        onLine(stdout.slice(0, index));
        stdout = stdout.slice(index + 1);
        index = stdout.indexOf("\n");
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.on("close", code => {
      signal.removeEventListener("abort", abort);
      if (stdout.trim()) onLine(stdout);
      resolve({ code, stderr });
    });
    child.stdin?.end(launch.stdin ?? "");
  });
}
