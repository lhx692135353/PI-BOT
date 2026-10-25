import { fail, HttpError } from "./db.js";

export type Provider = "xai" | "bailian" | "custom";

export interface CatalogModel {
  id: string;
  context_window: number | null;
  max_tokens: number | null;
}

const VOICE_ID = /grok-voice|(?:^|[-_])realtime(?:$|[-_])|omni-.+realtime|realtime-(?:plus|flash)/i;
const SKIP_CHAT = /embed|rerank|tts|asr|whisper|image|imagine|wanx|cosyvoice|paraformer|sambert|translat/i;

/** Server-side search tools. The provider runs them inside the Responses request. */
export function providerSearchTools(provider: string): { type: string }[] {
  if (provider === "xai") return [{ type: "web_search" }, { type: "x_search" }];
  if (provider === "bailian") return [{ type: "web_search" }];
  return [];
}

export function applyProviderSearch(body: Record<string, unknown>, model: { provider?: string | null; provider_search?: boolean | null }, lane?: string | null) {
  const extra = model.provider_search === true ? providerSearchTools(model.provider ?? "") : [];
  if (lane !== "task" || extra.length === 0) return body;
  const tools = Array.isArray(body.tools) ? body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object") return true;
    const record = tool as Record<string, unknown>;
    return !(record.type === "function" && record.name === "web_search");
  }) : [];
  for (const tool of extra) {
    if (!tools.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === tool.type)) tools.push(tool);
  }
  return { ...body, tools };
}

export function providerBase(provider: string): string | null {
  if (provider === "xai") return "https://api.x.ai/v1";
  if (provider === "bailian") return "https://dashscope.aliyuncs.com/compatible-mode/v1";
  return null;
}

export function inferProvider(baseUrl: string): Provider {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === "api.x.ai" || host.endsWith(".x.ai")) return "xai";
    if (host === "dashscope.aliyuncs.com" || host === "dashscope-intl.aliyuncs.com" || host.endsWith(".dashscope.aliyuncs.com")) return "bailian";
  } catch { /* not a URL */ }
  return "custom";
}

export function parseCatalog(payload: unknown): CatalogModel[] {
  const root = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  const output = root?.output && typeof root.output === "object" && !Array.isArray(root.output) ? root.output as Record<string, unknown> : null;
  const rows = [
    ...(Array.isArray(payload) ? payload : []),
    ...(Array.isArray(root?.data) ? root.data : []),
    ...(Array.isArray(root?.models) ? root.models : []),
    ...(Array.isArray(output?.models) ? output.models : []),
  ];
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const info = record.model_info && typeof record.model_info === "object" && !Array.isArray(record.model_info) ? record.model_info as Record<string, unknown> : {};
    const flat = { ...info, ...record };
    const id = text(record.id) || text(record.model);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const context = positive(flat, ["context_window", "context_length"]);
    let max = positive(flat, ["max_output_tokens", "max_completion_tokens", "max_tokens"]);
    const contextWindow = context !== null && context >= 1024 && context <= 4_000_000 ? context : null;
    if (contextWindow && max !== null && max >= contextWindow) max = contextWindow - 1;
    const maxTokens = max !== null && max >= 16 && max <= 1_000_000 && (contextWindow === null || max < contextWindow) ? max : null;
    out.push({ id, context_window: contextWindow, max_tokens: maxTokens });
  }
  return out;
}

export function classifyModels(models: CatalogModel[]) {
  const chat: CatalogModel[] = [];
  const voice: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    if (VOICE_ID.test(model.id)) voice.push(model);
    else if (!SKIP_CHAT.test(model.id)) chat.push(model);
  }
  return { chat, voice };
}

const BAILIAN_CAPABILITIES = ["TG", "VU", "Reasoning", "Multimodal-Omni", "Realtime-Omni", "Realtime-Chatting"];

export async function listCatalog(provider: "xai" | "bailian", key: string) {
  if (provider === "xai") {
    const language = await readJson("https://api.x.ai/v1/language-models", key).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 422) throw error;
      return null;
    });
    const all = await readJson("https://api.x.ai/v1/models", key);
    return classifyModels([...parseCatalog(language), ...parseCatalog(all)]);
  }
  return classifyModels(await listBailian(key));
}

/** Bailian's OpenAI-compatible `/models` answers 401. The admin console treats that as a signed-out session. */
async function listBailian(key: string) {
  const pageSize = 100;
  const models: unknown[] = [];
  let total = Infinity;
  for (let page = 1; page <= 10 && models.length < total; page++) {
    const params = new URLSearchParams({ page_no: String(page), page_size: String(pageSize), supports: "inference", language: "zh-CN" });
    for (const capability of BAILIAN_CAPABILITIES) params.append("capabilities", capability);
    const payload = await readJson(`https://dashscope.aliyuncs.com/api/v1/models?${params}`, key);
    const root = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
    if (root?.success === false) fail(502, text(root.message) || "无法拉取模型列表");
    const output = root?.output && typeof root.output === "object" && !Array.isArray(root.output) ? root.output as Record<string, unknown> : null;
    const rows = Array.isArray(output?.models) ? output.models : null;
    if (!rows) return page === 1 ? parseCatalog(payload) : parseCatalog({ output: { models } });
    const reported = Number(output?.total);
    if (Number.isFinite(reported) && reported >= 0) total = reported;
    models.push(...rows);
    if (rows.length === 0) break;
  }
  return parseCatalog({ output: { models } });
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function positive(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value) && value > 0) return Math.round(value);
  }
  return null;
}

async function readJson(url: string, key: string) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  }).catch(() => fail(502, "无法连接模型服务"));
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    // 401 here is the provider rejecting the key. Forwarding it logs the admin out.
    if (response.status === 401 || response.status === 403) fail(422, "API Key 无效或没有模型权限");
    fail(502, `无法拉取模型列表（HTTP ${response.status}）`);
  }
  return response.json() as Promise<unknown>;
}
