import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.CHAT_UI_DIR;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await wait(30); }
  throw new Error(label);
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { contextIsolation: false, nodeIntegration: false, offscreen: false, backgroundThrottling: false } });
  const logs = [];
  win.webContents.on('console-message', event => logs.push(event.message));
  const js = async source => { try { return await win.webContents.executeJavaScript(source); } catch (error) { throw new Error(`${source}: ${error}; ${logs.join(' | ')}`); } };
  const check = async (source, label) => { if (!await js(source)) throw new Error(label); };
  const screenshot = async name => { await wait(100); writeFileSync(join(dir, name), (await win.webContents.capturePage()).toPNG()); };
  try {
    await win.loadFile(join(dir, 'chat.html'));
    await until(() => js('!!window.__chatHarness && !!document.querySelector(".reply-segment")'), 'opening was not rendered before completion');
    await check('document.querySelectorAll(".reply-segment").length === 1 && !document.querySelector(".progress")', 'opening duplicated in legacy progress');
    await js('window.__chatHarness.finish()');
    await until(() => js('document.querySelectorAll(".reply-segment").length === 2 && !document.querySelector(".task-activity")'), 'finished task kept its activity or lost answer');
    await check('document.querySelectorAll(".msg.bot .bubble").length === 2', 'final answer echoed twice');
    await screenshot('chat-wide.png');
    await js('document.querySelector(".delegation").click()');
    await until(() => js('!!document.querySelector("dialog[open] .error")'), 'missing load failure state');
    await js('document.querySelector("dialog .error button").click()');
    await until(() => js('document.querySelectorAll("dialog article").length === 2'), 'retry failed');
    await js('[...document.querySelectorAll("dialog button")].find(b => b.textContent.includes("加载更多")).click()');
    await until(() => js('document.querySelectorAll("dialog article").length === 3'), 'pagination lost messages');
    await screenshot('conversation-wide.png');
    win.setSize(420, 820); await screenshot('conversation-narrow.png');
    await check('document.querySelector(".conversation-panel").getBoundingClientRect().width <= innerWidth', 'dialog overflows narrow viewport');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(() => js('!document.querySelector("dialog")'), 'Escape did not close details');
    await screenshot('chat-narrow.png');
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: true }));
    win.destroy(); app.exit(0);
  } catch (e) {
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: false, error: String(e.stack ?? e) }));
    win.destroy(); app.exit(1);
  }
});
