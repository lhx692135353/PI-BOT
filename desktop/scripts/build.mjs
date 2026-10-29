import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { workspace, buildService } from './build-service.mjs';
import { resolve } from 'node:path';
const infoFile = resolve('../client-build.json');
const buildInfo = existsSync(infoFile) ? JSON.parse(readFileSync(infoFile, 'utf8')) : { version: '0.3.0', buildNumber: 0 };
if (process.platform === 'win32') {
  const helper = spawnSync(process.execPath, ['scripts/build-windows-helper.mjs'], { stdio: 'inherit' });
  if (helper.status !== 0) process.exit(helper.status ?? 1);
}
const icon = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build-icon.ts'], { stdio: 'inherit' });
if (icon.status !== 0) process.exit(icon.status ?? 1);
if (process.platform === 'darwin') {
  mkdirSync('native/dist', { recursive: true });
  const result = spawnSync('xcrun', ['swiftc', '-O', 'native/Keychain.swift', '-o', 'native/dist/keychain'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await Promise.all([
  bundle({ entryPoints: ['apps/desktop/src/main.ts'], outfile: 'apps/desktop/dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], define: { __PI_BOT_BUILD__: JSON.stringify(buildInfo) }, sourcemap: true }),
  bundle({ entryPoints: ['apps/desktop/src/preload.ts'], outfile: 'apps/desktop/dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] }),
  buildService(),
]);
await viteBuild({ root: resolve('apps/desktop/ui'), base: './', build: { outDir: resolve('apps/desktop/ui-dist'), emptyOutDir: true }, configFile: false });
