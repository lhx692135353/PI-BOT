import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserTest, type BrowserTestConfig } from '../packages/service/src/browser-test.js';

const mode = process.env.PI_BOT_TEST_BROWSER;
const enabled = mode === 'chrome' || mode === 'chromium' || mode === 'auto';

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
  const execute = async (session: BrowserTest, args: Record<string, string>, signal?: AbortSignal) => {
    const result = await session.tool().execute('fixture', args as never, signal, undefined, {} as never);
    const content = result.content[0];
    assert.ok(content.type === 'text');
    return JSON.parse(content.text);
  };
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
