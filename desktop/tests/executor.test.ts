import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANCELLED } from '@pi-bot/agent';
import { Executor, type RunContext } from '../packages/service/src/executor.js';

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
