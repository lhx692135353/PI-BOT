import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { Hub, type DeviceConnection } from '../src/hub.js';
import { settings } from '../src/config.js';
import { createBot, updateBot, insertRun, finishRun } from '../src/bots.js';
import { createTask, startTask } from '../src/agents.js';
import { dispatchDevice, failDeviceRuns } from '../src/runs.js';
import { resolveTaskTarget, taskRouting, RemotePreparationRequired, resourceSchema } from '../src/targets.js';
import { manageGoals, AutomationScheduler, saveGoalDecision } from '../src/automations.js';
import { TEST_DB, resetDatabase } from './helpers.js';

test('task routing uses machines as per-task resources, never Bot identity', {skip:!TEST_DB}, async t => {
  await resetDatabase(TEST_DB!);
  const db=new Database(TEST_DB!), hub=new Hub();
  t.after(()=>db.close());
  await migrate(db);
  const user=randomUUID(), otherUser=randomUUID(), a=randomUUID(), b=randomUUID(), c=randomUUID();
  const s=settings({PI_BOT_DATABASE_URL:TEST_DB,PI_BOT_JWT_SECRET:'j'.repeat(40),PI_BOT_ADMIN_PASSWORD:'test-password',PI_BOT_RUNNER_TOKEN:'r'.repeat(40)});
  const sent: {device:string;message:any}[]=[];
  const connect=(id:string,capabilities=['files','shell','always-on-v1','preflight-v1'],available=true):DeviceConnection=>{
    const connection:DeviceConnection={deviceId:id,userId:user,capabilities,close(){},send(message){
      sent.push({device:id,message});
      if(message.type==='rpc') queueMicrotask(()=>hub.resolveRpc(id,{id:message.id,ok:true,result:{available}}));
    }};
    hub.attach(connection);return connection;
  };
  await db.tx(async tx=>{
    for(const [id,name] of [[user,'routing-user'],[otherUser,'other-user']]) await tx.insert('users',{user_id:id,username:name,password_hash:'unused',role:'user'});
    for(const id of [a,b,c]) await tx.insert('devices',{device_id:id,user_id:user,label:id,public_key:id,platform:'linux'});
    await tx.insert('models',{model_id:randomUUID(),name:'test',base_url:'https://example.com/v1',provider_model:'test',context_window:32000,max_tokens:1000,secret:{},is_default:true});
  });
  const bot=await db.tx(tx=>createBot(tx,user,{name:'Routing',persona:'',execution_device_id:a}));
  const makeParent=async(device=a)=>db.tx(async tx=>{
    const run=await insertRun(tx,{userId:user,botId:bot.bot_id,requestId:randomUUID(),text:'new request',computer:{deviceId:device},sourceClient:'desktop',sourceDeviceId:device,operationTarget:'cloud'});
    return tx.update('bot_runs',run.run_id,{status:'running'});
  });
  let parent=await makeParent();
  const claims={sub:user,bot:bot.bot_id,src:'cloud' as const};
  const route=(execution:'auto'|'device'|'cloud'|'remote'='auto')=>({execution,preferred_device_id:a,requirements:execution==='cloud'?[]:['files','shell'],resources:[]});
  let ca=connect(a), cb=connect(b);
  await t.test('Bot edits ignore deprecated bindings, conversations stay in cloud',async()=>{
    assert.equal(bot.execution_device_id,null);
    await db.tx(tx=>updateBot(tx,user,bot.bot_id,{execution_device_id:c,name:'Renamed'}));
    assert.equal((await db.tx(tx=>tx.get('bots',bot.bot_id))).execution_device_id,null);
    assert.equal(parent.executor,'cloud');assert.equal(parent.device_id,null);assert.equal(parent.source_device_id,a);
  });
  await t.test('source computer wins; a different new request uses its own source',async()=>{
    const first=await db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,route()));assert.equal(first.device_id,a);
    const second=await db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route(),preferred_device_id:b}));assert.equal(second.device_id,b);
    const routed=await db.tx(tx=>taskRouting(tx,user,{...parent,operation_target:'device:'+c}));assert.equal(routed.preferred_device_id,a);assert.equal(routed.execution,'auto');
    const mobile=await db.tx(tx=>taskRouting(tx,user,{source_client:'android'}));assert.equal(mobile.preferred_device_id,a);
  });
  await t.test('undeclared capability and missing resources are never assumed available',async()=>{
    assert.equal(resourceSchema.safeParse({target:'device:'+ '-'.repeat(36)}).success,false);
    ca=connect(a,['files']);
    assert.equal((await db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,route()))).device_id,b);
    ca=connect(a,undefined,false);
    await assert.rejects(db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route(),resources:[{target:'device:'+a,path:'project/data.csv'}]})),/文件所在电脑不可用/);
    ca=connect(a);
    assert.equal((await db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route(),resources:[{target:'device:'+a,path:'project/data.csv'}]}))).device_id,a);
    await assert.rejects(db.tx(tx=>taskRouting(tx,otherUser,{}, {resources:[{target:'device:'+a}]})),/不属于当前账号/);
  });
  await t.test('explicit unavailable computer fails and does not contact another machine',async()=>{
    hub.detach(ca);sent.length=0;
    await assert.rejects(db.tx(tx=>createTask(tx,hub,user,claims,{run_id:parent.run_id,kind:'background',task:'explicit',wait:false,execution:'device',device_id:a},s)),/指定电脑离线/);
    assert.equal(sent.filter(x=>x.message.type==='run').length,0);
    assert.equal((await db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,route()))).device_id,b);
    ca=connect(a);
  });
  await t.test('other computers use load then stable device ID; cloud text avoids machines',async()=>{
    const busy=await db.tx(tx=>insertRun(tx,{userId:user,botId:bot.bot_id,requestId:randomUUID(),text:'busy',computer:{deviceId:a},lane:'task'}));
    assert.equal((await db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route(),preferred_device_id:undefined}))).device_id,b);
    await db.tx(tx=>finishRun(tx,busy.run_id,'completed',null,'done'));
    assert.equal((await db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route(),preferred_device_id:undefined}))).device_id,[a,b].sort()[0]);
    assert.equal((await db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,route('cloud')))).operation_target,'cloud');
    await assert.rejects(db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,{...route('cloud'),resources:[{target:'device:'+a}]})),/不能访问机器/);
  });
  await t.test('cloud fallback checks actual environment capabilities and resource source',async()=>{
    hub.detach(ca);hub.detach(cb);
    await assert.rejects(db.tx(tx=>resolveTaskTarget(tx,s,hub,user,bot.slug,route())),/云端执行环境未开启/);
    const remoteSettings={...s,remoteBackend:'ssh' as const};
    await assert.rejects(db.tx(tx=>resolveTaskTarget(tx,remoteSettings,hub,user,bot.slug,route())),RemotePreparationRequired);
    const env=await db.tx(tx=>tx.insert('remote_environments',{environment_id:randomUUID(),user_id:user,backend:'ssh',secret:{},status:'ready',capabilities:['files','shell']}));
    assert.equal((await db.tx(tx=>resolveTaskTarget(tx,remoteSettings,hub,user,bot.slug,route()))).operation_target,'remote:'+env.environment_id);
    await assert.rejects(db.tx(tx=>resolveTaskTarget(tx,remoteSettings,hub,user,bot.slug,{...route(),requirements:['browser']})),/缺少任务所需能力/);
    await assert.rejects(db.tx(tx=>resolveTaskTarget(tx,remoteSettings,hub,user,bot.slug,{...route(),resources:[{target:'device:'+a}]})),/文件所在电脑/);
    ca=connect(a);cb=connect(b);
  });
  await t.test('queued automatic work reselects immediately before claim; concurrent claims execute once',async()=>{
    const result=await db.tx(tx=>createTask(tx,hub,user,claims,{run_id:parent.run_id,kind:'background',task:'automatic',wait:false,request_id:'automatic'},s));
    const queued=await db.tx(tx=>tx.get('agent_tasks',result.task.id));assert.equal(queued.operation_target,'pending');assert.equal(queued.device_id,null);
    const run=await db.tx(tx=>startTask(tx,hub,queued,s));assert.equal(run?.device_id,a);
    hub.detach(ca);sent.length=0;
    await Promise.all([dispatchDevice(db,s,hub,run!.run_id),dispatchDevice(db,s,hub,run!.run_id)]);
    const started=await db.tx(tx=>tx.get('bot_runs',run!.run_id));assert.equal(started.status,'running');assert.equal(started.device_id,b);
    assert.equal(sent.filter(x=>x.message.type==='run').length,1);assert.equal(sent.find(x=>x.message.type==='run')?.device,b);
    const task=await db.tx(tx=>tx.get('agent_tasks',result.task.id));assert.equal(task.routing.preferred_device_id,a);assert.equal(task.device_id,b);
    hub.detach(cb);await failDeviceRuns(db,b);
    assert.equal((await db.tx(tx=>tx.get('bot_runs',run!.run_id))).status,'failed');
    ca=connect(a);cb=connect(b);sent.length=0;
    await dispatchDevice(db,s,hub,run!.run_id);assert.equal(sent.filter(x=>x.message.type==='run').length,0,'interrupted execution is not replayed');
    // A new task still prefers the source rather than the previous selected node.
    const next=await db.tx(tx=>createTask(tx,hub,user,claims,{run_id:parent.run_id,kind:'background',task:'next',wait:false},s));
    const nextTask=await db.tx(tx=>tx.get('agent_tasks',next.task.id));
    const nextRun=await db.tx(tx=>startTask(tx,hub,nextTask,s));assert.equal(nextRun?.device_id,a);
    await db.tx(tx=>finishRun(tx,nextRun!.run_id,'completed',null,'done'));
  });
  await t.test('explicit destination lost after queuing fails instead of falling back',async()=>{
    const result=await db.tx(tx=>createTask(tx,hub,user,claims,{run_id:parent.run_id,kind:'background',task:'explicit queued',wait:false,execution:'device',device_id:a},s));
    hub.detach(ca);sent.length=0;
    await dispatchDevice(db,s,hub,result.run!.run_id);
    assert.equal((await db.tx(tx=>tx.get('bot_runs',result.run!.run_id))).status,'failed');assert.equal(sent.filter(x=>x.message.type==='run').length,0);
    ca=connect(a);
  });
  await t.test('goal policy remembers source preference while a review uses an available machine',async()=>{
    await db.tx(tx=>finishRun(tx,parent.run_id,'completed',null,'done'));
    parent=await makeParent();
    const goal=await db.tx(tx=>manageGoals(tx,user,claims,{run_id:parent.run_id,request_id:'goal',action:'create',goal:'Inspect data',authorization:'Only inspect library'},new Date(),s,hub));
    assert.ok('id' in goal);
    const saved=await db.tx(tx=>tx.get('bot_goals',goal.id));assert.equal(saved.routing.execution,'auto');assert.equal(saved.routing.preferred_device_id,a);assert.match(saved.operation_target,/^policy:/);
    await db.tx(tx=>finishRun(tx,parent.run_id,'completed',null,'done'));hub.detach(ca);
    await new AutomationScheduler(db,s,hub,()=>new Date(Date.now()+120000)).once();
    const review=await db.tx(tx=>tx.one("SELECT * FROM bot_runs WHERE bot_id=$1 AND origin='automation' ORDER BY created_at DESC LIMIT 1",[bot.bot_id]));
    assert.equal(review?.device_id,b);assert.equal((await db.tx(tx=>tx.get('bot_goals',goal.id))).operation_target,saved.operation_target);
    await db.tx(async tx=>{
      await saveGoalDecision(tx,user,{sub:user,src:'device',bot:bot.bot_id,did:b},{run_id:review!.run_id,decision:{goals:[{id:goal.id,state:'continue',progress:'Saved report',notify:false,reason:'checkpoint',checkpoint:{artifacts:['report.md']}}]}});
      await finishRun(tx,review!.run_id,'completed',null,'done');
      await tx.rows('UPDATE bot_automations SET next_wake_at=now() WHERE automation_id=$1',[review!.automation_id]);
    });
    ca=connect(a);hub.detach(cb);sent.length=0;
    await new AutomationScheduler(db,s,hub,()=>new Date(Date.now()+120000)).once();
    assert.equal(sent.filter(x=>x.message.type==='run').length,0,'checkpoint files on B are not replaced with same paths on A');
    assert.equal((await db.tx(tx=>tx.get('bot_automations',review!.automation_id))).status,'waiting_device');

  });
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
  const s=settings({PI_BOT_DATABASE_URL:TEST_DB,PI_BOT_JWT_SECRET:'j'.repeat(40),PI_BOT_ADMIN_PASSWORD:'test-password',PI_BOT_RUNNER_TOKEN:'r'.repeat(40),PI_BOT_VAULT_FILE:vaultFile(dir.path)});
  const app=await createApp(s,db,hub);t.after(async()=>{await app.close();dir.cleanup();});
  const login=(await app.inject({method:'POST',url:'/auth/login',payload:{username:'admin',password:'test-password'}})).json(),user=login.user.id;
  const api=async(method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+login.access_token}});
  await api('POST','/admin/api/models',{name:'test',base_url:'https://example.com/v1',provider_model:'test',api_key:'test-key',context_window:32000,max_tokens:1000});
  const a=randomUUID(),b=randomUUID(),bot=(await api('POST','/bots',{name:'No binding',execution_device_id:a})).json();assert.equal(bot.execution_device_id,null);
  await db.tx(async tx=>{for(const id of [a,b]) await tx.insert('devices',{device_id:id,user_id:user,label:id,public_key:id});});
  const sends:any[]=[];
  for(const id of [a,b]) hub.attach({deviceId:id,userId:user,capabilities:['files','shell'],close(){},send(message){sends.push({id,message});if(message.type==='rpc')queueMicrotask(()=>hub.resolveRpc(id,{id:message.id,ok:true,result:{path:message.params.path,kind:'text',content:id,entries:[]}}));}});
  const queued=await db.tx(tx=>insertRun(tx,{userId:user,botId:bot.id,requestId:randomUUID(),text:'queued task',computer:null,lane:'task',operationTarget:'cloud',routing:{execution:'auto',preferred_device_id:a,requirements:['files','shell'],resources:[]}}));
  assert.equal((await app.inject({method:'POST',url:`/internal/runs/${queued.run_id}/claim`,payload:{worker_id:randomUUID()}})).statusCode,401);
  const response=await app.inject({method:'POST',url:`/internal/runs/${queued.run_id}/claim`,headers:{authorization:'Bearer '+s.runnerToken},payload:{worker_id:randomUUID()}});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().run,null);
  assert.equal((await db.tx(tx=>tx.get('bot_runs',queued.run_id))).device_id,a,'a newly available computer replaces queued cloud selection');
  await dispatchDevice(db,s,hub,queued.run_id);assert.equal(sends.filter(x=>x.message.type==='run').length,1);
  const sources=(await api('GET',`/bots/${bot.id}/files/sources`)).json().sources;assert.equal(sources.length,2);
  const list=(await api('GET',`/bots/${bot.id}/files?target=device:${b}`)).json();assert.equal(list.target,'device:'+b);
  const content=(await api('GET',`/bots/${bot.id}/files/content?target=device:${b}&path=data.csv`)).json();assert.equal(content.content,b);assert.equal(content.target,'device:'+b);
  assert.equal((await api('GET',`/bots/${bot.id}/files?target=device:${randomUUID()}`)).statusCode,404);
  const patch=await api('PATCH',`/bots/${bot.id}`,{execution_device_id:b});assert.equal(patch.statusCode,200);assert.equal(patch.json().execution_device_id,null);
});
