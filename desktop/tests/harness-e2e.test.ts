import { isRealToolResult, latestUserText, realToolOutputs, ResponseStream } from "../../packages/agent/tests/responses.js";
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const text = (c: any): string => (Array.isArray(c) ? c.map(p => p.text ?? '').join('') : String(c ?? ''));

/** A provider double that drives the agent through tool calls based on the latest user text. */
async function scriptedProvider(outside: string) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const json = JSON.parse(raw);
    requests.push(json);
    const messages: any[] = json.input;
    const user = latestUserText(messages);
    const toolDone = isRealToolResult(messages);
    const results = realToolOutputs(messages).map(m => text(m.output));
    let reply: { text?: string; tool?: { name: string; args: object } };
    const goalId = user.match(/"id":"([0-9a-f-]{36})"/)?.[1];
    if (user === '建立自动检查链路测试') reply = toolDone
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
    else if (user.startsWith('补充任务:')) reply = toolDone ? { text: '补充已送达。' } : { tool: { name: 'task_message', args: { task_id: user.slice('补充任务:'.length), text: '改为蓝色' } } };
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
let search: Awaited<ReturnType<typeof mockSearch>>;
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
  provider = await scriptedProvider(join(dir, 'Desktop'));
  search = await mockSearch();
  serverDb = new Database(TEST_DB!);
  const config = settings({ PI_BOT_DATABASE_URL: TEST_DB, PI_BOT_ADMIN_PASSWORD: 'admin-password', PI_BOT_JWT_SECRET: 'j'.repeat(40), PI_BOT_VAULT_FILE: vaultFile(dir), PI_BOT_TAVILY_API_KEY: 'tvly-test-key' });
  api = await createApp(config, serverDb, new Hub(), new WebSearch(config, search.fetch));
  await api.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(api.server.address() as any).port}`;
  adminToken = (await http('POST', '/auth/login', { username: 'admin', password: 'admin-password' }, '')).json.access_token;
  await http('POST', '/admin/api/users', { username: 'bob', password: 'bob-password' });
  await http('POST', '/admin/api/models', { name: 'Scripted', base_url: provider.url, provider_model: 'scripted', api_key: 'sk-scripted', context_window: 32000, max_tokens: 1000 });
  app = new Application({ dataDir: join(dir, 'data'), libraryRoot: join(dir, 'pi-bot'), credentials: new MemoryCredentials(), emit: e => events.push(e), backoff: { baseMs: 50, maxMs: 200 } });
});
after(async () => {
  if (skip) return;
  await app?.shutdown();
  await api?.close();
  await provider?.close();
  await search?.close();
  rmSync(dir, { recursive: true, force: true });
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
  assert.equal(reply.executor, 'device');
  assert.match(reply.content, /完成：已写入 notes\/hello.md/);
  assert.deepEqual(reply.tools, [], 'worker tools stay off the public result');
  const workerTools = await serverDb.tx(tx => tx.one("SELECT m.tools FROM agent_tasks t JOIN bot_runs r ON r.run_id=t.child_run_id JOIN bot_messages m ON m.message_id=r.assistant_message_id WHERE t.task_id=$1", [reply.task_id]));
  assert.deepEqual(workerTools!.tools.map((t: any) => [t.name, t.state]), [['write_file', 'completed']]);
  assert.deepEqual(reply.progress, [], 'the result is separate from the opening acknowledgement');
  assert.equal(readFileSync(join(dir, 'pi-bot', 'writer', 'notes', 'hello.md'), 'utf8'), '# Hello from Pi Bot');
  assert.ok(events.some(e => e.type === 'bot.mood' && e.mood === 'working'), 'boards and UI see the bot working');
  assert.ok(events.some(e => e.type === 'delta'), 'streaming text reaches the UI');

  const bobToken = (await http('POST', '/auth/login', { username: 'bob', password: 'bob-password' }, '')).json.access_token;
  const files = await http('GET', `/bots/${bot.id}/files?path=notes`, undefined, bobToken);
  assert.deepEqual(files.json.entries.map((e: any) => e.name), ['hello.md']);
  const content = await http('GET', `/bots/${bot.id}/files/content?path=notes/hello.md`, undefined, bobToken);
  assert.equal(content.json.content, '# Hello from Pi Bot');
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
  const task = await eventually(async () => await serverDb.tx(tx => tx.one("SELECT * FROM agent_tasks WHERE parent_run_id=$1", [sent.run.id])));
  await eventually(() => events.some(e => e.type === 'activity' && e.activity?.runId === task.child_run_id && e.activity?.tool === 'run_command'));
  const followup = await app.call('send', { botId: bot.id, text: `补充任务:${task.task_id}` }) as any;
  const ack = await eventually(async () => {
    const page = await app.call('messages', { botId: bot.id }) as MessagePage;
    return page.messages.find(m => m.run_id === followup.run.id && m.role === 'assistant' && m.status === 'completed');
  });
  assert.equal(ack.content, '补充已送达。');
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
  assert.doesNotMatch(JSON.stringify(events.slice(start)), /skill_manage|skill_load|PRIVATE-MAC|正在维护/);
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

test('logout unbinds the Mac and the server falls back to the cloud', { skip }, async () => {
  await app.logout();
  assert.equal(app.state().connection, 'signed_out');
  const bobToken = (await http('POST', '/auth/login', { username: 'bob', password: 'bob-password' }, '')).json.access_token;
  const me = await http('GET', '/me', undefined, bobToken);
  assert.equal(me.json.computer.online, false);
});
