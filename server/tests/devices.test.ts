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
