const TOKEN = "pi-bot-admin-token";

/** The console lives at `<server>/admin/`, so the API is always one level up. */
const server = new URL("../", location.href);
const adminApi = new URL("api/", location.href);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function detail(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map((v) => (v && typeof v === "object" && "msg" in v ? String(v.msg) : String(v))).join("；");
  return "请求失败";
}

export const session = {
  get token() {
    return localStorage.getItem(TOKEN);
  },
  set(token: string | null) {
    if (token) localStorage.setItem(TOKEN, token);
    else localStorage.removeItem(TOKEN);
  },
};

async function request<T>(base: URL, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "auth/login") {
    session.set(null);
    location.reload();
  }
  if (!response.ok) throw new ApiError(response.status, detail(json.detail));
  return json as T;
}

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "user";
  disabled: boolean;
  created_at: string;
  bot_count?: number;
  devices?: Device[];
  computer?: { label: string; last_seen_at: string | null; online: boolean } | null;
}
export type ProviderName = "xai" | "bailian" | "custom";
export interface CatalogModel {
  id: string;
  context_window: number | null;
  max_tokens: number | null;
}
export interface Model {
  id: string;
  name: string;
  provider: ProviderName;
  base_url: string;
  provider_model: string;
  voice_model: string | null;
  context_window: number;
  max_tokens: number;
  enabled: boolean;
  is_default: boolean;
  updated_at: string;
}
export interface Device {
  id: string;
  username: string;
  platform: "linux" | "darwin" | "win32";
  label: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  online: boolean;
}
export interface Overview {
  users: number;
  bots: number;
  models: number;
  runs_today: number;
  tokens_today: number;
  devices_online: number;
}
export interface UsageRow {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  username?: string;
  name?: string;
}
export interface Usage {
  days: number;
  by_user: UsageRow[];
  by_model: UsageRow[];
  by_day: { day: string; source: string; calls: number; tokens: number }[];
}
export interface SearchUsage {
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
export type ModelInput = Omit<Model, "id" | "updated_at"> & { api_key?: string };

export const api = {
  login: (username: string, password: string) =>
    request<{ access_token: string; user: User }>(server, "auth/login", "POST", { username, password }),
  me: () => request<{ user: User }>(server, "me"),
  overview: () => request<Overview>(adminApi, "overview"),
  users: () => request<User[]>(adminApi, "users"),
  createUser: (body: { username: string; password: string; display_name: string; role: string }) =>
    request<User>(adminApi, "users", "POST", body),
  updateUser: (id: string, body: Partial<{ password: string; display_name: string; role: string; disabled: boolean }>) =>
    request<User>(adminApi, `users/${id}`, "PATCH", body),
  deleteUser: (id: string) => request(adminApi, `users/${id}`, "DELETE"),
  models: () => request<Model[]>(adminApi, "models"),
  modelCatalog: (body: { provider: "xai" | "bailian"; api_key?: string; model_id?: string }) =>
    request<{ chat: CatalogModel[]; voice: CatalogModel[] }>(adminApi, "model-catalog", "POST", body),
  createModel: (body: ModelInput) => request<Model>(adminApi, "models", "POST", body),
  updateModel: (id: string, body: Partial<ModelInput>) => request<Model>(adminApi, `models/${id}`, "PATCH", body),
  deleteModel: (id: string) => request(adminApi, `models/${id}`, "DELETE"),
  testModel: (id: string) =>
    request<{ ok: boolean; latency_ms: number; reply?: string; error?: string }>(adminApi, `models/${id}/test`, "POST"),
  devices: () => request<Device[]>(adminApi, "devices"),
  revokeDevice: (id: string) => request(adminApi, `devices/${id}/revoke`, "POST"),
  usage: (days: number) => request<Usage>(adminApi, `usage?days=${days}`),
  searchUsage: () => request<SearchUsage>(adminApi, "search/usage"),
};
