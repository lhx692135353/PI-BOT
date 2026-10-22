import { useEffect, useState } from 'react';
import { IMAGE_LIMIT_HINT, MAX_IMAGE_BYTES, imageSource, validImages, type ChatImage, type MessageImage } from '@pi-bot/agent/images';
import { call, errorText } from './bridge.js';

export async function readImages(files: File[], existing: ChatImage[]): Promise<ChatImage[]> {
  if (files.length + existing.length > 4) throw new Error(IMAGE_LIMIT_HINT);
  const images = await Promise.all(files.map(async file => {
    if (file.size > MAX_IMAGE_BYTES) throw new Error(IMAGE_LIMIT_HINT);
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.readAsDataURL(file);
    });
    return { name: file.name.slice(0, 255), mime_type: file.type, data };
  }));
  const combined = [...existing, ...images];
  if (!validImages(combined)) throw new Error(IMAGE_LIMIT_HINT);
  return combined;
}

export function MessagePicture({ botId, messageId, image, onLoad }: { botId: string; messageId: string; image: MessageImage; onLoad?(): void }) {
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let active = true;
    setError('');
    void call<ChatImage>('image', { botId, messageId, imageId: image.id }).then(value => { if (active) setSource(imageSource(value)); }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [botId, messageId, image.id, attempt]);
  useEffect(() => {
    if (!expanded) return;
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [expanded]);
  return <>
    {source ? <button className="message-picture" onClick={() => setExpanded(true)} title={`查看 ${image.name}`}><img src={source} alt={image.name} onLoad={onLoad} /></button>
      : <button className="ghost" onClick={() => setAttempt(n => n + 1)}>{error ? '图片加载失败，点击重试' : '图片加载中…'}</button>}
    {expanded && <div className="backdrop image-viewer" role="dialog" aria-modal="true" aria-label={image.name} onClick={() => setExpanded(false)}><button autoFocus aria-label="关闭图片">×</button><img src={source} alt={image.name} /></div>}
  </>;
}
