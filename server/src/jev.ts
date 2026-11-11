import { z } from "zod";
import { fail, type Tx } from "./db.js";
import type { Settings } from "./config.js";
import { Vault } from "./security.js";

const CONFIG_ID = "config";

export function normalizeJevBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  let url: URL;
  try { url = new URL(trimmed); } catch { return fail(422, "JEV 地址无效"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail(422, "JEV 地址只接受 http 或 https");
  if (url.username || url.password) return fail(422, "JEV 地址不能携带账号或密钥");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function normalizeJevModel(value: string | undefined) {
  const model = value?.trim() || "jev-latest";
  if (model.length > 80 || /\s/.test(model)) fail(422, "JEV 模型名无效");
  return model;
}

export function jevEndpoint(baseUrl: string) {
  return baseUrl.endsWith("/v1/systemone") ? baseUrl : `${baseUrl}/v1/systemone`;
}

export async function jevRow(tx: Tx) {
  return tx.one("SELECT enabled, managed, base_url, model, secret FROM jev_config WHERE singleton");
}

export async function jevPublic(tx: Tx, s: Settings) {
  const row = await jevRow(tx);
  if (row?.managed) {
    return {
      enabled: !!row.enabled,
      base_url: String(row.base_url ?? ""),
      model: String(row.model || "jev-latest"),
      configured: !!row.secret,
      source: "database" as const,
    };
  }
  if (s.jevBaseUrl && s.jevApiKey) {
    return { enabled: true, base_url: s.jevBaseUrl, model: s.jevModel || "jev-latest", configured: true, source: "environment" as const };
  }
  return { enabled: false, base_url: "", model: "jev-latest", configured: false, source: "none" as const };
}

/** Active SaaS JEV. A saved admin row replaces the environment fallback, including an explicit disable. */
export async function jevCredentials(tx: Tx, s: Settings, allowDisabled = false) {
  const row = await jevRow(tx);
  if (row?.managed) {
    if ((!row.enabled && !allowDisabled) || !row.base_url || !row.secret) return undefined;
    return {
      baseUrl: String(row.base_url),
      model: String(row.model || "jev-latest"),
      apiKey: new Vault(s.vaultFile, "jev").open(row.secret, CONFIG_ID),
    };
  }
  if (!s.jevBaseUrl || !s.jevApiKey) return undefined;
  return { baseUrl: s.jevBaseUrl, model: s.jevModel || "jev-latest", apiKey: s.jevApiKey };
}

export const jevSaveBody = z.object({
  enabled: z.boolean(),
  base_url: z.string().max(300).default(""),
  model: z.string().max(80).default("jev-latest"),
  api_key: z.string().max(500).optional(),
}).strict();

export async function saveJev(tx: Tx, s: Settings, body: unknown) {
  const input = jevSaveBody.parse(body);
  const baseUrl = normalizeJevBaseUrl(input.base_url);
  const model = normalizeJevModel(input.model);
  const current = await jevRow(tx);
  const typedKey = input.api_key?.trim();
  const envKey = !current?.managed ? s.jevApiKey : undefined;
  if (input.enabled && (!baseUrl || (!typedKey && !current?.secret && !envKey))) fail(422, "启用 JEV 需要地址和密钥");
  const secret = typedKey
    ? new Vault(s.vaultFile, "jev").seal(typedKey, CONFIG_ID)
    : !current?.secret && envKey
      ? new Vault(s.vaultFile, "jev").seal(envKey, CONFIG_ID)
      : undefined;
  await tx.rows(
    `UPDATE jev_config SET enabled=$1, managed=true, base_url=$2, model=$3, secret=coalesce($4::jsonb, secret), updated_at=now() WHERE singleton`,
    [input.enabled, baseUrl, model, secret ? JSON.stringify(secret) : null],
  );
  return jevPublic(tx, s);
}

export async function probeJev(config: { baseUrl: string; model: string; apiKey: string }, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(jevEndpoint(config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      state: { message: "连接测试" },
      questions: { ok: { type: "noul", instructions: "这是一次连接测试。" } },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  }).catch(() => fail(502, "无法连接 JEV"));
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const reason = response.status === 401 || response.status === 403 ? "密钥被拒绝" : `HTTP ${response.status}`;
    fail(502, `无法连接 JEV（${reason}）`);
  }
  await response.body?.cancel().catch(() => {});
  return { ok: true };
}
