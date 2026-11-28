import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tableDocument, type TableLayout } from '../../packages/a2ui/tests/table-fixtures.js';
import { ARTIFACT_ID, documentOf } from '../../packages/a2ui/tests/widget-fixtures.js';

test('wide tables stay inside messages and native pages report uncapped height with a reachable bottom', {skip: !process.env.PI_BOT_TEST_BROWSER, timeout: 90000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pibot-ui-layout-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  await build({entryPoints: {tables: 'desktop/tests/generative-ui-browser/tables.tsx', native: 'packages/a2ui/web/main.tsx'}, bundle: true, format: 'esm', loader:{".woff2":"file",".woff":"file",".ttf":"file"}, jsx: 'automatic', outdir: dir});
  const server = createServer(async (req, res) => {
    const native = req.url === '/native';
    if (req.url === '/' || native) {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${native ? 'native' : 'tables'}.css"><style>body{margin:0}.message{box-sizing:border-box;width:100%;max-width:720px;padding:20px;min-width:0}</style><div id="${native ? 'pi-bot-ui-root' : 'root'}"></div>${native ? '<script>window.packets=[];window.PiBotUiHost={postMessage(raw){const p=JSON.parse(raw);window.packets.push(p);if(p.id)queueMicrotask(()=>window.piBotUi.respond({id:p.id,result:null}));}}</script>' : ''}<script type="module" src="/${native ? 'native' : 'tables'}.js"></script>`);
    } else if (/^\/(tables|native)\.(js|css)$/.test(req.url ?? '')) {
      res.setHeader('Content-Type', req.url!.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(join(dir, req.url!.slice(1))));
    } else res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = await chromium.launch({headless: true, ...(process.env.PI_BOT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.PI_BOT_CHROMIUM_EXECUTABLE} : {channel: 'chromium'})});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 390, height: 800}});
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  await page.goto(url);
  for (const width of [320, 360, 390, 430, 1280]) {
    await page.setViewportSize({width, height: 800});
    for (const layout of ['direct', 'card', 'tabs', 'card-tabs', 'tabs-card', 'legacy'] as TableLayout[]) {
      await page.evaluate(layout => (window as any).setTableLayout(layout), layout);
      // React can leave the previous fixture visible until the next commit. Scope every
      // observation to the requested layout instead of accepting its identical 15 rows.
      const table = page.locator(`.message[data-layout="${layout}"] .pi-ui-table-scroll`); await table.waitFor();
      await page.waitForFunction(layout => document.querySelector(`.message[data-layout="${layout}"]`)?.querySelectorAll('tbody tr').length === 15, layout);
      const metrics = await table.evaluate(el => {
        const rect = el.getBoundingClientRect(), cells = [...el.querySelectorAll('thead th')].map(cell => cell.getBoundingClientRect());
        return {page: document.documentElement.scrollWidth, viewport: innerWidth, left: rect.left, right: rect.right, client: el.clientWidth, scroll: el.scrollWidth, widths: cells.map(r => r.width), cardOverflow: [...document.querySelectorAll('[data-aui="card"]')].some(card => card.scrollWidth > card.clientWidth + 1)};
      });
      assert.ok(metrics.page <= metrics.viewport + 1, `${width}/${layout}: page overflows`);
      assert.ok(metrics.left >= 0 && metrics.right <= width + 1, `${width}/${layout}: table viewport escapes`);
      assert.equal(metrics.cardOverflow, false, `${width}/${layout}: card overflows`);
      assert.ok(metrics.scroll > metrics.client, `${width}/${layout}: missing internal scroll ${JSON.stringify(metrics)}`);
      assert.ok(metrics.widths.every(w => w >= 159), `${width}/${layout}: columns too narrow: ${metrics.widths}`);
      await table.evaluate(el => { el.scrollLeft = el.scrollWidth; });
      assert.ok(await table.evaluate(el => { const last = el.querySelector('thead th:last-child')!.getBoundingClientRect(), frame = el.getBoundingClientRect(); return last.right <= frame.right + 1 && last.left < frame.right; }), 'last column reachable');
      assert.ok(await table.evaluate(el => [...el.querySelectorAll('thead th')].every((th, i) => Math.abs(th.getBoundingClientRect().width - el.querySelectorAll('tbody tr:first-child td')[i].getBoundingClientRect().width) < 1)), 'header aligns with cells');
      assert.ok(await table.evaluate(el => [...el.querySelectorAll('td')].every(td => td.scrollWidth <= td.clientWidth + 1)), 'long cells wrap');
      if (width === 390 && layout === 'card-tabs' && process.env.PI_BOT_SCREENSHOT_DIR) {
        await mkdir(process.env.PI_BOT_SCREENSHOT_DIR, {recursive: true});
        await page.screenshot({path: join(process.env.PI_BOT_SCREENSHOT_DIR, 'wide-table-mobile-right.png')});
        await table.evaluate(el => { el.scrollLeft = 0; });
        await page.screenshot({path: join(process.env.PI_BOT_SCREENSHOT_DIR, 'wide-table-mobile-left.png')});
      }
      if (layout !== 'legacy') {
        await table.evaluate(el => { el.scrollLeft = 0; });
        await page.getByRole('button', {name: '序号', exact: true}).click();
        assert.equal(await table.locator('tbody tr:first-child td:first-child').textContent(), '1');
        assert.ok((await table.locator('tbody tr:first-child td').nth(2).textContent())!.includes(','), 'number formatting retained');
        if (layout.includes('tabs')) {
          await page.getByRole('tab', {name: '说明', exact: true}).click();
          await table.waitFor({state: 'hidden'});
          await page.getByRole('tab', {name: '对比', exact: true}).click();
          await table.waitFor();
        }
      }
    }
  }
  await page.goto(url + '/native');
  await page.waitForFunction(() => !!(window as any).piBotUi);
  let revision = 1;
  const send = async (document: ReturnType<typeof tableDocument>) => {
    await page.evaluate(document => (window as any).piBotUi.receive({document, disabled: false}), {...document, revision: ++revision});
    await page.waitForTimeout(150);
  };
  await page.setViewportSize({width: 390, height: 600});
  await send(tableDocument('card-tabs', true));
  await page.waitForFunction(() => (window as any).packets.filter((p: any) => p.type === 'height').at(-1)?.height > 6000);
  const natural = await page.evaluate(() => (window as any).packets.filter((p: any) => p.type === 'height').at(-1).height);
  assert.ok(natural > 6000);
  assert.equal(await page.evaluate(() => (window as any).packets.filter((p: any) => p.type === 'height').at(-1).width), 390);
  const end = page.getByRole('button', {name: '最后一行操作', exact: true});
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  assert.ok(await end.evaluate(el => el.getBoundingClientRect().bottom <= innerHeight + 1), 'bottom reachable in a capped native viewport');
  const nativeTable = page.locator('.pi-ui-table-scroll');
  await nativeTable.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  assert.ok(await nativeTable.locator('tbody tr:last-child td:last-child').evaluate(el => {
    const cell = el.getBoundingClientRect(), frame = el.closest('.pi-ui-table-scroll')!.getBoundingClientRect();
    return cell.bottom <= innerHeight + 1 && cell.right <= frame.right + 1 && cell.left < frame.right;
  }), 'last row and last column are both reachable');
  await end.click();
  await page.waitForFunction(() => (window as any).packets.some((p: any) => p.type === 'action' && p.payload.action.name === 'end'));
  await page.getByRole('tab', {name: '说明', exact: true}).click();
  await page.waitForFunction(() => (window as any).packets.filter((p: any) => p.type === 'height').at(-1)?.height < 600);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'short content does not retain blank scroll space');
  await page.getByRole('tab', {name: '对比', exact: true}).click();
  await page.waitForFunction(() => (window as any).packets.filter((p: any) => p.type === 'height').at(-1)?.height > 6000);
  await page.setViewportSize({width: 800, height: 390});
  await page.waitForFunction(() => (window as any).packets.filter((p: any) => p.type === 'height').at(-1)?.width === 800);
  const reports = await page.evaluate(() => (window as any).packets.filter((p: any) => p.type === 'height').length);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => (window as any).packets.filter((p: any) => p.type === 'height').length), reports, 'height reporting settles');
  await send(tableDocument('direct', false, 1));
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1 && (window as any).packets.filter((p: any) => p.type === 'height').at(-1)?.height < 600);
  assert.equal(await page.evaluate(() => scrollY), 0, 'a shorter document clears the old scroll range');
  await page.evaluate(() => {
    const original = (window as any).PiBotUiHost.postMessage;
    (window as any).PiBotUiHost.postMessage = (raw: string) => {
      const packet = JSON.parse(raw);
      if (packet.type !== 'image') return original(raw);
      (window as any).packets.push(packet);
      setTimeout(() => {
        const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 1024;
        canvas.getContext('2d')!.fillRect(0, 0, 512, 1024);
        (window as any).piBotUi.respond({id: packet.id, result: canvas.toDataURL('image/png')});
      }, 200);
    };
    (window as any).packets = [];
  });
  await send(documentOf([{id: 'root', component: 'AuiImage', artifact_id: ARTIFACT_ID, alt: '延迟图片'}]));
  await page.waitForFunction(() => document.querySelector('.pi-image-preview img')?.getAttribute('src')?.startsWith('data:image/png'));
  await page.waitForFunction(() => (window as any).packets.filter((p: any) => p.type === 'height').at(-1)?.height > 300);
  assert.ok(await page.evaluate(() => {
    const heights = (window as any).packets.filter((p: any) => p.type === 'height').map((p: any) => p.height);
    return Math.max(...heights) > Math.min(...heights) + 200;
  }), 'asynchronous image loading remeasures natural content height');
  const handoff = await page.evaluate(() => {
    const fixture = document.createElement('section');
    fixture.style.cssText = 'position:fixed;inset:0;z-index:9999;background:white';
    fixture.innerHTML = '<p id="plain">Selectable ordinary text</p><input id="field"><button id="control">Button</button><div id="map" class="leaflet-container" style="height:40px">Map</div><div id="editable" contenteditable="true">Edit</div><div id="nested" style="height:30px;overflow-y:auto"><div style="height:200px">Nested scroll</div></div><div id="touch" style="touch-action:none;height:30px">DOM gesture</div>';
    document.body.append(fixture);
    const result: Record<string, boolean> = {};
    for (const id of ['plain', 'field', 'control', 'map', 'editable', 'nested', 'touch']) {
      const r = document.getElementById(id)!.getBoundingClientRect();
      result[id] = (window as any).piBotUi.canScrollAt((r.left + 2) / innerWidth, (r.top + 2) / innerHeight);
    }
    const selection = getSelection()!, range = document.createRange();
    range.selectNodeContents(document.getElementById('plain')!);
    selection.removeAllRanges(); selection.addRange(range);
    const r = document.getElementById('plain')!.getBoundingClientRect();
    result.selection = (window as any).piBotUi.canScrollAt((r.left + 2) / innerWidth, (r.top + 2) / innerHeight);
    selection.removeAllRanges(); fixture.remove();
    return result;
  });
  assert.deepEqual(handoff, {plain: true, field: false, control: false, map: false, editable: false, nested: false, touch: false, selection: false}, 'native handoff preserves DOM interaction and text selection');
  assert.deepEqual(errors, []);
});
