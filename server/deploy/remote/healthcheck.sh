#!/usr/bin/env bash
set -euo pipefail
[[ $(id -un) == pibot ]] || { echo 'Run as pibot: sudo -u pibot bash healthcheck.sh'; exit 1; }
printf '{"action":"health","operation_id":"healthcheck"}' | node /opt/pibot-remote/client.mjs
echo
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
