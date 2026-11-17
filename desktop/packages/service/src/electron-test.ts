import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { _electron, type ElectronApplication } from 'playwright';
import { Type } from 'typebox';

export type ElectronTestTarget = { app: 'pibot' | 'electron'; executable?: string; entry?: string };

interface ElectronTestOptions {
  dataDir: string;
  runId: string;
  target: ElectronTestTarget;
  canonical: (path: string) => Promise<string>;
  approveLaunch: (path: string, reason: string, signal?: AbortSignal) => Promise<boolean>;
  handoff: (signal?: AbortSignal) => Promise<boolean>;
}

const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });
const timeout = 10_000;
const applicationEnvironment = /^(?:path|systemroot|windir|systemdrive|home|userprofile|username|user|logname|temp|tmp|tmpdir|lang|lc_.*|display|xauthority|wayland_display|xdg_runtime_dir|dbus_session_bus_address|localappdata|appdata)$/i;
type Operation = {
  action: 'open' | 'observe' | 'click' | 'fill' | 'assert' | 'screenshot' | 'login';
  selector?: string;
  value?: string;
};

export class ElectronTest {
  private app?: ElectronApplication;
  private profile?: string;
  private closed = false;
  private closing?: Promise<void>;
  private operation?: Promise<ReturnType<typeof answer>>;
  private screenshots = 0;

  constructor(private o: ElectronTestOptions) {}

  private async launch(signal?: AbortSignal) {
    const builtIn = this.o.target.app === 'pibot';
    const executableInput = builtIn ? process.env.PI_BOT_DESKTOP_EXECUTABLE : this.o.target.executable;
    const entryInput = builtIn ? process.env.PI_BOT_DESKTOP_ENTRY : this.o.target.entry;
    if (!executableInput) throw new Error('找不到 Pi Bot 桌面可执行文件。请从桌面应用或项目开发启动命令运行本地服务');
    const executable = await realpath(await this.o.canonical(executableInput));
    const entry = entryInput ? await realpath(await this.o.canonical(entryInput)) : undefined;
    if (!(await stat(executable)).isFile()) throw new Error('请选择实际的 Electron 可执行文件');
    const reason = '本次端侧测试会启动独立 Electron 实例。' + (entry ? `开发入口：${entry}` : '');
    if (!await this.o.approveLaunch(executable, reason, signal)) throw new Error('本次应用测试未获启动授权');
    if (this.closed) throw new Error('测试已经结束');
    signal?.throwIfAborted();
    const root = join(this.o.dataDir, 'electron-test-profiles');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const profile = await realpath(await mkdtemp(join(root, 'run-')));
    this.profile = profile;
    const env: Record<string, string> = { PI_BOT_DATA_DIR: profile, PI_BOT_LIBRARY_ROOT: join(profile, 'library') };
    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue;
      if (applicationEnvironment.test(key) || (builtIn && /^PI_BOT_(?:ELECTRON_TEST_(?:SERVICE|NODE)|WINDOWS_HELPER)$/.test(key)))
        env[key] = value;
    }
    const app = await _electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${profile}`, ...(entry ? [entry] : [])],
      cwd: entry && (await stat(entry)).isDirectory() ? entry : dirname(entry ?? executable),
      env,
      chromiumSandbox: true, timeout: 30_000,
    });
    this.app = app;
    if (this.closed || signal?.aborted) throw new Error('测试已经结束');
    const userData = await app.evaluate(({ app }) => app.getPath('userData'));
    if (normalize(userData) !== profile && !(builtIn && normalize(userData) === join(profile, 'electron')))
      throw new Error('此应用未采用任务的隔离数据目录，请使用支持独立数据目录的测试版本');
    await app.firstWindow({ timeout });
  }

  private async run(input: Operation, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('测试已经结束');
    if (input.action === 'open') {
      if (!this.app) {
        try { await this.launch(signal); }
        catch (error) { await this.cleanup(); throw error; }
      }
      return answer('测试应用已打开');
    }
    if (!this.app) throw new Error('请先打开测试应用');
    const window = await this.app.firstWindow({ timeout });
    switch (input.action) {
      case 'observe': return answer((await window.locator('body').ariaSnapshot({ timeout })).slice(0, 8000));
      case 'login': {
        const nativeWindow = await this.app.browserWindow(window);
        try { await nativeWindow.evaluate(w => { w.show(); w.focus(); }); }
        finally { await nativeWindow.dispose(); }
        return answer(await this.o.handoff(signal) ? '用户已完成交接，请观察当前窗口' : '交接未完成，请根据当前情况向用户说明');
      }
      case 'screenshot': {
        const folder = join(this.o.dataDir, 'electron-test-evidence', this.o.runId);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const path = join(folder, `screenshot-${++this.screenshots}.png`);
        await window.screenshot({ path, timeout, animations: 'disabled' });
        return answer(`截图已保存到执行电脑：${path}`);
      }
      default: {
        if (!input.selector) throw new Error('此操作需要指定 CSS selector');
        const control = window.locator(input.selector);
        if (input.action === 'click') { await control.click({ timeout }); return answer('已点击'); }
        if (input.action === 'fill') { await control.fill(input.value ?? '', { timeout }); return answer('已输入测试数据'); }
        if (input.value === undefined) await control.waitFor({ state: 'visible', timeout });
        else await control.and(window.getByText(input.value, { exact: true })).waitFor({ state: 'visible', timeout });
        return answer('断言通过');
      }
    }
  }

  tool(): ToolDefinition {
    return {
      name: 'electron_test', executionMode: 'sequential', label: '端侧 Electron 应用测试', exposure: 'deferred',
      description: '操作本次任务在执行电脑上启动的独立 Electron 测试实例。open 启动，observe 读取结构，click/fill/assert 用 CSS selector 操作，assert 可附精确预期文本，screenshot 将证据留在本机，login 由用户在测试窗口手动操作。',
      parameters: Type.Object({
        action: Type.Union(['open', 'observe', 'click', 'fill', 'assert', 'screenshot', 'login'].map(action => Type.Literal(action))),
        selector: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        value: Type.Optional(Type.String({ maxLength: 2000 })),
      }),
      execute: async (_id, input: Operation, signal) => {
        if (this.operation) throw new Error('应用测试操作需要依次调用');
        const operation = this.run(input, signal);
        this.operation = operation;
        try { return await operation; }
        finally { this.operation = undefined; }
      },
    } as ToolDefinition;
  }

  private async cleanup() {
    const { app, profile } = this;
    this.app = this.profile = undefined;
    if (app) {
      const kill = setTimeout(() => app.process().kill('SIGKILL'), 12_000);
      try { await app.close(); } catch { app.process().kill('SIGKILL'); }
      finally { clearTimeout(kill); }
    }
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  close() {
    this.closed = true;
    this.closing ??= (async () => {
      await this.operation?.catch(() => {});
      await this.cleanup();
    })();
    return this.closing;
  }
}
