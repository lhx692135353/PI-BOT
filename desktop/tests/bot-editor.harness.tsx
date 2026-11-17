import { createRoot } from 'react-dom/client';
import { BotEditor } from '../apps/desktop/ui/editor.js';
import { avatarFor } from '@pi-bot/bot-face';
import type { Bot, ModelOption } from '../packages/protocol/src/index.js';

const history: { method: string; input: any }[] = [];
const saved: Bot[] = [];
const models: ModelOption[] = [{ id: 'existing-model', name: 'Existing model', is_default: true }, { id: 'other-model', name: 'Other model', is_default: false }];
window.agent = {
  call: async (method, input: any) => {
    history.push({ method, input });
    if (method === 'cliProfiles') return {
      cursor: { installed: true, profiles: [{ id: '/existing/profile', label: 'Saved profile' }] },
      codex: { installed: true, profiles: [{ id: '/existing/profile', label: 'Saved profile' }] },
    };
    return { id: 'saved-bot', ...input };
  },
  subscribe: () => () => {}, computerName: async () => '', defaultServerUrl: async () => '', openLibrary: async () => {}, openExternal: async () => {},
};
const root = createRoot(document.getElementById('root')!);
function render(runtime?: Bot['runtime'], noModels = false) {
  history.length = 0;
  saved.length = 0;
  const bot = runtime ? {
    id: 'existing-bot', name: 'Existing bot', persona: 'Keep persona', model_id: 'existing-model', runtime,
    cli_profile: '/existing/profile', cli_directory: '/existing/project', avatar: avatarFor('existing-bot'),
  } as Bot : undefined;
  root.render(<BotEditor key={`${runtime}-${noModels}`} bot={bot} models={noModels ? [] : models} deviceId="existing-device" onClose={() => {}} onSaved={bot => saved.push(bot)} />);
}
(window as any).__editorHarness = { history, saved, render };
render();
