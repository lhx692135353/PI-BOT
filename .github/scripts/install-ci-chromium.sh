#!/usr/bin/env bash
set -euo pipefail

node node_modules/playwright/cli.js install --with-deps --no-shell chromium
# BrowserTest channel:'chrome' needs Google Chrome Stable, not Playwright Chromium.
# ubuntu-24.04-arm runners do not ship it; install when Playwright provides a build.
if ! node node_modules/playwright/cli.js install --with-deps chrome; then
  echo '::warning::Google Chrome Stable unavailable on this runner; chrome-channel smoke will be skipped if the binary is missing'
fi
if [[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] &&
   [[ $(< /proc/sys/kernel/apparmor_restrict_unprivileged_userns) == 1 ]]; then
  browser=$(node -p "require('playwright').chromium.executablePath()")
  electron=$(node -e '
    // Electron may announce a lazy download while resolving its executable.
    console.log = console.error;
    const fromDesktop = require("node:module").createRequire(process.cwd() + "/desktop/package.json");
    process.stdout.write(require("node:fs").realpathSync(fromDesktop("electron")));
  ')
  load_profile() {
    printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile %s "%s" flags=(unconfined) {\n  userns,\n}\n' "$1" "$2" |
      sudo apparmor_parser -r
  }
  load_profile pibot-ci-chromium "$browser"
  load_profile pibot-ci-electron "$electron"
  if [[ -x /opt/google/chrome/chrome ]]; then
    load_profile pibot-ci-chrome /opt/google/chrome/chrome
  fi
fi
