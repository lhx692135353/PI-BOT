import { useEffect, useState, type FormEvent } from 'react';
import { PiBot, AVATAR_COLORS, colorfulAvatar } from './bot-avatar.js';
import { avatarFor, SHAPES, spec, type Avatar } from '@pi-bot/bot-face';
import type { Bot, ModelOption } from '../../../packages/protocol/src/index.js';
import { bridge, call, errorText } from './bridge.js';

type Runtime = 'pi' | 'cursor' | 'codex';
interface CliProfileScan { cursor: { installed: boolean; profiles: { id: string; label: string }[] }; codex: { installed: boolean; profiles: { id: string; label: string }[] } }

export function BotEditor({ bot, models, deviceId, onClose, onSaved }: { bot?: Bot; models: ModelOption[]; deviceId?: string | null; onClose(): void; onSaved(bot: Bot): void }) {
  const [name, setName] = useState(bot?.name ?? '');
  const [persona, setPersona] = useState(bot?.persona ?? '');
  const [modelId, setModelId] = useState<string>(bot?.model_id ?? '');
  const [runtime, setRuntime] = useState<Runtime>(bot?.runtime ?? 'pi');
  const [profile, setProfile] = useState(bot?.cli_profile ?? '');
  const [directory, setDirectory] = useState(bot?.cli_directory ?? '');
  const [profiles, setProfiles] = useState<CliProfileScan | null>(null);
  const [avatar, setAvatar] = useState<Avatar>(() => colorfulAvatar(bot?.avatar ?? avatarFor(crypto.randomUUID())));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const cli = runtime === 'cursor' || runtime === 'codex';
  const choices = runtime === 'cursor' ? profiles?.cursor : runtime === 'codex' ? profiles?.codex : undefined;
  useEffect(() => {
    if (!cli) return;
    void call<CliProfileScan>('cliProfiles', {}).then(scan => {
      setProfiles(scan);
      const list = runtime === 'cursor' ? scan.cursor.profiles : scan.codex.profiles;
      setProfile(current => current || list[0]?.id || '');
    }).catch(err => setError(errorText(err)));
  }, [cli, runtime]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (cli && !choices?.installed) throw new Error(runtime === 'cursor' ? '未检测到 Cursor CLI（agent）' : '未检测到 Codex CLI（codex）');
      if (cli && (!profile || !directory)) throw new Error('请选择 profile 和目录');
      const body = { name, persona, model_id: modelId || null, avatar, ...(cli ? { runtime, cli_profile: profile, cli_directory: directory, cli_device_id: deviceId ?? undefined } : { runtime: 'pi' as const }) };
      onSaved(bot ? await call<Bot>('botUpdate', { id: bot.id, ...body }) : await call<Bot>('botCreate', body));
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  };
  return (
    <div className="backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <form className="modal editor" onSubmit={submit}>
        <div className="editor-preview">
          <PiBot avatar={avatar} mood={name ? 'happy' : 'idle'} size={168} followPointer />
          <strong>{name || '新 Bot'}</strong>
          <span className="muted small">{spec.shapes[avatar.shape].label} · {spec.colors[avatar.color].label}</span>
          <button type="button" className="ghost small" onClick={() => setAvatar(colorfulAvatar(avatarFor(crypto.randomUUID())))}>随机换一个</button>
        </div>
        <div className="editor-fields">
          <h2>{bot ? '编辑 Bot' : '新建 Bot'}</h2>
          <label>名字<input value={name} onChange={e => setName(e.target.value)} maxLength={40} placeholder="例如：研究助理" autoFocus /></label>
          <label>运行时
            <select value={runtime} disabled={!!bot} onChange={e => { setRuntime(e.target.value as Runtime); setProfile(''); setDirectory(bot?.cli_directory ?? ''); }}>
              <option value="pi">Pi</option>
              <option value="cursor">本机 Cursor</option>
              <option value="codex">本机 Codex</option>
            </select>
          </label>
          <label>人设与职责<textarea value={persona} onChange={e => setPersona(e.target.value)} rows={4} maxLength={8000} placeholder="它负责做什么、用什么风格说话、有哪些习惯……" /></label>
          {cli && <label>Profile
            <select value={profile} onChange={e => setProfile(e.target.value)}>
              {(choices?.profiles ?? []).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>}
          {cli && <label>目录
            <span className="row">
              <input value={directory} onChange={e => setDirectory(e.target.value)} placeholder="这个智能体工作的绝对路径" />
              <button type="button" className="ghost" onClick={() => { void bridge.pickDirectory?.().then(path => { if (path) setDirectory(path); }); }}>选择</button>
            </span>
          </label>}
          <label>{cli ? '路由模型' : '模型'}
            <select value={modelId} onChange={e => setModelId(e.target.value)}>
              <option value="">跟随默认{models.find(m => m.is_default) ? `（${models.find(m => m.is_default)!.name}）` : ''}</option>
              {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          {cli && <p className="muted small">写代码用的模型来自 CLI profile。这里的模型只在 JEV 不可用时判断该续哪一段会话。电脑不在线时不能改到云端运行。</p>}
          {cli && choices?.installed === false && <p className="error">未检测到 {runtime === "cursor" ? "Cursor CLI（agent）" : "Codex CLI（codex）"}。终端里能运行不够，从程序坞打开时要用登录 shell 的 PATH 才能找到命令，所以创建保持灰色。</p>}
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
              {AVATAR_COLORS.map(color => (
                <button type="button" key={color} title={spec.colors[color].label} className={color === avatar.color ? 'picked' : ''} style={{ background: `linear-gradient(160deg, ${spec.colors[color].light[0]}, ${spec.colors[color].light[1]})` }} onClick={() => setAvatar({ ...avatar, color })} />
              ))}
            </div>
          </div>
          {!bot && <p className="muted small">任务按需选择机器，文件保存在实际使用的机器上。</p>}
          {error && <p className="error">{error}</p>}
          <footer>
            <button type="button" className="ghost" onClick={onClose}>取消</button>
            <button className="primary" disabled={!name.trim() || saving || (cli && (!profiles || !profile || !directory || choices?.installed === false))}>{bot ? '保存' : '创建'}</button>
          </footer>
        </div>
      </form>
    </div>
  );
}
