#!/usr/bin/env bash
# Build Hermes UI and package ui/dist into a signed .spkg manifest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI="$ROOT/ui"
VERSION="${HERMES_VERSION:-$(node -p "require('$UI/package.json').version")}"
OUTPUT="${HERMES_PACKAGE_OUTPUT:-$UI/hermes-${VERSION}.spkg}"

if ! command -v spacekit >/dev/null 2>&1; then
  echo "spacekit CLI not found. Install/build spacekit-cli first." >&2
  exit 1
fi

echo "→ Building Hermes UI (v${VERSION})..."
if [[ ! -x "$UI/node_modules/.bin/vite" ]]; then
  echo "→ Installing Hermes UI dependencies..."
  (cd "$UI" && npm install)
fi
(cd "$UI" && npm run build)

if [[ ! -f "$UI/dist/index.html" ]]; then
  echo "Build failed: $UI/dist/index.html not found." >&2
  exit 1
fi

echo "→ Packaging ${OUTPUT} ..."
spacekit app package "$UI/dist" \
  --name hermes-messenger-app \
  --entry index.html \
  --version "$VERSION" \
  --description "Hermes is the native SpaceKit Messenger app." \
  --category social \
  --keywords "messaging,chat,social,spacekit" \
  -o "$OUTPUT"

echo ""
echo "✅ Package ready: ${OUTPUT}"
echo "   Files dir:      ${OUTPUT}.files"
echo ""
echo "Next: ./scripts/deploy.sh"
