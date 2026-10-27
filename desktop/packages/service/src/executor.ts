import { reportTools } from "@pi-bot/agent";
import { toolDescriptor, errorInfo } from "@pi-bot/runtime-contracts";
import { randomUUID } from 'node:crypto';
import type { ChatImage } from '@pi-bot/agent/images';
import { join } from 'node:path';
import { a2uiTools, askAgentTool, taskTools, automationTools, CANCELLED, CONVERSATION_TIMEOUT_MS, createBotAgent, webSearchTool, type AgentFactory, type AgentHandle, type ToolActivity, type SkillSummary } from '@pi-bot/agent';
import type { Mood } from '@pi-bot/bot-face';
import { PhoneAdb, isPhoneAdbCommand } from './phone.js';
import { commandShell } from './platform.js';
import { libraryDir, libraryTools, Sandbox } from './library.js';

/** What the server sends with `{type:'run'}`; mirrors server `RunContext`. */
export interface RunContext {
  run_id: string;
  executor: 'device' | 'cloud';
  lane?: 'conversation' | 'task';
  execution_policy?: 'any' | 'device_only';
  automation_readonly?: boolean;
  deadline_at?: string;
  automation?: { id: string; kind: 'review'; version: number; checkpoint_version: number; checkpoint: Record<string, unknown> };
  instructions?: { id: string; text: string }[];
  bot: { id: string; name: string; slug: string };
  model: { id: string; name: string; context_window: number; max_tokens: number; capabilities?: Partial<import("@pi-bot/runtime-contracts").ModelCapabilities> };
  system: string;
  history: { role: 'user' | 'assistant'; content: string; images?: ChatImage[] }[];
  text: string;
  images?: ChatImage[];
  search_enabled?: boolean;
  agents_enabled?: boolean;
  skills?: SkillSummary[];
  memory_context?:string;task_id?:string;checkpoint_version?:number;observation_enabled?:boolean;
}
export interface ExecutorDeps {
  libraryRoot: string;
  agentDir: string;
  /** `${serverUrl}/llm/v1` */
  proxyUrl: string;
  llmToken(botId: string): Promise<string>;
  send(message: Record<string, unknown>): void;
  activity(run: RunContext, tool: string | null, mood: Mood | null): void;
  factory?: AgentFactory;
  approvalTimeoutMs?: number;
  phoneConfigPath?: string;
}
interface Active {
  run: RunContext;
  agent?: AgentHandle;
  cancelled: boolean;
  prompted: boolean;
  received: Set<string>;
  pending: { id: string; text: string }[];
  /** request_id → resolver */
  waiting: Map<string, (approved: boolean) => void>;
  /** approval_id → request_id */
  approvals: Map<string, string>;
  early: Map<string, boolean>;
}
const TOKEN_REFRESH_MS = 10 * 60 * 1000;

export class Executor {
  private active = new Map<string, Active>();
  private commandsSuspended = false;
  private commands = new Set<{ controller: AbortController; done: Promise<void> }>();
  async suspendCommands() {
    this.commandsSuspended = true;
    for (const item of this.commands) item.controller.abort();
    await Promise.all([...this.commands].map(item => item.done));
  }
  resumeCommands() { this.commandsSuspended = false; }
  constructor(private deps: ExecutorDeps) {}
  get running() { return [...this.active.keys()]; }

  async start(run: RunContext) {
    if (this.active.has(run.run_id)) return;
    const state: Active = { run, cancelled: false, prompted: false, received: new Set((run.instructions ?? []).map(i => i.id)), pending: [...run.instructions ?? []], waiting: new Map(), approvals: new Map(), early: new Map() };
    this.active.set(run.run_id, state);
    const event = (e: Record<string, unknown>) => this.deps.send({ type: 'run_event', run_id: run.run_id, event: e });
    event({ kind: 'started' });
    this.deps.activity(run, null, 'thinking');
    let timedOut = false;
    const timeoutMs = run.deadline_at ? Math.max(1, Date.parse(run.deadline_at) - Date.now()) : run.lane === 'conversation' ? CONVERSATION_TIMEOUT_MS : undefined;
    const deadline = timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; void state.agent?.abort(); }, timeoutMs);
    let latest = '', lastSent = 0, pendingText: NodeJS.Timeout | undefined, refresh: NodeJS.Timeout | undefined;
    const flush = () => { clearTimeout(pendingText); pendingText = undefined; lastSent = Date.now(); event({ kind: 'text', text: latest }); };
    try {
      const sandbox = new Sandbox(await libraryDir(this.deps.libraryRoot, run.bot.slug));
      let token = await this.deps.llmToken(run.bot.id);
      const phone = PhoneAdb.open(this.deps.phoneConfigPath);
      const phoneEnvironment = phone
        ? await phone.environment(run.lane === 'conversation', !!run.automation_readonly, this.commandsSuspended)
        : '\n本执行节点没有有效的显式手机配置；不能把其他电脑或其他智能体的手机当作本节点设备。';
      let tools = run.lane === "conversation" ? [] : libraryTools(sandbox, {
        requestOutside: (path, reason, signal) => new Promise<boolean>(resolve => {
          const requestId = randomUUID();
          const timer = setTimeout(() => settle(false), this.deps.approvalTimeoutMs ?? 15 * 60 * 1000);
          const settle = (approved: boolean) => {
            clearTimeout(timer); signal?.removeEventListener('abort', abort); state.waiting.delete(requestId);
            this.deps.activity(run, null, 'thinking');
            resolve(approved);
          };
          const abort = () => settle(false);
          signal?.addEventListener('abort', abort, { once: true });
          state.waiting.set(requestId, settle);
          this.deps.activity(run, null, 'waiting');
          event({ kind: 'approval', request_id: requestId, path, reason });
        }),
      });
      if (run.automation_readonly) tools = tools.filter(t => toolDescriptor(t.name)?.readonly);
      tools = tools.map(tool => tool.name !== 'run_command' ? tool : {
        ...tool, description: tool.description + (phone ? ' 也支持内置受控 phone-adb 命令；exec-out screencap -p 会返回图片。' : ''),
        execute: async (id, args, signal, update, ctx) => {
          if (this.commandsSuspended) throw new Error('手机正在人工接管，此节点命令执行已暂停');
          const controller = new AbortController();
          const abort = () => controller.abort();
          if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, {once:true});
          let finish!: () => void;
          const item = {controller, done:new Promise<void>(resolve => {finish=resolve;})};
          this.commands.add(item);
          try {
            const command = (args as { command: string; cwd?: string; timeout_seconds?: number }).command;
            if (isPhoneAdbCommand(command)) {
              if (!phone) throw new Error('本执行节点未显式配置受控手机');
              const input = args as { cwd?: string; timeout_seconds?: number };
              await sandbox.resolve(input.cwd ?? '.', { mustExist: true });
              return await phone.command(command, (input.timeout_seconds ?? 120) * 1000, controller.signal);
            }
            return await tool.execute(id, args, controller.signal, update, ctx);
          }
          finally { signal?.removeEventListener('abort', abort); this.commands.delete(item); finish(); }
        },
      });
      const api = this.deps.proxyUrl.replace(/\/llm\/v1\/?$/, '');
      if (run.execution_policy === 'device_only' && !run.automation_readonly) tools = tools.map(tool => {
        if (toolDescriptor(tool.name)?.effect !== 'write') return tool;
        return { ...tool, execute: async (id, args, signal, update, ctx) => {
          const journal = async (phase: 'start' | 'end', confirmed?: boolean, result?: string) => {
            const response = await fetch(`${api}/agent/automations/effect`, {
              method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ run_id: run.run_id, tool_call_id: id, phase, confirmed, tool_name: tool.name, summary: JSON.stringify(args).slice(0,2000), result }),
              redirect: 'error', signal: AbortSignal.timeout(15000),
            });
            if (!response.ok) throw new Error('操作状态无法确认，已停止自动执行');
          };
          await journal('start');
          const result = await tool.execute(id, args, signal, update, ctx);
          let confirmed = true;
          if (tool.name === 'run_command') {
            try {
              const output = JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join(''));
              confirmed = output.exit_code === 0 && !output.timed_out;
            } catch { confirmed = false; }
          }
          await journal('end', confirmed, result.content.filter(c => c.type === 'text').map(c => c.text).join('').slice(0,4000));
          return result;
        } };
      });
      if (run.lane === "conversation") tools.push(...taskTools(api, () => token, run.run_id), ...automationTools(api, () => token, run.run_id));
      if (run.automation) tools.push(...automationTools(api, () => token, run.run_id, true));
      if (run.lane !== "conversation" && run.search_enabled) tools.push(webSearchTool(api, () => token));
      if (run.agents_enabled) tools.push(askAgentTool(api, () => token, run.run_id, { conversation: run.lane === "conversation" }));
      tools.push(...reportTools(api, () => token, run.run_id, run.lane === "task" && !run.automation));
      tools.push(...a2uiTools(messages => { event({ kind: 'ui', messages }); }));
      const onTool = (t: ToolActivity) => {
        event({ kind: 'tool', ...t });
        const mood: Mood = toolDescriptor(t.name)?.activity ?? 'working';
        this.deps.activity(run, t.state === 'running' ? t.name : null, t.state === 'running' ? mood : 'thinking');
      };
      state.agent = await (this.deps.factory ?? createBotAgent)({
        model: { id: run.model.id, name: run.model.name, baseUrl: this.deps.proxyUrl, modelId: run.model.id, contextWindow: run.model.context_window, capabilities:run.model.capabilities, maxTokens: run.model.max_tokens },
        apiKey: token,
        readonly: run.automation_readonly,
        cwd: sandbox.root,
        agentDir: join(this.deps.agentDir, 'bots', run.bot.id),
        systemPrompt: `${run.system}\n实际执行环境：${process.platform}；shell：${commandShell()}；资料库绝对路径：${sandbox.root}。${phoneEnvironment}${process.platform === 'win32' ? ' 使用非交互 PowerShell 语法，不使用 bash/cmd 语法；含空格路径必须加引号，调用带引号的程序路径使用 &。输出为 UTF-8（旧程序可能使用其他代码页）。' : ''}`,
        history: run.history,
        tools,
        skills: { baseUrl: api, token: () => token, runId: run.run_id, catalog: run.skills ?? [] },
        runId:run.run_id,
        memory:{baseUrl:api,token:()=>token,runId:run.run_id,lane:run.lane??'task',context:run.memory_context??'',taskId:run.task_id,checkpointVersion:run.checkpoint_version,readonly:run.automation_readonly},
        onObservation:run.observation_enabled?e=>event({kind:'observation',...e}):undefined,
        onAction: onTool,
        onManifest: tools => event({kind:"manifest",tools}),
        onReply: run.automation ? undefined : reply => { event({ kind: "reply", ...reply }); },
        onProgress: lines => {
          clearTimeout(pendingText); pendingText = undefined;
          latest = '';
          event({ kind: 'progress', lines });
        },
      });
      if (timedOut) throw new Error(run.automation ? '自动轮次超过执行时限' : '对话响应超时，请重新发送');
      if (state.cancelled) throw new Error(CANCELLED);
      refresh = setInterval(() => { void this.deps.llmToken(run.bot.id).then(t => { token = t; return state.agent?.setApiKey(t); }).catch(() => {}); }, TOKEN_REFRESH_MS);
      const initial = state.pending.splice(0);
      for (const i of initial) event({ kind: 'instruction_ack', id: i.id });
      state.prompted = true;
      const input = run.text + initial.map(i => `\n\n用户追加要求：\n${i.text}`).join('');
      const final = await state.agent.prompt(input, text => {
        latest = text;
        if (Date.now() - lastSent > 150) flush();
        else pendingText ??= setTimeout(flush, 150);
      }, run.images);
      clearTimeout(pendingText);
      event({ kind: 'done', state: 'completed', text: final });
      this.deps.activity(run, null, run.automation ? null : 'celebrate');
    } catch (error) {
      clearTimeout(pendingText);
      const cancelled = !timedOut && (state.cancelled || (error instanceof Error && error.message === CANCELLED));
      const message = timedOut ? (run.automation ? '自动轮次超过执行时限' : '对话响应超时，请重新发送') : error instanceof Error && !cancelled ? error.message.slice(0, 300) : null;
      event({ kind: 'done', state: cancelled ? 'cancelled' : 'failed', error: message ?? '运行失败', error_info: errorInfo(error), text: latest || undefined });
      this.deps.activity(run, null, cancelled ? null : 'error');
    } finally {
      clearTimeout(deadline);
      clearInterval(refresh);
      for (const settle of state.waiting.values()) settle(false);
      state.agent?.dispose();
      this.active.delete(run.run_id);
    }
  }
  async message(runId: string, id: string, text: string) {
    const state = this.active.get(runId);
    if (!state || state.cancelled) return false;
    if (state.received.has(id)) return true;
    state.received.add(id);
    try {
      if (!state.prompted) state.pending.push({ id, text });
      else {
        if (!state.agent?.steer) throw new Error('执行器不支持追加要求');
        await state.agent.steer(text);
      }
      return true;
    } catch (e) { state.received.delete(id); throw e; }
  }
  cancel(runId: string) {
    const state = this.active.get(runId);
    if (!state) return false;
    state.cancelled = true;
    for (const settle of state.waiting.values()) settle(false);
    void state.agent?.abort();
    return true;
  }
  approvalCreated(runId: string, requestId: string, approvalId: string) {
    const state = this.active.get(runId);
    if (!state) return;
    state.approvals.set(approvalId, requestId);
    const early = state.early.get(approvalId);
    if (early !== undefined) this.decided(runId, approvalId, early);
  }
  approvalDecided(runId: string, approvalId: string, decision: 'approve' | 'reject') { this.decided(runId, approvalId, decision === 'approve'); }
  private decided(runId: string, approvalId: string, approved: boolean) {
    const state = this.active.get(runId);
    if (!state) return;
    const requestId = state.approvals.get(approvalId);
    if (!requestId) { state.early.set(approvalId, approved); return; }
    state.waiting.get(requestId)?.(approved);
  }
  stopAll() { for (const id of this.active.keys()) this.cancel(id); }
}

export const agentDirFor = (dataDir: string) => join(dataDir, 'pi');
