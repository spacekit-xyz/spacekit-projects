#!/usr/bin/env bash
# Package Dragon Layerz HTML into a signed .spkg for marketplace deploy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI="$ROOT/ui"
DIST="$UI/dist"
VERSION="${DRAGON_LAYERZ_VERSION:-1.0.0}"
OUTPUT="${DRAGON_LAYERZ_PACKAGE:-$DIST/dragon-layerz-${VERSION}.spkg}"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/dragon-layerz-pkg.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

if ! command -v spacekit >/dev/null 2>&1; then
  echo "spacekit CLI not found. Install/build spacekit-cli first." >&2
  exit 1
fi

# Stage ONLY the game HTML — never package prior .spkg / .spkg.files nests.
cp "$UI/dragon-layerz-v1.html" "$STAGE/index.html"

mkdir -p "$DIST"
# Drop stale package artifacts so dist stays lean for inspection / Desktop preview.
rm -rf "$DIST"
mkdir -p "$DIST"

echo "→ Packaging ${OUTPUT} ..."
spacekit app package "$STAGE" \
  --name dragon-layerz \
  --entry index.html \
  --version "$VERSION" \
  --description "Descent to the Cosmic Gate — retro arcade stacker." \
  --category games \
  --keywords "arcade,game,dragon,spacekit" \
  -o "$OUTPUT"

# Keep a clean copy of the shipped HTML next to the .spkg for local checks.
cp "$STAGE/index.html" "$DIST/index.html"

echo ""
echo "✅ Package ready: ${OUTPUT}"
REFS=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('content_refs',[])))" "$OUTPUT" 2>/dev/null || echo "?")
echo "   content_refs: ${REFS} (expect 1)"
echo "   Deploy: spacekit app deploy ${OUTPUT} --storage-node http://127.0.0.1:3030 --publish"
