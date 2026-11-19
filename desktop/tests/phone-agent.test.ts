import test from 'node:test';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Executor, type RunContext } from '../packages/service/src/executor.js';
import { PhoneController } from '../packages/service/src/phone.js';
import { ResponseStream, realToolOutputs } from '../../packages/agent/tests/responses.js';
const skip=process.platform!=='linux'&&'Configured phone requires Linux/flock';
const jpeg='/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAABQcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAQABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCOAL+Kf//Z';
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'phone-agent-')),path=join(root,'phone.json'),log=join(root,'argv.jsonl');
 const adb=join(root,'adb.cjs'),ffmpeg=join(root,'ffmpeg.cjs');
 writeFileSync(adb,`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args.includes('get-state'))process.stdout.write('device');
else if(args.includes('screencap')){const b=Buffer.alloc(24);b.writeUInt32BE(720,16);b.writeUInt32BE(1280,20);process.stdout.write(b);}
else if(args.some(arg=>arg.includes('slow')))setTimeout(()=>{},30000);
else process.stdout.write('ok');
`,{mode:0o700});
 writeFileSync(ffmpeg,`#!${process.execPath}
process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.from(${JSON.stringify(jpeg)},'base64')));
`,{mode:0o700});
 writeFileSync(path,JSON.stringify({enabled:true,adbPath:adb,ffmpegPath:ffmpeg,lockPath:join(root,'lock'),serial:'assigned-phone',adbPort:15039}),{mode:0o600});
 const run=(lane:'task'|'conversation'='task'):RunContext=>({run_id:'phone-'+lane,executor:'device',lane,bot:{id:'bot',name:'Phone',slug:'phone'},model:{id:'model',name:'Vision',context_window:32000,max_tokens:1000},system:'test',history:[],text:'查看手机后按 Home 键并告诉我结果',observation_enabled:true});
 return {root,path,log,run,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('conversation knows the configured phone but delegates operations without exposing command tools', {skip},async()=>{
 const f=fixture();let options:any;const events:any[]=[];
 const executor=new Executor({libraryRoot:f.root,agentDir:join(f.root,'agent'),phoneConfigPath:f.path,proxyUrl:'http://127.0.0.1/llm/v1',llmToken:async()=> 'test-token',send:e=>events.push(e),activity(){},factory:async o=>{
  options=o;return {tools:[],prompt:async()=> '手机在线，可安排后台操作。',setApiKey:async()=>{},abort:async()=>{},dispose(){}};
 }});
 try {
  await executor.start(f.run('conversation'));
  assert.match(options.systemPrompt,/assigned-phone.*15039.*在线/s);assert.match(options.systemPrompt,/start_task\(execution=device\)/);
  assert.ok(options.tools.some((t:any)=>t.name==='start_task'));
  assert.ok(!options.tools.some((t:any)=>t.name==='run_command'||t.name.startsWith('phone_')));
  assert.equal(events.at(-1).event.state,'completed');
 }finally{executor.stopAll();f.cleanup();}
});
test('real agent command loop sends screenshot image to Responses, operates the pinned phone and omits image diagnostics', {skip},async()=>{
 const f=fixture(),requests:any[]=[],events:any[]=[];let sawImage=false;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const body=raw?JSON.parse(raw):{};
  if(!req.url?.endsWith('/responses')){res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}
  requests.push(body);const count=realToolOutputs(body.input).length;
  const stream=new ResponseStream(res,body.model);
  if(!count)stream.tool('run_command',{command:'phone-adb exec-out screencap -p'},'screenshot');
  else {
   const images = (body.input ?? []).flatMap((item:any) => Array.isArray(item.content) ? item.content : Array.isArray(item.output) ? item.output : []).filter((part:any) => part.type === 'input_image');
   sawImage = images.length > 0;
   for (const image of images) {
    assert.match(image.image_url, /^data:image\/webp;base64,/);
    const data = image.image_url.split(',')[1];
    assert.notEqual(data, jpeg, 'model must not receive the original screenshot bytes');
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    assert.equal(meta.format, 'webp');
    assert.ok(meta.width! <= 1568 && meta.height! <= 1568);
   }
   if(count===1)stream.tool('run_command',{command:'phone-adb shell input keyevent 3'},'home');
   else stream.text(sawImage?'已看到手机画面并返回桌面。':'没有收到图片');
  }
  stream.end();
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const executor=new Executor({libraryRoot:f.root,agentDir:join(f.root,'agent'),phoneConfigPath:f.path,proxyUrl:`http://127.0.0.1:${(server.address() as any).port}/llm/v1`,llmToken:async()=> 'test-proxy-token',send:e=>events.push(e),activity(){}});
 try {
  await executor.start(f.run());
  const done=events.findLast(e=>e.event?.kind==='done')?.event;
  assert.equal(done?.state,'completed',JSON.stringify(done));assert.equal(done.text,'已看到手机画面并返回桌面。');assert.equal(sawImage,true);
  assert.equal(requests.length,3);assert.match(JSON.stringify(requests[0]),/phone-adb/);
  assert.ok(requests[0].tools.some((t:any)=>t.name==='run_command'));
  assert.ok(!requests[0].tools.some((t:any)=>t.name.startsWith('phone_')));
  const calls=readFileSync(f.log,'utf8').trim().split('\n').map(l=>JSON.parse(l));
  assert.ok(calls.some(args=>args.slice(6).join(' ')==="shell -T 'input' 'keyevent' '3'"));
  for(const args of calls)assert.deepEqual(args.slice(0,6),['-H','127.0.0.1','-P','15039','-s','assigned-phone']);
  assert.equal(JSON.stringify(events).includes(jpeg),false,'screenshot leaked into events');
  assert.ok(JSON.stringify(events).includes('omitted'));
 }finally{executor.stopAll();await new Promise<void>(r=>server.close(()=>r()));f.cleanup();}
});

test('manual takeover cancels an agent holding the phone lock, then resumes commands on release', {skip},async()=>{
 const f=fixture();let command:any,ready!:()=>void,finish!:()=>void;
 const loaded=new Promise<void>(r=>ready=r),end=new Promise<void>(r=>finish=r);
 const executor=new Executor({libraryRoot:f.root,agentDir:join(f.root,'agent'),phoneConfigPath:f.path,proxyUrl:'http://127.0.0.1/llm/v1',llmToken:async()=> 'test',send(){},activity(){},factory:async o=>{
  command=o.tools.find(t=>t.name==='run_command');ready();return {tools:[],prompt:async()=>{await end;return 'done';},setApiKey:async()=>{},abort:async()=>{},dispose(){}};
 }});
 const phone=new PhoneController(f.path,{acquired:()=>executor.suspendCommands(),released:()=>executor.resumeCommands()});
 const run=executor.start(f.run());
 try {
  await loaded;
  const pending=command.execute('slow',{command:'phone-adb shell slow'},undefined,()=>{},{});
  const outcome=pending.then(()=> 'completed',(e:Error)=>e.message);
  for(let i=0;i<100&&(!existsSync(f.log)||!readFileSync(f.log,'utf8').includes('slow'));i++)await new Promise(r=>setTimeout(r,20));
  assert.match(readFileSync(f.log,'utf8'),/slow/);
  const {sessionId}=await phone.call('phone.acquire',{}) as any;
  assert.equal(await outcome,'CANCELLED');
  await assert.rejects(command.execute('blocked',{command:'phone-adb get-state'},undefined,()=>{},{}),/人工接管/);
  await phone.call('phone.release',{sessionId});
  await new Promise(r=>setTimeout(r,100));
  assert.equal(JSON.parse((await command.execute('resumed',{command:'phone-adb get-state'},undefined,()=>{},{})).content[0].text).exit_code,0);
 }finally{
  await executor.suspendCommands();phone.close();finish();await run;executor.stopAll();f.cleanup();
 }
});
test('manual suspension aborts in-flight phone commands and rejects further commands until released', {skip},async()=>{
 const f=fixture();let command:any,ready!:()=>void,finish!:()=>void;
 const loaded=new Promise<void>(r=>ready=r),end=new Promise<void>(r=>finish=r);
 const executor=new Executor({libraryRoot:f.root,agentDir:join(f.root,'agent'),phoneConfigPath:f.path,proxyUrl:'http://127.0.0.1/llm/v1',llmToken:async()=> 'test',send(){},activity(){},factory:async o=>{
  command=o.tools.find(t=>t.name==='run_command');ready();return {tools:[],prompt:async()=>{await end;return 'done';},setApiKey:async()=>{},abort:async()=>{},dispose(){}};
 }});
 const run=executor.start(f.run());
 try {
  await loaded;const pending=command.execute('slow',{command:'phone-adb shell slow'},undefined,()=>{},{});
  const rejected=assert.rejects(pending,/CANCELLED/);
  for(let i=0;i<100&&(!existsSync(f.log)||!readFileSync(f.log,'utf8').includes('slow'));i++)await new Promise(r=>setTimeout(r,20));
  await executor.suspendCommands();await rejected;
  await assert.rejects(command.execute('blocked',{command:'phone-adb shell input keyevent 3'},undefined,()=>{},{}),/人工接管/);
  executor.resumeCommands();
  const result=await command.execute('resumed',{command:'phone-adb get-state'},undefined,()=>{},{});
  assert.equal(JSON.parse(result.content[0].text).exit_code,0);
 }finally{finish();await run;executor.stopAll();f.cleanup();}
});
