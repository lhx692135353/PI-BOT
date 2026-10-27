Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
window.__activityPhase = 'idle';
window.__deferNextBots = false;
const initialHandler = window.__handler;
window.__handler = (method, input) => {
  const result = initialHandler(method, input);
  if (method === 'bots') {
    const bot = result.bots[0], phase = window.__activityPhase;
    bot.latest_run = { id: 'conversation', bot_id: bot.id, status: 'completed', executor: 'device', error: null,
      assistant_message_id: 'answer', created_at: '2026-10-27T13:21:00Z', finished_at: '2026-10-27T13:21:10Z' };
    bot.activity = { status: phase === 'running' ? 'running' : phase === 'queued' ? 'queued' : 'completed',
      running_count: phase === 'running' ? 1 : 0, queued_count: phase === 'queued' ? 1 : 0,
      tool: phase === 'running' ? 'run_command' : null,
      summary: phase === 'running' ? '正在检查服务启动' : phase === 'queued' ? '有 1 个任务排队中' : null };
    if (window.__deferNextBots) {
      window.__deferNextBots = false;
      return new Promise(resolve => { window.__resolveOldBots = () => resolve(result); });
    }
  }
  if (method === 'messages') return { messages: [{ id: 'answer', bot_id: input.botId, run_id: 'conversation', seq: 1,
    role: 'assistant', status: 'completed', executor: 'device', tools: [], content: '服务还在启动。', created_at: '2026-10-27T13:21:10Z', updated_at: '2026-10-27T13:21:10Z' }], has_more: false };
  return result;
};
