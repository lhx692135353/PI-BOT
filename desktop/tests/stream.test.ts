import test from 'node:test';import assert from 'node:assert/strict';
import {applyStream,mergeTail,liveReplySegments,type StreamFrame} from '../apps/desktop/ui/timeline-cache.js';
import type {Message} from '../packages/protocol/src/index.js';
const m={id:'m',bot_id:'b',seq:1,role:'assistant',status:'running',content:'',created_at:'now',reply_segments:[{id:'o',phase:'opening',text:'starting'}]} as Message;
const frame=(seq:number,text:string,status:Message['status']='running')=>({type:'stream',bot_id:'b',message_id:'m',stream_id:'m',seq,offset:0,reset:true,text,status,message:m} as StreamFrame);
test('first frame creates placeholder; duplicates/out of order ignored; resets repair gaps',()=>{
 let page=applyStream(undefined,frame(1,'汉字🙂'.repeat(5000)))!;assert.equal(page.messages[0].content.length,20000);
 assert.equal(applyStream(page,frame(1,'dup')),page);assert.equal(applyStream(page,frame(0,'old')),page);
 page=applyStream(page,frame(8,'done','completed'))!;assert.equal(page.messages[0].content,'done');
 assert.equal(applyStream(page,frame(9,'stale','running')),page);
 assert.equal(mergeTail(page,{messages:[{...m,stream_seq:2}],has_more:false}).messages[0].content,'done');
});
test('live text is visible alongside opening segments; cancellation retained',()=>{
 const page=applyStream(undefined,frame(2,'live'))!;assert.equal(liveReplySegments(page.messages[0]).at(-1)?.text,'live');
 assert.equal(applyStream(page,frame(3,'partial','cancelled'))?.messages[0].status,'cancelled');
 assert.equal(applyStream(page,{...frame(4,'bad'),reset:false}),page);
});
