import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,cpSync,rmSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('client settings exposes updater states through the real renderer bridge, saves drafts, confirms scopes and retries failed decisions', async()=>{
  const here=dirname(fileURLToPath(import.meta.url)),base=join(here,'../test-results');mkdirSync(base,{recursive:true});
  const directory=mkdtempSync(join(base,'client-settings-'));
  try{
    await build({entryPoints:[join(here,'client-settings.harness.tsx')],outfile:join(directory,'settings.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
    writeFileSync(join(directory,'settings.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="settings.css"><div id="root"></div><script src="settings.js"></script>');
    const child=spawn(createRequire(import.meta.url)('electron') as string,['--no-sandbox','--disable-gpu','--headless=new',join(here,'client-settings-runner.mjs')],{windowsHide:true,env:{...process.env,CLIENT_SETTINGS_DIR:directory,ELECTRON_DISABLE_SANDBOX:'1'},stdio:['ignore','pipe','pipe']});
    let errors='';child.stderr.on('data',b=>{errors+=b;});
    const code=await new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
    assert.ok(existsSync(join(directory,'result.json')),`Electron exited ${code}: ${errors.slice(-2000)}`);
    const result=JSON.parse(readFileSync(join(directory,'result.json'),'utf8'));
    assert.equal(code,0,JSON.stringify({result,errors:errors.slice(-1000)}));assert.equal(result.ok,true);
    if(process.env.CLIENT_SETTINGS_SCREENSHOTS){mkdirSync(process.env.CLIENT_SETTINGS_SCREENSHOTS,{recursive:true});for(const name of ['updates-progress.png','updates-ready-and-authorizations.png','saved-authorizations.png'])cpSync(join(directory,name),join(process.env.CLIENT_SETTINGS_SCREENSHOTS,name));}
  }finally{rmSync(directory,{recursive:true,force:true});}
});
