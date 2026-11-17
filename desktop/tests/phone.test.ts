import { test as nodeTest, type TestContext } from 'node:test';
// The implementation invokes /usr/bin/flock; retain full coverage on Linux CI.
const test=(name:string,fn:(t:TestContext)=>void|Promise<void>)=>nodeTest(name,{skip:process.platform!=='linux' && 'Requires Linux /usr/bin/flock'},fn);
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneController } from '../packages/service/src/phone.js';
import { parseInput } from '../packages/protocol/src/index.js';

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
  assert.throws(()=>parseInput('phoneInput',{deviceId:sessionId,sessionId,event:{type:'key',code:26}}));
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

test('human takeover aborts in-flight Pi command and blocks new commands until release',async()=>{
 const {Executor}=await import('../packages/service/src/executor.js');
 const root=mkdtempSync(join(tmpdir(),'phone-executor-'));
 let command:any,ready!:()=>void,finish!:()=>void;
 const loaded=new Promise<void>(resolve=>{ready=resolve;});
 const end=new Promise<void>(resolve=>{finish=resolve;});
 const executor=new Executor({libraryRoot:root,agentDir:join(root,'agent'),proxyUrl:'http://127.0.0.1/llm/v1',llmToken:async()=> 'test',send(){},activity(){},factory:async o=>{
  command=o.tools.find(t=>t.name==='run_command');ready();
  return {tools:[],prompt:async()=>{await end;return 'done';},setApiKey:async()=>{},abort:async()=>{},dispose(){}};
 }});
 const run=executor.start({run_id:'test',executor:'device',bot:{id:'bot',name:'test',slug:'test'},model:{id:'test',name:'test',context_window:1000,max_tokens:100},system:'',history:[],text:'test'});
 try{
  await loaded;
  const pending=command.execute('test',{command:'sleep 30',timeout_seconds:40},undefined,()=>{},{});
  const rejected=assert.rejects(pending,/CANCELLED/);
  await new Promise(r=>setTimeout(r,100));
  await executor.suspendCommands();await rejected;
  await assert.rejects(command.execute('blocked',{command:'echo must-not-run'},undefined,()=>{},{}),/人工接管/);
  executor.resumeCommands();
  const output=await command.execute('after',{command:'printf released'},undefined,()=>{},{});
  assert.match(JSON.stringify(output),/released/);
 }finally{finish();await run;rmSync(root,{recursive:true,force:true});}
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
