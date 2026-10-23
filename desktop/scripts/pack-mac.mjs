import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { prepareRuntime } from './prepare-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(root, 'apps/desktop/runtime');
const require = createRequire(resolve(root, 'package.json'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// CI installs with --ignore-scripts, so the vendored `node` package has no binary. Use the Node that invoked this script; the packaged runtime copies the same executable.
run(process.execPath, ['scripts/build.mjs'], root);

prepareRuntime(root, runtime);
run(resolve(root, 'node_modules/.bin/electron-forge'), ['package', '--platform', 'darwin'], resolve(root, 'apps/desktop'));
const app = resolve(root, 'apps/desktop/out/Pi Bot-darwin-arm64/Pi Bot.app');
const { sign } = require('@electron/osx-sign');
const jit = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
];
await sign({
  app,
  identity: '-',
  platform: 'darwin',
  identityValidation: false,
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  binaries: [resolve(app, 'Contents/Resources/runtime/bin/node'), resolve(app, 'Contents/Resources/runtime/keychain')],
  optionsForFile: () => ({ entitlements: jit, hardenedRuntime: true, timestamp: 'none' }),
});

const stage = resolve(root, 'apps/desktop/out/dmg-stage');
const dmg = resolve(root, 'apps/desktop/out/make/Pi-Bot-arm64.dmg');
rmSync(stage, { recursive: true, force: true });
mkdirSync(resolve(root, 'apps/desktop/out/make'), { recursive: true });
mkdirSync(stage);
cpSync(app, resolve(stage, 'Pi Bot.app'), { recursive: true });
run('ln', ['-s', '/Applications', resolve(stage, 'Applications')], root);
rmSync(dmg, { force: true });
run('hdiutil', ['create', '-volname', 'Pi Bot', '-srcfolder', stage, '-ov', '-format', 'ULFO', dmg], root);
rmSync(stage, { recursive: true, force: true });
console.log(dmg);
