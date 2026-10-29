import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assetURL, channel, releaseMatches, parseCandidate, manifestURL, hasActiveWork } from '../apps/desktop/src/update-policy.js';
import { ClientUpdater, verifyPackage } from '../apps/desktop/src/client-updater.js';
const root = 'https://github.com/lhx692135353/PI-BOT/releases/download/';
const file = 'Pi-Bot-Windows-x64-Setup.exe';
const release = { draft: false, prerelease: true, tag_name: 'client-test-1001', assets: [
  { name: file, size: 3, browser_download_url: `${root}client-test-1001/${file}` },
  { name: 'update-manifest.json', browser_download_url: `${root}client-test-1001/update-manifest.json` },
] };
const manifest = { schemaVersion: 1, channel: 'test', buildNumber: 1001, version: '0.3.1001', commit: 'a'.repeat(40), minimumServerVersion: null,
  platforms: { 'windows-x64': { file, size: 3, sha256: createHash('sha256').update('abc').digest('hex') } } };
test('update channels explicitly separate prereleases and stable', () => {
  assert.equal(channel('test'), 'test'); assert.throws(() => channel('dev'));
  assert.ok(releaseMatches(release, 'test')); assert.ok(!releaseMatches(release, 'stable'));
  assert.ok(!releaseMatches({ ...release, draft: true }, 'test'));
  assert.ok(!releaseMatches({ ...release, prerelease: false }, 'test'));
  assert.ok(releaseMatches({ ...release, prerelease: false, tag_name: 'client-stable-1001' }, 'stable'));
});
test('updates compare numeric build number, not hash', () => {
  assert.equal(parseCandidate(release, manifest, 'test', 1000)?.buildNumber, 1001);
  assert.equal(parseCandidate(release, manifest, 'test', 1001), null);
  assert.equal(parseCandidate(release, manifest, 'test', 9999), null);
});
test('repository URL, schema, channel, size and compatibility are checked', () => {
  assert.equal(manifestURL(release), `${root}client-test-1001/update-manifest.json`);
  for (const url of ['http://github.com/x', 'https://evil.test/x', `${root}client-test-1001/${file}?x=1`]) assert.throws(() => assetURL(url, release.tag_name, file));
  for (const m of [{ ...manifest, schemaVersion: 2 }, { ...manifest, channel: 'stable' }, { ...manifest, commit: 'short' }, { ...manifest, buildNumber: 1002 }, { ...manifest, minimumServerVersion: '99' }]) assert.throws(() => parseCandidate(release, m, 'test', 1));
  assert.throws(() => parseCandidate({ ...release, assets: [{ ...release.assets[0], size: 4 }] }, manifest, 'test', 1));
});
test('install defers local and server activities; unknown local status is unsafe', () => {
  assert.equal(hasActiveWork({ activities: [] }, { bots: [] }), false);
  assert.equal(hasActiveWork({ activities: [{}] }, { bots: [] }), true);
  assert.equal(hasActiveWork({ activities: [] }, { bots: [{ latest_run: { status: 'running' } }] }), true);
  assert.equal(hasActiveWork({ activities: [] }, { bots: [{ active_tasks: [{}] }] }), true);
  assert.throws(() => hasActiveWork({}, { bots: [] }));
});
test('package verification rejects corrupted bytes and wrong size', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-update-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'installer.exe'); writeFileSync(path, 'abc');
  const candidate = manifest.platforms['windows-x64'];
  await verifyPackage(path, candidate);
  writeFileSync(path, 'abd'); await assert.rejects(verifyPackage(path, candidate), /SHA256/);
  writeFileSync(path, 'abcd'); await assert.rejects(verifyPackage(path, candidate), /大小/);
});
test('updater checks public releases, persists channel and verifies downloaded bytes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-updater-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async input => {
    const url = String(input);
    return new Response(url.includes('api.github.com') ? JSON.stringify([release]) : url.endsWith('.json') ? JSON.stringify(manifest) : 'abc');
  };
  const updater = new ClientUpdater(dir, '0.3.0', 0);
  assert.equal((await updater.state()).channel, 'stable');
  assert.equal((await updater.check('test')).phase, 'available');
  assert.equal((await updater.download()).phase, 'ready');
  assert.equal((await new ClientUpdater(dir, '0.3.0', 0).state()).channel, 'test');
  assert.equal((await updater.check('stable')).candidate, undefined);
});
test('corrupt download and network failures leave update uninstalled', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-updater-fail-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async input => new Response(String(input).includes('api.github.com') ? JSON.stringify([release]) : String(input).endsWith('.json') ? JSON.stringify(manifest) : 'BAD');
  const updater = new ClientUpdater(dir, '0.3.0', 0);
  await updater.check('test'); assert.equal((await updater.download()).phase, 'error');
  globalThis.fetch = async () => { throw new Error('network unavailable'); };
  const state = await updater.check('test'); assert.equal(state.phase, 'error'); assert.match(state.message, /network/);
  await assert.rejects(updater.install(async () => true), /先下载/);
});

test('release pagination exhaustion is visible rather than false up-to-date', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-updater-pages-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(Array.from({ length: 100 }, () => ({ draft: true })))); };
  const state = await new ClientUpdater(dir, '0.3.0', 0).check('stable');
  assert.equal(calls, 5); assert.equal(state.phase, 'error'); assert.match(state.message, /发布记录过多/);
});
