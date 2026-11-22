import test from 'node:test';
import assert from 'node:assert/strict';
import { taskTools, TASK_TOOL_NAMES } from '../src/tasks.js';
import { toolDescriptor } from '@pi-bot/runtime-contracts';

test('device_status queries live state without creating a task and preserves authentication', async t => {
  const original = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ checked_at: '2026-11-22T00:00:00Z', devices: [{ online: true }] }), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  const tool = taskTools('https://example.test/', () => 'short-token', 'run-id').find(t => t.name === 'device_status')!;
  assert.ok(TASK_TOOL_NAMES.has(tool.name));
  assert.equal(toolDescriptor(tool.name)?.readonly, true);
  const result = await tool.execute('call', { device_id: 'device-id' }, undefined, () => {}, {} as never);
  assert.match(JSON.stringify(result), /checked_at/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://example.test/agent/devices?run_id=run-id&device_id=device-id');
  assert.equal(new Headers(requests[0].init?.headers).get('Authorization'), 'Bearer short-token');
  assert.equal(requests[0].init?.body, undefined);
  assert.equal(requests[0].init?.redirect, 'error');
});
