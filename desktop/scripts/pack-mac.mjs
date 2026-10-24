import { spawnSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { prepareRuntime } from './prepare-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(root, 'apps/desktop/runtime');
const require = createRequire(resolve(root, 'package.json'));

function assertPortableSymlinks(root) {
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(file);
        if (isAbsolute(target)) throw new Error(`安装包里的符号链接不能指向构建机器：${file} -> ${target}`);
      } else if (stat.isDirectory()) pending.push(file);
    }
  }
}

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
const staged = resolve(stage, 'Pi Bot.app');
// Node 的 cp 默认会把相对符号链接改写成源机器上的绝对路径，装到别的电脑后 Electron Framework 就找不到。
cpSync(app, staged, { recursive: true, verbatimSymlinks: true });
assertPortableSymlinks(staged);
run('ln', ['-s', '/Applications', resolve(stage, 'Applications')], root);
rmSync(dmg, { force: true });
run('hdiutil', ['create', '-volname', 'Pi Bot', '-srcfolder', stage, '-ov', '-format', 'ULFO', dmg], root);
rmSync(stage, { recursive: true, force: true });
console.log(dmg);
