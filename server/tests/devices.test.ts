import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { TEST_DB, resetDatabase } from './helpers.js';

test('multi-device upgrade preserves the original binding, history, memory and queued task destinations', {skip:!TEST_DB}, async t => {
  await resetDatabase(TEST_DB!);
  const db = new Database(TEST_DB!);
  t.after(() => db.close());
  const user=randomUUID(), device=randomUUID(), bot=randomUUID(), run=randomUUID(), message=randomUUID();
  const queued=randomUUID(), child=randomUUID(), automation=randomUUID();
  await db.tx(async tx => {
    await tx.rows('CREATE TABLE schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
    const folder=new URL('../migrations/',import.meta.url);
    for (const file of (await readdir(folder)).filter(f=>f.endsWith('.sql') && f<'0010').sort()) {
      await tx.rows(await readFile(new URL(file,folder),'utf8'));
      await tx.rows('INSERT INTO schema_migrations(version) VALUES($1)',[file.slice(0,-4)]);
    }
    await tx.insert('users',{user_id:user,username:'legacy',role:'user',password_hash:'unused'});
    await tx.insert('devices',{device_id:device,user_id:user,public_key:'legacy',label:'Original Mac'});
    await tx.insert('bots',{bot_id:bot,user_id:user,name:'Legacy Bot',slug:'legacy-bot',avatar:{},next_seq:2});
    await tx.insert('bot_runs',{run_id:run,trace_id:randomUUID().replaceAll('-',''),user_id:user,bot_id:bot,request_id:'legacy',executor:'mac',device_id:device,status:'completed',user_message_id:randomUUID(),assistant_message_id:message,execution_policy:'mac_only'});
    await tx.insert('bot_messages',{message_id:message,bot_id:bot,run_id:run,seq:1,role:'assistant',status:'completed',executor:'mac',content:'Original history'});
    await tx.insert('bot_memories',{bot_id:bot,summary:'Original memory'});
    await tx.insert('bot_automations',{automation_id:automation,bot_id:bot,user_id:user,kind:'patrol',title:'Patrol',goal:'Check',status:'waiting_mac'});
    await tx.insert('agent_tasks',{task_id:queued,user_id:user,parent_run_id:run,parent_bot_id:bot,target_bot_id:bot,mode:'report',depth:0,task:'Queued local work',status:'queued',kind:'background'});
    await tx.insert('agent_tasks',{task_id:child,user_id:user,parent_run_id:run,parent_bot_id:bot,target_bot_id:bot,child_run_id:run,mode:'report',depth:0,task:'Finished work',status:'completed',kind:'background'});
    await tx.insert('usage_logs',{user_id:user,bot_id:bot,source:'mac',input_tokens:5});
  });
  await migrate(db); await migrate(db);
  await db.tx(async tx => {
    assert.equal((await tx.get('bots',bot)).execution_device_id,device);
    assert.equal((await tx.get('devices',device)).platform,'darwin');
    assert.equal((await tx.get('bot_runs',run)).executor,'device');
    assert.equal((await tx.get('bot_runs',run)).execution_policy,'device_only');
    assert.equal((await tx.get('bot_messages',message)).content,'Original history');
    assert.equal((await tx.get('bot_messages',message)).executor,'device');
    assert.equal((await tx.get('bot_memories',bot)).summary,'Original memory');
    assert.equal(await tx.get('bot_automations',automation), undefined);
    assert.equal((await tx.one('SELECT count(*) AS n FROM bot_goals WHERE bot_id=$1',[bot]))!.n, 0);
    for (const id of [queued,child]) {
      const task=await tx.get('agent_tasks',id);
      assert.equal(task.device_id,device); assert.equal(task.execution,'device');
    }
    assert.equal((await tx.one('SELECT source FROM usage_logs'))!.source,'device');
    await tx.insert('devices',{device_id:randomUUID(),user_id:user,public_key:'linux',label:'Linux',platform:'linux'});
    await tx.insert('devices',{device_id:randomUUID(),user_id:user,public_key:'windows',label:'Windows',platform:'win32'});
    assert.equal((await tx.one('SELECT count(*) AS n FROM devices WHERE user_id=$1 AND revoked_at IS NULL',[user]))!.n,3);
    assert.equal((await tx.get('bots',bot)).execution_device_id,device);
  });
});

test('Windows migration accepts win32 but rejects invalid platform', {skip:!TEST_DB}, async t => {
  await resetDatabase(TEST_DB!);
  const db = new Database(TEST_DB!); t.after(() => db.close());
  await migrate(db);
  const user = randomUUID();
  await db.tx(async tx => { await tx.insert('users', {user_id:user,username:'windows-migration',role:'user',password_hash:'unused'}); });
  for (const platform of ['darwin','linux','win32']) await db.tx(async tx => {
    await tx.insert('devices', {device_id:randomUUID(),user_id:user,public_key:platform,label:platform,platform});
  });
  await assert.rejects(db.tx(async tx => { await tx.insert('devices', {device_id:randomUUID(),user_id:user,public_key:'bad',label:'bad',platform:'unknown'}); }), /devices_platform_check/);
});

test('hardware recovery serializes concurrent same-account registrations and never revives revoked IDs',{skip:!TEST_DB},async t=>{
  const {registerDevice}=await import('../src/devices.js');
  await resetDatabase(TEST_DB!); const db=new Database(TEST_DB!);t.after(()=>db.close());await migrate(db);
  const owner=randomUUID(),other=randomUUID(),fp='v1:'+'a'.repeat(64);
  await db.tx(async tx=>{for(const [id,name] of [[owner,'owner'],[other,'other']])await tx.insert('users',{user_id:id,username:name,password_hash:'unused',role:'user'});});
  const register=(user:string,key:string)=>db.tx(tx=>registerDevice(tx,user,{public_key:key,label:'Same name',platform:'linux',hardware_fingerprint:fp}));
  const [first,second]=await Promise.all([register(owner,'first'),register(owner,'second')]);
  assert.equal(first.device.device_id,second.device.device_id);
  assert.equal((await db.tx(tx=>tx.one('SELECT count(*) AS n FROM device_key_rotations')))!.n,1);
  assert.notEqual((await register(other,'foreign')).device.device_id,first.device.device_id);
  await db.tx(tx=>tx.update('devices',first.device.device_id,{revoked_at:new Date()}));
  assert.notEqual((await register(owner,'new')).device.device_id,first.device.device_id);
});

test('real terminal tool events build cloud and device experience, deduplicate calls and retain old resources',{skip:!TEST_DB},async t=>{
  const {createBot,insertRun,recordTool,finishRun}=await import('../src/bots.js');
  const {endpointExperience,resourceExperience,resolveExperienceConflict,recordEndpointExperience}=await import('../src/endpoint-experience.js');
  await resetDatabase(TEST_DB!);const db=new Database(TEST_DB!);t.after(()=>db.close());await migrate(db);
  const owner=randomUUID();
  await db.tx(async tx=>{await tx.insert('users',{user_id:owner,username:'evidence',role:'user',password_hash:'unused'});});
  const bot=await db.tx(tx=>createBot(tx,owner,{name:'Evidence',persona:''}));
  const run=await db.tx(tx=>insertRun(tx,{userId:owner,botId:bot.bot_id,requestId:randomUUID(),text:'task',computer:null,lane:'task',operationTarget:'cloud'}));
  await db.tx(async tx=>{
    await recordTool(tx,run,{id:'first',name:'read_file',state:'completed',observed_path:'/actual/old-project'});
    for(let i=0;i<110;i++)await recordTool(tx,run,{id:'read-'+i,name:'read_file',state:'completed',observed_path:'/actual/repeated'});
    await recordTool(tx,run,{id:'running',name:'list_files',state:'running',observed_path:'/not-observed'});
    await recordTool(tx,run,{id:'shell-failure',name:'run_command',state:'failed'});
    await finishRun(tx,run.run_id,'completed',null,'done');
  });
  await db.tx(async tx=>{
    assert.equal(await resourceExperience(tx,bot.bot_id,'/actual/old-project'),'cloud');
    assert.equal(await resourceExperience(tx,bot.bot_id,'/not-observed'),undefined);
    const grouped=await endpointExperience(tx,bot.bot_id);assert.equal(grouped.filter(r=>r.path==='/actual/repeated').length,1);
    assert.equal(grouped.find(r=>r.path==='/actual/repeated')!.observations,110);
    const saved=await tx.get('bot_runs',run.run_id);
    await recordEndpointExperience(tx,saved,saved.endpoint_observations);
    assert.equal((await tx.one('SELECT count(*) AS n FROM endpoint_experiences WHERE run_id=$1',[run.run_id]))!.n,112);
  });
  const later=async(state:'failed'|'completed')=>db.tx(async tx=>{
    const r=await insertRun(tx,{userId:owner,botId:bot.bot_id,requestId:randomUUID(),text:'verify',computer:null,lane:'task',operationTarget:'cloud'});
    await recordTool(tx,r,{id:'verify',name:'read_file',state,observed_path:'/actual/old-project'});await finishRun(tx,r.run_id,'completed',null,'checked');
    return (await tx.one('SELECT * FROM endpoint_experiences WHERE run_id=$1',[r.run_id]))!;
  });
  const failure=await later('failed');
  assert.equal(await db.tx(tx=>resourceExperience(tx,bot.bot_id,'/actual/old-project')),undefined);
  const confirmation=await later('completed');
  await db.tx(tx=>resolveExperienceConflict(tx,bot.bot_id,failure.evidence_id,confirmation.evidence_id));
  assert.equal(await db.tx(tx=>resourceExperience(tx,bot.bot_id,'/actual/old-project')),'cloud');
});

test('registration API rotates a live socket and rejects stale keys and forged signed message sources',{skip:!TEST_DB},async t=>{
  const {createApp}=await import('../src/app.js');const {Hub}=await import('../src/hub.js');const {settings}=await import('../src/config.js');
  const {tempDir,vaultFile,deviceKeys,socket,eventually}=await import('./helpers.js');
  await resetDatabase(TEST_DB!);const dir=tempDir(),db=new Database(TEST_DB!),hub=new Hub();
  const s=settings({PI_BOT_DATABASE_URL:TEST_DB,PI_BOT_JWT_SECRET:'j'.repeat(40),PI_BOT_ADMIN_PASSWORD:'test-password',PI_BOT_VAULT_FILE:vaultFile(dir.path),PI_BOT_REMOTE_BACKEND:'none'});
  const app=await createApp(s,db,hub);await app.listen({host:'127.0.0.1',port:0});
  t.after(async()=>{await app.close();dir.cleanup();});
  const base=`http://127.0.0.1:${(app.server.address() as any).port}`;
  const login=(await app.inject({method:'POST',url:'/auth/login',payload:{username:'admin',password:'test-password'}})).json();
  const api=(url:string,payload:any)=>app.inject({method:'POST',url,payload,headers:{authorization:'Bearer '+login.access_token}});
  const old=deviceKeys(),fresh=deviceKeys();
  const fingerprint='v1:'+'b'.repeat(64);
  const registered=(await api('/devices/register',{public_key:old.publicKey,label:'Original',hardware_fingerprint:fingerprint})).json();
  const id=registered.device.id;old.setId(id);fresh.setId(id);
  const live=await socket(base.replace('http:','ws:')+'/ws/device',old.headers('GET','/ws/device'));
  t.after(()=>live.ws.terminate());await eventually(()=>hub.device(login.user.id,id));
  const rebound=await api('/devices/register',{public_key:fresh.publicKey,label:'Reinstalled',hardware_fingerprint:fingerprint});
  assert.equal(rebound.statusCode,200,rebound.body);assert.equal(rebound.json().device.id,id);
  await eventually(()=>!hub.device(login.user.id,id));
  const stale=await app.inject({method:'GET',url:'/devices',headers:old.headers('GET','/devices')});assert.equal(stale.statusCode,401);
  const valid=await app.inject({method:'GET',url:'/devices',headers:fresh.headers('GET','/devices')});assert.equal(valid.statusCode,200);
  await api('/admin/api/models',{name:'test',base_url:'https://example.test/v1',provider_model:'test',api_key:'test',context_window:32000,max_tokens:1000});
  const bot=(await api('/bots',{name:'Source'})).json();const foreign=randomUUID();
  const body={text:'hello',request_id:randomUUID(),source_device_id:foreign};const path=`/bots/${bot.id}/messages`;
  const forged=await app.inject({method:'POST',url:path,payload:body,headers:fresh.headers('POST',path,JSON.stringify(body))});
  assert.equal(forged.statusCode,422,forged.body);
});
