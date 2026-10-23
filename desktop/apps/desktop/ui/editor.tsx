import { useState, type FormEvent } from 'react';
import { PiBot } from '@pi-bot/bot-face/react';
import { avatarFor, COLORS, SHAPES, spec, type Avatar } from '@pi-bot/bot-face';
import type { Bot, Device, ModelOption } from '../../../packages/protocol/src/index.js';
import { call, errorText } from './bridge.js';

export function BotEditor({ bot, models, devices = [], currentDeviceId, onClose, onSaved }: { bot?: Bot; models: ModelOption[]; devices?: Device[]; currentDeviceId?: string | null; onClose(): void; onSaved(bot: Bot): void }) {
  const [name, setName] = useState(bot?.name ?? '');
  const [persona, setPersona] = useState(bot?.persona ?? '');
  const [modelId, setModelId] = useState<string>(bot?.model_id ?? '');
  const [avatar, setAvatar] = useState<Avatar>(bot?.avatar ?? avatarFor(crypto.randomUUID()));
  const [deviceId,setDeviceId] = useState(bot ? bot.execution_device_id ?? '' : currentDeviceId ?? devices.find(d=>!d.revoked_at)?.id ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (bot && deviceId !== (bot.execution_device_id ?? '') && !confirm('更换执行电脑后使用目标电脑自己的资料库，不会复制文件；目标检查将暂停，需要重新确认后恢复。')) { setSaving(false); return; }
      const body = { name, persona, model_id: modelId || null, execution_device_id: deviceId || null, avatar };
      onSaved(bot ? await call<Bot>('botUpdate', { id: bot.id, ...body }) : await call<Bot>('botCreate', body));
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  };
  return (
    <div className="backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <form className="modal editor" onSubmit={submit}>
        <div className="editor-preview" data-scheme={avatar.scheme}>
          <PiBot avatar={avatar} mood={name ? 'happy' : 'idle'} size={168} followPointer />
          <strong>{name || '新 Bot'}</strong>
          <span className="muted small">{spec.shapes[avatar.shape].label} · {spec.colors[avatar.color].label}</span>
          <button type="button" className="ghost small" onClick={() => setAvatar({ ...avatarFor(crypto.randomUUID()), scheme: avatar.scheme })}>随机换一个</button>
        </div>
        <div className="editor-fields">
          <h2>{bot ? '编辑 Bot' : '新建 Bot'}</h2>
          <label>名字<input value={name} onChange={e => setName(e.target.value)} maxLength={40} placeholder="例如：研究助理" autoFocus /></label>
          <label>人设与职责<textarea value={persona} onChange={e => setPersona(e.target.value)} rows={4} maxLength={8000} placeholder="它负责做什么、用什么风格说话、有哪些习惯……" /></label>
          <label>模型
            <select value={modelId} onChange={e => setModelId(e.target.value)}>
              <option value="">跟随默认{models.find(m => m.is_default) ? `（${models.find(m => m.is_default)!.name}）` : ''}</option>
              {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label>执行电脑
            <select value={deviceId} onChange={e=>setDeviceId(e.target.value)}>
              <option value="">未绑定 · 仅云端聊天</option>
              {devices.filter(d=>!d.revoked_at || d.id===deviceId).map(d=><option key={d.id} value={d.id} disabled={!!d.revoked_at}>{d.label} · {d.platform === 'linux' ? 'Linux' : d.platform === 'darwin' ? 'macOS' : d.platform === 'win32' ? 'Windows' : '未知平台'} · {d.revoked_at ? '已解绑' : d.online ? '在线' : '离线'}</option>)}
            </select>
          </label>
          <p className="muted small">文件留在所选电脑；离线时本地任务等待，云端仍可聊天和搜索。</p>
          <div className="field">
            <span>造型</span>
            <div className="shapes">
              {SHAPES.map(shape => (
                <button type="button" key={shape} className={shape === avatar.shape ? 'picked' : ''} onClick={() => setAvatar({ ...avatar, shape })} title={spec.shapes[shape].label}>
                  <PiBot avatar={{ ...avatar, shape }} mood="idle" size={48} paused />
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>颜色</span>
            <div className="swatches">
              {COLORS.map(color => (
                <button type="button" key={color} title={spec.colors[color].label} className={color === avatar.color ? 'picked' : ''} style={{ background: `linear-gradient(160deg, ${spec.colors[color].light[0]}, ${spec.colors[color].light[1]})` }} onClick={() => setAvatar({ ...avatar, color })} />
              ))}
              <button type="button" className="scheme" onClick={() => setAvatar({ ...avatar, scheme: avatar.scheme === 'light' ? 'dark' : 'light' })}>{avatar.scheme === 'light' ? '浅色' : '深色'}</button>
            </div>
          </div>
          {!bot && <p className="muted small">资料库会建在 ~/pi-bot/ 下，以名字生成文件夹。改名不会移动文件夹。</p>}
          {error && <p className="error">{error}</p>}
          <footer>
            <button type="button" className="ghost" onClick={onClose}>取消</button>
            <button className="primary" disabled={!name.trim() || saving}>{bot ? '保存' : '创建'}</button>
          </footer>
        </div>
      </form>
    </div>
  );
}
