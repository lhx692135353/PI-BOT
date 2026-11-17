import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { ElectronTest } from '../packages/service/src/electron-test.js';

const require = createRequire(new URL('../package.json', import.meta.url));

test('Electron tests launch an isolated renderer only after approval, then operate and close it', {
  skip: process.platform === 'linux' && !process.env.DISPLAY ? '需要桌面显示或 Xvfb' : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pibot-electron-test-'));
  const executable: string = require('electron');
  const entry = join(root, 'app.cjs');
  await writeFile(join(root, 'index.html'), `
    <label>Name <input id="name"></label>
    <button onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Submit</button>
    <p id="result">Ready</p>
  `);
  await writeFile(entry, `
    const { app, BrowserWindow } = require('electron');
    const { join } = require('node:path');
    app.whenReady().then(() => {
      const window = new BrowserWindow({ width: 500, height: 400 });
      void window.loadFile(join(__dirname, 'index.html'));
    });
  `);
  let allow = false;
  let launchPrompts = 0;
  let handoffs = 0;
  const session = new ElectronTest({
    dataDir: root, runId: 'fixture', target: { app: 'electron', executable, entry },
    canonical: async path => resolve(path),
    approveLaunch: async (path, reason) => {
      assert.equal(path, executable);
      assert.ok(reason.includes('app.cjs'));
      launchPrompts++;
      return allow;
    },
    handoff: async () => { handoffs++; return true; },
  });
  const tool = session.tool();
  const call = (action: string, selector?: string, value?: string) =>
    tool.execute(action, { action, selector, value }, undefined, undefined, {} as never);
  const asText = (r: Awaited<ReturnType<typeof call>>) => r.content[0]?.type === 'text' ? r.content[0].text : '';
  try {
    await assert.rejects(call('open'), /未获启动授权/);
    allow = true;
    await call('open');
    assert.equal(launchPrompts, 2);
    await call('assert', '#result', 'Ready');
    assert.match(asText(await call('observe')), /Submit/);
    await call('login');
    assert.equal(handoffs, 1);
    await call('fill', '#name', 'test user');
    await call('click', 'button');
    await call('assert', '#result', 'test user');
    await call('screenshot');
    assert.ok((await stat(join(root, 'electron-test-evidence', 'fixture', 'screenshot-1.png'))).size > 0);
    await session.close();
    assert.deepEqual(await readdir(join(root, 'electron-test-profiles')), []);
    await assert.rejects(call('open'), /测试已经结束/);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
