#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBSITE_ENV="${DRAGON_LAYERZ_WEBSITE_ENV:-$ROOT/../../../spacekit.xyz-website/.env}"
VERSION="${DRAGON_LAYERZ_VERSION:-1.0.0}"
PACKAGE="${DRAGON_LAYERZ_PACKAGE:-$ROOT/ui/dist/dragon-layerz-${VERSION}.spkg}"

if [[ -z "${SPACEKIT_STORAGE_NODE_URL:-}" && -f "$WEBSITE_ENV" ]]; then
  SPACEKIT_STORAGE_NODE_URL="$(grep -E '^VITE_SPACEKIT_STORAGE_NODE_URL=' "$WEBSITE_ENV" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
fi
STORAGE_NODE="${SPACEKIT_STORAGE_NODE_URL:-http://127.0.0.1:3030}"
PUBLISH="${DRAGON_LAYERZ_PUBLISH:-1}"

if ! command -v spacekit >/dev/null 2>&1; then
  echo "spacekit CLI not found. Install/build spacekit-cli first." >&2
  exit 1
fi

if [[ ! -f "$PACKAGE" ]]; then
  "$ROOT/scripts/package.sh"
fi

APP_ID="$(node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const id = pkg.app_id;
  if (Array.isArray(id)) console.log(id.map(b => b.toString(16).padStart(2, '0')).join(''));
  else console.log(String(id ?? '').replace(/^0x/, ''));
" "$PACKAGE")"

if [[ -n "$APP_ID" ]] && curl -fsS "${STORAGE_NODE}/facts/${APP_ID}" >/dev/null 2>&1; then
  echo "→ Purging previous deployment (storage keeps old manifest facts on redeploy)..."
  DRAGON_LAYERZ_APP_ID="$APP_ID" SPACEKIT_STORAGE_NODE_URL="$STORAGE_NODE" "$ROOT/scripts/undeploy.sh" "$APP_ID"
  echo ""
fi

DEPLOY_ARGS=(spacekit app deploy "$PACKAGE" --storage-node "$STORAGE_NODE")
if [[ "$PUBLISH" == "1" || "$PUBLISH" == "true" || "$PUBLISH" == "yes" ]]; then
  DEPLOY_ARGS+=(--publish)
fi

echo "→ Deploying ${PACKAGE}"
echo "   Storage node: ${STORAGE_NODE}"
echo ""

"${DEPLOY_ARGS[@]}"

echo ""
echo "💡 After deploy, set the app id in spacekit.xyz-website/.env:"
echo "   VITE_DRAGON_LAYERZ_APP_ID=<app-id-from-output-above>"
echo ""
echo "   View standalone: http://localhost:5173/app/<app-id>"
