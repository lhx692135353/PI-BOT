import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerDevice, messageProvenance } from '../src/devices.js';
import { taskRouting, resolveTaskTarget } from '../src/targets.js';
import { recordEndpointExperience, resourceExperience } from '../src/endpoint-experience.js';
import { modelMessageContent } from '../src/bots.js';
import { Hub } from '../src/hub.js';
import type { Tx, Row } from '../src/db.js';
import { hardwareHash, hardwareFingerprint } from '../../desktop/packages/service/src/hardware-identity.js';

/** Behavioral database double; SQL transactions/concurrency are covered separately by PostgreSQL tests. */
function fixture() {
  const devices: Row[] = [], evidence: Row[] = [], rotations:Row[]=[];
  const tx = {
    async one(sql:string,args:any[]) {
      if(sql.includes('FROM users')) return {user_id:args[0]};
      if(sql.includes('FROM devices')) return devices.find(d =>
        (sql.includes('device_id=$1') ? d.device_id===args[0] && d.user_id===args[1] : d.user_id===args[0] && d.public_key===args[1]) && !d.revoked_at);
      return undefined;
    },
    async rows(sql:string,args:any[]) {
      if(sql.startsWith('INSERT INTO endpoint_experiences')) {evidence.push({evidence_id:args[0],bot_id:args[1],run_id:args[2],target:args[3],capability:args[4],path:args[5],outcome:args[6],evidence:JSON.parse(args[7])});return [];}
      if(sql.includes('hardware_fingerprint=$2')) return devices.filter(d=>d.user_id===args[0] && d.hardware_fingerprint===args[1] && !d.revoked_at);
      if(sql.includes('FROM devices d')) return devices.filter(d=>d.user_id===args[0]&&!d.revoked_at);
      if(sql.includes('endpoint_experiences')) return evidence.filter(e=>e.bot_id===args[0] && (args.length<2||e.path===args[1]));
      return [];
    },
    async insert(table:string,data:Row) { const row={key_version:0,...data}; (table==='devices'?devices:table==='device_key_rotations'?rotations:evidence).push(row); return row; },
    async update(_table:string,id:string,data:Row) {const row=devices.find(d=>d.device_id===id)!; const next={...row,...Object.fromEntries(Object.entries(data).filter(([,v])=>v!==undefined))};devices[devices.indexOf(row)]=next;return next;},
    async get(_table:string,id:string) {return devices.find(d=>d.device_id===id);},
  } as unknown as Tx;
  return {tx,devices,evidence,rotations};
}
const fingerprint='v1:'+'a'.repeat(64);
const input=(public_key:string,fp:string|undefined=fingerprint)=>({public_key,label:'Laptop',platform:'linux',hardware_fingerprint:fp});

test('identity prefers active key, uniquely restores same account and audits without raw hardware identifiers', async()=>{
  const f=fixture(),u=randomUUID();
  const first=await registerDevice(f.tx,u,input('old'));
  assert.equal((await registerDevice(f.tx,u,input('old'))).device.device_id,first.device.device_id);
  const recovered=await registerDevice(f.tx,u,input('new'));
  assert.equal(recovered.device.device_id,first.device.device_id);assert.equal(recovered.rebound,true);
  assert.equal(recovered.device.key_version,1);assert.match(recovered.notice!,/重装后重新绑定/);
  assert.equal(f.rotations.length,1);assert.notEqual(f.rotations[0].old_key_hash,'old');
  assert.notEqual((await registerDevice(f.tx,'other',input('foreign'))).device.device_id,first.device.device_id);
  f.devices[0].revoked_at=new Date();
  assert.notEqual((await registerDevice(f.tx,u,input('third'))).device.device_id,first.device.device_id);
});
test('duplicate/absent fingerprints create identities; names never merge; legacy key registration still works',async()=>{
  const f=fixture(),u='owner';
  const first=await registerDevice(f.tx,u,input('one',undefined));
  // Explicit undefined default parameter would use fingerprint, so remove it for legacy registrations.
  const legacy=await registerDevice(f.tx,u,{public_key:'legacy',label:'Laptop',platform:'darwin'});
  assert.notEqual(legacy.device.device_id,first.device.device_id);
  f.devices.push({...first.device,device_id:randomUUID(),public_key:'clone'});
  const third=await registerDevice(f.tx,u,input('third'));
  assert.notEqual(third.device.device_id,first.device.device_id);assert.equal(third.rebound,false);
});
test('hardware hashes are versioned, platform-separated, stable and reject missing/placeholder IDs',async()=>{
  const raw='12345678-1234-4567-89ab-123456789abc';
  for(const platform of ['darwin','linux','win32']) assert.match(hardwareHash(platform,raw)!,/^v1:[a-f0-9]{64}$/);
  assert.equal(hardwareHash('darwin',raw.toUpperCase()),hardwareHash('darwin',raw));
  assert.notEqual(hardwareHash('linux',raw),hardwareHash('win32',raw));
  assert.equal(hardwareHash('linux','00000000-0000-0000-0000-000000000000'),undefined);
  assert.equal(hardwareHash('linux','unknown'),undefined);
  assert.match(hardwareHash('linux','0f'.repeat(16))!,/^v1:/);
  assert.equal(await hardwareFingerprint('unsupported' as NodeJS.Platform),undefined);
});
test('each cross-client message retains its own provenance and validates ownership',async()=>{
  const f=fixture(); const d=(await registerDevice(f.tx,'owner',input('key'))).device;
  const desktop=await messageProvenance(f.tx,'owner','desktop',d.device_id);
  const mobile=await messageProvenance(f.tx,'owner','android');
  assert.equal(desktop.device_label,'Laptop');assert.equal(mobile.entry,'cloud');
  assert.equal('device_id' in mobile,false);
  await assert.rejects(messageProvenance(f.tx,'owner','android',d.device_id),/云端入口/);
  assert.equal((await messageProvenance(f.tx,'owner','web')).client,'web');
  await assert.rejects(messageProvenance(f.tx,'foreign','desktop',d.device_id),/自己账号/);
  assert.equal(modelMessageContent({role:'user',content:'current device',provenance:desktop}),'current device');
  assert.doesNotMatch(modelMessageContent({role:'user',content:'current device',provenance:mobile}),new RegExp(d.device_id));
  assert.equal(modelMessageContent({role:'user',content:'old'}),'old');
});
test('terminal experience uses executed node and tool evidence, isolates bots and preserves contradictions',async()=>{
  const f=fixture(),target='device:'+randomUUID(),run={run_id:randomUUID(),bot_id:'bot',lane:'task',operation_target:target};
  await recordEndpointExperience(f.tx,run,[{id:'r',name:'read',state:'completed',observed_path:'/verified/project'},{id:'s',name:'bash',state:'completed'},{id:'pending',name:'write',state:'running'}]);
  assert.equal(f.evidence.length,2);assert.equal(f.evidence[0].target,target);
  assert.equal(await resourceExperience(f.tx,'bot','/verified/project'),target);
  assert.equal(await resourceExperience(f.tx,'other','/verified/project'),undefined);
  await recordEndpointExperience(f.tx,{...run,run_id:randomUUID()},[{id:'failed',name:'read',state:'failed',observed_path:'/verified/project'}]);
  assert.equal(f.evidence.length,3);assert.equal(await resourceExperience(f.tx,'bot','/verified/project'),undefined);
  await recordEndpointExperience(f.tx,{...run,operation_target:'cloud'},[{id:'r',name:'read',state:'completed'}]);assert.equal(f.evidence.length,4);
});
test('AI tool decision prioritizes explicit device, then unique evidence, cloud text, and clarification; offline never switches',async()=>{
  const f=fixture(),hub=new Hub(),u='owner';
  const a=(await registerDevice(f.tx,u,input('a'))).device;
  const b=(await registerDevice(f.tx,u,{public_key:'b',label:'Other',platform:'linux'})).device;
  hub.attach({userId:u,deviceId:b.device_id,capabilities:['shell'],send(message){if(['run','rpc'].includes(message.type)) throw Error('must not contact alternative');},close(){}});
  const source={bot_id:'bot',source_client:'android',source_device_id:b.device_id};
  const route=await taskRouting(f.tx,u,source,{device_id:a.device_id,requirements:['shell'],resource_key:'/not-known'});
  await assert.rejects(resolveTaskTarget(f.tx,undefined,hub,u,'bot',route),/离线.*用户选择/);
  await assert.rejects(taskRouting(f.tx,'foreign',source,{device_id:a.device_id}),/不属于当前账号/);
  assert.equal((await taskRouting(f.tx,u,source)).preferred_device_id,undefined);
  assert.equal((await resolveTaskTarget(f.tx,undefined,hub,u,'bot',await taskRouting(f.tx,u,source))).operation_target,'cloud');
  await assert.rejects(resolveTaskTarget(f.tx,undefined,hub,u,'bot',await taskRouting(f.tx,u,source,{requirements:['shell']})),/执行目标不明确/);
  f.evidence.push({bot_id:'bot',path:'/actual',target:'device:'+a.device_id,outcome:'observed'});
  assert.deepEqual((await taskRouting(f.tx,u,source,{resource_key:'/actual'})).resources,[{target:'device:'+a.device_id}]);
  f.evidence.push({bot_id:'bot',path:'/actual',target:'device:'+b.device_id,outcome:'observed'});
  await assert.rejects(taskRouting(f.tx,u,source,{resource_key:'/actual'}),/归属不明确/);
});

test('rotated device credentials invalidate existing model tokens while preserving legacy version zero',async()=>{
  const { issueLlmToken,llmCaller }=await import('../src/security.js');
  const s={jwtSecret:'test-secret'.repeat(5),llmTokenTtl:60} as any;
  let version=0;
  const tx={get:async()=>({user_id:'owner'}),one:async(_sql:string,args:any[])=>args[0]==='device'&&args[1]==='owner'&&args[2]===version?{exists:true}:undefined} as unknown as Tx;
  const old=await issueLlmToken({sub:'owner',src:'device',did:'device'},s);
  await llmCaller(tx,{authorization:'Bearer '+old},s);
  version=1;
  await assert.rejects(llmCaller(tx,{authorization:'Bearer '+old},s),/设备已解绑/);
  const current=await issueLlmToken({sub:'owner',src:'device',did:'device',kv:1},s);
  await llmCaller(tx,{authorization:'Bearer '+current},s);
});

test('old signatures fail after public-key rotation and the current key remains usable',async()=>{
  const {generateKeyPairSync,sign}=await import('node:crypto');
  const {device,sha256}=await import('../src/security.js');
  const old=generateKeyPairSync('ed25519'),current=generateKeyPairSync('ed25519');
  const publicKey=(pair:typeof old)=>pair.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64');
  const id=randomUUID();let key=publicKey(old);
  const tx={one:async(sql:string)=>sql.includes('FROM devices')?{device_id:id,user_id:'owner',public_key:key,key_version:1}:{nonce:'saved'},rows:async()=>[],get:async()=>({user_id:'owner'})} as unknown as Tx;
  const headers=(pair:typeof old)=>{
    const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomUUID();
    const signature=sign(null,Buffer.from(`${timestamp}.${nonce}.GET./devices.${sha256(Buffer.alloc(0))}`),pair.privateKey).toString('base64');
    return {'x-pibot-device-id':id,'x-pibot-timestamp':timestamp,'x-pibot-nonce':nonce,'x-pibot-signature':signature};
  };
  const s={signatureSkew:300} as any;
  await device(tx,headers(old),'GET','/devices',Buffer.alloc(0),s);
  key=publicKey(current);
  await assert.rejects(device(tx,headers(old),'GET','/devices',Buffer.alloc(0),s),/设备认证失败/);
  await device(tx,headers(current),'GET','/devices',Buffer.alloc(0),s);
});

test('conflict reconciliation requires newer success for the same bot, endpoint, capability and path',async()=>{
  const {resolveExperienceConflict}=await import('../src/endpoint-experience.js');
  const conflict={evidence_id:'c',bot_id:'bot',target:'device:a',capability:'files',path:'/actual',outcome:'conflict',verified_at:'2026-01-01'};
  let confirmation={...conflict,evidence_id:'s',outcome:'observed',verified_at:'2026-01-02'};
  let resolved=false;
  const tx={one:async(_q:string,args:any[])=>args[1]!=='bot'?undefined:args[0]==='c'?conflict:confirmation,rows:async()=>{resolved=true;return[];}} as unknown as Tx;
  await assert.rejects(resolveExperienceConflict(tx,'other','c','s'),/更新成功证据/);
  confirmation={...confirmation,target:'device:b'};
  await assert.rejects(resolveExperienceConflict(tx,'bot','c','s'),/更新成功证据/);
  assert.equal(resolved,false);
  confirmation={...confirmation,target:conflict.target};
  await resolveExperienceConflict(tx,'bot','c','s');assert.equal(resolved,true);
});

test('OS probes collect only explicit hardware identifiers and safely fall back on access/command failure',async()=>{
  const raw='12345678-1234-4567-89ab-123456789abc';
  const calls:string[]=[];
  const probe={run:async(command:string)=>{calls.push(command);return command.includes('ioreg')?`"IOPlatformUUID" = "${raw}"`:raw;},read:async(path:string)=>{calls.push(path);if(path.includes('/sys/'))throw Error('denied');return raw.replaceAll('-','');}};
  assert.equal(await hardwareFingerprint('darwin',probe),hardwareHash('darwin',raw));
  assert.equal(await hardwareFingerprint('win32',probe),hardwareHash('win32',raw));
  assert.equal(await hardwareFingerprint('linux',probe),hardwareHash('linux',raw.replaceAll('-','')));
  assert.deepEqual(calls,['/usr/sbin/ioreg','powershell.exe','/sys/class/dmi/id/product_uuid','/etc/machine-id']);
  const failed={run:async()=>{throw Error('unavailable');},read:async()=>{throw Error('denied');}};
  for(const platform of ['darwin','linux','win32'] as NodeJS.Platform[]) assert.equal(await hardwareFingerprint(platform,failed),undefined);
});
