import { accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

if (!process.argv[2]) throw new Error('请指定桌面服务的 runtime 目录');
const runtime = resolve(process.argv[2]);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { outputFiles } = await build({
  entryPoints: [resolve(desktop, 'tests/browser-test.test.ts')],
  platform: 'node', format: 'esm', bundle: true, packages: 'external', write: false,
});
const node = resolve(runtime, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
function chromeStableAvailable() {
  const candidates = process.platform === 'linux'
    ? ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : process.platform === 'win32'
        ? [`${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`]
        : [];
  return candidates.some(path => {
    if (!path) return false;
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
}
const modes = chromeStableAvailable() ? ['chrome', 'chromium'] : ['chromium'];
if (!modes.includes('chrome')) {
  console.warn('Skipping chrome-channel smoke: Google Chrome Stable not found; testing Playwright Chromium only');
}
for (const mode of modes) {
  const result = spawnSync(node, ['--input-type=module', '-'], {
    cwd: runtime, env: { ...process.env, PI_BOT_TEST_BROWSER: mode },
    input: outputFiles[0].text, stdio: ['pipe', 'inherit', 'inherit'],
    timeout: 70000, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`打包服务的 ${mode} 测试失败`);
}
