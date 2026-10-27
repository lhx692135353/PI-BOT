import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { Device } from '../../../packages/protocol/src/index.js';
import { call, errorText } from './bridge.js';
import {
  FRAME_HEIGHT, FRAME_WIDTH, PHONE_ASSOC_KEY, initialIdleEnd, isPhoneSessionId, mayApplyPhoneResponse, phoneModeLabel,
  readAcquire, readFrame, readPhoneMap, readStatus, resolvePhoneDevice, sessionEnded, takeoverHardEnd, textProblem,
  touchLease, writePhoneMap, type PhoneFrame, type PhoneNow, type PhoneScope, type PhoneStatus,
} from './phone-client.js';

const FRAME_INTERVAL_MS = 500;
const STATUS_INTERVAL_MS = 5000;
const TAP_SLOP_PX = 10;
const KEYS = [
  { code: 4, label: '返回' },
  { code: 3, label: '主页' },
  { code: 187, label: '最近' },
  { code: 67, label: '删除' },
  { code: 66, label: '回车' },
] as const;
type PhoneKey = (typeof KEYS)[number]['code'];
type PhoneEvent =
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; duration: number }
  | { type: 'text'; text: string }
  | { type: 'key'; code: PhoneKey };

function platformLabel(platform: string) {
  if (platform === 'linux') return 'Linux';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  return '未知平台';
}
function clampCoord(value: number, maximum: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.round(value)));
}
function toPhonePoint(clientX: number, clientY: number, image: HTMLImageElement) {
  const rect = image.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  if (clientX < rect.left || clientY < rect.top || clientX > rect.right || clientY > rect.bottom) return null;
  return {
    x: clampCoord((clientX - rect.left) / rect.width * FRAME_WIDTH, FRAME_WIDTH - 1),
    y: clampCoord((clientY - rect.top) / rect.height * FRAME_HEIGHT, FRAME_HEIGHT - 1),
  };
}
function remainLabel(expiresAt: number, now: number) {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function releaseSession(deviceId: string, sessionId: string) {
  if (!isPhoneSessionId(sessionId)) return;
  void call('phoneRelease', { deviceId, sessionId }).catch(() => {});
}
function rememberDevice(associationKey: string, botId: string, deviceId: string) {
  const next = writePhoneMap(readPhoneMap(localStorage.getItem(associationKey)), botId, deviceId);
  localStorage.setItem(associationKey, JSON.stringify(next));
}
function rawSessionId(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return isPhoneSessionId(sessionId) ? sessionId : null;
}

export function DevicePhoneButton({ device, onOpen }: { device: Device; onOpen(): void }) {
  const [status, setStatus] = useState<PhoneStatus>({ available: false, occupied: false });
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void call('phoneStatus', { deviceId: device.id }).then(value => {
        if (!cancelled) setStatus(readStatus(value));
      }).catch(() => { if (!cancelled) setStatus({ available: false, occupied: false }); });
    };
    load();
    const timer = window.setInterval(load, STATUS_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [device.id]);
  const title = !status.available
    ? status.reason ?? '打开后先看只读预览。这台电脑当前可能没有可显示的手机'
    : status.occupied ? '手机正在被接管，仍可打开只读预览' : status.label ?? '只读预览这台电脑上的手机';
  return (
    <span className="device-phone" title={title}>
      <button type="button" className="ghost small" aria-label={`预览${device.label}上的手机`} onClick={onOpen}>手机</button>
    </span>
  );
}

export function PhoneDock({
  botId, pinnedDeviceId, devices, executionDeviceId, onClose, associationKey = PHONE_ASSOC_KEY,
}: {
  associationKey?: string;
  botId: string | null;
  pinnedDeviceId: string | null;
  devices: Device[];
  executionDeviceId: string | null;
  onClose(): void;
}) {
  const live = devices.filter(device => !device.revoked_at);
  const [deviceId, setDeviceId] = useState<string | null>(pinnedDeviceId);
  const [phase, setPhase] = useState<'preview' | 'live'>('preview');
  const [status, setStatus] = useState<PhoneStatus>({ available: false, occupied: false });
  const [frame, setFrame] = useState<PhoneFrame | null>(null);
  const [frameNotice, setFrameNotice] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [generation, setGeneration] = useState(0);
  const sessionRef = useRef<{ id: string; deviceId: string } | null>(null);
  const hardRef = useRef(0);
  const idleRef = useRef(0);
  const pickedRef = useRef(false);
  const sendingRef = useRef(false);
  const pendingRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; at: number; moved: boolean } | null>(null);
  const mountedRef = useRef(true);
  const epochRef = useRef(0);
  const botRef = useRef(botId);
  const deviceRef = useRef(deviceId);
  const phaseRef = useRef(phase);
  const hiddenRef = useRef(hidden);
  const seenBotRef = useRef(botId);
  botRef.current = botId;
  deviceRef.current = deviceId;
  phaseRef.current = phase;
  hiddenRef.current = hidden;

  const snapshot = (): PhoneNow => ({
    epoch: epochRef.current,
    botId: botRef.current,
    deviceId: deviceRef.current,
    mounted: mountedRef.current,
    hidden: hiddenRef.current,
    phase: phaseRef.current,
  });
  const dropControl = (message?: string, clearView = false) => {
    epochRef.current += 1;
    setGeneration(epochRef.current);
    const current = sessionRef.current;
    sessionRef.current = null;
    hardRef.current = 0;
    idleRef.current = 0;
    pendingRef.current = false;
    dragRef.current = null;
    if (current) releaseSession(current.deviceId, current.id);
    if (!mountedRef.current) return;
    setPhase('preview');
    setExpiresAt(null);
    setDraft('');
    setPending(false);
    if (clearView) {
      setFrame(null);
      setFrameNotice('');
      setStatus({ available: false, occupied: false });
    }
    if (message !== undefined) setActionNotice(message);
    else if (clearView) setActionNotice('');
  };
  const releaseAbandoned = (scope: PhoneScope, value: unknown) => {
    const session = readAcquire(value, Date.now()) ?? (rawSessionId(value) ? { sessionId: rawSessionId(value)! } : null);
    if (session && !mayApplyPhoneResponse(scope, snapshot(), 'acquire')) releaseSession(scope.deviceId, session.sessionId);
    else if (session && !readAcquire(value, Date.now())) releaseSession(scope.deviceId, session.sessionId);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
      const current = sessionRef.current;
      sessionRef.current = null;
      if (current) releaseSession(current.deviceId, current.id);
    };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const abandon = (message: string) => {
      hiddenRef.current = true;
      const had = !!sessionRef.current || phaseRef.current === 'live' || pendingRef.current;
      dropControl(had ? message : undefined);
      setHidden(true);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') abandon('已转入后台，接管已释放');
      else { hiddenRef.current = false; setHidden(false); }
    };
    const onPageHide = () => abandon('页面已关闭，接管已释放');
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [onClose]);
  useLayoutEffect(() => {
    const botChanged = seenBotRef.current !== botId;
    seenBotRef.current = botId;
    if (botChanged) pickedRef.current = false;
    let saved: string | null = null;
    try { saved = botId ? readPhoneMap(localStorage.getItem(associationKey))[botId] ?? null : null; }
    catch { saved = null; }
    const pinnedOk = !!pinnedDeviceId && live.some(device => device.id === pinnedDeviceId);
    const keepPick = !botChanged && !pinnedDeviceId && pickedRef.current && !!deviceId && live.some(device => device.id === deviceId);
    const nextId = pinnedDeviceId
      ? (pinnedOk ? pinnedDeviceId : null)
      : !botId ? null
        : keepPick ? deviceId
          : resolvePhoneDevice({ savedDeviceId: saved, executionDeviceId, devices }).deviceId;
    if (!botChanged && nextId === deviceId) return;
    dropControl(undefined, true);
    if (nextId !== deviceId) setDeviceId(nextId);
  }, [botId, pinnedDeviceId, executionDeviceId, devices, deviceId, associationKey]);
  useEffect(() => {
    const selectedOnline = live.some(device => device.id === deviceId && device.online);
    if (!deviceId || selectedOnline) return;
    if (sessionRef.current || phaseRef.current === 'live' || pendingRef.current) dropControl('执行电脑离线，已释放接管');
  }, [deviceId, devices, generation]);
  useEffect(() => {
    if (!deviceId) return;
    const scope: PhoneScope = { epoch: epochRef.current, botId, deviceId };
    let cancelled = false;
    const load = () => {
      void call('phoneStatus', { deviceId: scope.deviceId }).then(value => {
        if (cancelled || !mayApplyPhoneResponse(scope, snapshot(), 'status')) return;
        setStatus(readStatus(value));
      }).catch(() => {
        if (cancelled || !mayApplyPhoneResponse(scope, snapshot(), 'status')) return;
        setStatus({ available: false, occupied: false });
      });
    };
    load();
    const timer = window.setInterval(load, STATUS_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [deviceId, botId, generation]);
  useEffect(() => {
    const online = live.some(device => device.id === deviceId && device.online);
    if (!deviceId || phase !== 'preview' || hidden || !online) {
      if (deviceId && !online && phase === 'preview') setFrameNotice('执行电脑离线，已暂停预览');
      return;
    }
    const scope: PhoneScope = { epoch: epochRef.current, botId, deviceId };
    let cancelled = false;
    let timer = 0;
    const pull = async () => {
      if (cancelled || !mayApplyPhoneResponse(scope, snapshot(), 'preview')) return;
      const started = Date.now();
      let pause = false;
      try {
        const value = await call('phonePreview', { deviceId: scope.deviceId });
        if (cancelled || !mayApplyPhoneResponse(scope, snapshot(), 'preview')) return;
        const next = readFrame(value);
        if (next) { setFrame(next); setFrameNotice(''); }
        else setFrameNotice('这一帧预览无效');
      } catch (error) {
        if (cancelled || !mayApplyPhoneResponse(scope, snapshot(), 'preview')) return;
        const message = errorText(error);
        pause = message.includes('未知方法');
        setFrameNotice(pause ? '只读预览尚未接入，不会自动接管' : '暂时没有取到预览');
      }
      if (cancelled || !mayApplyPhoneResponse(scope, snapshot(), 'preview')) return;
      timer = window.setTimeout(() => void pull(), pause ? STATUS_INTERVAL_MS : Math.max(0, FRAME_INTERVAL_MS - (Date.now() - started)));
    };
    void pull();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [deviceId, phase, hidden, botId, generation, devices]);
  useEffect(() => {
    if (phase !== 'live' || !deviceId || hidden) return;
    const scope: PhoneScope = { epoch: epochRef.current, botId, deviceId };
    let cancelled = false;
    let timer = 0;
    let failures = 0;
    const finish = (message: string) => {
      if (cancelled || !mayApplyPhoneResponse(scope, snapshot(), 'frame')) return;
      const current = sessionRef.current;
      if (!current || current.deviceId !== scope.deviceId) return;
      dropControl(message);
    };
    const pull = async () => {
      const session = sessionRef.current;
      const current = Date.now();
      if (cancelled || !session || session.deviceId !== scope.deviceId || !mayApplyPhoneResponse(scope, snapshot(), 'frame')) return;
      if (current >= hardRef.current) { finish('接管已到 10 分钟上限，已释放'); return; }
      if (current >= idleRef.current) { finish('空闲超过 45 秒，已释放'); return; }
      const started = Date.now();
      try {
        const value = await call('phoneFrame', { deviceId: session.deviceId, sessionId: session.id });
        if (cancelled || sessionRef.current?.id !== session.id || sessionRef.current.deviceId !== scope.deviceId || !mayApplyPhoneResponse(scope, snapshot(), 'frame')) return;
        const next = readFrame(value);
        if (next) {
          failures = 0;
          idleRef.current = touchLease('frame', Date.now(), hardRef.current, idleRef.current);
          setFrame(next);
          setFrameNotice('');
        } else if (++failures >= 5) { finish('连续没有取得有效画面，已释放接管'); return; }
        else setFrameNotice('这一帧画面无效');
      } catch (error) {
        if (cancelled || sessionRef.current?.id !== session.id || !mayApplyPhoneResponse(scope, snapshot(), 'frame')) return;
        const message = errorText(error);
        if (sessionEnded(error) || ++failures >= 5) finish(sessionEnded(error) ? message : '连续没有取到画面，已释放接管');
        else setFrameNotice('暂时没有取到画面');
      }
      if (!cancelled && sessionRef.current?.id === session.id && mayApplyPhoneResponse(scope, snapshot(), 'frame')) {
        timer = window.setTimeout(() => void pull(), Math.max(0, FRAME_INTERVAL_MS - (Date.now() - started)));
      }
    };
    void pull();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [phase, deviceId, hidden, botId, generation]);

  const chooseDevice = (next: string) => {
    if (!next || next === deviceId || !live.some(device => device.id === next)) return;
    pickedRef.current = true;
    dropControl(undefined, true);
    setDeviceId(next);
    if (botId) {
      try { rememberDevice(associationKey, botId, next); }
      catch { setActionNotice('这台电脑不允许保存关联'); }
    }
  };
  const takeover = async () => {
    if (!deviceId || phase !== 'preview' || hidden || pendingRef.current) return;
    if (!status.available || status.occupied) {
      setActionNotice(status.occupied ? '手机正在被占用，不能接管' : '当前不能接管');
      return;
    }
    const scope: PhoneScope = { epoch: epochRef.current, botId, deviceId };
    pendingRef.current = true;
    setPending(true);
    setActionNotice('');
    try {
      const acquired = await call('phoneAcquire', { deviceId: scope.deviceId });
      const current = Date.now();
      const session = readAcquire(acquired, current);
      if (!mayApplyPhoneResponse(scope, snapshot(), 'acquire')) {
        releaseAbandoned(scope, acquired);
        return;
      }
      if (!session) {
        const raw = rawSessionId(acquired);
        if (raw) releaseSession(scope.deviceId, raw);
        setActionNotice('没有取得有效的控制会话');
        return;
      }
      const hard = takeoverHardEnd(current, session.expiresAt);
      sessionRef.current = { id: session.sessionId, deviceId: scope.deviceId };
      hardRef.current = hard;
      idleRef.current = initialIdleEnd(current, hard);
      setExpiresAt(hard);
      setPhase('live');
      setActionNotice('');
    } catch (error) {
      if (mayApplyPhoneResponse(scope, snapshot(), 'acquire')) setActionNotice(errorText(error));
    } finally {
      if (scope.epoch === epochRef.current) {
        pendingRef.current = false;
        if (mountedRef.current) setPending(false);
      }
    }
  };
  const send = async (event: PhoneEvent) => {
    const session = sessionRef.current;
    if (!session || phaseRef.current !== 'live' || hiddenRef.current || session.deviceId !== deviceRef.current) {
      setActionNotice('还没有接管手机');
      return false;
    }
    const epoch = epochRef.current;
    try {
      await call('phoneInput', { deviceId: session.deviceId, sessionId: session.id, event });
      if (sessionRef.current?.id === session.id && epoch === epochRef.current && deviceRef.current === session.deviceId) {
        idleRef.current = touchLease('input', Date.now(), hardRef.current, idleRef.current);
      }
      return sessionRef.current?.id === session.id && epoch === epochRef.current;
    } catch (error) {
      if (!mountedRef.current || sessionRef.current?.id !== session.id || epoch !== epochRef.current) return false;
      const message = errorText(error);
      if (sessionEnded(error)) dropControl(message);
      else setActionNotice('操作没有送到手机');
      return false;
    }
  };
  const down = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (phase !== 'live' || event.button !== 0) return;
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* The pointer can end before capture. */ }
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), moved: false };
  };
  const move = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= TAP_SLOP_PX) drag.moved = true;
  };
  const up = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.pointerId !== event.pointerId || phase !== 'live') return;
    const from = toPhonePoint(drag.x, drag.y, event.currentTarget);
    const to = toPhonePoint(event.clientX, event.clientY, event.currentTarget);
    if (!from || !to) return;
    if (!drag.moved) void send({ type: 'tap', x: from.x, y: from.y });
    else void send({ type: 'swipe', x1: from.x, y1: from.y, x2: to.x, y2: to.y, duration: Math.min(2000, Math.max(50, Math.round(performance.now() - drag.at))) });
  };
  const submitText = async (event: FormEvent) => {
    event.preventDefault();
    if (sendingRef.current) return;
    const problem = textProblem(draft);
    if (problem) { setActionNotice(problem); return; }
    if (!draft) return;
    sendingRef.current = true;
    const accepted = await send({ type: 'text', text: draft });
    sendingRef.current = false;
    if (accepted && mountedRef.current) { setDraft(''); setActionNotice(''); }
  };
  const selected = live.find(device => device.id === deviceId) ?? null;
  const occupiedByOther = status.occupied && phase !== 'live';
  const phoneName = status.label || (status.phoneId ? status.phoneId : '节点未返回名称');
  const modeLabel = phoneModeLabel({
    hasDevices: live.length > 0,
    deviceSelected: !!selected,
    online: !!selected?.online,
    hidden,
    phase,
    pending,
    occupied: status.occupied,
    available: status.available,
  });

  return (
    <aside className="phone-dock" aria-label="手机预览">
      <section className="phone-panel">
        <header className="phone-head">
          <div>
            <h2>{phase === 'live' ? '手机接管' : '手机预览'}</h2>
            <p className="muted small">低帧率截图，大约每 0.5 秒一张，不是视频。{phase === 'live' && expiresAt ? `接管剩余 ${remainLabel(expiresAt, now)}。` : '默认只读预览，不调用接管，也不占用控制权。'}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose}>关闭</button>
        </header>
        <p className="muted small" role="status">{modeLabel}</p>
        {pinnedDeviceId ? (
          <p className="muted small">{selected ? `${selected.label} · ${platformLabel(selected.platform)} · ${selected.online ? '在线' : '离线'}` : '这台执行电脑已不可用'}</p>
        ) : (
          <label className="phone-device">执行电脑
            <select aria-label="选择已授权的执行电脑" value={deviceId ?? ''} onChange={event => chooseDevice(event.target.value)}>
              {!deviceId && <option value="">选择已授权的执行电脑</option>}
              {live.map(device => <option key={device.id} value={device.id}>{device.label} · {platformLabel(device.platform)} · {device.online ? '在线' : '离线'}</option>)}
            </select>
          </label>
        )}
        <p className="muted small">每台执行电脑只使用该节点已经启用的一台手机{deviceId ? `：${phoneName}` : ''}{status.phoneId ? `（${status.phoneId}）` : ''}。这里不会编造更多虚拟手机。{botId ? '关联按 Bot 记在本机，只接受仍授权的执行电脑，不同步到其他电脑或手机。' : '从设置打开时不改某个 Bot 的关联。'}</p>
        {!live.length && <p className="error">没有已授权的执行电脑。</p>}
        <div className={`phone-screen${phase === 'live' ? ' live' : ''}`}>
          {frame ? (
            <img
              src={frame.src}
              width={frame.width}
              height={frame.height}
              alt={phase === 'live' ? '手机当前画面，可以操作' : '手机只读预览'}
              draggable={false}
              onDragStart={event => event.preventDefault()}
              onContextMenu={event => event.preventDefault()}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={() => { dragRef.current = null; }}
            />
          ) : <p className="muted">{deviceId ? (selected?.online ? '正在读取画面…' : '执行电脑离线') : '先选择一台执行电脑'}</p>}
        </div>
        <div className="phone-actions">
          {phase === 'live'
            ? <button type="button" onClick={() => dropControl('已结束接管')}>结束接管</button>
            : <button type="button" className="primary" disabled={!deviceId || !selected?.online || !status.available || occupiedByOther || pending || hidden} onClick={() => void takeover()}>{pending ? '正在申请接管' : '接管'}</button>}
        </div>
        <div className="phone-keys">
          {KEYS.map(key => (
            <button key={key.code} type="button" disabled={phase !== 'live'} onClick={() => void send({ type: 'key', code: key.code })}>{key.label}</button>
          ))}
        </div>
        <form className="phone-compose" onSubmit={event => void submitText(event)} autoComplete="off">
          <input
            type="password"
            value={draft}
            maxLength={1000}
            placeholder="英文、数字和符号"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="发到手机的文字"
            disabled={phase !== 'live'}
            onChange={event => setDraft(event.target.value)}
          />
          <button className="primary" type="submit" disabled={phase !== 'live' || !draft}>发到手机</button>
        </form>
        <p className="muted small">接管最长 10 分钟，只有成功取到画面或输入才会把空闲时限重置为 45 秒。文字不进聊天、不写日志。关闭、切换 Bot 或电脑、进入后台都会释放接管。</p>
        {(actionNotice || frameNotice) && <p className="error">{actionNotice || frameNotice}</p>}
        {!status.available && status.reason && <p className="error">{status.reason}</p>}
        {occupiedByOther && <p className="muted small">手机正在被占用，只读预览仍可尝试，接管要等对方释放。</p>}
      </section>
    </aside>
  );
}
