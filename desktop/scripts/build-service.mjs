import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspace = { name:'pi-bot-workspace', setup(build) {
  build.onResolve({filter:/^@pi-bot\/agent\/images$/},()=>({path:resolve('../packages/agent/src/images.ts')}));
  build.onResolve({filter:/^zod$/},args=>args.importer.includes('packages/a2ui/')?{path:createRequire(resolve('../packages/a2ui/package.json')).resolve('zod')}:undefined);
  build.onResolve({filter:/^@pi-bot\/(agent|bot-face|a2ui)$/},args=>({path:resolve('../packages',args.path.split('/')[1],'src/index.ts')}));
} };
export async function buildService() {
  await build({entryPoints:{server:'packages/service/src/server.ts',cli:'packages/service/src/cli.ts'},outdir:'packages/service/dist',outExtension:{'.js':'.mjs'},plugins:[workspace],bundle:true,platform:'node',format:'esm',packages:'external',sourcemap:true});
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await buildService();
