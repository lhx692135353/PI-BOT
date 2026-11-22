import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { checkServerUrl, CloudSocket, type SocketDiagnosticEvent, type SocketDiagnosticDetail, type SocketTimers } from '../packages/service/src/cloud.js';
import { Application } from '../packages/service/src/application.js';
import { MemoryCredentials } from '../packages/service/src/keychain.js';
import type { Method } from '../packages/protocol/src/index.js';

test('public HTTP requires an explicit matching backend and cannot expand to other endpoints', () => {
  const previous = process.env.PI_BOT_HTTP_SERVER_URL;
  try {
    delete process.env.PI_BOT_HTTP_SERVER_URL;
    assert.equal(checkServerUrl('https://backend.example/pibot/'), 'https://backend.example/pibot');
    assert.equal(checkServerUrl('http://localhost:8000'), 'http://localhost:8000');
    assert.equal(checkServerUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000');
    assert.equal(checkServerUrl('http://[::1]:8000/'), 'http://[::1]:8000');
    assert.throws(() => checkServerUrl('http://192.0.2.10:8000'), /HTTPS/);
    assert.throws(() => checkServerUrl('http://backend.example:8000'), /HTTPS/);

    process.env.PI_BOT_HTTP_SERVER_URL = 'http://BACKEND.example:8000/pibot/';
    assert.equal(checkServerUrl('http://backend.example:8000/pibot///'), 'http://backend.example:8000/pibot');
    for (const address of [
      'http://other.example:8000/pibot',
      'http://backend.example:8001/pibot',
      'http://backend.example:8000/other',
      'http://backend.example:8000/pibot?token=value',
      'http://backend.example:8000/pibot#fragment',
      'http://user:password@backend.example:8000/pibot',
      'ftp://backend.example:8000/pibot',
    ]) assert.throws(() => checkServerUrl(address));

    process.env.PI_BOT_HTTP_SERVER_URL = 'invalid';
    assert.throws(() => checkServerUrl('http://backend.example:8000'), /HTTPS/);
  } finally {
    if (previous === undefined) delete process.env.PI_BOT_HTTP_SERVER_URL;
    else process.env.PI_BOT_HTTP_SERVER_URL = previous;
  }
});

for (const secure of [false, true]) test(`${secure ? 'secure' : 'plain'} device WebSocket uses Node's environment proxy`, async t => {
  const proxy = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  const requests: { method: string; target: string }[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  proxy.on('upgrade', (request, socket, head) => {
    requests.push({ method: 'GET', target: request.url! });
    sockets.handleUpgrade(request, socket, head, ws => ws.send(JSON.stringify({ type: 'hello' })));
  });
  proxy.on('connect', (request, socket) => {
    requests.push({ method: 'CONNECT', target: request.url! });
    // Observing CONNECT proves HTTPS uses the proxy, without bypassing TLS verification.
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    child!.stdin!.end('stop');
  });
  t.after(() => {
    child?.kill();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    proxy.closeAllConnections();
    proxy.close();
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address() as { port: number };
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const source = `
    import { CloudSocket } from ${JSON.stringify(new URL('../packages/service/src/cloud.ts', import.meta.url).href)};
    const socket = new CloudSocket('${secure ? 'https' : 'http'}://pi-bot-proxy.invalid', () => ({}), {
      message() {}, close() {}, open() { finish(); }
    });
    const timeout = setTimeout(() => {
      console.error('WebSocket did not reach the configured proxy');
      process.exitCode = 1;
      finish();
    }, 5000);
    function finish() { clearTimeout(timeout); socket.stop(); process.stdin.destroy(); }
    process.stdin.once('data', finish);
    socket.start();
  `;
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr!.on('data', chunk => { errors += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child!.once('error', reject);
    child!.once('close', resolve);
  });
  assert.equal(code, 0, errors);
  assert.deepEqual(requests, [secure
    ? { method: 'CONNECT', target: 'pi-bot-proxy.invalid:443' }
    : { method: 'GET', target: 'http://pi-bot-proxy.invalid/ws/device' }]);
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for socket state');
    await delay(5);
  }
}

async function socketFixture(t: TestContext, timers: SocketTimers = {}) {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  const peers: WebSocket[] = [];
  const diagnostics: { event: SocketDiagnosticEvent; detail: SocketDiagnosticDetail }[] = [];
  const closes: boolean[] = [];
  let opens = 0;
  server.on('upgrade', (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, ws => {
      peers.push(ws);
      ws.send(JSON.stringify({ type: 'hello' }));
      sockets.emit('connection', ws, request);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new CloudSocket(`http://127.0.0.1:${(server.address() as { port: number }).port}`, () => ({ 'x-secret': 'credential-marker' }), {
    message() {}, open() { opens++; }, close(authFailed) { closes.push(authFailed); },
    diagnostics(event, detail) { diagnostics.push({ event, detail }); },
  }, { baseMs: 10, maxMs: 20 }, timers);
  t.after(async () => {
    client.stop();
    for (const peer of sockets.clients) peer.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { server, sockets, peers, client, diagnostics, closes, get opens() { return opens; } };
}

test('device socket reconnects after transport loss and sends capabilities again', async t => {
  const f = await socketFixture(t);
  let capabilities = 0;
  f.sockets.on('connection', ws => ws.on('message', raw => {
    if (JSON.parse(raw.toString()).type === 'capabilities') capabilities++;
  }));
  f.client.start();
  await waitFor(() => capabilities === 1);
  f.peers[0].terminate();
  await waitFor(() => capabilities === 2);
  assert.equal(f.opens, 2);
  assert.deepEqual(f.closes, [false]);
  assert.ok(f.client.connected);
  assert.ok(f.diagnostics.some(d => d.event === 'cloud.socket.close' && d.detail.closeCode === '1006'));
  assert.ok(f.diagnostics.some(d => d.event === 'cloud.socket.retry' && d.detail.retryDelayMs === '10'));
});

test('reconnectNow neither duplicates a pending handshake nor interrupts a healthy connection', async t => {
  const f = await socketFixture(t);
  f.client.start();
  for (let i = 0; i < 10; i++) f.client.reconnectNow();
  await waitFor(() => f.client.connected);
  for (let i = 0; i < 10; i++) f.client.reconnectNow();
  await delay(50);
  assert.equal(f.peers.length, 1);
  assert.deepEqual(f.closes, []);
});

test('reconnectNow recovers stale connected state without overlapping sockets', async t => {
  const f = await socketFixture(t, { pingIntervalMs: 1000, pongTimeoutMs: 30 });
  f.client.start();
  await waitFor(() => f.client.connected);
  await delay(45);
  for (let i = 0; i < 10; i++) f.client.reconnectNow();
  await waitFor(() => f.opens === 2);
  assert.equal(f.peers.length, 2);
  assert.deepEqual(f.closes, [false]);
  assert.ok(f.diagnostics.some(d => d.event === 'cloud.socket.reconnect' && Number(d.detail.pongAgeMs) > 30));
  assert.ok(f.diagnostics.some(d => d.event === 'cloud.socket.retry' && d.detail.retryDelayMs === '0'));
});

test('missed application pongs cause heartbeat timeout and automatic reconnect', async t => {
  const f = await socketFixture(t, { pingIntervalMs: 10, pongTimeoutMs: 40 });
  f.sockets.on('connection', ws => {
    if (f.peers.length === 1) return;
    ws.on('message', raw => { if (JSON.parse(raw.toString()).type === 'ping') ws.send(JSON.stringify({ type: 'pong' })); });
  });
  f.client.start();
  await waitFor(() => f.opens === 2);
  await delay(100);
  assert.equal(f.peers.length, 2);
  assert.ok(f.client.connected);
  assert.ok(f.diagnostics.some(d => d.event === 'cloud.socket.heartbeat_timeout' && Number(d.detail.pongAgeMs) > 40));
});

test('late old-socket close cannot clear the replacement heartbeat or connection', async t => {
  const f = await socketFixture(t, { pingIntervalMs: 10, pongTimeoutMs: 50 });
  let pings = 0;
  f.sockets.on('connection', ws => ws.on('message', raw => {
    if (JSON.parse(raw.toString()).type === 'ping') { pings++; ws.send(JSON.stringify({ type: 'pong' })); }
  }));
  f.client.start();
  await waitFor(() => f.client.connected);
  // Capture the real listener to model a close callback already queued before stop/restart.
  const oldSocket = (f.client as unknown as { socket: WebSocket }).socket;
  const oldClose = oldSocket.listeners('close')[0];
  f.client.stop();
  f.client.start();
  await waitFor(() => f.opens === 2);
  const before = pings;
  oldClose.call(oldSocket, 1006, Buffer.alloc(0));
  await waitFor(() => pings >= before + 3);
  assert.ok(f.client.connected);
  assert.deepEqual(f.closes, []);
  assert.equal(f.diagnostics.filter(d => d.event === 'cloud.socket.close').length, 0);
});

for (const status of [401, 403]) test(`HTTP ${status} authentication failure stops all retries including reconnectNow`, async t => {
  const f = await socketFixture(t);
  f.server.removeAllListeners('upgrade');
  let requests = 0;
  f.server.on('upgrade', (_request, socket) => {
    requests++;
    socket.end(`HTTP/1.1 ${status} Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  });
  f.client.start();
  await waitFor(() => f.closes.length === 1);
  f.client.reconnectNow();
  await delay(60);
  assert.deepEqual(f.closes, [true]);
  assert.equal(requests, 1);
  assert.ok(!f.client.connected);
  assert.ok(f.diagnostics.some(d => d.event === 'cloud.socket.error' && d.detail.errorCode === `HTTP_${status}`));
  assert.ok(f.diagnostics.some(d => d.event === 'cloud.socket.auth_failed'));
  assert.ok(!f.diagnostics.some(d => d.event === 'cloud.socket.retry'));
});

test('4401 revocation stops reconnection and never logs the close reason', async t => {
  const f = await socketFixture(t);
  f.client.start();
  await waitFor(() => f.client.connected);
  f.peers[0].close(4401, 'credential-marker https://user:password@example.invalid/?token=secret');
  await waitFor(() => f.closes.length === 1);
  f.client.reconnectNow();
  await delay(60);
  assert.deepEqual(f.closes, [true]);
  assert.equal(f.peers.length, 1);
  assert.ok(f.diagnostics.some(d => d.event === 'cloud.socket.close' && d.detail.closeCode === '4401'));
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /credential-marker|password|token=|https:/);
});

test('4409 duplicate connection retains a minimum retry delay', async t => {
  const f = await socketFixture(t);
  f.client.start();
  await waitFor(() => f.client.connected);
  f.peers[0].close(4409);
  await waitFor(() => f.diagnostics.some(d => d.event === 'cloud.socket.retry'));
  assert.equal(f.diagnostics.find(d => d.event === 'cloud.socket.retry')?.detail.retryDelayMs, '5000');
  await delay(50);
  assert.equal(f.peers.length, 1);
});

test('socket diagnostics allowlist error codes and tolerate a throwing handler', async t => {
  const f = await socketFixture(t);
  f.client.start();
  await waitFor(() => f.client.connected);
  const socket = (f.client as unknown as { socket: WebSocket }).socket;
  socket.emit('error', Object.assign(new Error('https://user:password@example.invalid/?token=secret'), { code: 'credential-marker' }));
  socket.emit('error', Object.assign(new Error('credential-marker'), { code: 'ECONNRESET' }));
  assert.deepEqual(f.diagnostics.filter(d => d.event === 'cloud.socket.error').map(d => d.detail.errorCode), ['UNKNOWN', 'ECONNRESET']);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /credential-marker|password|token=|https:/);
  (f.client as unknown as { handlers: { diagnostics: () => void } }).handlers.diagnostics = () => { throw new Error('log unavailable'); };
  f.peers[0].terminate();
  await waitFor(() => f.opens === 2);
  assert.ok(f.client.connected);
});

test('Application connection.check returns state safely without a socket', async t => {
  const app = new Application({ dataDir: '/unused', libraryRoot: '/unused', credentials: new MemoryCredentials(), emit() {} });
  t.after(() => app.shutdown());
  assert.deepEqual(await app.call('connection.check' as Method, {}), app.state());
  assert.equal(app.state().connection, 'signed_out');
});

test('Application wake connection.check preserves a healthy socket and reconnects a stale one', async t => {
  const f = await socketFixture(t, { pingIntervalMs: 1000, pongTimeoutMs: 100 });
  const app = new Application({ dataDir: '/unused', libraryRoot: '/unused', credentials: new MemoryCredentials(), emit() {} });
  t.after(() => app.shutdown());
  (app as unknown as { socket: CloudSocket }).socket = f.client;
  f.client.start();
  await waitFor(() => f.client.connected);
  assert.deepEqual(await app.call('connection.check' as Method, {}), app.state());
  assert.equal(f.peers.length, 1);
  assert.deepEqual(f.closes, []);
  await delay(120);
  for (let i = 0; i < 5; i++) assert.deepEqual(await app.call('connection.check' as Method, {}), app.state());
  await waitFor(() => f.opens === 2);
  assert.equal(f.peers.length, 2);
  assert.deepEqual(f.closes, [false]);
});
