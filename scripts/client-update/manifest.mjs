import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
export function makeManifest(info, directory) {
  if (info.schemaVersion !== 1 || info.channel !== 'test' || !Number.isSafeInteger(info.buildNumber) || info.buildNumber <= 0 || info.version !== `0.3.${info.buildNumber}` || !/^[a-f0-9]{40}$/.test(info.commit)) throw new Error('Invalid build metadata');
  const platforms = {};
  for (const [platform, file] of Object.entries({ android: 'Pi-Bot-Android.apk', 'windows-x64': 'Pi-Bot-Windows-x64-Setup.exe', 'linux-x64': 'pi-bot-desktop-linux-x64.tar.gz' })) {
    const path = resolve(directory, file), size = statSync(path).size;
    if (!size) throw new Error(`Empty ${file}`);
    platforms[platform] = { file, size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  }
  return { ...info, platforms };
}
if (process.argv[1] === import.meta.filename) {
  const dir = resolve(process.argv[2]);
  const manifest = makeManifest(JSON.parse(readFileSync('client-build.json', 'utf8')), dir);
  writeFileSync(resolve(dir, 'update-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(resolve(dir, 'SHA256SUMS.txt'), Object.values(manifest.platforms).map(p => `${p.sha256}  ${p.file}\n`).join(''));
}
