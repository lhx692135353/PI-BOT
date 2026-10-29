import { fail, type Row, type Tx } from './db.js';
import type { Hub } from './hub.js';

export const deviceOut = (d: Row, online: boolean) => ({
  id: d.device_id, user_id: d.user_id, label: d.label, platform: d.platform,
  created_at: d.created_at, last_seen_at: d.last_seen_at, revoked_at: d.revoked_at, online: !d.revoked_at && online,
});
export async function deviceList(tx: Tx, hub: Hub, userId: string) {
  return (await tx.rows('SELECT * FROM devices WHERE user_id=$1 ORDER BY created_at,device_id', [userId]))
    .map(d => deviceOut(d, !!hub.device(userId, d.device_id)));
}
export async function checkDevice(tx: Tx, userId: string, deviceId: string | null | undefined) {
  if (!deviceId) return;
  // A concurrent revoke must wait for this assignment/task transaction, so its
  // subsequent cleanup also sees work accepted just before the revoke.
  if (!await tx.one('SELECT 1 FROM devices WHERE device_id=$1 AND user_id=$2 AND revoked_at IS NULL FOR SHARE', [deviceId,userId]))
    fail(422, '请选择自己账号下未解绑的执行电脑');
}
