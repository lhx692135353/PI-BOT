// Local-only release preparation: fixed allowlist, no repository-wide copy, no publish.
import { readFileSync, lstatSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['package.json','README.md','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md',
  'phone.example.json','tsconfig.json','src/index.ts','dist/index.js','dist/index.d.ts',
  'tests/controller.test.ts','scripts/export.mjs'];
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `pi-bot-virtual-phone-${pkg.version}`;
const target = resolve(process.argv[2] || `${name}-source.tar.gz`);
// Scan only allowed textual files. Never include actual phone.json, env, credentials or device data.
const forbidden = [ /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:sk|ghp|github_pat)-[A-Za-z0-9_]{24,}/,
  /["']?(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["'][^"']{8,}["']/i,
  /\/home\/zhaotao\// ];
const stage = mkdtempSync(join(tmpdir(), 'virtual-phone-export-'));
try {
  const base = join(stage, name);
  const manifest = [];
  for (const file of files) {
    const source = join(root, file);
    if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw Error(`Unsafe source: ${file}`);
    const content = readFileSync(source);
    if (forbidden.some(pattern => pattern.test(content.toString('utf8')))) throw Error(`Sensitive content: ${file}`);
    const dest = join(base, file);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, { mode: 0o644 });
    manifest.push(`${createHash('sha256').update(content).digest('hex')}  ${file}`);
  }
  writeFileSync(join(base, 'MANIFEST.sha256'), manifest.join('\n') + '\n');
  mkdirSync(dirname(target), { recursive: true });
  execFileSync('tar', ['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-czf',target,'-C',stage,name]);
  console.log(JSON.stringify({ archive: target, sha256: createHash('sha256').update(readFileSync(target)).digest('hex'), files: files.length + 1 }));
} finally { rmSync(stage, { recursive: true, force: true }); }
