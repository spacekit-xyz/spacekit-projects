#!/usr/bin/env bash
# Remove a Hermes app deployment from the storage node (manifest, content facts, marketplace listing).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBSITE_ENV="${HERMES_WEBSITE_ENV:-$ROOT/../../../spacekit.xyz-website/.env}"

APP_ID="${1:-${HERMES_APP_ID:-}}"
if [[ -z "$APP_ID" && -f "$WEBSITE_ENV" ]]; then
  APP_ID="$(grep -E '^VITE_HERMES_APP_ID=' "$WEBSITE_ENV" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
fi

if [[ -z "$APP_ID" ]]; then
  echo "Usage: ./scripts/undeploy.sh <app-id-hex>" >&2
  echo "   or set HERMES_APP_ID / VITE_HERMES_APP_ID in the website .env" >&2
  exit 1
fi

if [[ -z "${SPACEKIT_STORAGE_NODE_URL:-}" && -f "$WEBSITE_ENV" ]]; then
  SPACEKIT_STORAGE_NODE_URL="$(grep -E '^VITE_SPACEKIT_STORAGE_NODE_URL=' "$WEBSITE_ENV" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
fi
STORAGE_NODE="${SPACEKIT_STORAGE_NODE_URL:-http://localhost:3030}"

if ! command -v spacekit >/dev/null 2>&1; then
  echo "spacekit CLI not found." >&2
  exit 1
fi

echo "→ Removing Hermes deployment"
echo "   App ID:       ${APP_ID}"
echo "   Storage node: ${STORAGE_NODE}"
echo ""

MANIFEST_JSON="$(curl -fsS "${STORAGE_NODE}/facts/${APP_ID}" 2>/dev/null || true)"
CONTENT_IDS=("$APP_ID")

if [[ -n "$MANIFEST_JSON" ]] && command -v node >/dev/null 2>&1; then
  while IFS= read -r fid; do
    [[ -n "$fid" && "$fid" != "null" ]] && CONTENT_IDS+=("$fid")
  done < <(node -e "
    const j = JSON.parse(process.argv[1]);
    const pkg = j?.content?.Json?.data ?? j?.manifest ?? j;
    const refs = pkg?.content_refs ?? [];
    for (const r of refs) {
      const id = r.fact_id;
      if (Array.isArray(id)) console.log(id.map(b => b.toString(16).padStart(2,'0')).join(''));
      else if (typeof id === 'string') console.log(id);
    }
  " "$MANIFEST_JSON" 2>/dev/null || true)
fi

echo "→ Unpublishing facts (manifest + bundled files)..."
for fid in "${CONTENT_IDS[@]}"; do
  [[ -z "$fid" || "$fid" == "0000000000000000000000000000000000000000000000000000000000000000" ]] && continue
  echo "   • ${fid}"
  spacekit content unpublish --content-id "$fid" --storage-url "$STORAGE_NODE" --purge || true
done

echo ""
echo "→ Removing app_listings catalog entry..."
CONFIG="${HOME}/.spacekit/config.toml"
DID=""
if [[ -f "$CONFIG" ]]; then
  DID="$(grep -E '^did\s*=' "$CONFIG" 2>/dev/null | head -1 | sed -E 's/^[^"]*"([^"]+)".*/\1/')"
fi
if [[ -n "$DID" ]]; then
  curl -fsS -X DELETE \
    "${STORAGE_NODE}/api/documents/app_listings/${APP_ID}" \
    -H "Authorization: DID ${DID}" \
    >/dev/null 2>&1 && echo "   ✅ app_listings removed" || echo "   ⚠️  app_listings delete failed (may already be gone)"
else
  echo "   ⚠️  Could not read DID from ~/.spacekit/config.toml — skip app_listings DELETE"
fi

echo ""
echo "✅ Undeploy complete for ${APP_ID}"
