import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceStatus } from '../src/devices.js';
import { Hub } from '../src/hub.js';
import type { Tx } from '../src/db.js';
import { routes, type Context } from '../src/routes.js';

const rows = [
  { device_id: 'mac', user_id: 'owner', label: 'MacBook Pro', platform: 'darwin', last_seen_at: '2000-01-01', revoked_at: null },
  { device_id: 'linux', user_id: 'owner', label: 'Linux', platform: 'linux', last_seen_at: new Date().toISOString(), revoked_at: null },
  { device_id: 'revoked', user_id: 'owner', revoked_at: '2026-01-01' },
];
const tx = { rows: async (_sql: string, params: unknown[]) => rows.filter(d => d.user_id === params[0]) } as unknown as Tx;

test('device status uses current account-scoped connections, not last seen or historical failures', async () => {
  const hub = new Hub();
  const conn = { deviceId: 'mac', userId: 'owner', capabilities: ['shell'], send() {}, close() {} };
  hub.attach(conn);
  hub.attach({ ...conn, deviceId: 'revoked' });
  const snapshot = await deviceStatus(tx, hub, 'owner');
  assert.ok(Number.isFinite(Date.parse(snapshot.checked_at)));
  assert.equal(snapshot.source, 'server_connection');
  assert.deepEqual(snapshot.devices.map(d => [d.id, d.online, d.connection_state]), [['mac', true, 'online'], ['linux', false, 'offline'], ['revoked', false, 'revoked']]);
  assert.deepEqual(snapshot.devices[0].capabilities, ['shell']);
  assert.deepEqual(snapshot.devices[2].capabilities, []);
  hub.detach(conn);
  assert.equal((await deviceStatus(tx, hub, 'owner', 'mac')).devices[0].online, false);
  assert.deepEqual((await deviceStatus(tx, hub, 'other')).devices, []);
  await assert.rejects(deviceStatus(tx, hub, 'other', 'mac'), /电脑不存在/);
});

test('agent device status requires a matching active bot run and rejects foreign devices', async () => {
  const route = routes.find(r => r.path === '/agent/devices')!;
  assert.equal(route.auth, 'llm');
  const active = { run_id: 'run', user_id: 'owner', bot_id: 'bot', executor: 'cloud', status: 'running' };
  const scopedTx = { ...tx, one: async () => active } as unknown as Tx;
  const context = { tx: scopedTx, hub: new Hub(), user: { user_id: 'owner' }, llm: { bot: 'bot', src: 'cloud' }, query: { run_id: 'run' } } as unknown as Context;
  const result = await route.handler(context) as Awaited<ReturnType<typeof deviceStatus>>;
  assert.equal(result.devices.length, 3);
  await assert.rejects(Promise.resolve().then(() => route.handler({ ...context, llm: { bot: 'foreign', src: 'cloud' } } as Context)), /当前运行不存在/);
  await assert.rejects(Promise.resolve().then(() => route.handler({ ...context, query: { run_id: 'run', device_id: 'foreign' } })), /电脑不存在/);
  active.status = 'completed';
  await assert.rejects(Promise.resolve().then(() => route.handler(context)), /当前运行不存在/);
});
