import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { type Database, type Row, type Tx } from '../src/db.js';
import { settings } from '../src/config.js';
import { Hub } from '../src/hub.js';
import { sockets } from '../src/sockets.js';
import { DEVICE_CONNECTION_REPLACED, DEVICE_OFFLINE, SERVER_RESTARTED, failDeviceRuns, failOrphanedDeviceRuns } from '../src/runs.js';
import { sha256 } from '../src/security.js';

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: Row[] = [];
  closeCode?: number;
  terminated = false;
  send(value: string) { this.frames.push(JSON.parse(value)); }
  close(code = 1000) {
    if (this.readyState !== 1) return;
    this.closeCode = code;
    this.readyState = 3;
    this.emit('close');
  }
  terminate() { this.terminated = true; this.close(); }
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  get pongs() { return this.frames.filter(frame => frame.type === 'pong').length; }
}

// Exercise the real signature verifier and socket handlers, replacing only IO.
// No database server, environment variables, migrations or network ports required.
async function harness(t: TestContext) {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const intervals: (() => void)[] = [];
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => {
    intervals.push(callback);
    return intervals.length as unknown as NodeJS.Timeout;
  });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const keys = generateKeyPairSync('ed25519');
  const owner = { user_id: randomUUID(), disabled: false };
  const device = { device_id: randomUUID(), user_id: owner.user_id, key_version: 4,
    public_key: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'), revoked_at: null as Date | null };
  const calls: { sql: string; args: unknown[] }[] = [];
  const runs: Row[] = [];
  const tasks: Row[] = [];
  let onOne: ((sql: string, args: unknown[]) => Promise<Row | undefined>) | undefined;
  let onRows: ((sql: string, args: unknown[]) => Promise<Row[] | undefined>) | undefined;
  const tx = {
    pushEnabled: false,
    async one(sql: string, args: unknown[] = []) {
      calls.push({ sql, args });
      if (onOne) {
        const result = await onOne(sql, args);
        if (result !== undefined) return result;
      }
      if (sql.startsWith('SELECT * FROM devices')) return device.revoked_at ? undefined : device;
      if (sql.startsWith('INSERT INTO device_nonces')) return { nonce: args[1] };
      if (sql.startsWith('UPDATE devices') || sql.startsWith('SELECT 1 FROM devices'))
        return !device.revoked_at && args[1] === device.key_version ? { device_id: device.device_id } : undefined;
      if (sql.startsWith('SELECT * FROM bot_runs')) return runs.find(run => run.run_id === args[0]);
      return undefined;
    },
    async rows(sql: string, args: unknown[] = []) {
      calls.push({ sql, args });
      if (onRows) {
        const result = await onRows(sql, args);
        if (result !== undefined) return result;
      }
      if (sql.startsWith('SELECT run_id FROM bot_runs')) return runs;
      if (sql.startsWith('UPDATE agent_tasks SET status=\'failed\'')) return tasks;
      if (sql.startsWith('UPDATE bot_runs SET status=$2')) {
        const run = runs.find(r => r.run_id === args[0]);
        if (run) { run.status = args[1]; run.error = args[2]; }
      }
      return [];
    },
    async get(table: string, id: string) {
      if (table === 'users') return owner;
      if (table === 'devices') return device;
      if (table === 'bot_runs') return runs.find(run => run.run_id === id);
      if (table === 'bot_messages') return { content: '', reply_segments: [] };
      return undefined;
    },
    async notify() {},
  };
  const listener = Object.assign(new EventEmitter(), { query: async () => {}, release() {} });
  const db = { tx: async <T>(fn: (tx: Tx) => Promise<T>) => fn(tx as unknown as Tx),
    pool: { connect: async () => listener }, close: async () => {} } as unknown as Database;
  const hub = new Hub();
  let handler!: (ws: WebSocket, req: { headers: Row }) => void;
  const app = { get(path: string, _options: unknown, route: typeof handler) { if (path === '/ws/device') handler = route; },
    addHook() {}, log: { error() {} } } as unknown as FastifyInstance;
  await sockets(app, db, settings({ PI_BOT_DATABASE_URL: 'postgres://unused/test', PI_BOT_JWT_SECRET: 'j'.repeat(40), PI_BOT_REMOTE_BACKEND: 'none' }), hub);
  const connections: Socket[] = [];
  t.after(async () => { for (const ws of connections) ws.close(); await flush(); });
  const open = (valid = true) => {
    const ws = new Socket();
    connections.push(ws);
    const timestamp = String(Math.floor(now / 1000)), nonce = randomUUID();
    const signature = sign(null, Buffer.from(`${timestamp}.${nonce}.GET./ws/device.${sha256(Buffer.alloc(0))}`), keys.privateKey).toString('base64');
    handler(ws as unknown as WebSocket, { headers: {
      'x-pibot-device-id': device.device_id, 'x-pibot-timestamp': timestamp,
      'x-pibot-nonce': nonce, 'x-pibot-signature': valid ? signature : Buffer.alloc(64).toString('base64'),
    } });
    return ws;
  };
  const addRun = (id: string, policy = 'cloud_allowed', status = 'running') => {
    const run = { run_id: id, executor: 'device', status, execution_policy: policy,
      user_id: owner.user_id, bot_id: 'bot', assistant_message_id: id, lane: 'chat', origin: 'user' };
    runs.push(run);
    return run as Row;
  };
  return { db, hub, device, owner, open, calls, runs, tasks, addRun, intervals,
    advance(ms: number) { now += ms; },
    setOne(fn: typeof onOne) { onOne = fn; }, setRows(fn: typeof onRows) { onRows = fn; } };
}

test('JSON heartbeat bypasses slow business work and prevents false idle termination', async t => {
  const h = await harness(t), ws = h.open();
  await flush();
  const slow = deferred();
  h.setRows(async sql => { if (sql.includes('SET next_wake_at')) { await slow.promise; return []; } });
  t.after(() => slow.resolve());
  ws.message({ type: 'capabilities', features: ['always-on-v1'] });
  await flush();
  h.advance(45000);
  ws.message({ type: 'ping' });
  await flush();
  assert.equal(ws.pongs, 1);
  h.advance(30000);
  h.intervals[0]();
  assert.equal(ws.terminated, false);
  ws.message({ type: 'ping' });
  await flush();
  assert.equal(ws.pongs, 2);
  slow.resolve();
  await flush();
});

test('pending and failed signed authentication never receive pong', async t => {
  const h = await harness(t), gate = deferred();
  h.setOne(async sql => { if (sql.startsWith('SELECT * FROM devices')) { await gate.promise; return h.device; } });
  t.after(() => gate.resolve());
  const pending = h.open();
  pending.message({ type: 'ping' });
  await flush();
  assert.equal(pending.pongs, 0);
  assert.equal(h.hub.count(), 0);
  gate.resolve();
  await flush();
  assert.equal(pending.pongs, 1);
  const invalid = h.open(false);
  invalid.message({ type: 'ping' });
  await flush();
  assert.equal(invalid.pongs, 0);
  assert.equal(invalid.closeCode, 4401);
});

test('replacement heartbeat waits for lifecycle cleanup and ignores the detached previous socket', async t => {
  const h = await harness(t), old = h.open();
  await flush();
  const gate = deferred();
  h.setRows(async sql => { if (sql.startsWith('SELECT run_id FROM bot_runs')) { await gate.promise; return []; } });
  t.after(() => gate.resolve());
  const replacement = h.open();
  replacement.message({ type: 'ping' });
  await flush();
  old.message({ type: 'ping' });
  await flush();
  assert.equal(old.pongs, 0);
  assert.equal(replacement.pongs, 0);
  assert.equal(h.hub.count(), 0);
  gate.resolve();
  await flush();
  // The old socket's queued close lifecycle may still suppress the early ping.
  // Once all lifecycle cleanup settles, fresh heartbeats must be acknowledged.
  assert.equal(h.hub.count(), 1);
  replacement.message({ type: 'ping' });
  await flush();
  assert.equal(replacement.pongs, 1);
});

test('heartbeat validation is single-flight while its database lane is slow', async t => {
  const h = await harness(t), ws = h.open();
  await flush();
  const gate = deferred();
  let validations = 0;
  h.setOne(async sql => {
    if (sql.includes('key_version=$2 AND revoked_at IS NULL RETURNING')) {
      validations++;
      await gate.promise;
      return { device_id: h.device.device_id };
    }
  });
  t.after(() => gate.resolve());
  for (let i = 0; i < 4; i++) {
    h.advance(31000);
    ws.message({ type: 'ping' });
    await flush();
    h.intervals[0]();
  }
  assert.equal(ws.pongs, 4);
  assert.equal(validations, 1);
  assert.equal(ws.terminated, false);
  gate.resolve();
  await flush();
});

test('close during awaited cleanup cannot attach a dead connection or send hello/pong', async t => {
  const h = await harness(t), gate = deferred();
  h.setRows(async sql => { if (sql.startsWith('SELECT run_id FROM bot_runs')) { await gate.promise; return []; } });
  t.after(() => gate.resolve());
  const ws = h.open();
  ws.message({ type: 'ping' });
  await flush();
  ws.close();
  gate.resolve();
  await flush();
  assert.equal(h.hub.count(), 0);
  assert.equal(ws.frames.length, 0);
});

test('attachment resets idle clock after a long handshake/cleanup', async t => {
  const h = await harness(t), gate = deferred();
  h.setRows(async sql => { if (sql.startsWith('SELECT run_id FROM bot_runs')) { await gate.promise; return []; } });
  t.after(() => gate.resolve());
  const ws = h.open();
  await flush();
  h.advance(90000);
  gate.resolve();
  await flush();
  h.intervals[0]();
  assert.equal(ws.terminated, false);
  h.advance(60001);
  h.intervals[0]();
  assert.equal(ws.terminated, true);
});

test('replacement cleanup uses replacement error; detached socket cannot pong or damage new work', async t => {
  const h = await harness(t), old = h.open();
  await flush();
  const interrupted = h.addRun('interrupted');
  const replacement = h.open();
  await flush();
  assert.equal(old.closeCode, 4409);
  assert.equal(interrupted.error, DEVICE_CONNECTION_REPLACED);
  assert.equal(replacement.frames.some(frame => frame.type === 'hello'), true);
  const fresh = h.addRun('fresh');
  old.message({ type: 'ping' });
  await flush();
  assert.equal(old.pongs, 0);
  assert.equal(fresh.status, 'running');
  replacement.close();
  await flush();
  assert.equal(fresh.error, DEVICE_OFFLINE);
});

test('periodic validation checks revocation and key version even without business messages', async t => {
  const h = await harness(t), ws = h.open();
  await flush();
  ws.message({ type: 'ping' });
  await flush();
  const validations = () => h.calls.filter(c => c.sql.includes('key_version=$2 AND revoked_at IS NULL RETURNING'));
  assert.equal(validations().length, 1);
  assert.equal(validations()[0].args[1], 4);
  ws.message({ type: 'ping' });
  await flush();
  assert.equal(validations().length, 1);
  h.device.key_version++;
  h.advance(30001);
  h.intervals[0]();
  await flush();
  assert.equal(ws.closeCode, 4401);
  assert.equal(h.hub.count(), 0);
  const pongs = ws.pongs;
  ws.message({ type: 'ping' });
  await flush();
  assert.equal(ws.pongs, pongs);
});

test('revocation kicks the authenticated socket and refuses subsequent heartbeat', async t => {
  const h = await harness(t), ws = h.open();
  await flush();
  h.device.revoked_at = new Date();
  h.intervals[0]();
  await flush();
  assert.equal(ws.closeCode, 4401);
  ws.message({ type: 'ping' });
  await flush();
  assert.equal(ws.pongs, 0);
});

test('stale heartbeat DB completion cannot kick an authenticated replacement', async t => {
  const h = await harness(t), old = h.open();
  await flush();
  const gate = deferred();
  h.setOne(async sql => {
    if (sql.includes('key_version=$2 AND revoked_at IS NULL RETURNING')) { await gate.promise; return undefined; }
  });
  t.after(() => gate.resolve());
  old.message({ type: 'ping' });
  await flush();
  h.setOne(undefined);
  const replacement = h.open();
  await flush();
  // Make the old validation finish as revoked, but restore the current key first.
  h.device.revoked_at = new Date();
  gate.resolve();
  await flush();
  h.device.revoked_at = null;
  assert.equal(replacement.readyState, 1);
  assert.equal(h.hub.device(h.owner.user_id, h.device.device_id)?.keyVersion, 4);
  replacement.message({ type: 'ping' });
  await flush();
  assert.equal(replacement.pongs, 1);
});

test('restart distinguishes ordinary runs/tasks, preserves queued automation and automation error', async t => {
  const h = await harness(t);
  const ordinary = h.addRun('ordinary');
  const queued = h.addRun('queued', 'device_only', 'queued');
  const automation = h.addRun('automation', 'device_only');
  h.tasks.push({ task_id: 'delegation', kind: 'delegation', user_id: h.owner.user_id, parent_bot_id: 'parent', target_bot_id: 'target' });
  await failOrphanedDeviceRuns(h.db);
  assert.equal(ordinary.error, SERVER_RESTARTED);
  assert.equal(automation.error, 'AUTOMATION_DEVICE_OFFLINE');
  assert.equal(queued.status, 'queued');
  assert.ok(h.calls.some(c => c.sql.includes("SET status='waiting_device'")));
  assert.ok(h.calls.some(c => c.sql.startsWith('UPDATE agent_tasks') && c.args[0] === SERVER_RESTARTED));
  assert.ok(h.calls.some(c => c.sql.startsWith('INSERT INTO agent_task_messages') && c.args[5] === SERVER_RESTARTED));
  assert.notEqual(SERVER_RESTARTED, DEVICE_CONNECTION_REPLACED);
});

test('replacement reason propagates to delegated tasks while queued device-only work stays queued', async t => {
  const h = await harness(t);
  const queued = h.addRun('queued', 'device_only', 'queued');
  h.tasks.push({ task_id: 'delegation', kind: 'delegation', user_id: h.owner.user_id, parent_bot_id: 'parent', target_bot_id: 'target' });
  await failDeviceRuns(h.db, h.device.device_id, DEVICE_CONNECTION_REPLACED);
  assert.equal(queued.status, 'queued');
  assert.ok(h.calls.some(c => c.sql.startsWith('UPDATE agent_tasks') && c.args[1] === DEVICE_CONNECTION_REPLACED));
  assert.ok(h.calls.some(c => c.sql.startsWith('INSERT INTO agent_task_messages') && c.args[5] === DEVICE_CONNECTION_REPLACED));
});
