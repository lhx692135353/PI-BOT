import { createRunner } from '../../server/src/runner.js';
import { Worker } from '../../server/src/worker.js';
import { isRealToolResult, latestUserText, realToolOutputs, ResponseStream } from "../../packages/agent/tests/responses.js";
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/src/app.js';
import { settings } from '../../server/src/config.js';
import { WebSearch } from '../../server/src/search.js';
import { Hub } from '../../server/src/hub.js';
import { eventually, mockSearch, resetDatabase, TEST_DB, vaultFile } from '../../server/tests/helpers.js';
import { Application } from '../packages/service/src/application.js';
import { buildContext } from '../../server/src/bots.js';
import { Database } from '../../server/src/db.js';
import { MemoryCredentials } from '../packages/service/src/keychain.js';
import type { AppEvent, Bot, MessagePage } from '../packages/protocol/src/index.js';

const skip = !TEST_DB && '需要 PI_BOT_TEST_DATABASE_URL';
const browserMode = process.env.PI_BOT_TEST_BROWSER;
const browserSkip = skip || (!['chrome', 'chromium', 'auto'].includes(browserMode ?? '') && '需要 PI_BOT_TEST_BROWSER=chrome 或 chromium');
const handoffSkip = browserSkip || (process.env.PI_BOT_TEST_BROWSER_HANDOFF !== '1' && '需要 PI_BOT_TEST_BROWSER_HANDOFF=1');
const electronSkip = skip || (process.platform === 'linux' && !process.env.DISPLAY && '需要桌面显示或 Xvfb');
const BROWSER_PRIVATE_LOG = 'LOCAL-ONLY-BROWSER-DIAGNOSTIC';

async function browserPages() {
  let forbiddenHits = 0;
  let redirectHits = 0;
  const listen = async (server: ReturnType<typeof createServer>) => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  };
  const forbidden = createServer((_req, res) => { forbiddenHits++; res.end('outside'); });
  const other = await listen(forbidden);
  const site = createServer((req, res) => {
    if (req.url === '/redirect') {
      redirectHits++;
      return void res.writeHead(302, { location: other + '/redirect-target' }).end();
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(`
      <title>Registration</title>
      <form><label>Email <input aria-label="Email"></label><button>Register</button></form>
      <div role="status"></div>
      <script>
        document.querySelector('form').onsubmit = e => {
          e.preventDefault();
          document.querySelector('[role=status]').textContent = document.querySelector('input').value ? 'Registration saved' : 'Missing email';
          console.error('${BROWSER_PRIVATE_LOG}');
          fetch('${other}/subrequest').catch(() => {});
        };
      </script>`);
  });
  const origin = await listen(site);
  return { origin, other, hits: () => forbiddenHits, redirects: () => redirectHits, async close() {
    await Promise.all([site, forbidden].map(server => new Promise<void>(resolve => {
      server.closeAllConnections(); server.close(() => resolve());
    })));
  } };
}
const text = (c: any): string => (Array.isArray(c) ? c.map(p => p.text ?? '').join('') : String(c ?? ''));

/** A provider double that drives the agent through tool calls based on the latest user text. */
async function scriptedProvider(outside: string, browserOrigin?: string, dependencyOrigin?: string) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(json);
    if (!json.stream) {
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({id:'maintenance',object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({memories:[],topics:[]})}]}],usage:{input_tokens:1,output_tokens:1}}));
      return;
    }
    const messages: any[] = json.input;
    const user = latestUserText(messages);
    const toolDone = isRealToolResult(messages);
    const results = realToolOutputs(messages).map(m => text(m.output));
    let reply: { text?: string; tool?: { name: string; args: object } };
    const goalId = user.match(/"id":"([0-9a-f-]{36})"/)?.[1];
    const originalUser = latestUserText(messages);
    if (user === '测一下 Electron 测试应用') {
      const executable = createRequire(new URL('../package.json', import.meta.url))('electron');
      reply = toolDone ? { text: '已安排应用测试。' } : { tool: { name: 'start_task', args: {
        electron_test: { app: 'electron', executable, entry: join(dir, 'fixture.cjs') }, title: '应用测试', task: '执行 Electron 测试',
      } } };
    } else if (user === '执行 Electron 测试') {
      assert.ok(!json.tools.some((tool: any) => ['run_command', 'browser_test'].includes(tool.name)));
      const steps = [
        { action: 'open' }, { action: 'assert', selector: 'h1', value: 'Fixture app' },
        { action: 'login' }, { action: 'screenshot' },
      ];
      if (!results.length) {
        assert.ok(!json.tools.some((tool: any) => tool.name === 'electron_test'));
        reply = { tool: { name: 'tool_search', args: { query: 'electron_test' } } };
      } else {
        assert.match(results[0], /electron_test/);
        assert.ok(json.tools.some((tool: any) => tool.name === 'electron_test'));
        const args = steps[results.length - 1];
        reply = args ? { tool: { name: 'electron_test', args } } : {
          text: results.at(-1)?.includes('screenshot-1.png') ? '已完成应用交接并截图。' : '应用测试出错。',
        };
      }
    } else if (user === `测试网页注册流程 ${browserOrigin}/register`) {
      assert.ok(!json.tools.some((tool: any) => tool.name === 'browser_test'));
      reply = toolDone ? { text: '已安排网页测试。' } :
        { tool: { name: 'start_task', args: { browser_test_origin: browserOrigin, title: '网页注册测试', task: '验证浏览器注册流程' } } };
    } else if (user === '验证浏览器注册流程') {
      assert.ok(!json.tools.some((tool: any) => ['run_command', 'web_search'].includes(tool.name)));
      const steps = [
        { op: 'open', url: browserOrigin + '/redirect' }, { op: 'open', url: browserOrigin },
        { op: 'observe' }, { op: 'fill', role: 'textbox', name: 'Email', text: 'fixture@example.test' },
        { op: 'click', role: 'button', name: 'Register' },
        { op: 'assert', role: 'status', text: 'Registration saved' },
        { op: 'assert', role: 'status', text: 'Missing email' }, { op: 'diagnostics' },
      ];
      if (!results.length) {
        assert.ok(!json.tools.some((tool: any) => tool.name === 'browser_test'));
        reply = { tool: { name: 'tool_search', args: { query: 'browser_test' } } };
      } else {
        assert.match(results[0], /browser_test/);
        assert.ok(json.tools.some((tool: any) => tool.name === 'browser_test'));
        const args = steps[results.length - 1];
        reply = args ? { tool: { name: 'browser_test', args } } : { text: '注册流程通过，错误消息校验失败，已保存本机截图。' };
      }
    } else if (user === `打开测试窗口让我登录 ${browserOrigin}/register`) {
      reply = toolDone ? { text: '已安排可见浏览器任务。' } : {
        tool: { name: 'start_task', args: { browser_test_origin: browserOrigin, browser_test_visible: true, title: '可见浏览器交接', task: '验证浏览器登录交接' } },
      };
    } else if (user === '验证浏览器登录交接') {
      if (results.length === 0) reply = { tool: { name: 'tool_search', args: { query: 'browser_test' } } };
      else if (results.length === 1) reply = { tool: { name: 'browser_test', args: { op: 'open', url: browserOrigin } } };
      else if (results.length === 2) reply = { tool: { name: 'browser_test', args: { op: 'login' } } };
      else reply = { text: results.at(-1)?.includes('"resumed":true') ? '收到继续信号，已接回测试窗口。' : '用户取消了登录。' };
    } else if (user === '检查推断的测试站点' || user === '重新检查推断的测试站点') {
      reply = toolDone ? { text: '已安排网站权限测试。' } :
        { tool: { name: 'start_task', args: { browser_test_origin: browserOrigin, title: '单次网站权限', task: '验证本次网站授权' } } };
    } else if (user === '验证本次网站授权') {
      const browserCalls = messages.filter(message => message.type === 'function_call' && message.name === 'browser_test');
      if (!toolDone) reply = { tool: { name: 'tool_search', args: { query: 'browser_test' } } };
      else if (!browserCalls.length) reply = { tool: { name: 'browser_test', args: { op: 'open', url: browserOrigin + '/redirect' } } };
      else if (results.at(-1)?.includes('本次任务未获得网站访问授权')) reply = { text: '未获授权，未访问推断的网站。' };
      else if (browserCalls.length === 1) reply = { tool: { name: 'browser_test', args: { op: 'authorize', origins: [dependencyOrigin] } } };
      else if (browserCalls.length === 2) reply = { tool: { name: 'browser_test', args: { op: 'open', url: browserOrigin + '/redirect' } } };
      else reply = { text: '已访问本次授权的依赖站点。' };
    } else if (user === '核对云端测试工具') {
      reply = toolDone ? { text: '已安排云端核查。' } :
        { tool: { name: 'start_task', args: { execution: 'cloud', title: '核对云端工具', task: '在云端搜索端侧浏览器工具' } } };
    } else if (user === '在云端搜索端侧浏览器工具') {
      assert.ok(!json.tools.some((tool: any) => tool.name === 'browser_test'));
      reply = toolDone ? { text: '云端未提供端侧浏览器工具。' } :
        { tool: { name: 'tool_search', args: { query: 'browser_test' } } };
    } else if (originalUser === '问问压测智能体为什么停了') {
      const asked = messages.some(m => m.type === 'function_call' && m.name === 'ask_agent');
      reply = asked ? { text: '询问已提交，等对方回报。' }
        : { tool: { name: 'ask_agent', args: { agent: '压测智能体', task: '请核实停止原因，并报告已有数据。', wait: false, execution: 'device' } } };
    }
    else if (user.startsWith('你收到来自智能体') && user.includes('请核实停止原因，并报告已有数据。')) reply = { text: '压测已按用户要求停止，已有结果在报告目录。' };
    else if (user === '分条回复测试') reply = results.length === 0
      ? { tool: { name: 'send_reply', args: { phase: 'opening', text: '先核对服务状态。' } } }
      : results.length === 1 ? { tool: { name: 'send_reply', args: { phase: 'answer', text: '服务正常，接下来再测一次。' } } }
      : { text: '服务正常，接下来再测一次。' };
    else if (user === '建立自动检查链路测试') reply = toolDone
      ? { text: '已建立目标，有进展会告诉你。' }
      : { tool: { name: 'goal_manage', args: { action: 'create', title: '自动检查链路测试', goal: '把已授权的检查结论保存到自动记录文件，完成后告知', authorization: '用户授权在自己的资料库创建 automation/result.txt' } } };
    else if (user === '建立一个会保持安静的目标') reply = toolDone
      ? { text: '已记下这个目标。' }
      : { tool: { name: 'goal_manage', args: { action: 'create', title: '静默目标', goal: '没有新进展就保持安静', authorization: '没有明确下一步时不要改文件' } } };
    else if (user.startsWith('目标检查') && user.includes('静默目标')) {
      assert.ok(json.tools.some((t: any) => t.name === 'write_file'));
      assert.ok(!json.tools.some((t: any) => t.name === 'ask_agent'), 'goal review exposed ask_agent');
      reply = results.length
        ? { text: 'PRIVATE 静默检查输出' }
        : { tool: { name: 'goal_finish', args: { goals: [{ id: goalId, state: 'continue', progress: '没有新的重要变化', notify: false, reason: '已检查' }] } } };
    }
    else if (user.startsWith('目标检查') && user.includes('自动检查链路测试')) {
      if (!results.length) reply = { tool: { name: 'write_file', args: { path: 'automation/result.txt', content: '自动检查已完成' } } };
      else if (results.length === 1) reply = { tool: { name: 'task_checkpoint', args: { goal: '保存检查结果', completed: ['已保存 automation/result.txt'], findings: [], artifacts: ['automation/result.txt'], blockers: [], next_steps: [] } } };
      else if (results.length === 2) reply = { tool: { name: 'goal_finish', args: { goals: [{ id: goalId, state: 'continue', progress: '自动检查已完成，文件已保存。', notify: true, reason: '交付了约定成果', notification_key: 'automation-test:file-v1', checkpoint: { completed: ['已保存 automation/result.txt'] } }] } } };
      else reply = { text: 'PRIVATE 自动轮次内部输出' };
    }
    else if (user.startsWith('这是你之前委托给')) reply = { text: user.split('结果：\n').at(-1)! };
    else if (json.tools.some((t: any) => t.name === 'start_task') && /写文件|桌面|联网搜索|长任务/.test(user))
      reply = toolDone ? { text: '任务已安排，完成后告诉你。' } : { tool: { name: 'start_task', args: { title: user.slice(0, 40), task: user } } };
    else if (user.startsWith('补充任务:')) reply = toolDone ? { text: '补充已提交，等待任务接收。' } : { tool: { name: 'task_message', args: { task_id: user.slice('补充任务:'.length), text: '改为蓝色' } } };
    else if (user === '改为蓝色') reply = { text: '已根据补充改为蓝色。' };
    else if (user === '长任务') reply = toolDone ? { text: '长任务已完成。' } : { tool: { name: 'run_command', args: { command: 'sleep 2; echo completed' } } };
    else if (user === '沉淀方法') reply = toolDone ? { text: '方法已记住。' } : { tool: { name: 'skill_manage', args: { action: 'create', name: 'computer-report', description: '整理报告时使用', instructions: 'PRIVATE-MAC-WORKFLOW：先核实来源，再整理。' } } };
    else if (user === '复用方法') reply = toolDone ? { text: '报告已整理。' } : { tool: { name: 'skill_load', args: { name: 'computer-report' } } };
    else if (user.includes('写文件')) reply = toolDone ? { text: `完成：${results.at(-1)}` } : { tool: { name: 'write_file', args: { path: 'notes/hello.md', content: '# Hello from Pi Bot' } } };
    else if (user.includes('桌面')) {
      if (!toolDone) reply = { tool: { name: 'request_outside_access', args: { path: outside, reason: '需要看看桌面上的文件' } } };
      else if (results.length === 1 && results[0].includes('已批准')) reply = { tool: { name: 'list_files', args: { path: outside } } };
      else reply = { text: `桌面上有：${results.at(-1)}` };
    } else if (user.includes('联网搜索')) reply = toolDone ? { text: `搜到：${results.at(-1)}` } : { tool: { name: 'web_search', args: { query: 'Mac 搜索测试', language: 'zh-CN' } } };
    else reply = { text: '你好，我在。' };
    assert.equal(req.url, "/v1/responses");
    const stream = new ResponseStream(res, json.model);
    if (reply.tool) {
      // The mock AI explicitly chooses the test computer; provenance alone never routes on the server.
      const provenance = JSON.parse(messages.map(m=>typeof m.content==='string'?m.content:(m.content??[]).map((part:any)=>part.text??'').join('')).join('\n').match(/当前消息来源：(\{[^}]*\})/)?.[1]??'{}');
      if (['start_task','ask_agent'].includes(reply.tool.name) && !(reply.tool.args as any).device_id && (reply.tool.args as any).execution!=='cloud') Object.assign(reply.tool.args,{execution:'device',device_id:provenance.device_id});
      if (reply.tool.name==='goal_manage' && (reply.tool.args as any).action==='create') Object.assign(reply.tool.args,{resources:[{target:'device:'+provenance.device_id}],requirements:['files','shell']});

      stream.text(reply.tool.name.startsWith('skill_') ? '内部：正在维护 skill。' : '我先看看资料，再帮你处理。');
      stream.tool(reply.tool.name, reply.tool.args, `call_${messages.length}`);
    } else {
      for (const piece of Array.from(reply.text!)) stream.text(piece);

    }
    stream.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { requests, url: `http://127.0.0.1:${(server.address() as any).port}/v1`, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

let dir: string, api: Awaited<ReturnType<typeof createApp>>, base: string, provider: Awaited<ReturnType<typeof scriptedProvider>>, app: Application;
const events: AppEvent[] = [];
let adminToken = '';
let serverDb: Database;
let runner: Awaited<ReturnType<typeof createRunner>>, worker: Worker, workerDb: Database, workerLoop: Promise<void>;
let search: Awaited<ReturnType<typeof mockSearch>>;
let pages: Awaited<ReturnType<typeof browserPages>> | undefined;
async function http(method: string, path: string, body?: unknown, token = adminToken) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
}

before(async () => {
  if (skip) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-bot-e2e-')));
  mkdirSync(join(dir, 'Desktop'));
  writeFileSync(join(dir, 'Desktop', 'plan.txt'), 'x');
  await resetDatabase(TEST_DB!);
  if (!browserSkip) pages = await browserPages();
  provider = await scriptedProvider(join(dir, 'Desktop'), pages?.origin, pages?.other);
  search = await mockSearch();
  serverDb = new Database(TEST_DB!);
  runner=await createRunner({token:'r'.repeat(40),dir:join(dir,'runner')});
  await runner.listen({host:'127.0.0.1',port:0});
  const config = settings({PI_BOT_RUNNER_TOKEN:'r'.repeat(40),PI_BOT_RUNNER_URL:`http://127.0.0.1:${(runner.server.address() as any).port}`,PI_BOT_WORKER_POLL_SECONDS:'0.02', PI_BOT_DATABASE_URL: TEST_DB, PI_BOT_ADMIN_PASSWORD: 'admin-password', PI_BOT_JWT_SECRET: 'j'.repeat(40), PI_BOT_VAULT_FILE: vaultFile(dir), PI_BOT_TAVILY_API_KEY: 'tvly-test-key',
    // These runs exercise the computer path; cloud-computer routing is covered by the server tests.
    PI_BOT_REMOTE_BACKEND: 'none' });
  api = await createApp(config, serverDb, new Hub(), new WebSearch(config, search.fetch));
  await api.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(api.server.address() as any).port}`;
  workerDb=new Database(TEST_DB!);worker=new Worker(workerDb,{...config,internalUrl:base});workerLoop=worker.runForever();
  adminToken = (await http('POST', '/auth/login', { username: 'admin', password: 'admin-password' }, '')).json.access_token;
  await http('POST', '/admin/api/users', { username: 'bob', password: 'bob-password' });
  await http('POST', '/admin/api/models', { name: 'Scripted', base_url: provider.url, provider_model: 'scripted', api_key: 'sk-scripted', context_window: 32000, max_tokens: 1000 });
  app = new Application({ dataDir: join(dir, 'data'), libraryRoot: join(dir, 'pi-bot'), credentials: new MemoryCredentials(), emit: e => events.push(e), backoff: { baseMs: 50, maxMs: 200 } });
  if (pages && browserMode === 'chromium') {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'browser-test.json'), JSON.stringify({ enabled: true, browser: browserMode }));
  }
});
after(async () => {
  if (skip) return;
  worker?.stop();
  await app?.shutdown();
  await provider?.close();
  await workerLoop;
  await workerDb?.close();
  await runner?.close();
  await api?.close();
  await search?.close();
  await pages?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function connectBrowserHarness() {
  if (!app.state().user) await app.login({ serverUrl: base, username: 'bob', password: 'bob-password', label: 'Bob 的 Mac' });
  await eventually(() => app.state().connection === 'online');
}

test('browser testing is discovered on the selected desktop and keeps raw evidence local', { skip: browserSkip }, async () => {
  await connectBrowserHarness();
  const bot = await app.call('botCreate', { name: 'Web Tester', persona: '', avatar: { shape: 'bean', color: 'mint', scheme: 'light' } }) as Bot;
  if (browserMode !== 'chromium') assert.equal(existsSync(join(dir, 'data', 'browser-test.json')), false);
  await app.call('send', { botId: bot.id, text: `测试网页注册流程 ${pages!.origin}/register` });
  const reply = await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    return page.messages.find(message => /注册流程通过/.test(message.content) && message.status === 'completed');
  }, 45000);
  assert.match(reply.content, /已保存本机截图/);
  const task = await serverDb.tx(tx => tx.one("SELECT * FROM agent_tasks WHERE parent_bot_id=$1 AND title='网页注册测试'", [bot.id]));
  assert.equal(task?.execution, 'device');
  assert.equal(task?.device_id, app.state().deviceId);
  assert.equal(task?.routing.browser_test_authorization, 'user');
  const turns = provider.requests.filter(request => latestUserText(request.input) === '验证浏览器注册流程');
  const output = realToolOutputs(turns.at(-1).input).map((item: any) => text(item.output));
  assert.match(output[1], /"opened":false/);
  assert.match(output[2], /"opened":true/);
  assert.match(output[3], /textbox/);
  assert.match(output[6], /"passed":true/);
  assert.match(output[7], /"passed":false/);
  assert.equal(pages?.hits(), 0);
  assert.doesNotMatch(JSON.stringify(provider.requests), new RegExp(BROWSER_PRIVATE_LOG));
  const root = join(dir, 'data', 'browser-test-evidence');
  const evidence = join(root, readdirSync(root)[0]);
  assert.match(readFileSync(join(evidence, 'diagnostics.json'), 'utf8'), new RegExp(BROWSER_PRIVATE_LOG));
  assert.equal(readFileSync(join(evidence, 'screenshot-1.png')).subarray(1, 4).toString(), 'PNG');

  await app.call('send', { botId: bot.id, text: '核对云端测试工具' });
  const cloud = await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    return page.messages.find(message => /云端未提供端侧浏览器工具/.test(message.content) && message.status === 'completed');
  }, 15000);
  assert.equal(cloud.executor, 'cloud');
});

test('inferred sites and blocked dependencies require an approval that expires with the task', { skip: browserSkip }, async () => {
  const fixture = pages!;
  await connectBrowserHarness();
  const bot = await app.call('botCreate', { name: 'Scope Tester', persona: '', avatar: { shape: 'bean', color: 'mint', scheme: 'light' } }) as Bot;
  const approval = async () => eventually(async () => {
    const { bots } = await app.call('bots', {}) as { bots: Bot[] };
    return bots.find(record => record.id === bot.id)?.pending_approvals[0];
  }, 15000);
  const redirects = fixture.redirects();
  const hits = fixture.hits();
  await app.call('send', { botId: bot.id, text: '检查推断的测试站点' });
  const initial = await approval();
  assert.equal(initial.kind, 'browser_access');
  assert.equal(initial.path, fixture.origin);
  assert.equal(fixture.redirects(), redirects);
  await assert.rejects(app.call('decide', { approvalId: initial.id, decision: 'approve_always' }), /仅适用于本次任务/);
  await app.call('decide', { approvalId: initial.id, decision: 'approve' });
  const dependency = await approval();
  assert.equal(dependency.path, fixture.other);
  assert.equal(fixture.hits(), hits);
  await app.call('decide', { approvalId: dependency.id, decision: 'approve' });
  await eventually(() => fixture.hits() > hits, 15000);
  await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    return page.messages.find(message => message.status === 'completed' && /已访问本次授权/.test(message.content));
  }, 15000);
  const beforeSecond = fixture.redirects();
  await app.call('send', { botId: bot.id, text: '重新检查推断的测试站点' });
  const again = await approval();
  assert.equal(again.path, fixture.origin);
  assert.equal(fixture.redirects(), beforeSecond);
  await app.call('decide', { approvalId: again.id, decision: 'reject' });
  await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    return page.messages.find(message => message.status === 'completed' && /未获授权/.test(message.content));
  }, 15000);
  assert.equal(fixture.redirects(), beforeSecond);
});

test('a visible browser waits for the chat login confirmation before resuming', { skip: handoffSkip }, async () => {
  await connectBrowserHarness();
  const bot = await app.call('botCreate', { name: 'Login Tester', persona: '', avatar: { shape: 'bean', color: 'mint', scheme: 'light' } }) as Bot;
  await app.call('send', { botId: bot.id, text: `打开测试窗口让我登录 ${pages!.origin}/register` });
  const approval = await eventually(async () => {
    const { bots } = await app.call('bots', {}) as { bots: Bot[] };
    return bots.find(record => record.id === bot.id)?.pending_approvals[0];
  }, 45000);
  assert.equal(approval.kind, 'browser_login');
  assert.equal(approval.path, pages!.origin);
  assert.equal(approval.can_remember, false);
  assert.match(approval.scope ?? '', /独立测试窗口/);
  const task = await serverDb.tx(tx => tx.one("SELECT * FROM agent_tasks WHERE parent_bot_id=$1", [bot.id]));
  assert.equal(task?.status, 'waiting_approval');
  assert.equal(task?.routing.browser_test_visible, true);
  await assert.rejects(app.call('decide', { approvalId: approval.id, decision: 'approve_always' }), /仅适用于本次任务/);
  await app.call('decide', { approvalId: approval.id, decision: 'approve' });
  await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    return page.messages.find(message => message.status === 'completed' && /已接回测试窗口/.test(message.content));
  }, 15000);
});

test('a chat task discovers Electron on the desktop and requires one-time launch and login approvals', { skip: electronSkip }, async () => {
  await connectBrowserHarness();
  assert.deepEqual(await app.call('preferences', {}), { pstack_enabled: false, skin: 'default' });
  assert.deepEqual(await app.call('setPreferences', { pstack_enabled: true }), { pstack_enabled: true, skin: 'default' });
  await app.call('setPreferences', { pstack_enabled: false });
  writeFileSync(join(dir, 'fixture.cjs'), `
    const { app, BrowserWindow } = require('electron');
    app.whenReady().then(() => {
      const window = new BrowserWindow({ width: 500, height: 400 });
      void window.loadURL('data:text/html,<h1>Fixture app</h1>');
    });
  `);
  const bot = await app.call('botCreate', { name: 'Electron Tester', persona: '', avatar: { shape: 'bean', color: 'mint', scheme: 'light' } }) as Bot;
  await app.call('send', { botId: bot.id, text: '测一下 Electron 测试应用' });
  const pending = (kind: string) => eventually(async () => {
    const { bots } = await app.call('bots', {}) as { bots: Bot[] };
    return bots.find(record => record.id === bot.id)?.pending_approvals.find(item => item.kind === kind);
  }, 25000);
  const launch = await pending('outside_access');
  assert.equal(launch.can_remember, false);
  assert.equal(launch.access, 'execute');
  assert.match(launch.reason, /fixture.cjs/);
  await assert.rejects(app.call('decide', { approvalId: launch.id, decision: 'approve_always' }), /仅适用于本次任务/);
  await app.call('decide', { approvalId: launch.id, decision: 'approve' });
  const handoff = await pending('browser_login');
  assert.equal(handoff.path, 'Electron 应用测试窗口');
  await app.call('decide', { approvalId: handoff.id, decision: 'approve' });
  const finished = await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    return page.messages.find(message => message.status === 'completed' && message.content.includes('已完成应用交接并截图'));
  }, 15000);
  const task = await serverDb.tx(tx => tx.get('agent_tasks', finished.task_id!));
  assert.equal(task.operation_target, 'device:' + app.state().deviceId);
  assert.ok(existsSync(join(dir, 'data', 'electron-test-evidence', task.child_run_id, 'screenshot-1.png')));
  assert.deepEqual(readdirSync(join(dir, 'data', 'electron-test-profiles')), []);
});

test('the Mac harness logs in, binds itself and runs bots against its library', { skip }, async () => {
  await assert.rejects(app.login({ serverUrl: base, username: 'bob', password: 'nope', label: 'Bob 的 Mac' }), /用户名或密码错误/);
  const state = await app.login({ serverUrl: base, username: 'bob', password: 'bob-password', label: 'Bob 的 Mac' });
  assert.equal(state.user?.username, 'bob');
  await eventually(() => app.state().connection === 'online');

  const bot = await app.call('botCreate', { name: 'Writer', persona: '', avatar: { shape: 'bean', color: 'mint', scheme: 'light' } }) as Bot;
  assert.equal(bot.slug, 'writer');
  await app.call('send', { botId: bot.id, text: '帮我写文件' });
  const reply = await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    const last = page.messages.at(-1)!;
    return !!last.task_id && last.status !== 'running' && last;
  }, 20000);
  assert.equal(reply.status, 'completed', JSON.stringify(reply));
  assert.equal(reply.executor, 'cloud');
  assert.match(reply.content, /完成：已写入 notes\/hello.md/);
  assert.deepEqual(reply.tools, [], 'worker tools stay off the public result');
  const workerTools = await serverDb.tx(tx => tx.one("SELECT m.tools FROM agent_tasks t JOIN bot_runs r ON r.run_id=t.child_run_id JOIN bot_messages m ON m.message_id=r.assistant_message_id WHERE t.task_id=$1", [reply.task_id]));
  const fileEvidence=await serverDb.tx(tx=>tx.one("SELECT * FROM endpoint_experiences WHERE bot_id=$1 AND capability='files' AND path=$2",[bot.id,join(dir,'pi-bot','writer','notes','hello.md')]));
  assert.equal(fileEvidence?.target,'device:'+app.state().deviceId,'real desktop tool event records its observed path on the actual endpoint');
  assert.deepEqual(workerTools!.tools.map((t: any) => [t.name, t.state]), [['write_file', 'completed']]);
  assert.deepEqual(reply.progress, [], 'the result is separate from the opening acknowledgement');
  const page = await app.call('messages', { botId: bot.id }) as MessagePage;
  const opening = page.messages.find(m => m.role === 'assistant' && !m.task_id)!;
  assert.equal(opening.status, 'completed');
  assert.deepEqual(opening.progress, ['我先看看资料，再帮你处理。'], 'the short reply survives background execution');
  assert.match(opening.content, /任务已安排/);
  assert.ok(opening.seq < reply.seq, 'the verified result is delivered after the opening reply');
  assert.equal(readFileSync(join(dir, 'pi-bot', 'writer', 'notes', 'hello.md'), 'utf8'), '# Hello from Pi Bot');
  assert.ok(events.some(e => e.type === 'bot.mood' && e.mood === 'working'), 'boards and UI see the bot working');
  assert.ok(events.some(e => e.type === 'delta'), 'streaming text reaches the UI');
  assert.ok(events.some(e => e.type === 'stream' && e.reset && e.offset === 0), 'versioned streams pass through Application.emit to UI');

  const bobToken = (await http('POST', '/auth/login', { username: 'bob', password: 'bob-password' }, '')).json.access_token;
  const files = await http('GET', `/bots/${bot.id}/files?path=notes`, undefined, bobToken);
  assert.deepEqual(files.json.entries.map((e: any) => e.name), ['hello.md']);
  const content = await http('GET', `/bots/${bot.id}/files/content?path=notes/hello.md`, undefined, bobToken);
  assert.equal(content.json.content, '# Hello from Pi Bot');
});

test('desktop replies travel through device events and survive reload without duplicate final text', { skip }, async () => {
  const bots = await app.call('bots', {}) as { bots: Bot[] };
  const bot = bots.bots[0];
  const sent = await app.call('send', { botId: bot.id, text: '分条回复测试' }) as { run: { id: string } };
  const reply = await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    return page.messages.find(m => m.run_id === sent.run.id && m.role === 'assistant' && m.status === 'completed');
  });
  assert.equal(reply.reply_segments?.length, 2);
  assert.equal(reply.reply_segments?.[0].text, '先核对服务状态。');
  assert.equal(reply.content, '服务正常，接下来再测一次。');
});

test('the Mac sends, loads and replays image attachments through its signed cloud connection', { skip }, async () => {
  const bot = await app.call('botCreate', { name: 'Vision', persona: '', avatar: { shape: 'bean', color: 'mint', scheme: 'light' } }) as Bot;
  const image = { name: 'pixel.png', mime_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' };
  const sent = await app.call('send', { botId: bot.id, text: '', images: [image] }) as { messages: MessagePage['messages'] };
  const incoming = sent.messages[0];
  assert.equal(incoming.images?.length, 1);
  const loaded = await app.call('image', { botId: bot.id, messageId: incoming.id, imageId: incoming.images![0].id }) as typeof image;
  assert.equal(loaded.data, image.data);
  await eventually(async () => (await app.call('messages', { botId: bot.id }) as MessagePage).messages.at(-1)?.status === 'completed');
  const imageParts = (body: any) => body.input.filter((m: any) => m.role === 'user').flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'input_image') : []);
  assert.equal(imageParts(provider.requests.at(-1)).length, 1);
  await app.call('send', { botId: bot.id, text: '再看图片' });
  await eventually(async () => (await app.call('messages', { botId: bot.id }) as MessagePage).messages.at(-1)?.status === 'completed');
  assert.equal(imageParts(provider.requests.at(-1)).length, 1);
});

test('the Mac agent searches through the authenticated Server gateway', { skip }, async () => {
  const bot = ((await app.call('bots', {})) as { bots: Bot[] }).bots.find(b => b.name === 'Writer')!;
  await app.call('send', { botId: bot.id, text: '联网搜索一下' });
  const reply = await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    const last = page.messages.at(-1)!;
    return !!last.task_id && last.status !== 'running' && last;
  }, 20000);
  assert.equal(reply.status, 'completed', JSON.stringify(reply));
  assert.match(reply.content, /Pi Bot 官方资料/);
  assert.deepEqual(reply.tools, [], 'search executes in a private worker');
  assert.equal(search.queries.at(-1)?.query, 'Mac 搜索测试');
  assert.ok(events.some(e => e.type === 'bot.mood' && e.mood === 'searching'));
});

test('outside access waits for the user and continues after approval', { skip }, async () => {
  const bot = (await app.call('bots', {}) as { bots: Bot[] }).bots.find(b => b.name === 'Writer')!;
  await app.call('send', { botId: bot.id, text: '看看我的桌面' });
  const pending = await eventually(async () => {
    const b = (await app.call('bots', {}) as { bots: Bot[] }).bots.find(b => b.id === bot.id)!;
    return b.pending_approvals[0];
  }, 20000);
  assert.equal(pending.path, join(dir, 'Desktop'));
  assert.equal(pending.reason, '需要看看桌面上的文件');
  await app.call('decide', { approvalId: pending.id, decision: 'approve' });
  const reply = await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    const last = page.messages.at(-1)!;
    return !!last.task_id && last.status !== 'running' && last;
  }, 20000);
  assert.equal(reply.status, 'completed', JSON.stringify(reply));
  assert.match(reply.content, /plan\.txt/);
  assert.deepEqual(reply.progress, [], 'private worker progress does not leak into the report');
});

test('the Mac conversation steers a real running Pi task without cancelling its command', { skip }, async () => {
  const bot = ((await app.call('bots', {})) as { bots: Bot[] }).bots.find(b => b.name === 'Writer')!;
  const sent = await app.call('send', { botId: bot.id, text: '长任务' }) as any;
  const task = await eventually(async () => await serverDb.tx(tx => tx.one("SELECT * FROM agent_tasks WHERE parent_run_id=$1 AND child_run_id IS NOT NULL", [sent.run.id])));
  await eventually(() => events.some(e => e.type === 'activity' && e.activity?.runId === task.child_run_id && e.activity?.tool === 'run_command'));
  const followup = await app.call('send', { botId: bot.id, text: `补充任务:${task.task_id}` }) as any;
  const ack = await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    return page.messages.find(m => m.run_id === followup.run.id && m.role === 'assistant' && m.status === 'completed');
  });
  assert.equal(ack.content, '补充已提交，等待任务接收。');
  const report = await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    return page.messages.find(m => m.task_id === task.task_id && m.status === 'completed');
  });
  assert.equal(report.content, '已根据补充改为蓝色。');
  const instructions = await serverDb.tx(tx => tx.rows('SELECT * FROM agent_task_instructions WHERE task_id=$1', [task.task_id]));
  assert.equal(instructions.length, 1);
  assert.ok(instructions[0].delivered_at);
});

test('the Mac manages its own skills privately and stores them for cloud reuse', { skip }, async () => {
  const bot = ((await app.call('bots', {})) as { bots: Bot[] }).bots.find(b => b.name === 'Writer')!;
  const start = events.length;
  for (const text of ['沉淀方法', '复用方法']) {
    await app.call('send', { botId: bot.id, text });
    const reply = await eventually(async () => {
      const page = await app.call('messages', { botId: bot.id }) as MessagePage;
      const last = page.messages.at(-1)!;
      return last.status !== 'running' && last;
    }, 20000);
    assert.equal(reply.status, 'completed', JSON.stringify(reply));
    assert.deepEqual(reply.tools, []);
    assert.deepEqual(reply.progress, [], 'private skill activity does not create a canned acknowledgement');
    assert.doesNotMatch(reply.content, /内部|skill_|PRIVATE-MAC/);
  }
  assert.doesNotMatch(JSON.stringify(events.slice(start)), /PRIVATE-MAC|正在维护/);
  // Inspect the server through the public bearer, then create a cloud context
  // from the same bot to verify that Mac skills need no file synchronization.
  const bobToken = (await http('POST', '/auth/login', { username: 'bob', password: 'bob-password' }, '')).json.access_token;
  const files = await http('GET', `/bots/${bot.id}/files?path=`, undefined, bobToken);
  assert.ok(!files.json.entries.some((entry: any) => /skill|computer-report/.test(entry.name)));
  const messages = await http('GET', `/bots/${bot.id}/messages`, undefined, bobToken);
  const runId = messages.json.messages.at(-1).run_id;
  const context = await serverDb.tx(async tx => buildContext(tx, settings({ PI_BOT_DATABASE_URL: TEST_DB, PI_BOT_JWT_SECRET: 'j'.repeat(40) }), { ...await tx.get('bot_runs', runId), executor: 'cloud' }));
  assert.ok(context.skills.some(skill => skill.name === 'computer-report'));
});

test('a goal runs on the real computer, writes its result, and reports new progress once', { skip }, async () => {
  const bot = await app.call('botCreate', { name: '自动检查员', persona: '' , avatar: { shape: 'bean', color: 'mint', scheme: 'light' } }) as Bot;
  await app.call('send', { botId: bot.id, text: '建立自动检查链路测试' });
  const automation = await eventually(async () => {
    const a = await serverDb.tx(tx => tx.one("SELECT * FROM bot_automations WHERE bot_id=$1 AND kind='review'", [bot.id]));
    const running = await serverDb.tx(tx => tx.one("SELECT 1 FROM bot_runs WHERE bot_id=$1 AND lane='conversation' AND status IN ('queued','running')", [bot.id]));
    return a && !running && a;
  });
  await serverDb.tx(async tx => {
    await tx.rows('UPDATE bot_automations SET next_wake_at=now() WHERE automation_id=$1', [automation.automation_id]);
    await tx.notify({ user_id: automation.user_id, bot_id: bot.id });
  });
  const report = await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    return page.messages.find(m => m.content === '自动检查已完成，文件已保存。');
  }, 20000);
  assert.equal(report.status, 'completed');
  assert.equal(readFileSync(join(dir, 'pi-bot', bot.slug, 'automation/result.txt'), 'utf8'), '自动检查已完成');
  const goal = await serverDb.tx(tx => tx.one('SELECT * FROM bot_goals WHERE bot_id=$1', [bot.id]));
  assert.equal(goal!.status, 'active');
  assert.deepEqual(goal!.checkpoint.completed, ['已保存 automation/result.txt']);
  const round = await serverDb.tx(tx => tx.one('SELECT r.* FROM bot_runs r JOIN automation_rounds ar ON ar.run_id=r.run_id WHERE ar.automation_id=$1', [automation.automation_id]));
  assert.ok(round!.automation_calls >= 4 && round!.automation_calls <= 20);
  assert.equal(round!.effect_pending, false);
  const effects = await serverDb.tx(tx => tx.rows('SELECT status FROM automation_effects WHERE run_id=$1', [round!.run_id]));
  assert.deepEqual(effects.map(x => x.status), ['confirmed']);
  const page = await app.call('messages', { botId: bot.id }) as MessagePage;
  assert.equal(page.messages.filter(m => m.content === report.content).length, 1);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE|goal_finish|task_checkpoint|用户授权范围/);
});

test('a quiet goal review can act but stays silent and does not move visible activity', { skip }, async () => {
  const bot = await app.call('botCreate', { name: '静默检查员', persona: '', avatar: { shape: 'bean', color: 'mint', scheme: 'light' } }) as Bot;
  await app.call('send', { botId: bot.id, text: '建立一个会保持安静的目标' });
  const previous = await eventually(async () => {
    const goal = await serverDb.tx(tx => tx.one("SELECT 1 FROM bot_goals WHERE bot_id=$1", [bot.id]));
    const running = await serverDb.tx(tx => tx.one("SELECT 1 FROM bot_runs WHERE bot_id=$1 AND lane='conversation' AND status IN ('queued','running')", [bot.id]));
    return goal && !running && serverDb.tx(tx => tx.get('bots', bot.id));
  });
  await serverDb.tx(async tx => {
    await tx.rows('UPDATE bot_automations SET next_wake_at=now() WHERE bot_id=$1', [bot.id]);
    await tx.notify({ user_id: previous.user_id, bot_id: bot.id });
  });
  await eventually(async () => serverDb.tx(tx => tx.one("SELECT ar.* FROM automation_rounds ar JOIN bot_automations a USING(automation_id) WHERE a.bot_id=$1 AND ar.status='completed'", [bot.id])), 20000);
  const page = await app.call('messages', { botId: bot.id }) as MessagePage;
  assert.ok(!page.messages.some(m => m.content === '没有新的重要变化'));
  const current = await serverDb.tx(tx => tx.get('bots', bot.id));
  assert.equal(current.last_active_at.getTime(), previous.last_active_at.getTime());
  await app.call('botDelete', { id: bot.id });
  const state = await serverDb.tx(tx => tx.one('SELECT * FROM bot_automations WHERE bot_id=$1', [bot.id]));
  assert.equal(state!.status, 'stopped');
});

test('the real Mac harness calls the native delegation tool once, and exposes the request and answer in delegation details', { skip }, async () => {
  const sender = await app.call('botCreate', { name: '协作助手', persona: '', avatar: { shape: 'bean', color: 'mint', scheme: 'light' } }) as Bot;
  const recipient = await app.call('botCreate', { name: '压测智能体', persona: '', avatar: { shape: 'bean', color: 'mint', scheme: 'light' } }) as Bot;
  const start = events.length;
  const sent = await app.call('send', { botId: sender.id, text: '问问压测智能体为什么停了' }) as any;
  const reply = await eventually(async () => {
    const page = await app.call('messages', { botId: sender.id }) as MessagePage;
    return page.messages.find(m => m.run_id === sent.run.id && m.role === 'assistant' && m.status === 'completed');
  });
  assert.equal(reply.executor, 'cloud');
  assert.equal(reply.content, '询问已提交，等对方回报。');
  assert.equal(reply.agent_tasks?.length, 1);
  const taskId = reply.agent_tasks![0].id;
  const saved = await serverDb.tx(tx => tx.get('agent_tasks', taskId));
  assert.equal(saved.target_bot_id, recipient.id);
  assert.equal(saved.execution, 'device');
  const transcript = await eventually(async () => {
    const data = await app.call('taskConversation', { botId: sender.id, taskId }) as any;
    return data.messages.some((m: any) => m.kind === 'answer') && data;
  });
  assert.equal(transcript.messages.filter((m: any) => m.kind === 'request').length, 1);
  assert.ok(transcript.messages.some((m: any) => m.from_bot_id === sender.id && m.to_bot_id === recipient.id && m.content === '请核实停止原因，并报告已有数据。'));
  assert.ok(transcript.messages.some((m: any) => m.from_bot_id === recipient.id && m.to_bot_id === sender.id && m.content === '压测已按用户要求停止，已有结果在报告目录。'), JSON.stringify(transcript));
  assert.doesNotMatch(JSON.stringify(events.slice(start)), /问了，刚发出去|我给他发了消息/);
});

test('logout unbinds the Mac and the server falls back to the cloud', { skip }, async () => {
  await app.logout();
  assert.equal(app.state().connection, 'signed_out');
  const bobToken = (await http('POST', '/auth/login', { username: 'bob', password: 'bob-password' }, '')).json.access_token;
  const me = await http('GET', '/me', undefined, bobToken);
  assert.equal(me.json.computer.online, false);
});
