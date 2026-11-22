import { errorInfo, httpErrorInfo, type AppError } from "@pi-bot/runtime-contracts";
import WebSocket from 'ws';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { globalAgent as httpAgent } from 'node:http';
import { globalAgent as httpsAgent } from 'node:https';

export class CloudHttpError extends Error { readonly info:AppError; constructor(readonly status:number,message:string,info?:AppError){super(message);this.info=info??httpErrorInfo(status,message,"cloud");} }
export class CloudNetworkError extends Error {}
const TIMEOUT_MS = 15000;

export interface DeviceIdentity { privateKey: string; publicKey: string }
export function identityFromPrivateKey(privateKey: string): DeviceIdentity {
  const key = createPrivateKey({key:Buffer.from(privateKey,'base64'),format:'der',type:'pkcs8'});
  return {privateKey,publicKey:createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32).toString('base64')};
}
export function newIdentity(): DeviceIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
}
export type Signer = (method: string, path: string, body: Buffer) => Record<string, string>;
export function signer(deviceId: string, privateKey: string): Signer {
  const key: KeyObject = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return (method, path, body) => {
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex');
    const message = `${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${createHash('sha256').update(body).digest('hex')}`;
    return { 'x-pibot-device-id': deviceId, 'x-pibot-timestamp': timestamp, 'x-pibot-nonce': nonce, 'x-pibot-signature': sign(null, Buffer.from(message), key).toString('base64') };
  };
}

export function checkServerUrl(serverUrl: string) {
  const url = new URL(serverUrl);
  if (url.username || url.password || url.search || url.hash) throw new CloudNetworkError('服务器地址格式不正确');
  const normalized = url.href.replace(/\/+$/, '');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  let configuredHttp = false;
  if (process.env.PI_BOT_HTTP_SERVER_URL) {
    try { configuredHttp = new URL(process.env.PI_BOT_HTTP_SERVER_URL).href.replace(/\/+$/, '') === normalized; }
    catch { /* An invalid exception must not allow arbitrary HTTP servers. */ }
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || configuredHttp))) throw new CloudNetworkError('服务器地址必须使用 HTTPS，HTTP 地址需在启动配置中明确指定');
  return normalized;
}

// Only the server's short `detail` string is surfaced; bodies, headers and credentials never reach errors or logs.
async function detail(response: Response) {
  try {
    const json = await response.json() as { detail?: unknown };
    if (typeof json.detail === 'string') return json.detail.slice(0, 300);
    if (Array.isArray(json.detail)) return json.detail.map(d => (d && typeof d === 'object' && 'msg' in d ? String(d.msg) : '')).filter(Boolean).join('；').slice(0, 300) || '参数无效';
  } catch { /* Non-JSON error body is ignored. */ }
  return `服务器拒绝请求（HTTP ${response.status}）`;
}
/** `path` is signed exactly as given, without the server URL's path prefix. */
export async function cloudFetch<T>(serverUrl: string, method: string, path: string, options: { body?: unknown; headers?: Record<string, string>; signer?: Signer; timeoutMs?: number } = {}): Promise<T> {
  const base = checkServerUrl(serverUrl);
  const body = options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body), 'utf8');
  const headers: Record<string, string> = { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers, ...(options.signer ? options.signer(method, path.split('?')[0], body) : {}) };
  let response: Response;
  try { response = await fetch(base + path, { method, headers, body: options.body === undefined ? undefined : body, signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS), redirect: 'error' }); }
  catch { throw new CloudNetworkError('无法连接服务器'); }
  if (!response.ok) {
    const payload = await response.clone().json().catch(() => null);
    throw new CloudHttpError(response.status, await detail(response), errorInfo(payload));
  }
  return await response.json() as T;
}

export type SocketDiagnosticEvent = 'cloud.socket.connecting' | 'cloud.socket.open' | 'cloud.socket.hello' | 'cloud.socket.close' | 'cloud.socket.error' | 'cloud.socket.auth_failed' | 'cloud.socket.heartbeat_timeout' | 'cloud.socket.retry' | 'cloud.socket.reconnect';
export interface SocketDiagnosticDetail { closeCode?: string; errorCode?: string; pongAgeMs?: string; retryDelayMs?: string }
export interface SocketHandlers { message(message: Record<string, any>): void; open(): void; close(authFailed: boolean): void; features?(): string[]; diagnostics?(event: SocketDiagnosticEvent, detail: SocketDiagnosticDetail): void }
export interface SocketTimers { pingIntervalMs?: number; pongTimeoutMs?: number; handshakeTimeoutMs?: number }
// Error messages and arbitrary error.code values may contain credentials. Only known codes are logged.
const SOCKET_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'WS_ERR_UNEXPECTED_RSV_1', 'WS_ERR_INVALID_OPCODE', 'WS_ERR_INVALID_UTF8', 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH']);
/** The harness connection: runs, cancels, approvals and file RPCs arrive here. */
export class CloudSocket {
  private socket: WebSocket | null = null; private stopped = true; private retry: NodeJS.Timeout | undefined; private ping: NodeJS.Timeout | undefined; private attempts = 0; private lastPong = 0; private immediateRetry = false;
  connected = false;
  constructor(private serverUrl: string, private sign: Signer, private handlers: SocketHandlers, private backoff = { baseMs: 1000, maxMs: 30000 }, private timers: SocketTimers = {}) {}
  private diagnostic(event: SocketDiagnosticEvent, detail: SocketDiagnosticDetail = {}) { try { this.handlers.diagnostics?.(event, detail); } catch { /* Diagnostics must never interrupt the connection. */ } }
  private get pongTimeoutMs() { return this.timers.pongTimeoutMs ?? 45000; }
  start() { if (!this.stopped) return; this.stopped = false; this.open(); }
  stop() { this.stopped = true; this.immediateRetry = false; clearTimeout(this.retry); this.retry = undefined; clearInterval(this.ping); this.ping = undefined; const socket = this.socket; this.socket = null; this.connected = false; socket?.removeAllListeners(); socket?.on('error', () => {}); socket?.terminate(); }
  reconnectNow() {
    if (this.stopped) return;
    if (this.socket) {
      // A handshake already in flight is bounded by ws's handshake timeout. Never create a second one.
      if (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.CLOSING) return;
      const pongAgeMs = Date.now() - this.lastPong;
      if (this.socket.readyState === WebSocket.OPEN && pongAgeMs <= this.pongTimeoutMs) return;
      this.diagnostic('cloud.socket.reconnect', { pongAgeMs: String(pongAgeMs) });
      this.immediateRetry = true;
      this.socket.terminate(); // Its close handler owns cleanup and starts the replacement.
      return;
    }
    clearTimeout(this.retry); this.retry = undefined; this.attempts = 0; this.open();
  }
  send(message: Record<string, unknown>) { if (this.socket?.readyState === WebSocket.OPEN) { this.socket.send(JSON.stringify(message)); return true; } return false; }
  capabilities(...features: string[]) {
    this.send({ type: 'capabilities', features: ['always-on-v1', 'files', 'shell', 'preflight-v1', ...(this.handlers.features?.() ?? []), ...features] });
  }
  private open() {
    if (this.stopped || this.socket) return;
    this.diagnostic('cloud.socket.connecting');
    const url = new URL(`${this.serverUrl.replace(/\/$/, '')}/ws/device`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    // ws supplies createConnection, which otherwise bypasses Node's environment proxy agent.
    const agent = url.protocol === 'wss:' ? httpsAgent : httpAgent;
    const socket = new WebSocket(url, { agent, headers: this.sign('GET', '/ws/device', Buffer.alloc(0)), handshakeTimeout: this.timers.handshakeTimeoutMs ?? TIMEOUT_MS, maxPayload: 8_000_000, followRedirects: false });
    this.socket = socket; let authFailed = false;
    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return;
      this.attempts = 0; this.lastPong = Date.now();
      this.diagnostic('cloud.socket.open');
      this.ping = setInterval(() => {
        if (this.socket !== socket || this.stopped) return;
        const pongAgeMs = Date.now() - this.lastPong;
        if (pongAgeMs > this.pongTimeoutMs) { this.diagnostic('cloud.socket.heartbeat_timeout', { pongAgeMs: String(pongAgeMs) }); socket.terminate(); return; }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, this.timers.pingIntervalMs ?? 15000);
    });
    socket.on('message', raw => {
      if (this.socket !== socket || this.stopped) return;
      let message: any; try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.type === 'pong') this.lastPong = Date.now();
      else if (message?.type === 'hello') { this.connected = true; this.diagnostic('cloud.socket.hello'); this.capabilities(); this.handlers.open(); }
      else this.handlers.message(message);
    });
    socket.on('unexpected-response', (_request, response) => {
      if (this.socket !== socket) return;
      authFailed = response.statusCode === 401 || response.statusCode === 403;
      const status = response.statusCode;
      this.diagnostic('cloud.socket.error', { errorCode: status && status >= 100 && status <= 599 ? `HTTP_${status}` : 'UNKNOWN' });
      socket.terminate();
    });
    socket.on('error', error => {
      if (this.socket !== socket) return;
      const code = (error as NodeJS.ErrnoException).code;
      this.diagnostic('cloud.socket.error', { errorCode: code && SOCKET_ERROR_CODES.has(code) ? code : 'UNKNOWN' });
    });
    socket.on('close', code => {
      // An obsolete socket must not clear the replacement socket's heartbeat.
      if (this.socket !== socket) return;
      clearInterval(this.ping); this.ping = undefined;
      authFailed ||= code === 4401; const wasConnected = this.connected; this.connected = false; this.socket = null;
      this.diagnostic('cloud.socket.close', { closeCode: String(code), pongAgeMs: String(this.lastPong ? Date.now() - this.lastPong : 0) });
      if (authFailed) { this.stopped = true; this.immediateRetry = false; clearTimeout(this.retry); this.retry = undefined; this.diagnostic('cloud.socket.auth_failed', { closeCode: String(code) }); }
      if (wasConnected || authFailed) this.handlers.close(authFailed);
      if (this.stopped || this.socket) return;
      const delay = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** this.attempts++);
      const retryDelayMs = this.immediateRetry ? 0 : code === 4409 ? Math.max(delay, 5000) : delay;
      this.immediateRetry = false;
      this.diagnostic('cloud.socket.retry', { retryDelayMs: String(retryDelayMs) });
      this.retry = setTimeout(() => { this.retry = undefined; this.open(); }, retryDelayMs);
    });
  }
}
