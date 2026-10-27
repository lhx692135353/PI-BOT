{
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const start = Date.now();
  while (Date.now() - start < 8000) { if (check()) return; await delay(25); }
  throw new Error(`${label}: ${document.body.innerText.slice(0, 1000)}`);
}
(async () => {
  await until(() => document.querySelector('.composer') && document.body.innerText.includes('服务还在启动'), 'initial idle chat');
  if (document.querySelector('.task-activity')) throw new Error('reply wording was mistaken for a live execution');
  // No WebSocket event, focus event or local execution event announces the start.
  window.__activityPhase = 'running';
  await until(() => document.querySelector('.task-activity')?.textContent.includes('正在检查服务启动'), 'missed start notification never recovered');
  window.__activityPhase = 'completed';
  await until(() => !document.querySelector('.task-activity'), 'completion kept the running label');
  window.__activityPhase = 'queued';
  await until(() => document.querySelector('.task-activity')?.textContent.includes('排队'), 'idle cache failed to discover a queued task');
  window.__activityPhase = 'running'; window.__deferNextBots = true;
  window.dispatchEvent(new Event('focus'));
  await until(() => window.__resolveOldBots, 'delayed running snapshot');
  window.__activityPhase = 'completed'; window.dispatchEvent(new Event('focus'));
  await until(() => !document.querySelector('.task-activity'), 'new idle snapshot');
  window.__resolveOldBots(); await delay(150);
  if (document.querySelector('.task-activity')) throw new Error('old response resurrected a completed task');
  window.__activityResult = { ok: true };
})().catch(error => { window.__activityResult = { ok: false, error: String(error.stack || error) }; });
}
