import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

export function browserTestUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('浏览器测试只接受无凭据的 HTTP(S) 地址');
  return url;
}

function directHeaders(headers: IncomingHttpHeaders) {
  const result = { ...headers };
  const connection = typeof result.connection === 'string' ? result.connection.split(',').map(name => name.trim().toLowerCase()) : [];
  for (const name of [...connection, 'connection', 'proxy-connection', 'keep-alive', 'te', 'trailer',
    'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate']) delete result[name];
  return result;
}

/** Enforce the destination before opening a socket, including browser-followed redirects. */
export async function browserTestProxy(origins: ReadonlySet<string>, denied: (origin: string) => void) {
  let probeUrl: string;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const server = createServer((incoming, outgoing) => {
    if (incoming.method === 'GET' && incoming.url === probeUrl)
      return void outgoing.writeHead(200, { 'content-type': 'text/plain' }).end(probeUrl);
    let url: URL | undefined;
    try { url = browserTestUrl(incoming.url ?? ''); } catch { /* Invalid proxy target. */ }
    if (!url || url.protocol !== 'http:' || !origins.has(url.origin)) {
      denied(url?.origin ?? 'invalid');
      outgoing.writeHead(403).end();
      return;
    }
    const upstream = request(url, { method: incoming.method, agent: false, headers: { ...directHeaders(incoming.headers), host: url.host } },
      response => {
        outgoing.writeHead(response.statusCode ?? 502, directHeaders(response.headers));
        response.pipe(outgoing);
      });
    upstream.on('socket', track);
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502).end();
      else outgoing.destroy();
    });
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on('connection', track);
  server.on('connect', (incoming, downstream, head) => {
    let url: URL | undefined;
    const authority = incoming.url ?? '';
    if (/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+):\d+$/i.test(authority)) {
      try { url = browserTestUrl('https://' + authority); } catch { /* Invalid proxy target. */ }
    }
    if (!url || !origins.has(url.origin)) {
      denied(url?.origin ?? 'invalid');
      downstream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const remote = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443) });
    track(remote);
    const timer = setTimeout(() => remote.destroy(new Error('Proxy connection timed out')), 10000);
    remote.once('error', () => downstream.destroy());
    remote.once('close', () => { clearTimeout(timer); downstream.destroy(); });
    downstream.once('error', () => remote.destroy());
    downstream.once('close', () => remote.destroy());
    remote.once('connect', () => {
      clearTimeout(timer);
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      remote.pipe(downstream).pipe(remote);
    });
  });
  server.on('upgrade', (_incoming, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  probeUrl = url + '/' + randomUUID();
  return {
    url,
    probeUrl,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
