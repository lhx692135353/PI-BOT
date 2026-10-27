import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, win32 } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { commandShell, defaultDataDir } from '../packages/service/src/platform.js';
import { libraryFolder, nativeWindows, powerShellArgs, protectWindowsDirectory, validateWindowsPath } from '../packages/service/src/windows.js';
import { FileCredentials } from '../packages/service/src/keychain.js';
import { libraryDir, runCommand, Sandbox, OutsideError } from '../packages/service/src/library.js';
import { ServiceClient } from '../apps/desktop/src/service-client.js';
import { createServer } from 'node:net';
import { windowsIpcPort } from '../packages/service/src/paths.js';

const windows = process.platform === 'win32';
const native = { skip: windows ? false : 'Requires Windows APIs and compiled MSVC helper' };
if (windows) process.env.PI_BOT_WINDOWS_HELPER ||= resolve('native/dist/pi-bot-windows.exe');
function temp(t: { after(fn: () => void): void }) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-bot-win-')));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('Windows directories use win32 semantics even on Linux', () => {
  assert.equal(defaultDataDir('win32', { LOCALAPPDATA: 'D:\\Users\\用户\\AppData\\Local' }, 'D:\\Users\\用户'), 'D:\\Users\\用户\\AppData\\Local\\Pi Bot');
  assert.equal(defaultDataDir('win32', {}, 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Local\\Pi Bot');
  assert.equal(defaultDataDir('win32', { LOCALAPPDATA: 'relative' }, 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Local\\Pi Bot');
  assert.throws(() => defaultDataDir('win32', { PI_BOT_DATA_DIR: 'relative' }), /绝对路径/);
});
test('Windows IPC supports an explicit valid port while retaining stable per-user discovery', () => {
  const port = windowsIpcPort('C:\\Users\\Test\\Pi Bot', 'test');
  assert.ok(port >= 20000 && port < 60000);
  assert.equal(windowsIpcPort('c:/users/test/pi bot', 'test'), port);
  assert.equal(windowsIpcPort('C:\\data', 'test', '12345'), 12345);
  for (const invalid of ['', '0', '-1', '65536', '1.5', 'NaN', '123abc', ' 123', '00123']) {
    assert.throws(() => windowsIpcPort('C:\\data', 'test', invalid), /PI_BOT_IPC_PORT/);
  }
});
test('Windows file policy rejects namespaces, alternate streams, drive-relative and reserved names', () => {
  for (const path of ['C:foo', 'C:', '\\foo', '/foo', '\\\\server\\share', '//server/share', '\\\\?\\C:\\a', 'C:\\a:stream', 'a\\NUL.txt', 'a\\COM1', 'a\\LPT¹.txt', 'a.', 'a ', 'a\\b.\\c', 'a\\b?c']) assert.throws(() => validateWindowsPath(path), Error, path);
  for (const path of ['C:\\data\\中文 空格.txt', 'notes/a.md', '..\\approved', '.', 'a\\con-file.txt']) assert.doesNotThrow(() => validateWindowsPath(path), path);
  for (const slug of ['con', 'nul', 'aux', 'prn', 'com1', 'lpt9']) assert.equal(libraryFolder(slug, 'win32'), `_bot_${slug}`);
  assert.equal(libraryFolder('console', 'win32'), 'console'); assert.equal(libraryFolder('con', 'linux'), 'con');
});
test('Windows file policy rejects mixed-separator UNC paths before filesystem access', () => {
  for (const prefix of ['\\\\', '//', '\\/', '/\\']) {
    for (const suffix of ['server/share/file.txt', 'server\\share\\file.txt']) {
      const path = prefix + suffix;
      assert.ok(win32.isAbsolute(path));
      assert.throws(() => validateWindowsPath(path), /UNC/, path);
    }
  }
});
test('PowerShell transport preserves quotes, newlines and Unicode without cmd interpolation', () => {
  const command = `Write-Output '中文 " x';\nWrite-Output \`\"$env:PI_BOT_LIBRARY\`\"`;
  const args = powerShellArgs(command);
  assert.deepEqual(args.slice(0, 6), ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command']);
  const payload = args[6].match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  assert.ok(payload);
  assert.ok(Buffer.from(payload, 'base64').toString('utf16le').includes(command));
  assert.ok(!args.includes('-ExecutionPolicy'));
  assert.throws(() => powerShellArgs('a'.repeat(20000)), /命令过长/);
});

test('DPAPI encrypts at rest, round-trips and fails closed on corrupted data', native, async t => {
  const dir = join(temp(t), 'private'); protectWindowsDirectory(dir);
  const file = join(dir, 'credentials.dpapi'); const creds = new FileCredentials(file);
  await creds.set('device', 'private-key-secret-中文');
  assert.ok(!readFileSync(file).includes(Buffer.from('private-key-secret')));
  assert.equal(await new FileCredentials(file).get('device'), 'private-key-secret-中文');
  const ciphertext = readFileSync(file); ciphertext.fill(42, 0, 16); writeFileSync(file, ciphertext);
  await assert.rejects(creds.get('device'));
  assert.throws(() => nativeWindows('decrypt', Buffer.from('not a DPAPI blob')));
});
test('Windows native ACL helper rejects UNC paths before inspecting their ancestors', native, () => {
  for (const prefix of ['\\\\', '//', '\\/', '/\\']) {
    for (const operation of ['protect-directory', 'protect-file'] as const) {
      assert.throws(() => nativeWindows(operation, prefix + 'server/share/private'), /Expected a local/);
    }
  }
});
test('Windows paths reject junction escapes, volume-root approval and preserve reserved bot slugs', native, async t => {
  const dir = temp(t), root = await libraryDir(dir, 'con');
  assert.equal(root, join(dir, '_bot_con'));
  const outside = join(dir, 'outside'); mkdirSync(outside);
  const { symlinkSync } = await import('node:fs'); symlinkSync(outside, join(root, 'link'), 'junction');
  const sandbox = new Sandbox(root);
  await assert.rejects(sandbox.resolve('link/new.txt'), OutsideError);
  await assert.rejects(sandbox.allow(win32.parse(root).root), /不能授权/);
  await assert.rejects(sandbox.resolve('NUL.txt'), /保留名/);
  await sandbox.allow(outside);
  assert.equal(await sandbox.resolve('link/new.txt'), join(outside, 'new.txt'));
});
test('PowerShell handles UTF-8, paths, exit codes and script exceptions', native, async t => {
  const cwd = join(temp(t), '中文 空格'); mkdirSync(cwd);
  const result = await runCommand(`Write-Output '中文 "引号"'; Write-Output $env:PI_BOT_LIBRARY; exit 7`, cwd, 10000);
  assert.equal(result.exit_code, 7); assert.match(result.output, /中文 "引号"/); assert.ok(result.output.includes(cwd));
  assert.equal((await runCommand("throw 'expected-error'", cwd, 10000)).exit_code, 1);
  assert.equal((await runCommand('Write-Output OK', cwd, 10000)).exit_code, 0);
});
test('PowerShell text transport preserves stdout/stderr and literal XML-like user output', native, async t => {
  const cwd = join(temp(t), '中文 空格'); mkdirSync(cwd);
  const shell = commandShell();
  const run = promisify(execFile);
  // Check the real redirected streams separately, before runCommand combines
  // them. No filtering may discard a user's literal CLIXML marker or escapes.
  const literal = '#< CLIXML\n<Objs>中文 & _x0041_</Objs>';
  const result = await run(shell, powerShellArgs(`
[Console]::WriteLine('#< CLIXML')
[Console]::WriteLine('<Objs>中文 & _x0041_</Objs>')
[Console]::Error.WriteLine('stderr 中文 & _x0041_')
`), { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.stdout.replaceAll('\r\n', '\n'), literal + '\n');
  assert.equal(result.stderr.replaceAll('\r\n', '\n'), 'stderr 中文 & _x0041_\n');
  const host = await run(shell, powerShellArgs("Write-Progress -Activity 'progress' -Status 'working' -PercentComplete 50; Write-Host 'host 中文'; Write-Warning 'warning 中文'; Write-Output 'done'"), { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.match(host.stdout + host.stderr, /host 中文/);
  assert.match(host.stdout + host.stderr, /warning 中文/);
  assert.match(host.stdout, /done/);
  assert.doesNotMatch(host.stdout + host.stderr, /#< CLIXML|<Objs/);
  const failed = await runCommand("[Console]::Error.WriteLine('stderr 中文'); throw 'expected-error 中文'", cwd, 10000);
  assert.equal(failed.exit_code, 1);
  assert.match(failed.output, /stderr 中文/);
  assert.match(failed.output, /expected-error 中文/);
  assert.doesNotMatch(failed.output, /#< CLIXML|<Objs/);
  const combined = await runCommand("[Console]::WriteLine('#< CLIXML'); [Console]::WriteLine('<Objs>中文 & _x0041_</Objs>'); exit 9", cwd, 10000);
  assert.equal(combined.exit_code, 9);
  assert.equal(combined.output.replaceAll('\r\n', '\n'), literal + '\n');
});
test('Windows Job Object kills descendants on timeout and explicit cancellation', native, async t => {
  const dir = temp(t); const marker = join(dir, 'leaked.txt');
  const childScript = `Start-Sleep -Seconds 4; [IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'leaked')`;
  const encoded = Buffer.from(childScript, 'utf16le').toString('base64');
  const command = `Start-Process -FilePath '${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; Start-Sleep -Seconds 20`;
  assert.equal((await runCommand(command, dir, 1800)).timed_out, true);
  await delay(4500); assert.equal(existsSync(marker), false, 'timeout leaked a descendant');
  const controller = new AbortController();
  const running = runCommand(command, dir, 20000, controller.signal); setTimeout(() => controller.abort(), 1800);
  await assert.rejects(running, /CANCELLED/); await delay(4500); assert.equal(existsSync(marker), false, 'cancel leaked a descendant');
});
test('Windows Job Object kills descendants when the owning Node process crashes', native, async t => {
  const dir = temp(t), marker = join(dir, 'orphan.txt');
  const script = `Start-Sleep -Seconds 5; [IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'leaked')`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const command = `Start-Process -FilePath '${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; Start-Sleep -Seconds 20`;
  const modulePath = new URL('../packages/service/src/library.ts', import.meta.url).href;
  const code = `const {runCommand} = await import(${JSON.stringify(modulePath)}); void runCommand(${JSON.stringify(command)}, ${JSON.stringify(dir)}, 20000); setTimeout(()=>process.exit(77),1800);`;
  const node = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => { node.once('error', reject); node.once('close', code => code === 77 ? resolve() : reject(new Error(`fixture exited ${code}`))); });
  await delay(6000); assert.equal(existsSync(marker), false, 'parent crash leaked a descendant');
});
test('Windows service authenticates IPC, refuses wrong token, and shuts down on parent EOF', native, async t => {
  const dir = temp(t); const dataDir = join(dir, 'private');
  // Let Windows choose a bindable port instead of hashing into an occupied or excluded range.
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
  const port = (reservation.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const env = { ...process.env, PI_BOT_DATA_DIR: dataDir, PI_BOT_LIBRARY_ROOT: join(dir, 'libraries'), PI_BOT_PARENT_LEASE: '1', PI_BOT_IPC_PORT: String(port) };
  const service = spawn(process.execPath, [resolve('packages/service/dist/server.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (service.exitCode === null) service.kill(); });
  service.stdin.on('error', () => {}); let stderr = ''; service.stderr.on('data', b => { stderr += b; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`service startup timed out: ${stderr}`)), 10000);
    service.stdout.on('data', b => { if (b.toString().includes('service ready')) { clearTimeout(timer); resolve(); } });
    service.once('error', reject); service.once('exit', code => { clearTimeout(timer); reject(new Error(`service exited ${code}: ${stderr}`)); });
  });
  // Derive the endpoint in a separate process using the same environment, so module caching cannot mask bugs.
  const { execFileSync } = await import('node:child_process');
  const endpoint = execFileSync(process.execPath, ['--input-type=module', '-e', `const {socketPath}=await import(${JSON.stringify(new URL('../packages/service/dist/paths.mjs', import.meta.url).href)}); process.stdout.write(socketPath);`], { env, windowsHide: true, encoding: 'utf8' });
  assert.equal(endpoint, `tcp:${port}`);
  const tokenPath = join(dataDir, 'ipc-token');
  const client = new ServiceClient(() => {}, { socketPath: endpoint, tokenPath }); client.start();
  t.after(() => client.stop());
  let status: unknown;
  for (let i = 0; i < 30; i++) { try { status = await client.call('status', {}); break; } catch { await delay(100); } }
  assert.ok(status);
  const { connectLocal } = await import('../packages/service/src/paths.js');
  const wrong = connectLocal(endpoint); let accepted = false;
  wrong.on('connect', () => wrong.write(JSON.stringify({token:'0'.repeat(64)}) + '\n'));
  wrong.on('data', () => { accepted = true; });
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { wrong.destroy(); reject(new Error('wrong token not rejected')); }, 3000); wrong.once('close', () => { clearTimeout(timer); resolve(); }); wrong.once('error', () => {}); });
  assert.equal(accepted, false); client.stop();
  const closed = new Promise<number | null>(resolve => service.once('exit', resolve)); service.stdin.end();
  assert.equal(await closed, 0);
});
