import { z } from "zod";
import { fail, type Tx } from "./db.js";
import type { Settings } from "./config.js";
import { Vault } from "./security.js";

const CONFIG_ID = "config";
const RESULT_CHARS = 12000;

export function normalizeComposioBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  let url: URL;
  try { url = new URL(trimmed); } catch { return fail(422, "连接器地址无效"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail(422, "连接器地址只接受 http 或 https");
  if (url.username || url.password) return fail(422, "连接器地址不能携带账号或密钥");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export const composioIsActive = (row: { enabled?: boolean; base_url?: string; secret?: unknown } | undefined) =>
  !!row?.enabled && !!row.base_url && !!row.secret;

const clip = (value: unknown) => {
  const text = JSON.stringify(value) ?? "";
  return text.length <= RESULT_CHARS ? text : `${text.slice(0, RESULT_CHARS)}\n…（结果已截断）`;
};

export class ComposioGateway {
  constructor(private baseUrl: string, private apiKey: string, private fetchImpl: typeof fetch = fetch) {}

  private async call(path: string, body: unknown, signal?: AbortSignal) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    const data = await response.json().catch(() => ({})) as { error?: { message?: string }; message?: string };
    if (!response.ok) {
      const message = data.error?.message || data.message || "连接器请求失败";
      throw new Error(this.hide(message).slice(0, 300));
    }
    return data as Record<string, unknown>;
  }

  private hide(value: string) {
    return this.apiKey ? value.replaceAll(this.apiKey, "[已隐藏密钥]") : value;
  }

  private async session(userId: string, signal?: AbortSignal) {
    const data = await this.call("/api/v3.1/tool_router/session", {
      user_id: userId,
      workbench: { enable: false },
      proxy_execute: { enable: false },
      manage_connections: { enable: true, enable_wait_for_connections: false, enable_connection_removal: false },
    }, signal);
    if (typeof data.session_id !== "string" || !data.session_id) throw new Error("连接器没有返回会话");
    return data.session_id;
  }

  async search(userId: string, query: string, signal?: AbortSignal) {
    const sessionId = await this.session(userId, signal);
    return this.hide(clip(await this.call(`/api/v3.1/tool_router/session/${encodeURIComponent(sessionId)}/search`, {
      queries: [{ use_case: query }],
    }, signal)));
  }

  async connect(userId: string, toolkit: string, signal?: AbortSignal) {
    const sessionId = await this.session(userId, signal);
    const data = await this.call(`/api/v3.1/tool_router/session/${encodeURIComponent(sessionId)}/link`, { toolkit }, signal);
    return {
      toolkit,
      redirect_url: typeof data.redirect_url === "string" ? this.hide(data.redirect_url) : "",
      connected_account_id: typeof data.connected_account_id === "string" ? data.connected_account_id : undefined,
    };
  }

  async execute(userId: string, toolSlug: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const sessionId = await this.session(userId, signal);
    return this.hide(clip(await this.call(`/api/v3.1/tool_router/session/${encodeURIComponent(sessionId)}/execute`, {
      tool_slug: toolSlug,
      arguments: args,
    }, signal)));
  }

  async probe(signal?: AbortSignal) {
    await this.session("pi-bot-admin-check", signal);
    return { ok: true };
  }
}

export async function composioRow(tx: Tx) {
  return tx.one("SELECT enabled, base_url, secret FROM composio_config WHERE singleton");
}

export async function composioPublic(tx: Tx) {
  const row = await composioRow(tx);
  return { enabled: !!row?.enabled, base_url: row?.base_url ?? "", configured: !!row?.secret };
}

export async function composioGateway(tx: Tx, s: Settings, requireEnabled = true) {
  const row = await composioRow(tx);
  if (!row?.base_url || !row.secret || (requireEnabled && !row.enabled)) return undefined;
  return new ComposioGateway(row.base_url, new Vault(s.vaultFile, "composio").open(row.secret, CONFIG_ID));
}

export async function composioResult<T>(work: Promise<T>): Promise<T> {
  try { return await work; }
  catch (error) { return fail(502, error instanceof Error ? error.message : "连接器请求失败"); }
}

export const composioSaveBody = z.object({
  enabled: z.boolean(),
  base_url: z.string().max(300).default(""),
  api_key: z.string().max(500).optional(),
}).strict();

export async function saveComposio(tx: Tx, s: Settings, body: unknown) {
  const input = composioSaveBody.parse(body);
  const baseUrl = normalizeComposioBaseUrl(input.base_url);
  const current = await composioRow(tx);
  const apiKey = input.api_key?.trim();
  if (input.enabled && (!baseUrl || (!apiKey && !current?.secret))) fail(422, "启用连接器需要地址和密钥");
  const secret = apiKey ? new Vault(s.vaultFile, "composio").seal(apiKey, CONFIG_ID) : undefined;
  await tx.rows(
    `UPDATE composio_config SET enabled=$1, base_url=$2, secret=coalesce($3::jsonb, secret), updated_at=now() WHERE singleton`,
    [input.enabled, baseUrl, secret ? JSON.stringify(secret) : null],
  );
  return composioPublic(tx);
}
