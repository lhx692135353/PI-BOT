import type { ChatImage } from '@pi-bot/agent/images';

export interface Draft { text: string; images: ChatImage[] }
const key = 'pi-bot.message-drafts.v1';
let current: Record<string,Draft> | undefined;
export function readDrafts(): Record<string,Draft> {
  if (current) return current;
  const restored: Record<string,Draft> = {};
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [id,value] of Object.entries(data)) {
        const draft = value as Partial<Draft> | null;
        if (draft && typeof draft.text === 'string' && Array.isArray(draft.images)) restored[id] = {text:draft.text,images:draft.images};
      }
    }
  } catch { /* Missing or damaged draft storage starts empty. */ }
  current = restored;
  return current;
}
export function stageDrafts(drafts: Record<string,Draft>) { current = drafts; }
/** Synchronous write completes before the installer IPC; quota errors stop installation. */
export function flushDrafts() {
  const drafts = readDrafts();
  localStorage.setItem(key,JSON.stringify(Object.fromEntries(Object.entries(drafts).filter(([,d]) => d.text || d.images.length))));
}
