import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.env.CLIENT_SETTINGS_DIR;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
const wait = ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  const win = new BrowserWindow({show:false,width:720,height:1000,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});
  const js = code=>win.webContents.executeJavaScript(code);
  async function until(code,label){for(let i=0;i<100;i++){if(await js(code))return;await wait(40);}throw new Error(label);}
  async function click(text){await js(`[...document.querySelectorAll('button')].find(b=>b.textContent === ${JSON.stringify(text)}).click()`);}
  async function shot(name){await win.webContents.capturePage();await wait(250);writeFileSync(join(directory,name),(await win.webContents.capturePage()).toPNG());}
  try{
    await win.loadFile(join(directory,'settings.html'));
    await until(`document.body.textContent.includes('刷新授权') && [...document.querySelectorAll('button')].some(b=>b.textContent === '检查更新')`,'the renderer bridge hid the updater');
    await click('检查更新');
    await until(`document.body.textContent.includes('正在检查更新')`,'missing checking feedback');
    await until(`document.body.textContent.includes('已是当前通道最新版本')`,'manual check has no latest feedback');
    await js(`window.__settingsHarness.mode='error'`);await click('检查更新');
    await until(`document.querySelector('[role=status]').textContent.includes('网络连接失败') && !document.querySelector('[role=status]').textContent.includes('已是')`,'network error falsely reported latest');
    await js(`window.__settingsHarness.mode='available'`);await click('检查更新');
    await until(`document.body.textContent.includes('有新版')`,'candidate missing');
    await click('下载更新');
    await until(`document.querySelector('progress')?.value === 5242880`,'download progress missing');await shot('updates-progress.png');
    await js(`window.__settingsHarness.resumeDownload=true`);
    await until(`document.body.textContent.includes('等待你确认安装')`,'verified package state missing');
    await click('安装更新');
    await until(`document.body.textContent.includes('已取消安装')`,'cancellation feedback missing');
    if(!await js(`window.__settingsHarness.savedDraft`))throw new Error('draft not persisted before installation');
    await shot('updates-ready-and-authorizations.png');
    await js(`document.querySelector('.authorization-rule').scrollIntoView({block:'center'})`);
    await shot('saved-authorizations.png');
    await click('一直允许');
    await until(`document.body.textContent.includes('连接暂时中断')`,'decision failure missing');
    await click('一直允许');
    await until(`window.__settingsHarness.history.filter(x=>x.method==='decide').length===2`,'decision retry stayed disabled');
    if(!await js(`window.__settingsHarness.confirmations.every(x=>x.includes('办公电脑') && x.includes('不包含写入'))`))throw new Error('remembered permission scope was not confirmed');
    await click('撤销');
    await until(`document.body.textContent.includes('暂无已保存授权')`,'revocation not reflected');
    await js(`window.__settingsHarness.cancel=false`);await click('安装更新');
    await until(`document.body.textContent.includes('已打开安装器')`,'installer launch feedback missing');
    writeFileSync(join(directory,'result.json'),JSON.stringify({ok:true}));
    win.destroy();app.exit(0);
  }catch(error){writeFileSync(join(directory,'result.json'),JSON.stringify({ok:false,error:String(error.stack ?? error)}));win.destroy();app.exit(1);}
});
