#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
device=$(xcrun simctl list devices available -j | python3 -c 'import sys,json; d=json.load(sys.stdin); print(next(x["udid"] for a in d["devices"].values() for x in a if x["name"].startswith("iPhone")))')
xcrun simctl boot "$device" 2>/dev/null || true
xcrun simctl bootstatus "$device" -b
trap 'xcrun simctl io "$device" screenshot build/math-simulator.png || true' EXIT
xcrun simctl install "$device" build/Build/Products/Debug-iphonesimulator/PiBot.app
container=$(xcrun simctl get_app_container "$device" dev.pibot.ios data)
xcrun simctl launch "$device" dev.pibot.ios --math-smoke
for attempt in $(seq 1 45); do
  if [ -f "$container/Documents/math-smoke.json" ]; then
    cp "$container/Documents/math-smoke.json" build/math-smoke.json
    cat "$container/Documents/math-smoke.json"
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("ok") and d.get("clipboard_ok"), d' "$container/Documents/math-smoke.json"
    exit 0
  fi
  sleep 2
done
echo "Native math smoke test did not return a result" >&2
exit 1
