import { connect } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { join, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { defaultDataDir } from './platform.js';
export const dataDir = defaultDataDir();
// Unix sockets on macOS have a short path limit. Keep the socket under a private user-specific /tmp directory.
export const socketDir = join('/tmp', `pi-bot-${process.getuid?.() ?? 0}-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}`);
// Windows beta deliberately uses loopback TCP, not an inadequately secured named pipe.
// The port is only discovery; 256-bit per-install token authentication remains mandatory.
export function windowsIpcPort(directory: string, username: string, configured?: string) {
  if (configured !== undefined) {
    if (!/^[1-9]\d{0,4}$/.test(configured) || Number(configured) > 65535) throw new Error('PI_BOT_IPC_PORT 必须是 1 到 65535 的端口号');
    return Number(configured);
  }
  return 20000 + parseInt(createHash('sha256').update(`${username}:${win32.normalize(directory).toLowerCase()}`).digest('hex').slice(0, 8), 16) % 40000;
}
const windowsPort = windowsIpcPort(dataDir, userInfo().username, process.platform === 'win32' ? process.env.PI_BOT_IPC_PORT : undefined);
export const socketPath = process.platform === 'win32' ? `tcp:${windowsPort}` : join(socketDir, 'service.sock');
export const listenAddress = process.platform === 'win32' ? { port: windowsPort, host: '127.0.0.1', exclusive: true } : { path: socketPath };
export function connectLocal(endpoint = socketPath) {
  if (endpoint.startsWith('tcp:')) return connect({ port: Number(endpoint.slice(4)), host: '127.0.0.1' });
  return connect(endpoint);
}
export const tokenPath = join(dataDir, 'ipc-token');
/** Each bot's library lives in `<libraryRoot>/<slug>`. */
export const libraryRoot = process.env.PI_BOT_LIBRARY_ROOT || join(homedir(), 'pi-bot');
