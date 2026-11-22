import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';

// Run the actual Windows-only packaging smoke with IO doubles on every platform.
// Delayed close events model the gap between receiving a result/exit and releasing handles.
async function smoke(workerResult = true) {
  const source = await readFile(new URL('../scripts/smoke-windows-runtime.mjs', import.meta.url), 'utf8');
  const body = source.replace(/^import .*;\n/gm, '').replace(/import\.meta\.url/g, "'file:///smoke.mjs'");
  let openHandles = 0;
  let cleanup: unknown;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const child = () => {
    const c = Object.assign(new EventEmitter(), {
      exitCode: null as number | null, signalCode: null as string | null,
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { end: () => finish(0) }),
      kill: () => finish(null), send: (_data: unknown, callback: (error?: Error) => void) => {
        callback();
        setImmediate(() => workerResult ? c.emit('message', { ok: true, result: { bytes: [], text: '随包文档验证' } }) : finish(0));
      },
    });
    openHandles++;
    let closing = false;
    function finish(code: number | null) {
      if (closing) return;
      closing = true;
      c.exitCode = code;
      c.signalCode = code === null ? 'SIGTERM' : null;
      c.emit('exit', code);
      setImmediate(() => { openHandles--; c.emit('close', code); });
    }
    return c;
  };
  const context = {
    process: { platform: 'win32', env: {} }, console: { log() {} },
    mkdtempSync: () => '/stage', tmpdir: () => '/tmp',
    dirname: () => '/', resolve: (...parts: string[]) => parts.join('/'), join: (...parts: string[]) => parts.join('/'), fileURLToPath: () => '/smoke.mjs',
    cp: async () => {},
    rmSync: (_path: string, options: unknown) => { assert.equal(openHandles, 0, 'cleanup must wait for every child close'); cleanup = options; },
    fork: () => child(),
    spawn: (_binary: string, args: string[]) => {
      const c = child();
      if (args.includes('status')) setImmediate(() => { c.stdout.emit('data', '{}'); c.stdin.end(); });
      else setImmediate(() => c.stdout.emit('data', 'service ready'));
      return c;
    },
    createServer: () => Object.assign(new EventEmitter(), {
      listen: (_options: unknown, done: () => void) => done(), address: () => ({ port: 1234 }), close: (done: () => void) => done(),
    }),
    setTimeout: (fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { timers.delete(timer); clearTimeout(timer); },
  };
  try {
    await runInNewContext(`(async () => { ${body}\n })()`, context);
    assert.deepEqual(JSON.parse(JSON.stringify(cleanup)), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } finally { for (const timer of timers) clearTimeout(timer); }
}

test('Windows packaging smoke waits for worker, CLI and service close before retried cleanup', async () => {
  await smoke();
});

test('Windows packaging smoke fails if a document worker exits without a result', async () => {
  await assert.rejects(smoke(false), /exited without a result/);
});
