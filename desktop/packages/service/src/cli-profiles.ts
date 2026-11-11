import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export interface CliProfile { id: string; label: string }
export interface CliProfileScan {
  cursor: { installed: boolean; profiles: CliProfile[] };
  codex: { installed: boolean; profiles: CliProfile[] };
}

let loginPathCache: { key: string; dirs: string[] } | undefined;

/** Directories a Dock-launched app should search. The process PATH misses Homebrew, npm, and the login shell. */
export function cliSearchDirs(env: NodeJS.ProcessEnv = process.env) {
  const listed = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  if (process.platform === "win32") return [...new Set(listed)];
  const home = env.HOME || homedir();
  const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", join(home, ".local/bin"), join(home, ".npm-global/bin")];
  return [...new Set([...loginPath(env), ...listed, ...extra])];
}

function loginPath(env: NodeJS.ProcessEnv) {
  if (env.NODE_TEST_CONTEXT || env.PI_BOT_SKIP_LOGIN_PATH === "1") return [];
  const shell = env.SHELL && existsSync(env.SHELL) ? env.SHELL : "/bin/zsh";
  const key = `${shell}\0${env.HOME || homedir()}`;
  if (loginPathCache?.key === key) return loginPathCache.dirs;
  let stdout = "";
  try {
    const result = spawnSync(shell, ["-lc", "printf %s \"$PATH\""], { encoding: "utf8", timeout: 2000, windowsHide: true, env });
    stdout = result.status === 0 ? result.stdout : "";
  } catch {
    stdout = "";
  }
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  const dirs = line.includes(delimiter) ? line.split(delimiter).filter(Boolean) : [];
  if (env === process.env) loginPathCache = { key, dirs };
  return dirs;
}

function which(bin: string, env: NodeJS.ProcessEnv) {
  const finder = process.platform === "win32" ? "where" : "which";
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const result = spawnSync(finder, [bin], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...env, [pathKey]: cliSearchDirs(env).join(delimiter) },
  });
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
}

/** Absolute CLI binary, or undefined when this app cannot see it. An explicit override is not replaced by a search. */
export function resolveCliBin(name: "codex" | "agent", env: NodeJS.ProcessEnv = process.env) {
  const override = name === "codex" ? env.PI_BOT_CODEX_BIN : env.PI_BOT_CURSOR_BIN;
  if (override) return isAbsolute(override) ? (existsSync(override) ? override : undefined) : which(override, env);
  return which(name, env);
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
    cursor: { installed: !!resolveCliBin("agent", env), profiles: cursorProfiles },
    codex: { installed: !!resolveCliBin("codex", env), profiles: codexProfiles },
  };
}
