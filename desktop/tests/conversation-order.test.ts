import test from 'node:test';
import assert from 'node:assert/strict';
import {orderBots} from '../apps/desktop/ui/conversation-order.js';
import type {Bot} from '../packages/protocol/src/index.js';
const bot=(id:string,time:string,main=false)=>({id,last_message_at:time,last_active_at:'2099-01-01',is_main:main} as Bot);
test('message ordering pins main and breaks ties without activity time',()=>{
 const a=bot('a','2026-01-01'),b=bot('b','2026-01-02'),m=bot('m','2020-01-01',true);
 assert.deepEqual(orderBots([a,b,m]).map(x=>x.id),['m','b','a']);
 assert.deepEqual(orderBots([bot('z','2026-01-01'),a]).map(x=>x.id),['a','z']);
 a.last_active_at='2100-01-01';assert.deepEqual(orderBots([a,b]).map(x=>x.id),['b','a']);
});
test('legacy server preserves order rather than reordering on activity',()=>{
 const bots=[bot('z','2020-01-01'),{id:'a'} as Bot];assert.equal(orderBots(bots),bots);
});
