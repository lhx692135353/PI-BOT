import type { FastifyReply } from "fastify";
import { MODEL_TIMEOUT_MS } from "@pi-bot/agent";
import { fail, type Database, type Row, type Tx } from "./db.js";
import type { Settings } from "./config.js";
import { Vault, type LlmClaims } from "./security.js";
import { recordGeneration, bounded } from "./observations.js";
import { applyConversationReasoning, applyProviderSearch, reasoningTelemetry } from "./providers.js";
import { randomUUID } from "node:crypto";

export interface Usage {
  input: number;
  output: number;
  cached?:number;reasoning?:number;
}
export function usageFrom(value: unknown): Usage | null {
  const data = value as Row | null;
  const u = data?.response?.usage ?? data?.usage;
  if (!u || typeof u !== "object") return null;
  const input = Number(u.input_tokens ?? 0),
    output = Number(u.output_tokens ?? 0);
  return Number.isFinite(input) && Number.isFinite(output)
    ? { input, output,...(u.input_tokens_details?.cached_tokens!==undefined?{cached:Number(u.input_tokens_details.cached_tokens)}:{}),...(u.output_tokens_details?.reasoning_tokens!==undefined?{reasoning:Number(u.output_tokens_details.reasoning_tokens)}:{}) }
    : null;
}
/** Picks the last usage block from an SSE body without buffering the whole stream. */
export class SseUsage {
  private buffer = "";
  private data: string[] = [];
  usage: Usage | null = null;
  output:unknown='';
  firstToken?:Date;
  error?:string;
  terminal=false;
  private line(line: string) {
    if (!line) {
      try {
        const event=JSON.parse(this.data.join("\n"));
        this.usage = usageFrom(event) ?? this.usage;
        if(['response.completed','response.incomplete','response.failed'].includes(event.type))this.terminal=true;
        if(/response\.(?:output_text|reasoning_text|reasoning_summary_text|function_call_arguments)\.delta/.test(String(event.type)))this.firstToken??=new Date();
        if(event.type==='response.output_text.delta'){
          this.firstToken??=new Date();if(typeof this.output==='string'&&this.output.length<65536)this.output=(this.output+String(event.delta??'')).slice(0,65536);
        }
        if(Array.isArray(event.response?.output))this.output=bounded(event.response.output);
        if(event.type==='response.failed'||event.type==='response.incomplete'||event.type==='error')this.error='模型返回失败或未完成';
      } catch { /* comments, empty frames and non-JSON events */ }
      this.data = [];
    } else if (line.startsWith("data:")) {
      this.data.push(line.slice(5).trimStart());
    }
  }
  push(chunk: string) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, "");
      this.buffer = this.buffer.slice(i + 1);
      this.line(line);
    }
    if (this.buffer.length > 1_000_000) this.buffer = "";
  }
  end() {
    if (this.buffer) this.line(this.buffer.replace(/\r$/, ""));
    this.buffer = "";
    this.line("");
  }
}
export async function findModel(tx: Tx, requested: unknown) {
  const id = typeof requested === "string" ? requested : "";
  const m = /^[0-9a-f-]{36}$/i.test(id)
    ? await tx.one("SELECT * FROM models WHERE model_id=$1 AND enabled", [id])
    : await tx.one(
        "SELECT * FROM models WHERE enabled ORDER BY is_default DESC, created_at LIMIT 1",
      );
  if (!m) fail(404, "模型不存在或已停用");
  return m!;
}
export const endpoint = (m: Row) => `${m.base_url.replace(/\/+$/, "")}/responses`;
export async function recordUsage(
  db: Database,
  claims: LlmClaims,
  modelId: string,
  usage: Usage | null,
) {
  await db
    .tx((tx) =>
      tx.insert("usage_logs", {
        user_id: claims.sub,
        bot_id: claims.bot ?? null,
        model_id: modelId,
        source: claims.src,
        input_tokens: Math.max(0, Math.round(usage?.input ?? 0)),
        output_tokens: Math.max(0, Math.round(usage?.output ?? 0)),
      }),
    )
    .catch(() => {});
}
const openAiError = (reply: FastifyReply, status: number, message: string) =>
  reply.code(status).send({ error: { message, type: "pi_bot_proxy" } });

export async function proxyResponses(
  db: Database,
  s: Settings,
  claims: LlmClaims,
  model: Row,
  body: Row,
  reply: FastifyReply,
  signal: AbortSignal,
  correlation?:{run:Row;generationId?:string;parentTool?:string},
) {
  if (correlation?.run.execution_policy === "device_only") {
    const admitted = await db.tx(async tx => {
      const r = correlation!.run;
      const root = await tx.one("SELECT r.run_id FROM bot_runs r JOIN automation_rounds ar ON ar.run_id=r.run_id WHERE r.automation_id=$1 AND ar.status='active'", [r.automation_id]);
      if (!root || claims.src !== "device") return false;
      return !!await tx.one(`UPDATE bot_runs SET automation_calls=automation_calls+1
        WHERE run_id=$1 AND status='running' AND NOT cancel_requested AND automation_calls<$2 AND deadline_at>now() RETURNING run_id`, [root.run_id, s.automationModelCalls]);
    });
    if (!admitted) return openAiError(reply, 429, "目标检查已停止或达到本轮模型调用上限");
  }
  const key = new Vault(s.vaultFile).open(model.secret, model.model_id);
  const reasoning = applyConversationReasoning(applyProviderSearch({
    ...body,
    model: model.provider_model,
    max_output_tokens: Math.min(body.max_output_tokens ?? model.max_tokens, model.max_tokens),
    store: false,
  }, model, correlation?.run.lane), model, correlation?.run.lane);
  const payload = reasoning.payload;
  const started=new Date(),generationId=correlation?.generationId??randomUUID();
  let captured:unknown=null,observedUsage:Usage|null=null,firstToken:Date|undefined,traceError:string|undefined;
  try {
  let upstream: Response;
  try {
    upstream = await fetch(endpoint(model), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]),
      redirect: "error",
    });
  } catch {
    traceError="无法连接模型服务";
    return openAiError(reply, 502, "无法连接模型服务");
  }
  if (!upstream.ok || !upstream.body) {
    traceError=`模型服务 HTTP ${upstream.status}`;
    await upstream.body?.cancel().catch(() => {});
    await recordUsage(db, claims, model.model_id, null);
    // Provider bodies can echo request details; only the status is surfaced.
    return openAiError(
      reply,
      upstream.status === 429 ? 429 : 502,
      `模型服务返回错误（HTTP ${upstream.status}）`,
    );
  }
  const type = upstream.headers.get("content-type") ?? "application/json";
  if (!type.includes("text/event-stream")) {
    const text = await upstream.text();
    let usage: Usage | null = null;
    try {
      const parsed=JSON.parse(text);usage = usageFrom(parsed);captured=parsed.output??parsed;
      if(['failed','incomplete'].includes(parsed.status))traceError='模型返回失败或未完成';
    } catch {
      /* non-JSON bodies are passed through unchanged */
    }
    observedUsage=usage;
    await recordUsage(db, claims, model.model_id, usage);
    return reply.code(200).header("content-type", type).send(text);
  }
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const sse = new SseUsage(),
    decoder = new TextDecoder();
  try {
    for await (const chunk of upstream.body) {
      sse.push(decoder.decode(chunk, { stream: true }));
      if (!reply.raw.write(chunk))
        await new Promise((r) => reply.raw.once("drain", r));
    }
  } catch {
    traceError="模型流中断";
    /* client or provider closed the stream */
  } finally {
    sse.push(decoder.decode());
    sse.end();
    reply.raw.end();
    observedUsage=sse.usage;captured=sse.output;firstToken=sse.firstToken;traceError??=sse.error;
    if(!sse.terminal)traceError??="模型流未完成";
    await recordUsage(db, claims, model.model_id, sse.usage);
  }
  } finally {
    if(correlation) await recordGeneration(db,s,correlation.run,{id:generationId,parentTool:correlation.parentTool,started,firstToken,input:body.input,output:captured,usage:observedUsage,error:traceError,model,secrets:[key],reasoning:reasoningTelemetry(payload,reasoning.source)}).catch(()=>{});
  }
}

/** One-shot completion used by the admin connectivity test and memory summaries. */
export async function complete(
  model: Row,
  key: string,
  messages: { role: string; content: string }[],
  maxTokens: number,
  timeoutMs = 60000,
) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(endpoint(model), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: model.provider_model,
      input: messages,
      max_output_tokens: Math.min(maxTokens, model.max_tokens),
      stream: false,
      store: false,
    }),
    signal,
    redirect: "error",
  }).catch((error: unknown) => {
    if (
      signal.aborted ||
      (error instanceof Error && error.name === "TimeoutError")
    )
      throw new Error("模型请求超时");
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    throw new Error(
      `无法连接模型服务${typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : ""}`,
    );
  });
  if (!response.ok)
    throw new Error(`模型服务返回错误（HTTP ${response.status}）`);
  const data = (await response.json().catch(() => {
    if (signal.aborted) throw new Error("模型请求超时");
    throw new Error("模型服务返回的响应不是有效 JSON");
  })) as Row;
  if (data.status === "failed" || data.error) {
    const code = data.error?.code;
    throw new Error(
      `模型生成失败${typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? ` (${code})` : ""}`,
    );
  }
  if (data.status === "incomplete") {
    if (data.incomplete_details?.reason === "max_output_tokens")
      throw new Error(
        "模型输出不完整：已达到输出 token 上限（思考内容也计入额度）",
      );
    throw new Error("模型输出不完整");
  }
  return {
    text: (data.output ?? [])
      .filter((item: Row) => item.type === "message")
      .flatMap((item: Row) => item.content ?? [])
      .filter((part: Row) => part.type === "output_text")
      .map((part: Row) => part.text)
      .join(""),
    usage: usageFrom(data),
  };
}
