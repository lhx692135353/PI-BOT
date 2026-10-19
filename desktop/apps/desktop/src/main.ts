import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } from 'electron';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dataDir, libraryRoot } from '../../../packages/service/src/paths.js';
import { libraryDir } from '../../../packages/service/src/library.js';
import { ServiceClient } from './service-client.js';
import { parseInput, type Method } from '../../../packages/protocol/src/index.js';

mkdirSync(join(dataDir, 'electron'), { recursive: true, mode: 0o700 });
app.setPath('userData', join(dataDir, 'electron'));
let window: BrowserWindow | null = null;
let serviceProcess: ChildProcess | undefined;
const page = pathToFileURL(join(__dirname, '../ui-dist/index.html')).href;
const iconPath = join(__dirname, '../assets/pi-bot.png');
const client = new ServiceClient(event => window?.webContents.send('agent:event', event));
function validSender(event: Electron.IpcMainInvokeEvent) { if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('不受信任的 IPC 来源'); }
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';
function computerName() {
  try {
    const name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim();
    if (name) return name.slice(0, 80);
  } catch { /* 取不到电脑名称时用主机名。 */ }
  return (hostname().replace(/\.local$/, '') || 'Mac').slice(0, 80);
}
function startBundledService() {
  if (!app.isPackaged || serviceProcess) return;
  const root = join(process.resourcesPath, 'runtime');
  serviceProcess = spawn(join(root, 'bin', 'node'), [join(root, 'server.mjs')], {
    cwd: root,
    detached: true,
    env: { ...process.env, PI_BOT_KEYCHAIN_HELPER: join(root, 'keychain') },
    stdio: 'ignore',
  });
  serviceProcess.unref();
  serviceProcess.on('error', () => {});
}
function present(target: BrowserWindow) {
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  app.focus({ steal: true });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setName('Pi Bot');
  if (process.platform === 'darwin') app.setActivationPolicy('regular');
  app.on('second-instance', () => { if (window) present(window); });
  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(iconPath));
    ipcMain.handle('agent:computerName', event => { validSender(event); return computerName(); });
    ipcMain.handle('agent:defaultServerUrl', event => { validSender(event); return process.env.PI_BOT_SERVER_URL || DEFAULT_SERVER_URL; });
    ipcMain.handle('agent:call', async (event, method: Method, input: unknown) => { validSender(event); return client.call(method, parseInput(method, input)); });
    ipcMain.handle('agent:openExternal', async (event, url: string) => { validSender(event); const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('不支持此链接'); await shell.openExternal(parsed.href); });
    ipcMain.handle('agent:openLibrary', async (event, slug: unknown) => {
      validSender(event);
      if (typeof slug !== 'string') throw new Error('资料库无效');
      const error = await shell.openPath(await libraryDir(libraryRoot, slug));
      if (error) throw new Error('无法在 Finder 中打开资料库');
    });
    const createWindow = () => {
      window = new BrowserWindow({ width: 1180, height: 820, minWidth: 900, minHeight: 600, show: false, icon: iconPath, title: 'Pi Bot', backgroundColor: '#f6f4f1', titleBarStyle: 'hiddenInset', webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.once('ready-to-show', () => { if (window) present(window); });
      window.on('closed', () => { window = null; });
      void window.loadURL(page);
    };
    createWindow(); client.start(); startBundledService();
    app.on('activate', () => { if (!window) createWindow(); else present(window); });
  }).catch(() => { dialog.showErrorBox('启动失败', '无法启动 Pi Bot，请查看开发终端'); app.quit(); });
  app.on('before-quit', () => { client.stop(); serviceProcess?.kill('SIGTERM'); });
  app.on('window-all-closed', () => { /* macOS keeps UI process alive until Cmd+Q */ });
}
