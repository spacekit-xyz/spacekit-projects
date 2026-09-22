#!/usr/bin/env bash
# Train the Cairn auto-tag micro-brain (~single group, compact corpus).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/auto-tag.gf.toml"
OUT="$ROOT/agent/auto-tag-brain.bin"

SPACEKIT="${SPACEKIT:-}"
if [[ -z "$SPACEKIT" ]]; then
  if [[ -x /Users/astor/Projects/2026/spacekit/target/release/spacekit ]]; then
    SPACEKIT=/Users/astor/Projects/2026/spacekit/target/release/spacekit
  elif command -v spacekit >/dev/null 2>&1; then
    SPACEKIT=spacekit
  else
    echo "spacekit not found — set SPACEKIT= to release binary" >&2
    exit 1
  fi
fi

if [[ ! -f "$ROOT/data/train_auto_tag.jsonl" ]]; then
  python3 "$ROOT/scripts/build_corpus.py"
fi

mkdir -p "$ROOT/agent"
echo "→ Train auto-tag brain → $OUT"
echo "   using $SPACEKIT"

"$SPACEKIT" agent exec -- \
  --train-brain \
  --project "$PROJECT" \
  --data-dir "$ROOT/data" \
  --brain-output "$OUT"

echo ""
echo "✅ Brain: $OUT"
echo "Smoke infer:"
echo "  $SPACEKIT agent infer --project $PROJECT --brain $OUT --prompt \"Research notes on WordNet ego-network extraction\""
