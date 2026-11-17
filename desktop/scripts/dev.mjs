import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import electron from 'electron';
const node = process.execPath;
if (!existsSync(node)) throw new Error('请先运行 npm install 安装项目 Node.js 24');
const env = { ...process.env, PI_BOT_SERVER_URL: process.env.PI_BOT_SERVER_URL || 'http://127.0.0.1:8000' };
if (process.platform === 'win32') env.PI_BOT_WINDOWS_HELPER = resolve('native/dist/pi-bot-windows.exe');
const children = new Set(); let closing = false;
function run(binary, args, options = {}) { const child = spawn(binary, args, { stdio: 'inherit', env, detached: process.platform !== 'win32', windowsHide: true, ...options }); children.add(child); child.on('exit', () => children.delete(child)); return child; }
const build = run(node, ['scripts/build.mjs']);
await new Promise((resolve, reject) => { build.on('exit', code => code === 0 ? resolve() : reject(new Error('构建失败'))); build.on('error', reject); });
const { dataDir, socketPath: socket, connectLocal } = await import('../packages/service/dist/paths.mjs');
const running = await new Promise(resolve => {
  let token; try { token=readFileSync(join(dataDir,'ipc-token'),'utf8'); } catch { resolve(false); return; }
  const s=connectLocal(socket); let buffer='';
  const finish=value=>{clearTimeout(timer);s.destroy();resolve(value);};
  const timer=setTimeout(()=>finish(false),800);
  s.on('connect',()=>s.write(JSON.stringify({token})+'\n'));
  s.on('data',data=>{buffer+=data;const i=buffer.indexOf('\n');if(i>=0){try{finish(JSON.parse(buffer.slice(0,i)).ready===true);}catch{finish(false);}}});
  s.on('error',()=>finish(false));
});
const service = running ? null : run(node, ['packages/service/dist/server.mjs'], {
  env: {
    ...env, PI_BOT_PARENT_LEASE: '1', PI_BOT_DESKTOP_EXECUTABLE: electron, PI_BOT_DESKTOP_ENTRY: resolve('apps/desktop'),
    PI_BOT_ELECTRON_TEST_SERVICE: resolve('packages/service/dist/server.mjs'), PI_BOT_ELECTRON_TEST_NODE: node,
  },
  stdio: ['pipe', 'inherit', 'inherit'],
});
service?.stdin.on('error', () => {});
// The app is already built. Resolve Electron through Node so nested workspace
// installs work even when Forge cannot find their node_modules directory.
const electronEnv = { ...env };
delete electronEnv.ELECTRON_RUN_AS_NODE;
const ui = run(electron, [resolve('apps/desktop')], { cwd: resolve('apps/desktop'), env: electronEnv });
function signalGroup(child, signal) { try {
  if (process.platform === 'win32') { if (child === service && signal === 'SIGTERM') child.stdin.end(); else child.kill(); }
  else process.kill(-child.pid, signal);
} catch (error) { if (error.code !== 'ESRCH') throw error; } }
function stop() { if (closing) return; closing = true; const stopping = [...children]; for (const child of stopping) signalGroup(child, 'SIGTERM'); setTimeout(() => { for (const child of stopping) signalGroup(child, 'SIGKILL'); }, 8500).unref(); }
for (const child of [service, ui].filter(Boolean)) { child.on('error', stop); child.on('exit', stop); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
