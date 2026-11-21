import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Database,type Row} from '../src/db.js';
import {migrate} from '../src/migrate.js';
import {createBot,insertRun,setContent,finishRun} from '../src/bots.js';
import {publicStreams,streamFrame} from '../src/streams.js';
import {TEST_DB,resetDatabase} from './helpers.js';
const skip=!TEST_DB;let db:Database,user:string,bot:Row,run:Row;
before(async()=>{if(skip)return;await resetDatabase(TEST_DB!);db=new Database(TEST_DB!);await migrate(db);user=randomUUID();await db.tx(async tx=>{await tx.insert('users',{user_id:user,username:'streams',password_hash:'unused',role:'user'});bot=await createBot(tx,user,{name:'Stream',persona:''});run=await insertRun(tx,{userId:user,botId:bot.bot_id,requestId:randomUUID(),text:'hello',computer:null});});});
after(async()=>{if(!skip)await db.close();});
test('persisted reset frames support first placeholder, long text, independent replicas and terminal states',{skip},async()=>{
 let frames=await publicStreams(db,user,bot.bot_id);assert.equal(frames.length,1);const initial=frames[0];assert.equal(initial.offset,0);assert.equal(initial.reset,true);assert.equal(initial.message.status,'running');
 const text='汉字🙂'.repeat(5000);
 await db.tx(tx=>setContent(tx,run,text));
 frames=await publicStreams(db,user,bot.bot_id,run.assistant_message_id);assert.equal(frames[0].text,text);assert.ok(frames[0].seq>initial.seq);
 const replica=new Database(TEST_DB!);try {assert.deepEqual(await publicStreams(replica,user,bot.bot_id),frames);}finally{await replica.close();}
 const seq=frames[0].seq;
 await db.tx(tx=>setContent(tx,run,text));assert.equal((await publicStreams(db,user,bot.bot_id))[0].seq,seq);
 await db.tx(tx=>finishRun(tx,run.run_id,'cancelled',null));
 frames=await publicStreams(db,user,bot.bot_id);assert.equal(frames[0].status,'cancelled');assert.ok(frames[0].seq>seq);
 assert.equal((await publicStreams(db,user,bot.bot_id,undefined,true)).length,0);
 assert.equal((await publicStreams(db,randomUUID(),bot.bot_id)).length,0);
});
test('internal images/tasks/reasoning never become public frames',()=>{assert.equal(streamFrame({role:'assistant',visibility:'internal',content:'secret'}),null);assert.equal(streamFrame({role:'user',visibility:'public'}),null);});
