import { randomUUID } from "node:crypto";
import { isCliRuntime } from "./cli.js";
import { fail, type Row, type Tx } from "./db.js";

const clip = (value: string, limit: number) => value.replace(/\s+/g, " ").trim().slice(0, limit);

export async function cliRouteMaterial(tx: Tx, botId: string, beforeSeq: number) {
  const [sessions, recent] = await Promise.all([
    tx.rows(
      `SELECT session_id, engine_session_id, title, summary, last_user_text, updated_at
       FROM cli_sessions WHERE bot_id=$1 AND status='open' AND origin='user'
       ORDER BY updated_at DESC LIMIT 20`,
      [botId],
    ),
    tx.rows(
      `SELECT role, content FROM bot_messages
       WHERE bot_id=$1 AND visibility='public' AND seq<$2 AND status IN ('completed','cancelled')
         AND role IN ('user','assistant')
       ORDER BY seq DESC LIMIT 6`,
      [botId, beforeSeq],
    ),
  ]);
  return {
    sessions: sessions.map(row => ({
      id: row.session_id as string,
      engine_session_id: row.engine_session_id as string,
      title: String(row.title ?? ""),
      summary: String(row.summary ?? ""),
      last_user_text: String(row.last_user_text ?? ""),
      updated_at: new Date(row.updated_at).toISOString(),
    })),
    recent: recent.reverse().map(row => ({ role: row.role as "user" | "assistant", text: clip(String(row.content ?? ""), 500) })),
  };
}

export async function closeCliSessions(tx: Tx, botId: string) {
  await tx.rows("UPDATE cli_sessions SET status='closed', updated_at=now() WHERE bot_id=$1 AND status='open'", [botId]);
}

export async function saveCliSession(
  tx: Tx,
  run: Row,
  body: { session_id?: string; engine_session_id: string; title?: string; summary?: string; last_user_text?: string },
) {
  const bot = await tx.get("bots", run.bot_id);
  if (!isCliRuntime(bot?.runtime) || !bot.cli_device_id) fail(422, "不是 CLI 智能体");
  const summary = clip(body.summary ?? "", 500);
  const lastUser = clip(body.last_user_text ?? "", 500);
  const title = clip(body.title || lastUser || "未命名会话", 80);
  if (body.session_id) {
    const existing = await tx.one("SELECT * FROM cli_sessions WHERE session_id=$1 AND bot_id=$2", [body.session_id, bot.bot_id]);
    if (!existing) fail(404, "会话不存在");
    return tx.update("cli_sessions", body.session_id, {
      engine_session_id: body.engine_session_id,
      title: existing!.title ? String(existing!.title) : title,
      summary,
      last_user_text: lastUser,
      status: "open",
      updated_at: new Date(),
    });
  }
  return tx.insert("cli_sessions", {
    session_id: randomUUID(),
    bot_id: bot.bot_id,
    device_id: bot.cli_device_id,
    engine_session_id: body.engine_session_id,
    title,
    summary,
    last_user_text: lastUser,
    origin: run.origin === "agent" ? "delegation" : "user",
    status: "open",
  });
}
