import { errorInfo, httpErrorInfo } from "@pi-bot/runtime-contracts";
import { protectWindowsDirectory } from '../../../packages/service/src/windows.js';
import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, basename, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dataDir, libraryRoot } from '../../../packages/service/src/paths.js';
import { libraryDir } from '../../../packages/service/src/library.js';
import { ServiceClient, serviceRunning } from './service-client.js';
import { computerName } from '../../../packages/service/src/platform.js';
import { parseInput, type Method } from '../../../packages/protocol/src/index.js';

if (process.platform === 'win32') {
  if (app.isPackaged) process.env.PI_BOT_WINDOWS_HELPER = join(process.resourcesPath, 'runtime', 'pi-bot-windows.exe');
  if (!existsSync(process.env.PI_BOT_WINDOWS_HELPER || '')) { dialog.showErrorBox('安装不完整', '缺少 Windows 安全 helper，请重新安装完整测试包。'); app.exit(1); }
  protectWindowsDirectory(dataDir);
}
mkdirSync(join(dataDir, 'electron'), { recursive: true, mode: 0o700 });
app.setPath('userData', join(dataDir, 'electron'));
let window: BrowserWindow | null = null;
let serviceProcess: ChildProcess | undefined;
let quitting = false;
const page = pathToFileURL(join(__dirname, '../ui-dist/index.html')).href;
const iconPath = join(__dirname, '../assets/pi-bot.png');
const client = new ServiceClient(event => window?.webContents.send('agent:event', event));
function validSender(event: Electron.IpcMainInvokeEvent) { if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('不受信任的 IPC 来源'); }
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';
async function startBundledService() {
  if (!app.isPackaged || serviceProcess) return;
  if (await serviceRunning()) return;
  const root = join(process.resourcesPath, 'runtime');
  serviceProcess = spawn(join(root, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), [join(root, 'server.mjs')], {
    cwd: root,
    detached: false,
    windowsHide: true,
    env: { ...process.env, PI_BOT_PARENT_LEASE: '1', ...(process.platform === 'darwin' ? { PI_BOT_KEYCHAIN_HELPER: join(root, 'keychain') } : {}) },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  serviceProcess.stdin?.on('error', () => {});
  let diagnostic = '';
  serviceProcess.stderr?.on('data', b => { diagnostic = (diagnostic + b.toString()).slice(-2000); });
  serviceProcess.on('error', () => { dialog.showErrorBox('本地服务启动失败', '无法启动随包 Node 运行时，请检查安装是否完整。'); });
  serviceProcess.on('exit', code => {
    if (!quitting && code !== 0) dialog.showErrorBox('本地服务已停止', diagnostic || `服务退出码：${code}`);
  });
}
function present(target: BrowserWindow) {
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  app.focus({ steal: true });
}
const squirrelEvent = process.argv[1];
if (process.platform === 'win32' && ['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall', '--squirrel-obsolete'].includes(squirrelEvent)) {
  if (squirrelEvent === '--squirrel-obsolete') app.quit();
  else {
    const updater = spawn(join(dirname(process.execPath), '..', 'Update.exe'), [squirrelEvent === '--squirrel-uninstall' ? '--removeShortcut' : '--createShortcut', basename(process.execPath)], { windowsHide: true });
    updater.once('error', () => app.quit()); updater.once('exit', () => app.quit());
    setTimeout(() => app.quit(), 10000).unref();
  }
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setName('Pi Bot');
  if (process.platform === 'darwin') app.setActivationPolicy('regular');
  app.on('second-instance', () => { if (window) present(window); });
  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(iconPath));
    ipcMain.handle('agent:computerName', event => { validSender(event); return computerName(); });
    ipcMain.handle('agent:defaultServerUrl', event => { validSender(event); return process.env.PI_BOT_SERVER_URL || DEFAULT_SERVER_URL; });
    ipcMain.handle('agent:call', async (event, method: Method, input: unknown) => { validSender(event); try { return {__runtime_reply:2,ok:true,result:await client.call(method, parseInput(method,input))}; } catch(error) { return {__runtime_reply:2,ok:false,error_info:errorInfo(error)??httpErrorInfo(500,error instanceof Error?error.message:"操作失败","ipc")}; } });
    ipcMain.handle('agent:openExternal', async (event, url: string) => { validSender(event); const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('不支持此链接'); await shell.openExternal(parsed.href); });
    ipcMain.handle('agent:openLibrary', async (event, botId: unknown) => {
      validSender(event);
      if (typeof botId !== 'string') throw new Error('资料库无效');
      const {slug} = await client.call('openLibrary',{id:botId}) as {slug:string};
      const error = await shell.openPath(await libraryDir(libraryRoot, slug));
      if (error) throw new Error('无法在文件管理器中打开资料库');
    });
    const createWindow = () => {
      window = new BrowserWindow({ width: 1180, height: 820, minWidth: 900, minHeight: 600, show: false, icon: iconPath, title: 'Pi Bot', backgroundColor: '#f6f4f1', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.once('ready-to-show', () => { if (window) present(window); });
      window.on('closed', () => { window = null; });
      void window.loadURL(page);
    };
    createWindow(); client.start(); void startBundledService();
    app.on('activate', () => { if (!window) createWindow(); else present(window); });
  }).catch(() => { dialog.showErrorBox('启动失败', '无法启动 Pi Bot，请查看开发终端'); app.quit(); });
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true; client.stop();
    if (serviceProcess && serviceProcess.exitCode === null) {
      event.preventDefault();
      const deadline = setTimeout(() => { serviceProcess?.kill(); app.quit(); }, 10000);
      serviceProcess.once('exit', () => { clearTimeout(deadline); app.quit(); });
      serviceProcess.stdin?.end();
    }
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
