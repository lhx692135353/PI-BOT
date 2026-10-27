import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

test('chat shows immediate separate replies and scoped details with retry, paging and keyboard dismissal', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const base = join(here, '..', 'test-results'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'chat-ui-'));
  try {
    await esbuild.build({ entryPoints: [join(here, 'chat.harness.tsx')], outfile: join(dir, 'chat.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    writeFileSync(join(dir, 'chat.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="chat.css"><div id="root"></div><script src="chat.js"></script>');
    const child = spawn(createRequire(import.meta.url)('electron') as string, ['--no-sandbox', '--disable-gpu', join(here, 'chat-ui-runner.mjs')], { env: { ...process.env, CHAT_UI_DIR: dir, ELECTRON_DISABLE_SANDBOX: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number>(resolve => child.once('exit', code => resolve(code ?? 1)));
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    assert.equal(code, 0, JSON.stringify({ result, stderr: stderr.slice(-1500) }));
    assert.equal(result.ok, true);
    if (process.env.CHAT_UI_SCREENSHOTS) { mkdirSync(process.env.CHAT_UI_SCREENSHOTS, { recursive: true }); for (const file of ['chat-wide.png', 'chat-narrow.png', 'conversation-wide.png', 'conversation-narrow.png']) cpSync(join(dir, file), join(process.env.CHAT_UI_SCREENSHOTS, file)); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
