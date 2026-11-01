import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/db.js';
import { createApp } from '../src/app.js';
import { settings } from '../src/config.js';
import { Hub, type DeviceConnection } from '../src/hub.js';
import { createBot, insertRun, approvalOut, finishRun } from '../src/bots.js';
import { handleRunEvent } from '../src/runs.js';
import { issueToken, issueLlmToken } from '../src/security.js';
import { normalizedResource, resourceMatches, canRemember } from '../src/authorizations.js';
import { TEST_DB, resetDatabase, tempDir, vaultFile, deviceKeys } from './helpers.js';

test('saved resource matching rejects sibling prefixes, traversal and broad or destructive scopes', () => {
  const rule = {platform:'linux',resource:'/projects/demo',resource_type:'directory' as const};
  for (const path of ['/projects/demo','/projects/demo/a.txt']) assert.ok(resourceMatches(rule,path));
  for (const path of ['/projects/demo2/a','/projects/demo/../other/a','/etc/passwd','relative']) assert.equal(resourceMatches(rule,path),false);
  assert.equal(resourceMatches({...rule,resource_type:'file'},'/projects/demo/a'),false);
  const windows = {platform:'win32',resource:'C:\\Projects\\Demo',resource_type:'directory' as const};
  assert.ok(resourceMatches(windows,'c:/Projects/Demo/readme.txt'));
  assert.equal(resourceMatches(windows,'C:/Projects/demo/readme.txt'),false,'canonical case-sensitive directories stay distinct');
  assert.equal(resourceMatches({...rule,resource:'/projects/demo\\'},'/projects/demo/a'),false,'POSIX backslashes are literal filename characters');
  for (const path of ['C:\\Projects\\Demo-other\\a','C:\\Projects\\Demo\\..\\Other\\a','C:\\Projects\\Demo\\a:stream','\\\\server\\share\\a']) assert.equal(resourceMatches(windows,path),false);
  for (const path of ['C:\\','/','/home','/root']) assert.equal(normalizedResource(path,path.includes(':')?'win32':'linux'),null);
  const scope = {...rule,target:`device:${randomUUID()}`,target_label:'Windows PC',operation:'read' as const};
  assert.ok(canRemember(scope));
  for (const operation of ['write','execute','legacy'] as const) assert.equal(canRemember({...scope,operation}),false);
  assert.equal(canRemember({...scope,resource_type:'unknown'}),false);
});

test('saved authorization API persists, scopes, audits and revokes across runs and clients', {skip:!TEST_DB}, async t => {
  await resetDatabase(TEST_DB!);
  const dir = tempDir();
  const db = new Database(TEST_DB!);
  const hub = new Hub();
  const s = settings({PI_BOT_DATABASE_URL:TEST_DB,PI_BOT_JWT_SECRET:'j'.repeat(40),PI_BOT_ADMIN_PASSWORD:'test-password',PI_BOT_VAULT_FILE:vaultFile(dir.path)});
  const app = await createApp(s,db,hub);
  t.after(async () => { await app.close(); dir.cleanup(); });
  const login = await app.inject({method:'POST',url:'/auth/login',payload:{username:'admin',password:'test-password'}});
  assert.equal(login.statusCode,200,login.body);
  const token = login.json().access_token, userId = login.json().user.id;
  const deviceId = randomUUID(), secondDevice = randomUUID(), otherUser = randomUUID();
  const keys = deviceKeys(); keys.setId(deviceId);
  const bot = await db.tx(async tx => {
    for (const id of [deviceId,secondDevice]) await tx.insert('devices',{device_id:id,user_id:userId,label:id === deviceId ? 'Work PC' : 'Other PC',platform:'win32',public_key:keys.publicKey});
    await tx.insert('users',{user_id:otherUser,username:'other',role:'user',password_hash:'unused'});
    return createBot(tx,userId,{name:'授权测试',persona:''});
  });
  const otherToken = await issueToken({user_id:otherUser,role:'user'},s);
  const received: any[] = [];
  const conn: DeviceConnection = {deviceId,userId,send:m=>received.push(m),close(){}};
  hub.attach(conn);
  async function newRun(device = deviceId) {
    return db.tx(async tx => {
      const run = await insertRun(tx,{userId,botId:bot.bot_id,requestId:randomUUID(),text:'test',computer:null,targetDeviceId:device,lane:'task'});
      return tx.update('bot_runs',run.run_id,{status:'running'});
    });
  }
  async function approval(runId: string, access: 'read'|'write'|'execute'|undefined = 'read', path = 'C:\\Projects\\Demo', type: 'file'|'directory' = 'directory') {
    await handleRunEvent(db,s,hub,conn,{run_id:runId,event:{kind:'approval',request_id:randomUUID(),path,reason:'检查项目',access,resource_type:access ? type : undefined}});
    const id = received.at(-1).approval_id;
    return db.tx(tx=>tx.get('approvals',id));
  }
  async function api(method:'GET'|'POST'|'DELETE',url:string,payload?:object,bearer=token) {
    return app.inject({method,url,headers:{authorization:`Bearer ${bearer}`},...(payload ? {payload} : {})});
  }
  const run = await newRun();
  const pending = await approval(run.run_id);
  const shown = approvalOut(pending);
  assert.equal(shown.can_remember,true); assert.match(shown.scope,/Work PC.*读取/); assert.match(shown.scope,/不包含写入/);
  assert.equal((await api('POST',`/approvals/${pending.approval_id}`,{decision:'approve_always'},otherToken)).statusCode,404);
  const decision = await api('POST',`/approvals/${pending.approval_id}`,{decision:'approve_always'});
  assert.equal(decision.statusCode,200,decision.body);
  assert.equal(received.at(-1).decision,'approve_always');
  assert.equal((await api('POST',`/approvals/${pending.approval_id}`,{decision:'approve_always'})).statusCode,409);
  const list = await api('GET','/authorizations');
  assert.equal(list.statusCode,200); assert.equal(list.json().length,1);
  const rule = list.json()[0];
  assert.equal(rule.target,`device:${deviceId}`); assert.equal(rule.operation,'read');
  assert.deepEqual((await api('GET','/authorizations',undefined,otherToken)).json(),[]);
  // The desktop service accesses the same API using a real signed device request.
  const signed = await app.inject({method:'GET',url:'/authorizations',headers:keys.headers('GET','/authorizations')});
  assert.equal(signed.statusCode,200); assert.equal(signed.json()[0].id,rule.id);
  const next = await newRun();
  const llm = await issueLlmToken({sub:userId,src:'device',bot:bot.bot_id,did:deviceId},s);
  const check = async (path:string,access='read',runId=next.run_id,bearer=llm) => {
    const result = await api('POST','/agent/authorizations/check',{run_id:runId,path,access},bearer);
    assert.equal(result.statusCode,200,result.body); return result.json().approved;
  };
  assert.equal(await check('C:\\Projects\\Demo\\readme.md'),true,'a later run reuses the exact user/device/read/resource scope');
  for (const path of ['C:\\Projects\\Demo2\\a','D:\\Projects\\Demo\\a','C:\\Projects\\Other\\a','C:\\Projects\\Demo\\..\\Other\\a']) assert.equal(await check(path),false);
  for (const operation of ['write','execute']) assert.equal(await check('C:\\Projects\\Demo\\a',operation),false);
  const second = await newRun(secondDevice);
  const secondToken = await issueLlmToken({sub:userId,src:'device',bot:bot.bot_id,did:secondDevice},s);
  assert.equal(await check('C:\\Projects\\Demo\\a','read',second.run_id,secondToken),false);
  assert.equal((await api('POST','/agent/authorizations/check',{run_id:second.run_id,path:'C:\\Projects\\Demo',access:'read'},llm)).statusCode,404);
  assert.equal((await api('DELETE',`/authorizations/${rule.id}`,undefined,otherToken)).statusCode,404);
  const revoked = await api('DELETE',`/authorizations/${rule.id}`);
  assert.equal(revoked.statusCode,200,revoked.body);
  assert.equal(await check('C:\\Projects\\Demo\\readme.md'),false,'revocation takes effect within an already running task');
  assert.deepEqual((await api('GET','/authorizations')).json(),[]);
  const logs = (await api('GET','/authorizations/logs')).json();
  assert.deepEqual(logs.map((l:any)=>l.action),['revoke','use','grant']);
  assert.equal(logs[1].run_id,next.run_id);
  assert.deepEqual((await api('GET','/authorizations/logs',undefined,otherToken)).json(),[]);
  for (const access of ['write','execute',undefined] as const) {
    const p = await approval((await newRun()).run_id,access);
    if (access === undefined) {
      // A true legacy event has no explicit access and cannot become a remembered grant.
      await db.tx(tx=>tx.rows("UPDATE approvals SET detail=detail - 'authorization_scope' - 'access' WHERE approval_id=$1",[p.approval_id]));
    }
    const result = await api('POST',`/approvals/${p.approval_id}`,{decision:'approve_always'});
    assert.equal(result.statusCode,422,result.body);
    assert.equal((await api('POST',`/approvals/${p.approval_id}`,{decision:'approve'})).statusCode,200);
  }
  const expired = await approval((await newRun()).run_id);
  await db.tx(tx=>tx.rows("UPDATE approvals SET expires_at=now()-interval '1 second' WHERE approval_id=$1",[expired.approval_id]));
  assert.equal((await api('POST',`/approvals/${expired.approval_id}`,{decision:'approve_always'})).statusCode,409);
  assert.equal((await api('GET','/authorizations')).json().length,0);
  const ending = await newRun(), endingApproval = await approval(ending.run_id);
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>(resolve => {release=resolve;});
  const ready = new Promise<void>(resolve => {locked=resolve;});
  const finishing = db.tx(async tx => {
    await tx.one('SELECT run_id FROM bot_runs WHERE run_id=$1 FOR NO KEY UPDATE',[ending.run_id]);
    locked(); await gate;
    await finishRun(tx,ending.run_id,'completed',null);
  });
  await ready;
  const concurrentDecision = api('POST',`/approvals/${endingApproval.approval_id}`,{decision:'approve_always'});
  try { await new Promise(resolve=>setTimeout(resolve,50)); } finally { release(); }
  await finishing;
  assert.equal((await concurrentDecision).statusCode,409,'concurrent task completion must not persist a grant or deadlock');
  const cancelling = await newRun(), cancelledApproval = await approval(cancelling.run_id);
  await db.tx(tx=>tx.rows('UPDATE bot_runs SET cancel_requested=true WHERE run_id=$1',[cancelling.run_id]));
  assert.equal((await api('POST',`/approvals/${cancelledApproval.approval_id}`,{decision:'approve_always'})).statusCode,409);
  assert.equal((await api('GET','/authorizations')).json().length,0);
});
