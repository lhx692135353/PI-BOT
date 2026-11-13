import { existsSync, rmSync, writeFileSync } from "node:fs";
import { chooseRoute, routeState, type RouteDecision } from "@pi-bot/agent";
import { discoverCodexThreads, parseCliLine, runCliProcess, type CliLaunch } from "./cli-engine.js";
import { writeMcpConfig, writeMcpServer } from "./cli-mcp.js";

export interface CliTurnRun {
  run_id: string;
  text: string;
  model: { id: string };
  bot: { name: string };
  cli?: {
    runtime: "cursor" | "codex";
    profile: string;
    directory: string;
    persona: string;
    fresh: boolean;
    recent: { role: "user" | "assistant"; text: string }[];
    sessions: { id: string; engine_session_id: string; title: string; summary: string; last_user_text: string; updated_at: string }[];
  };
}

const clip = (text: string, limit: number) => text.replace(/\s+/g, " ").trim().slice(0, limit);

function promptFor(run: CliTurnRun, text: string, mcp: boolean) {
  const lines = [`你是 Pi Bot 里的智能体「${run.bot.name}」。`];
  if (run.cli?.persona.trim()) lines.push(run.cli.persona.trim());
  if (mcp) lines.push("需要其他 Pi Bot 智能体时，使用 MCP 工具 list_agents 和 ask_agent。任务描述必须自包含，对方看不到当前 CLI 对话。");
  lines.push(text);
  return lines.join("\n\n");
}

export interface CliRunDeps {
  token(): Promise<string>;
  proxyUrl: string;
  fetchImpl?: typeof fetch;
  bins?: { cursor?: string; codex?: string };
  local?: { url: string; model: string };
  dataDir?: string;
  launch?: (spec: CliLaunch, onLine: (line: string) => void, signal: AbortSignal) => Promise<{ code: number | null; stderr: string }>;
}

/** Route one turn, then resume or create the CLI session. Emits the same run events as the Pi executor. */
export async function runCliTurn(run: CliTurnRun, event: (entry: Record<string, unknown>) => void, signal: AbortSignal, deps: CliRunDeps) {
  const cli = run.cli;
  if (!cli) throw new Error("缺少 CLI 配置");
  event({ kind: "started" });
  let finished = false;
  let configPath: string | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const finish = (entry: Record<string, unknown>) => { if (!finished) { finished = true; event({ kind: "done", ...entry }); } };
  try {
    if (signal.aborted) return finish({ state: "cancelled" });
    if (!existsSync(cli.directory)) return finish({ state: "failed", error: "目录不存在" });
    const known = new Map(cli.sessions.map(session => [session.engine_session_id, session]));
    if (cli.runtime === "codex") {
      for (const thread of discoverCodexThreads(cli.directory)) {
        if (!known.has(thread.id)) known.set(thread.id, {
          id: thread.id, engine_session_id: thread.id, title: thread.title, summary: "", last_user_text: "", updated_at: thread.updated_at,
        });
      }
    }
    const routable = [...known.values()];
    const state = routeState(run.text, cli.recent, routable.map(session => ({
      id: session.id, title: session.title, summary: session.summary, last_user: session.last_user_text, updated_at: session.updated_at,
    })));
    const decision: RouteDecision = cli.fresh
      ? { action: "new" }
      : await chooseRoute(state, {
          fetch: deps.fetchImpl ?? fetch,
          local: deps.local,
          proxyUrl: deps.proxyUrl,
          token: await deps.token(),
          modelId: run.model.id,
          signal,
        });
    if (decision.action === "ask") return finish({ state: "completed", text: decision.prompt });
    const resume = decision.action === "resume"
      ? routable.find(session => session.id === decision.session_id || session.engine_session_id === decision.session_id)
      : undefined;
    if (decision.action === "resume" && !resume) return finish({ state: "failed", error: "要续的会话已经不在索引里" });
    const opening = decision.action === "new";
    const mcp = cli.runtime === "codex" && deps.dataDir ? (() => {
      const script = writeMcpServer(deps.dataDir!);
      configPath = writeMcpConfig(deps.dataDir!, { api: deps.proxyUrl.replace(/\/llm\/v1\/?$/, ""), token: "", runId: run.run_id });
      const refresh = async () => {
        const token = await deps.token();
        writeFileSync(configPath!, JSON.stringify({ api: deps.proxyUrl.replace(/\/llm\/v1\/?$/, ""), token, runId: run.run_id }), { mode: 0o600 });
      };
      return { script, refresh };
    })() : undefined;
    if (mcp) await mcp.refresh();
    refreshTimer = mcp ? setInterval(() => { void mcp.refresh().catch(() => {}); }, 10 * 60 * 1000) : undefined;
    let sessionId = resume?.engine_session_id;
    let streamed = "";
    let finalText = "";
    let failure = "";
    const publish = () => event({ kind: "text", text: finalText || streamed });
    const result = await (deps.launch ?? runCliProcess)({
        runtime: cli.runtime,
        profile: cli.profile,
        directory: cli.directory,
        prompt: opening ? promptFor(run, run.text, !!mcp) : run.text,
        resume: resume?.engine_session_id,
        mcp: mcp ? { node: process.execPath, script: mcp.script, configPath: configPath! } : undefined,
        bins: deps.bins,
      }, line => {
        for (const piece of parseCliLine(cli.runtime, line)) {
          if (piece.kind === "session" && piece.id) sessionId = piece.id;
          else if (piece.kind === "text" && piece.text) {
            if (piece.mode === "delta") streamed += piece.text;
            else if (piece.mode === "final") finalText = piece.text;
            else streamed = piece.text;
            publish();
          } else if (piece.kind === "tool") {
            event({ kind: "tool", id: piece.id, name: piece.name, state: piece.state, summary: piece.summary });
          } else if (piece.kind === "error" && piece.message) failure = piece.message;
        }
      }, signal);
      if (signal.aborted) return finish({ state: "cancelled", text: finalText || streamed || undefined });
      const text = finalText || streamed;
      if (failure || (result.code !== 0 && result.code !== null)) return finish({ state: "failed", error: (failure || result.stderr || "CLI 运行失败").slice(0, 300), text: text || undefined });
      if (!sessionId) return finish({ state: "failed", error: "CLI 没有返回会话编号", text: text || undefined });
      const token = await deps.token();
      const saved = await (deps.fetchImpl ?? fetch)(`${deps.proxyUrl.replace(/\/llm\/v1\/?$/, "")}/agent/cli-sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          run_id: run.run_id,
          session_id: cli.sessions.find(session => session.id === resume?.id)?.id,
          engine_session_id: sessionId,
          title: clip(run.text, 80),
          summary: clip(text, 500),
          last_user_text: clip(run.text, 500),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!saved.ok) return finish({ state: "failed", error: "CLI 已完成，但会话索引没有保存", text: text || undefined });
      finish({ state: "completed", text });
  } catch (error) {
    finish({ state: "failed", error: error instanceof Error ? error.message.slice(0, 300) : "CLI 运行失败" });
  } finally {
    clearInterval(refreshTimer);
    if (configPath) rmSync(configPath, { force: true });
  }
}
