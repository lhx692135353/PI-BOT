/** Client-only phone association and frame checks. This does not talk to a device. */

export const PHONE_ASSOC_KEY = 'pi-bot.phone.device.v2';
export function phoneAssociationKey(serverUrl: string | null, userId: string | null) {
  return `${PHONE_ASSOC_KEY}.${JSON.stringify([serverUrl?.replace(/\/+$/, '') ?? '', userId ?? ''])}`;
}
export const TAKEOVER_ABSOLUTE_MS = 10 * 60 * 1000;
export const TAKEOVER_IDLE_MS = 45 * 1000;
export const FRAME_WIDTH = 720;
export const FRAME_HEIGHT = 1280;

const MAX_FRAME_CHARS = 1_500_000;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PhoneDeviceRef { id: string; revoked_at?: string | null }
export interface PhoneStatus { available: boolean; occupied: boolean; label?: string; phoneId?: string }
export interface PhoneFrame { src: string; width: number; height: number }

export function readPhoneMap(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key && typeof item === 'string' && item) out[key] = item;
    }
    return out;
  } catch {
    return {};
  }
}

export function writePhoneMap(map: Record<string, string>, botId: string, deviceId: string): Record<string, string> {
  return { ...map, [botId]: deviceId };
}

/** Pick a real authorized execution computer. Never invents a phone or a second AVD. */
export function resolvePhoneDevice(input: {
  savedDeviceId?: string | null;
  executionDeviceId?: string | null;
  devices: PhoneDeviceRef[];
}): { deviceId: string | null; source: 'saved' | 'execution' | 'missing' | 'none' } {
  const live = input.devices.filter(device => !device.revoked_at);
  const has = (id?: string | null) => !!id && live.some(device => device.id === id);
  if (input.savedDeviceId) return has(input.savedDeviceId)
    ? { deviceId: input.savedDeviceId, source: 'saved' } : { deviceId: null, source: 'missing' };
  if (input.executionDeviceId) return has(input.executionDeviceId)
    ? { deviceId: input.executionDeviceId, source: 'execution' } : { deviceId: null, source: 'missing' };
  return { deviceId: null, source: 'none' };
}

export function takeoverHardEnd(acquiredAt: number, serverExpiresAt: number) {
  return Math.min(acquiredAt + TAKEOVER_ABSOLUTE_MS, serverExpiresAt);
}

/** Idle window created at acquire. This is not a frame or preview renewal. */
export function initialIdleEnd(now: number, hardEnd: number) {
  return Math.min(hardEnd, now + TAKEOVER_IDLE_MS);
}

export function isPhoneSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export type PhonePhase = 'preview' | 'live';
export type PhoneRequestKind = 'preview' | 'status' | 'frame' | 'acquire';
/** Identity of one in-flight UI request. A newer switch bumps epoch. */
export interface PhoneScope { epoch: number; botId: string | null; deviceId: string }
export interface PhoneNow { epoch: number; botId: string | null; deviceId: string | null; mounted: boolean; hidden: boolean; phase: PhonePhase }

function sameTarget(scope: PhoneScope, now: PhoneNow) {
  return now.mounted && now.epoch === scope.epoch && now.botId === scope.botId && now.deviceId === scope.deviceId;
}

/** Drop a response that belongs to an older bot, device, hidden page, or closed panel. */
export function mayApplyPhoneResponse(scope: PhoneScope, now: PhoneNow, kind: PhoneRequestKind) {
  if (!sameTarget(scope, now)) return false;
  if (kind === 'status') return true;
  if (now.hidden) return false;
  if (kind === 'preview') return now.phase === 'preview';
  if (kind === 'acquire') return now.phase === 'preview';
  return now.phase === 'live';
}

export function phoneModeLabel(input: {
  hasDevices: boolean;
  deviceSelected: boolean;
  online: boolean;
  hidden: boolean;
  phase: PhonePhase;
  pending: boolean;
  occupied: boolean;
  available: boolean;
}) {
  if (!input.hasDevices) return '没有已授权的执行电脑';
  if (!input.deviceSelected) return '未选择执行电脑';
  if (input.hidden) return '已转入后台，接管已释放';
  if (input.phase === 'live') return '正在接管';
  if (input.pending) return '正在申请接管';
  if (!input.online) return '执行电脑离线，只读预览已暂停';
  if (input.occupied) return '手机被占用，当前只是只读预览';
  if (!input.available) return '只读预览，当前不能接管';
  return '只读预览，不占用控制权';
}

/** Preview must not extend a control lease. Only a successful frame or input does. */
export function touchLease(kind: 'preview' | 'frame' | 'input', now: number, hardEnd: number, idleEnd: number) {
  if (kind === 'preview') return idleEnd;
  return Math.min(hardEnd, now + TAKEOVER_IDLE_MS);
}

export function readStatus(value: unknown): PhoneStatus {
  if (!value || typeof value !== 'object') return { available: false, occupied: false };
  const record = value as Record<string, unknown>;
  let available = record.available === true;
  let occupied = record.occupied === true;
  if (!available && !occupied && typeof record.status === 'string') {
    available = record.status === 'available';
    occupied = record.status === 'occupied';
  }
  return {
    available,
    occupied,
    label: typeof record.label === 'string' && record.label ? record.label : undefined,
    phoneId: typeof record.phoneId === 'string' && record.phoneId ? record.phoneId : undefined,
  };
}

function readTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readAcquire(value: unknown, now: number): { sessionId: string; expiresAt: number } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const sessionId = record.sessionId;
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return null;
  const expiresAt = readTime(record.expiresAt);
  if (expiresAt === null || expiresAt <= now) return null;
  return { sessionId, expiresAt };
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
  if (width !== FRAME_WIDTH || height !== FRAME_HEIGHT) return null;
  return { src: `data:image/jpeg;base64,${data}`, width, height };
}

export function textProblem(text: string) {
  if (!text) return '';
  if (text.length > 1000) return '文字太长，没有发送';
  if (!PRINTABLE_ASCII.test(text)) return '只能发送英文、数字和符号';
  return '';
}

export function sessionEnded(message: string) {
  return /会话已|连接已断开|正在被人工控制|已被占用/.test(message);
}
