import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { fail, type Row, type Tx } from './db.js';
import type { Hub } from './hub.js';
import type { Settings } from './config.js';

export const deviceOut = (d: Row, online: boolean) => ({
  id: d.device_id, user_id: d.user_id, label: d.label, platform: d.platform,
  created_at: d.created_at, last_seen_at: d.last_seen_at, revoked_at: d.revoked_at, online: !d.revoked_at && online,
});
export async function deviceList(tx: Tx, hub: Hub, userId: string) {
  return (await tx.rows('SELECT * FROM devices WHERE user_id=$1 ORDER BY created_at,device_id', [userId]))
    .map(d => deviceOut(d, !!hub.device(userId, d.device_id)));
}
export const CLOUD_COMPUTER_LABEL = '云端电脑';
/** The server-side machine every client shows as an always-available computer next to the user's own. */
export async function cloudComputer(tx: Tx, s: Settings, userId: string) {
  if (s.remoteBackend === 'none') return null;
  const env = await tx.one("SELECT * FROM remote_environments WHERE user_id=$1 AND status<>'retired'", [userId]);
  if (env && env.backend !== s.remoteBackend) return null;
  // The server host is prepared on demand, so it is usable before its first task.
  if (!env && s.remoteBackend !== 'local') return null;
  return {
    id: env?.environment_id ?? null, target: env ? 'remote:' + env.environment_id : null, label: CLOUD_COMPUTER_LABEL,
    platform: 'linux', backend: s.remoteBackend, online: s.remoteBackend === 'local' || env?.status === 'ready', status: env?.status ?? 'preparing',
  };
}
/** Same library path → same id on every machine, so a file mirrored to the cloud is listed once. */
export const libraryFileId = (botId: string, path: string) =>
  createHash('sha256').update(botId + '\0' + posix.normalize(path.replace(/\\/g, '/')).replace(/^(\.\/)+|\/+$/g, '')).digest('hex').slice(0, 32);
export async function checkDevice(tx: Tx, userId: string, deviceId: string | null | undefined) {
  if (!deviceId) return;
  // A concurrent revoke must wait for this assignment/task transaction, so its
  // subsequent cleanup also sees work accepted just before the revoke.
  if (!await tx.one('SELECT 1 FROM devices WHERE device_id=$1 AND user_id=$2 AND revoked_at IS NULL FOR SHARE', [deviceId,userId]))
    fail(422, '请选择自己账号下未解绑的执行电脑');
}
