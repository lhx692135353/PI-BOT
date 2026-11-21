import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {Database} from '../src/db.js';
import {migrate} from '../src/migrate.js';
import {Hub} from '../src/hub.js';
import {sockets} from '../src/sockets.js';
import {settings} from '../src/config.js';
import {issueToken} from '../src/security.js';
import {createBot,insertRun,setContent,finishRun} from '../src/bots.js';
import {TEST_DB,resetDatabase,socket,eventually} from './helpers.js';
test('two actual websocket replicas deliver long public resets and cancellation; reconnect heals running text',{skip:!TEST_DB},async t=>{
 await resetDatabase(TEST_DB!);const db=new Database(TEST_DB!);await migrate(db);
 const user={user_id:randomUUID(),username:'ws-streams',password_hash:'unused',role:'user'};
 let bot:any;await db.tx(async tx=>{await tx.insert('users',user);bot=await createBot(tx,user.user_id,{name:'WS',persona:''});});
 const s=settings({PI_BOT_DATABASE_URL:TEST_DB!,PI_BOT_JWT_SECRET:'j'.repeat(40),PI_BOT_REMOTE_BACKEND:'none'});
 const token=await issueToken(user,s);
 const replicas=[];for(let i=0;i<2;i++){
  const app=Fastify();await app.register(websocket);await sockets(app,new Database(TEST_DB!),s,new Hub());await app.listen({host:'127.0.0.1',port:0});replicas.push(app);
 }
 const connections:any[]=[];t.after(async()=>{for(const c of connections)c.ws.terminate();for(const app of replicas)await app.close();await db.close();});
 const url=(app:any)=>`ws://127.0.0.1:${app.server.address().port}/ws/events`;
 for(const app of replicas){const c=await socket(url(app),{authorization:`Bearer ${token}`});connections.push(c);await eventually(()=>c.frames.some((e:any)=>e.type==='hello'));}
 let run:any;await db.tx(async tx=>{run=await insertRun(tx,{userId:user.user_id,botId:bot.bot_id,requestId:randomUUID(),text:'hello',computer:null});});
 const text='汉字🙂'.repeat(5000);
 await db.tx(tx=>setContent(tx,run,text));
 for(const c of connections)await eventually(()=>c.frames.some((e:any)=>e.event?.type==='stream' && e.event.text===text));
 const reconnect=await socket(url(replicas[1]),{authorization:`Bearer ${token}`});connections.push(reconnect);
 await eventually(()=>reconnect.frames.some((e:any)=>e.event?.type==='stream' && e.event.text===text));
 await db.tx(tx=>finishRun(tx,run.run_id,'cancelled',null));
 for(const c of connections)await eventually(()=>c.frames.some((e:any)=>e.event?.type==='stream' && e.event.status==='cancelled'));
 for(const c of connections){const frames=c.frames.filter((e:any)=>e.event?.type==='stream').map((e:any)=>e.event);assert.ok(frames.every((f:any)=>f.message.role==='assistant' && f.message_id===run.assistant_message_id));assert.ok(frames.at(-1).seq>0);}
});
