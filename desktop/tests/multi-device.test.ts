import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentFactory } from '@pi-bot/agent';
import { createApp } from '../../server/src/app.js';
import { createRunner } from '../../server/src/runner.js';
import { Database } from '../../server/src/db.js';
import { Hub } from '../../server/src/hub.js';
import { Worker } from '../../server/src/worker.js';
import { settings } from '../../server/src/config.js';
import { TEST_DB, resetDatabase, tempDir, vaultFile, eventually } from '../../server/tests/helpers.js';
import { Application } from '../packages/service/src/application.js';
import { FileCredentials } from '../packages/service/src/keychain.js';
import { callerRun } from '../../server/src/agents.js';
import { insertRun } from '../../server/src/bots.js';
import { signer } from '../packages/service/src/cloud.js';
import WebSocket from 'ws';

test('independent computers route files, delegation, approvals and offline queues to the bound device', {skip:!TEST_DB,timeout:60000}, async t => {
  await resetDatabase(TEST_DB!);
  const dir=tempDir(), hub=new Hub(), executions:string[]=[], events:Record<string,string[]>={'linux-a':[],'linux-b':[]};
  const factory=(label:string):AgentFactory=>async o=>({
    tools:o.tools.map(t=>t.name),setApiKey:async()=>{},dispose(){},abort:async()=>{},
    prompt:async text=>{
      const tool=async(name:string,args:object)=>{
        const target=o.tools.find(t=>t.name===name); assert.ok(target,`missing ${name}`);
        return target.execute(randomUUID(),args,undefined,undefined,{} as any);
      };
      if (text.startsWith('delegate:') && o.tools.some(t=>t.name==='start_task')) {
        await tool('ask_agent',{agent:text.slice(9),task:'write:delegated.txt',wait:false}); return 'delegated';
      }
      if (text === 'cloud:search' && o.tools.some(t=>t.name==='start_task')) {
        await tool('start_task',{title:'Cloud search',task:'cloud:search',execution:'cloud'}); return 'queued cloud search';
      }
      if ((text.startsWith('write:') || text.startsWith('outside:')) && o.tools.some(t=>t.name==='start_task')) {
        await tool('start_task',{title:text,task:text}); return 'queued';
      }
      const command = text.split('\n').find(line=>/^(write|outside):/.test(line)) ?? text;
      if (command.startsWith('write:')) {
        executions.push(label); await tool('write_file',{path:command.slice(6),content:label});
        await tool('run_command',{command:'printf runtime-ok'}); return `written:${label}`;
      }
      if (command.startsWith('outside:')) {
        await tool('request_outside_access',{path:command.slice(8),reason:'test explicit outside access'}); return `approved:${label}`;
      }
      return `reply:${label}`;
    },
  });
  const secret='r'.repeat(40), runner=await createRunner({token:secret,dir:join(dir.path,'runner'),factory:factory('cloud')});
  await runner.listen({host:'127.0.0.1',port:0});
  const env={PI_BOT_DATABASE_URL:TEST_DB,PI_BOT_ADMIN_PASSWORD:'test-password',PI_BOT_JWT_SECRET:'j'.repeat(40),PI_BOT_VAULT_FILE:vaultFile(dir.path),PI_BOT_RUNNER_TOKEN:secret,PI_BOT_RUNNER_URL:`http://127.0.0.1:${(runner.server.address() as any).port}`,PI_BOT_WORKER_POLL_SECONDS:'0.02'};
  const db=new Database(TEST_DB!),app=await createApp(settings(env),db,hub);
  await app.listen({host:'127.0.0.1',port:0});
  const base=`http://127.0.0.1:${(app.server.address() as any).port}`;
  const workerDb=new Database(TEST_DB!),worker=new Worker(workerDb,settings({...env,PI_BOT_INTERNAL_URL:base}));
  const loop=worker.runForever();
  const computer=(name:string)=>new Application({dataDir:join(dir.path,name,'data'),libraryRoot:join(dir.path,name,'files'),credentials:new FileCredentials(join(dir.path,name,'data','secrets.json')),emit:e=>events[name].push(e.type),factory:factory(name),backoff:{baseMs:10,maxMs:50}});
  const a=computer('linux-a'),b=computer('linux-b');
  t.after(async()=>{worker.stop();await a.shutdown();await b.shutdown();await loop;await workerDb.close();await app.close();await runner.close();dir.cleanup();});
  const login={serverUrl:base,username:'admin',password:'test-password'};
  await a.login({...login,label:'Linux A'}); await b.login({...login,label:'Linux B'});
  await eventually(()=>a.state().connection==='online' && b.state().connection==='online');
  const aid=a.state().deviceId!,bid=b.state().deviceId!;
  assert.notEqual(aid,bid); assert.equal(hub.count(),2);
  await b.login({...login,label:'Linux B'});
  await eventually(()=>b.state().connection==='online');
  assert.equal(b.state().deviceId,bid,'logging in again reuses the device identity');
  assert.equal(hub.count(),2);
  const token=(await (await fetch(`${base}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(login)})).json() as any).access_token;
  const api=async(method:string,path:string,body?:object)=>{
    const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    return {status:r.status,data:await r.json() as any};
  };
  assert.equal((await api('POST','/admin/api/models',{name:'test',base_url:'http://127.0.0.1:1/v1',provider_model:'test',api_key:'test-only',context_window:32000,max_tokens:1000})).status,200);
  const botA=(await api('POST','/bots',{name:'Bot A',execution_device_id:aid})).data;
  const botB=(await api('POST','/bots',{name:'Bot B',execution_device_id:bid})).data;
  const send=async(id:string,text:string)=>{const r=await api('POST',`/bots/${id}/messages`,{text,request_id:randomUUID()});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.run;};
  const fileA=join(dir.path,'linux-a/files',botA.slug,'a.txt'), fileB=join(dir.path,'linux-b/files',botB.slug,'b.txt');
  await Promise.all([send(botA.id,'write:a.txt'),send(botB.id,'write:b.txt')]);
  await eventually(()=>existsSync(fileA)&&existsSync(fileB));
  assert.equal(readFileSync(fileA,'utf8'),'linux-a'); assert.equal(readFileSync(fileB,'utf8'),'linux-b');
  assert.equal(existsSync(join(dir.path,'linux-b/files',botA.slug,'a.txt')),false);
  const files=await api('GET',`/bots/${botA.id}/files/content?path=a.txt`); assert.equal(files.data.content,'linux-a');
  await assert.rejects(b.call('openLibrary',{id:botA.id}),/另一台/);
  await send(botA.id,`delegate:${botB.id}`);
  await eventually(()=>existsSync(join(dir.path,'linux-b/files',botB.slug,'delegated.txt')));
  const outside=join(dir.path,'outside');mkdirSync(outside);
  await send(botB.id,`outside:${outside}`);
  const approval=await eventually(async()=>{const r=await api('GET',`/bots/${botB.id}`);return r.data.pending_approvals[0];});
  const approvalRun=await db.tx(tx=>tx.get('bot_runs',approval.run_id));
  await assert.rejects(db.tx(tx=>callerRun(tx,approvalRun.user_id,{sub:approvalRun.user_id,src:'device',bot:botB.id,did:aid},approvalRun.run_id)));
  assert.equal((await api('PATCH',`/bots/${botB.id}`,{execution_device_id:aid})).status,409);
  assert.equal((await api('POST',`/approvals/${approval.id}`,{decision:'approve'})).status,200);
  await eventually(async()=> (await db.tx(tx=>tx.get('bot_runs',approval.run_id))).status==='completed');
  // Simulate a replacement connection while the original has an interrupted
  // operation. The old run must finish before the replacement can accept work.
  await eventually(async () => !(await db.tx(tx => tx.one("SELECT 1 FROM bot_runs WHERE bot_id=$1 AND lane='conversation' AND status IN ('running','waiting_approval')", [botA.id]))));
  const interrupted = await db.tx(async tx => {
    const r = await insertRun(tx,{userId:a.state().user!.id,botId:botA.id,requestId:randomUUID(),text:'interrupted',computer:{deviceId:aid}});
    await tx.rows("UPDATE bot_runs SET status='running' WHERE run_id=$1",[r.run_id]);
    return r;
  });
  const privateKey = await new FileCredentials(join(dir.path,'linux-a/data/secrets.json')).get(aid);
  assert.ok(privateKey);
  const replacement = new WebSocket(base.replace('http:','ws:')+'/ws/device',{headers:signer(aid,privateKey)('GET','/ws/device',Buffer.alloc(0))});
  t.after(()=>replacement.terminate());
  await new Promise<void>((resolve,reject)=>{
    replacement.once('error',reject);
    replacement.on('message',raw=>{if(JSON.parse(raw.toString()).type==='hello')resolve();});
  });
  assert.equal((await db.tx(tx=>tx.get('bot_runs',interrupted.run_id))).status,'failed');
  await a.shutdown(); replacement.terminate();
  await eventually(()=>!hub.device(a.state().user!.id,aid));
  await a.start(); await eventually(()=>a.state().connection==='online');
  const changesBeforeDisconnect=events['linux-b'].filter(e=>e==='bots').length;
  await a.shutdown(); await eventually(()=>!hub.device(a.state().user!.id,aid));
  await eventually(()=>events['linux-b'].filter(e=>e==='bots').length>changesBeforeDisconnect);
  assert.equal(hub.online(b.state().user!.id),true);
  const offline=await send(botA.id,'write:offline.txt'); assert.equal(offline.executor,'cloud');
  const queued=await eventually(async()=>db.tx(tx=>tx.one("SELECT * FROM agent_tasks WHERE target_bot_id=$1 AND task='write:offline.txt'",[botA.id])));
  assert.equal(queued.device_id,aid); assert.equal(queued.status,'queued');
  assert.equal((await api('GET',`/bots/${botA.id}/files`)).status,503);
  assert.equal(existsSync(join(dir.path,'linux-b/files',botA.slug,'offline.txt')),false);
  await a.start(); await eventually(()=>existsSync(join(dir.path,'linux-a/files',botA.slug,'offline.txt')));
  await eventually(async()=> (await db.tx(tx=>tx.get('agent_tasks',queued.task_id))).status==='completed');
  assert.equal(executions.filter(x=>x==='linux-a').length,2);
  await a.shutdown(); await eventually(()=>!hub.device(a.state().user!.id,aid));
  for (const n of [1,2,3]) await send(botA.id,`write:revoked-${n}.txt`);
  await eventually(async()=> (await db.tx(tx=>tx.rows("SELECT * FROM agent_tasks WHERE target_bot_id=$1 AND task LIKE 'write:revoked-%'",[botA.id]))).length===3);
  const backlog=await db.tx(tx=>tx.rows("SELECT * FROM agent_tasks WHERE target_bot_id=$1 AND task LIKE 'write:revoked-%'",[botA.id]));
  assert.ok(backlog.some(t=>!t.child_run_id),'capacity-limited tasks have no child run yet');
  await send(botA.id,'cloud:search');
  await eventually(async()=>db.tx(tx=>tx.one("SELECT 1 FROM agent_tasks WHERE target_bot_id=$1 AND task='cloud:search' AND execution='cloud' AND status='completed'",[botA.id])));
  assert.equal((await db.tx(tx=>tx.rows("SELECT * FROM agent_tasks WHERE target_bot_id=$1 AND task LIKE 'write:revoked-%' AND status='queued'",[botA.id]))).length,3,'offline file tasks do not block cloud work or leave their device');
  assert.equal((await api('POST',`/devices/${aid}/revoke`,{})).status,200);
  await eventually(async()=> (await db.tx(tx=>tx.rows("SELECT * FROM agent_tasks WHERE target_bot_id=$1 AND task LIKE 'write:revoked-%'",[botA.id]))).every(t=>t.status==='failed'));
  await a.start();
  await eventually(()=>a.state().connection==='revoked');
  await a.logout(); assert.equal(a.state().connection,'signed_out','a revoked device can clear its local login');
  assert.equal(b.state().connection,'online');
  const list=(await api('GET','/devices')).data;assert.equal(list.length,2);assert.ok(list.find((d:any)=>d.id===aid).revoked_at);
});
