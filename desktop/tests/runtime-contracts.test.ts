import test from 'node:test';
import assert from 'node:assert/strict';
import { errorInfo, toolDescriptor } from '@pi-bot/runtime-contracts';
import { bridge } from '../apps/desktop/ui/bridge.js';
import { sessionEnded } from '../apps/desktop/ui/phone-session.js';

test('IPC error envelope survives the renderer boundary independently of display wording',async()=>{
 const info={code:'session_expired' as const,scope:'phone',retryable:false,outcome:'unknown' as const,message:'The display wording can change completely'};
 const previous=globalThis.window;
 globalThis.window={agent:{call:async()=>({__runtime_reply:2,ok:false,error_info:info})}} as any;
 try{
  await assert.rejects(bridge.call('phonePreview',{}),error=>{
   assert.deepEqual(errorInfo(error),info);assert.equal(sessionEnded(error),true);return true;
  });
  assert.equal(sessionEnded(new Error('人工控制会话已失效，手机正在被占用')),false,'unstructured display prose does not control session state');
 }finally{globalThis.window=previous;}
});

test('unregistered tools do not inherit read permissions or activity from their names',()=>{
 assert.equal(toolDescriptor('search_read_file_without_permissions'),undefined);
 assert.equal(toolDescriptor('task_message')?.effect,'control');
});
