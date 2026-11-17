import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
    if (config?.enabled !== true || !Array.isArray(config.origins ?? []) ||
        (config.origins?.length ?? 0) > 32 || !['auto', 'chrome', 'chromium'].includes(config.browser ?? 'auto')) return;
    const origins = new Set<string>();
    for (const input of config.origins ?? []) {
      if (typeof input !== 'string') return;
      const url = browserTestUrl(input);
      if (url.pathname !== '/' || url.search || url.hash) return;
      origins.add(url.origin);
    }
    return { origins, browser: config.browser ?? 'auto' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { origins: new Set(), browser: 'auto' };
  }
}

const roles = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'heading', 'status', 'alert', 'tab', 'option'] as const;
const keys = ['Enter', 'Tab', 'Escape', 'Space', 'ArrowDown', 'ArrowUp'] as const;
const timeout = 10000;
const clean = (value: string, limit = 240) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
const netLocation = (value: string) => {
  try { return browserTestUrl(value).origin; } catch { return 'unknown'; }
};
type Operation = 'open' | 'observe' | 'click' | 'fill' | 'press' | 'assert' | 'diagnostics' | 'screenshot' | 'authorize' | 'login';
interface Args {
  op: Operation;
  url?: string;
  role?: typeof roles[number];
  name?: string;
  text?: string;
  key?: typeof keys[number];
  state?: 'visible' | 'hidden';
  origins?: string[];
}
type Diagnostic = { kind: 'console' | 'page' | 'request' | 'http' | 'blocked'; message: string };
interface BrowserAuthorization {
  userAuthorized: boolean;
  request(origins: string[], signal?: AbortSignal): Promise<boolean>;
}
interface LoginHandoff {
  visible: boolean;
  wait(origin: string, signal?: AbortSignal): Promise<boolean>;
}
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
const operations: Operation[] = ['open', 'observe', 'click', 'fill', 'press', 'assert', 'diagnostics', 'screenshot', 'authorize'];

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
  private origins: Set<string>;
  private blocked = new Set<string>();
  private refused = new Set<string>();
  private visible: boolean;
  private manual = false;

  constructor(private config: BrowserTestConfig, private origin: string, private dataDir: string, private libraryRoot: string,
    private authorization?: BrowserAuthorization, private handoff?: LoginHandoff) {
    this.origins = new Set(config.origins);
    if (authorization?.userAuthorized) this.origins.add(origin);
    this.visible = handoff?.visible ?? false;
  }

  private recordBlocked(url: string) {
    const origin = netLocation(url);
    if (origin !== 'unknown' && !this.origins.has(origin) && !this.refused.has(origin) && this.blocked.size < 32) this.blocked.add(origin);
  }

  private async authorize(origins: string[], signal?: AbortSignal) {
    if (!this.authorization || !origins.length || this.stopped) return false;
    const allowed = await this.authorization.request(origins, signal);
    if (this.stopped || signal?.aborted) return false;
    for (const origin of origins) {
      this.blocked.delete(origin);
      (allowed ? this.origins : this.refused).add(origin);
    }
    return allowed;
  }

  private log(kind: Diagnostic['kind'], message: string) {
    this.counts[kind]++;
    if (this.manual) return;
    if (this.events.length === 100) this.events.shift();
    this.events.push({ kind, message: clean(message, 1500) });
  }

  private async openContext(storageState?: StorageState) {
    await this.proxy?.close().catch(() => {});
    this.proxy = await browserTestProxy(this.origins, origin => {
      if (this.page) this.log('blocked', origin);
    });
    if (this.stopped) throw new Error('浏览器测试已取消');
    const options = {
      chromiumSandbox: true, headless: !this.visible, timeout: 30000,
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
      if (!this.browser) {
        if (this.stopped) throw new Error('浏览器测试已取消', { cause });
        throw new Error(this.visible
          ? '无法打开测试窗口。请确认执行电脑已登录图形桌面，且 Chrome 或 Chromium 可用。'
          : '无法安全启动测试浏览器。请检查 Chrome Stable、代理和沙箱，或运行 npx --yes playwright@1.65.1 install --no-shell chromium。', { cause });
      }
    }
    if (this.stopped) throw new Error('浏览器测试已取消');
    const context = await this.browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', storageState });
    context.setDefaultTimeout(timeout);
    context.setDefaultNavigationTimeout(timeout);
    context.on('request', request => this.recordBlocked(request.url()));
    await context.route('**/*', route => {
      const url = route.request().url();
      if (this.origins.has(netLocation(url))) return route.continue();
      this.recordBlocked(url);
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => {
      this.log('blocked', 'WebSocket ' + netLocation(socket.url().replace(/^ws/, 'http')));
      return socket.close();
    });
    this.context = context;
    return context;
  }

  private async openPage(storageState?: StorageState) {
    const context = this.context ?? await this.openContext(storageState);
    const page = this.page = await context.newPage();
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') this.log('console', message.text()); });
    page.on('pageerror', error => this.log('page', error.message));
    page.on('requestfailed', request => this.log('request', request.url() + ' ' + (request.failure()?.errorText ?? '')));
    page.on('response', response => { if (response.status() >= 400) this.log('http', response.status() + ' ' + response.url()); });
    page.on('popup', popup => { if (!this.manual) void popup.close().catch(() => {}); });
    return page;
  }

  private async login(page: Page, signal?: AbortSignal) {
    if (!this.handoff) throw new Error('此任务不支持打开登录窗口');
    this.manual = true;
    try {
      if (!this.visible) {
        const url = browserTestUrl(page.url());
        const state = await page.context().storageState({ indexedDB: true });
        const entries = await page.evaluate(() => Object.entries(sessionStorage));
        await this.browser?.close();
        this.browser = this.context = this.page = undefined;
        this.visible = true;
        page = await this.openPage(state);
        const marker = `__pibot_restore_${randomUUID()}`;
        await page.addInitScript(({ origin, entries, marker }) => {
          if (window.location.origin !== origin || sessionStorage.getItem(marker)) return;
          for (const [key, value] of entries) sessionStorage.setItem(key, value);
          sessionStorage.setItem(marker, '1');
        }, { origin: url.origin, entries, marker });
        // Resume at the login URL with a navigation, never replay a form submission.
        await page.goto(url.href, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      }
      const origin = netLocation(page.url());
      if (!this.origins.has(origin) || !this.browser?.isConnected())
        return { resumed: false, blocked_origins: [...this.blocked], reason: '登录窗口未打开允许的页面' };
      await page.bringToFront().catch(() => {});
      const closed = new AbortController();
      const browser = this.browser;
      const disconnect = () => closed.abort();
      const closePage = () => { if (page.context().pages().every(candidate => candidate.isClosed())) disconnect(); };
      browser.once('disconnected', disconnect);
      page.once('close', closePage);
      try {
        const waiting = signal ? AbortSignal.any([signal, closed.signal]) : closed.signal;
        if (!await this.handoff.wait(origin, waiting) || waiting.aborted || this.stopped) {
          this.stopped = true;
          await browser.close().catch(() => {});
          return { resumed: false, reason: '用户取消或关闭了登录窗口' };
        }
        const allowedPage = (candidate: Page) => !candidate.isClosed() && this.origins.has(netLocation(candidate.url()));
        const candidates = page.context().pages().filter(allowedPage);
        this.page = candidates.find(candidate => netLocation(candidate.url()) === this.origin) ??
          (allowedPage(page) ? page : candidates.at(-1));
        return { resumed: !!this.page, origin: this.page ? netLocation(this.page.url()) : undefined, blocked_origins: [...this.blocked] };
      } finally {
        browser.off('disconnected', disconnect);
        page.off('close', closePage);
      }
    } finally {
      this.manual = false;
    }
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

  private async operation(args: Args, signal?: AbortSignal) {
    if (this.stopped) throw new Error('浏览器测试已取消');
    if (args.op === 'authorize') {
      const origins = [...new Set(args.origins ?? [...this.blocked].slice(0, 8))];
      if (origins.some(origin => !this.blocked.has(origin))) throw new Error('只能申请本次页面实际遇到的域名');
      return { approved: await this.authorize(origins, signal), origins };
    }
    if (args.op === 'open') {
      const url = browserTestUrl(args.url ?? this.origin);
      if (url.origin !== this.origin) throw new Error('请打开本任务已选定的测试站点');
      if (!this.origins.has(url.origin) && (this.refused.has(url.origin) || !await this.authorize([url.origin], signal)))
        return { opened: false, reason: '本次任务未获得网站访问授权' };
      const page = this.page ?? await this.openPage();
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      const origin = netLocation(page.url());
      const allowed = this.origins.has(origin) && this.origins.has(netLocation(response?.url() ?? page.url()));
      if (!response || !allowed) {
        // A blocked navigation can still commit Chromium's error document after goto rejects.
        await page.close().catch(() => {});
        this.page = undefined;
      }
      return {
        opened: !!response && response.ok() && allowed,
        status: response?.status() ?? null, origin, errors: this.counts, blocked_origins: [...this.blocked],
      };
    }
    if (args.op === 'diagnostics') return { errors: this.counts, blocked_origins: [...this.blocked], evidence: await this.saveEvidence() };
    const page = this.page;
    if (!page) throw new Error('请先打开测试页面');
    if (!this.origins.has(netLocation(page.url()))) throw new Error('测试页面已离开允许的站点');
    if (args.op === 'login') return await this.login(page, signal);
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
      description: '在选定电脑上测试 Web 页面。open 打开站点，observe 查看页面，click/fill/press 操作，assert 执行断言，diagnostics 列出错误和 blocked_origins，screenshot 本机截图。authorize 可一次申请本次实际被拦截、测试所需的多个 origin。获批后安全地重新打开页面验证，避免重放可能已提交的操作。' +
        (this.handoff ? ' 遇到登录页、扫码或人工身份验证时调用 login，打开独立窗口并暂停。用户返回后先观察页面验证是否登录。' : ''),
      parameters: Type.Object({
        op: Type.Union((this.handoff ? [...operations, 'login'] : operations).map(op => Type.Literal(op))),
        url: optional(2048), role: Type.Optional(Type.Union(roles.map(role => Type.Literal(role)))),
        origins: Type.Optional(Type.Array(Type.String({ maxLength: 2048 }), { minItems: 1, maxItems: 8 })),
        name: optional(240), text: Type.Optional(Type.String({ maxLength: 1000 })),
        key: Type.Optional(Type.Union(keys.map(key => Type.Literal(key)))),
        state: Type.Optional(Type.Union([Type.Literal('visible'), Type.Literal('hidden')])),
      }, { additionalProperties: false }),
      execute: async (_id, args: Args, signal) => {
        if (this.pending) throw new Error('请按顺序执行浏览器测试操作');
        const abort = () => { void this.close(); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const pending = this.pending = this.operation(args, signal);
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
