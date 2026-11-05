import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export const SYNC_FILE_LIMIT = 10 * 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.Trash', '.browser']);
const inside = (root: string, path: string) => path.startsWith(root + sep);

/** Library files created or changed since `since`; files outside the library are never candidates. */
export async function changedSince(root: string, since: number, limit = 100) {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (found.length >= limit) return;
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && ((await stat(path).catch(() => null))?.mtimeMs ?? 0) >= since) found.push(path);
    }
  };
  await walk(root);
  return found;
}

/**
 * Keeps one cloud copy of what the agent generates in the bot library. Local files the agent
 * merely processes outside the library stay on this computer.
 */
export class LibraryMirror {
  private sent = new Map<string, string>();
  private disabled?: string;
  constructor(private o: { api: string; token(): string; runId: string; root: string; fetch?: typeof fetch }) {}

  async push(files: string[]) {
    const synced: string[] = [], skipped: string[] = [];
    if (this.disabled) return { synced, skipped, error: undefined };
    let error: string | undefined;
    for (const file of [...new Set(files)]) {
      if (!inside(this.o.root, file)) continue;
      const rel = relative(this.o.root, file).split(sep).join('/');
      if (rel.split('/').some(part => SKIP.has(part))) continue;
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) continue;
      if (info.size > SYNC_FILE_LIMIT) { skipped.push(rel); continue; }
      const version = `${info.mtimeMs}:${info.size}`;
      if (this.sent.get(rel) === version) continue;
      try {
        const response = await (this.o.fetch ?? fetch)(`${this.o.api}/agent/library/files`, {
          method: 'POST', headers: { Authorization: `Bearer ${this.o.token()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ run_id: this.o.runId, path: rel, content_base64: (await readFile(file)).toString('base64') }),
          redirect: 'error', signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) {
          const detail = await response.json().then((d: { detail?: unknown }) => typeof d.detail === 'string' ? d.detail : '', () => '');
          // No cloud computer for this account (or an older server): stop trying for this run.
          if ([404, 422].includes(response.status)) { this.disabled = detail || '云端资料库不可用'; return { synced, skipped, error: this.disabled }; }
          throw new Error(detail || `HTTP ${response.status}`);
        }
        this.sent.set(rel, version);
        synced.push(rel);
      } catch (e) { error = e instanceof Error ? e.message : String(e); }
    }
    return { synced, skipped, error };
  }
}

export function syncNote(result: { synced: string[]; skipped: string[]; error?: string }) {
  const parts = [
    result.synced.length ? `已同步到云端资料库：${result.synced.slice(0, 10).join('、')}${result.synced.length > 10 ? ` 等 ${result.synced.length} 个文件` : ''}` : '',
    result.skipped.length ? `超过 10MiB 未同步：${result.skipped.slice(0, 5).join('、')}` : '',
    result.error ? `云端资料库同步失败：${result.error}` : '',
  ].filter(Boolean);
  return parts.length ? `（${parts.join('；')}）` : '';
}
