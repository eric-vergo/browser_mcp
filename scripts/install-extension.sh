#!/usr/bin/env bash
# Sideload-install the Docs Browser extension into VSCode's user extensions dir.
# Re-run after changing the extension's source (the installed copy is a snapshot).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./extension/package.json').version")"
NAME="local.docs-browser-extension-${VERSION}"
DEST="$HOME/.vscode/extensions/${NAME}"

npm -w extension run build

rm -rf "$DEST"
mkdir -p "$DEST/node_modules"
cp extension/package.json "$DEST/"
cp -R extension/dist "$DEST/dist"
cp -R extension/media "$DEST/media"
# The Playwright sidecar (dist/sidecar/main.js) keeps playwright-core EXTERNAL, so it must be
# resolvable at runtime. playwright-core is self-contained (no deps); copy it alongside.
cp -R node_modules/playwright-core "$DEST/node_modules/playwright-core"

echo "Installed ${NAME} -> ${DEST}"
echo "Chromium uses the shared ~/Library/Caches/ms-playwright cache (already present)."
echo "Run 'Developer: Reload Window' in VSCode to activate; the MCP server binds 127.0.0.1:8765."
