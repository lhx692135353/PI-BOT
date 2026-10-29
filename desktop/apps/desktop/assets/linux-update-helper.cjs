// Runs on bundled Node after the parent Electron and its owned service exit.
// Arguments are generated in the trusted main process, never by the renderer.
const { rename, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function launch(executable, cwd) {
  const child = spawn(executable, [], { cwd, detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
  child.unref();
}
async function apply(root, staging, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error('Invalid parent pid');
  const backup = `${root}.backup-${Date.now()}`;
  let stopped = false;
  for (let i = 0; i < 1200; i++) {
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { stopped = true; break; } throw e; }
    await delay(100);
  }
  if (!stopped) throw new Error('Client did not exit; original installation untouched');
  await rename(root, backup);
  try {
    await rename(join(staging, 'Pi Bot-linux-x64'), root);
    await launch(join(root, 'Pi Bot'), root);
  } catch (error) {
    // Preserve failed new bytes for inspection; restore and restart the old app.
    try { await rename(root, join(staging, 'failed-install')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await rename(backup, root);
    await launch(join(root, 'Pi Bot'), root);
    throw error;
  }
  await rm(staging, { recursive: true, force: true });
  // Backup deliberately retained; no claims of rollback after app startup.
}
if (require.main === module) {
  const [root, staging, pid] = process.argv.slice(2);
  apply(root, staging, Number(pid)).catch(async error => {
    await writeFile(join(staging, 'update-error.txt'), String(error)).catch(() => {});
    process.exitCode = 1;
  });
}
module.exports = { apply };
