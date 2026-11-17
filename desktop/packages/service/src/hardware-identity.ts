import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export function hardwareHash(platform: string, raw: string): string | undefined {
  const id = raw.trim().toLowerCase();
  if (!/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(id) || /^(?:0+|f+)$/.test(id.replaceAll("-",""))) return;
  return 'v1:' + createHash('sha256').update(`pi-bot:hardware:v1:${platform}:${id}`).digest('hex');
}
export interface HardwareProbe {
  run(command:string,args:string[]):Promise<string>;
  read(path:string):Promise<string>;
}
const systemProbe:HardwareProbe = {
  run:async(command,args)=>(await execute(command,args,{timeout:5000,maxBuffer:65536})).stdout,
  read:path=>readFile(path,'utf8'),
};
/** No hostname/random fallback: failures preserve ordinary public-key registration. */
export async function hardwareFingerprint(platform = process.platform, probe:HardwareProbe = systemProbe): Promise<string | undefined> {
  try {
    let raw: string | undefined;
    if (platform === 'darwin') {
      const stdout = await probe.run('/usr/sbin/ioreg',['-rd1','-c','IOPlatformExpertDevice']);
      raw = stdout.match(/"IOPlatformUUID"\s*=\s*"([a-f0-9-]+)"/i)?.[1];
    } else if (platform === 'linux') {
      for (const path of ['/sys/class/dmi/id/product_uuid','/etc/machine-id']) {
        try { raw = await probe.read(path); if (hardwareHash(platform,raw)) break; } catch { /* Try next OS identifier. */ }
      }
    } else if (platform === 'win32') {
      const stdout = await probe.run('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-CimInstance Win32_ComputerSystemProduct).UUID']);
      raw = stdout.trim();
    }
    return raw ? hardwareHash(platform,raw) : undefined;
  } catch { return undefined; }
}
