import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.env.TIMELINE_DRAFTS_DIR;
const profile = join(directory,'profile'); mkdirSync(profile,{recursive:true});
app.setPath('userData',profile);
app.disableHardwareAcceleration();
const wait = ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
  const win = new BrowserWindow({show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});
  const js = code=>win.webContents.executeJavaScript(code);
  async function until(code,label) {
    for(let i=0;i<100;i++){if(await js(code)) return;await wait(30);}
    throw new Error(label);
  }
  async function expect(code,label) {if(!await js(code)) throw new Error(label);}
  async function select(id) {
    await js(`window.__draftHarness.select(${JSON.stringify(id)})`);
    await until(`document.querySelector('textarea')?.placeholder===${JSON.stringify(`给 ${id === 'bot-a' ? 'A' : 'B'} 发消息`)}`,'bot did not switch');
  }
  async function type(text) {
    await js(`(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(`document.querySelector('textarea').value===${JSON.stringify(text)}`,'typing did not update draft');
  }
  async function send(count) {
    await js(`document.querySelector('button.send').click()`);
    await until(`window.__draftHarness.requests.length===${count}`,'send did not start');
  }
  async function finish(success) {
    await js(`window.__draftHarness.finish(${success})`);
    await until(`!document.querySelector('button.attach').disabled`,'send did not settle');
  }
  const saved = `JSON.parse(localStorage.getItem('pi-bot.message-drafts.v1'))`;
  try {
    await win.loadFile(join(directory,'timeline.html'));
    await until(`document.querySelector('textarea')?.value==='  send A once  '`,'initial draft missing');
    await send(1);
    await expect(`window.__draftHarness.requests[0].text==='send A once'`,'send text was not trimmed');
    await select('bot-b');await type('B remains unsent');
    await finish(true);await js(`window.__draftHarness.save()`);
    await expect(`!${saved}['bot-a']`,'sent A draft survived switching to B');
    await expect(`${saved}['bot-b'].text==='B remains unsent' && ${saved}['bot-b'].images[0].name==='B.png'`,'A completion changed B draft');
    await win.reload();
    await until(`document.querySelector('textarea')?.value===''`,'sent A text returned after reload');
    await expect(`document.querySelectorAll('.image-drafts img').length===0`,'sent A images returned after reload');
    await select('bot-b');
    await expect(`document.querySelector('textarea').value==='B remains unsent' && document.querySelectorAll('.image-drafts img').length===1`,'unsent B draft was lost on reload');

    await select('bot-a');await type('send A again');await send(1);
    await type('new A text while sending');await select('bot-b');await finish(true);
    await js(`window.__draftHarness.save()`);
    await expect(`${saved}['bot-a'].text==='new A text while sending'`,'A completion deleted newly typed text');
    await expect(`${saved}['bot-b'].text==='B remains unsent'`,'A completion deleted B text');

    await send(2);await select('bot-a');await finish(false);
    await js(`window.__draftHarness.save()`);
    await expect(`${saved}['bot-b'].text==='B remains unsent' && ${saved}['bot-b'].images.length===1`,'failed B send lost its draft');
    await select('bot-b');
    await expect(`document.querySelector('textarea').value==='B remains unsent'`,'failed send draft missing after switching back');
    writeFileSync(join(directory,'result.json'),JSON.stringify({ok:true}));
    win.destroy();app.exit(0);
  } catch(error) {
    writeFileSync(join(directory,'result.json'),JSON.stringify({ok:false,error:String(error.stack ?? error)}));
    win.destroy();app.exit(1);
  }
});
