import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = resolve(root, 'node_modules/node/bin/node');
const runtime = resolve(root, 'apps/desktop/runtime');
const require = createRequire(resolve(root, 'package.json'));
const pkg = require(resolve(root, 'package.json'));
const runtimeDeps = ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'typebox', 'ws', 'zod', '@a2ui/web_core', 'zod-to-json-schema'];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(node, ['scripts/build.mjs'], root);

rmSync(runtime, { recursive: true, force: true });
mkdirSync(resolve(runtime, 'bin'), { recursive: true });
mkdirSync(resolve(runtime, 'licenses'), { recursive: true });
for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
  cpSync(resolve(root, '..', file), resolve(runtime, file));
}
cpSync(resolve(root, '../packages/agent/src/hermes-memory/LICENSE'), resolve(runtime, 'licenses/pi-hermes-memory-LICENSE'));
cpSync(resolve(root, 'node_modules/node/bin/node'), resolve(runtime, 'bin/node'));
cpSync(resolve(root, 'packages/service/dist/server.mjs'), resolve(runtime, 'server.mjs'));
cpSync(resolve(root, 'native/dist/keychain'), resolve(runtime, 'keychain'));
writeFileSync(resolve(runtime, 'package.json'), JSON.stringify({
  name: 'pi-bot-runtime',
  private: true,
  type: 'module',
  dependencies: Object.fromEntries(runtimeDeps.map(name => [name, pkg.dependencies[name] ?? require(resolve(root, '../packages/agent/package.json')).dependencies[name] ?? require(resolve(root, '../packages/a2ui/package.json')).dependencies[name]])),
}, null, 2));
run('npm', ['install', '--omit=dev', '--no-package-lock', '--ignore-scripts'], runtime);
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
