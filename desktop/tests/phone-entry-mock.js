{ const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const BOT = '00000000-0000-4000-8000-0000000000aa';
const JPEG = '/9j/aaaaaaaaaaaa';
localStorage.clear();
localStorage.setItem('pi-bot.selected', BOT);
window.__calls = [];
window.__handler = (method, input) => {
  if (method === 'status') return {
    connection: 'online', serverUrl: 'http://127.0.0.1:8787',
    user: { id: BOT, username: 'zhao', display_name: '赵涛' },
    deviceLabel: '本机', deviceId: A, libraryRoot: '/tmp/pi-bot-test', activities: [],
  };
  if (method === 'bots' || method === 'devices') {
    const devices = [
      { id: A, label: '电脑A', platform: 'linux', online: true, revoked_at: null, last_seen_at: '2026-10-23T00:00:00Z' },
      { id: B, label: '电脑B', platform: 'linux', online: true, revoked_at: null, last_seen_at: '2026-10-23T00:00:00Z' },
    ];
    if (method === 'devices') return devices;
    return {
      devices,
      bots: [{
        id: BOT, name: '助手', slug: 'assistant', persona: '', model_id: null,
        avatar: { shape: 'blob', color: 'orange', scheme: 'light' }, is_main: true,
        created_at: '2026-10-23T00:00:00Z', last_active_at: '2026-10-23T00:00:00Z',
        latest_run: null, last_message: null, pending_approvals: [], execution_device_id: A,
      }],
    };
  }
  if (['models','authorizations','authorizationLogs'].includes(method)) return [];
  if (method === 'messages') return { messages: [], has_more: false };
  if (method === 'phoneStatus') return { available: true, occupied: false, label: '验证机', phoneId: 'pixel' };
  if (method === 'phonePreview') return { mime: 'image/jpeg', data: JPEG, width: 720, height: 1280 };
  if (method === 'phoneAcquire') return { sessionId: '00000000-0000-4000-8000-000000000099', expiresAt: Date.now() + 600000 };
  return { method, input };
};
window.agent = {
  call: (method, input) => {
    window.__calls.push({ method, input });
    return Promise.resolve().then(() => window.__handler(method, input));
  },
  subscribe: listener => { listener({ type: 'service.status', connected: true }); return () => {}; },
  computerName: async () => 'linux-test',
  defaultServerUrl: async () => 'http://127.0.0.1:8787',
  openLibrary: async () => {},
  openExternal: async () => {},
};
}
