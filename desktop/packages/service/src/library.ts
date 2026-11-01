import { toolDescriptor } from "@pi-bot/runtime-contracts";
import { StringDecoder } from 'node:string_decoder';
import { libraryFolder, powerShellArgs, validateWindowsPath, windowsHelper } from './windows.js';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { commandShell } from './platform.js';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { withLibraryMutation } from './mutation-lock.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const READ_LIMIT = 256 * 1024;
const PREVIEW_TEXT_LIMIT = 512 * 1024;
const PREVIEW_IMAGE_LIMIT = 4 * 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.Trash']);
const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export class OutsideError extends Error {
  constructor(readonly path: string) { super(`路径 ${path} 在资料库以外。需要先调用 request_outside_access 说明原因并等待用户批准。`); }
}
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

export async function libraryDir(root: string, slug: string) {
  if (!SLUG.test(slug)) throw new Error('资料库名称无效');
  await mkdir(root, { recursive: true, mode: 0o755 });
  const dir = join(root, libraryFolder(slug));
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('资料库目录不安全');
  return realpath(dir);
}

/** Resolves paths for one run: the bot library plus any outside paths the user approved. */
export class Sandbox {
  private roots: string[];
  private grants: {path: string; access: 'read' | 'write' | 'execute'}[] = [];
  constructor(readonly root: string, approved: string[] = [], private authorizeSaved?: (path: string, access: 'read') => Promise<boolean>) { this.roots = [root, ...approved]; }
  get allowed() { return [...this.roots]; }
  expand(input: string) {
    const value = input || '.';
    if (process.platform === 'win32') validateWindowsPath(value);
    if (value === '~' || (value.startsWith('~/') || value.startsWith('~\\'))) return join(homedir(), value.slice(1));
    return isAbsolute(value) ? resolve(value) : resolve(this.root, value);
  }
  /** Follows symlinks on the existing part of the path so links cannot escape the allowed roots. */
  async canonical(input: string) {
    const full = this.expand(input);
    let existing = full;
    while (!(await lstat(existing).catch(() => null))) {
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const real = join(await realpath(existing), relative(existing, full));
    return real;
  }
  async resolve(input: string, options: { mustExist?: boolean; access?: 'read' | 'write' | 'execute' } = {}) {
    const real = await this.canonical(input), access = options.access ?? 'read';
    if (!this.roots.some(r => inside(r, real)) && !this.grants.some(g => g.access === access && inside(g.path,real)) &&
        !(access === 'read' && await this.authorizeSaved?.(real,access))) throw new OutsideError(real);
    if (options.mustExist && !(await lstat(real).catch(() => null))) throw new Error(`文件不存在：${this.display(real)}`);
    return real;
  }
  async allow(input: string, access?: 'read' | 'write' | 'execute') {
    const full = this.expand(input);
    if (full === parse(full).root || full === resolve(homedir())) throw new Error('不能授权整个磁盘或整个主目录，请指定更具体的路径');
    const real = await realpath(full).catch(() => full);
    if (real === parse(real).root || real === resolve(homedir())) throw new Error('不能授权整个磁盘或整个主目录，请指定更具体的路径');
    if (access) this.grants.push({path:real,access});
    else if (!this.roots.includes(real)) this.roots.push(real);
    return real;
  }
  display(path: string) { return inside(this.root, path) ? relative(this.root, path).split(sep).join('/') || '.' : path; }
}

export interface Entry { name: string; type: 'dir' | 'file'; size: number; modified: string }
export async function listDir(path: string): Promise<Entry[]> {
  const names = await readdir(path);
  const entries: Entry[] = [];
  for (const name of names) {
    if (name === '.DS_Store') continue;
    const s = await stat(join(path, name)).catch(() => null);
    if (s) entries.push({ name, type: s.isDirectory() ? 'dir' : 'file', size: s.size, modified: s.mtime.toISOString() });
  }
  return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)).slice(0, 1000);
}
function looksBinary(buffer: Buffer) { return buffer.subarray(0, 8000).includes(0); }

/** Read-only library access for phones; never leaves the bot library. */
export async function previewList(root: string, slug: string, path: string) {
  const sandbox = new Sandbox(await libraryDir(root, slug));
  const dir = await sandbox.resolve(path || '.', { mustExist: true });
  if (!(await stat(dir)).isDirectory()) throw new Error('不是目录');
  return { path: sandbox.display(dir) === '.' ? '' : sandbox.display(dir), entries: await listDir(dir) };
}
export async function previewRead(root: string, slug: string, path: string) {
  const sandbox = new Sandbox(await libraryDir(root, slug));
  const file = await sandbox.resolve(path, { mustExist: true });
  const s = await stat(file);
  if (!s.isFile()) throw new Error('不是文件');
  const mime = IMAGES[extname(file).toLowerCase()];
  const base = { path: sandbox.display(file), name: basename(file), size: s.size, modified: s.mtime.toISOString() };
  if (mime) return s.size > PREVIEW_IMAGE_LIMIT ? { ...base, kind: 'binary' as const } : { ...base, kind: 'image' as const, mime, base64: (await readFile(file)).toString('base64') };
  const buffer = await readFile(file).then(b => b.subarray(0, PREVIEW_TEXT_LIMIT));
  if (looksBinary(buffer)) return { ...base, kind: 'binary' as const };
  return { ...base, kind: 'text' as const, content: buffer.toString('utf8'), truncated: s.size > PREVIEW_TEXT_LIMIT };
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], details: {} });
function shellPath() {
  if (process.platform === 'win32') return process.env.Path || process.env.PATH || '';
  const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set([...(process.env.PATH ?? '').split(':').filter(Boolean), ...extra])].join(':');
}
export function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<{ exit_code: number | null; timed_out: boolean; output: string }>((done, reject) => {
    if (signal?.aborted) return reject(new Error('CANCELLED'));
    const windows = process.platform === 'win32';
    const env: NodeJS.ProcessEnv = { ...process.env, PI_BOT_LIBRARY: cwd };
    if (!windows) env.PATH = shellPath();
    const shell = commandShell();
    const child = spawn(windows ? windowsHelper() : shell, windows ? ['run', shell, ...powerShellArgs(command)] : ['-c', command], { cwd, env, detached: !windows, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    if (!windows) child.stdin.end();
    let output = '', settled = false, timedOut = false;
    const stop = () => {
      if (windows) { child.stdin.end(); return; }
      try { process.kill(-child.pid!, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 1500).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const append = (text: string) => { output = (output + text).slice(-30000); };
    child.stdout.on('data', (b: Buffer) => append(decoders[0].write(b)));
    child.stderr.on('data', (b: Buffer) => append(decoders[1].write(b)));
    const finish = (error?: Error, code?: number | null) => {
      if (settled) return; settled = true;
      for (const decoder of decoders) append(decoder.end()); clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (error) reject(new Error('命令无法启动'));
      else if (signal?.aborted) reject(new Error('CANCELLED'));
      else done({ exit_code: code ?? null, timed_out: timedOut, output });
    };
    child.once('error', e => finish(e));
    child.once('close', code => finish(undefined, code));
  });
}

async function walk(dir: string, visit: (file: string) => Promise<boolean>, budget = { files: 5000 }) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (SKIP.has(entry.name) || budget.files <= 0) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!(await walk(path, visit, budget))) return false; }
    else if (entry.isFile()) { budget.files--; if (!(await visit(path))) return false; }
  }
  return true;
}
function globRegex(glob: string) {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*') + '$');
}

export interface ToolHooks {
  /** Resolves true when the user approves access to a path outside the library. */
  requestOutside(path: string, reason: string, signal?: AbortSignal, access?: 'read' | 'write' | 'execute', resourceType?: 'file' | 'directory'): Promise<boolean | 'saved'>;
}
export function libraryTools(sandbox: Sandbox, hooks: ToolHooks): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'list_files', label: '查看目录', description: '列出目录内容。路径默认是资料库根目录；资料库以外的路径需要先获批准。',
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      execute: async (_id, args: any) => {
        const dir = await sandbox.resolve(args.path ?? '.', { mustExist: true });
        const entries = await listDir(dir);
        return text(entries.length ? entries.map(e => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}${e.type === 'file' ? ` (${e.size} B)` : '/'}`).join('\n') : '（空目录）');
      },
    },
    {
      name: 'read_file', label: '读取文件', description: '读取 UTF-8 文本文件，最多 256KB；可用 offset/limit 按行分段读取。',
      parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })) }),
      execute: async (_id, args: any) => {
        const file = await sandbox.resolve(args.path, { mustExist: true });
        const s = await stat(file);
        if (!s.isFile()) throw new Error('不是文件');
        const buffer = (await readFile(file)).subarray(0, args.offset || args.limit ? undefined : READ_LIMIT);
        if (looksBinary(buffer)) throw new Error('这是二进制文件，不能按文本读取');
        let content = buffer.toString('utf8');
        if (args.offset || args.limit) {
          const lines = content.split('\n'), start = (args.offset ?? 1) - 1;
          content = lines.slice(start, start + (args.limit ?? 2000)).join('\n');
        }
        if (content.length > READ_LIMIT) content = content.slice(0, READ_LIMIT) + '\n…（已截断，请用 offset/limit 分段读取）';
        return text(content);
      },
    },
    {
      name: 'search_files', label: '搜索文件', description: '在目录中按正则搜索文件内容，可用 glob 过滤文件名（如 **/*.md）。返回最多 100 条匹配。',
      parameters: Type.Object({ pattern: Type.String({ minLength: 1, maxLength: 500 }), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String({ maxLength: 200 })) }),
      execute: async (_id, args: any, signal) => {
        const dir = await sandbox.resolve(args.path ?? '.', { mustExist: true });
        let regex: RegExp;
        try { regex = new RegExp(args.pattern, 'i'); } catch { regex = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
        const filter = args.glob ? globRegex(args.glob) : null;
        const hits: string[] = [];
        await walk(dir, async file => {
          if (signal?.aborted) return false;
          const rel = relative(dir, file).split(sep).join('/');
          if (filter && !filter.test(rel) && !filter.test(basename(file))) return true;
          if (regex.test(rel)) hits.push(`${rel}（文件名匹配）`);
          const s = await stat(file).catch(() => null);
          if (!s || s.size > 1_000_000) return hits.length < 100;
          const buffer = await readFile(file).catch(() => null);
          if (!buffer || looksBinary(buffer)) return hits.length < 100;
          buffer.toString('utf8').split('\n').forEach((line, i) => { if (hits.length < 100 && regex.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`); });
          return hits.length < 100;
        });
        return text(hits.length ? hits.join('\n') : '没有匹配');
      },
    },
    {
      name: 'write_file', label: '写入文件', description: '创建或覆盖 UTF-8 文本文件，自动创建上级目录。产出的文件默认保存在资料库内。',
      parameters: Type.Object({ path: Type.String(), content: Type.String({ maxLength: 2_000_000 }) }),
      execute: async (_id, args: any) => {
        const file = await sandbox.resolve(args.path, { access: 'write' });
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${randomUUID()}.tmp`;
        await writeFile(tmp, args.content);
        await rename(tmp, file);
        return text(`已写入 ${sandbox.display(file)}（${Buffer.byteLength(args.content)} 字节）`);
      },
    },
    {
      name: 'edit_file', label: '修改文件', description: '把文件中的 old_text 精确替换为 new_text。old_text 必须唯一，除非 replace_all 为 true。',
      parameters: Type.Object({ path: Type.String(), old_text: Type.String({ minLength: 1 }), new_text: Type.String(), replace_all: Type.Optional(Type.Boolean()) }),
      execute: async (_id, args: any) => {
        const file = await sandbox.resolve(args.path, { mustExist: true, access: 'write' });
        const content = await readFile(file, 'utf8');
        const count = content.split(args.old_text).length - 1;
        if (!count) throw new Error('找不到 old_text，请先读取文件确认原文');
        if (count > 1 && !args.replace_all) throw new Error(`old_text 出现了 ${count} 次，请提供更多上下文使其唯一，或设置 replace_all`);
        await writeFile(file, args.replace_all ? content.split(args.old_text).join(args.new_text) : content.replace(args.old_text, () => args.new_text));
        return text(`已修改 ${sandbox.display(file)}（${args.replace_all ? count : 1} 处）`);
      },
    },
    {
      name: 'run_command', label: '执行命令', description: `在执行电脑上用 ${commandShell()} 执行命令，默认工作目录是资料库。返回退出码和最后 30000 个字符输出。不要执行破坏性或需要交互的命令。`,
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 20000 }), cwd: Type.Optional(Type.String()), timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })) }),
      execute: async (_id, args: any, signal) => {
        const cwd = await sandbox.resolve(args.cwd ?? '.', { mustExist: true, access: 'execute' });
        const r = await runCommand(args.command, cwd, (args.timeout_seconds ?? 120) * 1000, signal);
        return text(JSON.stringify(r));
      },
    },
    {
      name: 'request_outside_access', label: '申请访问', description: '申请资料库以外的文件或目录访问；access 默认为 read（可选择 write 或 execute）。读取授权不含写入或命令；只有读取权限可以被用户记住，其他权限仅本次任务有效。',
      parameters: Type.Object({ path: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1, maxLength: 1000 }), access: Type.Optional(Type.Union([Type.Literal('read'),Type.Literal('write'),Type.Literal('execute')])) }),
      execute: async (_id, args: any, signal) => {
        const full = await sandbox.canonical(args.path), access = args.access ?? 'read';
        if (full === parse(full).root || full === resolve(homedir())) throw new Error('请指定具体资源，不能授权整个磁盘或主目录');
        try { await sandbox.resolve(full, { access }); return text(`已可${access}访问 ${full}，无需申请`); } catch (e) { if (!(e instanceof OutsideError)) throw e; }
        const info = await stat(full).catch(() => null);
        if (access === 'read' && !info) throw new Error('读取授权需要已存在的文件或目录');
        const approved = await hooks.requestOutside(full, args.reason, signal, access, info?.isDirectory() ? 'directory' : 'file');
        if (!approved) return text(`用户拒绝了访问 ${full}。请不要再访问该路径，改用其他方式或向用户说明。`);
        if (approved !== 'saved') await sandbox.allow(full,access);
        return text(`用户已批准 ${access} 访问 ${full}（${approved === 'saved' ? '已保存，每次使用仍会校验，可在设置中撤销' : '本次任务有效'}）`);
      },
    },
  ] as ToolDefinition[];
  return tools.map(tool => toolDescriptor(tool.name)?.effect === 'write' ? {
    ...tool,
    execute: (id, args, signal, update, ctx) => withLibraryMutation(sandbox.root, signal, () => tool.execute(id, args, signal, update, ctx)),
  } : tool);
}

/** Probe existing resources without mkdir, shell execution or outside-library access. */
export async function preflightLibrary(root: string, slug: string, paths: string[]) {
  if (!SLUG.test(slug) || paths.length > 20) return {available:false};
  try {
    const base = await realpath(root), folder = join(base,libraryFolder(slug));
    if ((await lstat(folder)).isSymbolicLink()) return {available:false};
    const library = await realpath(folder);
    if (!inside(base,library)) return {available:false};
    const sandbox = new Sandbox(library);
    for (const path of paths) await sandbox.resolve(path,{mustExist:true});
    return {available:true};
  } catch { return {available:false}; }
}
