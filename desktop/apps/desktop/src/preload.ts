import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, AppEvent } from '../../../packages/protocol/src/index.js';
const bridge: DesktopBridge = {
  call: (method,input) => ipcRenderer.invoke('agent:call',method,input),
  subscribe: listener => { const handler = (_event: Electron.IpcRendererEvent, event: AppEvent) => listener(event); ipcRenderer.on('agent:event', handler); return () => ipcRenderer.removeListener('agent:event', handler); },
  computerName: () => ipcRenderer.invoke('agent:computerName'),
  defaultServerUrl: () => ipcRenderer.invoke('agent:defaultServerUrl'),
  openLibrary: slug => ipcRenderer.invoke('agent:openLibrary', slug),
  openExternal: url => ipcRenderer.invoke('agent:openExternal', url),
};
contextBridge.exposeInMainWorld('agent', bridge);
