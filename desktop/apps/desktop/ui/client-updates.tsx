import { useEffect, useState } from 'react';
import type { ClientUpdateState, UpdateChannel } from '../../../packages/protocol/src/index.js';
import { bridge, errorText } from './bridge.js';

export function ClientUpdates() {
  const [state, setState] = useState<ClientUpdateState | null>(null);
  const [channel, setChannel] = useState<UpdateChannel>('stable');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void bridge.updates?.state().then(value => { setState(value); setChannel(value.channel); }).catch(e => setError(errorText(e))); }, []);
  async function run(action: () => Promise<ClientUpdateState | boolean>) {
    setBusy(true); setError('');
    try { const result = await action(); if (typeof result !== 'boolean') setState(result); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  if (!bridge.updates || state?.supported === false) return null;
  return <section>
    <h3>客户端更新</h3>
    <p className="muted small">当前 {state?.version ?? '…'} · 构建 {state?.buildNumber ?? 0}。测试版来自 main 成功构建，可能不稳定。</p>
    <label>更新通道 <select disabled={busy} value={channel} onChange={e => { setChannel(e.target.value as UpdateChannel); setState(s => s ? { ...s, phase: 'idle', candidate: undefined, message: '' } : s); }}>
      <option value="stable">稳定版</option><option value="test">测试版</option>
    </select></label>
    <button className="ghost" disabled={busy} onClick={() => void run(() => bridge.updates!.check(channel))}>检查更新</button>
    {state?.candidate && state.channel === channel && <button className="ghost" disabled={busy} onClick={() => void run(() => state.phase === 'ready' ? bridge.updates!.install() : bridge.updates!.download())}>{state.phase === 'ready' ? '安装更新' : '下载更新'}</button>}
    <p className="muted small">{busy ? '正在处理，请稍候…' : state?.message}</p>
    {error && <p className="error">{error}</p>}
  </section>;
}
