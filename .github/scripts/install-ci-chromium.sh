#!/usr/bin/env bash
set -euo pipefail

node node_modules/playwright/cli.js install --with-deps --no-shell chromium
if [[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] &&
   [[ $(< /proc/sys/kernel/apparmor_restrict_unprivileged_userns) == 1 ]]; then
  browser=$(node -p "require('playwright').chromium.executablePath()")
  electron=$(node -p "require(require('node:module').createRequire(process.cwd() + '/desktop/package.json').resolve('electron'))")
  printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile pibot-ci-chromium "%s" flags=(unconfined) {\n  userns,\n}\nprofile pibot-ci-electron "%s" flags=(unconfined) {\n  userns,\n}\n' "$browser" "$electron" | sudo apparmor_parser -r
fi
