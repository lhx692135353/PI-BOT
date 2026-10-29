import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants, copyFile, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
const exec = promisify(execFile);
export const LINUX_MARKER = 'pi-bot-linux-tar-v1\n';
// Validate every member BEFORE extracting; links cannot escape the bundle or be
// used as ancestors. Python is a runtime prerequisite, never installed for users.
export const EXTRACT_SCRIPT = String.raw`
import tarfile, pathlib, posixpath, sys
archive, destination = sys.argv[1:]
root = 'Pi Bot-linux-x64'
with tarfile.open(archive, 'r:gz') as t:
    members = t.getmembers()
    if len(members) > 100000 or sum(m.size for m in members) > 4*1024**3:
        raise ValueError('Archive exceeds extraction limits')
    names, links = set(), set()
    for m in members:
        name = m.name.rstrip('/')
        parts = pathlib.PurePosixPath(name).parts
        if not parts or name != str(pathlib.PurePosixPath(name)) or parts[0] != root or name.startswith('/') or '..' in parts or name in names:
            raise ValueError('Unsafe or duplicate archive path')
        names.add(name)
        if not (m.isfile() or m.isdir() or m.issym()):
            raise ValueError('Unsupported archive member')
        if m.mode & 0o6000:
            raise ValueError('Privileged archive mode')
        if m.issym():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), m.linkname))
            if m.linkname.startswith('/') or not target.startswith(root + '/'):
                raise ValueError('Unsafe symbolic link')
            links.add(name)
    for name in names:
        if any(str(p) in links for p in pathlib.PurePosixPath(name).parents):
            raise ValueError('Symbolic link ancestor')
    # No device nodes, hardlinks, link ancestors, absolute paths or traversal.
    for m in members:
        m.uid = m.gid = 0
        m.uname = m.gname = ''
        m.mode &= 0o755
        t.extract(m, destination, set_attrs=True, numeric_owner=False)
`;
export async function linuxInstallRoot(executable: string): Promise<string> {
  const root = await realpath(dirname(executable));
  let marker = '';
  try { marker = await readFile(join(root, '.pi-bot-linux-tar'), 'utf8'); } catch { /* unmarked/unsupported install */ }
  if (marker !== LINUX_MARKER) throw new Error('此安装格式不支持原位更新，请手动安装官方 Linux x64 tar.gz 桌面包');
  if (basename(executable) !== 'Pi Bot') throw new Error('Linux 启动路径无效');
  if ((await stat(root)).uid !== process.getuid?.()) throw new Error('安装目录不属于当前用户，请手动更新；不自动提权');
  try {
    await access(root, constants.W_OK | constants.X_OK);
    await access(dirname(root), constants.W_OK | constants.X_OK);
  } catch { throw new Error('安装目录或父目录不可写，请手动更新或将官方 tar.gz 桌面包安装到用户可写目录；不自动提权'); }
  return root;
}
export async function checkLinuxDataPaths(root: string, paths: string[]) {
  for (const path of paths) {
    let target = resolve(path);
    try { target = await realpath(target); } catch { /* may not exist yet */ }
    const rel = relative(root, target);
    if (rel === '' || (!rel.startsWith('../') && rel !== '..')) throw new Error('资料目录位于安装目录内，请先迁移至安装目录之外再更新');
  }
}
export async function prepareLinuxUpdate(archive: string, executable: string, helper: string, node: string, parentPid: number): Promise<void> {
  const root = await linuxInstallRoot(executable);
  // Same filesystem for rename. Existing installation is untouched during staging.
  const staging = await mkdtemp(join(dirname(root), '.pi-bot-update-'));
  let handedOff = false;
  try {
    await exec('python3', ['-c', EXTRACT_SCRIPT, archive, staging], { timeout: 120000, maxBuffer: 1024 * 1024 });
    const next = join(staging, 'Pi Bot-linux-x64');
    if (await readFile(join(next, '.pi-bot-linux-tar'), 'utf8') !== LINUX_MARKER) throw new Error('Linux 更新包缺少安装标识');
    for (const file of ['Pi Bot', 'resources/runtime/bin/node', 'resources/app.asar']) {
      if (!(await stat(join(next, file))).isFile()) throw new Error('Linux 更新包不完整');
    }
    await access(join(next, 'Pi Bot'), constants.X_OK);
    const copy = join(staging, 'apply.cjs'); await copyFile(helper, copy);
    const child = spawn(node, [copy, root, staging, String(parentPid)], { detached: true, stdio: 'ignore', cwd: staging });
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
    child.unref(); handedOff = true;
  } catch (e) {
    throw new Error(`Linux 更新准备失败（未替换旧版）：${e instanceof Error ? e.message : e}。需要 python3 以及安装目录和父目录写入权限；不自动提权。`);
  } finally { if (!handedOff) await rm(staging, { recursive: true, force: true }); }
}
