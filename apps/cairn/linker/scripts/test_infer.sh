#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/linker.gf.toml"
BRAIN="$ROOT/agent/linker-brain.bin"
SPACEKIT="${SPACEKIT:-/Users/astor/Projects/2026/spacekit/target/release/spacekit}"

[[ -f "$BRAIN" ]] || { echo "Missing $BRAIN — run ./scripts/train.sh" >&2; exit 1; }

PROMPT="$(python3 "$ROOT/scripts/build_corpus.py" --print-sample 2>/dev/null || true)"
if [[ -z "$PROMPT" ]]; then
  PROMPT="$(python3 - <<PY
import importlib.util
from pathlib import Path
root = Path("$ROOT")
spec = importlib.util.spec_from_file_location("bc", root / "scripts/build_corpus.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
content, _ = mod.LINK_SAMPLES[0]
print(f"suggest links for:\\n{content}\\n\\n{mod.corpus_block()}")
PY
)"
fi

"$SPACEKIT" agent infer --project "$PROJECT" --brain "$BRAIN" --prompt "$PROMPT"
