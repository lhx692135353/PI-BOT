import Fastify from "fastify";
import { z } from "zod";
import { imagesSchema } from './images.js';
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  remoteTools,
  a2uiTools,
  askAgentTool,
  taskTools,
  automationTools,
  CANCELLED,
  createBotAgent,
  webSearchTool,
  type AgentFactory,
  type AgentHandle,
} from "@pi-bot/agent";

const requestSchema = z.object({
  run: z.object({
    run_id: z.string().uuid(),
    operation_target:z.string().default("legacy"),
    memory_context:z.string().max(50000).optional(),
    task_id:z.string().uuid().optional(),checkpoint_version:z.number().int().min(0).optional(),
    observation_enabled:z.boolean().default(false),
    lane: z.enum(["conversation", "task"]).default("task"),
    execution_policy: z.enum(["any", "device_only"]).default("any"),
    automation_readonly: z.boolean().default(false),
    deadline_at: z.string().optional(),
    automation: z.unknown().optional(),
    instructions: z.array(z.object({ id: z.string().uuid(), text: z.string().max(8000) })).default([]),
    bot: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }),
    model: z.object({
      id: z.string().uuid(),
      name: z.string(),
      context_window: z.number().int().positive(),
      max_tokens: z.number().int().positive(),
    }),
    system: z.string(),
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string(), images: imagesSchema.optional() })),
    text: z.string().min(1),
    images: imagesSchema.optional(),
    search_enabled: z.boolean().default(false),
    agents_enabled: z.boolean().default(false),
    skills: z.array(z.object({ name: z.string().max(64), description: z.string().max(1024), version: z.number().int().positive() })).max(64).default([]),
  }),
  base_url: z.string().url(),
  token: z.string().min(16),
});

/**
 * Cloud execution for bots whose computer is offline: conversation, optional web
 * search and delegation to other bots only. It has no file system or shell
 * tools and never sees provider keys.
 */
export async function createRunner(options: { token: string; dir: string; factory?: AgentFactory }) {
  if (options.token.length < 32) throw new Error("Runner token 至少 32 字符");
  const app = Fastify({ bodyLimit: 16 * 1024 * 1024, logger: false });
  const factory = options.factory ?? createBotAgent;
  interface Running { agent?: AgentHandle; cancelled: boolean; prompted: boolean; received: Set<string>; pending: { id: string; text: string }[] }
  const active = new Map<string, Running>();
  const cancelledBeforeStart = new Map<string, number>();
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    const value = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from(`Bearer ${options.token}`);
    if (value.length !== expected.length || !timingSafeEqual(value, expected))
      return reply.code(401).send({ error: "认证失败" });
  });
  app.get("/health", () => ({ ok: true, active: active.size }));
  app.post("/runs/:id/cancel", async (req) => {
    const state = active.get((req.params as any).id);
    if (!state) {
      for (const [id, until] of cancelledBeforeStart) if (until < Date.now()) cancelledBeforeStart.delete(id);
      cancelledBeforeStart.set((req.params as any).id, Date.now() + 60000);
    }
    if (state) {
      state.cancelled = true;
      await state.agent?.abort();
    }
    return { ok: true };
  });
  app.post("/runs/:id/messages", async (req, reply) => {
    const body = z.object({ id: z.string().uuid(), text: z.string().min(1).max(8000) }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: "追加要求无效" });
    const state = active.get((req.params as any).id);
    if (!state || state.cancelled) return reply.code(409).send({ error: "任务尚未启动或已结束" });
    const i = body.data;
    if (state.received.has(i.id)) return { ok: true };
    state.received.add(i.id);
    try {
      if (!state.prompted) state.pending.push(i);
      else {
        if (!state.agent?.steer) throw new Error("执行器不支持追加要求");
        await state.agent.steer(i.text);
      }
    } catch {
      state.received.delete(i.id);
      return reply.code(503).send({ error: "追加要求暂未送达" });
    }
    return { ok: true };
  });
  app.post("/runs", async (req, reply) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: "运行参数无效" });
    const p = parsed.data;
    if ((p.run.execution_policy === "device_only" || p.run.automation) && !p.run.operation_target.startsWith("remote:")) return reply.code(403).send({ error: "目标检查仅允许电脑执行" });
    if (active.has(p.run.run_id)) return reply.code(409).send({ error: "运行已存在" });
    const state: Running = { cancelled: (cancelledBeforeStart.get(p.run.run_id) ?? 0) > Date.now(), prompted: false,
      received: new Set(p.run.instructions.map(i => i.id)), pending: [...p.run.instructions] };
    cancelledBeforeStart.delete(p.run.run_id);
    active.set(p.run.run_id, state);
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
    const emit = (value: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(value) + "\n");
    };
    reply.raw.on("close", () => {
      state.cancelled = true;
      void state.agent?.abort();
    });
    try {
      const cwd = join(options.dir, "empty");
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const api = p.base_url.replace(/\/llm\/v1\/?$/, "");
      const tools = [
        ...(p.run.lane === "conversation" ? [...taskTools(api, () => p.token, p.run.run_id), ...automationTools(api, () => p.token, p.run.run_id)] : []),
        ...(p.run.lane !== "conversation" && p.run.search_enabled ? [webSearchTool(api, () => p.token)] : []),
        ...(p.run.agents_enabled ? [askAgentTool(api, () => p.token, p.run.run_id, { conversation: p.run.lane === "conversation" })] : []),
      ];
      if(p.run.lane === "task" && p.run.operation_target.startsWith("remote:")) tools.push(...remoteTools(api,()=>p.token,p.run.run_id));
      if(p.run.automation) tools.push(...automationTools(api,()=>p.token,p.run.run_id,true));
      tools.push(...a2uiTools(messages => { emit({ type: "ui", messages }); }));
      state.agent = await factory({
        model: {
          id: p.run.model.id,
          name: p.run.model.name,
          baseUrl: p.base_url,
          modelId: p.run.model.id,
          contextWindow: p.run.model.context_window,
          maxTokens: p.run.model.max_tokens,
        },
        readonly:p.run.automation_readonly,
        apiKey: p.token,
        cwd,
        agentDir: join(options.dir, "pi", "bots", p.run.bot.id),
        systemPrompt: p.run.system,
        history: p.run.history,
        tools,
        skills: { baseUrl: api, token: () => p.token, runId: p.run.run_id, catalog: p.run.skills },
        runId:p.run.run_id,
        memory:{baseUrl:api,token:()=>p.token,runId:p.run.run_id,lane:p.run.lane,context:p.run.memory_context??'',taskId:p.run.task_id,checkpointVersion:p.run.checkpoint_version},
        onObservation:p.run.observation_enabled?e=>emit({type:'observation',...e}):undefined,
        onTool: (t) => emit({ type: "tool", ...t }),
        onProgress: (lines) => emit({ type: "progress", lines }),
      });
      if (state.cancelled) throw new Error(CANCELLED);
      const initial = state.pending.splice(0);
      for (const i of initial) emit({ type: "instruction_ack", id: i.id });
      state.prompted = true;
      const input = p.run.text + initial.map(i => `\n\n用户追加要求：\n${i.text}`).join("");
      const text = await state.agent.prompt(input, (t) => emit({ type: "text", text: t }), p.run.images);
      emit({ type: "done", state: "completed", text });
    } catch (e) {
      const cancelled = state.cancelled || (e instanceof Error && e.message === CANCELLED);
      emit({
        type: "done",
        state: cancelled ? "cancelled" : "failed",
        error: cancelled ? null : e instanceof Error && /模型|工具/.test(e.message) ? e.message : "模型请求失败，请稍后重试",
      });
    } finally {
      if(p.run.operation_target.startsWith("remote:")) await fetch(`${p.base_url.replace(/\/llm\/v1\/?$/, "")}/agent/remote/release`,{method:"POST",headers:{Authorization:`Bearer ${p.token}`,"Content-Type":"application/json"},body:JSON.stringify({run_id:p.run.run_id}),signal:AbortSignal.timeout(5000)}).catch(()=>{});
      state.agent?.dispose();
      active.delete(p.run.run_id);
      reply.raw.end();
    }
  });
  app.addHook("onClose", async () => {
    for (const s of active.values()) {
      s.cancelled = true;
      await s.agent?.abort();
    }
  });
  return app;
}

if (process.argv[1]?.endsWith("/runner.ts") || process.argv[1]?.endsWith("/runner.mjs")) {
  const app = await createRunner({
    token: process.env.PI_BOT_RUNNER_TOKEN ?? "",
    dir: process.env.PI_BOT_RUNNER_DATA_DIR ?? "/data",
  });
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PI_BOT_RUNNER_PORT ?? 8001) });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
}
