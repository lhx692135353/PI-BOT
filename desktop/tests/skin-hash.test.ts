import test from 'node:test';
import assert from 'node:assert/strict';

function fnv1a32(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const VECTORS: Array<[string, number, number]> = [
  ['00000000-0000-0000-0000-000000000001', 3175583038, 3175583038 % 12],
  ['hello', 0x4f9f2cab, 3],
  ['', 0x811c9dc5, 0x811c9dc5 % 12],
];

test('ironman armor FNV-1a 32-bit hash is deterministic and covers all 12 armors', () => {
  assert.equal(fnv1a32(''), 0x811c9dc5);
  assert.equal(fnv1a32('hello'), 0x4f9f2cab);
  assert.equal(fnv1a32('hello') % 12, 3);
  for (const [id, expectedHash, expectedIdx] of VECTORS) {
    assert.equal(fnv1a32(id), expectedHash);
    assert.equal(fnv1a32(id) % 12, expectedIdx);
  }
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    seen.add(fnv1a32(`bot-${i}`) % 12);
  }
  assert.equal(seen.size, 12);
});
