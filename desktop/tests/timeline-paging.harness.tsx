import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_AVATAR } from '@pi-bot/bot-face';
import { Timeline } from '../apps/desktop/ui/timeline.js';
import type { Bot, Message } from '../packages/protocol/src/index.js';
import '../apps/desktop/ui/style.css';

const BOT = '00000000-0000-4000-8000-000000000001';
const now = '2026-11-10T12:00:00Z';
const bot: Bot = { id: BOT, name: '分页助手', slug: 'paging', persona: '', model_id: null, avatar: DEFAULT_AVATAR, created_at: now, last_active_at: now, latest_run: null, last_message: null, pending_approvals: [] };
const history: Message[] = Array.from({ length: 120 }, (_, i) => ({
  id: `m-${i + 1}`, bot_id: BOT, run_id: null, seq: i + 1, role: i % 2 ? 'assistant' : 'user', status: 'completed', executor: null, tools: [],
  content: `第 ${i + 1} 条消息。${'这是一段用来撑开高度的历史内容。'.repeat(1 + (i % 4))}`, created_at: now, updated_at: now,
}));
const PAGE = 30;
const harness = { loads: 0, release: () => {} };
(window as any).__paging = harness;
window.agent = { call: async () => ({}), subscribe: () => () => {}, computerName: async () => '', defaultServerUrl: async () => '', openLibrary: async () => {}, openExternal: async () => {} };

function App() {
  const [messages, setMessages] = useState(history.slice(-PAGE));
  const hasMore = messages[0].seq > 1;
  const onLoadMore = () => new Promise<void>(resolve => {
    harness.loads++;
    harness.release = () => {
      const before = messages[0].seq;
      setMessages(current => [...history.filter(m => m.seq < before).slice(-PAGE), ...current]);
      resolve();
    };
  });
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><Timeline bot={bot} messages={messages} hasMore={hasMore} mood="idle" online onLoadMore={onLoadMore} onSent={() => {}} onOpenBot={() => {}} /></div>;
}

createRoot(document.getElementById('root')!).render(<App />);
