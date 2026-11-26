#!/usr/bin/env bash
set -euo pipefail

# Resolve from the same workspace as install-ci-chromium.sh. npm rebuild at
# the repository root can miss this nested Electron; requiring its entry point
# before installation would instead start an unprotected lazy download.
installer=$(node -e '
  const { createRequire } = require("node:module");
  const path = require("node:path");
  const fromDesktop = createRequire(process.cwd() + "/desktop/package.json");
  process.stdout.write(path.join(path.dirname(fromDesktop.resolve("electron/package.json")), "install.js"));
')

for attempt in 1 2 3; do
  if node "$installer"; then
    break
  fi
  if [[ "$attempt" == 3 ]]; then
    echo '::error::Desktop Electron installation failed after 3 attempts' >&2
    exit 1
  fi
  delay=$((attempt * 10))
  echo "::warning::Desktop Electron installation attempt $attempt failed; retrying in ${delay}s" >&2
  sleep "$delay"
done

# Check the actual file before loading Electron, so verification cannot trigger
# another lazy download outside the retry loop. Do not launch the GUI in CI.
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const fromDesktop = createRequire(process.cwd() + '/desktop/package.json');
const packagePath = fromDesktop.resolve('electron/package.json');
const packageDir = path.dirname(packagePath);
const version = fromDesktop('electron/package.json').version;
const installedVersion = fs.readFileSync(path.join(packageDir, 'dist/version'), 'utf8').trim().replace(/^v/, '');
assert.equal(installedVersion, version, 'Installed Electron version must match the desktop dependency');
const relativePath = fs.readFileSync(path.join(packageDir, 'path.txt'), 'utf8').trim();
assert.ok(relativePath, 'Electron path.txt must not be empty');
const executable = fs.realpathSync(path.join(packageDir, 'dist', relativePath));
assert.ok(fs.statSync(executable).isFile(), 'Electron executable must be a file');
fs.accessSync(executable, fs.constants.X_OK);
assert.equal(fs.realpathSync(fromDesktop('electron')), executable, 'Desktop must resolve the verified executable');
console.log(`Verified desktop Electron ${version}: ${executable}`);
NODE
