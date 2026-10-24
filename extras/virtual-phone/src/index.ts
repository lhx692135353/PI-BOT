import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';

// Explicit, owner-only node configuration. Never discover arbitrary ADB devices.
const configSchema = z.object({ enabled: z.literal(true), adbPath: z.string().startsWith('/'), lockPath: z.string().startsWith('/'), serial: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:\[\]-]+$/), adbPort: z.number().int().min(1).max(65535), ffmpegPath: z.string().startsWith('/') }).strict();
type Config = z.infer<typeof configSchema>;
const point = z.number().int().nonnegative();
export const phoneEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), x: point.max(719), y: point.max(1279) }).strict(),
  z.object({ type: z.literal('swipe'), x1: point.max(719), y1: point.max(1279), x2: point.max(719), y2: point.max(1279), duration: z.number().int().min(50).max(2000) }).strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(1000).regex(/^[\x20-\x7e]+$/) }).strict(),
  z.object({ type: z.literal('key'), code: z.union([z.literal(3), z.literal(4), z.literal(67), z.literal(66), z.literal(187)]) }).strict(),
]);
const request = z.object({ phoneId: z.literal('google-play-validation').optional(), sessionId: z.string().uuid().optional(), event: phoneEvent.optional() }).strict();
function exec(file: string, args: string[], input?: Buffer | string, max = 4_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = []; let n = 0;
    const timer = setTimeout(() => p.kill('SIGKILL'), 8000);
    p.stdout.on('data', (b: Buffer) => { n += b.length; if (n > max) p.kill('SIGKILL'); else chunks.push(b); });
    p.stdin.on('error', () => {}); p.stdin.end(input);
    p.once('error', () => { clearTimeout(timer); reject(new Error('手机操作不可用')); });
    p.once('close', code => { clearTimeout(timer); code === 0 && n <= max ? resolve(Buffer.concat(chunks)) : reject(new Error('手机操作失败或超时')); });
  });
}
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export class PhoneController {
  private lease?: { id: string; expires: number; idle: number; lock: ChildProcess; config: Config };
  private queue = Promise.resolve();
  private timer = setInterval(() => { if (this.lease && (this.lease.expires < Date.now() || this.lease.idle < Date.now())) this.release(); }, 1000).unref();
  private generation = 0;
  private pending = 0;
  private closed = false;
  constructor(private configPath: string, private hooks?: { acquired(): Promise<void>; released(): void }) {}
  private config(): Config {
    try {
      const st = lstatSync(this.configPath);
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw Error();
      return configSchema.parse(JSON.parse(readFileSync(this.configPath, 'utf8')));
    } catch { throw new Error('此节点未显式启用手机控制'); }
  }
  release() { this.generation++; const old = this.lease; this.lease = undefined; old?.lock.stdin?.end(); old?.lock.kill(); if (old) this.hooks?.released(); }
  close() { this.closed = true; this.release(); clearInterval(this.timer); }
  call(method: string, raw: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('手机控制器已关闭'));
    if (this.pending >= 8) return Promise.reject(new Error('手机请求过于频繁'));
    this.pending++;
    const generation = this.generation;
    const task = this.queue.catch(() => {}).then(() => {
      if (generation !== this.generation) throw new Error('手机连接已断开');
      return this.handle(method, raw, generation);
    });
    this.queue = task.then(() => {}, () => {}); return task.finally(() => { this.pending--; });
  }
  private adb(c: Config, args: string[], input?: string) { return exec(c.adbPath, ['-H', '127.0.0.1', '-P', String(c.adbPort), '-s', c.serial, ...args], input); }
  private async capture(c: Config) {
    const png = await this.adb(c, ['exec-out', 'screencap', '-p']);
    if (png.length < 24 || png.readUInt32BE(16) !== 720 || png.readUInt32BE(20) !== 1280) throw new Error('当前屏幕尺寸不支持，请恢复竖屏720×1280');
    const jpg = await exec(c.ffmpegPath, ['-threads', '1', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-vf', 'scale=720:1280', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-threads', '1', '-q:v', '5', 'pipe:1'], png, 1_000_000);
    return { data: jpg.toString('base64'), width: 720, height: 1280, mime: 'image/jpeg' };
  }
  private touch(lease: NonNullable<PhoneController['lease']>) {
    const now = Date.now();
    if (this.lease !== lease || lease.expires <= now || lease.idle <= now) {
      if (this.lease === lease) this.release();
      throw new Error('人工控制会话已结束');
    }
    lease.idle = Math.min(lease.expires, now + 45000);
  }
  private async handle(method: string, raw: unknown, generation: number): Promise<unknown> {
    if (!['phone.status', 'phone.preview', 'phone.acquire', 'phone.frame', 'phone.input', 'phone.release'].includes(method)) throw new Error('不支持的手机请求');
    const parsed = request.safeParse(raw);
    if (!parsed.success) throw new Error('手机请求参数无效');
    const p = parsed.data;
    // Release must still work after the administrator disables/removes configuration.
    if (method === 'phone.release') {
      if (!this.lease || p.sessionId !== this.lease.id) throw new Error('人工控制会话已失效');
      this.release(); return { released: true };
    }
    let c: Config;
    try { c = this.config(); } catch (e) {
      if (this.lease) this.release();
      if (method === 'phone.status') return { available: false, occupied: false };
      throw e;
    }
    if (this.lease && JSON.stringify(c) !== JSON.stringify(this.lease.config)) {
      this.release();
      throw new Error('手机配置已变更，请重新确认设备并接管');
    }
    if (method === 'phone.status') {
      try { await this.adb(c, ['get-state']); return { available: true, occupied: !!this.lease, phoneId: 'google-play-validation', label: `Android · ${c.serial} · ADB ${c.adbPort}` }; }
      catch { return { available: false, occupied: false }; }
    }
    if (method === 'phone.preview') {
      // Owner-authenticated observation only: no flock, automation hook or lease renewal.
      if (p.sessionId || p.event) throw new Error('只读预览不接受控制参数');
      const frame = await this.capture(c);
      if (generation !== this.generation) throw new Error('手机连接已断开');
      return frame;
    }
    if (method === 'phone.acquire') {
      if (this.lease) throw new Error('手机正在被人工控制');
      await this.adb(c, ['get-state']);
      // Share the exact flock with the existing remote bridge and guarded ADB.
      const lock = spawn('/usr/bin/flock', ['-n', '-E', '75', c.lockPath, '/bin/sh', '-c', 'printf ready; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] });
      try { await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => { lock.kill(); reject(new Error('接管超时')); }, 3000);
        lock.once('error', () => { clearTimeout(t); reject(new Error('手机锁不可用')); });
        lock.once('exit', () => { clearTimeout(t); reject(new Error('手机已被占用')); });
        lock.stdout.once('data', () => { clearTimeout(t); resolve(); });
      }); } catch (e) { lock.stdin.end(); lock.kill(); throw e; }
      if (generation !== this.generation) { lock.stdin.end(); lock.kill(); throw new Error('手机连接已断开'); }
      const lease = { id: randomUUID(), expires: Date.now() + 600000, idle: Date.now() + 45000, lock, config: c };
      this.lease = lease; lock.on('exit', () => { if (this.lease === lease) this.release(); });
      try { await this.hooks?.acquired(); } catch { this.release(); throw new Error('无法暂停自动化，未授予人工控制'); }
      if (this.lease !== lease) throw new Error('人工控制会话已结束');
      try {
        if (JSON.stringify(this.config()) !== JSON.stringify(c)) throw new Error();
      } catch {
        this.release();
        throw new Error('手机配置已变更，请重新确认设备并接管');
      }
      return { sessionId: lease.id, expiresAt: lease.expires };
    }
    const lease = this.lease;
    if (!lease || p.sessionId !== lease.id || lease.expires <= Date.now() || lease.idle <= Date.now()) throw new Error('人工控制会话已失效');
    if (method === 'phone.frame') {
      const frame = await this.capture(c);
      this.touch(lease);
      return frame;
    }
    if (method === 'phone.input' && p.event) {
      const e = p.event;
      const command = e.type === 'tap' ? `input tap ${e.x} ${e.y}` : e.type === 'swipe' ? `input swipe ${e.x1} ${e.y1} ${e.x2} ${e.y2} ${e.duration}` : e.type === 'key' ? `input keyevent ${e.code}` : e.text.split('%').map(s => s ? `input text ${quote(s.replace(/ /g, '%s'))}` : '').join("\ninput text '%'\n");
      // Sensitive text travels over stdin, never command-line argv or logs.
      await this.adb(c, ['shell', '-T'], command + '\nexit\n');
      this.touch(lease);
      return { ok: true };
    }
    throw new Error('不支持的手机请求');
  }
}
