import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.ACTIVITY_UI_DIR;
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  const logs = []; win.webContents.on('console-message', event => logs.push(event.message));
  try {
    await win.loadFile(join(dir, 'activity.html'));
    const start = Date.now(); let result;
    while (Date.now() - start < 35000) {
      result = await win.webContents.executeJavaScript('window.__activityResult ?? null');
      if (result) break;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    if (!result) result = { ok: false, error: 'activity UI timed out' };
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ ...result, logs }));
    win.destroy(); app.exit(result.ok ? 0 : 1);
  } catch (error) { writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: false, error: String(error), logs })); win.destroy(); app.exit(1); }
});
