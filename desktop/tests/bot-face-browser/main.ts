/** Development-only fixture: real desktop UI, in-memory bots, no account or network. */
import { DEFAULT_AVATAR, type Color } from '@pi-bot/bot-face';
import type { AppEvent, Bot, RunStatus } from '../../packages/protocol/src/index.js';

const listeners = new Set<(event: AppEvent) => void>();
const now = () => new Date().toISOString();
const examples: { name: string; color: Color; status: RunStatus | null; tool?: string; sleeping?: boolean }[] = [
  { name: 'Pi Bot', color: 'orange', status: null },
  { name: '程序员', color: 'mint', status: 'running', tool: 'run_command' },
  { name: '研究员', color: 'sky', status: 'running', tool: 'web_search' },
  { name: '思考者', color: 'grape', status: 'running' },
  { name: '等待确认', color: 'lemon', status: 'waiting_approval' },
  { name: '休息中', color: 'pink', status: null, sleeping: true },
];
const bots: Bot[] = examples.map((example, index) => ({
  id: `avatar-test-${index}`,
  name: example.name,
  slug: `avatar-test-${index}`,
  persona: '',
  model_id: null,
  avatar: { ...DEFAULT_AVATAR, color: example.color },
  is_main: index === 0,
  created_at: now(),
  last_active_at: example.sleeping ? new Date(Date.now() - 7 * 86400_000).toISOString() : now(),
  latest_run: null,
  last_message: null,
  pending_approvals: [],
  activity: {
    status: example.status,
    tool: example.tool ?? null,
    summary: example.status === 'waiting_approval' ? '等你批准…' : null,
    running_count: example.status === 'running' ? 1 : 0,
    queued_count: 0,
  },
}));
window.agent = {
  call: async method => {
    switch (method) {
      case 'status': return {
        connection: 'online', serverUrl: 'http://localhost',
        user: { id: 'avatar-test', username: 'local-test', display_name: '动画验证' },
        deviceLabel: 'Mac', libraryRoot: '~/pi-bot', activities: [],
      };
      case 'bots': return { bots: structuredClone(bots) };
      case 'models': return [];
      case 'messages': return { messages: [], has_more: false };
      default: return {};
    }
  },
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  computerName: async () => 'Mac',
  defaultServerUrl: async () => 'http://localhost',
  openLibrary: async () => {},
  openExternal: async () => {},
};
// Simulate an OS preference change within this isolated fixture only.
const nativeMatchMedia = window.matchMedia.bind(window);
const motionQuery = '(prefers-reduced-motion: reduce)';
let reduceMotion = nativeMatchMedia(motionQuery).matches;
const media = Object.assign(new EventTarget(), { media: motionQuery }) as MediaQueryList;
Object.defineProperty(media, 'matches', { get: () => reduceMotion });
window.matchMedia = query => query === motionQuery ? media : nativeMatchMedia(query);
await import('../../apps/desktop/ui/main.js');

const controls = document.createElement('div');
controls.style.cssText = 'position:fixed;right:24px;bottom:150px;width:210px;background:white;padding:12px;border-radius:12px;box-shadow:0 2px 12px #0001;z-index:10';
const stateControl = document.createElement('label');
stateControl.textContent = '验证「程序员」状态';
const select = document.createElement('select');
for (const [value, label] of Object.entries({
  running: '工作中', queued: '排队', waiting_approval: '等待确认',
  completed: '完成', failed: '失败', cancelled: '取消',
})) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.append(option);
}
select.onchange = () => {
  const bot = bots[1];
  const status = select.value as RunStatus;
  bot.activity = {
    status, tool: status === 'running' ? 'run_command' : null,
    summary: status === 'waiting_approval' ? '等你批准…' : null,
    running_count: status === 'running' ? 1 : 0, queued_count: status === 'queued' ? 1 : 0,
  };
  bot.latest_run = {
    id: 'avatar-test-run', bot_id: bot.id, status, executor: 'mac', error: null,
    created_at: now(), finished_at: ['completed', 'failed', 'cancelled'].includes(status) ? now() : null,
    assistant_message_id: 'avatar-test-message',
  };
  for (const listener of listeners) listener({ type: 'bots' });
};
stateControl.append(select);
controls.append(stateControl);
document.body.append(controls);
const motionControl = document.createElement('label');
motionControl.style.cssText = 'display:flex;align-items:center;font-weight:normal';
const checkbox = document.createElement('input');
checkbox.type = 'checkbox';
checkbox.style.width = 'auto';
checkbox.checked = reduceMotion;
checkbox.onchange = () => {
  reduceMotion = checkbox.checked;
  media.dispatchEvent(new Event('change'));
};
motionControl.append(checkbox, '减少动态效果（模拟系统设置）');
controls.append(motionControl);
