import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.PAGING_UI_DIR;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await wait(30); }
  throw new Error(label);
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
  const logs = [];
  win.webContents.on('console-message', event => logs.push(event.message));
  const js = async source => { try { return await win.webContents.executeJavaScript(source); } catch (error) { throw new Error(`${source}: ${error}; ${logs.join(' | ')}`); } };
  const check = async (source, label) => { if (!await js(source)) throw new Error(`${label}: ${await js(`JSON.stringify(${state})`)}`); };
  const screenshot = async name => { await wait(150); writeFileSync(join(dir, name), (await win.webContents.capturePage()).toPNG()); };
  const state = `(() => { const t = document.querySelector('.timeline'); const first = document.querySelector('[data-message]'); return { count: document.querySelectorAll('[data-message]').length, gap: t.scrollHeight - t.scrollTop - t.clientHeight, top: t.scrollTop, first: first && first.dataset.message, jump: !!document.querySelector('.jump-bottom'), loading: !!document.querySelector('.load-more'), loads: window.__paging.loads }; })()`;
  const rectOf = id => `document.querySelector('[data-message="${id}"]').getBoundingClientRect().top`;
  try {
    await win.loadFile(join(dir, 'paging.html'));
    await until(() => js('document.querySelectorAll("[data-message]").length === 30'), 'first page missing');
    await wait(100);
    await check(`(${state}).gap < 2 && !(${state}).jump && window.__paging.loads === 0`, 'opening a timeline must show the newest message without paging');

    await js(`document.querySelector('.timeline').scrollTop = 1200; document.querySelector('.timeline').dispatchEvent(new Event('scroll'))`);
    await until(() => js(`!!document.querySelector('.jump-bottom')`), 'jump button missing after scrolling up');
    await check(`window.__paging.loads === 0`, 'paging started far from the top');

    await js(`document.querySelector('.timeline').scrollTop = 0; document.querySelector('.timeline').dispatchEvent(new Event('scroll'))`);
    await until(() => js(`window.__paging.loads === 1 && !!document.querySelector('.load-more')`), 'reaching the top did not load older messages');
    const before = await js(rectOf('m-91'));
    await screenshot('paging-loading.png');
    await js('window.__paging.release()');
    await until(() => js('document.querySelectorAll("[data-message]").length === 60'), 'older page not prepended');
    await wait(100);
    const after = await js(rectOf('m-91'));
    if (Math.abs(after - before) > 2) throw new Error(`reading position jumped by ${after - before}px`);
    await check(`window.__paging.loads === 1`, 'one scroll loaded more than one page');
    await screenshot('paging-older.png');

    await js(`document.querySelector('.jump-bottom').click()`);
    await until(() => js(`(${state}).gap < 2 && !document.querySelector('.jump-bottom')`), 'jump button did not return to the newest message');
    await screenshot('paging-bottom.png');
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: true }));
    win.destroy(); app.exit(0);
  } catch (e) {
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: false, error: String(e.stack ?? e) }));
    win.destroy(); app.exit(1);
  }
});
