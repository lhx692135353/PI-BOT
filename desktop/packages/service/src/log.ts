import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { SocketDiagnosticEvent } from './cloud.js';

export type LogEvent = 'service.started' | 'service.stopping' | 'cloud.online' | 'cloud.offline' | 'cloud.revoked' | 'run.started' | 'run.finished' | SocketDiagnosticEvent;
// Only fixed events, ids, timestamps and allowlisted socket codes/timings; never URLs, error messages or credentials.
export function createLog(dataDir: string) {
  const directory = join(dataDir, 'logs'), path = join(directory, 'service.log');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return (event: LogEvent, detail: Record<string, string> = {}) => {
    try {
      try { if (statSync(path).size > 1_000_000) renameSync(path, path + '.1'); } catch {}
      appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), event, ...detail }) + '\n', { mode: 0o600 });
    } catch { /* Logging must not interrupt a run. */ }
  };
}
