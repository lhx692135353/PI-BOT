import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { createApp } from "../src/app.js";
import { settings, type Settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { Worker } from "../src/worker.js";
import { voiceEndpoint } from "../src/voice.js";
import { eventually, resetDatabase, TEST_DB, tempDir, vaultFile } from "./helpers.js";

test("voice endpoint follows xAI and a same-host override", () => {
  assert.equal(voiceEndpoint("https://api.x.ai/v1"), "wss://api.x.ai/v1/realtime?model=grok-voice-latest");
  assert.equal(voiceEndpoint("https://example.com/v1"), null);
  assert.equal(voiceEndpoint("http://127.0.0.1:9/v1", "ws://127.0.0.1:9/v1/realtime"), "ws://127.0.0.1:9/v1/realtime?model=grok-voice-latest");
  assert.equal(voiceEndpoint("https://example.com/v1", "ws://127.0.0.1:9/v1/realtime"), null);
});

const skip = !TEST_DB && "需要 PI_BOT_TEST_DATABASE_URL";
let app: Awaited<ReturnType<typeof createApp>>;
let db!: Database;
let base: string;
let s: Settings;
let dir: ReturnType<typeof tempDir>;
let realtime: Awaited<ReturnType<typeof mockRealtime>>;

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const response = await fetch(base + path, {
    method,
    headers: { ...(payload ? { "content-type": "application/json" } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: payload,
  });
  const text = await response.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json };
}

function clientSocket(url: string) {
  const ws = new WebSocket(url);
  const frames: any[] = [];
  const audio: Buffer[] = [];
  const waiters: { match: (frame: any) => boolean; resolve: (frame: any) => void }[] = [];
  ws.on("message", (raw, isBinary) => {
    if (isBinary) { audio.push(Buffer.from(raw as Buffer)); return; }
    const frame = JSON.parse(raw.toString());
    frames.push(frame);
    for (const waiter of [...waiters]) if (waiter.match(frame)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  return {
    ws, frames, audio, opened, closed,
    send: (message: object) => ws.send(JSON.stringify(message)),
    next(match: (frame: any) => boolean, timeout = 8000) {
      const found = frames.find(match);
      if (found) return Promise.resolve(found);
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待通话消息超时 ${frames.map((frame) => frame.type).join(",")}`)), timeout);
        waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
      });
    },
  };
}

async function mockRealtime() {
  const http = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/v1/responses")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "通话总结：打过招呼。" }] }], usage: { input_tokens: 3, output_tokens: 5 } }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const messages: any[] = [];
  const waiters: { match: (frame: any) => boolean; resolve: (frame: any) => void }[] = [];
  let upstream: WebSocket | undefined;
  const push = (frame: any) => {
    messages.push(frame);
    for (const waiter of [...waiters]) if (waiter.match(frame)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  };
  http.on("upgrade", (req: IncomingMessage, socket, head) => {
    if (!(req.url ?? "").startsWith("/v1/realtime")) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      upstream = ws;
      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        const frame = JSON.parse(raw.toString());
        push(frame);
        if (frame.type === "session.update") {
          ws.send(JSON.stringify({ type: "session.updated", session: {} }));
          ws.send(JSON.stringify({ type: "conversation.created", conversation: { id: "conv-test" } }));
        }
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    realtimeUrl: `ws://127.0.0.1:${port}/v1/realtime`,
    send: (frame: object) => upstream?.send(JSON.stringify(frame)),
    next(match: (frame: any) => boolean, timeout = 8000) {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待上游消息超时 ${messages.map((frame) => frame.type).join(",")}`)), timeout);
        waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
      });
    },
    close: () => new Promise<void>((resolve) => { wss.close(); http.close(() => resolve()); }),
  };
}

before(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!);
  db = new Database(TEST_DB!);
  dir = tempDir();
  realtime = await mockRealtime();
  const env = {
    PI_BOT_DATABASE_URL: TEST_DB,
    PI_BOT_ADMIN_PASSWORD: "admin-password",
    PI_BOT_JWT_SECRET: "j".repeat(40),
    PI_BOT_VAULT_FILE: vaultFile(dir.path),
    PI_BOT_RUNNER_TOKEN: "r".repeat(40),
    PI_BOT_VOICE_REALTIME_URL: realtime.realtimeUrl,
    PI_BOT_VOICE_GRACE_MS: "2000",
    PI_BOT_WORKER_LEASE_SECONDS: "30",
  };
  s = settings(env);
  app = await createApp(s);
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
after(async () => {
  if (skip) return;
  await app?.close();
  await db?.close();
  await realtime?.close();
  dir?.cleanup();
});

test("a voice call replaces the text turn, speaks task results, and falls back to text", { skip }, async () => {
  const admin = await api("POST", "/auth/login", { body: { username: "admin", password: "admin-password" } });
  const created = await api("POST", "/admin/api/users", { token: admin.json.access_token, body: { username: "voice-user", password: "voice-password", display_name: "Voice" } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const user = await api("POST", "/auth/login", { body: { username: "voice-user", password: "voice-password" } });
  const token = user.json.access_token as string;
  const model = await api("POST", "/admin/api/models", {
    token: admin.json.access_token,
    body: { name: "语音模型", base_url: realtime.baseUrl, provider_model: "grok-voice-latest", api_key: "sk-voice", context_window: 32000, max_tokens: 1000 },
  });
  const other = await api("POST", "/admin/api/models", {
    token: admin.json.access_token,
    body: { name: "文本模型", base_url: "https://example.com/v1", provider_model: "text", api_key: "sk-text", context_window: 8000, max_tokens: 500 },
  });
  const bot = await api("POST", "/bots", { token, body: { name: "语音助手", persona: "说话干脆" } });
  assert.equal(bot.status, 200, JSON.stringify(bot.json));
  const botId = bot.json.id as string;
  const rejected = await api("PATCH", `/bots/${botId}`, { token, body: { model_id: other.json.id } });
  assert.equal(rejected.status, 200);
  const denied = clientSocket(`${base.replace(/^http/, "ws")}/ws/voice?token=${token}&bot=${botId}`);
  await denied.opened;
  const denial = await denied.next((frame) => frame.type === "error");
  assert.match(denial.detail, /不支持语音通话/);
  assert.equal(await denied.closed, 4403);
  assert.equal((await api("PATCH", `/bots/${botId}`, { token, body: { model_id: model.json.id } })).status, 200);

  const text = await api("POST", `/bots/${botId}/messages`, { token, body: { text: "先用文字问一句", request_id: randomUUID() } });
  assert.equal(text.status, 200, JSON.stringify(text.json));
  await db.tx((tx) => tx.rows("UPDATE bot_runs SET status='running', started_at=now(), lease_until=now()+interval '1 minute' WHERE run_id=$1", [text.json.run.id]));

  const call = clientSocket(`${base.replace(/^http/, "ws")}/ws/voice?token=${encodeURIComponent(token)}&bot=${botId}`);
  await call.opened;
  const hello = await call.next((frame) => frame.type === "hello");
  assert.equal(hello.sample_rate, 16000);
  await realtime.next((frame) => frame.type === "session.update");
  const voiceRun = await eventually(async () => {
    const row = await db.tx((tx) => tx.one("SELECT * FROM bot_runs WHERE bot_id=$1 AND origin='voice' AND status='running'", [botId]));
    return row || false;
  });
  assert.equal(voiceRun.origin, "voice");
  const cancelled = await db.tx((tx) => tx.get("bot_runs", text.json.run.id));
  assert.equal(cancelled.status, "cancelled");
  const page = await api("GET", `/bots/${botId}/messages`, { token });
  assert.equal(page.json.messages.some((message: any) => String(message.content).includes("你好呀")), false);
  const blocked = await api("POST", `/bots/${botId}/messages`, { token, body: { text: "通话中发文字", request_id: randomUUID() } });
  assert.equal(blocked.status, 409);

  const second = clientSocket(`${base.replace(/^http/, "ws")}/ws/voice?token=${encodeURIComponent(token)}&bot=${botId}`);
  await second.opened;
  assert.equal(await second.closed, 4409);

  realtime.send({ type: "conversation.item.input_audio_transcription.completed", transcript: "你好" });
  realtime.send({ type: "response.output_text.delta", delta: "你好呀" });
  realtime.send({
    type: "response.function_call_arguments.done",
    call_id: "call-task",
    name: "start_task",
    arguments: JSON.stringify({ title: "查资料", task: "查一下今天的新闻", execution: "cloud" }),
  });
  realtime.send({ type: "response.done", response: { id: "resp-tool", status: "completed" } });
  await realtime.next((frame) => frame.type === "conversation.item.create" && frame.item?.type === "function_call_output");
  const task = await eventually(async () => db.tx((tx) => tx.one("SELECT * FROM agent_tasks WHERE parent_run_id=$1 AND title='查资料'", [voiceRun.run_id])) || false);
  assert.equal(task.kind, "background");
  assert.equal(task.execution, "cloud");

  realtime.send({ type: "input_audio_buffer.speech_started" });
  const cleared = await call.next((frame) => frame.type === "clear");
  assert.equal(cleared.type, "clear");
  await realtime.next((frame) => frame.type === "response.cancel");

  const spoken = randomUUID();
  await db.tx((tx) => tx.insert("agent_tasks", {
    task_id: spoken, user_id: user.json.user.id, parent_run_id: voiceRun.run_id, parent_bot_id: botId, target_bot_id: botId,
    mode: "report", kind: "background", depth: 0, title: "查资料", task: "查一下今天的新闻", status: "completed",
    result: "语音回报标记", execution: "cloud", finished_at: new Date(),
  }));
  await db.tx((tx) => tx.notify({ user_id: user.json.user.id, bot_id: botId }));
  const announcement = await realtime.next((frame) => frame.type === "conversation.item.create" && String(frame.item?.content?.[0]?.text ?? "").includes("语音回报标记"));
  assert.match(announcement.item.content[0].text, /语音回报标记/);
  const pending = await db.tx((tx) => tx.get("agent_tasks", spoken));
  assert.equal(pending.delivered_at, null);

  call.ws.close();
  const ticket = await api("POST", `/bots/${botId}/voice/ticket`, { token });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.json));
  const resumed = clientSocket(`${base.replace(/^http/, "ws")}/ws/voice?ticket=${encodeURIComponent(ticket.json.ticket)}&call_id=${hello.call_id}`);
  await resumed.opened;
  const again = await resumed.next((frame) => frame.type === "hello");
  assert.equal(again.call_id, hello.call_id);
  resumed.send({ type: "hangup" });
  const summary = await eventually(async () => {
    const messages = await api("GET", `/bots/${botId}/messages`, { token });
    return messages.json.messages.find((message: any) => String(message.content).includes("通话总结")) || false;
  });
  assert.equal(summary.role, "assistant");
  assert.equal(summary.content.includes("你好呀"), false);
  const report = await eventually(async () => db.tx((tx) => tx.one("SELECT * FROM bot_runs WHERE request_id=$1", [`report:${spoken}`])) || false);
  assert.equal(report.origin, "report");
  const delivered = await db.tx((tx) => tx.get("agent_tasks", spoken));
  assert.ok(delivered.delivered_at);
});

test("a dropped call ends after the grace period and an expired voice lease is a voice failure", { skip }, async () => {
  const user = await api("POST", "/auth/login", { body: { username: "voice-user", password: "voice-password" } });
  const token = user.json.access_token as string;
  const bots = await api("GET", "/bots", { token });
  const botId = bots.json.bots.find((bot: any) => bot.name === "语音助手").id as string;
  const call = clientSocket(`${base.replace(/^http/, "ws")}/ws/voice?token=${encodeURIComponent(token)}&bot=${botId}`);
  await call.opened;
  const hello = await call.next((frame) => frame.type === "hello");
  call.ws.close();
  const ended = await eventually(async () => {
    const row = await db.tx((tx) => tx.get("bot_runs", hello.call_id));
    return row?.status === "completed" ? row : false;
  });
  assert.equal(ended.status, "completed");
  const late = clientSocket(`${base.replace(/^http/, "ws")}/ws/voice?token=${encodeURIComponent(token)}&bot=${botId}&call_id=${hello.call_id}`);
  await late.opened;
  assert.equal(await late.closed, 4404);

  const staleId = randomUUID();
  const userMessage = randomUUID();
  const assistant = randomUUID();
  await db.tx(async (tx) => {
    const seq = await tx.one("UPDATE bots SET next_seq=next_seq+2 WHERE bot_id=$1 RETURNING next_seq", [botId]);
    await tx.insert("bot_runs", {
      run_id: staleId, bot_id: botId, user_id: user.json.user.id, request_id: `voice:${staleId}`,
      executor: "cloud", status: "running", origin: "voice", lane: "conversation",
      user_message_id: userMessage, assistant_message_id: assistant,
      started_at: new Date(Date.now() - 120000), lease_until: new Date(Date.now() - 1000), trace_id: staleId,
    });
    await tx.insert("bot_messages", {
      message_id: userMessage, bot_id: botId, run_id: staleId, seq: seq!.next_seq - 2,
      role: "user", content: "语音通话", status: "completed", visibility: "internal",
    });
    await tx.insert("bot_messages", {
      message_id: assistant, bot_id: botId, run_id: staleId, seq: seq!.next_seq - 1,
      role: "assistant", content: "", status: "running", executor: "cloud", visibility: "internal", progress: [],
    });
  });
  const worker = new Worker(new Database(TEST_DB!), s);
  await worker.claim();
  const stale = await db.tx((tx) => tx.get("bot_runs", staleId));
  const message = await db.tx((tx) => tx.get("bot_messages", assistant));
  assert.equal(stale.status, "failed");
  assert.equal(stale.error, "语音通话已中断");
  assert.equal(message.visibility, "public");
  assert.equal(message.content, "语音通话已中断");
});


test("OpenAI voice uses a dedicated model, 24k base64 upstream and 16k PCM client", { skip }, async () => {
  const rt = await mockRealtime();
  const previous = { voiceProtocol: s.voiceProtocol, voiceRealtimeUrl: s.voiceRealtimeUrl, voiceModelId: s.voiceModelId };
  let call: ReturnType<typeof clientSocket> | undefined;
  try {
    const admin = await api("POST", "/auth/login", { body: { username: "admin", password: "admin-password" } });
    const token = admin.json.access_token;
    const voice = await api("POST", "/admin/api/models", { token, body: {
      name: "Dedicated realtime", base_url: rt.baseUrl, provider_model: "gpt-realtime", api_key: "sk-realtime", context_window: 32000, max_tokens: 1000,
    } });
    const text = await api("POST", "/admin/api/models", { token, body: {
      name: "Keep text model", base_url: rt.baseUrl, provider_model: "text-summary", api_key: "sk-summary", context_window: 32000, max_tokens: 1000,
    } });
    assert.equal(voice.status, 200);
    const bot = await api("POST", "/bots", { token, body: { name: "OpenAI phone", model_id: text.json.id } });
    assert.equal(bot.status, 200);
    s.voiceProtocol = "openai";
    s.voiceModelId = voice.json.id;
    s.voiceRealtimeUrl = rt.realtimeUrl + "?model=gpt-realtime";
    call = clientSocket(`${base.replace(/^http/, "ws")}/ws/voice?token=${token}&bot=${bot.json.id}`);
    await call.opened;
    const hello = await call.next(f => f.type === "hello");
    assert.equal(hello.sample_rate, 16000);
    const update = await rt.next(f => f.type === "session.update");
    assert.equal(update.session.type, "realtime");
    assert.equal(update.session.model, "gpt-realtime");
    assert.equal(update.session.audio.input.format.rate, 24000);
    assert.equal(update.session.audio.output.voice, "marin");
    assert.equal(update.session.turn_detection, undefined);
    call.ws.send(Buffer.alloc(3200));
    const input = await rt.next(f => f.type === "input_audio_buffer.append");
    assert.ok(Buffer.from(input.audio, "base64").length >= 4796);
    rt.send({ type: "response.output_audio.delta", delta: Buffer.alloc(4800).toString("base64") });
    await eventually(async () => call!.audio.length > 0);
    assert.equal(call.audio.reduce((n,b) => n+b.length, 0), 3200);
    const unchanged = await db.tx(tx => tx.get("bots", bot.json.id));
    assert.equal(unchanged.model_id, text.json.id);
    call.send({ type: "hangup" });
    await call.next(f => f.type === "ended");
    call.ws.close();
    await eventually(async () => {
      const run = await db.tx(tx => tx.get("bot_runs", hello.call_id));
      return run.status === "completed";
    });
  } finally {
    call?.ws.close();
    Object.assign(s, previous);
    await rt.close();
  }
});
