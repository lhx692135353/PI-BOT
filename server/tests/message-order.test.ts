import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database, type Row } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createBot, insertRun, finishRun, botOut, markBotRead } from "../src/bots.js";
import { resetDatabase, TEST_DB } from "./helpers.js";
const skip=!TEST_DB;
let db:Database,user:string,bot:Row;
before(async()=>{if(skip)return; await resetDatabase(TEST_DB!);db=new Database(TEST_DB!);await migrate(db);
  user=randomUUID();await db.tx(async tx=>{await tx.insert("users",{user_id:user,username:"message-order",password_hash:"unused",role:"user"});bot=await createBot(tx,user,{name:"Test",persona:""});});});
after(async()=>{if(!skip)await db.close();});
test("public messages advance ordering; task, progress and cancelled replies do not",{skip},async()=>{
 await db.tx(async tx=>{
  const old=new Date("2020-01-01");await tx.update("bots",bot.bot_id,{last_message_at:old});
  const background=await insertRun(tx,{userId:user,botId:bot.bot_id,requestId:randomUUID(),text:"task",computer:null,lane:"task",origin:"agent"});
  await finishRun(tx,background.run_id,"completed",null,"background answer");
  assert.equal((await tx.get("bots",bot.bot_id)).last_message_at.toISOString(),old.toISOString());
  const run=await insertRun(tx,{userId:user,botId:bot.bot_id,requestId:randomUUID(),text:"hello",computer:null});
  assert.ok((await tx.get("bots",bot.bot_id)).last_message_at>old);
  await tx.update("bots",bot.bot_id,{last_message_at:old});
  await tx.update("bot_messages",run.assistant_message_id,{content:"partial",updated_at:new Date()});
  assert.equal((await tx.get("bots",bot.bot_id)).last_message_at.toISOString(),old.toISOString());
  await finishRun(tx,run.run_id,"cancelled",null);
  assert.equal((await tx.get("bots",bot.bot_id)).last_message_at.toISOString(),old.toISOString());
  const reply=await insertRun(tx,{userId:user,botId:bot.bot_id,requestId:randomUUID(),text:"next",computer:null});
  await tx.update("bots",bot.bot_id,{last_message_at:old});
  await finishRun(tx,reply.run_id,"completed",null,"answer");
  assert.ok((await tx.get("bots",bot.bot_id)).last_message_at>old);
  const out=await botOut(tx,await tx.get("bots",bot.bot_id));assert.equal(out.unread_count,1);
  const seq=Number((await tx.get("bot_messages",reply.assistant_message_id)).seq);
  assert.equal((await markBotRead(tx,user,bot.bot_id,seq)).unread_count,0);
  assert.equal((await markBotRead(tx,user,bot.bot_id,0)).last_read_seq,seq);
 });
});
test("read cursor cannot swallow a running reply; failure advances order but is not unread",{skip},async()=>{
 await db.tx(async tx=>{
  const run=await insertRun(tx,{userId:user,botId:bot.bot_id,requestId:randomUUID(),text:"pending",computer:null});
  const seq=Number((await tx.get("bot_messages",run.assistant_message_id)).seq);
  assert.ok((await markBotRead(tx,user,bot.bot_id,Number.MAX_SAFE_INTEGER)).last_read_seq<seq);
  await finishRun(tx,run.run_id,"completed",null,"done");
  assert.equal((await botOut(tx,await tx.get("bots",bot.bot_id))).unread_count,1);
  await markBotRead(tx,user,bot.bot_id,seq);
  const failed=await insertRun(tx,{userId:user,botId:bot.bot_id,requestId:randomUUID(),text:"fail",computer:null});
  await tx.update("bots",bot.bot_id,{last_message_at:new Date("2020-01-01")});
  await finishRun(tx,failed.run_id,"failed","error");
  const out=await botOut(tx,await tx.get("bots",bot.bot_id));assert.equal(out.unread_count,0);assert.ok(out.last_message_at>new Date("2020-01-01"));
 });
});

test("internal voice placeholder published after later transcripts remains unread",{skip},async()=>{
 await db.tx(async tx=>{
  const seq=await tx.one("UPDATE bots SET next_seq=next_seq+3 WHERE bot_id=$1 RETURNING next_seq",[bot.bot_id]);
  const id=randomUUID();
  await tx.insert("bot_messages",{message_id:id,bot_id:bot.bot_id,seq:Number(seq!.next_seq)-3,role:"assistant",content:"",status:"running",visibility:"internal"});
  await tx.insert("bot_messages",{message_id:randomUUID(),bot_id:bot.bot_id,seq:Number(seq!.next_seq)-1,role:"user",content:"voice transcript",status:"completed",visibility:"public"});
  const cursor=await markBotRead(tx,user,bot.bot_id,Number(seq!.next_seq)-1);
  assert.ok(cursor.last_read_seq<Number(seq!.next_seq)-3);
  await tx.update("bot_messages",id,{visibility:"public",status:"completed",content:"summary",updated_at:new Date()});
  assert.equal((await botOut(tx,await tx.get("bots",bot.bot_id))).unread_count,1);
 });
});
