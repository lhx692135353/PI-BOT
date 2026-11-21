import {uploadDocument} from './documents.js';
import { AttachmentMenu } from './attachment-menu.js';
import type {ArtifactRef} from '../../../packages/protocol/src/index.js';
import { confirmAction, showNotice } from './dialogs.js';
import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PiBot } from './bot-avatar.js';
import type { Mood } from '@pi-bot/bot-face';
import type { AgentTaskRef, Approval, Bot, FromBot, Message, MessagePage, TaskConversation } from '../../../packages/protocol/src/index.js';
import { uniqueById } from './unique.js';
import { UiView } from '@pi-bot/a2ui/react';
import '@pi-bot/a2ui/styles';
import { bridge, call, errorText } from './bridge.js';
import { imageSource, type ChatImage } from '@pi-bot/agent/images';
import { MessagePicture, readImages } from './images.js';
import { readDrafts, stageDrafts, flushDrafts } from './drafts.js';
import { Icon } from './icons.js';

const time = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
const NO_IMAGES: ChatImage[] = [];

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if(href&&/^\/remote\/artifacts\/[0-9a-f-]{36}$/.test(href))void call<{url:string}>('remoteArtifact',{id:href.split('/').at(-1)}).then(r=>bridge.openExternal(r.url)).catch(e=>showNotice(errorText(e)));else if (href && /^https?:/.test(href)) void bridge.openExternal(href); }}>{children}</a>,
    }}>{text}</ReactMarkdown>
  );
});

function Progress({ lines }: { lines: string[] }) {
  // Older servers and saved history may still include the retired placeholder.
  const remarks = lines;
  if (!remarks.length) return null;
  return (
    <div className="progress" aria-label="任务进度">
      {remarks.map((line, i) => <div className="bubble markdown" key={i}><Markdown text={line} /></div>)}
    </div>
  );
}

const TASK_STATE: Record<AgentTaskRef['status'], string> = { queued: '排队中', running: '进行中', waiting_approval: '等你批准', completed: '已完成', failed: '未完成', cancelled: '已取消' };

function Delegations({ tasks, onSelect }: { tasks: AgentTaskRef[]; onSelect(task: AgentTaskRef): void }) {
  tasks = tasks.filter(t => t.kind !== 'background');
  if (!tasks.length) return null;
  return <div className="delegations">{tasks.map(t => (
    <button key={t.id} className={`delegation ${t.status}`} onClick={() => onSelect(t)} aria-label={`查看与 ${t.bot_name} 的传话详情`}>
      {t.message_count ?? 0} 条消息往来 · {t.bot_name} · {TASK_STATE[t.status]} ›
    </button>
  ))}</div>;
}

function ConversationDialog({ bot, task, onClose, onOpenBot }: { bot: Bot; task: AgentTaskRef; onClose(): void; onOpenBot(id: string): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<TaskConversation | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const state = useRef<TaskConversation | null>(null);
  const loading = useRef(false);
  const alive = useRef(true);
  const load = async (more = false) => {
    if (loading.current) return;
    loading.current = true; setBusy(true);
    try {
      const current = state.current;
      const after = current && (more || !current.has_more) ? current.next_after : 0;
      const page = await call<TaskConversation>('taskConversation', { botId: bot.id, taskId: task.id, after });
      if (!alive.current) return;
      const byId = new Map((current?.messages ?? []).map(m => [m.id, m]));
      page.messages.forEach(m => byId.set(m.id, m));
      const next = { ...page, messages: [...byId.values()].sort((a, b) => a.seq - b.seq), next_after: Math.max(current?.next_after ?? 0, page.next_after), has_more: after === 0 && current ? current.has_more : page.has_more };
      state.current = next; setData(next); setError('');
    } catch (e) { if (alive.current) setError(errorText(e)); }
    finally { loading.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal(); void load();
    const timer = setInterval(() => { void load(); }, 5000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);
  const participants = data?.bots ?? [{ id: bot.id, name: bot.name, avatar: bot.avatar }, { id: task.bot_id, name: task.bot_name, avatar: null }];
  return <dialog className="conversation-dialog" ref={dialog} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === dialog.current) onClose(); }} aria-labelledby="conversation-title">
    <div className="conversation-panel">
      <header><div id="conversation-title" className="conversation-participants">{participants.map((b, i) => <span key={b.id}>{i > 0 && <span className="muted">↔ </span>}{b.avatar && <PiBot avatar={b.avatar} mood="happy" size={26} />}{b.name}</span>)}</div><button className="ghost" onClick={onClose} aria-label="关闭传话详情">×</button></header>
      <div className="conversation-meta">{data?.total ?? task.message_count ?? 0} 条消息往来 · {TASK_STATE[data?.status ?? task.status]}{data?.execution_label ? ` · 本次使用：${data.execution_label}` : ""}</div>
      <div className="conversation-messages" aria-live="polite">
        {!data && busy && <p className="muted">正在加载传话…</p>}
        {data && !data.messages.length && <p className="muted">还没有传话记录</p>}
        {uniqueById(data?.messages ?? []).map(m => { const sender = participants.find(b => b.id === m.from_bot_id); return <article key={m.id}><div className="conversation-sender">{sender?.avatar && <PiBot avatar={sender.avatar} mood="happy" size={22} />}<strong>{sender?.name ?? '智能体'}</strong>{m.created_at && <time>{time(m.created_at)}</time>}</div><div className="bubble markdown"><Markdown text={m.content} /></div></article>; })}
        {error && <p className="error" role="alert">{error} <button className="ghost" disabled={busy} onClick={() => void load()}>重试</button></p>}
        {data?.has_more && <button className="ghost" disabled={busy} onClick={() => void load(true)}>{busy ? '正在加载…' : '加载更多往来'}</button>}
      </div>
      <footer><button className="ghost" onClick={() => { onClose(); onOpenBot(task.bot_id); }}>打开 {task.bot_name} 的聊天 ›</button></footer>
    </div>
  </dialog>;
}

function ReportFiles({ message }: { message: Message }) {
  const [error,setError]=useState('');
  const [opening,setOpening]=useState<string|null>(null);
  if(!message.attachments?.length)return null;
  return <div className="report-files">{message.attachments.map(file=><button type="button" className="report-file" key={file.id} disabled={opening===file.id} onClick={()=>{setError('');setOpening(file.id);void call<{url:string}>('reportOpen',{id:file.id}).then(r=>bridge.openExternal(r.url)).catch(e=>setError(errorText(e))).finally(()=>setOpening(null));}}>
    <span className="report-file-icon" aria-hidden="true">▤</span><span className="report-file-info"><strong>{file.title}</strong><span>{file.name.split('.').at(-1)?.toUpperCase()} · {file.size<1024 ? `${file.size} B` : `${(file.size/1024).toFixed(1)} KB`} · {time(file.created_at)}</span></span><span className="report-file-action">{opening===file.id?'打开中…':'打开文件 ›'}</span>
  </button>)}{error&&<p role="alert" className="error">{error}</p>}</div>;
}

function ReplyBubbles({ message }: { message: Message }) {
  const segments = uniqueById(message.reply_segments ?? []);
  const legacy = segments.length ? [] : (message.progress ?? []);
  const tail = segments.some(s=>s.phase === 'answer') ? '' : message.content;
  return <>
    <Progress lines={legacy} />
    {segments.map(s => <div className="reply-segment" key={s.id}><div className="bubble markdown"><Markdown text={s.text} /></div><time className="meta">{time(s.created_at)}</time></div>)}
    {tail ? <div className="bubble markdown"><Markdown text={tail} /></div> : !segments.length && message.status === 'running' ? <div className="typing"><i /><i /><i /></div> : null}
    <ReportFiles message={message} />
  </>;
}

function RelayMessage({ m, onOpenBot }: { m: Message & { from_bot: FromBot }; onOpenBot(id: string): void }) {
  const from = m.from_bot;
  return (
    <div className="msg relay" data-message={m.id}>
      <button className="relay-head" onClick={() => onOpenBot(from.id)} title={`打开 ${from.name} 的时间线`}>
        {from.avatar && <PiBot avatar={from.avatar} mood="happy" size={22} />}
        <span>{from.kind === 'report' ? `${from.name} 的回报` : `来自 ${from.name} 的委托`}</span>
      </button>
      <div className="bubble markdown"><Markdown text={m.content} /></div>
      <ReportFiles message={m} />
      <span className="meta">{time(m.created_at)}</span>
    </div>
  );
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  const login = approval.kind === 'browser_login';
  const browser = login || approval.kind === 'browser_access';
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState(false);
  const [error, setError] = useState('');
  const decide = async (decision: 'approve' | 'approve_always' | 'reject') => {
    if (decision === 'approve_always' && !await confirmAction(`一直允许以下范围？\n${approval.scope}\n可在设置 → 已保存授权中撤销。`)) return;
    setError('');
    setBusy(true);
    try { await call('decide', { approvalId: approval.id, decision }); setDecided(true); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="approval">
      <strong>{login ? '测试暂停，等待你登录' : browser ? '浏览器测试需要访问站点' : '想访问资料库以外的位置'}</strong>
      <code style={browser ? { whiteSpace: 'pre-wrap' } : undefined}>{approval.path}</code>
      <p>{approval.reason}</p>
      <p className="small">{approval.scope ?? (browser ? '仅本次任务可访问以上站点' : '仅本次任务访问此路径。旧版执行端无法保存授权，请更新执行电脑客户端。')}</p>
      {decided && <p role="status">已提交决定，正在同步…</p>}{error && <p className="error small">{error}</p>}
      <div className="row-end">
        <button className="ghost" disabled={busy || decided} onClick={() => decide('reject')}>{login ? '取消登录' : '拒绝'}</button>
        <button className="primary" disabled={busy || decided} onClick={() => decide('approve')}>{login ? '返回 Bot 继续' : '仅本次允许'}</button>
        {!browser && <button className="ghost" disabled={busy || decided || !approval.can_remember} title={approval.can_remember ? '保存上述操作权限，可在设置中撤销' : '旧版或范围不明确的权限需要逐次确认'} onClick={() => decide('approve_always')}>一直允许</button>}
      </div>
    </div>
  );
}

/** Older history starts loading this far before the top is reached. */
const LOAD_AHEAD = 600;

export function Timeline({ bot, messages, hasMore, mood, online, onLoadMore, onSent, onOpenBot }: { bot: Bot; messages: Message[]; hasMore: boolean; mood: Mood; online: boolean; onLoadMore(): Promise<void>; onSent(page: MessagePage): void; onOpenBot(id: string): void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<{ bot: string; id?: string; offset: number }>({ bot: '', offset: 0 });
  const [farFromBottom, setFarFromBottom] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  const requestedPage = useRef<{ bot: string; oldest: string } | null>(null);
  const [olderError, setOlderError] = useState('');
  const [drafts, setDrafts] = useState(readDrafts);
  const text = drafts[bot.id]?.text ?? '';
  const setText = (update: string | ((current: string) => string)) => setDrafts(current => ({...current,[bot.id]:{...current[bot.id],images:current[bot.id]?.images ?? [],text:typeof update === 'function' ? update(current[bot.id]?.text ?? '') : update}}));
  const [conversationTask, setConversationTask] = useState<AgentTaskRef | null>(null);
  const images = drafts[bot.id]?.images ?? NO_IMAGES;
  const setImages = (update: ChatImage[] | ((current: ChatImage[]) => ChatImage[])) => setDrafts(current => ({ ...current, [bot.id]: {...current[bot.id],text:current[bot.id]?.text ?? '', images:typeof update === 'function' ? update(current[bot.id]?.images ?? NO_IMAGES) : update} }));
  const documents = drafts[bot.id]?.documents ?? [];
  const documentPicker=useRef<HTMLInputElement>(null);
  const [documentReady,setDocumentReady]=useState(false);
  const [uploads,setUploads]=useState<{botId:string;file:File;id:string;sent:number;error?:string;controller:AbortController}[]>([]);
  useEffect(()=>{if(online)void call('documentCapabilities').then(()=>setDocumentReady(true)).catch(()=>setDocumentReady(false));},[online]);
  const upload=async(item:{botId:string;file:File;id:string;sent:number;controller:AbortController})=>{
    setUploads(current=>[...current.filter(x=>x.id!==item.id),item]);
    try{
      const artifact=await uploadDocument(item.file,item.botId,item.id,sent=>setUploads(current=>current.map(x=>x.id===item.id?{...x,sent}:x)),item.controller.signal);
      setDrafts(current=>({...current,[item.botId]:{text:current[item.botId]?.text??'',images:current[item.botId]?.images??[],documents:[...(current[item.botId]?.documents??[]).filter(x=>x.id!==artifact.id),artifact]}}));
      setUploads(current=>current.filter(x=>x.id!==item.id));
    }catch(e){if(!item.controller.signal.aborted)setUploads(current=>current.map(x=>x.id===item.id?{...x,error:errorText(e)}:x));}
  };
  const addDocuments=(files:File[])=>{
    if(!files.length || !online || submitting.current)return;
    if(!documentReady){setError('服务器尚不支持文件上传，请升级服务器');return;}
    if(documents.length+uploads.filter(x=>x.botId===bot.id).length+files.length>4){setError('每条消息最多 4 个文件');return;}
    for(const file of files)void upload({botId:bot.id,file,id:crypto.randomUUID(),sent:0,controller:new AbortController()});
  };
  const documentBusy=uploads.some(x=>x.botId===bot.id);
  const [reading, setReading] = useState(false);
  const readingRef = useRef(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  const retry = useRef<{ text: string; images: ChatImage[]; documents:ArtifactRef[]; bot: string; id: string } | null>(null);
  const activeBot = useRef(bot.id);
  useLayoutEffect(() => { stageDrafts(drafts); }, [drafts]);
  useEffect(() => {
    const save = () => { try { flushDrafts(); } catch { /* Installation retries this write and surfaces a blocking error. */ } };
    window.addEventListener('pagehide',save);
    return () => { save(); window.removeEventListener('pagehide',save); };
  },[]);
  activeBot.current = bot.id;
  const run = bot.latest_run;
  const firstOffset = (el: HTMLDivElement, id: string | undefined) => {
    const node = id ? el.querySelector<HTMLElement>(`[data-message="${CSS.escape(id)}"]`) : null;
    return node ? node.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
  };
  const loadOlder = () => {
    const oldest = messages[0]?.id;
    if (!hasMore || loadingOlderRef.current || !oldest) return;
    // The request can settle before React commits the older messages.
    if (requestedPage.current?.bot === bot.id && requestedPage.current.oldest === oldest) return;
    const request = requestedPage.current = { bot: bot.id, oldest };
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderError('');
    onLoadMore()
      .catch(e => {
        if (requestedPage.current === request) requestedPage.current = null;
        if (activeBot.current === request.bot) setOlderError(errorText(e));
      })
      .finally(() => { loadingOlderRef.current = false; setLoadingOlder(false); });
  };
  const readSeq = useRef({bot:'',seq:0,pending:false});
  const markVisibleRead = () => {
    const el=scroller.current;
    if(!online || bot.unread_count===undefined || !el || document.visibilityState!=='visible' || el.scrollHeight-el.scrollTop-el.clientHeight>=80)return;
    const seq=Math.max(0,...messages.filter(m=>m.status!=='running').map(m=>m.seq));
    if(readSeq.current.bot===bot.id && (readSeq.current.pending || readSeq.current.seq>=seq))return;
    const id=bot.id;
    const confirmed=readSeq.current.bot===id?readSeq.current.seq:0;
    readSeq.current={bot:id,seq:confirmed,pending:true};
    void call('markRead',{botId:id,seq}).then((r:any)=>{
      if(readSeq.current.bot===id) readSeq.current.seq=Math.max(readSeq.current.seq,Number(r.last_read_seq)||0);
    }).catch(()=>{}).finally(()=>{if(readSeq.current.bot===id)readSeq.current.pending=false;});
  };
  useEffect(()=>{markVisibleRead();document.addEventListener('visibilitychange',markVisibleRead);return()=>document.removeEventListener('visibilitychange',markVisibleRead);},[bot.id,bot.unread_count,messages,online]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    markVisibleRead();
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = gap < 80;
    setFarFromBottom(gap > el.clientHeight);
    anchor.current = { bot: bot.id, id: messages[0]?.id, offset: firstOffset(el, messages[0]?.id) ?? 0 };
    if (el.scrollTop < LOAD_AHEAD && !olderError) loadOlder();
  };
  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: el.scrollHeight - el.scrollTop > el.clientHeight * 6 ? 'auto' : 'smooth' });
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const previous = anchor.current;
    const first = messages[0]?.id;
    if (requestedPage.current && (requestedPage.current.bot !== bot.id || requestedPage.current.oldest !== first)) {
      requestedPage.current = null;
    }
    if (previous.bot !== bot.id) { stick.current = true; setFarFromBottom(false); }
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (previous.id) {
      // Older messages and the loading row both sit above the reader. Keep the
      // anchored message still when either of those rows appears or disappears.
      const offset = firstOffset(el, previous.id);
      if (offset !== null) el.scrollTop += offset - previous.offset;
    }
    anchor.current = { bot: bot.id, id: first, offset: firstOffset(el, first) ?? 0 };
    if (hasMore && el.scrollTop < LOAD_AHEAD && !loadingOlderRef.current && !olderError) loadOlder();
  }, [messages, bot.id, bot.pending_approvals.length, loadingOlder, olderError]);
  useEffect(() => { setError(''); setOlderError(''); setConversationTask(null); }, [bot.id]);
  const addFiles = async (files: File[]) => {
    if (!files.length || readingRef.current || submitting.current || !online) return;
    const botId = bot.id;
    readingRef.current = true; setReading(true); setError('');
    let next = images;
    const generic: File[] = [];
    try {
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          try { next = await readImages([file], next); continue; }
          catch { /* Unsupported images and images beyond the visual quota remain ordinary files. */ }
        }
        generic.push(file);
      }
      if (activeBot.current === botId) {
        setImages(next);
        addDocuments(generic);
      }
    } finally { readingRef.current = false; setReading(false); }
  };
  const send = async () => {
    const value = text.trim();
    if ((!value && !images.length && !documents.length) || !online || submitting.current || readingRef.current || documentBusy) return;
    const draft = text;
    const botId = bot.id;
    if (retry.current?.text !== value || retry.current.bot !== botId || retry.current.images !== images || retry.current.documents.map(d=>d.id).join() !== documents.map(d=>d.id).join()) retry.current = { text: value, images, documents, bot: botId, id: crypto.randomUUID() };
    submitting.current = true;
    setSending(true);
    setError('');
    stick.current = true;
    try {
      const result = await call<{ messages: Message[] }>('send', { botId, text: value, images, document_ids:documents.map(d=>d.id), request_id: retry.current.id });
      onSent({ messages: result.messages, has_more: hasMore });
      setDrafts(current => {
        const latest = current[botId];
        if (!latest) return current;
        return {...current,[botId]:{
          text:latest.text === draft ? '' : latest.text,
          images:latest.images === images ? [] : latest.images,
          documents:(latest.documents??[]).filter(d=>!documents.some(sent=>sent.id===d.id)),
        }};
      });
      retry.current = null;
    } catch (e) { if (activeBot.current === botId) setError(errorText(e)); }
    finally { submitting.current = false; setSending(false); }
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); void send(); }
  };
  let lastDay = '';
  return (
    <>
      {conversationTask && <ConversationDialog key={`${bot.id}:${conversationTask.id}`} bot={bot} task={conversationTask} onClose={() => setConversationTask(null)} onOpenBot={onOpenBot} />}
      {!online && <p className="muted small" role="status">连接已断开，仍可编辑草稿，重连后发送。</p>}
      <div className="timeline-frame">
      <div className="timeline" ref={scroller} onScroll={onScroll}>
        {(loadingOlder || olderError) && (
          <div className="load-more muted" role="status">
            {olderError ? <>{olderError} <button className="ghost" onClick={loadOlder}>重试</button></> : '正在加载更早的消息…'}
          </div>
        )}
        {!messages.length && (
          <div className="intro">
            <PiBot avatar={bot.avatar} mood={mood === 'idle' ? 'happy' : mood} size={150} followPointer />
            <h2>{bot.is_main ? '有什么想做的，告诉我' : `我是 ${bot.name}`}</h2>
            <p className="muted">{bot.is_main ? '我是 Pi Bot，你的主智能体。查资料、写作、整理文件，或只是聊聊天，都可以直接找我。' : bot.persona ? bot.persona.slice(0, 140) : '告诉我你想做什么。我的资料都放在自己的资料库里，随时可以在文件管理器中查看。'}</p>
          </div>
        )}
        {uniqueById(messages).map(m => {
          const d = day(m.created_at);
          const separator = d !== lastDay ? <div className="day" key={`d-${m.id}`}><span>{d}</span></div> : null;
          lastDay = d;
          return [separator, m.role === 'user' && m.from_bot ? (
            <RelayMessage key={m.id} m={m as Message & { from_bot: FromBot }} onOpenBot={onOpenBot} />
          ) : m.role === 'user' ? (
            <div className="msg user" key={m.id} data-message={m.id}>
              {!!m.images?.length && <div className="message-pictures">{m.images.map(image => <MessagePicture key={image.id} botId={bot.id} messageId={m.id} image={image} onLoad={() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }} />)}</div>}
              {m.content && <div className="bubble">{m.content}</div>}<ReportFiles message={m} /><span className="meta">{time(m.created_at)}</span>
            </div>
          ) : (
            <div className="msg bot" key={m.id} data-message={m.id}>
              <div className="body">
                <ReplyBubbles message={m} />
                <Delegations tasks={m.agent_tasks ?? []} onSelect={setConversationTask} />
                {m.ui && <UiView key={m.id} document={m.ui} disabled={!online || m.status !== 'completed'}
                  save={async (states, revision) => { const saved = await call<Message>('uiState', { botId: bot.id, messageId: m.id, states, revision }); return saved.ui!; }}
                  action={async input => { const result=await call<{messages:Message[]}>('uiAction',{botId:bot.id,messageId:m.id,...input}); onSent({messages:result.messages,has_more:hasMore}); }} />}
                <span className="meta">
                  {!m.reply_segments?.length && time(m.created_at)}
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
      {farFromBottom && <button type="button" className="jump-bottom" onClick={toBottom} title="回到最新消息" aria-label="回到最新消息"><Icon name="arrow" size={18} style={{ transform: 'rotate(180deg)' }} /></button>}
      </div>
      <div className="composer" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { e.preventDefault(); const files=Array.from(e.dataTransfer.files);void addFiles(files); }}>
        {error && <p className="error small">{error}</p>}
        {!online && <p className="muted small">电脑未连接服务器，暂时无法发送。</p>}
        {!!images.length && <div className="image-drafts">{images.map((image, i) => <div key={i}><img src={imageSource(image)} alt={image.name} /><button disabled={sending || reading} aria-label={`移除 ${image.name}`} onClick={() => setImages(current => current.filter((_, index) => index !== i))}>×</button></div>)}</div>}
        <div className="document-drafts">
          {documents.map(file=><div key={file.id}><span>{file.name}</span><button type="button" disabled={sending} onClick={()=>setDrafts(current=>({...current,[bot.id]:{...current[bot.id],documents:(current[bot.id]?.documents??[]).filter(d=>d.id!==file.id)}}))}>移除</button></div>)}
          {uploads.filter(x=>x.botId===bot.id).map(item=><div key={item.id}><span>{item.file.name} · {Math.round(item.sent/item.file.size*100)}% {item.error}</span>{item.error&&<button type="button" onClick={()=>void upload({...item,controller:new AbortController()})}>重试</button>}<button type="button" onClick={()=>{item.controller.abort();setUploads(current=>current.filter(x=>x.id!==item.id));void call('documentUploadCancel',{id:item.id}).catch(()=>{});}}>取消上传</button></div>)}
        </div>
        <div className="input">
          <input ref={documentPicker} type="file" multiple hidden onChange={e=>{const files=Array.from(e.target.files??[]);void addFiles(files);e.target.value='';}} />
          <AttachmentMenu key={bot.id} disabled={!online || sending || reading || ((!documentReady || documents.length+uploads.filter(x=>x.botId===bot.id).length>=4) && images.length>=4)} onFiles={() => documentPicker.current?.click()} />
          <textarea value={text} onChange={e => setText(e.target.value)} onKeyDown={key} onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); void addFiles(files); } }} rows={Math.min(8, Math.max(1, text.split('\n').length))} placeholder={`给 ${bot.name} 发消息`} aria-label="消息输入" />
          <button className="send" disabled={(!text.trim() && !images.length && !documents.length) || !online || sending || reading || documentBusy} onClick={send} title="发送（Enter）" aria-label="发送消息"><Icon name="arrow" size={19} /></button>
        </div>
      </div>
    </>
  );
}
