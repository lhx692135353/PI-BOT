import { createRoot } from 'react-dom/client';
import { ClientUpdates } from '../apps/desktop/ui/client-updates.js';
import { SavedAuthorizations } from '../apps/desktop/ui/saved-authorizations.js';
import { ApprovalCard } from '../apps/desktop/ui/timeline.js';
import type { ClientUpdateState, SavedAuthorization } from '../packages/protocol/src/index.js';
import { stageDrafts } from '../apps/desktop/ui/drafts.js';
import '../apps/desktop/ui/style.css';

let state: ClientUpdateState = {supported:true,channel:'stable',phase:'idle',version:'0.3.1000',buildNumber:1000,message:''};
const candidate = {version:'0.3.1001',buildNumber:1001,commit:'a'.repeat(40),size:10485760};
const wait = (ms:number) => new Promise(r=>setTimeout(r,ms));
let rules: SavedAuthorization[] = [{id:'rule',target:'device:pc',target_label:'办公电脑',operation:'read',resource:'C:\\Projects\\Demo',resource_type:'directory',created_at:new Date().toISOString(),last_used_at:null}];
const history: unknown[] = [];
const harness = { mode:'latest', cancel:true, failDecision:true, resumeDownload:false, confirmations:[] as string[], history, savedDraft:false };
(window as any).__settingsHarness = harness;
window.confirm = text => { harness.confirmations.push(text ?? ''); return true; };
window.agent = {
  updates:{
    state:async()=>({...state}),
    check:async channel=>{
      state={...state,channel,phase:'checking',message:'正在检查更新…',candidate:undefined}; await wait(600);
      state=harness.mode === 'error' ? {...state,phase:'error',message:'网络连接失败，请重试'} : harness.mode === 'latest' ? {...state,phase:'idle',message:'已是当前通道最新版本'} : {...state,phase:'available',message:'有新版 0.3.1001',candidate};
      return {...state};
    },
    download:async()=>{
      state={...state,phase:'downloading',downloadedBytes:0,totalBytes:candidate.size,message:'正在下载 0%'};
      await wait(350); state={...state,downloadedBytes:candidate.size/2,message:'正在下载 50%'};
      while (!harness.resumeDownload) await wait(40);
      state={...state,phase:'ready',packageReady:true,message:'安装包已校验，等待你确认安装'}; return {...state};
    },
    install:async()=>{
      harness.savedDraft=JSON.parse(localStorage.getItem('pi-bot.message-drafts.v1') ?? '{}').bot?.text === '未发送草稿';
      if (harness.cancel) return false;
      state={...state,phase:'launching',message:'已打开安装器，请按系统提示确认升级'}; return true;
    },
  },
  call:async(method,input:any)=>{
    history.push({method,input});
    if(method === 'authorizations')return rules;
    if(method === 'authorizationLogs')return [{id:1,action:'grant',operation:'read',target:'device:pc',resource:'C:\\Projects\\Demo',created_at:new Date().toISOString()}];
    if(method === 'authorizationRevoke'){rules=[];return {revoked:true};}
    if(method === 'decide' && harness.failDecision){harness.failDecision=false;throw new Error('连接暂时中断，请重试');}
    return {};
  },
  subscribe:()=>()=>{},computerName:async()=>'',defaultServerUrl:async()=>'',openLibrary:async()=>{},openExternal:async()=>{},
};
stageDrafts({bot:{text:'未发送草稿',images:[]}});
createRoot(document.getElementById('root')!).render(<div className="backdrop"><div className="modal settings">
  <ClientUpdates />
  <ApprovalCard approval={{id:'approval',run_id:'run',bot_id:'bot',kind:'outside_access',path:'C:\\Projects\\Demo',reason:'读取项目说明',status:'pending',expires_at:'2099-01-01',can_remember:true,access:'read',scope:'当前账号 · 办公电脑 · 读取 · C:\\Projects\\Demo 及其子路径。不包含写入、删除或执行命令。'}} />
  <SavedAuthorizations />
</div></div>);
