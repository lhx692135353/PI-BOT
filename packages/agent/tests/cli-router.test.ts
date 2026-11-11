import test from "node:test";
import assert from "node:assert/strict";
import { chooseRoute, routeState, systemOneBody, type RouteState, type SessionCard } from "../src/cli-router.js";

const cards: SessionCard[] = [
  { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", title: "修登录", summary: "正在改登录页", last_user: "登录按钮没反应", updated_at: "2026-11-01T00:00:00.000Z" },
  { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "写测试", summary: "正在补路由测试", last_user: "把测试补上", updated_at: "2026-11-02T00:00:00.000Z" },
];

function state(message: string, recent: RouteState["recent"] = []): RouteState {
  return routeState(message, recent, cards);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("close probabilities on 继续 ask instead of starting a session", async () => {
  const calls: string[] = [];
  const decision = await chooseRoute(state("继续"), {
    fetch: async (url) => {
      calls.push(String(url));
      return jsonResponse({
        answers: {
          session: { choice: cards[1].id, probabilities: { [cards[0].id]: 0.42, [cards[1].id]: 0.48, __new__: 0.1 } },
          clear: { noul: 0.9 },
        },
      });
    },
    proxyUrl: "http://jev.example/llm/v1",
    token: "short-token",
    modelId: "model-1",
  });
  assert.equal(decision.action, "ask");
  if (decision.action === "ask") assert.match(decision.prompt, /修登录/);
  assert.deepEqual(calls, ["http://jev.example/llm/v1/systemone"]);
});

test("新开一个 creates a session without asking the model", async () => {
  let called = false;
  const decision = await chooseRoute(state("新开一个"), {
    fetch: async () => { called = true; return jsonResponse({}); },
    proxyUrl: "http://jev.example/llm/v1",
    token: "short-token",
    modelId: "model-1",
  });
  assert.deepEqual(decision, { action: "new" });
  assert.equal(called, false);
});

test("a high-confidence choice resumes that session", async () => {
  const decision = await chooseRoute(state("把断言补完整"), {
    fetch: async () => jsonResponse({
      answers: {
        session: { choice: cards[1].id, probabilities: { [cards[0].id]: 0.12, [cards[1].id]: 0.8, __new__: 0.08 } },
        clear: { noul: 0.9 },
      },
    }),
    proxyUrl: "http://jev.example/llm/v1",
    token: "short-token",
  });
  assert.deepEqual(decision, { action: "resume", session_id: cards[1].id });
});

test("d3 and SaaS System One bodies match except for the model", () => {
  const routed = state("继续", [
    { role: "user", text: "登录按钮没反应" },
    { role: "assistant", text: "我先看一下点击处理。" },
  ]);
  const local = systemOneBody(routed, "vllm-sr/d3");
  const saas = systemOneBody(routed, "jev-latest");
  assert.equal(local.model, "vllm-sr/d3");
  assert.equal(saas.model, "jev-latest");
  const { model: localModel, ...localRest } = local;
  const { model: saasModel, ...saasRest } = saas;
  assert.deepEqual(localRest, saasRest);
  assert.notEqual(localModel, saasModel);
  assert.equal(local.state.message, "继续");
  assert.equal(local.state.recent.length, 2);
  assert.equal(local.state.sessions.length, 2);
  assert.ok(local.questions.session.criteria[cards[0].id]);
  assert.equal(local.questions.session.criteria.__new__.length > 0, true);
});

test("a numbered reply resumes only after the timeline asked", async () => {
  const asked = state("1", [{ role: "assistant", text: "请回复编号、会话标题，或说「新开一个」：\n1. 修登录" }]);
  const unasked = state("1");
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls += 1; return jsonResponse({}, 503); };
  const picked = await chooseRoute(asked, { fetch: fetchImpl, proxyUrl: "http://jev.example/llm/v1", token: "t", modelId: "m" });
  assert.deepEqual(picked, { action: "resume", session_id: cards[0].id });
  assert.equal(calls, 0);
  const fallback = await chooseRoute(unasked, { fetch: fetchImpl, proxyUrl: "http://jev.example/llm/v1", token: "t", modelId: "m" });
  assert.equal(fallback.action, "ask");
  assert.equal(calls, 2);
});

test("local d3 is preferred and a dead router falls through to the current model, then asks", async () => {
  const bodies: { url: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const href = String(url);
    bodies.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (href.endsWith("/health")) return jsonResponse({ ok: true });
    if (href.endsWith("/v1/systemone")) return jsonResponse({}, 503);
    if (href.endsWith("/systemone")) return jsonResponse({}, 404);
    if (href.endsWith("/responses")) return jsonResponse({ output: [{ content: [{ text: "not json" }] }] });
    return jsonResponse({}, 500);
  };
  const decision = await chooseRoute(state("继续"), {
    fetch: fetchImpl,
    local: { url: "http://127.0.0.1:8000/v1/systemone", model: "vllm-sr/d3" },
    proxyUrl: "http://jev.example/llm/v1",
    token: "short-token",
    modelId: "model-1",
  });
  assert.equal(decision.action, "ask");
  assert.equal(bodies[0].url, "http://127.0.0.1:8000/health");
  const local = bodies.find(item => item.url.endsWith("/v1/systemone"))!;
  const saas = bodies.find(item => item.url.endsWith("/llm/v1/systemone"))!;
  assert.equal((local.body as { model: string }).model, "vllm-sr/d3");
  assert.equal("model" in (saas.body as object), false);
  assert.deepEqual((local.body as { state: unknown }).state, (saas.body as { state: unknown }).state);
  assert.deepEqual((local.body as { questions: unknown }).questions, (saas.body as { questions: unknown }).questions);
  assert.equal((bodies.find(item => item.url.endsWith("/responses"))!.body as { model: string }).model, "model-1");
});
