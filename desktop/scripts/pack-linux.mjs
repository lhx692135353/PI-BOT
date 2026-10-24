import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { prepareRuntime, run } from './prepare-runtime.mjs';

if (process.platform!=='linux' || process.arch!=='x64') throw new Error('Linux 首版打包需要 Linux x86_64');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(resolve(root,'package.json'));
const serviceOnly=process.argv.includes('--service-only');
const out=resolve(root,'out/linux'); mkdirSync(out,{recursive:true});
run(process.execPath,[serviceOnly?'scripts/build-service.mjs':'scripts/build.mjs'],root);
const service=resolve(out,'pi-bot-service-linux-x64');
prepareRuntime(root,service);
writeFileSync(resolve(service,'pi-bot'),'#!/bin/sh\nPI_BOT_LAUNCHER=$(readlink -f -- "$0") || exit 1\nPI_BOT_RUNTIME_DIR=$(CDPATH= cd -- "$(dirname -- "$PI_BOT_LAUNCHER")" && pwd) || exit 1\nexec "$PI_BOT_RUNTIME_DIR/bin/node" "$PI_BOT_RUNTIME_DIR/cli.mjs" "$@"\n',{mode:0o755});
cpSync(resolve(root,'deploy/linux/pi-bot.service'),resolve(service,'pi-bot.service'));
run('tar',['-czf',resolve(out,'pi-bot-service-linux-x64.tar.gz'),'-C',out,'pi-bot-service-linux-x64'],root);
if (!serviceOnly) {
  const runtime=resolve(root,'apps/desktop/runtime');
  rmSync(runtime,{recursive:true,force:true}); cpSync(service,runtime,{recursive:true, verbatimSymlinks:true});
  const electron=require('electron');
  if (!electron) throw new Error('请先安装 Electron 运行时');
  run(resolve(root,'node_modules/.bin/electron-forge'),['package','--platform','linux','--arch','x64'],resolve(root,'apps/desktop'));
  run('tar',['-czf',resolve(out,'pi-bot-desktop-linux-x64.tar.gz'),'-C',resolve(root,'apps/desktop/out'),'Pi Bot-linux-x64'],root);
}
console.log(`Linux packages: ${out}`);
