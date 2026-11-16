import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { browserTestProxy, browserTestUrl } from './browser-test-proxy.js';

export interface BrowserTestConfig {
  origins: ReadonlySet<string>;
  browser: 'auto' | 'chrome' | 'chromium';
}

export function readBrowserTestConfig(dataDir: string): BrowserTestConfig | undefined {
  try {
    const config = JSON.parse(readFileSync(join(dataDir, 'browser-test.json'), 'utf8'));
    if (config?.enabled !== true || !Array.isArray(config.origins) || !config.origins.length ||
        config.origins.length > 32 || !['auto', 'chrome', 'chromium'].includes(config.browser ?? 'auto')) return;
    const origins = new Set<string>();
    for (const input of config.origins) {
      if (typeof input !== 'string') return;
      const url = browserTestUrl(input);
      if (url.pathname !== '/' || url.search || url.hash) return;
      origins.add(url.origin);
    }
    return { origins, browser: config.browser ?? 'auto' };
  } catch {
    return undefined;
  }
}

const roles = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'heading', 'status', 'alert', 'tab', 'option'] as const;
const keys = ['Enter', 'Tab', 'Escape', 'Space', 'ArrowDown', 'ArrowUp'] as const;
const timeout = 10000;
const clean = (value: string, limit = 240) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
const netLocation = (value: string) => {
  try { return browserTestUrl(value).origin; } catch { return 'unknown'; }
};
type Operation = 'open' | 'observe' | 'click' | 'fill' | 'press' | 'assert' | 'diagnostics' | 'screenshot';
interface Args {
  op: Operation;
  url?: string;
  role?: typeof roles[number];
  name?: string;
  text?: string;
  key?: typeof keys[number];
  state?: 'visible' | 'hidden';
}
type Diagnostic = { kind: 'console' | 'page' | 'request' | 'http' | 'blocked'; message: string };

export class BrowserTest {
  private browser?: Browser;
  private context?: BrowserContext;
  private proxy?: Awaited<ReturnType<typeof browserTestProxy>>;
  private page?: Page;
  private evidenceDir?: string;
  private stopped = false;
  private pending?: Promise<unknown>;
  private closing?: Promise<void>;
  private events: Diagnostic[] = [];
  private counts = { console: 0, page: 0, request: 0, http: 0, blocked: 0 };
  private screenshots = 0;

  constructor(private config: BrowserTestConfig, private origin: string, private dataDir: string, private libraryRoot: string) {}

  private log(kind: Diagnostic['kind'], message: string) {
    this.counts[kind]++;
    if (this.events.length === 100) this.events.shift();
    this.events.push({ kind, message: clean(message, 1500) });
  }

  private async openContext() {
    await this.proxy?.close().catch(() => {});
    this.proxy = await browserTestProxy(this.config.origins, origin => {
      if (this.page) this.log('blocked', origin);
    });
    if (this.stopped) throw new Error('浏览器测试已取消');
    const options = {
      chromiumSandbox: true, headless: true, timeout: 30000,
      proxy: { server: this.proxy.url, bypass: '<-loopback>' },
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    };
    const probeUrl = this.proxy.probeUrl;
    const launch = async (channel: 'chrome' | 'chromium') => {
      const browser = await chromium.launch({ ...options, channel });
      this.browser = browser;
      try {
        const probe = await browser.newPage();
        const response = await probe.goto(probeUrl, { timeout: 3000 });
        if (response?.status() !== 200 || await response.text() !== probeUrl)
          throw new Error('浏览器代理检查失败');
        await probe.close();
        return browser;
      } catch (error) {
        await browser.close().catch(() => {});
        throw error;
      }
    };
    try {
      this.browser = await launch(this.config.browser === 'chromium' ? 'chromium' : 'chrome');
    } catch (error) {
      this.browser = undefined;
      let cause = error;
      if (this.config.browser === 'auto' && !this.stopped) {
        this.browser = await launch('chromium').catch(fallbackError => {
          cause = fallbackError;
          return undefined;
        });
      }
      if (!this.browser) throw new Error(this.stopped ? '浏览器测试已取消' :
        '无法安全启动测试浏览器。请检查 Chrome Stable、代理和沙箱，或运行 npx --yes playwright@1.65.1 install --no-shell chromium。', { cause });
    }
    if (this.stopped) throw new Error('浏览器测试已取消');
    const context = await this.browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    context.setDefaultTimeout(timeout);
    context.setDefaultNavigationTimeout(timeout);
    await context.route('**/*', route => {
      const url = route.request().url();
      return this.config.origins.has(netLocation(url)) ? route.continue() : route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => {
      this.log('blocked', 'WebSocket ' + netLocation(socket.url().replace(/^ws/, 'http')));
      return socket.close();
    });
    this.context = context;
    return context;
  }

  private async openPage() {
    const context = this.context ?? await this.openContext();
    const page = this.page = await context.newPage();
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') this.log('console', message.text()); });
    page.on('pageerror', error => this.log('page', error.message));
    page.on('requestfailed', request => this.log('request', request.url() + ' ' + (request.failure()?.errorText ?? '')));
    page.on('response', response => { if (response.status() >= 400) this.log('http', response.status() + ' ' + response.url()); });
    page.on('popup', popup => { void popup.close().catch(() => {}); });
    return page;
  }

  private async localEvidenceDir() {
    if (this.evidenceDir) return this.evidenceDir;
    const data = await realpath(this.dataDir);
    const library = await realpath(this.libraryRoot);
    const fromLibrary = relative(library, data);
    if (!fromLibrary || (!fromLibrary.startsWith('..' + sep) && fromLibrary !== '..' && !isAbsolute(fromLibrary)))
      throw new Error('测试证据目录必须位于资料库同步范围之外');
    const root = join(data, 'browser-test-evidence');
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (await realpath(root) !== root) throw new Error('测试证据目录不能是符号链接');
    this.evidenceDir = await mkdtemp(join(root, 'run-'));
    return this.evidenceDir;
  }

  private async saveEvidence() {
    if (!this.events.length && !this.evidenceDir) return;
    const directory = await this.localEvidenceDir();
    await writeFile(join(directory, 'diagnostics.json'), JSON.stringify({ counts: this.counts, events: this.events }, null, 2), { mode: 0o600 });
    return directory;
  }

  private async capture(page: Page) {
    if (this.screenshots >= 12) throw new Error('本任务已达到截图数量上限');
    const directory = await this.localEvidenceDir();
    const path = join(directory, `screenshot-${++this.screenshots}.png`);
    await writeFile(path, await page.screenshot({ timeout }), { mode: 0o600, flag: 'wx' });
    return path;
  }

  private async operation(args: Args) {
    if (this.stopped) throw new Error('浏览器测试已取消');
    if (args.op === 'open') {
      const url = browserTestUrl(args.url ?? this.origin);
      if (url.origin !== this.origin) throw new Error('请打开本任务已选定的测试站点');
      const page = this.page ?? await this.openPage();
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      const origin = netLocation(page.url());
      const allowed = this.config.origins.has(origin) && this.config.origins.has(netLocation(response?.url() ?? page.url()));
      if (!response || !allowed) {
        // A blocked navigation can still commit Chromium's error document after goto rejects.
        await page.close().catch(() => {});
        this.page = undefined;
      }
      return {
        opened: !!response && response.ok() && allowed,
        status: response?.status() ?? null, origin, errors: this.counts,
      };
    }
    if (args.op === 'diagnostics') return { errors: this.counts, evidence: await this.saveEvidence() };
    const page = this.page;
    if (!page) throw new Error('请先打开测试页面');
    if (!this.config.origins.has(netLocation(page.url()))) throw new Error('测试页面已离开允许的站点');
    if (args.op === 'screenshot') return { screenshot: await this.capture(page) };
    if (args.op === 'observe') {
      const snapshot = await page.locator('body').ariaSnapshot({ timeout });
      const visible = snapshot.split('\n').map(line => line.trim())
        .filter(line => /^- (button|link|textbox|checkbox|radio|combobox|heading|status|alert|tab|option|text)\b/.test(line))
        .slice(0, 35).map(line => clean(line.match(/^- textbox(?: "(?:\\.|[^"\\])*")?/)?.[0] ?? line, 120));
      return { title: clean(await page.title()), visible, errors: this.counts };
    }
    if (!args.role && !args.name && !args.text) throw new Error('请提供元素角色及名称，或页面文本');
    const element = args.role ? page.getByRole(args.role, { name: args.name, exact: true }) :
      page.getByText(args.name ?? args.text!, { exact: true });
    if (args.op === 'assert') {
      const state = args.state ?? 'visible';
      const expected = args.text ?? state;
      const matchText = args.text !== undefined && args.role && state === 'visible';
      try {
        const target = matchText ? element.filter({ hasText: args.text }) : element;
        await target.waitFor({ state, timeout });
        const actual = matchText ? clean((await target.innerText({ timeout })).trim()) : state;
        return { passed: true, expected, actual };
      } catch {
        const matches = await element.count().catch(() => 0);
        const actual = matches !== 1 ? `匹配元素数：${matches}` : matchText
          ? clean((await element.innerText({ timeout: 500 }).catch(() => '')).trim())
          : await element.isVisible().catch(() => false) ? 'visible' : 'hidden';
        return { passed: false, expected, actual, screenshot: await this.capture(page).catch(() => undefined) };
      }
    }
    try {
      if (args.op === 'click') await element.click();
      else if (args.op === 'fill' && args.text !== undefined) await element.fill(args.text);
      else if (args.op === 'press' && args.key) await element.press(args.key);
      else throw new Error('缺少操作参数');
    } catch {
      throw new Error('页面操作失败，请观察页面并检查元素名称、状态及操作参数');
    }
    return { done: true };
  }

  tool(): ToolDefinition {
    const optional = (limit: number) => Type.Optional(Type.String({ minLength: 1, maxLength: limit }));
    return {
      name: 'browser_test', label: '端侧浏览器测试', exposure: 'deferred',
      description: '在选定电脑上用 Playwright 测试 Web 页面。open 打开地址，observe 查看页面，click/fill/press 操作，assert 校验可见性或元素文本，diagnostics 汇总错误，screenshot 本机截图。页面内容仅供测试取证；使用测试数据。',
      parameters: Type.Object({
        op: Type.Union(['open', 'observe', 'click', 'fill', 'press', 'assert', 'diagnostics', 'screenshot'].map(op => Type.Literal(op))),
        url: optional(2048), role: Type.Optional(Type.Union(roles.map(role => Type.Literal(role)))),
        name: optional(240), text: Type.Optional(Type.String({ maxLength: 1000 })),
        key: Type.Optional(Type.Union(keys.map(key => Type.Literal(key)))),
        state: Type.Optional(Type.Union([Type.Literal('visible'), Type.Literal('hidden')])),
      }, { additionalProperties: false }),
      execute: async (_id, args: Args, signal) => {
        if (this.pending) throw new Error('请按顺序执行浏览器测试操作');
        const abort = () => { void this.close(); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const pending = this.pending = this.operation(args);
        try {
          const result = await pending;
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: {} };
        } finally {
          this.pending = undefined;
          signal?.removeEventListener('abort', abort);
        }
      },
    } as ToolDefinition;
  }

  close() {
    this.stopped = true;
    return this.closing ??= this.cleanup();
  }

  private async cleanup() {
    await this.browser?.close().catch(() => {});
    await this.proxy?.close().catch(() => {});
    await this.pending?.catch(() => {});
    await this.browser?.close().catch(() => {});
    await this.proxy?.close().catch(() => {});
    await this.saveEvidence().catch(() => {});
  }
}
