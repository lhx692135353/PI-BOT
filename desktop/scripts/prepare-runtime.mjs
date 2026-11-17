import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export function run(command,args,cwd) {
  const result=spawnSync(command,args,{cwd,stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status!==0) throw new Error(`${command} failed (${result.status})`);
}
export function prepareRuntime(root,runtime) {
  const require=createRequire(resolve(root,'package.json'));
  const manifests=['package.json','../packages/agent/package.json','../packages/a2ui/package.json'].map(file=>require(resolve(root,file)));
  const deps=['@earendil-works/pi-ai','@earendil-works/pi-coding-agent','playwright','typebox','ws','zod','@a2ui/web_core','zod-to-json-schema','pdfjs-dist','mammoth','docx','exceljs','jszip'];
  rmSync(runtime,{recursive:true,force:true});
  mkdirSync(resolve(runtime,'bin'),{recursive:true}); mkdirSync(resolve(runtime,'licenses'));
  for (const file of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md']) cpSync(resolve(root,'..',file),resolve(runtime,file));
  cpSync(resolve(root,'../packages/agent/src/hermes-memory/LICENSE'),resolve(runtime,'licenses/pi-hermes-memory-LICENSE'));
  cpSync(resolve(root,'../packages/agent/src/pstack-LICENSE'),resolve(runtime,'licenses/pstack-LICENSE'));
  cpSync(process.execPath,resolve(runtime,process.platform==='win32'?'bin/node.exe':'bin/node'));
  for (const file of ['server.mjs','cli.mjs','document-worker.mjs']) cpSync(resolve(root,'packages/service/dist',file),resolve(runtime,file));
  if (process.platform==='win32') cpSync(resolve(root,'native/dist/pi-bot-windows.exe'),resolve(runtime,'pi-bot-windows.exe'));
  if (process.platform==='darwin') cpSync(resolve(root,'native/dist/keychain'),resolve(runtime,'keychain'));
  writeFileSync(resolve(runtime,'package.json'),JSON.stringify({name:'pi-bot-runtime',private:true,type:'module',dependencies:Object.fromEntries(deps.map(name=>[name,manifests.map(m=>m.dependencies?.[name]).find(Boolean)]))},null,2));
  cpSync(resolve(root,'runtime-package-lock.json'),resolve(runtime,'package-lock.json'));
  const npmCli=process.env.npm_execpath;
  if (!npmCli) throw new Error('请通过 npm run 调用打包脚本，以使用当前 npm CLI');
  run(process.execPath,[npmCli,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],runtime);
}
