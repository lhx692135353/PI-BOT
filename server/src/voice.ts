import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import WebSocket, { type RawData } from "ws";
import { HttpError, fail, type Database, type Row, type Tx } from "./db.js";
import type { Settings } from "./config.js";
import type { Hub } from "./hub.js";
import type { VoiceAnnouncer } from "./agents.js";
import { cancelTask, createTask, listTasks, messageTask, readTask, type AgentDispatcher } from "./agents.js";
import { goalRequest, manageGoals, wakeGoals } from "./automations.js";
import { ACTIVE, collaborators, finishRun, ownBot, resolveModel, systemPrompt } from "./bots.js";
import { forgottenContext, maskForgotten } from "./memory.js";
import { complete } from "./llm.js";
import { cancelRun, dispatchDevice } from "./runs.js";
import { readVoiceTicket, user, Vault, type LlmClaims } from "./security.js";
import { inferProvider } from "./providers.js";

const SAMPLE_RATE = 16000;
const MAX_CALL_MS = 120 * 60 * 1000;
const PLAYBACK_WAIT_MS = 8000;

/** Voice stays off until a voice model is chosen. A same-host override lets tests stand in for the provider. */
export function voiceEndpoint(model: { base_url: string; provider?: string | null; voice_model?: string | null }, override?: string): string | null {
  const voice = model.voice_model?.trim();
  if (!voice) return null;
  const provider = model.provider || inferProvider(model.base_url);
  if (provider === "xai") return `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(voice)}`;
  if (provider === "bailian") {
    let host = "token-plan.cn-beijing.maas.aliyuncs.com";
    try {
      const name = new URL(model.base_url).hostname.toLowerCase();
      if (name === "dashscope-intl.aliyuncs.com" || (name.endsWith(".dashscope.aliyuncs.com") && (name.includes("intl") || name.includes("ap-southeast")))) host = "dashscope-intl.aliyuncs.com";
      else if (name === "dashscope.aliyuncs.com" || name.endsWith(".dashscope.aliyuncs.com")) host = "dashscope.aliyuncs.com";
      else if (name) host = name;
    } catch { /* Token Plan in Beijing */ }
    return `wss://${host}/api-ws/v1/realtime?model=${encodeURIComponent(voice)}`;
  }
  if (!override) return null;
  let base: URL;
  let target: URL;
  try { base = new URL(model.base_url); target = new URL(override); } catch { return null; }
  if (target.host !== base.host) return null;
  target.searchParams.set("model", voice);
  return target.toString();
}

const fn = (name: string, description: string, properties: Row, required: string[]) => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties, required },
});
const VOICE_TOOLS = [
  fn("start_task", "立刻安排后台任务并返回，不要等待它做完。需要搜索、读写文件、执行命令或较长推理时使用。纯联网用 execution=cloud，本机文件或命令用 device。", {
    title: { type: "string" }, task: { type: "string" }, execution: { type: "string", enum: ["device", "cloud"] },
  }, ["title", "task"]),
  fn("task_status", "查看本 Bot 的后台任务，不等待完成。", { task_id: { type: "string" } }, []),
  fn("task_message", "给进行中的任务补充要求。", { task_id: { type: "string" }, text: { type: "string" } }, ["task_id", "text"]),
  fn("cancel_task", "用户明确要求停止时取消任务。全部停止时 all=true。", { task_id: { type: "string" }, all: { type: "boolean" } }, []),
  fn("ask_agent", "把任务交给同一用户的另一个智能体，立即返回，不要等待。", {
    agent: { type: "string" }, task: { type: "string" }, execution: { type: "string", enum: ["device", "cloud"] },
  }, ["agent", "task"]),
  fn("goal_manage", "用户在追求一件会持续的事时，自己记下目标，不要等用户说建立目标。也可查询、修改、暂停、恢复、完成或停止。先 list 避免重复。create 必须给 goal 和 authorization。", {
    action: { type: "string", enum: ["list", "create", "update", "pause", "resume", "complete", "stop"] },
    goal_id: { type: "string" }, all: { type: "boolean" },
    title: { type: "string" }, goal: { type: "string" }, authorization: { type: "string" },
    expected_version: { type: "number" },
  }, ["action"]),
];

type Phase = "connecting" | "listening" | "speaking" | "thinking";
type AbortWork = { kind: "device"; send(m: Row): void; runId: string } | { kind: "cloud"; runId: string };

function jsonSend(ws: WebSocket | undefined, value: Row) {
  if (!ws || ws.readyState !== 1) return;
  if (ws.bufferedAmount > 4_000_000) return;
  ws.send(JSON.stringify(value));
}

/**
 * One live phone call per bot. The API holds the Grok socket; clients only send
 * and play 16 kHz PCM. The call occupies the conversation slot until it ends.
 */
export class VoiceHub implements VoiceAnnouncer {
  private byBot = new Map<string, VoiceSession>();
  private byRun = new Map<string, VoiceSession>();
  private gates = new Map<string, Promise<unknown>>();
  constructor(
    private db: Database,
    private s: Settings,
    private hub: Hub,
    private dispatcher: AgentDispatcher,
  ) {}
  announce(botId: string, task: Row) {
    return this.byBot.get(botId)?.ensureAnnouncement(task) ?? false;
  }
  attach(ws: WebSocket, req: FastifyRequest) {
    const url = new URL(req.url, "http://localhost");
    return (async () => {
      let auth: { userId: string; botId: string; callId: string | null };
      try {
        auth = await this.authenticate(url);
      } catch (error) {
        closeWith(ws, error);
        return;
      }
      return this.gate(auth.botId, async () => {
        const current = this.byBot.get(auth.botId);
        if (auth.callId) {
          const session = this.byRun.get(auth.callId);
          if (!session || session.userId !== auth.userId || session.ending) return closeWith(ws, new HttpError(404, "通话已结束"));
          session.adopt(ws);
          return;
        }
        if (current?.ending) return closeWith(ws, new HttpError(409, "通话正在结束"));
        if (current && current.userId === auth.userId && !current.client) {
          current.adopt(ws);
          return;
        }
        if (current) return closeWith(ws, new HttpError(409, "正在语音通话"));
        try {
          await this.start(ws, auth.userId, auth.botId);
        } catch (error) {
          closeWith(ws, error);
        }
      });
    })();
  }
  private gate<T>(key: string, fn: () => Promise<T>) {
    const prev = this.gates.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.gates.set(key, run);
    void run.finally(() => { if (this.gates.get(key) === run) this.gates.delete(key); });
    return run;
  }
  private async authenticate(url: URL) {
    const callId = url.searchParams.get("call_id");
    const ticket = url.searchParams.get("ticket");
    if (ticket) {
      const claims = await readVoiceTicket(ticket, this.s);
      const active = await this.db.tx((tx) => tx.get("users", claims.userId));
      if (!active || active.disabled) fail(401, "账号不可用");
      return { userId: claims.userId, botId: claims.botId, callId };
    }
    const token = url.searchParams.get("token");
    const botId = url.searchParams.get("bot");
    if (!token || !botId) throw new HttpError(401, "需要认证");
    const u = await this.db.tx((tx) => user(tx, { authorization: `Bearer ${token}` }, this.s));
    await this.db.tx((tx) => ownBot(tx, u.user_id, botId));
    return { userId: String(u.user_id), botId, callId };
  }
  private async start(ws: WebSocket, userId: string, botId: string) {
    const opened = await this.db.tx(async (tx) => {
      const bot = await ownBot(tx, userId, botId, true);
      const model = await resolveModel(tx, bot);
      if (!model) throw new HttpError(503, "管理员尚未配置可用模型");
      const endpoint = voiceEndpoint(model, this.s.voiceRealtimeUrl);
      if (!endpoint) throw new HttpError(422, "当前模型未开通语音");
      const aborts = await cancelTextTurns(tx, this.hub, userId, botId);
      const orphans = await tx.rows("SELECT * FROM bot_runs WHERE bot_id=$1 AND origin='voice' AND status = ANY($2)", [botId, ACTIVE]);
      for (const run of orphans) {
        await finishRun(tx, run.run_id, "failed", "语音通话已中断", "语音通话已中断");
        await tx.rows("UPDATE bot_messages SET visibility='public' WHERE message_id=$1", [run.assistant_message_id]);
      }
      const memory = await tx.get("bot_memories", bot.bot_id);
      const forgotten = await forgottenContext(tx, bot.bot_id);
      const agents = await collaborators(tx, bot);
      const instructions = `${systemPrompt(bot, maskForgotten(memory?.summary ?? "", forgotten), "cloud", { lane: "conversation", agents })}

你正在和用户打电话。用口语短句，不要 Markdown、列表、链接堆砌、任务编号和工具日志。闲聊和已有依据的简单问题直接回答。需要搜索、读写文件、执行命令或较长推理时立刻 start_task，用一句话说明正在做什么，然后停下，不要等待做完。用户一打断就停止当前这句。后台任务结束后，系统会把结果发给你，你再用一两句话告诉用户。其他智能体只用 ask_agent，不要等待。`;
      const runId = randomUUID();
      const userMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      const seq = await tx.one("UPDATE bots SET next_seq=next_seq+2, last_active_at=now() WHERE bot_id=$1 RETURNING next_seq", [botId]);
      const lease = new Date(Date.now() + this.s.leaseSeconds * 1000);
      await tx.insert("bot_runs", {
        run_id: runId, bot_id: botId, user_id: userId, request_id: `voice:${runId}`,
        executor: "cloud", status: "running", origin: "voice", lane: "conversation",
        user_message_id: userMessageId, assistant_message_id: assistantMessageId,
        started_at: new Date(), lease_until: lease, trace_id: runId,
      });
      await tx.insert("bot_messages", {
        message_id: userMessageId, bot_id: botId, run_id: runId, seq: seq!.next_seq - 2,
        role: "user", content: "语音通话", status: "completed", visibility: "internal",
      });
      await tx.insert("bot_messages", {
        message_id: assistantMessageId, bot_id: botId, run_id: runId, seq: seq!.next_seq - 1,
        role: "assistant", content: "", status: "running", executor: "cloud", visibility: "internal", progress: [],
      });
      await wakeGoals(tx, botId);
      await tx.notify({ user_id: userId, bot_id: botId });
      const key = new Vault(this.s.vaultFile).open(model.secret, model.model_id);
      return { runId, assistantMessageId, endpoint, instructions, key, model, aborts };
    });
    for (const abort of opened.aborts) {
      if (abort.kind === "device") abort.send({ type: "cancel", run_id: abort.runId });
      else if (this.s.runnerToken) {
        await fetch(`${this.s.runnerUrl}/runs/${abort.runId}/cancel`, {
          method: "POST", headers: { Authorization: `Bearer ${this.s.runnerToken}` }, signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
    }
    const session = new VoiceSession(this.db, this.s, this.hub, this.dispatcher, {
      userId, botId, runId: opened.runId, assistantMessageId: opened.assistantMessageId,
      endpoint: opened.endpoint, instructions: opened.instructions, key: opened.key, model: opened.model,
    }, () => {
      this.byBot.delete(botId);
      this.byRun.delete(opened.runId);
    });
    this.byBot.set(botId, session);
    this.byRun.set(opened.runId, session);
    session.adopt(ws);
    session.openUpstream();
  }
}

async function cancelTextTurns(tx: Tx, hub: Hub, userId: string, botId: string) {
  const runs = await tx.rows("SELECT * FROM bot_runs WHERE bot_id=$1 AND lane='conversation' AND origin<>'voice' AND status = ANY($2)", [botId, ACTIVE]);
  const aborts: AbortWork[] = [];
  for (const run of runs) {
    const result = await cancelRun(tx, hub, userId, run.run_id);
    if (result.notify) aborts.push({ kind: "device", send: (m) => result.notify!.send(m), runId: run.run_id });
    else if (run.executor === "cloud" && run.status !== "queued") aborts.push({ kind: "cloud", runId: run.run_id });
    const current = await tx.get("bot_runs", run.run_id);
    if (current && ACTIVE.includes(current.status)) await finishRun(tx, run.run_id, "cancelled", null);
  }
  return aborts;
}

/** Keep groups of 3 samples so a later chunk can finish an incomplete 24 kHz frame. */
export function pcm24kTo16k(input: Buffer): { audio: Buffer; pending: Buffer } {
  const even = input.length - (input.length % 2);
  const groups = Math.floor(even / 2 / 3);
  const used = groups * 3 * 2;
  const audio = Buffer.alloc(groups * 4);
  for (let group = 0; group < groups; group++) {
    const offset = group * 6;
    const first = input.readInt16LE(offset);
    const second = input.readInt16LE(offset + 2);
    const third = input.readInt16LE(offset + 4);
    audio.writeInt16LE(first, group * 4);
    audio.writeInt16LE(Math.round((second + third) / 2), group * 4 + 2);
  }
  const pending = Buffer.alloc(input.length - used);
  input.copy(pending, 0, used);
  return { audio, pending };
}

function closeWith(ws: WebSocket, error: unknown) {
  const status = error instanceof HttpError ? error.status : 500;
  const detail = error instanceof HttpError && typeof error.detail === "string" ? error.detail : "语音通话没有接通";
  jsonSend(ws, { type: "error", detail });
  const code = status === 401 ? 4401 : status === 404 ? 4404 : status === 409 ? 4409 : 4403;
  try { ws.close(code, detail.slice(0, 120)); } catch { /* already closed */ }
}

class VoiceSession {
  readonly userId: string;
  ending = false;
  client?: WebSocket;
  private upstream?: WebSocket;
  private resumeTried = false;
  private muted = false;
  private phase: Phase = "connecting";
  private conversationId?: string;
  private grace?: NodeJS.Timeout;
  private lease?: NodeJS.Timeout;
  private limit?: NodeJS.Timeout;
  private playbackIdle = true;
  private playbackWaiters: (() => void)[] = [];
  private responseOpen = false;
  private tools: { call_id: string; name: string; arguments: string }[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private announcements: { taskId: string; text: string }[] = [];
  private speakingTask?: { taskId: string; text: string };
  private transcript: string[] = [];
  private assistant = "";
  private earlyAudio: Buffer[] = [];
  private pcmPending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private replacing = false;
  constructor(
    private db: Database,
    private s: Settings,
    private hub: Hub,
    private dispatcher: AgentDispatcher,
    private call: {
      userId: string; botId: string; runId: string; assistantMessageId: string;
      endpoint: string; instructions: string; key: string; model: Row;
    },
    private onGone: () => void,
  ) {
    this.userId = call.userId;
    this.lease = setInterval(() => void this.renew(), Math.min(20000, Math.max(1000, s.leaseSeconds * 250)));
    this.limit = setTimeout(() => void this.finish("completed", "timeout"), MAX_CALL_MS);
  }
  get runId() { return this.call.runId; }
  adopt(ws: WebSocket) {
    clearTimeout(this.grace);
    this.grace = undefined;
    if (this.client && this.client !== ws) {
      this.replacing = true;
      this.client.close(1000);
      this.replacing = false;
    }
    this.client = ws;
    jsonSend(ws, { type: "hello", call_id: this.call.runId, sample_rate: SAMPLE_RATE, phase: this.phase });
    this.hub.publish(this.userId, { type: "call", bot_id: this.call.botId, call_id: this.call.runId, phase: this.phase });
    ws.on("message", (raw, isBinary) => {
      if (this.client !== ws || this.ending) return;
      if (isBinary) this.audioFromClient(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
      else this.control(raw);
    });
    ws.on("close", () => {
      if (this.client !== ws) return;
      this.client = undefined;
      if (this.ending || this.replacing) return;
      this.grace = setTimeout(() => void this.finish("completed", "disconnect"), this.s.voiceGraceMs);
    });
  }
  openUpstream() {
    const bailian = this.provider() === "bailian";
    const url = !bailian && this.conversationId ? `${this.call.endpoint}&conversation_id=${encodeURIComponent(this.conversationId)}` : this.call.endpoint;
    const upstream = new WebSocket(url, { headers: { Authorization: `Bearer ${this.call.key}` } });
    this.upstream = upstream;
    upstream.on("open", () => {
      this.resumeTried = false;
      upstream.send(JSON.stringify(bailian ? {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          voice: "longanqian",
          instructions: this.call.instructions,
          input_audio_format: "pcm",
          output_audio_format: "pcm",
          turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800 },
          tools: VOICE_TOOLS,
        },
      } : {
        type: "session.update",
        session: {
          voice: "eve",
          instructions: this.call.instructions,
          turn_detection: { type: "server_vad" },
          reasoning: { effort: "none" },
          resumption: { enabled: true },
          tools: VOICE_TOOLS,
          audio: {
            input: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, transport: "binary", transcription: { model: "grok-transcribe" } },
            output: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, transport: "binary" },
          },
        },
      }));
      for (const chunk of this.earlyAudio) this.sendAudio(upstream, chunk);
      this.earlyAudio = [];
    });
    upstream.on("message", (data, isBinary) => this.onUpstream(data, isBinary));
    upstream.on("error", () => {});
    upstream.on("close", () => {
      if (this.upstream !== upstream || this.ending) return;
      this.upstream = undefined;
      if (this.resumeTried) void this.finish("failed", "upstream");
      else { this.resumeTried = true; this.openUpstream(); }
    });
  }
  ensureAnnouncement(task: Row) {
    if (this.ending) return false;
    const taskId = String(task.task_id);
    if (this.speakingTask?.taskId === taskId || this.announcements.some((item) => item.taskId === taskId)) return true;
    const result = task.status === "completed" ? String(task.result || "没有文字结果") : task.status === "failed" ? String(task.error || "没有完成") : "已取消";
    this.announcements.push({
      taskId,
      text: `系统通知：一项后台任务结束了。请用一两句口语告诉用户，不要念编号和日志。\n标题：${String(task.title || task.task || "").slice(0, 80)}\n状态：${task.status}\n结果：${result.slice(0, 1500)}`,
    });
    this.pump();
    return true;
  }
  private provider() {
    return String(this.call.model.provider || inferProvider(String(this.call.model.base_url ?? "")));
  }
  /** Token Plan realtime returns 24 kHz PCM. Desktop and Android play 16 kHz. */
  private playPcm(pcm: Buffer) {
    if (!pcm.length || this.client?.readyState !== 1) return;
    let audio = pcm;
    if (this.provider() === "bailian") {
      const converted = pcm24kTo16k(Buffer.concat([this.pcmPending, pcm]));
      this.pcmPending = converted.pending;
      audio = converted.audio;
    }
    if (!audio.length) return;
    this.client.send(audio);
    this.playbackIdle = false;
    this.setPhase("speaking");
  }
  private sendAudio(upstream: WebSocket, chunk: Buffer) {
    if (upstream.readyState !== 1 || !chunk.length) return;
    if (this.provider() === "bailian") upstream.send(JSON.stringify({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }));
    else upstream.send(chunk);
  }
  private audioFromClient(chunk: Buffer) {
    if (this.muted || !chunk.length) return;
    const upstream = this.upstream;
    if (upstream?.readyState === 1) this.sendAudio(upstream, chunk);
    else {
      this.earlyAudio.push(chunk);
      let bytes = this.earlyAudio.reduce((n, part) => n + part.length, 0);
      while (bytes > 32000 && this.earlyAudio.length) bytes -= this.earlyAudio.shift()!.length;
    }
  }
  private control(raw: RawData) {
    let message: Row;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === "ping") jsonSend(this.client, { type: "pong" });
    else if (message.type === "hangup") void this.finish("completed", "hangup");
    else if (message.type === "mute") this.muted = !!message.on;
    else if (message.type === "barge") this.barge();
    else if (message.type === "playback_idle") this.notePlaybackIdle();
  }
  private onUpstream(data: RawData, isBinary: boolean) {
    if (this.ending) return;
    if (isBinary) {
      this.playPcm(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    let event: Row;
    try { event = JSON.parse(data.toString()); } catch { return; }
    const type = String(event.type ?? "");
    if (type === "session.updated" && this.phase === "connecting") this.setPhase("listening");
    else if (type === "conversation.created" && event.conversation?.id) this.conversationId = String(event.conversation.id);
    else if (type === "input_audio_buffer.speech_started") this.barge();
    else if (type === "conversation.item.input_audio_transcription.completed" && event.transcript) this.transcript.push(`用户：${String(event.transcript).slice(0, 2000)}`);
    else if (type === "response.created") { this.responseOpen = true; this.setPhase(this.tools.length ? "thinking" : "speaking"); }
    else if ((type === "response.output_text.delta" || type === "response.text.delta" || type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") && event.delta) this.assistant = (this.assistant + String(event.delta)).slice(0, 8000);
    else if ((type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") && !this.assistant.trim() && event.transcript) this.assistant = String(event.transcript).slice(0, 8000);
    else if ((type === "response.output_audio.delta" || type === "response.audio.delta") && typeof event.delta === "string") {
      this.playPcm(Buffer.from(event.delta, "base64"));
    } else if (type === "response.function_call_arguments.done") {
      this.tools.push({ call_id: String(event.call_id ?? ""), name: String(event.name ?? ""), arguments: String(event.arguments ?? "{}") });
      this.setPhase("thinking");
    } else if (type === "response.done") {
      this.responseOpen = false;
      if (this.assistant.trim()) { this.transcript.push(`助手：${this.assistant.trim()}`); this.assistant = ""; }
      const cancelled = event.response?.status === "cancelled";
      const clientPresent = !!this.client;
      this.enqueue(() => this.afterResponse(cancelled, clientPresent));
    } else if (type === "error" && !this.responseOpen && this.phase === "connecting") void this.finish("failed", "upstream");
  }
  private barge() {
    jsonSend(this.client, { type: "clear" });
    this.playbackIdle = true;
    this.notePlaybackIdle();
    if (this.upstream?.readyState === 1) this.upstream.send(JSON.stringify({ type: "response.cancel" }));
    if (this.speakingTask) {
      this.announcements.unshift(this.speakingTask);
      this.speakingTask = undefined;
    }
    this.setPhase("listening");
  }
  private async afterResponse(cancelled: boolean, clientPresent: boolean) {
    if (this.speakingTask) {
      const spoken = this.speakingTask;
      this.speakingTask = undefined;
      if (!cancelled && clientPresent) await this.ack(spoken.taskId);
      else this.announcements.unshift(spoken);
    }
    const tools = this.tools.splice(0);
    if (tools.length && !this.ending) {
      this.setPhase("thinking");
      for (const tool of tools) {
        const output = await this.executeTool(tool);
        this.upstreamSend({ type: "conversation.item.create", item: { type: "function_call_output", call_id: tool.call_id, output } });
      }
      await this.waitPlayback();
      if (!this.ending) {
        this.upstreamSend({ type: "response.create" });
        return;
      }
    }
    if (!this.ending) this.setPhase("listening");
    this.pump();
  }
  private pump() {
    if (this.ending || this.responseOpen || this.speakingTask || !this.playbackIdle || !this.client || this.upstream?.readyState !== 1) return;
    const next = this.announcements.shift();
    if (!next) return;
    this.speakingTask = next;
    this.upstreamSend({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: next.text }] },
    });
    this.upstreamSend({ type: "response.create" });
  }
  private async executeTool(tool: { call_id: string; name: string; arguments: string }) {
    let args: Row = {};
    try { args = JSON.parse(tool.arguments || "{}"); } catch { return JSON.stringify({ error: "参数无效" }); }
    const claims: LlmClaims = { sub: this.userId, src: "cloud", bot: this.call.botId };
    try {
      if (tool.name === "start_task" || tool.name === "ask_agent") {
        const created = await this.db.tx((tx) => createTask(tx, this.hub, this.userId, claims, {
          run_id: this.call.runId,
          kind: tool.name === "start_task" ? "background" : "delegation",
          wait: false,
          title: typeof args.title === "string" ? args.title : undefined,
          task: String(args.task ?? ""),
          agent: typeof args.agent === "string" ? args.agent : undefined,
          execution: args.execution === "cloud" || args.execution === "device" ? args.execution : undefined,
          request_id: tool.call_id || randomUUID(),
        }));
        if (created.run?.executor === "device") await dispatchDevice(this.db, this.s, this.hub, created.run.run_id);
        return JSON.stringify({ title: created.task.title, status: created.task.status, task_id: created.task.id });
      }
      if (tool.name === "task_status") {
        const status = await this.db.tx(async (tx) => args.task_id ? readTask(tx, this.userId, claims, String(args.task_id)) : listTasks(tx, this.userId, claims, this.call.runId));
        return JSON.stringify(status);
      }
      if (tool.name === "task_message") {
        const updated = await this.db.tx((tx) => messageTask(tx, this.userId, claims, String(args.task_id), {
          run_id: this.call.runId, text: String(args.text ?? ""), request_id: tool.call_id || randomUUID(),
        }));
        return JSON.stringify(updated);
      }
      if (tool.name === "cancel_task") {
        const notifies: { runId: string; send(m: Row): void }[] = [];
        const tasks = await this.db.tx(async (tx) => {
          if (!args.task_id && args.all !== true) fail(422, "请指定任务，或明确取消全部");
          const rows = args.all === true
            ? await tx.rows("SELECT task_id FROM agent_tasks WHERE user_id=$1 AND (parent_bot_id=$2 OR target_bot_id=$2) AND status IN ('queued','running','waiting_approval') ORDER BY created_at", [this.userId, this.call.botId])
            : [{ task_id: String(args.task_id) }];
          const results = [];
          for (const row of rows) {
            const cancelled = await cancelTask(tx, this.hub, this.userId, claims, row.task_id);
            if (cancelled.notify) notifies.push(cancelled.notify);
            results.push(cancelled.task);
          }
          return results;
        });
        for (const notify of notifies) notify.send({ type: "cancel", run_id: notify.runId });
        return JSON.stringify({ tasks });
      }
      if (tool.name === "goal_manage") {
        const parsed = goalRequest.safeParse({ ...args, run_id: this.call.runId, request_id: tool.call_id || randomUUID() });
        if (!parsed.success) return JSON.stringify({ error: "参数无效" });
        const managed = await this.db.tx((tx) => manageGoals(tx, this.userId, claims, parsed.data));
        return JSON.stringify(managed);
      }
      return JSON.stringify({ error: "没有这个操作" });
    } catch (error) {
      const detail = error instanceof HttpError && typeof error.detail === "string" ? error.detail : "操作失败";
      return JSON.stringify({ error: detail });
    }
  }
  private async ack(taskId: string) {
    await this.db.tx((tx) => tx.rows("UPDATE agent_tasks SET delivered_at=now() WHERE task_id=$1 AND delivered_at IS NULL", [taskId]));
  }
  private waitPlayback() {
    if (this.playbackIdle || !this.client) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.playbackIdle = true; resolve(); }, PLAYBACK_WAIT_MS);
      this.playbackWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }
  private notePlaybackIdle() {
    this.playbackIdle = true;
    const waiters = this.playbackWaiters.splice(0);
    for (const waiter of waiters) waiter();
    this.pump();
  }
  private setPhase(phase: Phase) {
    if (this.phase === phase || this.ending) return;
    this.phase = phase;
    jsonSend(this.client, { type: "state", phase });
    this.hub.publish(this.userId, { type: "call", bot_id: this.call.botId, call_id: this.call.runId, phase });
  }
  private upstreamSend(value: Row) {
    if (this.upstream?.readyState === 1) this.upstream.send(JSON.stringify(value));
  }
  private enqueue(fn: () => Promise<void>) {
    this.chain = this.chain.then(fn, fn);
  }
  private async renew() {
    if (this.ending) return;
    const kept = await this.db.tx((tx) => tx.one(
      "UPDATE bot_runs SET lease_until=$2 WHERE run_id=$1 AND status='running' RETURNING run_id",
      [this.call.runId, new Date(Date.now() + this.s.leaseSeconds * 1000)],
    ));
    if (!kept) void this.finish("failed", "lease");
  }
  private async finish(state: "completed" | "failed", reason: string) {
    if (this.ending) return;
    this.ending = true;
    clearInterval(this.lease);
    clearTimeout(this.limit);
    clearTimeout(this.grace);
    this.hub.publish(this.userId, { type: "call", bot_id: this.call.botId, call_id: this.call.runId, phase: "ended", reason });
    jsonSend(this.client, { type: "ended", reason });
    try { this.client?.close(1000); } catch { /* already closed */ }
    try { this.upstream?.close(); } catch { /* already closed */ }
    if (this.assistant.trim()) this.transcript.push(`助手：${this.assistant.trim()}`);
    const summary = await this.summarize();
    const failed = state === "failed";
    await this.db.tx(async (tx) => {
      const run = await tx.get("bot_runs", this.call.runId);
      if (run && ACTIVE.includes(run.status)) await finishRun(tx, this.call.runId, state, failed ? "语音通话已中断" : null, summary);
      await tx.rows("UPDATE bot_messages SET visibility='public', content=$2, status=$3 WHERE message_id=$1", [
        this.call.assistantMessageId, summary, failed ? "failed" : "completed",
      ]);
      await tx.notify({ user_id: this.userId, bot_id: this.call.botId });
    });
    this.onGone();
    this.dispatcher.kick();
  }
  private async summarize() {
    const lines = this.transcript.filter(Boolean);
    if (!lines.length) return "语音通话已结束。";
    try {
      const { text } = await complete(this.call.model, this.call.key, [
        { role: "system", content: "把这段语音通话整理成给聊天时间线的简短中文总结。不要逐字稿，不要编造没有发生的事，两三句话即可。" },
        { role: "user", content: lines.join("\n").slice(0, 12000) },
      ], 400, 20000);
      return text.trim() || "语音通话已结束。";
    } catch {
      return "语音通话已结束。";
    }
  }
}
