import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database, type Row } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { Hub, type DeviceConnection } from '../src/hub.js';
import { settings } from '../src/config.js';
import { createBot, updateBot, insertRun, finishRun } from '../src/bots.js';
import { AgentDispatcher, createTask, startTask } from '../src/agents.js';
import { dispatchDevice, failDeviceRuns } from '../src/runs.js';
import { resolveTaskTarget, taskRouting, RemotePreparationRequired, resourceSchema } from '../src/targets.js';
import { manageGoals, AutomationScheduler, saveGoalDecision } from '../src/automations.js';
import { TEST_DB, resetDatabase, eventually } from './helpers.js';

test('routing rejects ambiguity before insertion and keeps an explicit destination through dispatch', {skip:!TEST_DB}, async t => {
  await resetDatabase(TEST_DB!);
  const db=new Database(TEST_DB!),hub=new Hub(); t.after(()=>db.close()); await migrate(db);
  const user=randomUUID(),a=randomUUID(),b=randomUUID();
  const s=settings({PI_BOT_DATABASE_URL:TEST_DB,PI_BOT_JWT_SECRET:'j'.repeat(40),PI_BOT_ADMIN_PASSWORD:'test-password',PI_BOT_RUNNER_TOKEN:'r'.repeat(40),PI_BOT_REMOTE_BACKEND:'none'});
  await db.tx(async tx=>{
    await tx.insert('users',{user_id:user,username:'routing',password_hash:'unused',role:'user'});
    for(const id of [a,b])await tx.insert('devices',{device_id:id,user_id:user,label:id,public_key:id,platform:'linux'});
    await tx.insert('models',{model_id:randomUUID(),name:'test',base_url:'https://example.com/v1',provider_model:'test',context_window:32000,max_tokens:1000,secret:{},is_default:true});
  });
  const bot=await db.tx(tx=>createBot(tx,user,{name:'Routing',persona:''}));
  const parent=await db.tx(async tx=>{const run=await insertRun(tx,{userId:user,botId:bot.bot_id,requestId:randomUUID(),text:'request',computer:null,sourceClient:'android'});return tx.update('bot_runs',run.run_id,{status:'running'});});
  const claims={sub:user,bot:bot.bot_id,src:'cloud' as const};
  const sends:Row[]=[];
  const connect=(id:string)=>{const c={userId:user,deviceId:id,capabilities:['files','shell'],send(m:Row){sends.push(m);},close(){}};hub.attach(c);return c;};
  connect(b);
  const create=(extra:object)=>db.tx(tx=>createTask(tx,hub,user,claims,{run_id:parent.run_id,kind:'background',task:'work',wait:false,...extra},s));
  await assert.rejects(create({requirements:['shell']}),/执行目标不明确/);
  await assert.rejects(create({device_id:a,requirements:['shell']}),/离线/);
  assert.equal((await db.tx(tx=>tx.one('SELECT count(*) AS n FROM agent_tasks')))!.n,0);
  const legacy=await db.tx(tx=>tx.insert('agent_tasks',{task_id:randomUUID(),user_id:user,parent_run_id:parent.run_id,parent_bot_id:bot.bot_id,target_bot_id:bot.bot_id,depth:0,mode:'report',kind:'background',task:'old pinned resource',status:'queued',execution:'device',operation_target:'pending',routing:{execution:'auto',requirements:['files'],resources:[{target:'device:'+a}]}}));
  await failDeviceRuns(db,a);
  assert.equal((await db.tx(tx=>tx.get('agent_tasks',legacy.task_id))).status,'failed');
  const ca=connect(a);
  const result=await create({device_id:a,requirements:['shell']});
  hub.detach(ca);sends.length=0;
  await dispatchDevice(db,s,hub,result.run!.run_id);
  assert.equal((await db.tx(tx=>tx.get('bot_runs',result.run!.run_id))).status,'failed');
  assert.equal(sends.filter(m=>m.type==='run').length,0);
  assert.equal((await db.tx(tx=>tx.get('bot_runs',result.run!.run_id))).device_id,a);
});

test('routing migration preserves queued destinations, history and checkpoints, and converts goal bindings into preferences',{skip:!TEST_DB},async t=>{
  const {readFile,readdir}=await import('node:fs/promises');
  await resetDatabase(TEST_DB!);const db=new Database(TEST_DB!);t.after(()=>db.close());
  const folder=new URL('../migrations/',import.meta.url), user=randomUUID(), device=randomUUID(), bot=randomUUID(), run=randomUUID(), task=randomUUID(), goal=randomUUID(), automation=randomUUID();
  await db.tx(async tx=>{
    await tx.rows('CREATE TABLE schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
    for(const file of (await readdir(folder)).filter(f=>f.endsWith('.sql') && f<'0019').sort()){
      await tx.rows(await readFile(new URL(file,folder),'utf8'));await tx.rows('INSERT INTO schema_migrations(version) VALUES($1)',[file.slice(0,-4)]);
    }
    await tx.insert('users',{user_id:user,username:'migration-user',role:'user',password_hash:'unused'});
    await tx.insert('devices',{device_id:device,user_id:user,label:'Original',public_key:'unused'});
    await tx.insert('bots',{bot_id:bot,user_id:user,name:'Original',slug:'original',avatar:{},execution_device_id:device});
    await tx.insert('bot_runs',{run_id:run,trace_id:run,user_id:user,bot_id:bot,request_id:'old',executor:'device',device_id:device,status:'queued',user_message_id:randomUUID(),assistant_message_id:randomUUID(),lane:'task',operation_target:'device:'+device});
    await tx.insert('agent_tasks',{task_id:task,user_id:user,parent_run_id:run,parent_bot_id:bot,target_bot_id:bot,mode:'report',depth:0,kind:'background',task:'old queued',status:'queued',execution:'device',device_id:device,operation_target:'device:'+device});
    await tx.insert('bot_goals',{goal_id:goal,user_id:user,bot_id:bot,title:'Continue',statement:'Continue work',operation_target:'device:'+device,checkpoint:{completed:['read data']},authorization_scope:'Only own library'});
    await tx.insert('bot_automations',{automation_id:automation,user_id:user,bot_id:bot,kind:'review',title:'Review',goal:'Review work',operation_target:'device:'+device,checkpoint:{completed:['read data']}});
  });
  await migrate(db);await migrate(db);
  await db.tx(async tx=>{
    const queued=await tx.get('agent_tasks',task);assert.equal(queued.device_id,device);assert.equal(queued.routing,null);
    const oldRun=await tx.get('bot_runs',run);assert.equal(oldRun.status,'queued');assert.equal(oldRun.device_id,device);assert.equal(oldRun.routing,null);
    const saved=await tx.get('bot_goals',goal);assert.equal(saved.routing.execution,'auto');assert.equal(saved.routing.preferred_device_id,device);assert.equal(saved.authorization_scope,'Only own library');assert.deepEqual(saved.checkpoint,{completed:['read data']});assert.equal(saved.checkpoint_target,'device:'+device);
    assert.deepEqual(saved.routing.resources,[{target:'device:'+device}]);
    assert.equal((await tx.get('bot_automations',automation)).operation_target,'device:'+device,'active review keys stay valid');
  });
});

test('cloud worker finalizes queued routing through authenticated API; file reads retain explicitly selected source',{skip:!TEST_DB},async t=>{
  const {createApp}=await import('../src/app.js');
  const {tempDir,vaultFile}=await import('./helpers.js');
  await resetDatabase(TEST_DB!);const dir=tempDir(),db=new Database(TEST_DB!),hub=new Hub();
  const s=settings({PI_BOT_DATABASE_URL:TEST_DB,PI_BOT_JWT_SECRET:'j'.repeat(40),PI_BOT_ADMIN_PASSWORD:'test-password',PI_BOT_RUNNER_TOKEN:'r'.repeat(40),PI_BOT_VAULT_FILE:vaultFile(dir.path),PI_BOT_REMOTE_BACKEND:'none'});
  const app=await createApp(s,db,hub);t.after(async()=>{await app.close();dir.cleanup();});
  const login=(await app.inject({method:'POST',url:'/auth/login',payload:{username:'admin',password:'test-password'}})).json(),user=login.user.id;
  const api=async(method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+login.access_token}});
  await api('POST','/admin/api/models',{name:'test',base_url:'https://example.com/v1',provider_model:'test',api_key:'test-key',context_window:32000,max_tokens:1000});
  const a=randomUUID(),b=randomUUID(),bot=(await api('POST','/bots',{name:'No binding',execution_device_id:a})).json();assert.equal(bot.execution_device_id,null);
  await db.tx(async tx=>{for(const id of [a,b]) await tx.insert('devices',{device_id:id,user_id:user,label:id,public_key:id});});
  const sends:any[]=[];
  for(const id of [a,b]) hub.attach({deviceId:id,userId:user,capabilities:['files','shell'],close(){},send(message){sends.push({id,message});if(message.type==='rpc')queueMicrotask(()=>hub.resolveRpc(id,{id:message.id,ok:true,result:{path:message.params.path,kind:'text',content:id,entries:[]}}));}});
  const queued=await db.tx(tx=>insertRun(tx,{userId:user,botId:bot.id,requestId:randomUUID(),text:'queued task',computer:null,lane:'task',operationTarget:'cloud',routing:{execution:'device',device_id:a,requirements:['files','shell'],resources:[]}}));
  assert.equal((await app.inject({method:'POST',url:`/internal/runs/${queued.run_id}/claim`,payload:{worker_id:randomUUID()}})).statusCode,401);
  const response=await app.inject({method:'POST',url:`/internal/runs/${queued.run_id}/claim`,headers:{authorization:'Bearer '+s.runnerToken},payload:{worker_id:randomUUID()}});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().run,null);
  assert.equal((await db.tx(tx=>tx.get('bot_runs',queued.run_id))).device_id,a,'a newly available computer replaces queued cloud selection');
  await dispatchDevice(db,s,hub,queued.run_id);
  // The live dispatcher may already hold the claim while constructing context.
  await eventually(()=>sends.filter(x=>x.message.type==='run').length===1);
  await dispatchDevice(db,s,hub,queued.run_id);assert.equal(sends.filter(x=>x.message.type==='run').length,1);
  const sources=(await api('GET',`/bots/${bot.id}/files/sources`)).json().sources;assert.equal(sources.length,2);
  const list=(await api('GET',`/bots/${bot.id}/files?target=device:${b}`)).json();assert.equal(list.target,'device:'+b);
  const content=(await api('GET',`/bots/${bot.id}/files/content?target=device:${b}&path=data.csv`)).json();assert.equal(content.content,b);assert.equal(content.target,'device:'+b);
  assert.equal((await api('GET',`/bots/${bot.id}/files?target=device:${randomUUID()}`)).statusCode,404);
  const patch=await api('PATCH',`/bots/${bot.id}`,{execution_device_id:b});assert.equal(patch.statusCode,200);assert.equal(patch.json().execution_device_id,null);
});

test('ownership, capabilities, preflight and outside-library authorization remain enforced',{skip:!TEST_DB},async t=>{
  await resetDatabase(TEST_DB!);const db=new Database(TEST_DB!),hub=new Hub();t.after(()=>db.close());await migrate(db);
  const user=randomUUID(),otherUser=randomUUID(),a=randomUUID(),b=randomUUID();
  const s=settings({PI_BOT_DATABASE_URL:TEST_DB,PI_BOT_JWT_SECRET:'j'.repeat(40),PI_BOT_REMOTE_BACKEND:'none'});
  await db.tx(async tx=>{for(const [id,name] of [[user,'owner'],[otherUser,'other']])await tx.insert('users',{user_id:id,username:name,role:'user',password_hash:'unused'});for(const id of [a,b])await tx.insert('devices',{device_id:id,user_id:user,label:id,public_key:id});});
  const bot=await db.tx(tx=>createBot(tx,user,{name:'Safe',persona:''}));
  const connect=(id:string,capabilities=['files','shell','preflight-v1'],available=true,reason?:string)=>{const c={deviceId:id,userId:user,capabilities,close(){},send(message:Row){if(message.type==='rpc')queueMicrotask(()=>hub.resolveRpc(id,{id:message.id,ok:true,result:{available,reason}}));}};hub.attach(c);return c;};
  let ca=connect(a);connect(b);
  const route=(execution:'auto'|'device'|'cloud'|'remote'='device')=>({execution,device_id:a,requirements:['files','shell'],resources:[] as {target:string;path?:string}[]});
  await t.test('undeclared capability and missing resources are never assumed available',async()=>{
    assert.equal(resourceSchema.safeParse({target:'device:'+ '-'.repeat(36)}).success,false);
    ca=connect(a,['files']);
    await assert.rejects(db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,route())),/shell/);
    ca=connect(a,undefined,false);
    await assert.rejects(db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route(),resources:[{target:'device:'+a,path:'project/data.csv'}]})),/资源检查未通过/);
    ca=connect(a);
    assert.equal((await db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route(),resources:[{target:'device:'+a,path:'project/data.csv'}]}))).device_id,a);
    await assert.rejects(db.tx(tx=>taskRouting(tx,otherUser,{}, {resources:[{target:'device:'+a}]})),/不属于当前账号/);
  });
  await t.test('an online device reports missing capabilities and inaccessible resources without claiming it is offline',async()=>{
    ca=connect(a,['files']);
    await assert.rejects(db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route('device'),device_id:a})),error=>{
      assert.match((error as Error).message,/电脑已连接.*shell/);assert.doesNotMatch((error as Error).message,/离线/);return true;
    });
    ca=connect(a,undefined,false,'outside_library');
    const resources=[{target:'device:'+a,path:'/outside/project'}];
    await assert.rejects(db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route('device'),device_id:a,resources})),/电脑已连接.*request_outside_access/);
    await assert.rejects(db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route(),resources})),/电脑已连接.*request_outside_access/);
    assert.equal((await db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route('device'),device_id:a,resources:[{target:'device:'+a}]}))).device_id,a,'a task may request permission on the same device without pre-reading outside resources');
    ca=connect(a,undefined,false,'missing');
    await assert.rejects(db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route('device'),device_id:a,resources})),/电脑已连接.*不存在.*不要省略/);
    ca=connect(a,undefined,false);
    await assert.rejects(db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route('device'),device_id:a,resources})),/电脑已连接.*路径检查未通过/,'old clients without a reason remain supported');
    ca=connect(a);
  });

});
