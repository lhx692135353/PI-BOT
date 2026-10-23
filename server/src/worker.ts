import { randomUUID } from "node:crypto";
import { Database, type Row } from "./db.js";
import { settings, type Settings } from "./config.js";
import { issueLlmToken, Vault } from "./security.js";
import { migrate } from "./migrate.js";
import { modelMessageContent, buildContext, finishRun, markRunning, recordTool, resolveModel, setContent, setProgress, type RunContext } from "./bots.js";
import { complete, recordUsage } from "./llm.js";

import { claimExecution } from "./scheduling.js";
import { maintainMemory } from "./memory-maintenance.js";
import { ObservationExporter } from "./langfuse-exporter.js";
import { recordObservation } from "./observations.js";
import {recordUi} from "./ui.js";

const RUN_LIMIT_MS = 30 * 60 * 1000;

/**
 * Executes cloud runs (computer offline) through the Runner and keeps each bot's
 * rolling memory summary up to date.
 */
export class Worker {
  readonly id = randomUUID();
  private stopped = false;
  private exporter:ObservationExporter;
  private controllers = new Set<AbortController>();
  private running = new Set<Promise<void>>();
  private compacting?: Promise<unknown>;
  private lastExport=0;
  constructor(
    readonly db: Database,
    readonly s: Settings,
  ) {
    this.exporter=new ObservationExporter(db,s);
    if (!s.runnerToken || s.runnerToken.length < 32) throw new Error("需要配置 PI_BOT_RUNNER_TOKEN（至少 32 字符）");
  }
  stop() {
    this.stopped = true;
    for (const c of this.controllers) c.abort();
  }
  async claim(): Promise<RunContext | undefined> {
    return this.db.tx(async (tx) => {
      const stale = await tx.rows(
        "SELECT run_id, origin, assistant_message_id FROM bot_runs WHERE executor='cloud' AND status='running' AND lease_until < now() FOR UPDATE SKIP LOCKED",
      );
      for (const r of stale) {
        if (r.origin === "voice") {
          await finishRun(tx, r.run_id, "failed", "语音通话已中断", "语音通话已中断");
          await tx.rows("UPDATE bot_messages SET visibility='public' WHERE message_id=$1", [r.assistant_message_id]);
        } else await finishRun(tx, r.run_id, "failed", "云端执行中断，请重新发送");
      }
      const candidates = await tx.rows("SELECT run_id FROM bot_runs WHERE executor='cloud' AND execution_policy='any' AND status='queued' AND NOT cancel_requested ORDER BY (lane='task'), (origin='report'), created_at LIMIT 100");
      let run: Row | null = null;
      for (const candidate of candidates) {
        run = await claimExecution(tx, candidate.run_id, this.s, this.id);
        if (run) break;
      }
      if (!run) return;
      await tx.notify({ user_id: run.user_id, bot_id: run.bot_id });
      try {
        return await buildContext(tx, this.s, run);
      } catch {
        await finishRun(tx, run.run_id, "failed", "管理员尚未配置可用模型");
      }
    });
  }
  async runOnce() {
    const job = await this.claim();
    if (!job) return false;
    await this.execute(job);
    return true;
  }
  private async execute(job: RunContext) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const owner = await this.db.tx((tx) => tx.get("bot_runs", job.run_id));
    let content = "",
      state: "completed" | "failed" | "cancelled" = "failed",
      error: string | null = "模型请求失败，请稍后重试",
      lost = false,
      cancelled = false,
      written = 0,
      beating = false;
    const headers = { Authorization: `Bearer ${this.s.runnerToken}`, "Content-Type": "application/json" };
    const cancelRunner = () =>
      fetch(`${this.s.runnerUrl}/runs/${job.run_id}/cancel`, { method: "POST", headers, signal: AbortSignal.timeout(5000) }).catch(() => {});
    const ours = (r: Row | undefined) => !!r && r.status === "running" && r.worker_id === this.id;
    const beat = async () => {
      if (beating) return;
      beating = true;
      try {
        await this.db.tx(async (tx) => {
          const r = await tx.get("bot_runs", job.run_id);
          if (!ours(r)) {
            lost = true;
            return;
          }
          cancelled = r.cancel_requested;
          await tx.rows("UPDATE bot_runs SET lease_until=$2 WHERE run_id=$1", [job.run_id, new Date(Date.now() + this.s.leaseSeconds * 1000)]);
        });
      } catch {
        lost = true;
      } finally {
        beating = false;
      }
      if (cancelled || lost || this.stopped) {
        await cancelRunner();
        controller.abort();
      }
    };
    const timer = setInterval(() => void beat(), Math.max(1000, Math.min(15000, this.s.leaseSeconds * 250)));
    const deadline = setTimeout(() => {
      error = job.lane === "conversation" ? "对话响应超时，请重新发送" : "运行超过 30 分钟，已停止";
      void cancelRunner();
      controller.abort();
    }, job.lane === "conversation" ? 60000 : RUN_LIMIT_MS);
    let sawDone = false;
    try {
      const token = await issueLlmToken({ sub: owner.user_id, src: "cloud", bot: job.bot.id }, this.s, Math.ceil(RUN_LIMIT_MS / 1000) + 300);
      const response = await fetch(`${this.s.runnerUrl}/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ run: job, base_url: `${this.s.internalUrl}/llm/v1`, token }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("Runner unavailable");
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const e = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (e.type === "text") {
            content = e.text;
            if (Date.now() - written >= 500) {
              written = Date.now();
              await this.db.tx(async (tx) => {
                const r = await tx.get("bot_runs", job.run_id);
                if (!ours(r)) return void (lost = true);
                await setContent(tx, r, content);
                await tx.notify(r.lane === "task" ? { user_id: r.user_id, bot_id: r.bot_id } : { user_id: r.user_id, bot_id: r.bot_id, message_id: r.assistant_message_id, content });
              });
            }
          } else if(e.type === "observation") {
            const {type,...observation}=e;
            await this.db.tx(async tx=>{const r=await tx.get("bot_runs",job.run_id);if(ours(r))await recordObservation(tx,r,observation,this.s.tracingEnabled);}).catch(()=>{});
          } else if (e.type === "instruction_ack") {
            await this.db.tx(tx => tx.rows("UPDATE agent_task_instructions SET delivered_at=now() WHERE task_id=$1 AND instruction_id=$2", [owner.task_id, e.id]));
          } else if (e.type === "ui") {
            await this.db.tx(async tx => { const r=await tx.get("bot_runs",job.run_id); if(ours(r)) await recordUi(tx,r,e.messages); });
          } else if (e.type === "progress") {
            content = "";
            written = 0;
            await this.db.tx(async (tx) => {
              const r = await tx.get("bot_runs", job.run_id);
              if (!ours(r)) return;
              await setProgress(tx, r, e.lines);
              await tx.notify({ user_id: r.user_id, bot_id: r.bot_id });
            });
          } else if (e.type === "tool")
            await this.db.tx(async (tx) => {
              const r = await tx.get("bot_runs", job.run_id);
              if (!ours(r)) return;
              await recordTool(tx, r, e);
              await tx.notify({ user_id: r.user_id, bot_id: r.bot_id });
            });
          else if (e.type === "done") {
            sawDone = true;
            state = e.state;
            error = e.error ?? null;
            if (typeof e.text === "string") content = e.text;
          }
        }
      }
      if (!sawDone) throw new Error("Runner stream interrupted");
    } catch {
      if (cancelled) {
        state = "cancelled";
        error = null;
      } else if (this.stopped) error = "云端执行中断，请重新发送";
      state = cancelled ? "cancelled" : "failed";
      await cancelRunner();
    } finally {
      clearInterval(timer);
      clearTimeout(deadline);
      this.controllers.delete(controller);
    }
    if (!lost)
      await this.db.tx(async (tx) => {
        const r = await tx.get("bot_runs", job.run_id);
        if (!ours(r)) return;
        await finishRun(tx, job.run_id, state, error, content);
      });
  }

  async compactOnce(): Promise<boolean> {
    return maintainMemory(this.db,this.s,this.id);
  }

  async runForever() {
    while (!this.stopped) {
      try {
        if(Date.now()-this.lastExport>=1000){this.lastExport=Date.now();void this.exporter.flush();}
        {
          const job = await this.claim();
          if (job) {
            const p: Promise<void> = this.execute(job)
              .catch(() => console.error("cloud run failed"))
              .finally(() => this.running.delete(p));
            this.running.add(p);
            continue;
          }
        }
        if (!this.compacting) this.compacting = this.compactOnce().then(did=>did||maintainMemory(this.db,this.s,this.id,true))
          .catch(() => {}).finally(() => { this.compacting = undefined; });
      } catch {
        console.error("cloud worker cycle failed");
      }
      await new Promise((resolve) => setTimeout(resolve, this.s.pollSeconds * 1000));
    }
    await Promise.all([...this.running, this.compacting]);
    await this.exporter.shutdown();
  }
}

if (process.argv[1]?.endsWith("/worker.ts") || process.argv[1]?.endsWith("/worker.mjs")) {
  const s = settings(),
    db = new Database(s.databaseUrl);
  await migrate(db);
  const worker = new Worker(db, s);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => worker.stop());
  try {
    await worker.runForever();
  } finally {
    await db.close();
  }
}
