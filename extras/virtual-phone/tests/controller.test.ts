import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneController, phoneEvent } from '../src/index.js';

test('phone is opt-in; rejects untrusted config and unsafe inputs', async () => {
 const root=mkdtempSync(join(tmpdir(),'phone-'));
 const phone=new PhoneController(join(root,'phone.json'));
 try {
  assert.deepEqual(await phone.call('phone.status',{}),{available:false,occupied:false});
  await assert.rejects(phone.call('phone.acquire',{}),/显式启用/);
  const cfg={enabled:true,adbPath:'/bin/true',ffmpegPath:'/bin/true',lockPath:join(root,'lock'),serial:'emulator-5556',adbPort:5038};
  writeFileSync(join(root,'phone.json'),JSON.stringify(cfg),{mode:0o644});
  chmodSync(join(root,'phone.json'),0o644);
  assert.deepEqual(await phone.call('phone.status',{}),{available:false,occupied:false});
  chmodSync(join(root,'phone.json'),0o600);
  assert.equal((await phone.call('phone.status',{}) as any).available,true);
  const {sessionId}=await phone.call('phone.acquire',{}) as any;
  await assert.rejects(phone.call('phone.acquire',{}),/人工控制/);
  await assert.rejects(phone.call('phone.frame',{sessionId:'00000000-0000-4000-8000-000000000000'}),/失效/);
  await assert.rejects(phone.call('phone.input',{sessionId,event:{type:'tap',x:720,y:0}}),/参数/);
  await assert.rejects(phone.call('phone.input',{sessionId,event:{type:'text',text:'secret\ncommand'}}),/参数/);
  assert.deepEqual(await phone.call('phone.input',{sessionId,event:{type:'text',text:"a ' ; $(false) %s"}}),{ok:true});
  await phone.call('phone.release',{sessionId});
  await assert.rejects(phone.call('phone.frame',{sessionId}),/失效/);
  assert.equal(phoneEvent.safeParse({type:'key',code:26}).success,false);
 } finally { phone.close(); await new Promise(r=>setTimeout(r,100)); rmSync(root,{recursive:true,force:true}); }
});

test('phone exclusive flock blocks other controller and disconnect releases',async()=>{
 const root=mkdtempSync(join(tmpdir(),'phone-lock-'));
 const cfg=join(root,'phone.json');
 writeFileSync(cfg,JSON.stringify({enabled:true,adbPath:'/bin/true',ffmpegPath:'/bin/true',lockPath:join(root,'lock'),serial:'emulator-5556',adbPort:5038}),{mode:0o600});
 const a=new PhoneController(cfg),b=new PhoneController(cfg);
 try {
  await a.call('phone.acquire',{});
  await assert.rejects(b.call('phone.acquire',{}),/占用/);
  a.release(); await new Promise(r=>setTimeout(r,150));
  assert.ok((await b.call('phone.acquire',{}) as any).sessionId);
 } finally {a.close();b.close();await new Promise(r=>setTimeout(r,100));rmSync(root,{recursive:true,force:true});}
});

test('expired idle session releases lock and rejects further input',async()=>{
 const root=mkdtempSync(join(tmpdir(),'phone-expire-')),cfg=join(root,'phone.json');
 writeFileSync(cfg,JSON.stringify({enabled:true,adbPath:'/bin/true',ffmpegPath:'/bin/true',lockPath:join(root,'lock'),serial:'emulator-5556',adbPort:5038}),{mode:0o600});
 const phone=new PhoneController(cfg);const now=Date.now;
 try{
  const {sessionId}=await phone.call('phone.acquire',{}) as any;
  Date.now=()=>now()+46000;
  await assert.rejects(phone.call('phone.input',{sessionId,event:{type:'key',code:4}}),/失效/);
  await new Promise(r=>setTimeout(r,1100));
  assert.equal((await phone.call('phone.status',{}) as any).occupied,false);
 }finally{Date.now=now;phone.close();await new Promise(r=>setTimeout(r,100));rmSync(root,{recursive:true,force:true});}
});


test('read-only preview does not take lock, suspend automation or keep a control lease alive',async()=>{
 const root=mkdtempSync(join(tmpdir(),'phone-preview-')),cfg=join(root,'phone.json');
 const fake=join(root,'capture.cjs');
 writeFileSync(fake,`#!${process.execPath}
if(process.argv.includes('screencap')){const b=Buffer.alloc(24);b.writeUInt32BE(720,16);b.writeUInt32BE(1280,20);process.stdout.write(b);}
else if(process.argv.includes('pipe:1')){process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('jpeg-fixture'));}
else process.stdout.write('device');
`,{mode:0o700});
 writeFileSync(cfg,JSON.stringify({enabled:true,adbPath:fake,ffmpegPath:fake,lockPath:join(root,'lock'),serial:'emulator-5556',adbPort:5038}),{mode:0o600});
 let acquired=0,released=0;
 const a=new PhoneController(cfg,{acquired:async()=>{acquired++;},released:()=>{released++;}}),b=new PhoneController(cfg);
 const now=Date.now;
 try{
  const frame=await a.call('phone.preview',{}) as any;
  assert.equal(frame.mime,'image/jpeg');assert.equal(frame.width,720);assert.equal(frame.height,1280);
  assert.equal(Buffer.from(frame.data,'base64').toString(),'jpeg-fixture');
  assert.equal(acquired,0);assert.equal((await a.call('phone.status',{}) as any).occupied,false);
  const {sessionId}=await a.call('phone.acquire',{}) as any;
  assert.equal(acquired,1);
  assert.ok(await b.call('phone.preview',{})); // another viewer never needs flock
  assert.ok(await a.call('phone.preview',{}));
  assert.equal(acquired,1);assert.equal(released,0);
  await assert.rejects(a.call('phone.preview',{sessionId}),/控制参数/);
  await assert.rejects(a.call('phone.input',{event:{type:'key',code:4}}),/失效/);
  Date.now=()=>now()+46000;
  assert.ok(await a.call('phone.preview',{}));
  await assert.rejects(a.call('phone.input',{sessionId,event:{type:'key',code:4}}),/失效/);
  a.release();assert.equal(released,1);
  assert.ok(await a.call('phone.preview',{}));
  assert.ok((await b.call('phone.acquire',{}) as any).sessionId);
 }finally{Date.now=now;a.close();b.close();await new Promise(r=>setTimeout(r,100));rmSync(root,{recursive:true,force:true});}
});

test('failed frame/input and unknown RPC never renew idle; successful operations do', async () => {
 const root=mkdtempSync(join(tmpdir(),'phone-renew-')),cfg=join(root,'phone.json');
 const fake=join(root,'fake.cjs'),flag=join(root,'fail');
 writeFileSync(fake,`#!${process.execPath}
const {existsSync}=require('node:fs');
if(existsSync(${JSON.stringify(flag)}))process.exit(1);
if(process.argv.includes('screencap')){const b=Buffer.alloc(24);b.writeUInt32BE(720,16);b.writeUInt32BE(1280,20);process.stdout.write(b);}
else if(process.argv.includes('pipe:1')){process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('jpeg-fixture'));}
else {process.stdin.resume();process.stdout.write('device');}
`,{mode:0o700});
 writeFileSync(cfg,JSON.stringify({enabled:true,adbPath:fake,ffmpegPath:fake,lockPath:join(root,'lock'),serial:'emulator-5556',adbPort:5038}),{mode:0o600});
 const phone=new PhoneController(cfg),now=Date.now;let elapsed=0;
 try {
  Date.now=()=>now()+elapsed;
  const {sessionId}=await phone.call('phone.acquire',{}) as any;
  const original=(phone as any).lease.idle;
  elapsed=20_000;
  await phone.call('phone.frame',{sessionId});
  const renewed=(phone as any).lease.idle;
  assert.ok(renewed>original);
  elapsed=40_000;
  writeFileSync(flag,'fail');
  await assert.rejects(phone.call('phone.frame',{sessionId}),/失败|超时/);
  await assert.rejects(phone.call('phone.input',{sessionId,event:{type:'key',code:4}}),/失败|超时/);
  await assert.rejects(phone.call('phone.unsupported',{sessionId}),/不支持/);
  assert.equal((phone as any).lease.idle,renewed);
  rmSync(flag);
  elapsed=66_000;
  await assert.rejects(phone.call('phone.input',{sessionId,event:{type:'key',code:4}}),/失效/);
 } finally {Date.now=now;phone.close();await new Promise(r=>setTimeout(r,100));rmSync(root,{recursive:true,force:true});}
});

test('closed controller cannot reacquire a lease without an expiry timer', async () => {
 const phone = new PhoneController('/nonexistent/phone.json');
 phone.close();
 phone.close(); // shutdown is idempotent
 await assert.rejects(phone.call('phone.acquire', {}), /已关闭/);
 await assert.rejects(phone.call('phone.preview', {}), /已关闭/);
});

test('ADB always pins the explicit local host, configured port and serial without discovery or fallback', async () => {
 const root=mkdtempSync(join(tmpdir(),'phone-target-')),cfg=join(root,'phone.json');
 const fake=join(root,'adb.cjs'),log=join(root,'argv.jsonl');
 writeFileSync(fake,`#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');
process.stdin.resume();process.stdout.write('device');
`,{mode:0o700});
 const config={enabled:true,adbPath:fake,ffmpegPath:'/bin/true',lockPath:join(root,'lock'),serial:'test-device-42',adbPort:15039};
 const save=()=>writeFileSync(cfg,JSON.stringify(config),{mode:0o600});
 save(); const phone=new PhoneController(cfg);
 try {
  const status=await phone.call('phone.status',{}) as any;
  assert.equal(status.available,true);
  assert.match(status.label,/test-device-42.*15039/);
  const {sessionId}=await phone.call('phone.acquire',{}) as any;
  await phone.call('phone.input',{sessionId,event:{type:'key',code:4}});
  const {readFileSync}=await import('node:fs');
  const calls=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.length,3);
  for(const args of calls) assert.deepEqual(args.slice(0,6),['-H','127.0.0.1','-P','15039','-s','test-device-42']);
  config.serial=''; save();
  await assert.rejects(phone.call('phone.input',{sessionId,event:{type:'key',code:4}}),/显式启用/);
  assert.equal((phone as any).lease,undefined);
  assert.equal(readFileSync(log,'utf8').trim().split('\n').length,3);
 } finally {phone.close();await new Promise(r=>setTimeout(r,100));rmSync(root,{recursive:true,force:true});}
});

test('configuration changes invalidate a lease before preview, frame or input can target another device', async () => {
 for(const method of ['phone.preview','phone.frame','phone.input']) {
  const root=mkdtempSync(join(tmpdir(),'phone-config-')),cfg=join(root,'phone.json');
  const config={enabled:true,adbPath:'/bin/true',ffmpegPath:'/bin/true',lockPath:join(root,'lock'),serial:'device-a',adbPort:15039};
  const save=()=>writeFileSync(cfg,JSON.stringify(config),{mode:0o600});
  save(); const phone=new PhoneController(cfg);
  try {
   const {sessionId}=await phone.call('phone.acquire',{}) as any;
   config.serial='device-b';config.adbPort=15040;config.lockPath=join(root,'other-lock');save();
   await assert.rejects(phone.call(method,method==='phone.preview'?{}:{sessionId,event:{type:'key',code:4}}),/配置已变更/);
   assert.equal((phone as any).lease,undefined);
   await assert.rejects(phone.call('phone.input',{sessionId,event:{type:'key',code:4}}),/失效/);
   assert.ok((await phone.call('phone.acquire',{}) as any).sessionId);
  } finally {phone.close();await new Promise(r=>setTimeout(r,100));rmSync(root,{recursive:true,force:true});}
 }
});

test('release works after disabling configuration; changes during acquisition fail closed', async () => {
 const root=mkdtempSync(join(tmpdir(),'phone-disable-')),cfg=join(root,'phone.json');
 const config={enabled:true,adbPath:'/bin/true',ffmpegPath:'/bin/true',lockPath:join(root,'lock'),serial:'device-a',adbPort:15039};
 const save=()=>writeFileSync(cfg,JSON.stringify(config),{mode:0o600});
 save();const phone=new PhoneController(cfg);
 try {
  const {sessionId}=await phone.call('phone.acquire',{}) as any;
  rmSync(cfg);
  assert.deepEqual(await phone.call('phone.release',{sessionId}),{released:true});
 } finally {phone.close();}
 save();const changing=new PhoneController(cfg,{acquired:async()=>{config.serial='device-b';save();},released:()=>{}});
 try {
  await assert.rejects(changing.call('phone.acquire',{}),/配置已变更/);
  assert.equal((changing as any).lease,undefined);
 } finally {changing.close();await new Promise(r=>setTimeout(r,100));rmSync(root,{recursive:true,force:true});}
});
