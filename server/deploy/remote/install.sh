#!/usr/bin/env bash
# Run from the repository or the prepared image bundle. Requires administrator privileges.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo'; exit 1; }
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 && $(dpkg --print-architecture) == amd64 ]] || { echo 'Supported image: Ubuntu 24.04 LTS amd64'; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
guest_dir=${PI_BOT_GUEST_SOURCE:-"$script_dir/../../remote-guest"}
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl xz-utils openssh-server qemu-guest-agent cloud-init xfce4 dbus-x11 xvfb x11vnc xdotool xclip scrot x11-utils fonts-noto-cjk
node_version=${PI_BOT_NODE_VERSION:-24.21.0}
if [[ ! -x /usr/local/bin/node ]] || [[ $(/usr/local/bin/node -p 'process.versions.node.split(".")[0]') != 24 ]]; then
 task_dir=$(mktemp -d)
 trap 'rm -rf "$task_dir"' EXIT
 curl -fsSL "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz" -o "$task_dir/node.tar.xz"
 curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$task_dir/sums"
 expected=$(awk -v name="node-v$node_version-linux-x64.tar.xz" '$2==name {print $1}' "$task_dir/sums")
 [[ -n "$expected" ]]
 echo "$expected  $task_dir/node.tar.xz" | sha256sum -c -
 tar -xJf "$task_dir/node.tar.xz" -C /usr/local --strip-components=1
fi
id pibot >/dev/null 2>&1 || useradd --create-home --shell /bin/bash pibot
install -d -m 755 /opt/pibot-remote
if [[ $(realpath "$guest_dir") != /opt/pibot-remote ]]; then cp "$guest_dir/"*.mjs "$guest_dir/package.json" "$guest_dir/package-lock.json" /opt/pibot-remote/; fi
cd /opt/pibot-remote
npm ci --omit=dev
PLAYWRIGHT_BROWSERS_PATH=/opt/pibot-remote/browsers npx playwright install --with-deps chromium
chmod -R a+rX /opt/pibot-remote
install -d -o pibot -g pibot -m 700 /home/pibot/workspaces
install -m 755 "$script_dir/desktop-session.sh" /opt/pibot-remote/desktop-session.sh
cat > /etc/systemd/system/pibot-desktop.service <<'UNIT'
[Unit]
Description=Pi Bot private virtual desktop
After=network.target
[Service]
User=pibot
Environment=HOME=/home/pibot
ExecStart=/opt/pibot-remote/desktop-session.sh
Restart=always
RestartSec=3
KillMode=control-group
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/pibot-remote.service <<'UNIT'
[Unit]
Description=Pi Bot remote operation component
After=pibot-desktop.service
Requires=pibot-desktop.service
[Service]
User=pibot
Environment=HOME=/home/pibot
Environment=DISPLAY=:99
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/pibot-remote/browsers
Environment=PI_BOT_GUEST_ROOT=/home/pibot/workspaces
ExecStart=/usr/local/bin/node /opt/pibot-remote/runtime.mjs
Restart=always
RestartSec=3
KillMode=control-group
[Install]
WantedBy=multi-user.target
UNIT
# Ubuntu's unprivileged userns restriction needs a profile for the pinned Chromium.
# Keep Chromium's own sandbox enabled; grant this executable user namespaces.
chromium_bin=$(PLAYWRIGHT_BROWSERS_PATH=/opt/pibot-remote/browsers node --input-type=module -e "import {chromium} from 'playwright';process.stdout.write(chromium.executablePath())")
cat > /etc/apparmor.d/pibot-chromium <<PROFILE
abi <abi/4.0>,
include <tunables/global>
profile pibot-chromium "$chromium_bin" flags=(unconfined) {
 userns,
}
PROFILE
if [[ ${PI_BOT_IMAGE_BUILD:-0} != 1 ]]; then
 apparmor_parser -r /etc/apparmor.d/pibot-chromium
 systemctl daemon-reload
 systemctl enable --now ssh pibot-desktop pibot-remote
else
 systemctl enable ssh pibot-desktop pibot-remote
fi
printf '%s\n' 'Installed. Add an SSH key for pibot, then run healthcheck.sh.'
