import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import sharp from "sharp";
import { reportViewer } from "../src/reports.js";
import { IMAGE_MODELS } from "../src/image-generation.js";
import { tempDir } from "./helpers.js";

test("admin saves selectable image models without exposing saved keys and generated images preview/download", {
  skip: !process.env.PI_BOT_TEST_BROWSER, timeout: 60000,
}, async t => {
  const dir = tempDir();
  t.after(() => dir.cleanup());
  await build({ entryPoints: { main: "admin/src/main.tsx", "report-viewer": "server/src/report-viewer.tsx" }, bundle: true, format: "esm", loader:{".woff2":"file",".woff":"file",".ttf":"file"}, jsx: "automatic", outdir: dir.path });
  const image = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#f4692a" } }).png().toBuffer();
  let config = { enabled: false, base_url: "", models: [...IMAGE_MODELS], default_model: IMAGE_MODELS[1], configured: false };
  const saves: any[] = [];
  const server = createServer(async (req, res) => {
    const json = (value: unknown) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.url === "/me") return json({ user: { id: "fixture", role: "admin", display_name: "测试管理员" } });
    if (req.url === "/admin/api/image-generation") {
      if (req.method === "PUT") {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const saved = JSON.parse(Buffer.concat(chunks).toString()); saves.push(saved);
        const { api_key, ...fields } = saved;
        config = { ...fields, configured: !!api_key || config.configured };
      }
      return json(config);
    }
    if (req.url?.startsWith("/reports/image/content")) {
      res.setHeader("Content-Type", "image/png"); res.setHeader("x-report-title", encodeURIComponent("生成图片预览")); res.setHeader("x-report-name", "robot.png");
      return res.end(image);
    }
    if (req.url === "/reports/view/image") { res.setHeader("Content-Type", "text/html"); return res.end(reportViewer); }
    if (req.url === "/admin/") { res.setHeader("Content-Type", "text/html"); return res.end('<html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="./main.css"><div id="root"></div><script type="module" src="./main.js"></script></html>'); }
    const file = req.url === "/reports/view/viewer.js" ? "report-viewer.js" : req.url === "/admin/main.js" ? "main.js" : req.url === "/admin/main.css" ? "main.css" : undefined;
    if (file) { res.setHeader("Content-Type", file.endsWith("css") ? "text/css" : "application/javascript"); return res.end(await readFile(join(dir.path, file))); }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  // CI installs the full Chromium browser, not the separate headless-shell package.
  const browser = await chromium.launch({ headless: true, channel: "chromium", ...(process.env.PI_BOT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PI_BOT_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 980 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("pi-bot-admin-token", "fixture-admin-token"));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await page.goto(`${base}/admin/#image-generation`);
  await page.getByRole("heading", { name: "图片生成" }).waitFor();
  await page.getByLabel("启用生图").check();
  await page.getByLabel("CLIProxy 地址").fill("https://proxy.example.com/v1");
  await page.getByLabel("API Key", { exact: true }).fill("fixture-private-image-key");
  await page.getByLabel(IMAGE_MODELS[1], { exact: true }).uncheck();
  assert.equal(await page.getByLabel("默认模型").inputValue(), IMAGE_MODELS[0]);
  await page.getByLabel("默认模型").selectOption(IMAGE_MODELS[2]);
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByRole("status").waitFor();
  assert.equal(saves.length, 1); assert.equal(saves[0].api_key, "fixture-private-image-key");
  assert.deepEqual(saves[0].models, [IMAGE_MODELS[0], IMAGE_MODELS[2]]);
  assert.equal(await page.getByLabel(/API Key/).inputValue(), "");
  await page.getByLabel(IMAGE_MODELS[1], { exact: true }).check();
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByRole("status").waitFor();
  assert.equal(saves.length, 2); assert.equal("api_key" in saves[1], false);
  if (process.env.PI_BOT_SCREENSHOT_DIR) {
    await mkdir(process.env.PI_BOT_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.PI_BOT_SCREENSHOT_DIR, "image-generation-settings.png"), fullPage: true });
  }
  await page.goto(`${base}/reports/view/image#token=fixture`);
  await page.getByRole("img", { name: "生成图片预览" }).waitFor();
  assert.equal(await page.getByRole("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 640), true);
  assert.equal(await page.getByRole("link", { name: "下载文件" }).getAttribute("download"), "robot.png");
  assert.equal(await page.evaluate(() => location.hash), "");
  assert.deepEqual(errors, []);
});
