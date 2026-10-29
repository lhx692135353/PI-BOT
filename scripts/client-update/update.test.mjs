import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identity } from './prepare.mjs';
import { makeManifest } from './manifest.mjs';
test('monotonic identity and bounded Windows version', () => {
  const a = identity('1', 'a'.repeat(40)), b = identity('2', 'b'.repeat(40));
  assert.ok(b.buildNumber > a.buildNumber); assert.equal(a.version, '0.3.1001');
  for (const n of ['0', '-1', '1.5', 'NaN', '64536']) assert.throws(() => identity(n, 'a'.repeat(40)));
  assert.throws(() => identity('1', 'short'));
});
test('manifest requires all complete platform packages and hashes exact bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-update-'));
  try {
    const info = identity('10', 'a'.repeat(40));
    assert.throws(() => makeManifest(info, dir));
    writeFileSync(join(dir, 'Pi-Bot-Android.apk'), 'abc'); writeFileSync(join(dir, 'Pi-Bot-Windows-x64-Setup.exe'), 'def');
    assert.throws(() => makeManifest(info, dir));
    writeFileSync(join(dir, 'pi-bot-desktop-linux-x64.tar.gz'), 'linux');
    const result = makeManifest(info, dir);
    assert.equal(result.platforms['linux-x64'].size, 5);
    assert.equal(result.platforms.android.size, 3);
    assert.equal(result.platforms.android.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.throws(() => makeManifest({ ...info, channel: 'stable' }, dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
