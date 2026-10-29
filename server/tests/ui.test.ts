import { insertRun, finishRun } from "../src/bots.js";
import { createTask, AgentDispatcher } from "../src/agents.js";
import { dispatchDevice } from "../src/runs.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { createRunner } from "../src/runner.js";
import { Database } from "../src/db.js";
import { Worker } from "../src/worker.js";
import { settings } from "../src/config.js";
import { EXAMPLE } from "@pi-bot/a2ui";
import {
  mockProvider,
  resetDatabase,
  TEST_DB,
  tempDir,
  vaultFile,
  deviceKeys,
  socket,
  eventually,
} from "./helpers.js";
const skip = !TEST_DB && "需要 PI_BOT_TEST_DATABASE_URL";
let app: Awaited<ReturnType<typeof createApp>>,
  runner: Awaited<ReturnType<typeof createRunner>>,
  provider: Awaited<ReturnType<typeof mockProvider>>,
  worker: Worker,
  db: Database,
  dir: ReturnType<typeof tempDir>;
let base: string,
  token: string,
  other: string,
  botId: string,
  messageId: string;
async function api(method: string, path: string, body?: unknown, auth = token) {
  const r = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${auth}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: (await r.json()) as any };
}
before(async () => {
  if (skip) return;
  await resetDatabase(TEST_DB!);
  dir = tempDir();
  provider = await mockProvider();
  runner = await createRunner({ token: "r".repeat(40), dir: dir.path });
  await runner.listen({ host: "127.0.0.1", port: 0 });
  const env = {
    PI_BOT_DATABASE_URL: TEST_DB,
    PI_BOT_ADMIN_PASSWORD: "admin-password",
    PI_BOT_JWT_SECRET: "j".repeat(40),
    PI_BOT_VAULT_FILE: vaultFile(dir.path),
    PI_BOT_RUNNER_TOKEN: "r".repeat(40),
    PI_BOT_RUNNER_URL: `http://127.0.0.1:${(runner.server.address() as any).port}`,
  };
  app = await createApp(settings(env));
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const admin = (
    await api(
      "POST",
      "/auth/login",
      { username: "admin", password: "admin-password" },
      "",
    )
  ).json.access_token;
  for (const username of ["ui-owner", "ui-other"])
    await api(
      "POST",
      "/admin/api/users",
      { username, password: "test-password" },
      admin,
    );
  token = (
    await api(
      "POST",
      "/auth/login",
      { username: "ui-owner", password: "test-password" },
      "",
    )
  ).json.access_token;
  other = (
    await api(
      "POST",
      "/auth/login",
      { username: "ui-other", password: "test-password" },
      "",
    )
  ).json.access_token;
  await api(
    "POST",
    "/admin/api/models",
    {
      name: "UI model",
      base_url: provider.url,
      provider_model: "ui-model",
      api_key: "sk-test-only",
      context_window: 32000,
      max_tokens: 2000,
    },
    admin,
  );
  botId = (await api("POST", "/bots", { name: "UI Bot" })).json.id;
  db = new Database(TEST_DB!);
  worker = new Worker(db, settings({ ...env, PI_BOT_INTERNAL_URL: base }));
});
after(async () => {
  if (skip) return;
  worker.stop();
  await runner.close();
  await app.close();
  await db.close();
  await provider.close();
  dir.cleanup();
});
test(
  "real cloud Agent show_ui reaches Worker, persists with the reply and survives timeline reload",
  { skip },
  async () => {
    const sent = await api("POST", `/bots/${botId}/messages`, {
      text: "交互界面链路测试",
      request_id: randomUUID(),
    });
    assert.equal(sent.status, 200);
    await worker.runOnce();
    const page = await api("GET", `/bots/${botId}/messages`);
    const reply = page.json.messages.at(-1);
    assert.equal(reply.status, "completed", JSON.stringify(reply));
    assert.equal(reply.ui.surfaces[0].data.amount, 50);
    assert.equal(reply.ui.revision, 1);
    messageId = reply.id;
    assert.ok(
      provider.requests.some((r) =>
        r.body.tools?.some((t: any) => t.name === "show_ui"),
      ),
    );
  },
);
test(
  "a successful UI-only response completes without requiring artificial assistant text",
  { skip },
  async () => {
    const created = await api("POST", "/bots", { name: "UI only" });
    const id = created.json.id;
    assert.equal(
      (
        await api("POST", `/bots/${id}/messages`, {
          text: "纯交互界面链路测试",
          request_id: randomUUID(),
        })
      ).status,
      200,
    );
    await worker.runOnce();
    const reply = (await api("GET", `/bots/${id}/messages`)).json.messages.at(
      -1,
    );
    assert.equal(reply.status, "completed");
    assert.equal(reply.content, "");
    assert.ok(reply.ui);
  },
);
test(
  "UI state is private; concurrent device changes have a single winner and stale writes are rejected",
  { skip },
  async () => {
    const path = `/bots/${botId}/messages/${messageId}/ui-state`;
    const body = {
      revision: 1,
      states: [{ surfaceId: "calculator", data: { amount: 70 } }],
    };
    assert.equal((await api("POST", path, body, other)).status, 404);
    const replies = await Promise.all([
      api("POST", path, body),
      api("POST", path, {
        ...body,
        states: [{ surfaceId: "calculator", data: { amount: 80 } }],
      }),
    ]);
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
    const current = (
      await api("GET", `/bots/${botId}/messages`)
    ).json.messages.find((m: any) => m.id === messageId);
    assert.equal(current.ui.revision, 2);
    assert.ok([70, 80].includes(current.ui.surfaces[0].data.amount));
  },
);
test(
  "published actions use current state, run through the normal task path, and retries are idempotent",
  { skip },
  async () => {
    const path = `/bots/${botId}/messages/${messageId}/ui-actions`;
    const body = {
      revision: 2,
      states: [{ surfaceId: "calculator", data: { amount: 81 } }],
      action: {
        name: "submit",
        surfaceId: "calculator",
        sourceComponentId: "submit",
        context: { amount: 999 },
      },
      request_id: randomUUID(),
    };
    assert.equal(
      (
        await api("POST", path, {
          ...body,
          action: { ...body.action, name: "run_command" },
        })
      ).status,
      422,
    );
    assert.equal((await api("POST", path, body, other)).status, 404);
    const posted = await api("POST", path, body);
    assert.equal(posted.status, 200, JSON.stringify(posted.json));
    assert.equal(posted.json.run.executor, "cloud");
    assert.equal(
      posted.json.messages[0].content,
      "在交互工具中选择了「交给 Bot 继续处理」",
    );
    const detail = await db.tx((tx) =>
      tx.get("bot_messages", posted.json.run.user_message_id),
    );
    assert.equal(detail.ui_action.action.context.amount, 81);
    const again = await api("POST", path, body);
    assert.equal(again.status, 200);
    assert.equal(again.json.run.id, posted.json.run.id);
    await worker.runOnce();
    assert.equal(
      (await api("GET", `/bots/${botId}`)).json.latest_run.status,
      "completed",
    );
    const page = (await api("GET", `/bots/${botId}/messages`)).json.messages;
    assert.equal(page.length, 4);
    assert.equal(
      page.find((m: any) => m.id === messageId).ui.surfaces[0].data.amount,
      81,
    );
  },
);
test("device task A2UI stays private until the cloud publishes the completed report",{skip},async()=>{
  const keys=deviceKeys(),reg=await api("POST","/devices/register",{public_key:keys.publicKey,label:"UI test computer"});keys.setId(reg.json.device.id);
  const computer=socket(base.replace("http","ws")+"/ws/device",keys.headers("GET","/ws/device"));await computer.next(m=>m.type==='hello');
  computer.send({type:'capabilities',features:['files','shell']});
  const user=(await api('GET','/me')).json.user;
  await eventually(()=>(app as any).hub.device(user.id,reg.json.device.id)?.capabilities?.includes('shell'));
  try {
    const task=await db.tx(async tx=>{
      const parent=await insertRun(tx,{userId:user.id,botId,requestId:randomUUID(),text:'show UI',computer:null});
      await tx.update('bot_runs',parent.run_id,{status:'running'});
      const task=await createTask(tx,(app as any).hub,user.id,{sub:user.id,src:'cloud',bot:botId},{run_id:parent.run_id,kind:'background',task:'show UI',execution:'device',device_id:reg.json.device.id,wait:false},settings({PI_BOT_DATABASE_URL:TEST_DB,PI_BOT_JWT_SECRET:"j".repeat(40)}));
      await finishRun(tx,parent.run_id,'completed',null,'已安排');return task;
    });
    const config=settings({PI_BOT_DATABASE_URL:TEST_DB,PI_BOT_JWT_SECRET:'j'.repeat(40)});
    await dispatchDevice(db,config,(app as any).hub,task.run!.run_id);
    const job=(await computer.next(m=>m.type==='run' && m.run.run_id===task.run!.run_id)).run;
    computer.send({type:'run_event',run_id:job.run_id,event:{kind:'ui',messages:EXAMPLE}});
    await eventually(async()=> (await db.tx(tx=>tx.get('bot_messages',task.run!.assistant_message_id))).ui?.revision===1);
    assert.ok(!(await api('GET',`/bots/${botId}/messages`)).json.messages.some((m:any)=>m.run_id===job.run_id));
    computer.send({type:'run_event',run_id:job.run_id,event:{kind:'done',state:'completed',text:'已展示'}});
    await eventually(async()=> (await db.tx(tx=>tx.get('bot_runs',job.run_id))).status==='completed');
    await new AgentDispatcher(db,config,(app as any).hub).once();await worker.runOnce();
    const reply=await eventually(async()=> (await api('GET',`/bots/${botId}/messages`)).json.messages.find((m:any)=>m.task_id===task.task.id && m.ui));
    assert.equal(reply.ui.revision,1);assert.equal(reply.executor,'cloud');assert.equal(reply.status,'completed');
  } finally {computer.close();}
});
