import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Timeline } from '../apps/desktop/ui/timeline.js';
import { bridge } from '../apps/desktop/ui/bridge.js';
import { stageDrafts } from '../apps/desktop/ui/drafts.js';
import type { Bot } from '../packages/protocol/src/index.js';

const image = {name:'pixel.png',mime_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'};
const botA: Bot = {id:'bot-a',name:'A',slug:'a',persona:'',model_id:null,avatar:{shape:'blob',color:'orange',scheme:'light'},pending_approvals:[],latest_run:null,last_message:null,created_at:'2026-10-31',last_active_at:'2026-10-31'};
const botB: Bot = {...botA,id:'bot-b',name:'B',slug:'b'};
let pending: {resolve(value:unknown):void;reject(error:Error):void} | undefined;
const harness = {
  requests: [] as {botId:string;text:string;images:unknown[]}[],
  select: (_id:string) => {},
  finish: (success:boolean) => {
    if (!pending) throw new Error('No pending send');
    const request = pending; pending = undefined;
    if (success) request.resolve({messages:[]}); else request.reject(new Error('Send failed'));
  },
  save: () => bridge.updates!.install(),
};
(window as any).__draftHarness = harness;
window.agent = {
  updates:{
    state:async()=>({supported:true,phase:'ready',channel:'stable',version:'0.3.0',buildNumber:0,message:''}),
    check:async()=>{throw new Error('unused');},download:async()=>{throw new Error('unused');},
    install:async()=>false,
  },
  call:async(method,input:any)=>{
    if (method !== 'send') throw new Error(`Unexpected call: ${method}`);
    harness.requests.push(input);
    return new Promise((resolve,reject)=>{pending={resolve,reject};});
  },
  subscribe:()=>()=>{},computerName:async()=>'',defaultServerUrl:async()=>'',openLibrary:async()=>{},openExternal:async()=>{},
};
if (!localStorage.getItem('pi-bot.message-drafts.v1')) stageDrafts({
  'bot-a':{text:'  send A once  ',images:[image]},
  'bot-b':{text:'draft B',images:[{...image,name:'B.png'}]},
});
function Harness() {
  const [bot,setBot] = useState(botA);
  harness.select = id=>setBot(id === botA.id ? botA : botB);
  return <Timeline bot={bot} messages={[]} hasMore={false} mood="idle" online={true} onLoadMore={()=>{}} onSent={()=>{}} onOpenBot={()=>{}} />;
}
createRoot(document.getElementById('root')!).render(<Harness />);
