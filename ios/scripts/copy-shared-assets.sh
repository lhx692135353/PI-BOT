#!/bin/sh
# Copies the shared character spec and the A2UI renderer into the app bundle,
# the same files Android packs as assets. Builds the renderer if it is missing.
set -eu

ROOT="${SRCROOT}/.."
DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"
A2UI="${ROOT}/packages/a2ui"

if [ ! -f "${A2UI}/dist/index.html" ]; then
  # Xcode does not inherit the login shell PATH (nvm, Homebrew).
  export PATH="${PATH}:/opt/homebrew/bin:/usr/local/bin"
  [ -s "${HOME}/.nvm/nvm.sh" ] && . "${HOME}/.nvm/nvm.sh" >/dev/null 2>&1 || true
  if command -v node >/dev/null 2>&1 && [ -d "${ROOT}/node_modules" ]; then
    (cd "${ROOT}" && node packages/a2ui/scripts/build.mjs)
  fi
fi
if [ ! -f "${A2UI}/dist/index.html" ]; then
  echo "error: 缺少 A2UI 渲染器。请在仓库根目录运行 pnpm install && node packages/a2ui/scripts/build.mjs"
  exit 1
fi

mkdir -p "${DEST}/bot-face" "${DEST}/a2ui"
cp "${ROOT}/packages/bot-face/spec.json" "${DEST}/bot-face/spec.json"
for file in index.html renderer.js style.css; do
  cp "${A2UI}/dist/${file}" "${DEST}/a2ui/${file}"
done
