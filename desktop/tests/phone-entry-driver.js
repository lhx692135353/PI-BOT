{ const A = '00000000-0000-4000-8000-000000000001';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, label) {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const value = read();
    if (value) return value;
    await delay(30);
  }
  throw new Error(`超时：${label}；${document.body.innerText.slice(0, 500)}；${window.__calls.map(call => call.method).join(',')}`);
}
function calls(method) { return window.__calls.filter(call => call.method === method); }
async function runEntry() {
  const header = await waitFor(() => document.querySelector('button[aria-label="打开手机预览"]'), '聊天右上角手机入口');
  const before = window.__calls.length;
  header.click();
  await waitFor(() => document.querySelector('aside[aria-label="手机预览"]'), '右上角打开的面板');
  await delay(150);
  if (calls('phonePreview').length) throw new Error('Agent 不应隐式绑定手机所在电脑');
  const picker = document.querySelector('select[aria-label="选择已授权的执行电脑"]');
  if (!picker) throw new Error('未提供明确选择电脑的入口');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(picker,A); picker.dispatchEvent(new Event('change',{bubbles:true}));
  const preview = await waitFor(() => calls('phonePreview')[0], '右上角入口的预览');
  if (preview.input?.deviceId !== A) throw new Error('右上角面板没有预览明确选择的电脑');
  if (calls('phoneAcquire').length !== 0) throw new Error('右上角打开面板时调用了接管');
  if (!document.body.innerText.includes('默认只读预览')) throw new Error('右上角面板没有默认只读说明');
  await waitFor(() => document.querySelector('.phone-screen img'), '右上角预览画面');
  document.querySelector('aside[aria-label="手机预览"] button')?.click();
  await waitFor(() => !document.querySelector('aside[aria-label="手机预览"]'), '关闭右上角面板');
  if (calls('phoneAcquire').length !== 0) throw new Error('只读预览关闭时发生了接管');
  if (window.__calls.length <= before) throw new Error('右上角入口没有发起任何调用');

  document.querySelector('button.me')?.click();
  const settingsEntry = await waitFor(() => document.querySelector('button[aria-label="预览电脑A上的手机"]'), '设置里的手机入口');
  const acquireBefore = calls('phoneAcquire').length;
  settingsEntry.click();
  await waitFor(() => document.querySelector('aside[aria-label="手机预览"]'), '设置打开的面板');
  if (!document.body.innerText.includes('从设置打开时不改某个 Bot 的关联')) throw new Error('设置入口改写了 Bot 关联说明');
  if (document.querySelector('select[aria-label="选择已授权的执行电脑"]')) throw new Error('设置入口不应再让用户改选电脑');
  const pinned = await waitFor(() => calls('phonePreview').find(call => call.input?.deviceId === A), '设置入口预览');
  if (!pinned) throw new Error('设置入口没有预览所选执行电脑');
  await delay(300);
  if (calls('phoneAcquire').length !== acquireBefore) throw new Error('设置入口打开面板时调用了接管');
  return { ok: true, failures: [], calls: window.__calls.map(call => call.method) };
}
window.addEventListener('error', event => { window.__errors = [...(window.__errors || []), String(event.error || event.message)]; });
void runEntry().then(result => { window.__phoneResult = result; }).catch(error => {
  window.__phoneResult = { ok: false, failures: [{ name: '聊天入口与设置入口', message: error instanceof Error ? error.stack || error.message : String(error) }], errors: window.__errors || [] };
});
}
