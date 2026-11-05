#!/bin/sh
# Started as root only to take ownership of a freshly created host-mounted cloud library; always runs as node.
set -e
if [ "$(id -u)" = 0 ]; then
  root="${PI_BOT_LOCAL_WORK_ROOT:-/data/workspaces}"
  mkdir -p "$root"
  chown node:node "$root"
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
