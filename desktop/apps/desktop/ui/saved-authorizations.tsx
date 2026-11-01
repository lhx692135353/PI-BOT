import { useEffect, useState } from 'react';
import type { SavedAuthorization, AuthorizationLog } from '../../../packages/protocol/src/index.js';
import { call, errorText } from './bridge.js';

const actions: Record<string,string> = {grant:'保存授权',allow_once:'仅本次允许',reject:'拒绝',use:'使用授权',revoke:'撤销授权'};
export function SavedAuthorizations() {
  const [rules,setRules] = useState<SavedAuthorization[]>([]);
  const [logs,setLogs] = useState<AuthorizationLog[]>([]);
  const [error,setError] = useState('');
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState('');
  async function refresh() {
    setError(''); setLoading(true);
    try {
      const [rules,logs] = await Promise.all([call<SavedAuthorization[]>('authorizations'),call<AuthorizationLog[]>('authorizationLogs')]);
      setRules(rules); setLogs(logs);
    } catch(e) { setError(errorText(e)); } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); },[]);
  async function revoke(rule: SavedAuthorization) {
    if (!confirm(`撤销「${rule.target_label}」对 ${rule.resource} 的读取授权？后续访问将重新确认。`)) return;
    setBusy(rule.id);
    try { await call('authorizationRevoke',{id:rule.id}); await refresh(); }
    catch(e) { setError(errorText(e)); } finally { setBusy(''); }
  }
  return <section>
    <h3>已保存授权</h3>
    <p className="muted small">权限限当前账号、指定电脑和资源的读取；不包含写入、删除或执行命令。每次使用由服务器验证。</p>
    <button className="ghost small" disabled={loading || !!busy} onClick={() => void refresh()}>刷新授权</button>
    {loading ? <p role="status">正在加载授权…</p> : !error && !rules.length && <p className="muted small">暂无已保存授权。</p>}
    {rules.map(rule => <div key={rule.id} className="authorization-rule">
      <strong>{rule.target_label} · 读取</strong>
      <code>{rule.resource}{rule.resource_type === 'directory' ? '（含子路径）' : ''}</code>
      <span className="muted small">保存于 {new Date(rule.created_at).toLocaleString()}{rule.last_used_at ? ` · 最近使用 ${new Date(rule.last_used_at).toLocaleString()}` : ''}</span>
      <button className="ghost danger small" disabled={!!busy} onClick={() => void revoke(rule)}>撤销</button>
    </div>)}
    {error && <p className="error" role="alert">{error}</p>}
    <details><summary>授权及使用日志（最近 100 条）</summary>
      {logs.map(log => <p className="small" key={log.id}>{new Date(log.created_at).toLocaleString()} · {actions[log.action] ?? log.action} · {log.operation} · {log.target}<br /><code>{log.resource}</code></p>)}
    </details>
  </section>;
}
