import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

test("math and chemistry render with local fonts, source copy, selection freezing and mobile bridge", {skip:!process.env.PI_BOT_TEST_BROWSER,timeout:60000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),"pibot-math-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  await build({entryPoints:{harness:"packages/markdown/tests/harness.tsx",mobile:"packages/a2ui/web/main.tsx"},outdir:dir,bundle:true,format:"esm",jsx:"automatic",loader:{".woff2":"file",".woff":"file",".ttf":"file"},assetNames:"[name]"});
  await writeFile(join(dir,"harness.html"),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="harness.css"><style>body{font:16px/1.7 system-ui;margin:20px}#root{max-width:720px;margin:auto}</style><div id="root"></div><script type="module" src="harness.js"></script></html>');
  const mobile=(await readFile("packages/a2ui/web/index.html","utf8")).replace('./main.tsx','./mobile.js').replace('</head>','<link rel="stylesheet" href="./mobile.css"></head>');
  await writeFile(join(dir,"mobile.html"),mobile);
  const server=createServer(async(req,res)=>{try{
    const name=(req.url??"").slice(1);if(!/^[A-Za-z0-9_.-]+$/.test(name)){res.statusCode=404;return res.end();}
    res.setHeader("Content-Type",name.endsWith("js")?"text/javascript":name.endsWith("css")?"text/css":name.endsWith("woff2")?"font/woff2":name.endsWith("woff")?"font/woff":name.endsWith("ttf")?"font/ttf":"text/html");
    res.end(await readFile(join(dir,name)));
  }catch{res.statusCode=404;res.end();}});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch({headless:true,channel:"chromium",...(process.env.PI_BOT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PI_BOT_CHROMIUM_EXECUTABLE}:{})});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1024,height:1000}}),errors:string[]=[],external:string[]=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/*",route=>{if(!route.request().url().startsWith(base)){external.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto(base+"/harness.html");await page.locator(".katex").first().waitFor();
  assert.equal(await page.locator(".katex").count(),9);assert.equal(await page.locator(".pi-math-error").count(),0);
  await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.fonts.check('16px KaTeX_Main')),true);
  assert.match(await page.locator(".pi-markdown").innerText(),/价格 \$5 和 \$10/);
  const copied=await page.evaluate(()=>{
    const root=document.querySelector(".pi-markdown")!;const range=document.createRange();range.selectNodeContents(root);const selection=getSelection()!;selection.removeAllRanges();selection.addRange(range);
    const clipboardData=new DataTransfer();root.dispatchEvent(new ClipboardEvent("copy",{bubbles:true,cancelable:true,clipboardData}));return clipboardData.getData("text/plain");
  });
  assert.match(copied,/\$t_3\$/);assert.match(copied,/\\ce\{H2SO4\}/);assert.doesNotMatch(copied,/⧉/);
  await page.waitForTimeout(60);
  await page.evaluate(()=>(window as any).setMarkdown("new $x_1$"));await page.waitForTimeout(80);
  assert.match(await page.locator(".pi-markdown").innerText(),/溶解度/);
  await page.evaluate(()=>getSelection()?.removeAllRanges());await page.waitForFunction(()=>document.querySelector(".pi-markdown")?.textContent?.includes("new"));
  await page.evaluate(()=>(window as any).setMarkdown("$\\unknowncommand{x}$"));await page.locator(".pi-math-error").waitFor();
  await page.evaluate(()=>(window as any).setMarkdown("$x_"));assert.equal(await page.locator(".katex").count(),0);
  await page.evaluate(()=>(window as any).setMarkdown("$x_1$"));await page.locator(".katex").waitFor();
  await page.addInitScript({content:'window.packets=[];window.PiBotUiHost={postMessage:function(raw){var packet=JSON.parse(raw);window.packets.push(packet);if(packet.id)queueMicrotask(function(){window.piBotUi.respond({id:packet.id,result:null});});}};'});
  await page.setViewportSize({width:390,height:844});await page.goto(base+"/mobile.html");await page.waitForFunction(()=>!!(window as any).piBotUi);
  const source=String.raw`**温度** $t_3\,{}^\circ\mathrm{C}$；$\ce{SO4^2-}$

$$\frac{30\text{ g}}{100\text{ g}+30\text{ g}}\times100\%\approx23.1\%$$

$$\underbrace{x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x+x}_{24}$$`;
  await page.evaluate(source=>(window as any).piBotUi.receive({markdown:{source,fontSize:16,color:"#292929"}}),source);
  await page.locator(".katex").first().waitFor();await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.locator(".pi-math-error").count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.equal(await page.locator(".pi-math-block .pi-math-content").last().evaluate(el=>el.scrollWidth>el.clientWidth),true);
  await page.locator(".pi-math-copy").first().hover();
  await page.locator(".pi-math-copy").first().click();
  await page.waitForTimeout(100);
  assert.ok(await page.evaluate(()=>(window as any).packets.some((p:any)=>p.type==="copy")), JSON.stringify({errors,packets:await page.evaluate(()=>(window as any).packets),buttons:await page.locator(".pi-math-copy").count()}));
  assert.equal(await page.evaluate(()=>(window as any).packets.some((p:any)=>p.type==="copy"&&p.payload.text.includes("t_3"))),true);
  assert.equal(await page.evaluate(()=>(window as any).packets.some((p:any)=>p.type==="height"&&p.height>50)),true);
  const smokePayload={markdown:{source:JSON.parse(await readFile("packages/markdown/fixtures/smoke.json","utf8")).source,fontSize:16,color:"#292929"}};
  await page.evaluate(payload=>(window as any).piBotUi.receive(payload),smokePayload);
  await page.evaluate((await readFile("packages/markdown/tests/native-smoke.js","utf8"))+";window.piBotMathSmoke("+JSON.stringify(smokePayload)+");");
  await page.waitForFunction(()=>(window as any).packets.some((p:any)=>p.type==="math_smoke"));
  const smoke=await page.evaluate(()=>(window as any).packets.find((p:any)=>p.type==="math_smoke").result);
  assert.equal(smoke.ok,true,JSON.stringify(smoke));
  const screenshots=resolve("test-results/math");await mkdir(screenshots,{recursive:true});await page.screenshot({path:join(screenshots,"math-narrow.png"),fullPage:true});
  await page.setViewportSize({width:1024,height:900});await page.screenshot({path:join(screenshots,"math-wide.png"),fullPage:true});
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
});
