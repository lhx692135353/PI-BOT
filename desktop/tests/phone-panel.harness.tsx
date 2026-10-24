/** Mounts the real phone panel in Electron. The bridge is a local mock; nothing talks to a phone or server. */
import { useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PHONE_ASSOC_KEY } from '../apps/desktop/ui/phone-client.js';
import { DevicePhoneButton, PhoneDock } from '../apps/desktop/ui/phone-control.js';
import type { Device } from '../packages/protocol/src/index.js';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const BOT = '00000000-0000-4000-8000-0000000000aa';
const BOT2 = '00000000-0000-4000-8000-0000000000bb';
const SESSION = '00000000-0000-4000-8000-000000000099';
const JPEG_A = '/9j/aaaaaaaaaaaa';
const JPEG_B = '/9j/bbbbbbbbbbbb';

interface Call { method: string; input: unknown }
interface Failure { name: string; message: string }
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

const calls: Call[] = [];
let respond: (method: string, input: unknown) => unknown = () => ({});
let visibility: DocumentVisibilityState = 'visible';
let root: Root | null = null;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor<T>(read: () => T | null | undefined | false, label: string, timeout = 5000): Promise<T> {
  const start = Date.now();
  let error: unknown;
  while (Date.now() - start < timeout) {
    try {
      const value = read();
      if (value) return value;
    } catch (caught) { error = caught; }
    await delay(20);
  }
  const detail = error instanceof Error ? error.message : document.body.innerText.slice(0, 400);
  throw new Error(`超时：${label}；调用 ${calls.map(call => call.method).join(',')}；${detail}`);
}
function methods(name: string) { return calls.filter(call => call.method === name); }
function frame(data: string) { return { mime: 'image/jpeg', data, width: 720, height: 1280 }; }
function devices(): Device[] {
  return [
    { id: A, label: '电脑A', platform: 'linux', online: true, revoked_at: null, last_seen_at: '2026-10-23T00:00:00Z' },
    { id: B, label: '电脑B', platform: 'linux', online: true, revoked_at: null, last_seen_at: '2026-10-23T00:00:00Z' },
  ];
}
function button(text: string) {
  return [...document.querySelectorAll('button')].find(item => item.textContent === text) as HTMLButtonElement | undefined;
}
function image() { return document.querySelector('.phone-screen img') as HTMLImageElement | null; }
function installVisibility() {
  const define = (target: object) => Object.defineProperty(target, 'visibilityState', { configurable: true, get: () => visibility });
  try { define(document); }
  catch { define(Document.prototype); }
}
function installBridge() {
  const agent = {
    call: (method: string, input?: unknown) => {
      calls.push({ method, input });
      return Promise.resolve().then(() => respond(method, input));
    },
    subscribe: () => () => {},
    computerName: async () => 'linux-test',
    defaultServerUrl: async () => 'http://127.0.0.1:8787',
    openLibrary: async () => {},
    openExternal: async () => {},
  };
  Object.assign(window, { agent });
}
function reset() {
  calls.length = 0;
  visibility = 'visible';
  localStorage.clear();
  respond = () => ({});
  root?.unmount();
  root = null;
  const host = document.getElementById('root');
  if (host) host.replaceChildren();
}
async function render(node: ReactNode) {
  const host = document.getElementById('root');
  check(host, '缺少挂载节点');
  if (!root) root = createRoot(host);
  root.render(node);
  await delay(30);
}
async function enabledTakeover() {
  return waitFor(() => {
    const found = button('接管');
    return found && !found.disabled ? found : null;
  }, '可点的接管按钮');
}

async function entryAndDefaultPreview() {
  let opened = 0;
  respond = method => method === 'phoneStatus'
    ? { available: true, occupied: false, label: '验证机', phoneId: 'pixel' }
    : {};
  await render(<DevicePhoneButton device={devices()[0]} onOpen={() => { opened += 1; }} />);
  const entry = await waitFor(() => document.querySelector('button[aria-label="预览电脑A上的手机"]'), '设置里的手机入口');
  await waitFor(() => methods('phoneStatus').length > 0, '入口查询状态');
  check(methods('phoneAcquire').length === 0, '设置入口不应接管');
  check(methods('phonePreview').length === 0, '设置入口不应预览');
  (entry as HTMLButtonElement).click();
  check(opened === 1, '点击入口没有打开面板');

  const preview = deferred<unknown>();
  respond = (method, input) => {
    if (method === 'phoneStatus') return { available: true, occupied: false, label: '验证机', phoneId: 'pixel' };
    if (method === 'phonePreview') return preview.promise;
    if (method === 'phoneAcquire') throw new Error(`默认预览不应接管 ${JSON.stringify(input)}`);
    return {};
  };
  calls.length = 0;
  await render(<PhoneDock botId={BOT} pinnedDeviceId={null} devices={devices()} executionDeviceId={A} onClose={() => {}} />);
  await waitFor(() => document.querySelector('aside[aria-label="手机预览"] h2')?.textContent === '手机预览', '预览面板标题');
  check(document.body.innerText.includes('默认只读预览'), '面板没有说明默认只读');
  const first = await waitFor(() => methods('phonePreview')[0], '默认 phonePreview');
  check((first.input as { deviceId?: string }).deviceId === A, '预览没有打到当前执行电脑');
  check(methods('phoneAcquire').length === 0, '打开面板时已调用接管');
  preview.resolve(frame(JPEG_A));
  await waitFor(() => image()?.src.includes(JPEG_A) || null, '预览画面');
  await waitFor(() => methods('phonePreview').length >= 2, '预览刷新');
  check(methods('phoneAcquire').length === 0, '预览刷新期间调用了接管');
  check(!button('结束接管'), '默认进入了接管');
}

async function switchClearsOldFrame() {
  const previews: Array<Deferred<unknown> & { deviceId: string; settled: boolean }> = [];
  respond = method => {
    if (method === 'phoneStatus') return { available: true, occupied: false, label: '验证机', phoneId: 'pixel' };
    if (method === 'phonePreview') {
      const pending = deferred<unknown>();
      const deviceId = (calls.at(-1)?.input as { deviceId?: string } | undefined)?.deviceId ?? '';
      const item = { ...pending, deviceId, settled: false };
      const resolve = pending.resolve;
      item.resolve = value => { item.settled = true; resolve(value); };
      previews.push(item);
      return pending.promise;
    }
    return {};
  };
  await render(<PhoneDock botId={BOT} pinnedDeviceId={null} devices={devices()} executionDeviceId={A} onClose={() => {}} />);
  const first = await waitFor(() => previews.find(item => item.deviceId === A && !item.settled), '电脑A的预览请求');
  first.resolve(frame(JPEG_A));
  await waitFor(() => image()?.src.includes(JPEG_A) || null, '电脑A的画面');
  const late = await waitFor(() => previews.find(item => item.deviceId === A && !item.settled), '下一帧仍在途的旧预览');
  const select = await waitFor(() => document.querySelector('select[aria-label="选择已授权的执行电脑"]') as HTMLSelectElement | null, '执行电脑选择');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  check(setter, '无法设置选择框');
  setter.call(select, B);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => !image(), '切走后仍显示旧画面');
  late.resolve(frame(JPEG_A));
  for (const item of previews) if (item.deviceId === A && !item.settled) item.resolve(frame(JPEG_A));
  await delay(80);
  check(!image()?.src.includes(JPEG_A), '迟到的旧预览写回了新设备');
  const next = await waitFor(() => previews.find(item => item.deviceId === B && !item.settled), '电脑B的预览请求');
  next.resolve(frame(JPEG_B));
  await waitFor(() => image()?.src.includes(JPEG_B) || null, '新设备画面');
  check(methods('phoneAcquire').length === 0, '切换设备时调用了接管');
  calls.length = 0;
  root?.render(<PhoneDock botId={BOT2} pinnedDeviceId={null} devices={devices()} executionDeviceId={B} onClose={() => {}} />);
  await waitFor(() => !image()?.src.includes(JPEG_B), '切换 Bot 后仍保留上一台设备的画面');
}

function Host(props: { botId: string | null; pinned: string | null; execution: string | null; onUnmount(): void }) {
  const [open, setOpen] = useState(true);
  if (!open) return <p>面板已关闭</p>;
  return <PhoneDock botId={props.botId} pinnedDeviceId={props.pinned} devices={devices()} executionDeviceId={props.execution} onClose={() => { setOpen(false); props.onUnmount(); }} />;
}

async function lateAcquireReleases() {
  let acquire = deferred<unknown>();
  respond = method => {
    if (method === 'phoneStatus') return { available: true, occupied: false, label: '验证机', phoneId: 'pixel' };
    if (method === 'phonePreview') return frame(JPEG_A);
    if (method === 'phoneAcquire') return acquire.promise;
    return {};
  };
  await render(<PhoneDock botId={BOT} pinnedDeviceId={null} devices={devices()} executionDeviceId={A} onClose={() => {}} />);
  (await enabledTakeover()).click();
  await waitFor(() => methods('phoneAcquire').some(call => (call.input as { deviceId?: string }).deviceId === A), '接管请求');
  const select = document.querySelector('select') as HTMLSelectElement;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, B);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => !image()?.src.includes(JPEG_A), '切换后接管前的画面还在');
  acquire.resolve({ sessionId: SESSION, expiresAt: Date.now() + 10 * 60 * 1000 });
  const released = await waitFor(() => methods('phoneRelease').find(call => (call.input as { sessionId?: string }).sessionId === SESSION), '迟到接管的释放');
  check((released.input as { deviceId?: string }).deviceId === A, '释放打到了错误的执行电脑');
  check(!button('结束接管'), '迟到会话被留在新设备上');
  check(document.querySelector('h2')?.textContent === '手机预览', '迟到会话把面板留在接管态');

  calls.length = 0;
  localStorage.clear();
  acquire = deferred();
  root?.unmount();
  root = null;
  let unmounted = false;
  await render(<Host botId={BOT} pinned={null} execution={A} onUnmount={() => { unmounted = true; }} />);
  (await enabledTakeover()).click();
  const pending = await waitFor(() => methods('phoneAcquire')[0], '关闭前的接管请求');
  const pendingDevice = (pending.input as { deviceId?: string }).deviceId;
  button('关闭')?.click();
  await waitFor(() => unmounted, '关闭面板');
  acquire.resolve({ sessionId: SESSION, expiresAt: Date.now() + 10 * 60 * 1000 });
  const closed = await waitFor(() => methods('phoneRelease')[0], '关闭后面板迟到接管的释放');
  check((closed.input as { deviceId?: string }).deviceId === pendingDevice, `关闭后的释放打到了 ${(closed.input as { deviceId?: string }).deviceId}，接管的是 ${pendingDevice}`);
}

async function closeAndBackgroundRelease() {
  const session = { sessionId: SESSION, expiresAt: Date.now() + 10 * 60 * 1000 };
  respond = method => {
    if (method === 'phoneStatus') return { available: true, occupied: false, label: '验证机', phoneId: 'pixel' };
    if (method === 'phonePreview') return frame(JPEG_A);
    if (method === 'phoneAcquire') return session;
    return {};
  };
  let unmounted = false;
  await render(<Host botId={BOT} pinned={null} execution={A} onUnmount={() => { unmounted = true; }} />);
  (await enabledTakeover()).click();
  await waitFor(() => document.querySelector('h2')?.textContent === '手机接管', '进入接管');
  button('关闭')?.click();
  await waitFor(() => unmounted, '关闭');
  const released = await waitFor(() => methods('phoneRelease')[0], '关闭时释放');
  check((released.input as { sessionId?: string }).sessionId === SESSION, '关闭释放的会话不对');

  calls.length = 0;
  unmounted = false;
  await render(<PhoneDock botId={BOT} pinnedDeviceId={null} devices={devices()} executionDeviceId={A} onClose={() => { unmounted = true; }} />);
  (await enabledTakeover()).click();
  await waitFor(() => document.querySelector('h2')?.textContent === '手机接管', '后台前已接管');
  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  const background = await waitFor(() => methods('phoneRelease')[0], '转入后台时释放');
  check((background.input as { deviceId?: string }).deviceId === A, '后台释放打错设备');
  await waitFor(() => document.body.innerText.includes('已转入后台'), '后台提示');
  check(document.querySelector('h2')?.textContent === '手机预览', '后台后仍停在接管');
  const acquireCount = methods('phoneAcquire').length;
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await delay(200);
  check(methods('phoneAcquire').length === acquireCount, '回到前台后自动重新接管');

  calls.length = 0;
  root?.unmount();
  root = null;
  await render(<PhoneDock botId={BOT} pinnedDeviceId={null} devices={devices()} executionDeviceId={A} onClose={() => {}} />);
  (await enabledTakeover()).click();
  await waitFor(() => methods('phoneAcquire').length > 0 && document.querySelector('h2')?.textContent === '手机接管', 'pagehide 前进入接管');
  calls.length = 0;
  window.dispatchEvent(new Event('pagehide'));
  const page = await waitFor(() => methods('phoneRelease')[0], 'pagehide 释放');
  check((page.input as { sessionId?: string }).sessionId === SESSION, 'pagehide 没有释放当前会话');
}

async function missingBindingDoesNotRetarget() {
  localStorage.setItem(PHONE_ASSOC_KEY, JSON.stringify({ [BOT]: A }));
  const remaining = devices().filter(device => device.id === B);
  respond = method => method === 'phoneStatus' ? { available: true, occupied: false } : frame(JPEG_B);
  await render(<PhoneDock botId={BOT} pinnedDeviceId={null} devices={remaining} executionDeviceId={B} onClose={() => {}} />);
  await delay(150);
  check(methods('phonePreview').length === 0, '失效绑定静默切到另一台电脑预览');
  check(methods('phoneAcquire').length === 0, '失效绑定触发接管');
  const select = document.querySelector('select[aria-label="选择已授权的执行电脑"]') as HTMLSelectElement;
  check(select?.value === '', '失效绑定未要求明确选择');
  select.value = B; select.dispatchEvent(new Event('change', { bubbles: true }));
  const preview = await waitFor(() => methods('phonePreview')[0], '明确选择后的预览');
  check((preview.input as { deviceId?: string }).deviceId === B, '明确选择后的目标不一致');
}

const scenarios = [
  ['入口与默认预览不接管', entryAndDefaultPreview],
  ['切换设备或 Bot 清掉旧画面', switchClearsOldFrame],
  ['迟到的接管会被释放', lateAcquireReleases],
  ['关闭和后台会释放接管', closeAndBackgroundRelease],
  ['失效绑定不静默换设备', missingBindingDoesNotRetarget],
] as const;

async function main() {
  const failures: Failure[] = [];
  installVisibility();
  installBridge();
  for (const [name, run] of scenarios) {
    reset();
    try { await run(); }
    catch (error) { failures.push({ name, message: error instanceof Error ? error.stack || error.message : String(error) }); }
  }
  reset();
  return { ok: failures.length === 0, failures, scenarios: scenarios.map(([name]) => name) };
}

void main().then(result => { (window as unknown as { __phoneResult?: unknown }).__phoneResult = result; })
  .catch(error => { (window as unknown as { __phoneResult?: unknown }).__phoneResult = { ok: false, failures: [{ name: 'harness', message: error instanceof Error ? error.stack || error.message : String(error) }] }; });
