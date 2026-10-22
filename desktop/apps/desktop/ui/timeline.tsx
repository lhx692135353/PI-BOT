import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PiBot } from '@pi-bot/bot-face/react';
import type { Mood } from '@pi-bot/bot-face';
import type { AgentTaskRef, Approval, Bot, FromBot, Message, MessagePage } from '../../../packages/protocol/src/index.js';
import { UiView } from '@pi-bot/a2ui/react';
import '@pi-bot/a2ui/styles';
import { bridge, call, errorText } from './bridge.js';
import { IMAGE_LIMIT_HINT, IMAGE_TYPES, imageSource, type ChatImage } from '@pi-bot/agent/images';
import { MessagePicture, readImages } from './images.js';

const time = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
const NO_IMAGES: ChatImage[] = [];

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:/.test(href)) void bridge.openExternal(href); }}>{children}</a>,
    }}>{text}</ReactMarkdown>
  );
});

function Progress({ lines }: { lines: string[] }) {
  // Older servers and saved history may still include the retired placeholder.
  const remarks = lines.filter(line => line.replace(/\s/gu, '') !== '好，我来看看，稍后把结果给你。');
  if (!remarks.length) return null;
  return (
    <div className="progress" aria-label="任务进度">
      {remarks.map((line, i) => <div className="bubble markdown" key={i}><Markdown text={line} /></div>)}
    </div>
  );
}

const TASK_STATE: Record<AgentTaskRef['status'], string> = { queued: '排队中', running: '进行中', waiting_approval: '等你批准', completed: '已完成', failed: '未完成', cancelled: '已取消' };

function Delegations({ tasks, onOpenBot }: { tasks: AgentTaskRef[]; onOpenBot(id: string): void }) {
  tasks = tasks.filter(t => t.kind !== 'background');
  if (!tasks.length) return null;
  return (
    <div className="delegations">
      {tasks.map(t => (
        <button key={t.id} className={`delegation ${t.status}`} onClick={() => onOpenBot(t.bot_id)} title={`打开 ${t.bot_name} 的时间线`}>
          交给了 {t.bot_name} · {t.mode === 'report' && t.status === 'running' ? '完成后回报' : TASK_STATE[t.status]} ›
        </button>
      ))}
    </div>
  );
}

function RelayMessage({ m, onOpenBot }: { m: Message & { from_bot: FromBot }; onOpenBot(id: string): void }) {
  const from = m.from_bot;
  return (
    <div className="msg relay">
      <button className="relay-head" onClick={() => onOpenBot(from.id)} title={`打开 ${from.name} 的时间线`}>
        {from.avatar && <PiBot avatar={from.avatar} mood="happy" size={22} />}
        <span>{from.kind === 'report' ? `${from.name} 的回报` : `来自 ${from.name} 的委托`}</span>
      </button>
      <div className="bubble markdown"><Markdown text={m.content} /></div>
      <span className="meta">{time(m.created_at)}</span>
    </div>
  );
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    try { await call('decide', { approvalId: approval.id, decision }); } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <div className="approval">
      <strong>想访问资料库以外的位置</strong>
      <code>{approval.path}</code>
      <p>{approval.reason}</p>
      {error && <p className="error small">{error}</p>}
      <div className="row-end">
        <button className="ghost" disabled={busy} onClick={() => decide('reject')}>拒绝</button>
        <button className="primary" disabled={busy} onClick={() => decide('approve')}>允许本次任务访问</button>
      </div>
    </div>
  );
}

export function Timeline({ bot, messages, hasMore, mood, online, onLoadMore, onSent, onOpenBot }: { bot: Bot; messages: Message[]; hasMore: boolean; mood: Mood; online: boolean; onLoadMore(): void; onSent(page: MessagePage): void; onOpenBot(id: string): void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [text, setText] = useState('');
  const [imageDrafts, setImageDrafts] = useState<Record<string, ChatImage[]>>({});
  const images = imageDrafts[bot.id] ?? NO_IMAGES;
  const setImages = (update: ChatImage[] | ((current: ChatImage[]) => ChatImage[])) => setImageDrafts(current => ({ ...current, [bot.id]: typeof update === 'function' ? update(current[bot.id] ?? NO_IMAGES) : update }));
  const picker = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const readingRef = useRef(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  const retry = useRef<{ text: string; images: ChatImage[]; bot: string; id: string } | null>(null);
  const activeBot = useRef(bot.id);
  activeBot.current = bot.id;
  const run = bot.latest_run;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, bot.pending_approvals.length]);
  useEffect(() => { stick.current = true; setError(''); }, [bot.id]);
  const addImages = async (files: File[]) => {
    if (!files.length || readingRef.current || submitting.current || !online) return;
    const botId = bot.id;
    readingRef.current = true;
    setReading(true);
    setError('');
    try { const next = await readImages(files, images); if (activeBot.current === botId) setImages(next); }
    catch (e) { if (activeBot.current === botId) setError(errorText(e)); }
    finally { readingRef.current = false; setReading(false); }
  };
  const send = async () => {
    const value = text.trim();
    if ((!value && !images.length) || !online || submitting.current || readingRef.current) return;
    const draft = text;
    const botId = bot.id;
    if (retry.current?.text !== value || retry.current.bot !== botId || retry.current.images !== images) retry.current = { text: value, images, bot: botId, id: crypto.randomUUID() };
    submitting.current = true;
    setSending(true);
    setError('');
    stick.current = true;
    try {
      const result = await call<{ messages: Message[] }>('send', { botId, text: value, images, request_id: retry.current.id });
      onSent({ messages: result.messages, has_more: hasMore });
      if (activeBot.current === botId) setText(current => current === draft ? '' : current);
      setImages(current => current === images ? [] : current);
      retry.current = null;
    } catch (e) { if (activeBot.current === botId) setError(errorText(e)); }
    finally { submitting.current = false; setSending(false); }
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  };
  let lastDay = '';
  return (
    <>
      <div className="timeline" ref={scroller} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {hasMore && <button className="ghost load-more" onClick={onLoadMore}>加载更早的消息</button>}
        {!messages.length && (
          <div className="intro">
            <PiBot avatar={bot.avatar} mood={mood === 'idle' ? 'happy' : mood} size={150} followPointer />
            <h2>{bot.is_main ? '有什么想做的，告诉我' : `我是 ${bot.name}`}</h2>
            <p className="muted">{bot.is_main ? '我是 Pi Bot，你的主智能体。查资料、写作、整理文件，或只是聊聊天，都可以直接找我。' : bot.persona ? bot.persona.slice(0, 140) : '告诉我你想做什么。我的资料都放在自己的资料库里，随时可以在文件管理器中查看。'}</p>
          </div>
        )}
        {messages.map(m => {
          const d = day(m.created_at);
          const separator = d !== lastDay ? <div className="day" key={`d-${m.id}`}><span>{d}</span></div> : null;
          lastDay = d;
          return [separator, m.role === 'user' && m.from_bot ? (
            <RelayMessage key={m.id} m={m as Message & { from_bot: FromBot }} onOpenBot={onOpenBot} />
          ) : m.role === 'user' ? (
            <div className="msg user" key={m.id}>
              {!!m.images?.length && <div className="message-pictures">{m.images.map(image => <MessagePicture key={image.id} botId={bot.id} messageId={m.id} image={image} onLoad={() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }} />)}</div>}
              {m.content && <div className="bubble">{m.content}</div>}<span className="meta">{time(m.created_at)}</span>
            </div>
          ) : (
            <div className="msg bot" key={m.id}>
              <div className="body">
                <Progress lines={m.progress ?? []} />
                <Delegations tasks={m.agent_tasks ?? []} onOpenBot={onOpenBot} />
                {m.content ? <div className="bubble markdown"><Markdown text={m.content} /></div> : m.status === 'running' ? <div className="typing"><i /><i /><i /></div> : null}
                {m.ui && <UiView key={m.id} document={m.ui} disabled={!online || m.status !== 'completed'}
                  save={async (states, revision) => { const saved = await call<Message>('uiState', { botId: bot.id, messageId: m.id, states, revision }); return saved.ui!; }}
                  action={async input => { const result=await call<{messages:Message[]}>('uiAction',{botId:bot.id,messageId:m.id,...input}); onSent({messages:result.messages,has_more:hasMore}); }} />}
                <span className="meta">
                  {time(m.created_at)}
                  {m.executor === 'cloud' && <span className="tag" title="电脑离线时在云端运行，只能对话和联网搜索">云端</span>}
                  {m.status === 'failed' && <span className="tag bad">{run?.assistant_message_id === m.id && run.error ? run.error : '运行失败'}</span>}
                  {m.status === 'cancelled' && <span className="tag">已停止</span>}
                </span>
              </div>
            </div>
          )];
        })}
        {bot.activity?.summary && <div className="task-activity" role="status" aria-live="polite"><PiBot avatar={bot.avatar} mood={mood} size={26} /><span>{bot.activity.summary}</span></div>}
        {bot.pending_approvals.map(a => <ApprovalCard key={a.id} approval={a} />)}
      </div>
      <div className="composer" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { e.preventDefault(); void addImages(Array.from(e.dataTransfer.files)); }}>
        {error && <p className="error small">{error}</p>}
        {!online && <p className="muted small">电脑未连接服务器，暂时无法发送。</p>}
        {!!images.length && <div className="image-drafts">{images.map((image, i) => <div key={i}><img src={imageSource(image)} alt={image.name} /><button disabled={sending || reading} aria-label={`移除 ${image.name}`} onClick={() => setImages(current => current.filter((_, index) => index !== i))}>×</button></div>)}</div>}
        <div className="input">
          <input ref={picker} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden onChange={e => { void addImages(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          <button className="attach ghost" disabled={!online || sending || reading || images.length >= 4} onClick={() => picker.current?.click()} title={IMAGE_LIMIT_HINT} aria-label="上传图片">＋</button>
          <textarea value={text} onChange={e => setText(e.target.value)} onKeyDown={key} onPaste={e => { const files = Array.from(e.clipboardData.files).filter(file => file.type.startsWith('image/')); if (files.length) { e.preventDefault(); void addImages(files); } }} rows={Math.min(8, Math.max(1, text.split('\n').length))} placeholder={`给 ${bot.name} 发消息`} disabled={!online} />
          <button className="send" disabled={(!text.trim() && !images.length) || !online || sending || reading} onClick={send} title="发送（Enter）">↑</button>
        </div>
      </div>
    </>
  );
}
