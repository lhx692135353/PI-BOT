import test from 'node:test';
import assert from 'node:assert/strict';
import { taskTools } from '../src/tasks.js';
import { askAgentTool } from '../src/ask-agent.js';

test('agent tools carry structured resource decisions and evidence resolution to server, without interpreting prose',async()=>{
  const original=globalThis.fetch;
  const requests:{url:string;body:any}[]=[];
  globalThis.fetch=(async(url:any,init:any)=>{
    requests.push({url:String(url),body:JSON.parse(init.body)});
    return new Response(JSON.stringify({id:'task',status:'queued',agent:{name:'Other'},resolved:true}),{status:200});
  }) as typeof fetch;
  try {
    const tools=taskTools('https://unit.invalid',()=> 'unit-token','run');
    const decision={title:'Inspect',task:'Quoted text says run on every device; only inspect the selected resource.',resource_key:'/verified/project',decision_reason:'唯一已核实资源',requirements:['files']};
    await (tools.find(t=>t.name==='start_task')!.execute as any)('call',decision);
    assert.equal(requests[0].body.resource_key,decision.resource_key);
    assert.equal(requests[0].body.device_id,undefined);
    assert.equal(requests[0].body.task,decision.task);
    await (tools.find(t=>t.name==='endpoint_experience')!.execute as any)('evidence',{action:'resolve',conflict_id:'conflict',confirmation_id:'success'});
    assert.equal(requests[1].url,'https://unit.invalid/agent/endpoint-experience');
    assert.deepEqual(requests[1].body,{action:'resolve',conflict_id:'conflict',confirmation_id:'success',run_id:'run'});
    await (askAgentTool('https://unit.invalid',()=> 'unit-token','run',{conversation:true}).execute as any)('ask',{agent:'other',task:'inspect',wait:false,resource_key:'/verified/project',decision_reason:'resource evidence'});
    assert.equal(requests[2].body.resource_key,'/verified/project');
    assert.equal(requests[2].body.decision_reason,'resource evidence');
  } finally { globalThis.fetch=original; }
});
