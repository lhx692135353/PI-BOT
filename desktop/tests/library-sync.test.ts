import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedSince, LibraryMirror, syncNote } from '../packages/service/src/library-sync.js';

test('generated library files get one cloud copy; outside-library and unchanged files are never uploaded', async t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pibot-sync-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'writer'), outside = join(base, 'project');
  mkdirSync(join(root, 'outputs'), { recursive: true }); mkdirSync(join(root, 'node_modules'), { recursive: true }); mkdirSync(outside);
  const since = Date.now() - 1000;
  writeFileSync(join(root, 'outputs', 'chart.png'), 'png');
  writeFileSync(join(root, 'node_modules', 'dep.js'), 'skip');
  writeFileSync(join(outside, 'main.py'), 'local only');
  const uploads: { path: string; content: string }[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    uploads.push({ path: body.path, content: Buffer.from(body.content_base64, 'base64').toString() });
    return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
  }) as typeof globalThis.fetch;
  const mirror = new LibraryMirror({ api: 'http://server', token: () => 'token', runId: 'run', root, fetch });

  const changed = await changedSince(root, since);
  assert.deepEqual(changed, [join(root, 'outputs', 'chart.png')], 'dependency folders are not library output');
  const result = await mirror.push([...changed, join(outside, 'main.py')]);
  assert.deepEqual(result.synced, ['outputs/chart.png']);
  assert.deepEqual(uploads, [{ path: 'outputs/chart.png', content: 'png' }]);
  assert.match(syncNote(result), /已同步到云端资料库：outputs\/chart\.png/);

  assert.deepEqual((await mirror.push(changed)).synced, [], 'an unchanged file is not sent twice');
  assert.equal(uploads.length, 1);
});

test('an account without a cloud computer stops syncing for the run instead of failing the tool', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pibot-sync-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.md'), 'a'); writeFileSync(join(root, 'b.md'), 'b');
  let calls = 0;
  const fetch = (async () => { calls++; return new Response(JSON.stringify({ detail: '云端操作未开启，请联系管理员' }), { status: 422 }); }) as unknown as typeof globalThis.fetch;
  const mirror = new LibraryMirror({ api: 'http://server', token: () => 'token', runId: 'run', root, fetch });
  const result = await mirror.push([join(root, 'a.md'), join(root, 'b.md')]);
  assert.equal(result.error, '云端操作未开启，请联系管理员');
  assert.equal(calls, 1);
  await mirror.push([join(root, 'a.md')]);
  assert.equal(calls, 1);
});
