import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Page } from 'playwright';
import { BrowserTest, type BrowserTestConfig } from '../packages/service/src/browser-test.js';

const mode = process.env.PI_BOT_TEST_BROWSER;
const enabled = mode === 'chrome' || mode === 'chromium' || mode === 'auto';
const handoff = enabled && process.env.PI_BOT_TEST_BROWSER_HANDOFF === '1';

async function execute(session: BrowserTest, args: Record<string, string>, signal?: AbortSignal) {
  const result = await session.tool().execute('fixture', args as never, signal, undefined, {} as never);
  const content = result.content[0];
  assert.ok(content.type === 'text');
  return JSON.parse(content.text);
}

test('browser test sessions recover from blocked navigation, isolate cookies and respect cancellation', { skip: !enabled, timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-bot-browser-'));
  const library = join(root, 'library');
  const data = join(root, 'data');
  await Promise.all([mkdir(library), mkdir(data)]);
  let navigationStarted!: () => void;
  const reached = new Promise<void>(resolve => { navigationStarted = resolve; });
  let outsideHits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/pending') { navigationStarted(); return; }
    if (req.url === '/redirect') {
      const port = (server.address() as AddressInfo).port;
      return void res.writeHead(302, { Location: `http://localhost:${port}/outside` }).end();
    }
    if (req.url === '/outside') outsideHits++;
    if (req.url === '/cookie') res.setHeader('Set-Cookie', 'fixture=present; Path=/');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h1>${req.headers.cookie ? 'Cookie present' : 'Fresh session'}</h1>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const config: BrowserTestConfig = { browser: enabled ? mode : 'auto', origins: new Set([origin]) };
  const first = new BrowserTest(config, origin, data, library);
  const second = new BrowserTest(config, origin, data, library);
  try {
    assert.equal((await execute(first, { op: 'open', url: origin + '/cookie' })).opened, true);
    for (let repeat = 0; repeat < 3; repeat++) {
      const blocked = await execute(first, { op: 'open', url: origin + '/redirect' });
      assert.equal(blocked.opened, false);
      await assert.rejects(execute(first, { op: 'observe' }), /请先打开测试页面/);
      assert.equal((await execute(first, { op: 'open', url: origin })).opened, true);
    }
    assert.equal(outsideHits, 0);
    await Promise.all([first, second].map(async session => {
      assert.equal((await execute(session, { op: 'open', url: origin })).opened, true);
      const result = await execute(session, { op: 'observe' });
      assert.match(JSON.stringify(result.visible), session === first ? /Cookie present/ : /Fresh session/);
    }));
    const controller = new AbortController();
    const pending = execute(first, { op: 'open', url: origin + '/pending' }, controller.signal);
    await Promise.race([reached, pending.then(() => assert.fail('navigation ended before cancellation'))]);
    controller.abort();
    assert.equal((await pending).opened, false);
    await assert.rejects(execute(first, { op: 'observe' }), /已取消/);
    assert.match(JSON.stringify((await execute(second, { op: 'observe' })).visible), /Fresh session/);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await rm(root, { recursive: true, force: true });
  }
});

test('manual login keeps the active window or moves the current test state into a visible browser', { skip: !handoff, timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-bot-login-'));
  const library = join(root, 'library');
  const data = join(root, 'data');
  await Promise.all([mkdir(library), mkdir(data)]);
  let submitCount = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/prepare') {
      res.setHeader('Set-Cookie', 'prelogin=ready; Path=/');
      return void res.end('<script>localStorage.setItem("fixture", "local"); sessionStorage.setItem("fixture", "tab");</script><h1>Ready</h1>');
    }
    if (req.url === '/submit' && req.method === 'POST') {
      submitCount++;
      res.writeHead(303, { Location: '/welcome', 'Set-Cookie': 'login=ready; Path=/' }).end();
      return;
    }
    if (req.url === '/welcome') return void res.end(`<h1>${req.headers.cookie?.includes('login=ready') ? 'Signed in' : 'Missing login'}</h1>`);
    res.end('<form action="/submit" method="post"><button>Sign in manually</button></form>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const config: BrowserTestConfig = { browser: enabled ? mode : 'auto', origins: new Set([origin]) };
  try {
    for (const visible of [true, false]) {
      let original: Page;
      const session = new BrowserTest(config, origin, data, library, undefined, {
        visible,
        wait: async loginOrigin => {
          assert.equal(loginOrigin, origin);
          const page = (session as unknown as { page: Page }).page;
          assert.equal(page === original, visible);
          assert.ok((await page.context().cookies()).some(cookie => cookie.name === 'prelogin'));
          assert.deepEqual(await page.evaluate(() => [localStorage.getItem('fixture'), sessionStorage.getItem('fixture')]), ['local', 'tab']);
          await assert.rejects(execute(session, { op: 'observe' }), /请按顺序/);
          await page.getByRole('button', { name: 'Sign in manually' }).click();
          await page.waitForURL(origin + '/welcome');
          return true;
        },
      });
      try {
        assert.equal((await execute(session, { op: 'open', url: origin + '/prepare' })).opened, true);
        assert.equal((await execute(session, { op: 'open', url: origin + '/login' })).opened, true);
        original = (session as unknown as { page: Page }).page;
        assert.equal((await execute(session, { op: 'login' })).resumed, true);
        assert.equal((await execute(session, { op: 'assert', role: 'heading', name: 'Signed in' })).passed, true);
      } finally {
        await session.close();
      }
    }
    assert.equal(submitCount, 2);
  } finally {
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await rm(root, { recursive: true, force: true });
  }
});
