import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { LINUX_MARKER, EXTRACT_SCRIPT, linuxInstallRoot, prepareLinuxUpdate, checkLinuxDataPaths } from '../apps/desktop/src/linux-updater.js';
import { parseCandidate } from '../apps/desktop/src/update-policy.js';
import { ClientUpdater } from '../apps/desktop/src/client-updater.js';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const linux = { skip: process.platform !== 'linux' };
const require = createRequire(import.meta.url);
const { apply } = require('../apps/desktop/assets/linux-update-helper.cjs');
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'pi bot linux update '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const file = 'pi-bot-desktop-linux-x64.tar.gz';
const release = { draft: false, prerelease: true, tag_name: 'client-test-1002', assets: [
  { name: file, size: 3, browser_download_url: `https://github.com/lhx692135353/PI-BOT/releases/download/client-test-1002/${file}` },
  { name: 'update-manifest.json', browser_download_url: 'https://github.com/lhx692135353/PI-BOT/releases/download/client-test-1002/update-manifest.json' },
] };
const manifest = { schemaVersion: 1, channel: 'test', buildNumber: 1002, version: '0.3.1002', commit: 'b'.repeat(40),
  platforms: { 'linux-x64': { file, size: 3, sha256: createHash('sha256').update('abc').digest('hex') } } };
test('Linux selects only its exact desktop archive, verifies channel/build/asset', () => {
  assert.equal(parseCandidate(release, manifest, 'test', 1001, 'linux-x64')?.buildNumber, 1002);
  assert.equal(parseCandidate(release, manifest, 'test', 1002, 'linux-x64'), null);
  assert.throws(() => parseCandidate(release, manifest, 'test', 1001, 'windows-x64'));
  assert.throws(() => parseCandidate({ ...release, prerelease: false }, manifest, 'test', 1, 'linux-x64'));
  assert.throws(() => parseCandidate(release, { ...manifest, platforms: { 'linux-x64': { ...manifest.platforms['linux-x64'], file: 'service.tar.gz' } } }, 'test', 1, 'linux-x64'));
});
test('Linux downloads, revalidates before confirmed install and refuses corrupt bytes', linux, async t => {
  const dir = await fixture(t);
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async input => new Response(String(input).includes('api.github.com') ? JSON.stringify([release]) : String(input).endsWith('.json') ? JSON.stringify(manifest) : 'abc');
  let installs = 0;
  let path = '';
  const updater = new ClientUpdater(dir, '0.3.1001', 1001, 'linux-x64', async archive => { installs++; path = archive; });
  assert.equal((await updater.check('test')).phase, 'available');
  assert.equal((await updater.download()).phase, 'ready');
  assert.equal(await updater.install(async () => false), false); assert.equal(installs, 0);
  assert.equal(await updater.install(async () => true), true); assert.equal(installs, 1); assert.ok(path.endsWith('.tar.gz'));
  await writeFile(path, 'BAD');
  await assert.rejects(updater.install(async () => true), /SHA256/); assert.equal(installs, 1);
});
test('Linux rejects unsupported unmarked installs, missing Python/extraction failure never replaces old app', linux, async t => {
  const dir = await fixture(t); const root = join(dir, 'install'); await mkdir(root);
  await assert.rejects(linuxInstallRoot(join(root, 'Pi Bot')));
  await writeFile(join(root, '.pi-bot-linux-tar'), LINUX_MARKER);
  assert.equal(await linuxInstallRoot(join(root, 'Pi Bot')), root);
  await assert.rejects(prepareLinuxUpdate(join(dir, 'missing.tar.gz'), join(root, 'Pi Bot'), 'missing-helper', process.execPath, process.pid), /未替换旧版/);
  assert.equal(await readFile(join(root, '.pi-bot-linux-tar'), 'utf8'), LINUX_MARKER);
  assert.deepEqual(await readdir(dir), ['install']);
});
test('Linux extractor rejects traversal, absolute paths, devices, hardlinks and escaping/link ancestor symlinks', linux, async t => {
  const dir = await fixture(t);
  const make = String.raw`
import tarfile, io, sys
with tarfile.open(sys.argv[1], 'w:gz') as t:
    kind = sys.argv[2]
    m = tarfile.TarInfo('Pi Bot-linux-x64/file')
    if kind == 'traversal': m.name = 'Pi Bot-linux-x64/../../escaped'
    if kind == 'absolute': m.name = '/tmp/escaped'
    if kind == 'device': m.type = tarfile.CHRTYPE
    if kind == 'hardlink': m.type = tarfile.LNKTYPE; m.linkname = '/etc/passwd'
    if kind == 'escape': m.type = tarfile.SYMTYPE; m.linkname = '../../escaped'
    if kind == 'ancestor': m.type = tarfile.SYMTYPE; m.linkname = 'safe'
    t.addfile(m)
    if kind == 'ancestor': t.addfile(tarfile.TarInfo('Pi Bot-linux-x64/file/child'))
`;
  for (const kind of ['traversal', 'absolute', 'device', 'hardlink', 'escape', 'ancestor']) {
    const archive = join(dir, `${kind}.tar.gz`); const dest = join(dir, kind); await mkdir(dest);
    await exec('python3', ['-c', make, archive, kind]);
    await assert.rejects(exec('python3', ['-c', EXTRACT_SCRIPT, archive, dest]));
    assert.deepEqual(await readdir(dest), []);
  }
});
test('Linux extractor accepts safe relative symlinks and preserves executable mode', linux, async t => {
  const dir = await fixture(t); const src = join(dir, 'Pi Bot-linux-x64'); await mkdir(src);
  await writeFile(join(src, 'Pi Bot'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const archive = join(dir, 'bundle.tar.gz');
  await exec('ln', ['-s', 'Pi Bot', join(src, 'relative-link')]);
  await exec('tar', ['-czf', archive, '-C', dir, 'Pi Bot-linux-x64']);
  const dest = join(dir, 'extracted'); await mkdir(dest);
  await exec('python3', ['-c', EXTRACT_SCRIPT, archive, dest]);
  await access(join(dest, 'Pi Bot-linux-x64/relative-link'), 1);
});
async function deadPid() {
  const { pid } = await new Promise<{pid: number}>(resolve => {
    const child = execFile(process.execPath, ['-e', ''], () => resolve({ pid: child.pid! }));
  });
  return pid;
}
test('Linux helper swaps and restarts from paths with spaces; preserves old backup and external user data', linux, async t => {
  const dir = await fixture(t); const root = join(dir, 'Pi Bot install'); const staging = join(dir, 'staging');
  await mkdir(root); await mkdir(join(staging, 'Pi Bot-linux-x64'), { recursive: true });
  await writeFile(join(root, 'old-version'), 'old'); await writeFile(join(dir, 'user-data'), 'keep');
  await writeFile(join(staging, 'Pi Bot-linux-x64/Pi Bot'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await apply(root, staging, await deadPid());
  await access(join(root, 'Pi Bot'));
  const backup = (await readdir(dir)).find(p => p.startsWith('Pi Bot install.backup-'))!;
  assert.equal(await readFile(join(dir, backup, 'old-version'), 'utf8'), 'old');
  assert.equal(await readFile(join(dir, 'user-data'), 'utf8'), 'keep');
});
test('Linux helper restores old installation when new executable cannot launch', linux, async t => {
  const dir = await fixture(t); const root = join(dir, 'install'); const staging = join(dir, 'staging');
  await mkdir(root); await mkdir(join(staging, 'Pi Bot-linux-x64'), { recursive: true });
  await writeFile(join(root, 'Pi Bot'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(root, 'old-version'), 'old');
  await assert.rejects(apply(root, staging, await deadPid()));
  assert.equal(await readFile(join(root, 'old-version'), 'utf8'), 'old');
});

test('Linux staging hands off only after complete extraction, then replaces/restarts disposable bundle', linux, async t => {
  const dir = await fixture(t); const root = join(dir, 'old app'); const src = join(dir, 'source');
  const next = join(src, 'Pi Bot-linux-x64');
  await mkdir(root); await mkdir(join(next, 'resources/runtime/bin'), { recursive: true });
  await writeFile(join(root, '.pi-bot-linux-tar'), LINUX_MARKER);
  await writeFile(join(root, 'old-version'), 'old');
  await writeFile(join(next, '.pi-bot-linux-tar'), LINUX_MARKER);
  await writeFile(join(next, 'Pi Bot'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(next, 'resources/runtime/bin/node'), 'fixture');
  await writeFile(join(next, 'resources/app.asar'), 'fixture');
  const archive = join(dir, 'update.tar.gz'); await exec('tar', ['-czf', archive, '-C', src, 'Pi Bot-linux-x64']);
  const moduleURL = new URL('../apps/desktop/src/linux-updater.ts', import.meta.url).href;
  const helper = resolve('desktop/apps/desktop/assets/linux-update-helper.cjs');
  const code = `import {prepareLinuxUpdate} from ${JSON.stringify(moduleURL)}; await prepareLinuxUpdate(${JSON.stringify(archive)}, ${JSON.stringify(join(root, 'Pi Bot'))}, ${JSON.stringify(helper)}, process.execPath, process.pid);`;
  await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code]);
  let replaced = false;
  for (let i = 0; i < 100; i++) {
    try { await access(join(root, 'resources/app.asar')); replaced = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(replaced, 'detached helper replaced fixture after the parent exited');
  assert.ok((await readdir(dir)).some(p => p.startsWith('old app.backup-')));
});

test('Linux refuses data/library inside the installation tree', linux, async t => {
  const dir = await fixture(t); const root = join(dir, 'app'); await mkdir(root);
  await assert.rejects(checkLinuxDataPaths(root, [join(root, 'user-data')]), /迁移/);
  await assert.rejects(checkLinuxDataPaths(root, [root]), /迁移/);
  await checkLinuxDataPaths(root, [join(dir, 'separate-data')]);
});
