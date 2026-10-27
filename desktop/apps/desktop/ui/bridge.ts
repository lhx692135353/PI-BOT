import { RuntimeError, errorInfo } from "@pi-bot/runtime-contracts";
import type { DesktopBridge, Method } from '../../../packages/protocol/src/index.js';

declare global { interface Window { agent: DesktopBridge } }
function agent(): DesktopBridge {
  if (!window.agent) throw new Error('桌面桥尚未就绪');
  return window.agent;
}
/** Resolved on use so renderer modules can be imported without a preload bridge. */
export const bridge: DesktopBridge = {
  call: async (method,input) => {
    // Construct errors in the renderer. Electron strips custom Error properties
    // when exceptions cross contextBridge, so IPC carries a plain envelope.
    const result=await agent().call(method,input);
    if(result && typeof result === "object" && "__runtime_reply" in result){
      const reply=result as {__runtime_reply:unknown;ok?:boolean;result?:unknown;error_info?:unknown};
      if(!reply.ok){const info=errorInfo(reply);if(info)throw new RuntimeError(info);throw new Error("操作失败");}
      return reply.result;
    }
    return result;
  },
  subscribe: listener => agent().subscribe(listener),
  computerName: () => agent().computerName(),
  defaultServerUrl: () => agent().defaultServerUrl(),
  openLibrary: botId => agent().openLibrary(botId),
  openExternal: url => agent().openExternal(url),
};
export function call<T>(method: Method, input?: unknown) { return bridge.call(method, input) as Promise<T>; }
export const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '操作失败');
