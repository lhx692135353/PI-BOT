import { StrictMode, useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { PiBot } from "@pi-bot/bot-face/react";
import type { Mood } from "@pi-bot/bot-face";
import { api, ApiError, session, type CatalogModel, type Device, type Model, type ModelInput, type Overview, type ProviderName, type Usage, type User } from "./api.js";
import "./style.css";

type Page = "overview" | "users" | "models" | "devices" | "usage";
const PAGES: { id: Page; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "users", label: "用户" },
  { id: "models", label: "模型" },
  { id: "devices", label: "电脑设备" },
  { id: "usage", label: "用量" },
];

const message = (e: unknown) => (e instanceof Error ? e.message : "请求失败");
const fmt = (n: number) => n.toLocaleString("zh-CN");
const ago = (iso: string | null) => {
  if (!iso) return "从未";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};

function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    load().then(
      (d) => {
        setData(d);
        setError("");
      },
      (e) => setError(message(e)),
    );
  }, [load]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

function Login({ onDone }: { onDone: (u: User) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [mood, setMood] = useState<Mood>("idle");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMood("thinking");
    setError("");
    try {
      const r = await api.login(username, password);
      if (r.user.role !== "admin") throw new ApiError(403, "该账号不是管理员");
      session.set(r.access_token);
      setMood("celebrate");
      setTimeout(() => onDone(r.user), 700);
    } catch (err) {
      setMood("error");
      setError(message(err));
    }
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <PiBot avatar={{ shape: "blob", color: "orange", scheme: "light" }} mood={mood} size={132} followPointer />
        <h1>Pi Bot 管理后台</h1>
        <p className="muted">管理用户、模型与设备</p>
        <label>
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
        </label>
        <label>
          密码
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={!username || !password || mood === "thinking"}>
          登录
        </button>
      </form>
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="ghost icon" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function OverviewPage() {
  const load = useCallback(() => api.overview(), []);
  const { data, error } = useLoad<Overview>(load);
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  const stats = [
    ["用户", data.users],
    ["Bot", data.bots],
    ["在线电脑", data.devices_online],
    ["启用模型", data.models],
    ["今日运行", data.runs_today],
    ["今日 Token", data.tokens_today],
  ] as const;
  return (
    <>
      <div className="stats">
        {stats.map(([label, value]) => (
          <div className="stat" key={label}>
            <span className="muted">{label}</span>
            <strong>{fmt(Number(value))}</strong>
          </div>
        ))}
      </div>
      {data.models === 0 && (
        <div className="callout">
          <PiBot avatar={{ shape: "blob", color: "orange", scheme: "light" }} mood="waiting" size={72} />
          <div>
            <strong>还没有可用模型</strong>
            <p className="muted">用户的 Bot 需要至少一个启用的模型才能工作。到「模型」页添加一个 Responses API 兼容的模型。</p>
          </div>
        </div>
      )}
    </>
  );
}

function UserForm({ user, onClose, onSaved }: { user?: User; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ username: user?.username ?? "", display_name: user?.display_name ?? "", password: "", role: user?.role ?? "user" });
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (user) await api.updateUser(user.id, { display_name: form.display_name, role: form.role, ...(form.password ? { password: form.password } : {}) });
      else await api.createUser(form);
      onSaved();
      onClose();
    } catch (err) {
      setError(message(err));
    }
  };
  return (
    <Modal title={user ? `编辑 ${user.username}` : "新建用户"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          用户名
          <input value={form.username} disabled={!!user} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="字母、数字和 _ . @ -" />
        </label>
        <label>
          显示名称
          <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
        </label>
        <label>
          {user ? "重置密码（留空不修改）" : "初始密码"}
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="至少 8 位" autoComplete="new-password" />
        </label>
        <label>
          角色
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as User["role"] })}>
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={!form.username || (!user && form.password.length < 8)}>
            保存
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function EnvironmentForm({user,onClose}:{user:User;onClose():void}) {
 const [environment,setEnvironment]=useState<any>();
 const [form,setForm]=useState({host:'',port:22,username:'pibot',fingerprint:'',work_root:'/home/pibot/workspaces'});
 const [privateKey,setPrivateKey]=useState(''),[password,setPassword]=useState(''),[passphrase,setPassphrase]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{void api.environment(user.id).then(e=>{setEnvironment(e);if(e.config)setForm(e.config);}).catch(e=>setError(message(e)));},[user.id]);
 const perform=async(test:boolean)=>{setBusy(true);setError('');try{if(!test){await api.saveEnvironment(user.id,{config:form,...(privateKey||password?{secret:{private_key:privateKey||undefined,password:password||undefined,passphrase:passphrase||undefined}}:{})});setPrivateKey('');setPassword('');setPassphrase('');}setEnvironment(test?await api.testEnvironment(user.id):await api.environment(user.id));}catch(e){setError(message(e));}finally{setBusy(false);}};
 return <Modal title={`${user.display_name} 的云端环境`} onClose={onClose}><p>模式：{environment?.backend??'加载中'} · 状态：{environment?.status??''}</p><p className="muted small">每用户一台虚机。SSH 环境请先按部署文档安装 Ubuntu 24.04 操作组件，再录入主机指纹。</p>{environment?.backend==='ssh'&&<form onSubmit={e=>{e.preventDefault();void perform(false);}}>
 {(['host','port','username','fingerprint','work_root'] as const).map(key=><label key={key}>{({host:'地址',port:'端口',username:'SSH 用户名',fingerprint:'SHA256 主机指纹',work_root:'工作根目录'})[key]}<input required value={form[key]} type={key==='port'?'number':'text'} onChange={e=>setForm({...form,[key]:key==='port'?Number(e.target.value):e.target.value})}/></label>)}
 <label>私钥（留空保留原凭据）<textarea value={privateKey} onChange={e=>setPrivateKey(e.target.value)} autoComplete="off"/></label>
 <label>私钥口令<input type="password" value={passphrase} onChange={e=>setPassphrase(e.target.value)} autoComplete="new-password"/></label>
 <label>或 SSH 密码<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password"/></label>
 <button className="primary" disabled={busy}>保存</button></form>}
 {environment?.error&&<p className="error">{environment.error}</p>}{error&&<p className="error">{error}</p>}
 <p className="muted small">能力：{environment?.capabilities?.join('、')||'尚未检测'}</p><footer><button className="ghost" onClick={onClose}>关闭</button><button className="primary" disabled={busy||!environment||environment.backend==='none'} onClick={()=>void perform(true)}>{busy?'处理中…':'连接和能力检测'}</button></footer></Modal>;
}

function UsersPage({ me }: { me: User }) {
  const [environmentUser,setEnvironmentUser]=useState<User|null>(null);
  const load = useCallback(() => api.users(), []);
  const { data, error, reload } = useLoad<User[]>(load);
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      reload();
    } catch (e) {
      alert(message(e));
    }
  };
  return (
    <>
      <div className="toolbar">
        <p className="muted">用户由管理员创建，没有自助注册。每个用户可以同时绑定多台 Mac 或 Linux 执行电脑。</p>
        <button className="primary" onClick={() => setEditing("new")}>
          新建用户
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>用户</th>
            <th>角色</th>
            <th>Bot</th>
            <th>电脑</th>
            <th>状态</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((u) => (
            <tr key={u.id} className={u.disabled ? "dim" : ""}>
              <td>
                <strong>{u.display_name}</strong>
                <div className="muted small">{u.username}</div>
              </td>
              <td>{u.role === "admin" ? <span className="badge accent">管理员</span> : "用户"}</td>
              <td>{u.bot_count ?? 0}</td>
              <td>
                {u.devices?.filter(d=>!d.revoked_at).length ? u.devices.filter(d=>!d.revoked_at).map(d=><div key={d.id} className="device"><i className={d.online ? 'dot on' : 'dot'}/>{d.label} · {d.platform === 'linux' ? 'Linux' : d.platform === 'darwin' ? 'macOS' : d.platform === 'win32' ? 'Windows' : '未知平台'} · {d.online ? '在线' : '离线'}</div>) : <span className="muted">未绑定</span>}
              </td>
              <td>{u.disabled ? <span className="badge">已禁用</span> : <span className="badge ok">正常</span>}</td>
              <td className="actions">
                <button className="ghost" onClick={()=>setEnvironmentUser(u)}>云端环境</button>
                <button className="ghost" onClick={() => setEditing(u)}>
                  编辑
                </button>
                {u.id !== me.id && (
                  <>
                    <button className="ghost" onClick={() => act(() => api.updateUser(u.id, { disabled: !u.disabled }))}>
                      {u.disabled ? "启用" : "禁用"}
                    </button>
                    <button className="ghost danger" onClick={() => confirm(`删除用户 ${u.username}？其 Bot 记录会一并删除（电脑上的资料库文件保留）。`) && act(() => api.deleteUser(u.id))}>
                      删除
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {environmentUser&&<EnvironmentForm user={environmentUser} onClose={()=>setEnvironmentUser(null)}/>}
      {editing && <UserForm user={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </>
  );
}

const EMPTY_MODEL: ModelInput = { name: "", provider: "xai", base_url: "", provider_model: "", voice_model: null, provider_search: false, api_key: "", context_window: 128000, max_tokens: 8192, enabled: true, is_default: false };
const PROVIDER_LABEL: Record<ProviderName, string> = { xai: "xAI", bailian: "百炼", custom: "自定义" };

function ModelForm({ model, onClose, onSaved }: { model?: Model; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<ModelInput>(model ? { ...model, api_key: "" } : EMPTY_MODEL);
  const [catalog, setCatalog] = useState<{ chat: CatalogModel[]; voice: CatalogModel[] } | null>(null);
  const [manual, setManual] = useState(form.provider === "custom");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<ModelInput>) => setForm({ ...form, ...patch });
  const known = form.provider === "xai" || form.provider === "bailian";
  const chat = [...(catalog?.chat ?? [])];
  if (form.provider_model && !chat.some((item) => item.id === form.provider_model)) chat.unshift({ id: form.provider_model, context_window: form.context_window, max_tokens: form.max_tokens });
  const voice = [...(catalog?.voice ?? [])];
  if (form.voice_model && !voice.some((item) => item.id === form.voice_model)) voice.unshift({ id: form.voice_model, context_window: null, max_tokens: null });
  const picked = chat.find((item) => item.id === form.provider_model);
  const locked = Boolean(catalog && picked?.context_window && picked.max_tokens);
  const pull = async () => {
    if (!known) return;
    if (!form.api_key && !model) { setError("请先填写 API Key"); return; }
    setLoading(true);
    setError("");
    try {
      const result = await api.modelCatalog({ provider: form.provider as "xai" | "bailian", api_key: form.api_key || undefined, model_id: model?.id });
      setCatalog(result);
      setManual(false);
    } catch (err) {
      setManual(true);
      setError(message(err));
    } finally {
      setLoading(false);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body: ModelInput = {
        ...form,
        voice_model: form.voice_model || null,
        base_url: known ? (form.provider === "xai" ? "https://api.x.ai/v1" : "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1") : form.base_url.trim().replace(/\/+$/, ""),
      };
      if (model) {
        if (!body.api_key) delete body.api_key;
        await api.updateModel(model.id, body);
      } else await api.createModel(body);
      onSaved();
      onClose();
    } catch (err) {
      setError(message(err));
    }
  };
  return (
    <Modal title={model ? `编辑 ${model.name}` : "添加模型"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          显示名称
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="例如：Grok" />
        </label>
        <label>
          服务商
          <select value={form.provider} onChange={(e) => { const provider = e.target.value as ProviderName; setCatalog(null); setManual(provider === "custom"); set({ provider, provider_model: "", capabilities: undefined, voice_model: provider === "bailian" ? "qwen-audio-3.0-realtime-plus" : null, provider_search: false }); }}>
            <option value="xai">xAI</option>
            <option value="bailian">百炼</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        {known ? <p className="muted small">{form.provider === "xai" ? "接口使用 https://api.x.ai/v1，不用填写域名。" : "接口使用 https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1，不用填写域名。"}</p> : (
          <label>
            接口地址（Responses API Base URL）
            <input value={form.base_url} onChange={(e) => set({ base_url: e.target.value })} placeholder="https://example.com/v1" />
          </label>
        )}
        <label>
          API Key{model && "（留空则保持不变）"}
          <input type="password" value={form.api_key} onChange={(e) => set({ api_key: e.target.value })} autoComplete="off" />
        </label>
        {known && (
          <button type="button" className="ghost" disabled={loading} onClick={pull}>
            {loading ? "拉取中…" : "拉取模型"}
          </button>
        )}
        <label>
          对话模型
          {known && !manual ? (
            <select value={form.provider_model} disabled={!catalog} onChange={(e) => {
              const item = chat.find((option) => option.id === e.target.value);
              set({
                provider_model: e.target.value,
                ...(item?.context_window ? { context_window: item.context_window } : {}),
                ...(item?.max_tokens ? { max_tokens: item.max_tokens } : {}),
                capabilities: item?.capabilities,
                name: !form.name || form.name === form.provider_model ? e.target.value : form.name,
              });
            }}>
              <option value="">{catalog ? "选择模型" : "先拉取模型"}</option>
              {chat.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
            </select>
          ) : (
            <input value={form.provider_model} onChange={(e) => set({ provider_model: e.target.value })} placeholder={known ? "拉取失败时可手填模型 ID" : "填写服务商模型 ID"} />
          )}
        </label>
        {known && (
          <label>
            语音模型
            <select value={form.voice_model ?? ""} onChange={(e) => set({ voice_model: e.target.value || null })}>
              <option value="">不开通语音</option>
              {voice.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
            </select>
          </label>
        )}
        {known && <p className="muted small">语音模型可以不选。不选则这个模型不能打电话。</p>}
        {known && (
          <label className="check">
            <input type="checkbox" checked={form.provider_search} onChange={(e) => set({ provider_search: e.target.checked })} />
            使用服务商搜索
          </label>
        )}
        {known && <p className="muted small">{form.provider === "xai" ? "打开后，任务里的联网搜索使用 xAI，检索网页和 X。" : "打开后，任务里的联网搜索使用百炼的网页检索。模型需要支持这项能力。"}</p>}
        <label className="check"><input type="checkbox" checked={form.capabilities?.vision ?? true} onChange={e=>set({capabilities:{chat:true,voice:false,tools:true,reasoning:"unknown",...form.capabilities,vision:e.target.checked}})}/>支持图片输入</label>
        <label className="check"><input type="checkbox" checked={form.capabilities?.tools ?? true} onChange={e=>set({capabilities:{chat:true,vision:true,voice:false,reasoning:"unknown",...form.capabilities,tools:e.target.checked}})}/>支持原生工具调用</label>
        <label>推理模式
          <select value={form.capabilities?.reasoning ?? "unknown"} onChange={e => set({capabilities:{chat:true,vision:true,voice:false,tools:true,...form.capabilities,reasoning:e.target.value as "none"|"configurable"|"required"|"unknown"}})}>
            <option value="unknown">自动识别，未知模型遵循服务商默认</option><option value="none">无推理模式</option><option value="configurable">可配置</option><option value="required">必须开启</option>
          </select>
        </label>
        {form.capabilities?.reasoning === "configurable" && <label>聊天关闭推理的参数（JSON，按服务商文档填写）
          <input key={`${form.provider}:${form.provider_model}`} defaultValue={JSON.stringify(form.capabilities.reasoning_off ?? {})} onBlur={e=>{try{const value=JSON.parse(e.target.value);if(value && typeof value==="object"&&!Array.isArray(value))set({capabilities:{...form.capabilities!,reasoning_off:value}});}catch{e.target.setCustomValidity("请输入 JSON 对象");}}}/>
        </label>}
        {locked ? (
          <p className="muted small">上下文 {fmt(form.context_window)}，单次输出上限 {fmt(form.max_tokens)}。这两项来自所选模型。</p>
        ) : (
          <div className="row">
            <label>
              上下文长度
              <input type="number" value={form.context_window} onChange={(e) => set({ context_window: Number(e.target.value) })} />
            </label>
            <label>
              单次输出上限
              <input type="number" value={form.max_tokens} onChange={(e) => set({ max_tokens: Number(e.target.value) })} />
            </label>
          </div>
        )}
        <div className="row checks">
          <label className="check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> 启用
          </label>
          <label className="check">
            <input type="checkbox" checked={form.is_default} onChange={(e) => set({ is_default: e.target.checked })} /> 设为默认
          </label>
        </div>
        <p className="muted small">密钥加密保存在服务端，客户端只通过服务端代理调用模型，永远拿不到密钥。</p>
        {error && <p className="error">{error}</p>}
        <footer>
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={!form.name || !form.provider_model || (!known && !form.base_url) || (!model && !form.api_key)}>
            保存
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function ModelsPage() {
  const load = useCallback(() => api.models(), []);
  const { data, error, reload } = useLoad<Model[]>(load);
  const [editing, setEditing] = useState<Model | "new" | null>(null);
  const [tests, setTests] = useState<Record<string, {state:"pending"|"ok"|"error";text:string}>>({});
  const test = async (m: Model) => {
    setTests((t) => ({ ...t, [m.id]: {state:"pending",text:"测试中…"} }));
    const r = await api.testModel(m.id).catch((e) => ({ ok: false, error: message(e), latency_ms: 0 }));
    setTests((t) => ({ ...t, [m.id]: {state:r.ok?"ok":"error",text:r.ok?`可用 · ${r.latency_ms} ms` : `${"error" in r ? r.error : "失败"}`} }));
  };
  return (
    <>
      <div className="toolbar">
        <p className="muted">所有用户的 Bot 共用这里的模型。默认模型用于未单独选择模型的 Bot 和长期记忆整理。</p>
        <button className="primary" onClick={() => setEditing("new")}>
          添加模型
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="cards">
        {data?.map((m) => (
          <div className={`card ${m.enabled ? "" : "dim"}`} key={m.id}>
            <div className="card-head">
              <strong>{m.name}</strong>
              {m.is_default && <span className="badge accent">默认</span>}
              {!m.enabled && <span className="badge">已停用</span>}
            </div>
            <dl>
              <dt>服务商</dt>
              <dd>{PROVIDER_LABEL[m.provider] ?? m.provider}</dd>
              <dt>模型</dt>
              <dd>{m.provider_model}</dd>
              <dt>语音</dt>
              <dd>{m.voice_model || "未开通"}</dd>
              {(m.provider === "xai" || m.provider === "bailian") && <><dt>搜索</dt>
              <dd>{m.provider_search ? "服务商" : "关闭"}</dd></>}
              {m.provider === "custom" && <><dt>接口</dt>
              <dd className="mono">{m.base_url}</dd></>}
              <dt>上下文</dt>
              <dd>
                {fmt(m.context_window)} / 输出 {fmt(m.max_tokens)}
              </dd>
            </dl>
            {tests[m.id] && <p className={tests[m.id].state === "error" ? "error small" : "ok small"}>{tests[m.id].text}</p>}
            <div className="actions">
              <button className="ghost" onClick={() => test(m)}>
                测试
              </button>
              <button className="ghost" onClick={() => setEditing(m)}>
                编辑
              </button>
              <button className="ghost danger" onClick={() => confirm(`删除模型 ${m.name}？使用它的 Bot 会改用默认模型。`) && api.deleteModel(m.id).then(reload, (e) => alert(message(e)))}>
                删除
              </button>
            </div>
          </div>
        ))}
        {data?.length === 0 && <p className="muted">还没有模型。</p>}
      </div>
      {editing && <ModelForm model={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </>
  );
}

function DevicesPage() {
  const load = useCallback(() => api.devices(), []);
  const { data, error, reload } = useLoad<Device[]>(load);
  return (
    <>
      <p className="muted">用户在 Mac、Linux 客户端或命令行登录即可添加设备。吊销只断开所选设备，其他电脑继续工作。</p>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>设备</th>
            <th>用户</th>
            <th>最近在线</th>
            <th>绑定时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((d) => (
            <tr key={d.id} className={d.revoked_at ? "dim" : ""}>
              <td>
                <span className="device">
                  <i className={d.online ? "dot on" : "dot"} />
                  {d.label} · {d.platform === 'linux' ? 'Linux' : d.platform === 'darwin' ? 'macOS' : d.platform === 'win32' ? 'Windows' : '未知平台'}
                </span>
              </td>
              <td>{d.username}</td>
              <td>{d.online ? "在线" : ago(d.last_seen_at)}</td>
              <td>{new Date(d.created_at).toLocaleString("zh-CN")}</td>
              <td className="actions">
                {d.revoked_at ? (
                  <span className="muted small">已吊销</span>
                ) : (
                  <button className="ghost danger" onClick={() => confirm(`吊销 ${d.label}？`) && api.revokeDevice(d.id).then(reload, (e) => alert(message(e)))}>
                    吊销
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

const SOURCES: Record<string, string> = { device: "电脑", cloud: "云端", memory: "记忆整理", test: "测试" };

function SearchUsagePanel() {
  const load = useCallback(() => api.searchUsage(), []);
  const { data, error, reload } = useLoad(load);
  useEffect(() => {
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);
  const number = (value: number | null) => value === null ? "—" : fmt(value);
  return (
    <section className="search-usage" aria-label="Tavily 搜索额度">
      <div className="toolbar">
        <div>
          <h2>Tavily 搜索额度</h2>
          <p className="muted small">账号与当前 Key 共用的可用额度，每次搜索消耗 1 credit。</p>
        </div>
        <button onClick={reload}>刷新额度</button>
      </div>
      {error && <p className="error" role="alert">无法刷新搜索额度：{error}</p>}
      {!data && !error && <p className="muted">正在获取搜索额度…</p>}
      {data?.status === "not_configured" && <p className="muted">尚未配置 Tavily Key。请在服务端环境变量 PI_BOT_TAVILY_API_KEY 中填写后重启服务。</p>}
      {data?.configured && <>
        <div className="stats">
          <div className="stat"><span className="muted">剩余可用 credits</span><strong className={data.status === "exhausted" ? "error" : ""}>{number(data.remaining)}</strong></div>
          <div className="stat"><span className="muted">本月账号已用</span><strong>{number(data.plan_used)}</strong></div>
          <div className="stat"><span className="muted">本月套餐上限</span><strong>{number(data.plan_limit)}</strong></div>
        </div>
        {data.status === "exhausted" && <p className="error" role="alert">搜索额度到了</p>}
        {data.status === "unavailable" && <p className="error" role="alert">{data.error}；额度恢复查询前暂停搜索。</p>}
        <p className="muted small">
          {data.plan && `套餐：${data.plan} · `}
          {data.key_used !== null && `当前 Key 已用：${fmt(data.key_used)} / ${data.key_limit === null ? "未单独设限" : fmt(data.key_limit)} · `}
          {data.checked_at ? `用量同步：${new Date(data.checked_at).toLocaleString("zh-CN", { hour12: false })}` : "尚未取得用量数据"}
        </p>
        <p className="muted small">每分钟同步额度，成功搜索后更新剩余数量。达到套餐或 Key 上限即停止，不使用按量付费额度。</p>
      </>}
    </section>
  );
}

function UsagePage() {
  const [days, setDays] = useState(7);
  const load = useCallback(() => api.usage(days), [days]);
  const { data, error } = useLoad<Usage>(load);
  const daily = new Map<string, number>();
  for (const r of data?.by_day ?? []) daily.set(r.day, (daily.get(r.day) ?? 0) + r.tokens);
  const max = Math.max(1, ...daily.values());
  const table = (rows: Usage["by_user"], label: string, key: "username" | "name") => (
    <table>
      <thead>
        <tr>
          <th>{label}</th>
          <th>调用</th>
          <th>输入 Token</th>
          <th>输出 Token</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r[key] ?? "（已删除）"}</td>
            <td>{fmt(r.calls)}</td>
            <td>{fmt(r.input_tokens)}</td>
            <td>{fmt(r.output_tokens)}</td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={4} className="muted">
              暂无数据
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
  return (
    <>
      <SearchUsagePanel />
      <div className="toolbar">
        <div className="segmented">
          {[1, 7, 30].map((d) => (
            <button key={d} className={d === days ? "active" : ""} onClick={() => setDays(d)}>
              {d === 1 ? "今天" : `${d} 天`}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <div className="chart">
            {[...daily.entries()].map(([day, tokens]) => (
              <div className="bar" key={day} title={`${day}：${fmt(tokens)} tokens`}>
                <i style={{ height: `${(tokens / max) * 100}%` }} />
                <span>{day.slice(5)}</span>
              </div>
            ))}
            {daily.size === 0 && <p className="muted">这段时间还没有模型调用。</p>}
          </div>
          <p className="muted small">
            来源：{Object.entries(SOURCES).map(([k, v]) => `${v} ${fmt((data.by_day ?? []).filter((r) => r.source === k).reduce((n, r) => n + r.tokens, 0))}`).join(" · ")}
          </p>
          <div className="split">
            <section>
              <h3>按用户</h3>
              {table(data.by_user, "用户", "username")}
            </section>
            <section>
              <h3>按模型</h3>
              {table(data.by_model, "模型", "name")}
            </section>
          </div>
        </>
      )}
    </>
  );
}

function App() {
  const [me, setMe] = useState<User | null>(null);
  const [checking, setChecking] = useState(!!session.token);
  const [page, setPage] = useState<Page>(() => (location.hash.slice(1) as Page) || "overview");
  useEffect(() => {
    if (!session.token) return;
    api.me().then(
      (r) => {
        if (r.user.role === "admin") setMe(r.user);
        else session.set(null);
      },
      () => session.set(null),
    ).finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    location.hash = page;
  }, [page]);
  if (checking) return null;
  if (!me) return <Login onDone={setMe} />;
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <PiBot avatar={{ shape: "blob", color: "orange", scheme: "dark" }} mood="idle" size={36} />
          <span>Pi Bot</span>
        </div>
        <nav>
          {PAGES.map((p) => (
            <button key={p.id} className={p.id === page ? "active" : ""} onClick={() => setPage(p.id)}>
              {p.label}
            </button>
          ))}
        </nav>
        <div className="me">
          <span>{me.display_name}</span>
          <button
            className="ghost small"
            onClick={() => {
              session.set(null);
              setMe(null);
            }}
          >
            退出
          </button>
        </div>
      </aside>
      <main>
        <h1>{PAGES.find((p) => p.id === page)!.label}</h1>
        {page === "overview" && <OverviewPage />}
        {page === "users" && <UsersPage me={me} />}
        {page === "models" && <ModelsPage />}
        {page === "devices" && <DevicesPage />}
        {page === "usage" && <UsagePage />}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
