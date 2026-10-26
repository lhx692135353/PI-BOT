import {
  applyUiMessages,
  updateUiState,
  validateUiAction,
  type UiDocument,
} from "@pi-bot/a2ui";
import { fail, type Tx, type Row } from "./db.js";
import { ownBot, postMessage } from "./bots.js";
export async function recordUi(tx: Tx, run: Row, messages: unknown) {
  const message = await tx.one(
    "SELECT ui FROM bot_messages WHERE message_id=$1 AND status='running' FOR UPDATE",
    [run.assistant_message_id],
  );
  if (!message) return;
  const ui = applyUiMessages(message.ui ?? null, messages);
  await tx.rows(
    "UPDATE bot_messages SET ui=$2, updated_at=now() WHERE message_id=$1",
    [run.assistant_message_id, JSON.stringify(ui)],
  );
  await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
}
function invalid(error: unknown): never {
  return fail(
    422,
    error instanceof Error ? error.message.slice(0, 250) : "交互界面操作无效",
  );
}
async function ownMessage(
  tx: Tx,
  userId: string,
  botId: string,
  messageId: string,
) {
  await ownBot(tx, userId, botId, true);
  const row = await tx.one(
    "SELECT * FROM bot_messages WHERE message_id=$1 AND bot_id=$2 AND role='assistant' AND visibility='public' FOR UPDATE",
    [messageId, botId],
  );
  if (!row?.ui) fail(404, "交互界面不存在");
  if (row!.status !== "completed") fail(409, "请等待 Bot 完成回复后再操作");
  return row!;
}
export async function saveUiState(
  tx: Tx,
  userId: string,
  botId: string,
  messageId: string,
  revision: number,
  states: unknown,
) {
  const row = await ownMessage(tx, userId, botId, messageId);
  if (row.ui.revision !== revision)
    fail(409, "界面已在其他设备更新，请重新打开后操作");
  let next: UiDocument;
  try {
    next = updateUiState(row.ui, states);
  } catch (e) {
    return invalid(e);
  }
  const message = await tx.update("bot_messages", messageId, {
    ui: next,
    updated_at: new Date(),
  });
  await tx.notify({ user_id: userId, bot_id: botId });
  return message;
}
export async function submitUiAction(
  tx: Tx,
  userId: string,
  botId: string,
  messageId: string,
  input: {
    revision: number;
    states: unknown;
    action: unknown;
    request_id: string;
  },
  computer: { deviceId: string } | null,
  source:{client?:string;deviceId?:string}={},
) {
  const row = await ownMessage(tx, userId, botId, messageId);
  // Same idempotency scope as normal messages. A retry must not append another user message.
  const requestId = `ui:${messageId}:${input.request_id}`;
  const existing = await tx.one(
    "SELECT * FROM bot_runs WHERE bot_id=$1 AND request_id=$2",
    [botId, requestId],
  );
  if (existing) return { run: existing, created: false };
  if (row.ui.revision !== input.revision)
    fail(409, "界面已在其他设备更新，请重新打开后操作");
  let ui: UiDocument, action: ReturnType<typeof validateUiAction>;
  try {
    ui = updateUiState(row.ui, input.states);
    action = validateUiAction(ui, input.action);
  } catch (e) {
    return invalid(e);
  }
  const surface = ui.surfaces.find((s) => s.id === action.surfaceId)!;
  const component = surface.components.find(
    (c) => c.id === action.sourceComponentId,
  )!;
  const child = surface.components.find((c) => c.id === component.child);
  const label =
    typeof child?.text === "string"
      ? child.text.replace(/\s+/g, " ").slice(0, 80)
      : "提交当前选择";
  const text = `在交互工具中选择了「${label}」`;
  const detail = {
    source_message_id: messageId,
    action,
    states: ui.surfaces.map((s) => ({ surfaceId: s.id, data: s.data })),
  };
  if (JSON.stringify(detail).length > 90000) fail(422, "提交的界面数据过大");
  const result = await postMessage(tx, userId, botId, text, requestId, computer,[],source);
  await tx.update("bot_messages", result.run.user_message_id, {
    ui_action: detail,
  });
  await tx.update("bot_messages", messageId, { ui, updated_at: new Date() });
  return { run: result.run, created: result.created };
}
