#!/usr/bin/env bash
# Build Quay UI and package ui/dist into a signed .spkg manifest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI="$ROOT/ui"
VERSION="${QUAY_VERSION:-$(node -p "require('$UI/package.json').version")}"
OUTPUT="${QUAY_PACKAGE_OUTPUT:-$UI/quay-${VERSION}.spkg}"

if ! command -v spacekit >/dev/null 2>&1; then
  echo "spacekit CLI not found. Install/build spacekit-cli first." >&2
  exit 1
fi

echo "→ Building Quay UI (v${VERSION})..."
if [[ ! -x "$UI/node_modules/.bin/vite" ]]; then
  echo "→ Installing Quay UI dependencies..."
  (cd "$UI" && npm install)
fi
(cd "$UI" && npm run build)

if [[ ! -f "$UI/dist/index.html" ]]; then
  echo "Build failed: $UI/dist/index.html not found." >&2
  exit 1
fi

echo "→ Packaging ${OUTPUT} ..."
spacekit app package "$UI/dist" \
  --name quay-file-manager-app \
  --entry index.html \
  --version "$VERSION" \
  --description "Quay is a SpaceKit app for files." \
  --category productivity \
  --keywords "files,productivity,spacekit,storage" \
  -o "$OUTPUT"

echo ""
echo "✅ Package ready: ${OUTPUT}"
echo "   Files dir:      ${OUTPUT}.files"
echo ""
echo "Next: ./scripts/deploy.sh"
