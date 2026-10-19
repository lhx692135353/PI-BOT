import { mkdirSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { TASK_TOOL_NAMES } from "./tasks.js";
import { isInternalTool, SKILL_TOOLS, skillsExtension, type SkillOptions } from "./skills.js";
import { memoryExtension, MEMORY_TOOLS, type MemoryOptions } from "./hermes-memory/extension.js";
import { observationExtension, type Observation } from "./observations.js";
export type { Observation } from "./observations.js";

/**
 * A model reachable through the Pi Bot model proxy. `modelId` is the Pi Bot
 * model UUID; the proxy maps it to the provider model and injects the key.
 */
export interface ModelConfig {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}
export interface ToolActivity {
  id: string;
  name: string;
  state: "running" | "completed" | "failed";
  summary?: string;
}
export interface BotAgentOptions {
  model: ModelConfig;
  /** Short-lived proxy token; refresh with `setApiKey` on long runs. */
  apiKey: string;
  cwd: string;
  /** Pi's private state directory (no session files are written). */
  agentDir: string;
  systemPrompt: string;
  history: HistoryMessage[];
  memory?: MemoryOptions;
  readonly?: boolean;
  runId?:string;
  onObservation?:(event:Observation)=>void;
  tools: ToolDefinition[];
  /** Private skills are scoped by the authenticated run, never by model input. */
  skills?: SkillOptions;
  redactSecrets?: string[];
  onTool?: (activity: ToolActivity) => void;
  /** Completed, brief remarks before tool use, kept separate from the answer. */
  onProgress?: (lines: string[]) => void;
  /** Stop a model stream that sends no events; running tools are exempt. */
  modelIdleTimeoutMs?: number;
}
export interface AgentHandle {
  tools: string[];
  prompt(text: string, onText: (text: string) => void): Promise<string>;
  setApiKey(key: string): Promise<void>;
  steer?(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}
export type AgentFactory = (options: BotAgentOptions) => Promise<AgentHandle>;

export { a2uiTools, UI_INSTRUCTIONS } from "./a2ui.js";
export { webSearchTool } from "./web-search.js";
export { automationTools } from "./automations.js";
export { taskTools, TASK_TOOL_NAMES } from "./tasks.js";
export { askAgentTool, type AskAgentOptions } from "./ask-agent.js";
export { isInternalTool, type SkillSummary } from "./skills.js";

export const CANCELLED = "CANCELLED";
/** Safety ceiling for agent-authored progress. The agent chooses the words and how many segments. */
export const PROGRESS_SEGMENTS = 8;
export const PROGRESS_CHARS = 2000;

export function redactor(secrets: string[]) {
  const list = secrets.filter((s) => s.length >= 6);
  return (value: string) =>
    list.reduce((text, secret) => text.replaceAll(secret, "[已隐藏凭据]"), value);
}

const SUMMARY_KEYS = ["path", "query", "command", "pattern"];

/** One human-readable line for a tool call, preferring its most telling argument. */
export function summarize(value: unknown) {
  const args = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  if (args && typeof args.agent === "string" && typeof args.task === "string") {
    const task = args.task.replace(/\s+/g, " ").trim();
    return `${args.agent}：${task.length > 60 ? `${task.slice(0, 59)}…` : task}`;
  }
  const key = args && SUMMARY_KEYS.find((k) => typeof args[k] === "string" && args[k]);
  const text = key ? String(args![key]) : typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export class PiAgent implements AgentHandle {
  tools: string[];
  constructor(
    private session: AgentSession,
    private runtime: ModelRuntime,
    private provider: string,
    private redact: (value: string) => string,
    private onTool?: BotAgentOptions["onTool"],
    private onProgress?: BotAgentOptions["onProgress"],
    private modelIdleTimeoutMs = 120000,
    private privateSkills = false,
  ) {
    this.tools = session.getActiveToolNames();
  }
  setApiKey(key: string) {
    return this.runtime.setRuntimeApiKey(this.provider, key);
  }
  async prompt(text: string, onText: (text: string) => void) {
    let content = "",
      failed = false,
      aborted = false,
      settled = false,
      renderedUi = false;
    const progress: string[] = [];
    let idleTimer: NodeJS.Timeout | undefined, timedOut = false;
    const runningTools = new Set<string>();
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      if (!runningTools.size) idleTimer = setTimeout(() => { timedOut = true; void this.session.abort(); }, this.modelIdleTimeoutMs);
    };
    armIdleTimer();
    const unsubscribe = this.session.subscribe((event) => {
      const e = event as any;
      if (e.type === "tool_execution_start") runningTools.add(String(e.toolCallId ?? e.toolName));
      if (e.type === "tool_execution_end" && e.toolName === "show_ui" && !e.isError) renderedUi = true;
      if (e.type === "tool_execution_end") runningTools.delete(String(e.toolCallId ?? e.toolName));
      armIdleTimer();
      if (event.type === "message_start" && event.message.role === "assistant") {
        content = "";
      }
      if (e.type === "tool_execution_start" && !isInternalTool(e.toolName) && !TASK_TOOL_NAMES.has(e.toolName))
        this.onTool?.({
          id: String(e.toolCallId ?? e.toolName),
          name: e.toolName,
          state: "running",
          summary: this.redact(summarize(e.args)),
        });
      if (e.type === "tool_execution_end" && !isInternalTool(e.toolName) && !TASK_TOOL_NAMES.has(e.toolName))
        this.onTool?.({
          id: String(e.toolCallId ?? e.toolName),
          name: e.toolName,
          state: e.isError ? "failed" : "completed",
        });
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        content += event.assistantMessageEvent.delta;
        // Tool calls may arrive after the opening text. Buffer private-skill
        // sessions until the message is classified, so management remarks
        // cannot leak through transient WebSocket deltas.
        if (!this.privateSkills) onText(this.redact(content));
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const msg = event.message;
        content = msg.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");
        const internal = msg.content.some(c => c.type === "toolCall" && isInternalTool(c.name));
        if (!internal) onText(this.redact(content));
        failed = msg.stopReason === "error";
        aborted = msg.stopReason === "aborted";
        if (!failed && !aborted && msg.content.some((c) => c.type === "toolCall")) {
          const remark = this.redact(content).trim().slice(0, PROGRESS_CHARS);
          if (!internal && remark && !progress.includes(remark) && progress.length < PROGRESS_SEGMENTS) {
            progress.push(remark);
            this.onProgress?.([...progress]);
          }
          // The next model message is the answer. This remark stays in progress.
          content = "";
          onText("");
        }
      }
      if (event.type === "agent_settled") settled = true;
    });
    try {
      await this.session.prompt(text, { expandPromptTemplates: false });
      if (!settled) await this.session.waitForIdle();
      if (timedOut) throw new Error("模型长时间没有响应，已停止本次任务，请稍后重试");
      if (aborted) throw new Error(CANCELLED);
      if (failed) throw new Error("模型请求失败，请稍后重试或联系管理员检查模型配置");
      if (!content && !renderedUi) throw new Error("模型未返回文本");
      return this.redact(content);
    } finally {
      clearTimeout(idleTimer);
      unsubscribe();
    }
  }
  async steer(text: string) {
    await this.session.steer(text);
  }
  abort() {
    return this.session.abort();
  }
  dispose() {
    this.session.dispose();
  }
}

export const createBotAgent: AgentFactory = async (o) => {
  if (o.tools.some(tool => isInternalTool(tool.name) && !["automation_manage", "automation_finish"].includes(tool.name))) throw new Error("内部工具名称不能由外部工具覆盖");
  mkdirSync(o.agentDir, { recursive: true, mode: 0o700 });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const provider = `pi-bot-${o.model.id}`;
  runtime.registerProvider(provider, {
    baseUrl: o.model.baseUrl,
    api: "openai-responses",
    authHeader: true,
    models: [
      {
        id: o.model.modelId,
        name: o.model.name,
        reasoning: false,
        input: ["text"],
        contextWindow: o.model.contextWindow,
        maxTokens: o.model.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  await runtime.setRuntimeApiKey(provider, o.apiKey);
  const model = runtime.getModel(provider, o.model.modelId);
  if (!model) throw new Error("模型配置无法加载");
  const sessionManager = SessionManager.inMemory(o.cwd);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of o.history)
    sessionManager.appendMessage(
      m.role === "user"
        ? { role: "user", content: m.content, timestamp: Date.now() }
        : {
            role: "assistant",
            content: [{ type: "text", text: m.content }],
            api: "openai-responses",
            provider,
            model: o.model.modelId,
            usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
          },
    );
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 2, provider: { timeoutMs: 120000, maxRetries: 0 } },
    compaction: { enabled: true },
  });
  // Explicit factories only: never discover executable code or skills from the
  // user's home, library, ancestors, or another bot's private directory.
  const resourceLoader = new DefaultResourceLoader({
    cwd: o.cwd, agentDir: o.agentDir, settingsManager, systemPrompt: o.systemPrompt,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    appendSystemPromptOverride: () => [],
    extensionFactories: [...(o.skills ? [{ name: "bot-skills", factory: skillsExtension(o.skills) }] : []),...(o.memory?[{name:"bot-memory",factory:memoryExtension(o.memory)}]:[]),...(o.runId?[{name:"bot-observation",factory:observationExtension(o.runId,o.onObservation)}]:[])],
  });
  await resourceLoader.reload();
  if (resourceLoader.getExtensions().errors.length) throw new Error("内部能力插件加载失败");
  const allowed = new Set([...o.tools.map(t => t.name), ...(o.skills ? SKILL_TOOLS.filter(n => !o.readonly || n !== "skill_manage") : []),...(o.memory?MEMORY_TOOLS.filter(n=>n!== (o.memory!.lane==="task"?"resume_task":"task_checkpoint")):[])]);
  const { session } = await createAgentSession({
    cwd: o.cwd,
    agentDir: o.agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    noTools: "all",
    tools: [...allowed],
    customTools: o.tools,
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  const active = session.getActiveToolNames();
  if (active.length !== allowed.size || active.some((n) => !allowed.has(n))) {
    session.dispose();
    throw new Error("工具隔离校验失败");
  }
  return new PiAgent(
    session,
    runtime,
    provider,
    redactor([o.apiKey, ...(o.redactSecrets ?? [])]),
    o.onTool,
    o.onProgress,
    o.modelIdleTimeoutMs,
    !!o.skills,
  );
};
