import { errorInfo, httpErrorInfo, RuntimeError } from "@pi-bot/runtime-contracts";
import { PhoneController } from './phone.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Mood } from '@pi-bot/bot-face';
import type { AgentFactory } from '@pi-bot/agent';
import type { AccountState, AppEvent, Bot, Connection, LocalActivity, Method, MessagePage, ModelOption } from '../../protocol/src/index.js';
import { checkServerUrl, cloudFetch, CloudHttpError, CloudSocket, newIdentity, identityFromPrivateKey, signer, type Signer } from './cloud.js';
import type { Credentials } from './keychain.js';
import { Executor, agentDirFor, type RunContext } from './executor.js';
import { previewList, previewRead, preflightLibrary } from './library.js';
import type { LogEvent } from './log.js';

interface Account {
  serverUrl: string;
  deviceId: string;
  deviceLabel: string;
  user: { id: string; username: string; display_name: string };
}
export interface ApplicationOptions {
  dataDir: string;
  libraryRoot: string;
  credentials: Credentials;
  emit(event: AppEvent): void;
  log?(event: LogEvent, detail?: Record<string, string>): void;
  factory?: AgentFactory;
  backoff?: { baseMs: number; maxMs: number };
}

/**
 * The computer harness: binds this computer to a Pi Bot account, keeps the device
 * socket open, executes bot runs locally and proxies UI calls to the server.
 */
export class Application {
  private account: Account | null = null;
  private sign: Signer | null = null;
  private socket: CloudSocket | null = null;
  private connectionGeneration = 0;
  private executor: Executor | null = null;
  private connection: Connection = 'signed_out';
  private activities = new Map<string, LocalActivity>();
  private afterglow = new Map<string, NodeJS.Timeout>();
  private phone: PhoneController;
  constructor(private o: ApplicationOptions) { this.phone = new PhoneController(join(o.dataDir, 'phone.json'), { acquired: async () => { await this.executor?.suspendCommands(); }, released: () => { this.executor?.resumeCommands(); } }); }
  private get accountFile() { return join(this.o.dataDir, 'account.json'); }

  async start() {
    if (!existsSync(this.accountFile)) return;
    try {
      const account = JSON.parse(readFileSync(this.accountFile, 'utf8')) as Account;
      const key = await this.o.credentials.get(account.deviceId);
      if (!key) throw new Error('missing key');
      this.connect(account, key);
    } catch {
      this.setConnection('signed_out');
    }
  }
  state(): AccountState {
    return { connection: this.connection, serverUrl: this.account?.serverUrl ?? null, user: this.account?.user ?? null, deviceId: this.account?.deviceId ?? null, deviceLabel: this.account?.deviceLabel ?? null, libraryRoot: this.o.libraryRoot };
  }
  private setConnection(connection: Connection) {
    if (this.connection === connection) return;
    this.connection = connection;
    this.o.emit({ type: 'account', state: this.state() });
  }
  private connect(account: Account, privateKey: string) {
    checkServerUrl(account.serverUrl);
    const generation = ++this.connectionGeneration;
    this.account = account;
    this.sign = signer(account.deviceId, privateKey);
    this.executor = new Executor({
      libraryRoot: this.o.libraryRoot,
      agentDir: agentDirFor(this.o.dataDir),
      proxyUrl: `${account.serverUrl}/llm/v1`,
      llmToken: async botId => (await this.cloud<{ token: string }>('POST', '/device/llm-token', { bot_id: botId })).token,
      send: m => { this.socket?.send(m); },
      activity: (run, tool, mood) => this.activity(run, tool, mood),
      factory: this.o.factory,
      phoneConfigPath: join(this.o.dataDir, 'phone.json'),
    });
    this.socket = new CloudSocket(account.serverUrl, this.sign, {
      open: () => { if (generation !== this.connectionGeneration) return; void this.phone.call('phone.status',{}).then((status:any) => {if (generation === this.connectionGeneration && status.available) this.socket?.send({type:'capabilities',features:['always-on-v1','files','shell','preflight-v1','phone']});}).catch(()=>{}); this.o.log?.('cloud.online'); this.setConnection('online'); this.o.emit({ type: 'bots' }); },
      close: authFailed => {
        if (generation !== this.connectionGeneration) return;
        this.o.log?.(authFailed ? 'cloud.revoked' : 'cloud.offline');
        this.phone.release();
        this.executor?.stopAll();
        if (authFailed) { this.socket?.stop(); this.setConnection('revoked'); }
        else this.setConnection('offline');
      },
      message: m => { if (generation === this.connectionGeneration) void this.onMessage(m, generation).catch(() => {}); },
    }, this.o.backoff);
    this.setConnection('connecting');
    this.socket.start();
  }
  private activity(run: RunContext, tool: string | null, mood: Mood | null) {
    clearTimeout(this.afterglow.get(run.bot.id));
    this.afterglow.delete(run.bot.id);
    const activity = mood ? { botId: run.bot.id, runId: run.run_id, tool, mood } : null;
    if (activity) this.activities.set(run.run_id, activity); else this.activities.delete(run.run_id);
    if (mood === 'celebrate' || mood === 'error') this.activities.delete(run.run_id);
    const others = [...this.activities.values()].filter(a => a.botId === run.bot.id);
    const aggregate = others.find(a => a.mood === 'waiting') ?? others.find(a => a.tool) ?? others.at(-1) ?? activity;
    this.o.emit({ type: 'activity', botId: run.bot.id, activity: aggregate });
    this.o.emit({ type: 'bot.mood', bot_id: run.bot.id, name: run.bot.name, mood: aggregate?.mood ?? 'idle' });
    if (!others.length && (mood === 'celebrate' || mood === 'error')) this.afterglow.set(run.bot.id, setTimeout(() => {
      this.afterglow.delete(run.bot.id);
      this.o.emit({ type: 'activity', botId: run.bot.id, activity: null });
      this.o.emit({ type: 'bot.mood', bot_id: run.bot.id, name: run.bot.name, mood: 'idle' });
    }, 6000));
  }
  private async onMessage(m: Record<string, any>, generation = this.connectionGeneration) {
    if (generation !== this.connectionGeneration) return;
    const socket = this.socket;
    const executor = this.executor;
    if (!executor) return;
    switch (m.type) {
      case 'run':
        this.o.log?.('run.started', { run: String(m.run?.run_id) });
        await executor.start(m.run as RunContext);
        this.o.log?.('run.finished', { run: String(m.run?.run_id) });
        return;
      case 'task_message':
        if (await executor.message(m.run_id, m.instruction_id, m.text))
          this.socket?.send({ type: 'run_event', run_id: m.run_id, event: { kind: 'instruction_ack', id: m.instruction_id } });
        return;
      case 'cancel': executor.cancel(m.run_id); return;
      case 'approval_created': executor.approvalCreated(m.run_id, m.request_id, m.approval_id); return;
      case 'approval': executor.approvalDecided(m.run_id, m.approval_id, m.decision); return;
      case 'rpc': {
        try {
          const p = m.params ?? {};
          const result = typeof m.method === 'string' && m.method.startsWith('phone.') ? await this.phone.call(m.method, p)
            : m.method === 'tasks.preflight' ? await preflightLibrary(this.o.libraryRoot, String(p.slug), Array.isArray(p.paths) && p.paths.every((x: unknown) => typeof x === 'string') ? p.paths : ['../invalid'])
            : m.method === 'files.list' ? await previewList(this.o.libraryRoot, String(p.slug), String(p.path ?? ''))
            : m.method === 'files.read' ? await previewRead(this.o.libraryRoot, String(p.slug), String(p.path ?? ''))
            : (() => { throw new RuntimeError(httpErrorInfo(501,'不支持的请求','device')); })();
          if (generation === this.connectionGeneration && socket === this.socket) socket?.send({ type: 'rpc_result', id: m.id, ok: true, result });
        } catch (e) {
          const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
          if (generation === this.connectionGeneration && socket === this.socket) socket?.send({ type: 'rpc_result', id: m.id, ok: false, error: missing ? '文件不存在' : e instanceof Error ? e.message : '读取失败', error_info:errorInfo(e)??httpErrorInfo(missing?404:500,e instanceof Error?e.message:'读取失败','device') });
        }
        return;
      }
      case 'event': {
        const e = m.event ?? {};
        if (e.type === 'presence') { this.o.emit({type:'bots'}); return; }
        if (e.type === 'bot' || e.type === 'delta' || e.type === 'bots') this.o.emit(e as AppEvent);
        return;
      }
    }
  }
  private cloud<T>(method: string, path: string, body?: unknown) {
    if (!this.account || !this.sign) throw new Error('请先登录');
    const generation = this.connectionGeneration;
    return cloudFetch<T>(this.account.serverUrl, method, path, { body, signer: this.sign }).catch(error => {
      if (generation === this.connectionGeneration && error instanceof CloudHttpError && error.status === 401 && path !== '/device/llm-token') { this.socket?.stop(); this.setConnection('revoked'); }
      throw error;
    });
  }

  async login(input: { serverUrl: string; username: string; password: string; label: string }) {
    const serverUrl = checkServerUrl(input.serverUrl);
    const auth = await cloudFetch<{ access_token: string; user: Account['user'] }>(serverUrl, 'POST', '/auth/login', { body: { username: input.username, password: input.password } });
    const savedKey = this.account?.serverUrl === serverUrl && this.account?.user.id === auth.user.id
      ? await this.o.credentials.get(this.account.deviceId) : null;
    const identity = savedKey ? identityFromPrivateKey(savedKey) : newIdentity();
    const reg = await cloudFetch<{ device: { id: string } }>(serverUrl, 'POST', '/devices/register', { body: { public_key: identity.publicKey, label: input.label, platform: process.platform }, headers: { authorization: `Bearer ${auth.access_token}` } });
    await this.logout(false);
    const account: Account = { serverUrl, deviceId: reg.device.id, deviceLabel: input.label, user: { id: auth.user.id, username: auth.user.username, display_name: auth.user.display_name } };
    await this.o.credentials.set(account.deviceId, identity.privateKey);
    mkdirSync(this.o.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.accountFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(account), { mode: 0o600 });
    renameSync(tmp, this.accountFile);
    this.connect(account, identity.privateKey);
    return this.state();
  }
  async logout(revoke = true) {
    const account = this.account, sign = this.sign;
    this.connectionGeneration++;
    this.phone.release();
    this.executor?.stopAll();
    this.socket?.stop();
    if (this.account) await this.o.credentials.delete(this.account.deviceId).catch(() => {});
    rmSync(this.accountFile, { force: true });
    this.account = null; this.sign = null; this.socket = null; this.executor = null;
    this.activities.clear();
    for (const timer of this.afterglow.values()) clearTimeout(timer);
    this.afterglow.clear();
    this.setConnection('signed_out');
    // Local logout must work offline. Revoke the captured identity only, so a
    // delayed response cannot change a new login or restore the old session.
    if (revoke && account && sign) {
      try { await cloudFetch(account.serverUrl, 'POST', `/devices/${account.deviceId}/revoke`, { signer: sign, timeoutMs: 3000 }); }
      catch { /* Remote unbinding is best effort; local credentials are gone. */ }
    }
    return this.state();
  }
  async call(method: Method, input: any): Promise<unknown> {
    switch (method) {
      case 'phoneStatus': return this.cloud('POST', `/devices/${input.deviceId}/phone/status`, {});
      case 'phonePreview': return this.cloud('POST', `/devices/${input.deviceId}/phone/preview`, {});
      case 'phoneAcquire': return this.cloud('POST', `/devices/${input.deviceId}/phone/acquire`, {});
      case 'phoneFrame': return this.cloud('POST', `/devices/${input.deviceId}/phone/frame`, {sessionId:input.sessionId});
      case 'phoneInput': return this.cloud('POST', `/devices/${input.deviceId}/phone/input`, {sessionId:input.sessionId,event:input.event});
      case 'phoneRelease': return this.cloud('POST', `/devices/${input.deviceId}/phone/release`, {sessionId:input.sessionId});
      case 'reportOpen': { const result=await this.cloud<{url:string}>('POST',`/reports/${input.id}/open`,{}); return {url:this.account!.serverUrl.replace(/\/$/,'')+result.url}; }
      case 'remoteArtifact':{const result=await this.cloud<{url:string}>('POST',`/remote/artifacts/${input.id}/open`,{});return {url:this.account!.serverUrl.replace(/\/+$/,'')+result.url};}
      case 'remoteDesktop': {const result=await this.cloud<{url:string}>('POST','/remote/desktop/open',{bot_id:input.botId});return {url:this.account!.serverUrl.replace(/\/+$/,'')+result.url};}
      case 'status': return { ...this.state(), activities: [...this.activities.values()] };
      case 'login': return this.login(input);
      case 'logout': return this.logout();
      case 'models': return this.cloud<ModelOption[]>('GET', '/models');
      case 'devices': return this.cloud('GET', '/devices');
      case 'deviceRevoke': return this.cloud('POST', `/devices/${input.id}/revoke`);
      case 'openLibrary': {
        const bot = await this.cloud<Bot>('GET', `/bots/${input.id}`);
        return { slug: bot.slug };
      }
      case 'goals': return this.cloud('GET', `/bots/${input.id}/goals`);
      case 'librarySources': return this.cloud('GET', `/bots/${input.id}/files/sources`);
      case 'library': return this.cloud('GET', `/bots/${input.id}/files?path=${encodeURIComponent(input.path ?? '')}${input.target ? '&target='+encodeURIComponent(input.target) : ''}`);
      case 'libraryRead': return this.cloud('GET', `/bots/${input.id}/files/content?path=${encodeURIComponent(input.path)}${input.target ? '&target='+encodeURIComponent(input.target) : ''}`);
      case 'bots': return this.cloud<{ bots: Bot[] }>('GET', '/bots');
      case 'botCreate': return this.cloud<Bot>('POST', '/bots', input);
      case 'botUpdate': { const { id, ...patch } = input; return this.cloud<Bot>('PATCH', `/bots/${id}`, patch); }
      case 'botDelete': return this.cloud('DELETE', `/bots/${input.id}`);
      case 'taskConversation': return this.cloud('GET', `/bots/${input.botId}/tasks/${input.taskId}/conversation?after=${input.after ?? 0}`);
      case 'messages': return this.cloud<MessagePage>('GET', `/bots/${input.botId}/messages?limit=50${input.before ? `&before=${input.before}` : ''}`);
      case 'send': return this.cloud('POST', `/bots/${input.botId}/messages`, { client:"desktop", text: input.text, images: input.images, request_id: input.request_id ?? randomUUID() });
      case 'image': return this.cloud('GET', `/bots/${input.botId}/messages/${input.messageId}/images/${input.imageId}`);
      case 'voiceTicket': return this.cloud('POST', `/bots/${input.botId}/voice/ticket`,{client:"desktop"});
      case 'uiState': return this.cloud('POST', `/bots/${input.botId}/messages/${input.messageId}/ui-state`, { revision: input.revision, states: input.states });
      case 'uiAction': return this.cloud('POST', `/bots/${input.botId}/messages/${input.messageId}/ui-actions`, { client:"desktop", revision: input.revision, states: input.states, action: input.action, request_id: input.request_id });
      case 'cancel': this.executor?.cancel(input.runId); return this.cloud('POST', `/runs/${input.runId}/cancel`);
      case 'decide': return this.cloud('POST', `/approvals/${input.approvalId}`, { decision: input.decision });
      case 'authorizations': return this.cloud('GET', '/authorizations');
      case 'authorizationRevoke': return this.cloud('DELETE', `/authorizations/${input.id}`);
      case 'authorizationLogs': return this.cloud('GET', '/authorizations/logs');
    }
    throw new RuntimeError(httpErrorInfo(501,'未知方法','local-service'));
  }
  async shutdown() { this.connectionGeneration++; this.phone.close(); this.executor?.stopAll(); this.socket?.stop(); for (const timer of this.afterglow.values()) clearTimeout(timer); this.afterglow.clear(); }
}
