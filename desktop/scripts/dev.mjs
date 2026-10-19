import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import electron from 'electron';
const node = resolve('node_modules/node/bin/node');
if (!existsSync(node)) throw new Error('请先运行 npm install 安装项目 Node.js 24');
const env = { ...process.env, PI_BOT_SERVER_URL: process.env.PI_BOT_SERVER_URL || 'http://127.0.0.1:8000' };
const children = new Set(); let closing = false;
function run(binary, args, options = {}) { const child = spawn(binary, args, { stdio: 'inherit', env, detached: true, ...options }); children.add(child); child.on('exit', () => children.delete(child)); return child; }
const build = run(node, ['scripts/build.mjs']);
await new Promise((resolve, reject) => { build.on('exit', code => code === 0 ? resolve() : reject(new Error('构建失败'))); build.on('error', reject); });
const service = run(node, ['packages/service/dist/server.mjs']);
// The app is already built. Resolve Electron through Node so nested workspace
// installs work even when Forge cannot find their node_modules directory.
const electronEnv = { ...env };
delete electronEnv.ELECTRON_RUN_AS_NODE;
const ui = run(electron, [resolve('apps/desktop')], { cwd: resolve('apps/desktop'), env: electronEnv });
function signalGroup(child, signal) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
function stop() { if (closing) return; closing = true; const stopping = [...children]; for (const child of stopping) signalGroup(child, 'SIGTERM'); setTimeout(() => { for (const child of stopping) signalGroup(child, 'SIGKILL'); }, 8500).unref(); }
for (const child of [service, ui]) { child.on('error', stop); child.on('exit', stop); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
