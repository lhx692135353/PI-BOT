import { useEffect, useRef, useState } from 'react';
import type { ClientUpdateState, UpdateChannel } from '../../../packages/protocol/src/index.js';
import { bridge, errorText } from './bridge.js';

export function ClientUpdates() {
  const [state, setState] = useState<ClientUpdateState | null>(null);
  const [channel, setChannel] = useState<UpdateChannel>('stable');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const operation = useRef(0);
  useEffect(() => {
    let disposed = false;
    void bridge.updates?.state().then(value => { if (!disposed) { setState(value); setChannel(value.channel); } }).catch(e => { if (!disposed) setError(errorText(e)); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if ((!busy && !['checking','downloading'].includes(state?.phase ?? '')) || !bridge.updates) return;
    let disposed = false;
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      const generation = operation.current;
      void bridge.updates!.state().then(value => { if (!disposed && generation === operation.current) setState(value); })
        .catch(e => { if (!disposed) setError(errorText(e)); }).finally(() => { polling = false; });
    }, 250);
    return () => { disposed = true; clearInterval(timer); };
  }, [busy, state?.phase]);
  async function run(action: () => Promise<ClientUpdateState | boolean>, phase?: 'checking' | 'downloading') {
    operation.current++;
    setBusy(true); setError('');
    if (phase) setState(s => s ? {...s,phase,message:phase === 'checking' ? '正在检查更新…' : '正在下载安装包…'} : s);
    try { const result = await action(); const value = typeof result !== 'boolean' ? result : await bridge.updates!.state(); setState(result === false ? {...value,message:'已取消安装，已校验的安装包保留，可稍后继续。'} : value); }
    catch (e) { const message = errorText(e); setError(message); setState(s => s ? {...s,phase:'error',message} : s); }
    finally { operation.current++; setBusy(false); }
  }
  if (!bridge.updates || state?.supported === false) return <section>
    <h3>客户端更新</h3>
    <p className="muted small">当前平台尚无自动安装通道，请在官方发布页检查并下载适用的安装包。覆盖安装可保留配置和资料。</p>
    <button className="ghost" onClick={() => void bridge.openExternal('https://github.com/lhx692135353/PI-BOT/releases').catch(e => setError(errorText(e)))}>检查更新（官方发布页）</button>
    {error && <p className="error">{error}</p>}
  </section>;
  const working = busy || ['checking','downloading','launching'].includes(state?.phase ?? '');
  const ready = state?.packageReady || state?.phase === 'ready';
  return <section>
    <h3>客户端更新</h3>
    <p className="muted small">当前 {state?.version ?? '…'} · 构建 {state?.buildNumber ?? 0}。测试版来自 main 成功构建，可能不稳定。</p>
    {state?.lastInstall && <p className={state.lastInstall.verified ? 'muted small' : 'error small'}>{state.lastInstall.verified ? `已核实升级后版本：${state.version}（构建 ${state.buildNumber}）` : `上次升级尚未确认完成，目标 ${state.lastInstall.toVersion}，当前仍为 ${state.version}。`}</p>}
    <label>更新通道 <select disabled={working} value={channel} onChange={e => { setChannel(e.target.value as UpdateChannel); setState(s => s ? { ...s, phase: 'idle', candidate: undefined, message: '' } : s); }}>
      <option value="stable">稳定版</option><option value="test">测试版</option>
    </select></label>
    <button className="ghost" disabled={working} onClick={() => void run(() => bridge.updates!.check(channel),'checking')}>检查更新</button>
    {state?.candidate && state.channel === channel && <button className="ghost" disabled={working} onClick={() => void run(() => ready ? bridge.updates!.install() : bridge.updates!.download(),ready ? undefined : 'downloading')}>{ready ? '安装更新' : '下载更新'}</button>}
    <p className={state?.phase === 'error' ? 'error' : 'muted small'} role="status" aria-live="polite">{state?.message || (busy ? '正在检查更新…' : '点击检查更新获取当前通道的最新版本。')}</p>
    {state?.phase === 'downloading' && <div><progress aria-label="安装包下载进度" value={state.downloadedBytes ?? 0} max={state.totalBytes ?? 1} /><span className="small"> {((state.downloadedBytes ?? 0) / 1048576).toFixed(1)} / {((state.totalBytes ?? 0) / 1048576).toFixed(1)} MB</span></div>}
    {error && <p className="error">{error}</p>}
  </section>;
}
