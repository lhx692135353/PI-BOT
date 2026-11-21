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
  for (const m of page.messages) {const prev=byId.get(m.id);if(!prev || (m.stream_seq ?? -1)>=(prev.stream_seq ?? -1))byId.set(m.id,m);}
  return { messages: [...byId.values()].sort(bySeq), hasMore: first && first.seq <= old.messages[0].seq ? page.has_more : old.hasMore };
}

/** Prepends an older page; ignored when the timeline was replaced while it loaded. */
export function mergeOlder(old: TimelinePage | undefined, before: string, page: MessagePage): TimelinePage | undefined {
  if (!old || old.messages[0]?.id !== before) return old;
  const byId = new Map(page.messages.map(m => [m.id, m]));
  for (const m of old.messages) byId.set(m.id, m);
  return { messages: [...byId.values()].sort(bySeq), hasMore: page.has_more };
}

export type StreamFrame={type:'stream';bot_id:string;message_id:string;stream_id:string;seq:number;offset:number;reset:boolean;text:string;status:Message["status"];message:Message};
export function applyStream(old:TimelinePage|undefined,e:StreamFrame):TimelinePage|undefined {
 if(!e.reset || e.offset!==0 || !Number.isSafeInteger(e.seq) || e.seq<0 || e.message?.id!==e.message_id || e.message.role!=='assistant')return old;
 const prev=old?.messages.find(m=>m.id===e.message_id);
 if(prev && (prev.stream_seq ?? -1)>=e.seq)return old;
 if(prev && prev.status!=='running' && e.status==='running')return old;
 const message={...e.message,content:e.text,status:e.status,stream_seq:e.seq};
 const byId=new Map((old?.messages ?? []).map(m=>[m.id,m]));byId.set(message.id,message);
 return {messages:[...byId.values()].sort(bySeq),hasMore:old?.hasMore ?? true};
}
export function liveReplySegments(message:Message) {
 const segments=message.reply_segments ?? [];
 if(message.status!=='running' || !message.content.trim())return segments;
 const answer=[...segments].reverse().find(s=>s.phase==='answer');
 return answer?segments.map(s=>s.id===answer.id?{...s,text:message.content}:s):[...segments,{id:`${message.id}:stream`,phase:'answer' as const,text:message.content,created_at:message.created_at,generated_at:message.created_at}];
}
