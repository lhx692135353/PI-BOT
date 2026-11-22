import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { fail, type Row, type Tx } from './db.js';
import type { Hub } from './hub.js';
import type { Settings } from './config.js';

export const deviceOut = (d: Row, online: boolean) => ({
  concurrency_limit: d.concurrency_limit,
  id: d.device_id, user_id: d.user_id, label: d.label, platform: d.platform,
  created_at: d.created_at, last_seen_at: d.last_seen_at, revoked_at: d.revoked_at, online: !d.revoked_at && online,
});
export async function deviceList(tx: Tx, hub: Hub, userId: string) {
  return (await tx.rows('SELECT * FROM devices WHERE user_id=$1 ORDER BY created_at,device_id', [userId]))
    .map(d => deviceOut(d, !!hub.device(userId, d.device_id)));
}
/** A server connection snapshot, not a command/resource probe or a last-seen inference. */
export async function deviceStatus(tx: Tx, hub: Hub, userId: string, deviceId?: string) {
  const rows = await tx.rows('SELECT * FROM devices WHERE user_id=$1 ORDER BY created_at,device_id', [userId]);
  const selected = deviceId ? rows.filter(d => d.device_id === deviceId) : rows;
  if (deviceId && !selected.length) fail(404, '电脑不存在或不属于当前账号');
  return {
    checked_at: new Date().toISOString(),
    source: 'server_connection',
    devices: selected.map(d => {
      const conn = d.revoked_at ? undefined : hub.device(userId, d.device_id);
      return { ...deviceOut(d, !!conn), target: `device:${d.device_id}`, capabilities: conn?.capabilities ?? [], connection_state: d.revoked_at ? 'revoked' : conn ? 'online' : 'offline' };
    }),
  };
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

/** Account lock serializes key/fingerprint decisions, including first registration. */
export async function registerDevice(tx: Tx, userId: string, input: { public_key: string; label: string; platform: string; hardware_fingerprint?: string }) {
  await tx.one('SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE', [userId]);
  const prior = await tx.one('SELECT * FROM devices WHERE user_id=$1 AND public_key=$2 AND revoked_at IS NULL', [userId,input.public_key]);
  const matches = !prior && input.hardware_fingerprint ? await tx.rows('SELECT * FROM devices WHERE user_id=$1 AND hardware_fingerprint=$2 AND revoked_at IS NULL FOR UPDATE', [userId,input.hardware_fingerprint]) : [];
  const recovered = !prior && matches.length === 1 ? matches[0] : undefined;
  const original = prior ?? recovered;
  const d = original ? await tx.update('devices',original.device_id, {
    label:input.label,platform:input.platform,hardware_fingerprint:input.hardware_fingerprint,
    public_key:input.public_key,key_version:recovered ? original.key_version + 1 : original.key_version,
  }) : await tx.insert('devices',{device_id:randomUUID(),user_id:userId,...input});
  if (recovered) await tx.insert('device_key_rotations', {
    rotation_id:randomUUID(),device_id:d.device_id,user_id:userId,key_version:d.key_version,
    old_key_hash:createHash('sha256').update(recovered!.public_key).digest('hex'),
    new_key_hash:createHash('sha256').update(input.public_key).digest('hex'),
  });
  return { device:d, rebound:!!recovered, notice:recovered ? `已识别为 ${recovered!.label}（重装后重新绑定）` : undefined };
}

export async function messageProvenance(tx: Tx, userId: string, client = 'unknown', deviceId?: string) {
  if (deviceId) {
    await checkDevice(tx,userId,deviceId);
    if (["android","ios","web"].includes(client)) return fail(422,"云端入口不能声明来源执行电脑");
    const d = await tx.get('devices',deviceId);
    return {client:'desktop',device_id:deviceId,device_label:d.label};
  }
  return {client:client === 'legacy' ? 'unknown' : client, entry:['ios','android'].includes(client) ? 'cloud' : undefined};
}
