import { errorInfo, RuntimeError, httpErrorInfo } from "@pi-bot/runtime-contracts";
import { type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AppEvent, Method } from '../../../packages/protocol/src/index.js';
import { socketPath, tokenPath, connectLocal } from '../../../packages/service/src/paths.js';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  packet: string;
  sent: boolean;
}
// The service accepts at most 32 concurrent requests per connection. Leave room
// for a timed-out request that is still finishing on the service side.
const MAX_IN_FLIGHT = 16;
export class ServiceClient {
  private socket?: Socket;
  private connected = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private pending = new Map<string, PendingCall>();
  private inFlight = new Set<string>();
  constructor(private emit: (event: AppEvent) => void, private paths = { socketPath, tokenPath }) {}
  start() {
    if (this.stopped || this.socket) return;
    let token: string;
    try { token = readFileSync(this.paths.tokenPath, 'utf8'); } catch { this.schedule(); return; }
    const socket = connectLocal(this.paths.socketPath);
    this.socket = socket; socket.setEncoding('utf8'); let buffer = '';
    socket.once('connect', () => socket.write(JSON.stringify({ token }) + '\n'));
    socket.on('data', (data: string) => {
      buffer += data; if (buffer.length > 4_000_000) { socket.destroy(); return; }
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try {
          const packet = JSON.parse(line);
          if (packet.ready) { this.connected = true; this.emit({ type: 'service.status', connected: true }); }
          else if (packet.event) this.emit(packet.event);
          else {
            this.inFlight.delete(packet.id);
            const pending = this.pending.get(packet.id);
            if (pending) {
              clearTimeout(pending.timer); this.pending.delete(packet.id);
              if (packet.error) pending.reject(new RuntimeError(errorInfo(packet) ?? httpErrorInfo(500,packet.error,"local-service"))); else pending.resolve(packet.result);
            }
          }
          this.flush();
        } catch { socket.destroy(); return; }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined; this.connected = false; this.inFlight.clear();
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RuntimeError({code:'transport_closed',scope:'local-service',retryable:false,outcome:'unknown',message:'本地服务连接中断，请重连后检查运行状态'})); }
      this.pending.clear(); this.emit({ type: 'service.status', connected: false }); this.schedule();
    });
  }
  private schedule() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, 1000);
  }
  private flush() {
    if (!this.connected || !this.socket || this.socket.destroyed) return;
    for (const [id, pending] of this.pending) {
      if (this.inFlight.size >= MAX_IN_FLIGHT) break;
      if (pending.sent) continue;
      pending.sent = true; this.inFlight.add(id); this.socket.write(pending.packet);
    }
  }
  call(method: Method, input: unknown): Promise<unknown> {
    if (!this.connected || !this.socket || this.stopped) return Promise.reject(new RuntimeError(httpErrorInfo(503,'本地服务尚未连接','local-service')));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Keep the slot until the service replies; timeout does not cancel a mutation.
        reject(new RuntimeError({code:'timeout',scope:'local-service',retryable:false,outcome:'unknown',message:'请求超时，请检查服务和运行状态'})); this.flush();
      }, 150000);
      this.pending.set(id, { resolve, reject, timer, packet: JSON.stringify({ id, method, input }) + '\n', sent: false });
      this.flush();
    });
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; this.socket?.destroy(); }
}

/** Check authenticated IPC before starting another instance. */
export function serviceRunning(timeoutMs = 800): Promise<boolean> {
  return new Promise(resolve => {
    const client = new ServiceClient(event => {
      if (event.type === 'service.status' && event.connected) { clearTimeout(timer); client.stop(); resolve(true); }
    });
    const timer = setTimeout(() => { client.stop(); resolve(false); },timeoutMs);
    client.start();
  });
}
