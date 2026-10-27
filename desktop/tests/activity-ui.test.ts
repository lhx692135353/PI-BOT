import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

test('idle desktop discovers a missed task start, clears completion and rejects an older running snapshot', { timeout: 45000 }, async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const base = join(here, '..', 'test-results'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'activity-ui-'));
  try {
    await esbuild.build({ entryPoints: [join(here, '../apps/desktop/ui/main.tsx')], outfile: join(dir, 'app.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
    for (const name of ['phone-entry-mock.js', 'activity-entry-mock.js', 'activity-entry-driver.js']) cpSync(join(here, name), join(dir, name));
    writeFileSync(join(dir, 'activity.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="phone-entry-mock.js"></script><script src="activity-entry-mock.js"></script><script src="app.js"></script><script src="activity-entry-driver.js"></script>');
    const child = spawn(createRequire(import.meta.url)('electron') as string, ['--no-sandbox', '--disable-gpu', join(here, 'activity-ui-runner.mjs')], { env: { ...process.env, ACTIVITY_UI_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number>(resolve => child.once('exit', code => resolve(code ?? 1)));
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    assert.equal(code, 0, JSON.stringify({ ...result, stderr: stderr.slice(-1000) }));
    assert.equal(result.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
