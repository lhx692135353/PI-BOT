import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { UpdateChannel, ClientUpdateState } from '../../../packages/protocol/src/index.js';
import { channel, releaseMatches, manifestURL, parseCandidate, type Candidate, type UpdatePlatform } from './update-policy.js';

// Redirects are restricted to GitHub's HTTPS release asset hosts; no credentials.
const hosts = new Set(['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
async function response(url: string, timeout = 30000): Promise<Response> {
  for (let i = 0; i < 6; i++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !hosts.has(parsed.hostname)) throw new Error('下载重定向地址不受信任');
    const result = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'Pi-Bot-Updater', Accept: 'application/vnd.github+json' } });
    if ([301,302,303,307,308].includes(result.status)) {
      const location = result.headers.get('location'); await result.body?.cancel();
      if (!location) throw new Error('更新下载重定向无效'); url = new URL(location, url).href; continue;
    }
    if (!result.ok) { await result.body?.cancel(); throw new Error(`GitHub 请求失败 ${result.status}（可能限流或网络不可用）`); }
    return result;
  }
  throw new Error('更新重定向过多');
}
async function json(url: string, maximum: number): Promise<unknown> {
  const result = await response(url); const reader = result.body?.getReader();
  if (!reader) throw new Error('更新元数据为空');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maximum) throw new Error('更新元数据过大'); chunks.push(value); }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function verifyPackage(path: string, candidate: Pick<Candidate, 'sha256' | 'size'>) {
  const info = await stat(path);
  if (!info.isFile() || info.size !== candidate.size) throw new Error('安装包大小校验失败');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== candidate.sha256) throw new Error('安装包 SHA256 校验失败，旧版不受影响');
}
export class ClientUpdater {
  private selected: Candidate | null = null;
  private readyFile: string | null = null;
  private busy = false;
  private stateValue: ClientUpdateState;
  constructor(private directory: string, version: string, private currentBuild: number, private platform: UpdatePlatform = 'windows-x64', private linuxInstall?: (archive: string) => Promise<void>) {
    this.stateValue = { channel: 'stable', phase: 'idle', version, buildNumber: currentBuild, message: '' };
  }
  async state(): Promise<ClientUpdateState> {
    if (!this.busy && this.stateValue.phase === 'idle') {
      try { this.stateValue.channel = channel(JSON.parse(await readFile(join(this.directory, 'preferences.json'), 'utf8')).channel); } catch { /* default stable */ }
    }
    return { ...this.stateValue };
  }
  async check(value: unknown): Promise<ClientUpdateState> {
    const selected = channel(value);
    if (this.busy) throw new Error('已有更新操作正在进行');
    this.busy = true; this.selected = null; this.readyFile = null;
    this.stateValue = { ...this.stateValue, channel: selected, phase: 'checking', candidate: undefined, message: '正在检查…' };
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temp = join(this.directory, `preferences-${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify({ channel: selected }), { mode: 0o600, flag: 'wx' });
      await rename(temp, join(this.directory, 'preferences.json'));
      let best: Candidate | null = null;
      for (let page = 1; page <= 5; page++) {
        const releases = await json(`https://api.github.com/repos/lhx692135353/PI-BOT/releases?per_page=100&page=${page}`, 8 * 1024 * 1024);
        if (!Array.isArray(releases)) throw new Error('Release 列表无效');
        for (const release of releases) {
          if (!releaseMatches(release, selected)) continue;
          const url = manifestURL(release); if (!url) continue;
          const candidate = parseCandidate(release, await json(url, 65536), selected, this.currentBuild, this.platform);
          if (candidate && candidate.buildNumber > (best?.buildNumber ?? 0)) best = candidate;
        }
        if (releases.length < 100) break;
        if (page === 5) throw new Error('发布记录过多，请在 GitHub 页面手动核实最新版本');
      }
      this.selected = best;
      this.stateValue = { ...this.stateValue, phase: best ? 'available' : 'idle',
        candidate: best ? { version: best.version, buildNumber: best.buildNumber, commit: best.commit, size: best.size } : undefined,
        message: best ? `可更新至 ${best.version} · ${best.commit.slice(0,7)}` : '当前通道暂无更高版本' };
    } catch (e) { this.failure(e); } finally { this.busy = false; }
    return this.state();
  }
  private failure(error: unknown) { this.stateValue = { ...this.stateValue, phase: 'error', message: error instanceof Error ? error.message : '更新失败，旧版不受影响' }; }
  async download(): Promise<ClientUpdateState> {
    if (this.busy) throw new Error('已有更新操作正在进行');
    const candidate = this.selected;
    if (!candidate) throw new Error('请先检查更新');
    this.busy = true; this.readyFile = null;
    this.stateValue = { ...this.stateValue, phase: 'downloading', message: '正在下载并校验…' };
    const partial = join(this.directory, `update-${randomUUID()}.part`), target = partial.replace(/\.part$/, this.platform === 'linux-x64' ? '.tar.gz' : '.exe');
    try {
      const result = await response(candidate.url, 10 * 60 * 1000); const reader = result.body?.getReader();
      if (!reader) throw new Error('下载内容为空');
      const handle = await open(partial, 'wx', 0o600); let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          total += value.length; if (total > candidate.size) throw new Error('下载大小不匹配');
          await handle.writeFile(value);
        }
      } finally { await handle.close(); await reader.cancel(); }
      await verifyPackage(partial, candidate); await rename(partial, target);
      this.readyFile = target;
      this.stateValue = { ...this.stateValue, phase: 'ready', message: this.platform === 'linux-x64' ? '安装包已校验，等待确认替换并重启（保留旧版备份）' : '安装包已校验，等待你确认安装（Windows 安装器未签名）' };
    } catch (e) { await rm(partial, { force: true }); await rm(target, { force: true }); this.failure(e); }
    finally { this.busy = false; }
    return this.state();
  }
  async install(confirmAndCheckActivity: () => Promise<boolean>): Promise<boolean> {
    if (this.busy || !this.selected || !this.readyFile) throw new Error('请先下载并校验更新');
    if (this.platform !== 'linux-x64' && process.platform !== 'win32') throw new Error('本安装器仅支持 Windows x64');
    this.busy = true;
    try {
      if (!await confirmAndCheckActivity()) return false;
      await verifyPackage(this.readyFile, this.selected);
      if (this.platform === 'linux-x64') {
        if (!this.linuxInstall) throw new Error('当前 Linux 安装格式不支持原位更新，请手动安装官方 tar.gz 桌面包');
        await this.linuxInstall(this.readyFile);
        this.stateValue.phase = 'launching'; this.stateValue.message = '更新已就绪，退出后替换并重启；保留旧版备份';
        return true;
      }
      // Fixed private path only: renderer never supplies paths, URLs or arguments.
      const child = spawn(this.readyFile, [], { detached: true, windowsHide: false, stdio: 'ignore' });
      await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
      child.unref(); this.stateValue.phase = 'launching'; this.stateValue.message = '已打开安装器，请按系统提示确认升级';
      return true;
    } catch (e) { this.failure(e); throw e; } finally { this.busy = false; }
  }
}
