import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('timeline clears sent drafts across bot switches and reloads while preserving later edits and failed sends',async()=>{
  const here=dirname(fileURLToPath(import.meta.url)),base=join(here,'../test-results');mkdirSync(base,{recursive:true});
  const directory=mkdtempSync(join(base,'timeline-drafts-'));
  try {
    await build({entryPoints:[join(here,'timeline-drafts.harness.tsx')],outfile:join(directory,'timeline.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}});
    writeFileSync(join(directory,'timeline.html'),'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="timeline.js"></script>');
    const child=spawn(createRequire(import.meta.url)('electron') as string,['--no-sandbox','--disable-gpu','--headless=new',join(here,'timeline-drafts-runner.mjs')],{windowsHide:true,env:{...process.env,TIMELINE_DRAFTS_DIR:directory,ELECTRON_DISABLE_SANDBOX:'1'},stdio:['ignore','pipe','pipe']});
    let errors='';child.stderr.on('data',b=>{errors+=b;});
    const code=await new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
    assert.ok(existsSync(join(directory,'result.json')),`Electron exited ${code}: ${errors.slice(-2000)}`);
    const result=JSON.parse(readFileSync(join(directory,'result.json'),'utf8'));
    assert.equal(code,0,JSON.stringify({result,errors:errors.slice(-1000)}));assert.equal(result.ok,true);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
