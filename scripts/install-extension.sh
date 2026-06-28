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
mkdir -p "$DEST"
cp extension/package.json "$DEST/"
cp -R extension/dist "$DEST/dist"
cp -R extension/media "$DEST/media"

echo "Installed ${NAME} -> ${DEST}"
echo "Run 'Developer: Reload Window' in VSCode to activate."
