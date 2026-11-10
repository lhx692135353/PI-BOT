import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../packages/protocol/src/index.js';
import { mergeOlder, mergeTail } from '../apps/desktop/ui/timeline-cache.js';

const message = (seq: number, content = `m${seq}`): Message => ({
  id: `id-${seq}`, bot_id: 'bot', run_id: null, seq, role: seq % 2 ? 'user' : 'assistant', content, status: 'completed',
  executor: null, tools: [], created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z',
});
const seqs = (messages: Message[]) => messages.map(m => m.seq);

test('a fresh tail page is shown as is', () => {
  const page = mergeTail(undefined, { messages: [message(3), message(4)], has_more: true });
  assert.deepEqual(seqs(page.messages), [3, 4]);
  assert.equal(page.hasMore, true);
});

test('an overlapping tail keeps cached older history and its paging state', () => {
  const cached = { messages: [1, 2, 3, 4].map(n => message(n)), hasMore: true };
  const page = mergeTail(cached, { messages: [message(4, 'edited'), message(5)], has_more: true });
  assert.deepEqual(seqs(page.messages), [1, 2, 3, 4, 5]);
  assert.equal(page.messages[3].content, 'edited');
  assert.equal(page.hasMore, true);
});

test('a tail reaching past the cache decides whether more history exists', () => {
  const cached = { messages: [message(3), message(4)], hasMore: true };
  const page = mergeTail(cached, { messages: [message(1), message(2), message(3), message(4)], has_more: false });
  assert.deepEqual(seqs(page.messages), [1, 2, 3, 4]);
  assert.equal(page.hasMore, false);
});

test('a tail that cannot reach the cache replaces it instead of leaving a gap', () => {
  const cached = { messages: [message(1), message(2)], hasMore: false };
  const page = mergeTail(cached, { messages: [message(40), message(41)], has_more: true });
  assert.deepEqual(seqs(page.messages), [40, 41]);
  assert.equal(page.hasMore, true);
});

test('older pages prepend only onto the timeline they were requested for', () => {
  const current = { messages: [message(5), message(6)], hasMore: true };
  const older = { messages: [message(3), message(4)], has_more: false };
  const merged = mergeOlder(current, 'id-5', older);
  assert.deepEqual(seqs(merged!.messages), [3, 4, 5, 6]);
  assert.equal(merged!.hasMore, false);
  assert.equal(mergeOlder(current, 'id-1', older), current);
});
