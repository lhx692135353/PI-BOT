/* Loaded only by the debug launch fixtures, in the actual native WebView. */
window.piBotMathSmoke = async function (payload) {
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  try {
    for (let i = 0; i < 150 && document.querySelectorAll('.katex').length < 6; i++) await pause();
    await document.fonts.ready;
    const root = document.querySelector('.pi-markdown');
    if (!root) throw new Error('Markdown root missing');
    const count = root.querySelectorAll('.katex').length;
    const errors = root.querySelectorAll('.pi-math-error').length;
    const font = document.fonts.check('16px KaTeX_Main');
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const expectedCopy = root.querySelector('[data-tex]').dataset.tex;
    const range = document.createRange(); range.selectNodeContents(root);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    await pause();
    const clipboardData = new DataTransfer();
    root.dispatchEvent(new ClipboardEvent('copy', {bubbles:true, cancelable:true, clipboardData}));
    const copied = clipboardData.getData('text/plain');
    const before = root.textContent;
    window.piBotUi.receive({markdown:{source:'更新 $x_1$',fontSize:16,color:'#292929'}});
    await pause();
    const frozen = root.textContent === before;
    selection.removeAllRanges();
    for (let i = 0; i < 50 && !root.textContent.includes('更新'); i++) await pause();
    const resumed = root.textContent.includes('更新');
    window.piBotUi.receive(payload);
    for (let i = 0; i < 50 && root.querySelectorAll('.katex').length < 6; i++) await pause();
    const respond = window.piBotUi.respond;
    let copyReady = false;
    window.piBotUi.respond = function (value) { respond(value); copyReady = !value.error; };
    root.querySelector('.pi-math-copy').click();
    for (let i = 0; i < 100 && !copyReady; i++) await pause();
    window.piBotUi.respond = respond;
    window.PiBotUiHost.postMessage(JSON.stringify({type:'math_smoke',result:{
      ok: count >= 6 && errors === 0 && font && copyReady && !overflow && frozen && resumed && copied.includes(expectedCopy),
      count, errors, font, copyReady, overflow, frozen, resumed, expectedCopy, copied
    }}));
  } catch (error) {
    window.PiBotUiHost.postMessage(JSON.stringify({type:'math_smoke',result:{ok:false,error:String(error)}}));
  }
};
