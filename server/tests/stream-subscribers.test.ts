import test from 'node:test';import assert from 'node:assert/strict';import {Hub} from '../src/hub.js';
test('stream subscriber detection includes listeners and devices, isolated by user',()=>{
 const hub=new Hub();assert.equal(hub.hasSubscribers('u'),false);
 const stop=hub.subscribe('u',()=>{});assert.equal(hub.hasSubscribers('u'),true);assert.equal(hub.hasSubscribers('other'),false);stop();assert.equal(hub.hasSubscribers('u'),false);
 const sent:any[]=[];const conn={userId:'u',deviceId:'d',close:()=>{},send:(e:any)=>sent.push(e)};hub.attach(conn);
 assert.equal(hub.hasSubscribers('u'),true);assert.equal(hub.hasSubscribers('other'),false);
 hub.publish('u',{type:'stream',bot_id:'b',message_id:'m',run_id:'r',stream_id:'m',seq:1,offset:0,reset:true,text:'hello',status:'running',message:{id:'m'}});
 assert.equal(sent.at(-1).event.type,'stream');hub.detach(conn);assert.equal(hub.hasSubscribers('u'),false);
});
