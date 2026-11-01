import { withLibraryMutation } from "../packages/service/src/mutation-lock.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { preflightLibrary, libraryDir, libraryTools, OutsideError, previewList, previewRead, Sandbox } from '../packages/service/src/library.js';

function temp() {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-bot-lib-')));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
const call = async (tools: ReturnType<typeof libraryTools>, name: string, args: object, signal?: AbortSignal) => {
  const tool = tools.find(t => t.name === name)!;
  const r = await (tool.execute as any)('id', args, signal);
  return r.content[0].text as string;
};

test('library folders are created per slug and slugs are validated', async () => {
  const dir = temp();
  try {
    const lib = await libraryDir(join(dir.path, 'pi-bot'), 'research-bot');
    assert.equal(lib, join(dir.path, 'pi-bot', 'research-bot'));
    assert.ok(existsSync(lib));
    await assert.rejects(libraryDir(dir.path, '../etc'), /资料库名称无效/);
    await assert.rejects(libraryDir(dir.path, 'A'), /资料库名称无效/);
  } finally { dir.cleanup(); }
});

test('sandbox keeps file tools inside the library unless the user approves', async () => {
  const dir = temp();
  try {
    const root = await libraryDir(dir.path, 'bot');
    const outside = join(dir.path, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const sandbox = new Sandbox(root);
    assert.equal(await sandbox.resolve('notes/a.md'), join(root, 'notes/a.md'));
    await assert.rejects(sandbox.resolve('../outside/secret.txt'), OutsideError);
    await assert.rejects(sandbox.resolve(join(outside, 'secret.txt')), OutsideError);
    await assert.rejects(sandbox.resolve('link/secret.txt'), OutsideError, 'symlinks cannot escape');
    await assert.rejects(sandbox.resolve('link/new.txt'), OutsideError, 'nor create files through a symlink');
    await assert.rejects(sandbox.allow(parse(root).root), /不能授权整个磁盘/);
    await sandbox.allow(outside);
    assert.equal(await sandbox.resolve('link/secret.txt'), join(outside, 'secret.txt'));
  } finally { dir.cleanup(); }
});

test('file tools read, write, edit and search inside the library', async () => {
  const dir = temp();
  try {
    const root = await libraryDir(dir.path, 'bot');
    const tools = libraryTools(new Sandbox(root), { requestOutside: async () => false });
    assert.match(await call(tools, 'write_file', { path: 'notes/today.md', content: '# 今天\n买牛奶\n买面包\n' }), /已写入 notes\/today.md/);
    assert.equal(readFileSync(join(root, 'notes/today.md'), 'utf8'), '# 今天\n买牛奶\n买面包\n');
    assert.match(await call(tools, 'list_files', {}), /📁 notes\//);
    assert.match(await call(tools, 'read_file', { path: 'notes/today.md', offset: 2, limit: 1 }), /^买牛奶$/);
    await assert.rejects(call(tools, 'edit_file', { path: 'notes/today.md', old_text: '买', new_text: '卖' }), /出现了 2 次/);
    assert.match(await call(tools, 'edit_file', { path: 'notes/today.md', old_text: '买牛奶', new_text: '买豆浆' }), /1 处/);
    assert.match(await call(tools, 'search_files', { pattern: '豆浆', glob: '**/*.md' }), /notes\/today.md:2: 买豆浆/);
    assert.equal(await call(tools, 'search_files', { pattern: '豆浆', glob: '*.txt' }), '没有匹配');
    await assert.rejects(call(tools, 'read_file', { path: join(dir.path, 'outside.txt') }), OutsideError);
  } finally { dir.cleanup(); }
});

test('run_command runs in the library with a timeout and can be cancelled', async () => {
  const dir = temp();
  try {
    const root = await libraryDir(dir.path, 'bot');
    const tools = libraryTools(new Sandbox(root), { requestOutside: async () => false });
    const r = JSON.parse(await call(tools, 'run_command', { command: process.platform === 'win32' ? '[Console]::WriteLine((Get-Location).Path); [Console]::WriteLine($env:PI_BOT_LIBRARY); exit 3' : 'pwd && echo $PI_BOT_LIBRARY && exit 3' }));
    assert.equal(r.exit_code, 3);
    assert.equal(r.output.trim().split(/\r?\n/)[0], root);
    const slow = JSON.parse(await call(tools, 'run_command', { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 5' : 'sleep 5', timeout_seconds: 1 }));
    assert.equal(slow.timed_out, true);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(call(tools, 'run_command', { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 5' : 'sleep 5' }, controller.signal), /CANCELLED/);
  } finally { dir.cleanup(); }
});

test('request_outside_access asks the user and extends the sandbox only when approved', async () => {
  const dir = temp();
  try {
    const root = await libraryDir(dir.path, 'bot');
    const outside = join(dir.path, 'Desktop');
    mkdirSync(outside);
    writeFileSync(join(outside, 'todo.txt'), 'hi');
    const asked: string[] = [];
    let answer = false;
    const tools = libraryTools(new Sandbox(root), { requestOutside: async (path, reason) => { asked.push(`${path}|${reason}`); return answer; } });
    assert.match(await call(tools, 'request_outside_access', { path: outside, reason: '整理桌面' }), /用户拒绝/);
    await assert.rejects(call(tools, 'read_file', { path: join(outside, 'todo.txt') }), OutsideError);
    answer = true;
    assert.match(await call(tools, 'request_outside_access', { path: outside, reason: '整理桌面' }), /已批准/);
    assert.equal(await call(tools, 'read_file', { path: join(outside, 'todo.txt') }), 'hi');
    assert.match(await call(tools, 'request_outside_access', { path: join(outside, 'todo.txt'), reason: 'again' }), /无需申请/);
    assert.deepEqual(asked, [`${outside}|整理桌面`, `${outside}|整理桌面`]);
  } finally { dir.cleanup(); }
});

test('phone previews list and read only inside the library', async () => {
  const dir = temp();
  try {
    const root = await libraryDir(dir.path, 'bot');
    mkdirSync(join(root, 'img'));
    writeFileSync(join(root, 'readme.md'), '你好');
    writeFileSync(join(root, 'img', 'dot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    const list = await previewList(dir.path, 'bot', '');
    assert.deepEqual(list.entries.map(e => e.name), ['img', 'blob.bin', 'readme.md']);
    assert.deepEqual((await previewRead(dir.path, 'bot', 'readme.md')) as any, { ...(await previewRead(dir.path, 'bot', 'readme.md')), kind: 'text', content: '你好' });
    assert.equal((await previewRead(dir.path, 'bot', 'img/dot.png')).kind, 'image');
    assert.equal((await previewRead(dir.path, 'bot', 'blob.bin')).kind, 'binary');
    await assert.rejects(previewList(dir.path, 'bot', '..'), OutsideError);
    await assert.rejects(previewRead(dir.path, 'bot', join(dir.path, 'outside.txt')), OutsideError);
  } finally { dir.cleanup(); }
});

test('saved read permission is checked on every access and cannot authorize writes, commands or symlink escapes', async t => {
  const dir = temp(); t.after(() => dir.cleanup());
  const root = await libraryDir(dir.path,'bot'), outside = join(dir.path,'project'), sibling = join(dir.path,'other');
  mkdirSync(outside); mkdirSync(sibling);
  writeFileSync(join(outside,'readme.txt'),'project'); writeFileSync(join(sibling,'private.txt'),'private');
  symlinkSync(sibling,join(outside,'escape'),process.platform === 'win32' ? 'junction' : 'dir');
  let active = true, checks = 0;
  const sandbox = new Sandbox(root,[],async path => { checks++; return active && (path === outside || path.startsWith(outside + (process.platform === 'win32' ? '\\' : '/'))); });
  const tools = libraryTools(sandbox,{requestOutside:async()=> 'saved'});
  assert.equal(await call(tools,'read_file',{path:join(outside,'readme.txt')}),'project');
  await assert.rejects(call(tools,'write_file',{path:join(outside,'readme.txt'),content:'bad'}),OutsideError);
  await assert.rejects(call(tools,'edit_file',{path:join(outside,'readme.txt'),old_text:'project',new_text:'bad'}),OutsideError);
  await assert.rejects(sandbox.resolve(outside,{access:'execute'}),OutsideError);
  await assert.rejects(call(tools,'read_file',{path:join(outside,'escape','private.txt')}),OutsideError);
  active = false;
  await assert.rejects(call(tools,'read_file',{path:join(outside,'readme.txt')}),OutsideError,'revocation is not cached until task end');
  assert.ok(checks >= 3);
  active = true;
  assert.match(await call(tools,'request_outside_access',{path:outside,reason:'read project'}),/无需申请/);
  active = false;
  await assert.rejects(call(tools,'read_file',{path:join(outside,'readme.txt')}),OutsideError);
  assert.equal(readFileSync(join(outside,'readme.txt'),'utf8'),'project');
});

test('one-time outside read and write grants retain separate operation scopes', async t => {
  const dir = temp(); t.after(() => dir.cleanup());
  const root = await libraryDir(dir.path,'bot'), outside = join(dir.path,'project'); mkdirSync(outside);
  writeFileSync(join(outside,'a.txt'),'a');
  const requests: string[] = [];
  const tools = libraryTools(new Sandbox(root),{requestOutside:async (_p,_r,_s,access) => { requests.push(access!); return true; }});
  await call(tools,'request_outside_access',{path:outside,reason:'read'});
  assert.equal(await call(tools,'read_file',{path:join(outside,'a.txt')}),'a');
  await assert.rejects(call(tools,'write_file',{path:join(outside,'a.txt'),content:'b'}),OutsideError);
  await call(tools,'request_outside_access',{path:outside,reason:'write',access:'write'});
  await call(tools,'write_file',{path:join(outside,'a.txt'),content:'b'});
  assert.deepEqual(requests,['read','write']);
});

test('library mutations serialize across runs, abort queued waiters and release after failures', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const first = withLibraryMutation('shared-test-library', undefined, async () => { order.push('first'); started(); await gate; order.push('first done'); });
  const abort = new AbortController();
  const cancelled = withLibraryMutation('shared-test-library', abort.signal, async () => { throw new Error('cancelled work ran'); });
  const cancelledCheck = assert.rejects(cancelled, /CANCELLED/);
  abort.abort();
  const last = withLibraryMutation('shared-test-library', undefined, async () => { order.push('last'); });
  await running;
  assert.deepEqual(order, ['first']);
  release();
  await Promise.all([first, cancelledCheck, last]);
  assert.deepEqual(order, ['first', 'first done', 'last']);
  await assert.rejects(withLibraryMutation('shared-test-library', undefined, async () => { throw new Error('failed write'); }), /failed write/);
  assert.equal(await withLibraryMutation('shared-test-library', undefined, async () => 'still works'), 'still works');
});


test('task preflight only checks existing resources and never creates a library or traverses outside it',async()=>{
  const dir=temp();
  try {
    const root=join(dir.path,'libraries');
    assert.deepEqual(await preflightLibrary(root,'missing',['data.csv']),{available:false});
    assert.equal(existsSync(root),false);
    const library=await libraryDir(root,'bot');
    writeFileSync(join(library,'data.csv'),'real source');
    assert.deepEqual(await preflightLibrary(root,'bot',['data.csv']),{available:true});
    assert.deepEqual(await preflightLibrary(root,'bot',['missing.csv']),{available:false});
    assert.deepEqual(await preflightLibrary(root,'bot',['../outside.csv']),{available:false});
    const outside=join(dir.path,'outside');mkdirSync(outside);writeFileSync(join(outside,'secret'),'secret');
    symlinkSync(outside,join(library,'escape'),process.platform==='win32'?'junction':'dir');
    assert.deepEqual(await preflightLibrary(root,'bot',['escape/secret']),{available:false});
    assert.equal(readFileSync(join(library,'data.csv'),'utf8'),'real source');
  } finally {dir.cleanup();}
});
