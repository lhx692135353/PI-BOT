import { createRoot } from 'react-dom/client';
import { DEFAULT_AVATAR } from '@pi-bot/bot-face';
import { Timeline } from '../apps/desktop/ui/timeline.js';
import type { Bot, Message } from '../packages/protocol/src/index.js';
import '../apps/desktop/ui/style.css';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const TASK = '00000000-0000-4000-8000-000000000003';
const now = '2026-10-27T12:00:00Z';
const bot: Bot = { id: A, name: '服务助手', slug: 'service', persona: '', model_id: null, avatar: DEFAULT_AVATAR, created_at: now, last_active_at: now, latest_run: null, last_message: null, pending_approvals: [], activity: { status: 'running', running_count: 1, queued_count: 0, tool: null, summary: '正在检查显存占用' } };
const opening = { id: 'open', phase: 'opening' as const, text: '先检查服务的显存占用和测试机器。', created_at: now, generated_at: now };
const answer = { id: 'answer', phase: 'answer' as const, text: '服务正常。接下来把显存使用上限从 60% 调回 85%，重启后再测一次。', created_at: now, generated_at: now };
let reply: Message = { id: 'reply', bot_id: A, run_id: 'run', seq: 2, role: 'assistant', content: '', status: 'running', executor: 'device', tools: [], progress: [opening.text], reply_segments: [opening], created_at: now, updated_at: now,
  agent_tasks: [{ id: TASK, bot_id: B, bot_name: '检查助手', status: 'running', mode: 'report', kind: 'delegation', message_count: 3 }] };
const user: Message = { ...reply, id: 'user', seq: 1, role: 'user', content: '现在怎么样了？简单说一下。', status: 'completed', reply_segments: [], progress: [], agent_tasks: [] };
let requests = 0;
window.agent = {
  call: async (method, input: any) => {
    if(method === 'reportOpen')return {__runtime_reply:2,ok:true,result:{url:'https://report.test/preview'}};
    if (method !== 'taskConversation') return {};
    requests++;
    if (requests === 1) throw new Error('连接暂时中断');
    const entries = [
      { id: '1', seq: 1, from_bot_id: A, to_bot_id: B, kind: 'request', content: '检查服务的显存占用，再核对测试机器。', created_at: now },
      { id: '2', seq: 2, from_bot_id: B, to_bot_id: A, kind: 'update', content: '服务正常，正在核对测试机器。', created_at: now },
      { id: '3', seq: 3, from_bot_id: B, to_bot_id: A, kind: 'answer', content: '建议把显存使用上限从 60% 调回 85%，重启后再测一次。', created_at: now },
    ];
    return { task_id: TASK, status: 'completed', total: 3, bots: [{ id: A, name: bot.name, avatar: DEFAULT_AVATAR }, { id: B, name: '检查助手', avatar: DEFAULT_AVATAR }], messages: input.after ? entries.slice(2) : entries.slice(0, 2), next_after: input.after ? 3 : 2, has_more: !input.after };
  },
  subscribe: () => () => {}, computerName: async () => '', defaultServerUrl: async () => '', openLibrary: async () => {}, openExternal: async url => { (window as any).__reportOpened=url; },
};
const root = createRoot(document.getElementById('root')!);
function render() { root.render(<div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><Timeline bot={bot} messages={[user, reply]} hasMore={false} mood="working" online onLoadMore={() => {}} onSent={() => {}} onOpenBot={() => {}} /></div>); }
render();
(window as any).__chatHarness = {
  finish() { reply = { ...reply, attachments:[{id:TASK,title:'服务状态与显存压力测试完整报告',name:'report.md',mime:'text/markdown',size:16400,created_at:now,status:'ready'}], content: answer.text, status: 'completed', reply_segments: [opening, answer], agent_tasks: reply.agent_tasks?.map(t => ({ ...t, status: 'completed' })) }; bot.activity = { status: null, tool: null, summary: null, running_count: 0, queued_count: 0 }; render(); },
};
