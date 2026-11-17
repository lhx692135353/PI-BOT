import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.env.BOT_EDITOR_DIR;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  async function until(code) {
    for (let i = 0; i < 100; i++) {
      if (await js(code)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Timed out: ${code}`);
  }
  async function submit(expected = 1) {
    await js(`document.querySelector('form').requestSubmit()`);
    await until(`window.__editorHarness.saved.length === ${expected}`);
    return js(`window.__editorHarness.history.findLast(x => x.method === 'botCreate' || x.method === 'botUpdate')`);
  }
  try {
    await win.loadFile(join(directory, 'editor.html'));
    for (const noModels of [false, true]) {
      await js(`window.__editorHarness.render(undefined, ${noModels})`);
      await until(`document.querySelector('h2')?.textContent === '新建 Bot' && !document.querySelector('input[maxlength="40"]').value`);
      assert.deepEqual(await js(`[...document.querySelectorAll('select option')].map(o => o.value)`), ['pi']);
      assert.equal(await js(`document.body.textContent.includes('模型')`), false);
      await js(`(() => { const input = document.querySelector('input[maxlength="40"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'New bot'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await until(`!document.querySelector('button.primary').disabled`);
      const created = await submit();
      assert.equal(created.method, 'botCreate');
      assert.equal(created.input.runtime, 'pi');
      assert.equal(created.input.name, 'New bot');
      assert.equal(Object.hasOwn(created.input, 'model_id'), false);
      assert.equal(await js(`window.__editorHarness.history.some(x => x.method === 'cliProfiles')`), false);
    }
    for (const runtime of ['pi', 'cursor', 'codex']) {
      await js(`window.__editorHarness.render('${runtime}')`);
      await until(`document.querySelector('h2')?.textContent === '编辑 Bot' && !document.querySelector('button.primary').disabled && window.__editorHarness.saved.length === 0`);
      assert.equal(await js(`document.querySelector('option[value="cursor"], option[value="codex"]') !== null`), false);
      assert.equal(await js(`document.querySelector('select option[value="existing-model"]').selected`), true);
      if (runtime !== 'pi') {
        assert.equal(await js(`document.querySelector('input[disabled]').value`), runtime === 'cursor' ? '本机 Cursor' : '本机 Codex');
      }
      const updated = await submit();
      assert.equal(updated.method, 'botUpdate');
      assert.equal(updated.input.runtime, runtime);
      assert.equal(updated.input.model_id, 'existing-model');
      assert.equal(updated.input.persona, 'Keep persona');
      if (runtime !== 'pi') {
        assert.equal(updated.input.cli_profile, '/existing/profile');
        assert.equal(updated.input.cli_directory, '/existing/project');
        assert.equal(updated.input.cli_device_id, 'existing-device');
      }
      for (const [value, expectedCount] of [['other-model', 2], ['', 3]]) {
        await js(`(() => { const select = document.querySelector('option[value="existing-model"]').parentElement; select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await until(`document.querySelector('option[value="existing-model"]').parentElement.value === ${JSON.stringify(value)}`);
        const changed = await submit(expectedCount);
        assert.equal(changed.input.model_id, value || null);
        assert.equal(changed.input.runtime, runtime);
      }
    }
    writeFileSync(join(directory, 'result.json'), JSON.stringify({ ok: true }));
    win.destroy(); app.exit(0);
  } catch (error) {
    writeFileSync(join(directory, 'result.json'), JSON.stringify({ ok: false, error: String(error.stack ?? error) }));
    win.destroy(); app.exit(1);
  }
});
