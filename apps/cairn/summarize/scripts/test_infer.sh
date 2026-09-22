#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/summarize.gf.toml"
BRAIN="$ROOT/agent/summarize-brain.bin"
SPACEKIT="${SPACEKIT:-/Users/astor/Projects/2026/spacekit/target/release/spacekit}"
PROMPT="${1:-Research notes on WordNet ego-network extraction and sharded growformer training.}"

[[ -f "$BRAIN" ]] || { echo "Missing $BRAIN — run ./scripts/train.sh" >&2; exit 1; }
"$SPACEKIT" agent infer --project "$PROJECT" --brain "$BRAIN" --prompt "$PROMPT"
