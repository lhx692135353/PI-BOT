import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

test('timeline loads older pages near the top, keeps the reading position and jumps back to the newest message', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const base = join(here, '..', 'test-results'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'paging-ui-'));
  try {
    await esbuild.build({ entryPoints: [join(here, 'timeline-paging.harness.tsx')], outfile: join(dir, 'paging.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
    writeFileSync(join(dir, 'paging.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="paging.css"><div id="root"></div><script src="paging.js"></script>');
    const child = spawn(createRequire(import.meta.url)('electron') as string, ['--no-sandbox', '--disable-gpu', '--headless=new', join(here, 'timeline-paging-runner.mjs')], { env: { ...process.env, PAGING_UI_DIR: dir, ELECTRON_DISABLE_SANDBOX: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
    const resultPath = join(dir, 'result.json');
    assert.ok(existsSync(resultPath), `Electron exited (${code}) before producing a test result:\n${stderr.slice(-4000)}`);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(code, 0, JSON.stringify({ result, stderr: stderr.slice(-1500) }));
    assert.equal(result.ok, true);
    if (process.env.PAGING_UI_SCREENSHOTS) { mkdirSync(process.env.PAGING_UI_SCREENSHOTS, { recursive: true }); for (const file of ['paging-loading.png', 'paging-older.png', 'paging-bottom.png']) cpSync(join(dir, file), join(process.env.PAGING_UI_SCREENSHOTS, file)); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
