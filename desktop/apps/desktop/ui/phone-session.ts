import { errorInfo } from "@pi-bot/runtime-contracts";
/**
 * Not mounted. PhoneDock in phone-control.tsx is the panel the app renders.
 * This PhoneDesk keeps an earlier token/lease design and a different storage key;
 * wiring it in would ignore the phone-client association and idle helpers.
 */
import type { Device } from '../../../packages/protocol/src/index.js';

/** JPEG snapshots at about 2 fps. This is not a video stream. */
export const FRAME_INTERVAL_MS = 500;
export const STATUS_INTERVAL_MS = 5000;
export const ABSOLUTE_SESSION_MS = 10 * 60 * 1000;
export const TAP_SLOP_PX = 10;
const FRAME_WIDTH = 720;
const FRAME_HEIGHT = 1280;
const MAX_FRAME_CHARS = 1_500_000;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Per-bot execution-computer choice. This desktop client only; never synced. */
export const PHONE_LINK_STORAGE_KEY = 'pi-bot.phone-link.v1';
export const PHONE_LINK_SCOPE = '只保存在这台桌面客户端本机，按 Bot 记住，不会同步到服务器、其他电脑或账号。';

export const PHONE_KEYS = [
  { code: 4, label: '返回' },
  { code: 3, label: '主页' },
  { code: 187, label: '最近' },
  { code: 67, label: '删除' },
  { code: 66, label: '回车' },
] as const;
export type PhoneKey = (typeof PHONE_KEYS)[number]['code'];
export type PhoneEvent =
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; duration: number }
  | { type: 'text'; text: string }
  | { type: 'key'; code: PhoneKey };
export interface PhoneFrame { src: string; width: number; height: number }
export interface PhoneStatus { available: boolean; occupied: boolean; label?: string; phoneId?: string }
export type PhoneMethod = 'phoneStatus' | 'phonePreview' | 'phoneAcquire' | 'phoneFrame' | 'phoneInput' | 'phoneRelease';
export type PhoneCaller = (method: PhoneMethod, input: Record<string, unknown>) => Promise<unknown>;
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface PhoneContext {
  botId: string | null;
  pinnedDeviceId: string | null;
  devices: Device[];
  links: Record<string, string>;
}
export interface PhoneView {
  ready: boolean;
  mode: 'pick' | 'preview' | 'control';
  device: Device | null;
  status: PhoneStatus;
  statusKnown: boolean;
  frame: PhoneFrame | null;
  metrics: { width: number; height: number };
  notice: string;
  frameNotice: string;
  expiresAt: number | null;
  controlling: boolean;
  pendingAcquire: boolean;
  canControl: boolean;
}

const emptyStatus = (): PhoneStatus => ({ available: false, occupied: false });

export function readPhoneLinks(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const links: Record<string, string> = {};
    for (const [botId, deviceId] of Object.entries(value)) {
      if (UUID.test(botId) && typeof deviceId === 'string' && UUID.test(deviceId)) links[botId] = deviceId;
    }
    return links;
  } catch { return {}; }
}
export function serializePhoneLinks(links: Record<string, string>) {
  return JSON.stringify(readPhoneLinks(JSON.stringify(links)));
}
export function resolveLinkedDevice(links: Record<string, string>, botId: string | null, devices: Device[], pinnedDeviceId: string | null) {
  const list = devices.filter(device => !device.revoked_at);
  if (pinnedDeviceId) return list.find(device => device.id === pinnedDeviceId) ?? null;
  if (!botId) return null;
  const id = links[botId];
  return id ? list.find(device => device.id === id) ?? null : null;
}
export function readStatus(value: unknown): PhoneStatus {
  if (!value || typeof value !== 'object') return emptyStatus();
  const record = value as Record<string, unknown>;
  let available = record.available === true;
  let occupied = record.occupied === true;
  if (typeof record.available !== 'boolean' && typeof record.status === 'string') {
    available = record.status === 'available';
    occupied = record.status === 'occupied';
  }
  const label = typeof record.label === 'string' && record.label.trim() ? record.label : undefined;
  const phoneId = typeof record.phoneId === 'string' && record.phoneId.trim() ? record.phoneId : undefined;
  return { available, occupied, label, phoneId };
}
export function readTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
export function readSessionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const sessionId = (value as Record<string, unknown>).sessionId;
  return typeof sessionId === 'string' && UUID.test(sessionId) ? sessionId : null;
}
export function readAcquire(value: unknown, now = Date.now()): { sessionId: string; expiresAt: number } | null {
  const sessionId = readSessionId(value);
  if (!sessionId || !value || typeof value !== 'object') return null;
  const expiresAt = readTime((value as Record<string, unknown>).expiresAt);
  if (expiresAt === null || expiresAt <= now) return null;
  return { sessionId, expiresAt: Math.min(expiresAt, now + ABSOLUTE_SESSION_MS) };
}
export function readFrame(value: unknown): PhoneFrame | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.mime !== 'image/jpeg' || typeof record.data !== 'string') return null;
  const data = record.data.replace(/\s/g, '');
  if (data.length < 16 || data.length > MAX_FRAME_CHARS || data.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || !data.startsWith('/9j/')) return null;
  const { width, height } = record;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 1 || width > FRAME_WIDTH || height < 1 || height > FRAME_HEIGHT) return null;
  return { src: `data:image/jpeg;base64,${data}`, width, height };
}
export function sessionEnded(error: unknown) {
  const code=errorInfo(error)?.code;
  return code === "session_expired" || code === "session_occupied" || code === "transport_closed";
}
export function textProblem(text: string) {
  if (!text) return '';
  if (text.length > 1000) return '文字太长，没有发送';
  if (!PRINTABLE_ASCII.test(text)) return '只能发送英文、数字和符号';
  return '';
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '操作失败';
}
function clampCoord(value: number, maximum: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.round(value)));
}
export function toPhonePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, width: number, height: number) {
  if (rect.width < 1 || rect.height < 1) return null;
  const xMax = Math.min(FRAME_WIDTH - 1, Math.max(0, width - 1));
  const yMax = Math.min(FRAME_HEIGHT - 1, Math.max(0, height - 1));
  return {
    x: clampCoord((clientX - rect.left) / rect.width * width, xMax),
    y: clampCoord((clientY - rect.top) / rect.height * height, yMax),
  };
}
export function pointerGesture(
  start: { x: number; y: number },
  end: { x: number; y: number },
  elapsedMs: number,
  rect: { left: number; top: number; width: number; height: number },
  metrics: { width: number; height: number },
  moved: boolean,
): PhoneEvent | null {
  const from = toPhonePoint(start.x, start.y, rect, metrics.width, metrics.height);
  const to = toPhonePoint(end.x, end.y, rect, metrics.width, metrics.height);
  if (!from || !to) return null;
  if (!moved && Math.hypot(end.x - start.x, end.y - start.y) >= TAP_SLOP_PX) moved = true;
  if (!moved) return { type: 'tap', x: from.x, y: from.y };
  return { type: 'swipe', x1: from.x, y1: from.y, x2: to.x, y2: to.y, duration: Math.min(2000, Math.max(50, Math.round(elapsedMs))) };
}
export function remainLabel(expiresAt: number, now: number) {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function allowedKey(code: number): code is PhoneKey {
  return PHONE_KEYS.some(key => key.code === code);
}

interface Lease { deviceId: string; sessionId: string; expiresAt: number }

export class PhoneDesk {
  private closed = false;
  private hidden = false;
  private ready = false;
  private botId: string | null = null;
  private pinnedId: string | null = null;
  private links: Record<string, string> = {};
  private devices: Device[] = [];
  private device: Device | null = null;
  private mode: PhoneView['mode'] = 'pick';
  private session: Lease | null = null;
  private released = new Set<string>();
  private status = emptyStatus();
  private statusKnown = false;
  private frame: PhoneFrame | null = null;
  private metrics = { width: FRAME_WIDTH, height: FRAME_HEIGHT };
  private notice = '';
  private frameNotice = '';
  private pendingAcquire = false;
  private frameFailures = 0;
  private previewToken = 0;
  private frameToken = 0;
  private statusToken = 0;
  private acquireToken = 0;
  private timers = new Set<unknown>();
  private listeners = new Set<() => void>();
  constructor(private options: { call: PhoneCaller; clock?: Clock; onLink?(botId: string, deviceId: string): void; onUnlink?(botId: string): void; onClearPin?(): void }) {}
  private get clock() { return this.options.clock ?? systemClock; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit() { for (const listener of this.listeners) listener(); }
  get view(): PhoneView {
    return {
      ready: this.ready,
      mode: this.mode,
      device: this.device,
      status: this.status,
      statusKnown: this.statusKnown,
      frame: this.frame,
      metrics: this.metrics,
      notice: this.notice,
      frameNotice: this.frameNotice,
      expiresAt: this.session?.expiresAt ?? null,
      controlling: this.mode === 'control' && !!this.session,
      pendingAcquire: this.pendingAcquire,
      canControl: !!this.device?.online && this.status.available && !this.status.occupied && this.mode !== 'control' && !this.pendingAcquire && !this.hidden,
    };
  }
  sync(ctx: PhoneContext) {
    if (this.closed) return;
    this.ready = true;
    this.botId = ctx.botId;
    this.pinnedId = ctx.pinnedDeviceId;
    this.links = ctx.links;
    this.devices = ctx.devices.filter(device => !device.revoked_at);
    const next = this.resolve();
    const same = next?.id === this.device?.id;
    if (!next) {
      this.stopWork(false);
      this.device = null;
      this.mode = 'pick';
      this.frame = null;
      this.emit();
      return;
    }
    if (!same) {
      this.stopWork(true);
      this.device = next;
      this.mode = 'preview';
      this.frame = null;
      this.status = emptyStatus();
      this.statusKnown = false;
      this.frameNotice = '';
      this.restartLoops();
      this.emit();
      return;
    }
    const changed = next.online !== this.device!.online || next.label !== this.device!.label || next.platform !== this.device!.platform;
    this.device = next;
    if (!next.online && this.session) {
      this.stopWork(true);
      this.mode = 'preview';
      this.notice = '执行电脑离线，已释放接管';
      this.frameNotice = '执行电脑离线，已暂停预览';
      this.emit();
      return;
    }
    if (!next.online) {
      this.previewToken++;
      this.frameNotice = '执行电脑离线，已暂停预览';
    } else if (changed && this.mode === 'preview' && !this.hidden) this.startPreview();
    if (changed) this.emit();
  }
  selectDevice(deviceId: string) {
    const device = this.devices.find(item => item.id === deviceId && !item.revoked_at);
    if (!device || this.closed) return;
    if (this.session && this.session.deviceId !== device.id) this.release(this.session);
    this.pinnedId = null;
    this.options.onClearPin?.();
    if (this.botId) {
      this.links = { ...this.links, [this.botId]: device.id };
      this.options.onLink?.(this.botId, device.id);
    }
    const same = this.device?.id === device.id && this.mode !== 'pick';
    this.device = device;
    this.notice = this.botId ? '已记到当前 Bot，只保存在这台客户端。' : '没有当前 Bot，这次选择只在本面板生效。';
    if (!same) {
      this.mode = 'preview';
      this.frame = null;
      this.status = emptyStatus();
      this.statusKnown = false;
      this.restartLoops();
    }
    this.emit();
  }
  showPicker() {
    this.stopWork(true);
    this.device = null;
    this.mode = 'pick';
    this.frame = null;
    this.pinnedId = null;
    this.notice = '';
    this.options.onClearPin?.();
    if (this.botId && this.links[this.botId]) {
      const next = { ...this.links };
      delete next[this.botId];
      this.links = next;
      this.options.onUnlink?.(this.botId);
    }
    this.emit();
  }
  async takeControl() {
    const device = this.device;
    if (!device || this.hidden || this.closed || this.mode === 'control' || this.pendingAcquire) return;
    if (!device.online || !this.status.available || this.status.occupied) {
      this.notice = this.status.occupied ? '手机正在被占用，不能接管' : '当前不能接管';
      this.emit();
      return;
    }
    const token = ++this.acquireToken;
    this.pendingAcquire = true;
    this.previewToken++;
    this.emit();
    try {
      const value = await this.options.call('phoneAcquire', { deviceId: device.id });
      const now = this.clock.now();
      const sessionId = readSessionId(value);
      const acquired = readAcquire(value, now);
      if (this.closed || this.hidden || token !== this.acquireToken || this.device?.id !== device.id || !acquired) {
        if (sessionId) this.release({ deviceId: device.id, sessionId, expiresAt: now });
        if (token === this.acquireToken && !this.closed && !this.hidden) {
          this.pendingAcquire = false;
          this.mode = this.device ? 'preview' : 'pick';
          this.notice = '没有取得有效的控制会话';
          this.startPreview();
          this.emit();
        } else this.pendingAcquire = false;
        return;
      }
      this.session = { deviceId: device.id, sessionId: acquired.sessionId, expiresAt: acquired.expiresAt };
      this.mode = 'control';
      this.pendingAcquire = false;
      this.notice = '';
      this.frameNotice = '';
      this.frameFailures = 0;
      this.emit();
      this.pullFrame();
    } catch (error) {
      if (token !== this.acquireToken || this.closed) { this.pendingAcquire = false; return; }
      this.pendingAcquire = false;
      this.mode = this.device ? 'preview' : 'pick';
      this.notice = errorText(error);
      if (!this.hidden) this.startPreview();
      this.emit();
    }
  }
  endControl() {
    const had = !!this.session;
    this.stopWork(true);
    if (this.device) this.mode = 'preview';
    this.notice = had ? '已结束接管' : '';
    this.emit();
    if (this.device && !this.hidden && !this.closed) this.startPreview();
  }
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    if (hidden) {
      const had = !!this.session || this.pendingAcquire;
      this.previewToken++;
      this.frameToken++;
      this.acquireToken++;
      if (this.session) this.release(this.session);
      this.pendingAcquire = false;
      if (this.mode === 'control') this.mode = this.device ? 'preview' : 'pick';
      if (had) this.notice = '已暂停并释放手机控制';
      this.emit();
      return;
    }
    if (!this.closed && this.device && this.mode !== 'control') this.startPreview();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.previewToken++;
    this.frameToken++;
    this.statusToken++;
    this.acquireToken++;
    this.clearTimers();
    if (this.session) this.release(this.session);
    this.pendingAcquire = false;
    this.mode = 'pick';
    this.emit();
  }
  async send(event: PhoneEvent) {
    const session = this.session;
    if (!session || this.mode !== 'control' || this.hidden || this.closed) {
      this.notice = '还没有接管，操作没有发送';
      this.emit();
      return false;
    }
    if (event.type === 'text') {
      const problem = textProblem(event.text);
      if (problem) { this.notice = problem; this.emit(); return false; }
      if (!event.text) return false;
    }
    if (event.type === 'key' && !allowedKey(event.code)) {
      this.notice = '不支持这个按键';
      this.emit();
      return false;
    }
    try {
      await this.options.call('phoneInput', { deviceId: session.deviceId, sessionId: session.sessionId, event });
      if (this.session?.sessionId === session.sessionId) { this.notice = ''; this.emit(); }
      return this.session?.sessionId === session.sessionId;
    } catch (error) {
      if (this.session?.sessionId !== session.sessionId) return false;
      const message = errorText(error);
      if (sessionEnded(error)) {
        this.notice = message;
        this.stopWork(true);
        this.mode = 'preview';
        this.startPreview();
      } else this.notice = '操作没有送到手机';
      this.emit();
      return false;
    }
  }
  private resolve() {
    return resolveLinkedDevice(this.links, this.botId, this.devices, this.pinnedId);
  }
  private stopWork(releaseLease: boolean) {
    this.previewToken++;
    this.frameToken++;
    this.acquireToken++;
    this.pendingAcquire = false;
    this.clearTimers();
    if (releaseLease && this.session) this.release(this.session);
    this.pumpStatus();
  }
  private restartLoops() {
    this.previewToken++;
    this.frameToken++;
    this.clearTimers();
    this.frameFailures = 0;
    this.pumpStatus();
    if (this.mode === 'control' && this.session) this.pullFrame();
    else if (this.mode === 'preview') this.startPreview();
  }
  private later(fn: () => void, ms: number) {
    const id = this.clock.setTimeout(() => { this.timers.delete(id); fn(); }, ms);
    this.timers.add(id);
  }
  private clearTimers() {
    for (const id of this.timers) this.clock.clearTimeout(id);
    this.timers.clear();
  }
  private release(session: Lease) {
    if (this.session?.sessionId === session.sessionId) this.session = null;
    if (this.released.has(session.sessionId)) return;
    this.released.add(session.sessionId);
    void this.options.call('phoneRelease', { deviceId: session.deviceId, sessionId: session.sessionId }).catch(() => {});
  }
  private pumpStatus() {
    const token = ++this.statusToken;
    const run = () => {
      if (token !== this.statusToken || this.closed || !this.device) return;
      const deviceId = this.device.id;
      void this.options.call('phoneStatus', { deviceId }).then(value => {
        if (token !== this.statusToken || this.device?.id !== deviceId) return;
        this.status = readStatus(value);
        this.statusKnown = true;
        this.emit();
      }).catch(() => {
        if (token !== this.statusToken || this.device?.id !== deviceId) return;
        this.statusKnown = true;
        this.emit();
      }).finally(() => {
        if (token !== this.statusToken || this.closed) return;
        this.later(() => run(), STATUS_INTERVAL_MS);
      });
    };
    run();
  }
  private startPreview() {
    const token = ++this.previewToken;
    const run = () => {
      if (token !== this.previewToken || this.closed || this.hidden || this.mode === 'control' || this.pendingAcquire) return;
      const device = this.device;
      if (!device) return;
      if (!device.online) {
        this.frameNotice = '执行电脑离线，已暂停预览';
        this.emit();
        return;
      }
      const started = this.clock.now();
      void this.options.call('phonePreview', { deviceId: device.id }).then(value => {
        if (token !== this.previewToken || this.device?.id !== device.id || this.mode === 'control') return;
        const frame = readFrame(value);
        if (frame) { this.frame = frame; this.metrics = { width: frame.width, height: frame.height }; this.frameNotice = ''; }
        else this.frameNotice = '这一帧画面无效';
        this.emit();
      }).catch(error => {
        if (token !== this.previewToken || this.mode === 'control') return;
        const message = errorText(error);
        this.frameNotice = errorInfo(error)?.code === 'unsupported' ? '只读预览尚未接入本地服务' : '暂时没有取到预览';
        this.emit();
        if (errorInfo(error)?.code === 'unsupported') return;
      }).finally(() => {
        if (token !== this.previewToken || this.closed || this.hidden || this.mode === 'control') return;
        if (this.frameNotice === '只读预览尚未接入本地服务') {
          this.later(() => run(), STATUS_INTERVAL_MS);
          return;
        }
        const delay = Math.max(0, FRAME_INTERVAL_MS - (this.clock.now() - started));
        this.later(() => run(), delay);
      });
    };
    run();
  }
  private pullFrame() {
    const session = this.session;
    if (!session || this.mode !== 'control' || this.hidden || this.closed) return;
    if (this.clock.now() >= session.expiresAt) {
      this.notice = '控制会话已结束';
      this.release(session);
      this.mode = 'preview';
      this.frameToken++;
      this.emit();
      this.startPreview();
      return;
    }
    const token = this.frameToken;
    const started = this.clock.now();
    void this.options.call('phoneFrame', { deviceId: session.deviceId, sessionId: session.sessionId }).then(value => {
      if (token !== this.frameToken || this.session?.sessionId !== session.sessionId) return;
      const frame = readFrame(value);
      if (frame) {
        this.frameFailures = 0;
        this.frame = frame;
        this.metrics = { width: frame.width, height: frame.height };
        this.frameNotice = '';
      } else if (++this.frameFailures >= 5) this.failFrames('连续没有取得有效画面，会话已结束');
      else this.frameNotice = '这一帧画面无效';
      this.emit();
    }).catch(error => {
      if (token !== this.frameToken || this.session?.sessionId !== session.sessionId) return;
      const message = errorText(error);
      if (sessionEnded(error) || ++this.frameFailures >= 5) this.failFrames(sessionEnded(error) ? message : '连续没有取到画面，会话已结束');
      else this.frameNotice = '暂时没有取到画面';
      this.emit();
    }).finally(() => {
      if (token !== this.frameToken || this.mode !== 'control' || this.session?.sessionId !== session.sessionId) return;
      const delay = Math.max(0, FRAME_INTERVAL_MS - (this.clock.now() - started));
      this.later(() => this.pullFrame(), delay);
    });
  }
  private failFrames(message: string) {
    const session = this.session;
    this.notice = message;
    this.frameToken++;
    if (session) this.release(session);
    this.mode = 'preview';
    this.startPreview();
  }
}
