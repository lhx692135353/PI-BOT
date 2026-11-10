import type { Message, MessagePage } from '../../../packages/protocol/src/index.js';

export type TimelinePage = { messages: Message[]; hasMore: boolean };

const PREFIX = 'pi-bot.timeline.v1.';
/** Only the newest messages are kept on disk; older pages come from the server on scroll. */
const CACHE_LIMIT = 60;
const key = (userId: string, botId: string) => `${PREFIX}${userId}.${botId}`;

export function readTimeline(userId: string, botId: string): TimelinePage | null {
  try {
    const raw = localStorage.getItem(key(userId, botId));
    if (!raw) return null;
    const page = JSON.parse(raw) as TimelinePage;
    if (!Array.isArray(page.messages) || !page.messages.length) return null;
    return { messages: page.messages, hasMore: page.hasMore === true };
  } catch { return null; }
}

export function writeTimeline(userId: string, botId: string, page: TimelinePage) {
  const messages = page.messages.slice(-CACHE_LIMIT);
  if (!messages.length) return;
  const value = JSON.stringify({ messages, hasMore: page.hasMore || messages.length < page.messages.length });
  try { localStorage.setItem(key(userId, botId), value); }
  catch {
    // Quota is shared with drafts; history is only a cache.
    clearTimelines();
  }
}

export function clearTimelines(userId?: string) {
  const prefix = userId ? `${PREFIX}${userId}.` : PREFIX;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) localStorage.removeItem(k);
    }
  } catch { /* Storage may be unavailable; nothing to clear then. */ }
}

const bySeq = (a: Message, b: Message) => a.seq - b.seq;

/** Merges the newest page into what is already shown. A page that does not reach the cached messages replaces them, so no gap is ever displayed. */
export function mergeTail(old: TimelinePage | undefined, page: MessagePage): TimelinePage {
  const first = page.messages[0];
  const newest = old?.messages.at(-1);
  if (!old?.messages.length || (page.has_more && first && newest && first.seq > newest.seq)) {
    return { messages: [...page.messages].sort(bySeq), hasMore: page.has_more };
  }
  const byId = new Map(old.messages.map(m => [m.id, m]));
  for (const m of page.messages) byId.set(m.id, m);
  return { messages: [...byId.values()].sort(bySeq), hasMore: first && first.seq <= old.messages[0].seq ? page.has_more : old.hasMore };
}

/** Prepends an older page; ignored when the timeline was replaced while it loaded. */
export function mergeOlder(old: TimelinePage | undefined, before: string, page: MessagePage): TimelinePage | undefined {
  if (!old || old.messages[0]?.id !== before) return old;
  const byId = new Map(page.messages.map(m => [m.id, m]));
  for (const m of old.messages) byId.set(m.id, m);
  return { messages: [...byId.values()].sort(bySeq), hasMore: page.has_more };
}
