#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=:99
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp &
xpid=$!
trap 'kill $(jobs -pr) 2>/dev/null || true' EXIT TERM INT
for attempt in $(seq 1 50); do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep .2; done
dbus-run-session -- startxfce4 &
x11vnc -display "$DISPLAY" -localhost -rfbport 5901 -forever -shared -nopw -quiet &
x11vnc -display "$DISPLAY" -localhost -rfbport 5902 -forever -shared -viewonly -nopw -quiet &
wait -n
