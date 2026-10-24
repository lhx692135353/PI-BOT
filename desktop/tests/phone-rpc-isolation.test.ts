import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Application } from '../packages/service/src/application.js';

// No network, account files, real ADB or executor. Exercise only RPC completion routing.
for (const fails of [false, true]) test(`late phone RPC ${fails ? 'error' : 'frame'} cannot cross account/socket generation`, async () => {
 const app = new Application({ dataDir: '/unused', libraryRoot: '/unused', credentials: {} as any, emit() {} });
 const internal = app as any;
 const oldPackets: unknown[] = [], newPackets: unknown[] = [];
 let finish!: () => void;
 const pending = new Promise<void>(resolve => { finish = resolve; });
 internal.executor = {};
 internal.socket = { send: (m: unknown) => oldPackets.push(m) };
 internal.phone.close();
 internal.phone = { call: async () => { await pending; if (fails) throw new Error('old account'); return { data: 'old-frame' }; }, close() {} };
 const request = internal.onMessage({ type: 'rpc', id: 'old-id', method: 'phone.preview', params: {} }, 0);
 internal.connectionGeneration++;
 internal.socket = { send: (m: unknown) => newPackets.push(m) };
 finish(); await request;
 assert.deepEqual(oldPackets, []); assert.deepEqual(newPackets, []);
 await internal.onMessage({ type: 'rpc', id: 'stale', method: 'phone.preview' }, 0);
 assert.deepEqual(newPackets, []);
 await internal.onMessage({ type: 'rpc', id: 'current', method: 'phone.preview' }, 1);
 assert.equal(newPackets.length, 1);
 assert.equal((newPackets[0] as any).id, 'current');
});
