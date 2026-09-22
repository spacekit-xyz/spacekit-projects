#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/summarize.gf.toml"
OUT="$ROOT/agent/summarize-brain.bin"

SPACEKIT="${SPACEKIT:-}"
if [[ -z "$SPACEKIT" ]]; then
  if [[ -x /Users/astor/Projects/2026/spacekit/target/release/spacekit ]]; then
    SPACEKIT=/Users/astor/Projects/2026/spacekit/target/release/spacekit
  elif command -v spacekit >/dev/null 2>&1; then
    SPACEKIT=spacekit
  else
    echo "spacekit not found — set SPACEKIT=" >&2
    exit 1
  fi
fi

python3 "$ROOT/scripts/build_corpus.py"
mkdir -p "$ROOT/agent"

echo "→ Train summarize brain → $OUT"
"$SPACEKIT" agent exec -- \
  --train-brain \
  --project "$PROJECT" \
  --data-dir "$ROOT/data" \
  --brain-output "$OUT"

echo "✅ Brain: $OUT"
