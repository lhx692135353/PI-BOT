import { z } from "zod";
import type { Settings } from "./config.js";
import { fail, HttpError, type Database, type Row, type Tx } from "./db.js";
import { Vault, type LlmClaims } from "./security.js";
import { endpoint, recordUsage, usageFrom } from "./llm.js";
import { providerSearchTools } from "./providers.js";

/** Tavily is configured. Whether any backend is usable is `searchBackend`. */
export const searchAvailable = (s: Settings) => Boolean(s.tavilyKey);
type Backend = { name: "tavily" } | { name: "provider"; model: Row };
export function selectBackend(s: Settings, providerModel?: Row | null): Backend | null {
  if (s.searchBackend !== "provider" && s.tavilyKey) return { name: "tavily" };
  if (s.searchBackend !== "tavily" && providerModel) return { name: "provider", model: providerModel };
  return null;
}
/** Every web_search goes through one backend; Tavily wins in auto mode because it returns snippets only. */
export async function searchBackend(tx: Tx, s: Settings) {
  const model = s.searchBackend === "tavily" ? null : await tx.one(
    "SELECT * FROM models WHERE enabled AND provider_search AND provider IN ('xai','bailian') ORDER BY is_default DESC, created_at LIMIT 1",
  );
  return selectBackend(s, model);
}
export const SEARCH_QUOTA_REACHED = "搜索额度到了";
const USAGE_TTL_MS = 60_000;
const credits = z.number().finite().nonnegative();
const usageSchema = z.object({
  key: z.object({ usage: credits, limit: credits.nullable() }),
  account: z.object({ current_plan: z.string(), plan_usage: credits, plan_limit: credits }),
});
type TavilyUsage = z.infer<typeof usageSchema>;

export interface SearchUsage {
  backend: "tavily" | "provider" | null;
  model: string | null;
  configured: boolean;
  status: "not_configured" | "available" | "exhausted" | "unavailable";
  plan: string | null;
  plan_used: number | null;
  plan_limit: number | null;
  key_used: number | null;
  key_limit: number | null;
  remaining: number | null;
  checked_at: string | null;
  error: string | null;
}
interface SearchResult { title: string; url: string; content: string }
interface SearchPage { results: SearchResult[]; warnings: string[]; summary?: string }
const MAX_RESULTS = 8;
const clean = (value: unknown, limit: number) => String(value ?? "").replace(/<[^>]*>/g, "").trim().slice(0, limit);
function safeUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Shared Tavily SaaS gateway. Only the API process holds the provider key. */
export class TavilySearch {
  private cache = new Map<string, { until: number; page: SearchPage }>();
  private quota?: TavilyUsage;
  private checkedAt?: number;
  private nextUsageAt = 0;
  private usageError: string | null = null;
  private usageRequest?: Promise<void>;
  private spent = 0;
  private reserved = 0;
  private blocked = false;

  constructor(private s: Settings, private request: typeof fetch = fetch, private now = Date.now) {}

  private headers() { return { Authorization: `Bearer ${this.s.tavilyKey}`, "Content-Type": "application/json" }; }

  private remaining() {
    if (!this.quota) return 0;
    const { key, account } = this.quota;
    return this.blocked ? 0 : Math.max(0, Math.min(
      account.plan_limit - account.plan_usage,
      key.limit === null ? Infinity : key.limit - key.usage,
    ) - this.reserved);
  }

  private async syncUsage() {
    if (this.usageRequest) return this.usageRequest;
    if (this.now() < this.nextUsageAt) return;
    this.nextUsageAt = this.now() + USAGE_TTL_MS;
    const spentBefore = this.spent;
    this.usageRequest = (async () => {
      try {
        const response = await this.request("https://api.tavily.com/usage", {
          headers: this.headers(), signal: AbortSignal.timeout(8000), redirect: "error",
        });
        if (response.status === 401) fail(503, "Tavily API Key 无效，请管理员检查环境变量");
        if (response.status === 429) fail(503, "Tavily 用量查询频率受限，请稍后重试");
        if (!response.ok) fail(503, "暂时无法获取 Tavily 搜索额度，请稍后重试");
        const parsed = usageSchema.safeParse(await response.json());
        if (!parsed.success) fail(503, "Tavily 用量数据格式异常，请稍后重试");
        // Conservatively include searches completed while this snapshot was being fetched.
        const overlap = this.spent - spentBefore;
        const quota = parsed.data!;
        quota.key.usage += overlap;
        quota.account.plan_usage += overlap;
        this.quota = quota;
        this.checkedAt = this.now();
        this.usageError = null;
        this.blocked = false;
      } catch (error) {
        this.usageError = error instanceof HttpError && typeof error.detail === "string" ? error.detail : "暂时无法获取 Tavily 搜索额度，请稍后重试";
      }
    })();
    try { await this.usageRequest; }
    finally { this.usageRequest = undefined; }
  }

  /** Admin-safe snapshot; provider responses and credentials never leave this gateway. */
  async usage(): Promise<Omit<SearchUsage, "backend" | "model">> {
    const configured = searchAvailable(this.s);
    if (configured) await this.syncUsage();
    return {
      configured,
      status: !configured ? "not_configured" : this.usageError ? "unavailable" : this.remaining() < 1 ? "exhausted" : "available",
      plan: this.quota?.account.current_plan ?? null,
      plan_used: this.quota?.account.plan_usage ?? null,
      plan_limit: this.quota?.account.plan_limit ?? null,
      key_used: this.quota?.key.usage ?? null,
      key_limit: this.quota?.key.limit ?? null,
      remaining: this.quota && !this.usageError ? this.remaining() : null,
      checked_at: this.checkedAt === undefined ? null : new Date(this.checkedAt).toISOString(),
      error: this.usageError,
    };
  }

  async search(query: string, language: string, signal?: AbortSignal): Promise<SearchPage> {
    if (!searchAvailable(this.s)) fail(503, "管理员尚未配置 Tavily 搜索 API Key");
    await this.syncUsage();
    // Fail closed when the balance cannot be checked. Never spill into pay-as-you-go credits.
    if (this.usageError) fail(503, this.usageError);
    if (this.remaining() < 1) fail(402, SEARCH_QUOTA_REACHED);
    const key = JSON.stringify([query, language]);
    const cached = this.cache.get(key);
    if (cached && cached.until > this.now()) return cached.page;
    const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    // Reserve synchronously so parallel requests cannot all consume the last credit.
    this.reserved++;
    let charged = false;
    let dispatched = false;
    try {
      abort.throwIfAborted();
      dispatched = true;
      const response = await this.request("https://api.tavily.com/search", {
        method: "POST", signal: abort, redirect: "error", headers: this.headers(),
        body: JSON.stringify({
          query, max_results: 8, search_depth: "fast", auto_parameters: false,
          include_answer: false, include_raw_content: false, include_usage: true,
          ...(!["auto", "all"].includes(language) ? { language: language.toLowerCase() } : {}),
        }),
      });
      if ([432, 433].includes(response.status)) {
        this.blocked = true;
        fail(402, SEARCH_QUOTA_REACHED);
      }
      if (response.status === 401) fail(503, "Tavily API Key 无效，请管理员检查环境变量");
      if (response.status === 429) fail(503, "搜索请求过于频繁，请稍后重试");
      if (!response.ok) fail(502, "搜索服务暂时不可用，请稍后重试");
      charged = true; // Explicit fast searches cost one credit, including empty results.
      const data = await response.json() as { results?: unknown };
      if (!Array.isArray(data.results)) fail(502, "搜索服务返回格式异常");
      const seen = new Set<string>();
      const results: SearchResult[] = [];
      for (const entry of data.results as any[]) {
        const url = safeUrl(entry?.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        results.push({ title: clean(entry.title, 300), url, content: clean(entry.content, 2000) });
        if (results.length === MAX_RESULTS) break;
      }
      const page: SearchPage = { results, warnings: [] };
      if (results.length) {
        this.cache.delete(key);
        this.cache.set(key, { until: this.now() + 300000, page });
        if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
      }
      return page;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // A lost response may already have spent a credit upstream. Require a fresh
      // balance before another search instead of reusing an uncertain allowance.
      if (dispatched && !charged) this.usageError = "搜索连接中断，无法确认剩余额度，请稍后重试";
      return fail(502, "联网搜索超时或连接失败，请稍后重试");
    } finally {
      this.reserved--;
      if (charged) {
        this.spent++;
        if (this.quota) {
          this.quota.key.usage++;
          this.quota.account.plan_usage++;
        }
      }
    }
  }
}

const PROVIDER_INSTRUCTIONS = [
  "你是联网搜索后端，只负责检索，不回答检索以外的问题。",
  `根据用户的查询联网检索，只输出一个 JSON 对象，不要 Markdown：{"results":[{"title":"","url":"","content":""}]}。`,
  `最多 ${MAX_RESULTS} 条，按相关度排序。url 必须是检索到的原始网页地址。content 写这条来源里与查询直接相关的要点，最多 300 字，保留数字、日期和型号，不要编造；来源没有写的内容不要补。`,
].join("\n");

/** Pulls bounded results out of a Responses payload; only URLs the provider actually retrieved are kept when it reports them. */
export function providerPage(data: Row): SearchPage {
  const output: Row[] = Array.isArray(data.output) ? data.output : [];
  const parts = output.filter(i => i?.type === "message").flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p?.type === "output_text");
  const text = parts.map(p => String(p.text ?? "")).join("");
  const citations = parts.flatMap(p => Array.isArray(p.annotations) ? p.annotations : []).filter(a => a?.type === "url_citation");
  const retrieved = new Set([
    ...citations.map(a => safeUrl(a.url)),
    ...output.filter(i => i?.type === "web_search_call").flatMap(i => Array.isArray(i.action?.sources) ? i.action.sources : []).map((src: Row) => safeUrl(src?.url)),
  ].filter((url): url is string => !!url));
  let parsed: Row | null = null;
  try { parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { /* fall back to citations */ }
  const results: SearchResult[] = [];
  const add = (title: unknown, link: unknown, content: unknown) => {
    const url = safeUrl(link);
    if (!url || results.length >= MAX_RESULTS || results.some(r => r.url === url) || (retrieved.size && !retrieved.has(url))) return;
    results.push({ title: clean(title, 300), url, content: clean(content, 2000) });
  };
  for (const r of Array.isArray(parsed?.results) ? parsed!.results : []) add(r?.title, r?.url, r?.content);
  if (!results.length) for (const c of citations) add(c.title, c.url, "");
  const summary = !parsed && results.length ? clean(text, 2000) : "";
  return { results, warnings: results.length ? [] : ["搜索没有返回可用结果"], ...(summary ? { summary } : {}) };
}

/** Provider-native search runs as its own bounded request, so retrieved pages never enter the caller's context. */
export class ProviderSearch {
  private cache = new Map<string, { until: number; page: SearchPage }>();
  constructor(private db: Database, private s: Settings, private request: typeof fetch = fetch, private now = Date.now) {}
  async search(model: Row, query: string, language: string, signal?: AbortSignal, who?: LlmClaims): Promise<SearchPage> {
    const key = JSON.stringify([model.model_id, query, language]);
    const cached = this.cache.get(key);
    if (cached && cached.until > this.now()) return cached.page;
    const secret = new Vault(this.s.vaultFile).open(model.secret, model.model_id);
    const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(80000)]) : AbortSignal.timeout(80000);
    let response: Response;
    try {
      response = await this.request(endpoint(model), {
        method: "POST", signal: abort, redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          model: model.provider_model,
          input: [
            { role: "system", content: PROVIDER_INSTRUCTIONS },
            { role: "user", content: ["auto", "all"].includes(language) ? query : `${query}\n（结果语言：${language}）` },
          ],
          tools: providerSearchTools(model.provider),
          ...(model.provider === "xai" ? { max_turns: this.s.providerSearchMaxTurns } : {}),
          max_output_tokens: Math.min(4000, model.max_tokens),
          stream: false, store: false,
        }),
      });
    } catch {
      return fail(502, "联网搜索超时或连接失败，请稍后重试");
    }
    if (response.status === 429) fail(503, "搜索请求过于频繁，请稍后重试");
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail(502, "搜索服务暂时不可用，请稍后重试");
    }
    const data = await response.json().catch(() => null) as Row | null;
    if (who) await recordUsage(this.db, who, model.model_id, usageFrom(data));
    if (!data || data.status === "failed") fail(502, "搜索服务返回格式异常");
    const page = providerPage(data!);
    if (page.results.length) {
      this.cache.delete(key);
      this.cache.set(key, { until: this.now() + 300000, page });
      if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
    }
    return page;
  }
}

/** The single web_search entry point; backends differ only in how results are produced. */
export class WebSearch {
  private tavily: TavilySearch;
  private provider?: ProviderSearch;
  constructor(private s: Settings, request: typeof fetch = fetch, now = Date.now, private db?: Database) {
    this.tavily = new TavilySearch(s, request, now);
    if (db) this.provider = new ProviderSearch(db, s, request, now);
  }
  private backend() {
    return this.db ? this.db.tx(tx => searchBackend(tx, this.s)) : Promise.resolve(selectBackend(this.s));
  }
  async search(query: string, language: string, signal?: AbortSignal, who?: LlmClaims): Promise<SearchPage> {
    const backend = await this.backend();
    if (!backend) return fail(503, "管理员尚未配置联网搜索");
    return backend.name === "provider"
      ? this.provider!.search(backend.model, query, language, signal, who)
      : this.tavily.search(query, language, signal);
  }
  async usage(): Promise<SearchUsage> {
    const backend = await this.backend();
    if (backend?.name === "provider") return {
      backend: "provider", model: backend.model.name, configured: true, status: "available",
      plan: null, plan_used: null, plan_limit: null, key_used: null, key_limit: null, remaining: null, checked_at: null, error: null,
    };
    return { backend: backend ? "tavily" : null, model: null, ...(await this.tavily.usage()) };
  }
}
