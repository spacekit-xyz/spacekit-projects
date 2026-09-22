#!/usr/bin/env bash
# Upload a packaged Cairn .spkg to the storage node (and optionally marketplace).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI="$ROOT/ui"
WEBSITE_ENV="${CAIRN_WEBSITE_ENV:-$ROOT/../../../spacekit.xyz-website/.env.production}"
VERSION="${CAIRN_VERSION:-$(node -p "require('$UI/package.json').version")}"
PACKAGE="${CAIRN_PACKAGE:-$UI/cairn-${VERSION}.spkg}"

if [[ -z "${SPACEKIT_STORAGE_NODE_URL:-}" && -f "$WEBSITE_ENV" ]]; then
  SPACEKIT_STORAGE_NODE_URL="$(grep -E '^VITE_SPACEKIT_STORAGE_NODE_URL=' "$WEBSITE_ENV" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
fi
STORAGE_NODE="${SPACEKIT_STORAGE_NODE_URL:-http://localhost:3030}"
PUBLISH="${CAIRN_PUBLISH:-1}"

if ! command -v spacekit >/dev/null 2>&1; then
  echo "spacekit CLI not found. Install/build spacekit-cli first." >&2
  exit 1
fi

if [[ ! -f "$PACKAGE" ]]; then
  echo "Package not found: $PACKAGE" >&2
  echo "Run ./scripts/package.sh first." >&2
  exit 1
fi

# App id is stable (creator + name). Storage POST /facts returns 200 "exists" without
# overwriting an existing manifest — purge first so content_refs pick up new bundles.
APP_ID="$(node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const id = pkg.app_id;
  if (Array.isArray(id)) console.log(id.map(b => b.toString(16).padStart(2, '0')).join(''));
  else console.log(String(id ?? '').replace(/^0x/, ''));
" "$PACKAGE")"

if [[ -n "$APP_ID" ]] && curl -fsS "${STORAGE_NODE}/facts/${APP_ID}" >/dev/null 2>&1; then
  echo "→ Purging previous deployment (storage keeps old manifest facts on redeploy)..."
  CAIRN_APP_ID="$APP_ID" SPACEKIT_STORAGE_NODE_URL="$STORAGE_NODE" "$ROOT/scripts/undeploy.sh" "$APP_ID"
  echo ""
fi

DEPLOY_ARGS=(spacekit app deploy "$PACKAGE" --storage-node "$STORAGE_NODE")
if [[ "$PUBLISH" == "1" || "$PUBLISH" == "true" || "$PUBLISH" == "yes" ]]; then
  DEPLOY_ARGS+=(--publish)
fi

echo "→ Deploying ${PACKAGE}"
echo "   Storage node: ${STORAGE_NODE}"
echo "   App ID:       ${APP_ID}"
echo ""

"${DEPLOY_ARGS[@]}"

# Verify manifest on storage references the packaged JS.
if [[ -n "$APP_ID" ]] && command -v node >/dev/null 2>&1; then
  EXPECTED_JS="$(node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const js = (pkg.content_refs || []).find(r => String(r.path || '').endsWith('.js'));
    console.log(js ? js.path : '');
  " "$PACKAGE")"
  REMOTE_JS="$(curl -fsS "${STORAGE_NODE}/facts/${APP_ID}" 2>/dev/null | node -e "
    const fs = require('fs');
    let d = '';
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      try {
        const j = JSON.parse(d);
        const pkg = j?.content?.Json?.data ?? j;
        const js = (pkg?.content_refs || []).find(r => String(r.path || '').endsWith('.js'));
        console.log(js ? js.path : '');
      } catch { console.log(''); }
    });
  " 2>/dev/null || true)"
  if [[ -n "$EXPECTED_JS" && -n "$REMOTE_JS" && "$EXPECTED_JS" != "$REMOTE_JS" ]]; then
    echo "" >&2
    echo "⚠️  Storage manifest still references ${REMOTE_JS}" >&2
    echo "   Expected ${EXPECTED_JS} — restart the storage node if you run an older build," >&2
    echo "   then rerun ./scripts/deploy.sh" >&2
    exit 1
  fi
  if [[ -n "$EXPECTED_JS" && "$EXPECTED_JS" == "$REMOTE_JS" ]]; then
    echo "✅ Storage manifest references ${EXPECTED_JS}"
  fi
fi

if [[ -n "$APP_ID" && -f "$WEBSITE_ENV" ]]; then
  if grep -q '^VITE_CAIRN_NOTES_APP_ID=' "$WEBSITE_ENV"; then
    sed -i.bak "s/^VITE_CAIRN_NOTES_APP_ID=.*/VITE_CAIRN_NOTES_APP_ID=${APP_ID}/" "$WEBSITE_ENV"
    rm -f "${WEBSITE_ENV}.bak"
    echo "✅ Updated VITE_CAIRN_NOTES_APP_ID in ${WEBSITE_ENV}"
  else
    echo "VITE_CAIRN_NOTES_APP_ID=${APP_ID}" >> "$WEBSITE_ENV"
    echo "✅ Appended VITE_CAIRN_NOTES_APP_ID to ${WEBSITE_ENV}"
  fi
fi

echo ""
echo "💡 Rebuild and redeploy the website so the launcher picks up any env change:"
echo "   cd spacekit.xyz-website && npm run build && <deploy website>"
echo ""
echo "   View standalone: http://localhost:5173/app/${APP_ID}"
