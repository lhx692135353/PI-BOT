import { z } from "zod";
const integer = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) =>
  z.coerce
    .number()
    .int()
    .min(min)
    .max(max)
    .parse(value ?? fallback);
export function settings(env = process.env) {
  return {
    tracingEnabled: /^(true|1|yes)$/i.test(env.LANGFUSE_TRACING_ENABLED ?? "false"),
    databaseUrl: z.string().min(1).parse(env.PI_BOT_DATABASE_URL),
    adminUsername: z
      .string()
      .min(1)
      .max(64)
      .parse(env.PI_BOT_ADMIN_USERNAME ?? "admin"),
    /** Only needed to create the first administrator. */
    adminPassword: z.string().min(8).optional().parse(env.PI_BOT_ADMIN_PASSWORD || undefined),
    jwtSecret: z.string().min(32).parse(env.PI_BOT_JWT_SECRET),
    jwtTtl: integer(env.PI_BOT_JWT_TTL_SECONDS, 7 * 86400, 60, 30 * 86400),
    llmTokenTtl: integer(env.PI_BOT_LLM_TOKEN_TTL_SECONDS, 900, 900, 86400),
    signatureSkew: integer(env.PI_BOT_SIGNATURE_SKEW_SECONDS, 300, 30, 3600),
    approvalTtl: integer(env.PI_BOT_APPROVAL_TTL_SECONDS, 900, 60, 86400),
    rpcTimeoutMs: integer(env.PI_BOT_RPC_TIMEOUT_MS, 10000, 1000, 60000),
    leaseSeconds: integer(env.PI_BOT_WORKER_LEASE_SECONDS, 60, 15, 3600),
    pollSeconds: z.coerce
      .number()
      .positive()
      .max(60)
      .parse(env.PI_BOT_WORKER_POLL_SECONDS ?? 1),
    /** Cloud runs one worker executes at once; delegating runs wait on their children. */
    workerConcurrency: integer(env.PI_BOT_WORKER_CONCURRENCY, 4, 1, 64),
    conversationConcurrency: integer(env.PI_BOT_CONVERSATION_CONCURRENCY, 4, 1, 64),
    /** How long a dropped voice socket keeps the Grok session before the call ends. */
    voiceGraceMs: integer(env.PI_BOT_VOICE_GRACE_MS, 15000, 200, 120000),
    /** Test override. Production calls follow an xAI model base URL. */
    voiceRealtimeUrl: env.PI_BOT_VOICE_REALTIME_URL?.trim() || undefined,
    automationRoundSeconds: integer(env.PI_BOT_AUTOMATION_ROUND_SECONDS, 300, 10, 1800),
    automationModelCalls: integer(env.PI_BOT_AUTOMATION_MODEL_CALLS, 20, 1, 200),
    automationDailyRounds: integer(env.PI_BOT_AUTOMATION_DAILY_ROUNDS, 96, 1, 10000),
    automationPatrolDailyRounds: integer(env.PI_BOT_AUTOMATION_PATROL_DAILY_ROUNDS, 8, 1, 1000),
    historyLimit: integer(env.PI_BOT_HISTORY_LIMIT, 40, 4, 400),
    memoryThreshold: integer(env.PI_BOT_MEMORY_THRESHOLD, 60, 10, 2000),
    vaultFile: env.PI_BOT_VAULT_FILE,
    internalUrl: (env.PI_BOT_INTERNAL_URL ?? "http://api:8000").replace(
      /\/+$/,
      "",
    ),
    runnerUrl: env.PI_BOT_RUNNER_URL ?? "http://runner:8001",
    runnerToken: env.PI_BOT_RUNNER_TOKEN,
    tavilyKey: env.PI_BOT_TAVILY_API_KEY?.trim() || undefined,
    adminDir: env.PI_BOT_ADMIN_DIR,
  };
}
export type Settings = ReturnType<typeof settings>;
