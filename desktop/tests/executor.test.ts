import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANCELLED } from '@pi-bot/agent';
import { Executor, type RunContext } from '../packages/service/src/executor.js';
import { OutsideError } from '../packages/service/src/library.js';

test('saved approval decisions reach real file tools without caching permission after revocation', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'pi-bot-saved-executor-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const outside = join(root,'project'); mkdirSync(outside);
  const file = join(outside,'readme.txt'); writeFileSync(file,'project');
  let active = false, networkFailure = false, approvals = 0, checks = 0;
  const original = globalThis.fetch; t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch = async (url,options) => {
    assert.equal(String(url),'http://127.0.0.1/agent/authorizations/check');
    assert.equal((options!.headers as Record<string,string>).Authorization,'Bearer test-token');
    const body = JSON.parse(options!.body as string);
    assert.equal(body.run_id,'saved-run'); assert.equal(body.access,'read');
    assert.ok(body.path === outside || body.path === file);
    checks++;
    return new Response(JSON.stringify({approved:active}),{status:networkFailure ? 503 : 200});
  };
  const events: any[] = [];
  const executor = new Executor({
    libraryRoot:join(root,'libraries'),agentDir:join(root,'agents'),phoneConfigPath:join(root,'no-phone.json'),
    proxyUrl:'http://127.0.0.1/llm/v1',llmToken:async()=> 'test-token',activity(){},
    send:message=>{
      events.push(message);
      const event = message.event as {kind:string;request_id:string};
      if (event.kind !== 'approval') return;
      approvals++; active = true;
      // Decisions can race ahead of the request-to-approval acknowledgement.
      executor.approvalDecided('saved-run','approval','approve_always');
      executor.approvalCreated('saved-run',event.request_id,'approval');
    },
    factory:async options=>({
      tools:[],setApiKey:async()=>{},dispose(){},abort:async()=>{},
      prompt:async()=>{
        const call = (name:string,args:unknown)=>options.tools!.find(tool=>tool.name===name)!.execute('test',args,undefined,()=>{},{} as any);
        await call('request_outside_access',{path:outside,reason:'read project'});
        const result = await call('read_file',{path:file});
        assert.match(JSON.stringify(result),/project/);
        await assert.rejects(call('write_file',{path:file,content:'bad'}),OutsideError);
        active = false;
        await assert.rejects(call('read_file',{path:file}),OutsideError);
        networkFailure = true;
        await assert.rejects(call('read_file',{path:file}),/无法验证已保存授权/);
        return 'verified';
      },
    }),
  });
  await executor.start({run_id:'saved-run',executor:'device',lane:'task',bot:{id:'bot',name:'Bot',slug:'bot'},model:{id:'model',name:'test',context_window:32000,max_tokens:1000},system:'test',history:[],text:'test'});
  assert.equal(approvals,1); assert.ok(checks>=4);
  assert.equal(events.at(-1).event.state,'completed',JSON.stringify(events.at(-1)));
});

for (const explicitDeadline of [false, true]) {
  test(explicitDeadline ? 'conversation respects an explicit earlier deadline' : 'slow conversation survives one minute and stops after ten minutes', async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-bot-executor-'));
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const events: any[] = [];
    let started!: () => void, rejectPrompt!: (error: Error) => void, aborts = 0;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const executor = new Executor({
      libraryRoot: root, agentDir: join(root, 'agent'), phoneConfigPath: join(root, 'no-phone.json'),
      proxyUrl: 'http://127.0.0.1/llm/v1', llmToken: async () => 'test-token',
      send: event => events.push(event), activity() {},
      factory: async () => ({
        tools: [], setApiKey: async () => {}, dispose() {},
        prompt: () => new Promise<string>((resolve, reject) => { rejectPrompt = reject; started(); }),
        abort: async () => { aborts++; rejectPrompt(new Error(CANCELLED)); },
      }),
    });
    const run: RunContext = {
      run_id: 'slow-conversation', executor: 'device', lane: 'conversation',
      bot: { id: 'bot', name: 'Bot', slug: 'bot' },
      model: { id: 'model', name: 'Qwen', context_window: 32000, max_tokens: 1000 },
      system: 'test', history: [], text: 'hello',
      ...(explicitDeadline ? { deadline_at: new Date(Date.now() + 5000).toISOString() } : {}),
    };
    const running = executor.start(run);
    try {
      await ready;
      if (explicitDeadline) {
        t.mock.timers.tick(4999);
      } else {
        t.mock.timers.tick(60_000);
        assert.equal(aborts, 0, 'a slow model must survive the old one-minute limit');
        t.mock.timers.tick(539_999);
      }
      assert.equal(aborts, 0);
      t.mock.timers.tick(1);
      await running;
      assert.equal(aborts, 1);
      assert.equal(events.at(-1).event.state, 'failed');
      assert.equal(events.at(-1).event.error, '对话响应超时，请重新发送');
    } finally {
      executor.stopAll();
      await running;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
