import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
// One release workflow owns this sequence. Reruns retain the same identity.
export function identity(run, sha) {
  const buildNumber = 1000 + Number(run);
  if (!/^[1-9]\d*$/.test(String(run)) || !Number.isSafeInteger(buildNumber) || buildNumber > 65535 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid build identity (Windows version component must fit uint16)');
  return { schemaVersion: 1, channel: 'test', buildNumber, version: `0.3.${buildNumber}`, commit: sha, minimumServerVersion: null };
}
if (process.argv[1] === import.meta.filename) {
  const info = identity(process.env.GITHUB_RUN_NUMBER, process.env.GITHUB_SHA);
  for (const file of ['desktop/package.json', 'desktop/apps/desktop/package.json']) {
    const path = resolve(root, file), pkg = JSON.parse(readFileSync(path, 'utf8'));
    pkg.version = info.version; writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  }
  writeFileSync(resolve(root, 'client-build.json'), JSON.stringify(info, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_OUTPUT, `build_number=${info.buildNumber}\nversion=${info.version}\ntag=client-test-${info.buildNumber}\n`);
  }
}
