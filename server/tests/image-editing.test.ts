import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { annotateImage, annotationSchema, cropImage, cropSchema, orientedImage } from "../src/image-operations.js";
import { editImage, editImageBody, IMAGE_MODELS } from "../src/image-generation.js";
import { resolveImageSource } from "../src/image-source.js";
import { createApp } from "../src/app.js";
import { Database } from "../src/db.js";
import { settings } from "../src/config.js";
import { finishRun, insertRun, setContent } from "../src/bots.js";
import { recordReply } from "../src/replies.js";
import { issueLlmToken } from "../src/security.js";
import { TEST_DB, resetDatabase, tempDir, vaultFile } from "./helpers.js";

const fixture = () => sharp(Buffer.from('<svg width="800" height="400"><rect width="800" height="400" fill="white"/><path d="M60 20 V360 H760 M60 300 Q350 310 700 50 M60 140 H600 V360" fill="none" stroke="black" stroke-width="2"/></svg>')).png().toBuffer();
test("M-point overlays preserve all pixels outside the annotation and crop uses oriented originals", async () => {
  const bytes = await fixture();
  const mark = annotationSchema.parse({ type: "point", x: 0.75, y: 0.35, radius: 0.0125, color: "#ff0000" });
  const result = await annotateImage(bytes, [mark]);
  assert.deepEqual([result.width, result.height], [800,400]);
  const original = await sharp(bytes).ensureAlpha().raw().toBuffer();
  const output = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  for (let y=0;y<400;y++) for(let x=0;x<800;x++) if(Math.abs(x-600)>7 || Math.abs(y-140)>7) {
    const offset=(y*800+x)*4; assert.deepEqual(output.subarray(offset,offset+4),original.subarray(offset,offset+4));
  }
  assert.deepEqual([...output.subarray((140*800+600)*4,(140*800+600)*4+3)], [255,0,0]);
  assert.deepEqual(await sharp(bytes).metadata().then(m=>[m.width,m.height]), [800,400]);
  const rotated = await sharp(bytes).jpeg().withMetadata({orientation:6}).toBuffer();
  assert.deepEqual(await orientedImage(rotated).then(m=>[m.width,m.height]), [400,800]);
  assert.deepEqual(await cropImage(rotated,cropSchema.parse({x:0.25,y:0.25,width:0.5,height:0.5})).then(m=>[m.width,m.height]), [200,400]);
  assert.throws(()=>cropSchema.parse({x:0.9,y:0,width:0.2,height:1}));
  const all = ["text","arrow","line","rectangle","circle"].map(type => annotationSchema.parse({
    text:{type,text:"M 标注",x:0.77,y:0.34},arrow:{type,x1:0.2,y1:0.2,x2:0.7,y2:0.3},line:{type,x1:0,y1:0,x2:1,y2:1},rectangle:{type,x:0.1,y:0.1,width:0.2,height:0.2},circle:{type,x:0.7,y:0.4,radius:0.1},
  }[type]));
  assert.ok((await annotateImage(bytes,all)).bytes.length>0);
});

test("all edit adapters carry source bytes; GPT carries masks; unsupported masks never make a paid request", async () => {
  const bytes=await fixture(), encoded=bytes.toString("base64"); let calls=0;
  for(const model of IMAGE_MODELS) {
    const input=editImageBody.parse({run_id:randomUUID(),request_id:"one",prompt:"change background",model,source:{artifact_id:randomUUID()}});
    await editImage("https://gateway/prefix","secret",input,bytes,model===IMAGE_MODELS[1]?bytes:undefined,undefined,(async(url,init)=>{
      calls++;
      assert.equal(new Headers(init?.headers).get("authorization"),"Bearer secret");
      if(model===IMAGE_MODELS[2]) {
        assert.match(String(url),/prefix\/v1beta\/models\//);
        const parts=JSON.parse(String(init?.body)).contents[0].parts;
        assert.equal(parts[1].inlineData.data,encoded);
        return Response.json({candidates:[{content:{parts:[{inlineData:{data:encoded}}]}}]});
      }
      assert.equal(String(url),"https://gateway/prefix/v1/images/edits");
      assert.equal(new Headers(init?.headers).has("content-type"),false);
      const form=init!.body as FormData;
      assert.deepEqual(Buffer.from(await (form.get("image") as Blob).arrayBuffer()),bytes);
      assert.equal(form.has("mask"),model===IMAGE_MODELS[1]);
      return Response.json({data:[{b64_json:encoded}]});
    }) as typeof fetch);
    if(model!==IMAGE_MODELS[1]) await assert.rejects(editImage("https://gateway","secret",input,bytes,bytes,undefined,(async()=>{throw new Error("must not call");}) as typeof fetch),/蒙版/);
  }
  assert.equal(calls,3);
});

test("image API scopes originals, replays local edits, preserves lineage and verifies delivery", {skip:!TEST_DB}, async t=>{
  await resetDatabase(TEST_DB!);
  const dir=tempDir(), db=new Database(TEST_DB!);
  const s=settings({PI_BOT_DATABASE_URL:TEST_DB!,PI_BOT_ADMIN_PASSWORD:"test-password",PI_BOT_JWT_SECRET:"j".repeat(40),PI_BOT_VAULT_FILE:vaultFile(dir.path),PI_BOT_RUNNER_TOKEN:"r".repeat(40),PI_BOT_REMOTE_BACKEND:"none",PI_BOT_LOCAL_WORK_ROOT:"/pibot-test-workspaces"});
  const app=await createApp(s,db); t.after(async()=>{await app.close();dir.cleanup();});
  const login=(await app.inject({method:"POST",url:"/auth/login",payload:{username:"admin",password:"test-password"}})).json();
  const headers={authorization:`Bearer ${login.access_token}`};
  await app.inject({method:"POST",url:"/admin/api/models",headers,payload:{name:"chat",base_url:"https://example.invalid",provider_model:"test",api_key:"unused",context_window:32000,max_tokens:1000}});
  const bot=(await app.inject({method:"GET",url:"/bots",headers})).json().bots[0].id;
  const bytes=await fixture();
  const run=await db.tx(tx=>insertRun(tx,{userId:login.user.id,botId:bot,requestId:randomUUID(),text:"标 M 点",computer:null,lane:"task",images:[{name:"curve.png",mime_type:"image/png",data:bytes.toString("base64")}]}));
  const message=await db.tx(tx=>tx.get("bot_messages",run.user_message_id));
  const source={message_id:message.message_id,image_id:message.images[0].id};
  const token=await issueLlmToken({sub:login.user.id,bot,src:"cloud"},s);
  const post=(path:string,body:object)=>app.inject({method:"POST",url:`/agent/images/${path}`,headers:{authorization:`Bearer ${token}`},payload:{run_id:run.run_id,...body}});
  const read=await post("read",{source}); assert.equal(read.statusCode,200,read.body); assert.equal(read.json().width,800);
  assert.equal((await post("read",{source:{...source,image_id:randomUUID()}})).statusCode,404);
  await assert.rejects(db.tx(tx=>resolveImageSource(tx,{...run,bot_id:randomUUID()},source)),/共享/);
  assert.deepEqual((await db.tx(tx=>resolveImageSource(tx,{...run,bot_id:randomUUID(),image_refs:[source]},source))).bytes,bytes);
  await assert.rejects(db.tx(tx=>resolveImageSource(tx,{...run,user_id:randomUUID(),image_refs:[source]},source)),/共享/);
  const body={source,request_id:"mark",annotations:[{type:"point",x:0.75,y:0.35},{type:"text",text:"M",x:0.77,y:0.34}]};
  const first=await post("annotate",body); assert.equal(first.statusCode,200,first.body);
  const id=first.json().artifact.id;
  assert.equal((await post("annotate",body)).json().artifact.id,id);
  assert.equal((await post("annotate",{...body,annotations:[{type:"point",x:0.1,y:0.1}]})).statusCode,409);
  const artifact=await db.tx(tx=>tx.get("report_artifacts",id)); assert.deepEqual(artifact.image_metadata.source,source);
  const crop=await post("crop",{source:{artifact_id:id},request_id:"crop",crop:{x:0,y:0,width:0.5,height:0.5}});assert.equal(crop.statusCode,200,crop.body);
  await db.tx(async tx=>{await finishRun(tx,run.run_id,"completed",null,"图片已保存。");assert.equal((await tx.get("bot_runs",run.run_id)).status,"completed");});
  const parent=await db.tx(tx=>insertRun(tx,{userId:login.user.id,botId:bot,requestId:randomUUID(),text:"委托标图",computer:null}));
  const other=(await app.inject({method:"POST",url:"/bots",headers,payload:{name:"改图助手",persona:""}})).json().id;
  const delegated=await app.inject({method:"POST",url:"/agent/tasks",headers:{authorization:`Bearer ${token}`},payload:{run_id:parent.run_id,agent:other,task:"标注共享原图",wait:false,execution:"cloud",expected_output:"image",image_refs:[source]}});
  assert.equal(delegated.statusCode,200,delegated.body);
  const child=await db.tx(tx=>tx.one("SELECT r.* FROM bot_runs r JOIN agent_tasks t ON t.child_run_id=r.run_id WHERE t.task_id=$1",[delegated.json().id]));
  assert.equal(child!.expected_output,"image");assert.deepEqual(child!.image_refs,[source]);
  assert.deepEqual((await db.tx(tx=>resolveImageSource(tx,child!,source))).bytes,bytes);
  const published=await db.tx(tx=>insertRun(tx,{userId:login.user.id,botId:bot,requestId:randomUUID(),text:"保存后再取消",computer:null,lane:"task"}));
  const saved=await post("annotate",{...body,run_id:published.run_id,request_id:"before-cancel"});assert.equal(saved.statusCode,200,saved.body);
  await db.tx(async tx=>{
    await tx.update("bot_runs",published.run_id,{cancel_requested:true});
    await finishRun(tx,published.run_id,"completed",null,"已完成");
    const output=await tx.get("bot_messages",published.assistant_message_id);assert.equal(output.status,"cancelled");assert.match(output.content,/已保存/);assert.doesNotMatch(output.content,/未交付/);
  });
  const cancelled=await db.tx(tx=>insertRun(tx,{userId:login.user.id,botId:bot,requestId:randomUUID(),text:"取消图片任务",computer:null,lane:"task"}));
  await db.tx(async tx=>{
    await tx.update("bot_runs",cancelled.run_id,{expected_output:"image",cancel_requested:true});
    await tx.update("bot_messages",cancelled.assistant_message_id,{reply_segments:[{id:"legacy",phase:"answer",text:"已完成",created_at:new Date().toISOString(),generated_at:new Date().toISOString()}]});
    await finishRun(tx,cancelled.run_id,"completed",null,"已完成");
    const output=await tx.get("bot_messages",cancelled.assistant_message_id);assert.equal(output.status,"cancelled");assert.doesNotMatch(output.content,/已完成/);
  });
  const empty=await db.tx(tx=>insertRun(tx,{userId:login.user.id,botId:bot,requestId:randomUUID(),text:"生图",computer:null,lane:"task"}));
  await db.tx(async tx=>{
    const current=await tx.update("bot_runs",empty.run_id,{expected_output:"image"});
    await recordReply(tx,current,{id:"lie",phase:"answer",text:"已标注完成",generated_at:new Date().toISOString()});
    await setContent(tx,current,"已标注完成");
    assert.equal((await tx.get("bot_messages",empty.assistant_message_id)).content,"");
    await finishRun(tx,empty.run_id,"completed",null,"已标注完成");
    assert.equal((await tx.get("bot_runs",empty.run_id)).status,"failed");
    const output=await tx.get("bot_messages",empty.assistant_message_id); assert.doesNotMatch(output.content,/已标注完成/);assert.match(output.content,/未完成/);
  });
});
