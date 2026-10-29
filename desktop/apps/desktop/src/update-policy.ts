import type { UpdateChannel } from '../../../packages/protocol/src/index.js';

export const RELEASE_ROOT = 'https://github.com/lhx692135353/PI-BOT/releases/download/';
export interface Candidate { version: string; buildNumber: number; commit: string; tag: string; url: string; sha256: string; size: number }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('更新元数据格式无效');
  return value as Record<string, unknown>;
}
export function channel(value: unknown): UpdateChannel {
  if (value !== 'stable' && value !== 'test') throw new Error('更新通道无效');
  return value;
}
export function releaseMatches(value: unknown, selected: UpdateChannel): boolean {
  const r = object(value);
  return r.draft === false && typeof r.tag_name === 'string' && (selected === 'test'
    ? r.prerelease === true && /^client-test-[1-9]\d*$/.test(r.tag_name)
    : r.prerelease === false && /^client-stable-[1-9]\d*$/.test(r.tag_name));
}
export function assetURL(url: unknown, tag: unknown, file: string): string {
  if (typeof tag !== 'string' || !/^client-(test|stable)-[1-9]\d*$/.test(tag) ||
      typeof url !== 'string' || url !== `${RELEASE_ROOT}${tag}/${file}`) throw new Error('更新下载地址不受信任');
  return url;
}
export function manifestURL(value: unknown): string | null {
  const r = object(value);
  if (!Array.isArray(r.assets)) throw new Error('Release 缺少安装包清单');
  const matches = r.assets.map(object).filter(a => a.name === 'update-manifest.json');
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('更新清单重复');
  return assetURL(matches[0].browser_download_url, r.tag_name, 'update-manifest.json');
}
export type UpdatePlatform = 'windows-x64' | 'linux-x64';
export function parseCandidate(release: unknown, manifest: unknown, selected: UpdateChannel, currentBuild: number, platform: UpdatePlatform = 'windows-x64'): Candidate | null {
  if (!releaseMatches(release, selected)) throw new Error('更新通道不匹配');
  const r = object(release), m = object(manifest);
  if (m.schemaVersion !== 1 || m.channel !== selected || !Number.isSafeInteger(m.buildNumber) || (m.buildNumber as number) <= 0 ||
      m.version !== `0.3.${m.buildNumber}` || r.tag_name !== `client-${selected}-${m.buildNumber}` ||
      typeof m.commit !== 'string' || !/^[a-f0-9]{40}$/.test(m.commit)) throw new Error('更新版本元数据无效');
  if (m.minimumServerVersion != null) throw new Error('此更新有服务器版本要求，请先核实兼容性');
  const p = object(object(m.platforms)[platform]);
  const file = platform === 'linux-x64' ? 'pi-bot-desktop-linux-x64.tar.gz' : 'Pi-Bot-Windows-x64-Setup.exe';
  if (p.file !== file || typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256) ||
      !Number.isSafeInteger(p.size) || (p.size as number) <= 0 || (p.size as number) > 1024 * 1024 * 1024) throw new Error('更新包信息无效');
  if (!Array.isArray(r.assets)) throw new Error('更新包缺失');
  const assets = r.assets.map(object).filter(a => a.name === file);
  if (assets.length !== 1 || assets[0].size !== p.size) throw new Error('Release 安装包大小不匹配');
  const url = assetURL(assets[0].browser_download_url, r.tag_name, file);
  if ((m.buildNumber as number) <= currentBuild) return null;
  return { version: m.version as string, buildNumber: m.buildNumber as number, commit: m.commit,
    tag: r.tag_name as string, url, sha256: p.sha256, size: p.size as number };
}
export function hasActiveWork(status: unknown, bots: unknown): boolean {
  const s = object(status);
  if (!Array.isArray(s.activities)) throw new Error('无法确认本地任务状态，请稍后再安装');
  if (s.activities.length) return true;
  const b = object(bots);
  if (!Array.isArray(b.bots)) throw new Error('无法确认任务状态，请稍后再安装');
  return b.bots.map(object).some(bot => {
    const run = bot.latest_run ? object(bot.latest_run) : null;
    const activity = bot.activity ? object(bot.activity) : null;
    return (run && ['queued', 'running', 'waiting_approval'].includes(String(run.status))) ||
      (Array.isArray(bot.active_tasks) && bot.active_tasks.length > 0) ||
      (activity && (Number(activity.running_count) > 0 || Number(activity.queued_count) > 0 || ['queued','running','waiting_approval'].includes(String(activity.status))));
  });
}
