#!/usr/bin/env bash
# Smoke-test auto-tag infer + optional eval holdout rows.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/auto-tag.gf.toml"
BRAIN="$ROOT/agent/auto-tag-brain.bin"

SPACEKIT="${SPACEKIT:-/Users/astor/Projects/2026/spacekit/target/release/spacekit}"
if [[ ! -x "$SPACEKIT" ]]; then
  SPACEKIT=spacekit
fi

if [[ ! -f "$BRAIN" ]]; then
  echo "Missing $BRAIN — run ./scripts/train.sh first" >&2
  exit 1
fi

PROMPT="${1:-Research notes on WordNet ego-network extraction and sharded growformer training.}"
echo "=== infer ==="
"$SPACEKIT" agent infer --project "$PROJECT" --brain "$BRAIN" --prompt "$PROMPT"

if [[ -f "$ROOT/data/eval_auto_tag.jsonl" ]]; then
  echo ""
  echo "=== eval holdout (first 5) ==="
  head -5 "$ROOT/data/eval_auto_tag.jsonl" | while IFS= read -r line; do
    text=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["text"])' "$line")
    expected=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["expected_response"])' "$line")
    echo "--- prompt: ${text:0:72}…"
    out=$("$SPACEKIT" agent infer --project "$PROJECT" --brain "$BRAIN" --prompt "$text" 2>/dev/null | tail -1)
    echo "    expected: $expected"
    echo "    got:      $out"
  done
fi
