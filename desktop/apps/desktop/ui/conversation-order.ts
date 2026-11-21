import type {Bot} from '../../../packages/protocol/src/index.js';
export function orderBots(bots:Bot[]):Bot[] {
  // Old servers keep their existing order; new servers use a stable message key.
  if(bots.some(b=>!b.last_message_at))return bots;
  return [...bots].sort((a,b)=>Number(!!b.is_main)-Number(!!a.is_main) || Date.parse(b.last_message_at!)-Date.parse(a.last_message_at!) || a.id.localeCompare(b.id));
}
