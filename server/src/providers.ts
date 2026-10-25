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
  const rows = [
    ...(Array.isArray(payload) ? payload : []),
    ...(Array.isArray(root?.data) ? root.data : []),
    ...(Array.isArray(root?.models) ? root.models : []),
  ];
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const context = positive(record, ["context_window", "context_length"]);
    let max = positive(record, ["max_output_tokens", "max_completion_tokens", "max_tokens"]);
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

export async function listCatalog(provider: "xai" | "bailian", key: string) {
  if (provider === "xai") {
    const language = await readJson("https://api.x.ai/v1/language-models", key).catch((error: unknown) => {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) throw error;
      return null;
    });
    const all = await readJson("https://api.x.ai/v1/models", key);
    return classifyModels([...parseCatalog(language), ...parseCatalog(all)]);
  }
  return classifyModels(parseCatalog(await readJson("https://dashscope.aliyuncs.com/compatible-mode/v1/models", key)));
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
    if (response.status === 401 || response.status === 403) fail(response.status, "API Key 无效或没有模型权限");
    fail(502, `无法拉取模型列表（HTTP ${response.status}）`);
  }
  return response.json() as Promise<unknown>;
}
