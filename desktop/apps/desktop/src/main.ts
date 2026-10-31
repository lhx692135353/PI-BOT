import { linuxInstallRoot, checkLinuxDataPaths, prepareLinuxUpdate } from './linux-updater.js';
import { ClientUpdater } from './client-updater.js';
import { hasActiveWork } from './update-policy.js';
import { errorInfo, httpErrorInfo } from "@pi-bot/runtime-contracts";
import { protectWindowsDirectory } from '../../../packages/service/src/windows.js';
import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, basename, dirname } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
declare const __PI_BOT_BUILD__: { version: string; buildNumber: number };
const identity = typeof __PI_BOT_BUILD__ === 'undefined' ? { version: app.getVersion(), buildNumber: 0 } : __PI_BOT_BUILD__;
const updater = new ClientUpdater(join(dataDir, 'updates'), identity.version, identity.buildNumber, process.platform === 'linux' ? 'linux-x64' : 'windows-x64',
  process.platform === 'linux' && app.isPackaged ? archive => prepareLinuxUpdate(archive, process.execPath, join(__dirname, '../assets/linux-update-helper.cjs'), join(process.resourcesPath, 'runtime/bin/node'), process.pid) : undefined);
const updatesSupported = process.arch === 'x64' && (process.platform === 'win32' || process.platform === 'linux');
async function ensureUpdatesSupported() {
  if (!updatesSupported) throw new Error('当前仅支持 Windows / Linux x64 在线更新');
  if (process.platform === 'linux') {
    if (!app.isPackaged) throw new Error('开发模式不执行在线更新，请安装官方 Linux tar.gz 桌面包');
    const root = await linuxInstallRoot(process.execPath);
    await checkLinuxDataPaths(root, [dataDir, libraryRoot]);
  }
}
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
    ipcMain.handle('updates:state', async event => { validSender(event); return { ...await updater.state(), supported: updatesSupported }; });
    ipcMain.handle('updates:check', async (event, channel: unknown) => { validSender(event); await ensureUpdatesSupported(); return updater.check(channel); });
    ipcMain.handle('updates:download', async event => { validSender(event); await ensureUpdatesSupported(); return updater.download(); });
    ipcMain.handle('updates:install', async event => {
      validSender(event); await ensureUpdatesSupported();
      const launched = await updater.install(async () => {
        const answer = await dialog.showMessageBox(window!, { type: 'question', buttons: ['稍后', '已结束活动，继续升级'], defaultId: 0, cancelId: 0,
          title: '确认客户端升级', message: '请先结束任务、通话和手机控制。',
          detail: process.platform === 'linux' ? '将校验并解压官方 tar.gz 桌面包，退出后替换并重启。保留本地设置、资料库和旧版目录备份。需要 python3 和安装目录写入权限；不自动提权。' : '安装器未签名，Windows 可能显示警告。升级会关闭客户端，保留本地设置和资料库。不会自动卸载旧版。' });
        if (answer.response !== 1) return false;
        const status = await client.call('status', {}) as { activities: unknown[]; connection: string };
        let bots: unknown = { bots: [] };
        try { bots = await client.call('bots', {}); } catch {
          // Local service is authoritative for tasks on this PC; no NAS dependency.
          const offline = await dialog.showMessageBox(window!, { type: 'warning', buttons: ['稍后', '确认所有活动均已结束'], defaultId: 0, cancelId: 0,
            message: '无法刷新服务器任务状态', detail: '本地任务仍会检查，但远端任务信息可能不完整。请自行确认已结束通话、任务和手机控制。' });
          if (offline.response !== 1) return false;
        }
        if (hasActiveWork(status, bots)) throw new Error('仍有活动任务，请结束后再安装；安装包已保留');
        await writeFile(join(dataDir,'electron','window-state.json'),JSON.stringify({width:window!.getBounds().width,height:window!.getBounds().height,maximized:window!.isMaximized()}),{mode:0o600});
        window!.webContents.session.flushStorageData();
        await window!.webContents.session.cookies.flushStore();
        return true;
      });
      if (launched) app.quit();
      return launched;
    });
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
      let saved = {width:1180,height:820,maximized:false};
      try {
        const value = JSON.parse(readFileSync(join(dataDir,'electron','window-state.json'),'utf8'));
        if (Number.isInteger(value.width) && value.width >= 900 && value.width <= 7680 && Number.isInteger(value.height) && value.height >= 600 && value.height <= 4320) saved = value;
      } catch { /* First launch uses defaults. */ }
      window = new BrowserWindow({ width: saved.width, height: saved.height, minWidth: 900, minHeight: 600, show: false, icon: iconPath, title: 'Pi Bot', backgroundColor: '#f6f4f1', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
      if (saved.maximized) window.maximize();
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
