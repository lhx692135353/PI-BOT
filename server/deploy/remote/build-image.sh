#!/usr/bin/env bash
# Run on Linux with libguestfs-tools, qemu-utils and Node/npm. This creates a new output image.
set -euo pipefail
[[ $# == 2 ]] || { echo 'Usage: build-image.sh ubuntu-24.04-server-cloudimg-amd64.img output.qcow2'; exit 1; }
[[ ! -e "$2" ]] || { echo 'Output already exists'; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ -f "$script_dir/../../remote-guest/package-lock.json" ]]
bundle=$(mktemp -d)
trap 'rm -rf "$bundle"' EXIT
mkdir -p "$bundle/pibot-remote/deploy"
cp "$script_dir/../../remote-guest/"*.mjs "$script_dir/../../remote-guest/"*.json "$bundle/pibot-remote/"
cp "$script_dir/install.sh" "$script_dir/desktop-session.sh" "$bundle/pibot-remote/deploy/"
qemu-img create -f qcow2 "$2" "${PI_BOT_IMAGE_SIZE:-16G}"
# Official Noble cloud images use partition 1 for the root filesystem.
virt-resize --expand "${PI_BOT_IMAGE_ROOT_PARTITION:-/dev/sda1}" "$1" "$2"
virt-customize -a "$2" --network --copy-in "$bundle/pibot-remote:/opt" --run-command 'PI_BOT_GUEST_SOURCE=/opt/pibot-remote PI_BOT_IMAGE_BUILD=1 bash /opt/pibot-remote/deploy/install.sh' --run-command 'cloud-init clean --logs --machine-id; rm -f /etc/ssh/ssh_host_*; rm -f /home/pibot/.ssh/authorized_keys'
sha256sum "$2"
