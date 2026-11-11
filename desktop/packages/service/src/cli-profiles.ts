import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliProfile { id: string; label: string }
export interface CliProfileScan {
  cursor: { installed: boolean; profiles: CliProfile[] };
  codex: { installed: boolean; profiles: CliProfile[] };
}

function installed(bin: string) {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(finder, [bin], { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

function extraCursorProfiles(dataDir: string) {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, "cursor-profiles.json"), "utf8")) as { profiles?: { label?: string; dir?: string }[] };
    return (parsed.profiles ?? []).flatMap(profile => profile.dir ? [{ id: profile.dir, label: profile.label || profile.dir }] : []);
  } catch {
    return [];
  }
}

/** Codex profiles are `~/.codex/<name>.config.toml`. Cursor profiles are config directories. */
export function scanCliProfiles(dataDir: string, env: NodeJS.ProcessEnv = process.env): CliProfileScan {
  const cursorHome = join(homedir(), ".cursor");
  const cursorProfiles: CliProfile[] = [];
  const seen = new Set<string>();
  for (const profile of [{ id: env.CURSOR_CONFIG_DIR || cursorHome, label: "默认" }, ...extraCursorProfiles(dataDir)]) {
    if (!profile.id || seen.has(profile.id) || !existsSync(profile.id)) continue;
    seen.add(profile.id);
    cursorProfiles.push(profile);
  }
  const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
  const codexProfiles: CliProfile[] = [{ id: "default", label: "默认" }];
  if (existsSync(codexHome)) {
    for (const name of readdirSync(codexHome)) {
      const match = name.match(/^([A-Za-z0-9_-]+)\.config\.toml$/);
      if (match) codexProfiles.push({ id: match[1], label: match[1] });
    }
  }
  return {
    cursor: { installed: installed(env.PI_BOT_CURSOR_BIN || "agent"), profiles: cursorProfiles },
    codex: { installed: installed(env.PI_BOT_CODEX_BIN || "codex"), profiles: codexProfiles },
  };
}
