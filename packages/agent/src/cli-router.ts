/** Session routing for a local Cursor or Codex agent. JEV and vLLM d3 share one System One body. */

export const RECENT_TURNS = 6;
export const SESSION_LIMIT = 20;
export const CARD_CHARS = 240;
export const CLEAR_MIN = 0.6;
export const GAP_MIN = 0.15;
export const NEW_MIN = 0.55;

export interface SessionCard {
  id: string;
  title: string;
  summary: string;
  last_user: string;
  updated_at: string;
}
export interface RouteTurn { role: "user" | "assistant"; text: string }
export interface RouteState {
  message: string;
  recent: RouteTurn[];
  sessions: SessionCard[];
}
export type RouteDecision =
  | { action: "resume"; session_id: string }
  | { action: "new" }
  | { action: "ask"; prompt: string };

export interface ChoiceAnswer {
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}
export interface ClearAnswer { noul: number }

const NEW_SESSION = /^(新开一个(会话)?|新会话|新建会话|另开一个|new session)$/i;

export function clip(text: string, limit = CARD_CHARS) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export function wantsNewSession(message: string) {
  return NEW_SESSION.test(message.trim());
}

export function routeState(message: string, recent: RouteTurn[], sessions: SessionCard[]): RouteState {
  return {
    message: clip(message, 2000),
    recent: recent.slice(-RECENT_TURNS).map(turn => ({ role: turn.role, text: clip(turn.text, 500) })),
    sessions: sessions.slice(0, SESSION_LIMIT).map(session => ({
      ...session,
      title: clip(session.title, 80),
      summary: clip(session.summary),
      last_user: clip(session.last_user, 200),
    })),
  };
}

/** Same request for vLLM d3 and SaaS JEV. `model` is the only field that differs. */
export function systemOneBody(state: RouteState, model: string) {
  const criteria: Record<string, string> = {};
  for (const session of state.sessions) {
    criteria[session.id] = [session.title, session.summary, session.last_user ? `最近：${session.last_user}` : "", session.updated_at]
      .filter(Boolean).join("；");
  }
  criteria.__new__ = "现有会话都不对，应该新开一个 CLI 会话";
  return {
    model,
    state: { message: state.message, recent: state.recent, sessions: state.sessions },
    questions: {
      session: {
        type: "choice",
        instructions: "这条用户消息应该续哪一个已有 CLI 会话？要同时看 recent 和每个会话的摘要。只看当前一句往往不够。材料不足或主题对不上时选 __new__。",
        criteria,
      },
      clear: {
        type: "noul",
        instructions: "现有材料是否足以断定这条消息属于某一个已有会话，而不是应该新建？",
      },
    },
  };
}

export function fallbackInput(state: RouteState, modelId: string) {
  const body = systemOneBody(state, "fallback");
  return {
    model: modelId,
    store: false,
    max_output_tokens: 400,
    input: [
      { role: "system", content: "你只输出一个 JSON 对象，不要解释。字段 session 是选项 id 或 __new__，clear 是 0 到 1（是否足以断定属于已有会话），probabilities 是每个选项的概率且和约为 1。只看当前一句往往不够，要结合 recent 和会话摘要。" },
      { role: "user", content: JSON.stringify({ state: body.state, options: body.questions.session.criteria }) },
    ],
  };
}

function ask(state: RouteState): RouteDecision {
  if (!state.sessions.length) return { action: "new" };
  const lines = state.sessions.map((session, index) => `${index + 1}. ${session.title || "未命名会话"}`).join("\n");
  return { action: "ask", prompt: `这句话对得上不止一个正在进行的工作，我先不继续执行。请回复编号、会话标题，或说「新开一个」：\n${lines}` };
}

export function matchUserPick(state: RouteState): RouteDecision | null {
  if (wantsNewSession(state.message)) return { action: "new" };
  const previous = state.recent.at(-1);
  const asked = previous?.role === "assistant" && previous.text.includes("请回复编号");
  if (!asked) return null;
  const text = state.message.trim();
  const exact = state.sessions.find(session => session.title && session.title === text);
  if (exact) return { action: "resume", session_id: exact.id };
  const numbered = text.match(/^(\d{1,2})$/);
  if (numbered) {
    const session = state.sessions[Number(numbered[1]) - 1];
    if (session) return { action: "resume", session_id: session.id };
  }
  return null;
}

export function decideFromScores(state: RouteState, session: ChoiceAnswer, clear: ClearAnswer): RouteDecision {
  const probabilities = session.probabilities && Object.keys(session.probabilities).length
    ? session.probabilities
    : { [session.choice]: session.confidence ?? 1 };
  const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  const top = ranked[0]?.[1] ?? 0;
  const second = ranked[1]?.[1] ?? 0;
  const gap = top - second;
  if (session.choice === "__new__") {
    if (top >= NEW_MIN && gap >= GAP_MIN) return { action: "new" };
    return ask(state);
  }
  if (state.sessions.some(item => item.id === session.choice) && clear.noul >= CLEAR_MIN && gap >= GAP_MIN)
    return { action: "resume", session_id: session.choice };
  return ask(state);
}

export function scoresFromSystemOne(body: unknown): { session: ChoiceAnswer; clear: ClearAnswer } | null {
  const answers = (body as { answers?: { session?: ChoiceAnswer; clear?: { noul?: number } } } | null)?.answers;
  if (!answers?.session?.choice || typeof answers.clear?.noul !== "number") return null;
  return { session: answers.session, clear: { noul: answers.clear.noul } };
}

export function scoresFromFallbackText(text: string): { session: ChoiceAnswer; clear: ClearAnswer } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { session?: string; clear?: number; probabilities?: Record<string, number> };
    if (!parsed.session || typeof parsed.clear !== "number") return null;
    return { session: { choice: parsed.session, probabilities: parsed.probabilities, confidence: parsed.probabilities?.[parsed.session] }, clear: { noul: parsed.clear } };
  } catch {
    return null;
  }
}

export function responseText(body: unknown): string {
  const output = (body as { output?: { content?: { text?: string }[] }[] } | null)?.output ?? [];
  return output.flatMap(item => item.content ?? []).map(part => part.text ?? "").join("");
}

export interface RouteDeps {
  fetch: typeof fetch;
  local?: { url: string; model: string };
  proxyUrl?: string;
  token?: string;
  modelId?: string;
  signal?: AbortSignal;
}

async function healthy(url: string, fetchImpl: typeof fetch, signal?: AbortSignal) {
  try {
    const response = await fetchImpl(`${new URL(url).origin}/health`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(800)]) : AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown, token?: string, signal?: AbortSignal) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

/** Prefer a healthy local d3, then SaaS JEV, then the bot's current model. Failure asks instead of guessing. */
export async function chooseRoute(state: RouteState, deps: RouteDeps): Promise<RouteDecision> {
  const picked = matchUserPick(state);
  if (picked) return picked;
  if (!state.sessions.length) return { action: "new" };
  const attempts: (() => Promise<{ session: ChoiceAnswer; clear: ClearAnswer } | null>)[] = [];
  if (deps.local?.url) attempts.push(async () => {
    if (!await healthy(deps.local!.url, deps.fetch, deps.signal)) return null;
    const body = await postJson(deps.fetch, deps.local!.url, systemOneBody(state, deps.local!.model), undefined, deps.signal);
    return body ? scoresFromSystemOne(body) : null;
  });
  if (deps.proxyUrl && deps.token) attempts.push(async () => {
    const body = systemOneBody(state, "jev");
    const answered = await postJson(deps.fetch, `${deps.proxyUrl!.replace(/\/+$/, "")}/systemone`, { state: body.state, questions: body.questions }, deps.token, deps.signal);
    return answered ? scoresFromSystemOne(answered) : null;
  });
  if (deps.proxyUrl && deps.token && deps.modelId) attempts.push(async () => {
    const answered = await postJson(deps.fetch, `${deps.proxyUrl!.replace(/\/+$/, "")}/responses`, fallbackInput(state, deps.modelId!), deps.token, deps.signal);
    return answered ? scoresFromFallbackText(responseText(answered)) : null;
  });
  for (const attempt of attempts) {
    try {
      const scores = await attempt();
      if (scores) return decideFromScores(state, scores.session, scores.clear);
    } catch {
      /* The next backend, or a clarification, covers an unreachable router. */
    }
  }
  return ask(state);
}
