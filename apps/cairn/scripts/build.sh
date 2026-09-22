#!/usr/bin/env bash
# Build Cairn contract WASM, growformer agent runtime WASM, and verify agent brains.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="${SPACEKIT_STANDARD_LIBRARY:-$ROOT/../../../spacekit-standard-library}"
JS="${SPACEKIT_JS:-$ROOT/../../../spacekit-js}"
GROWFORMER_PKG="$JS/growformer-pkg"
CONTRACT_SRC="$ROOT/contracts/counter.rs"
CONTRACT_OUT="$ROOT/contracts/counter.wasm"
AGENT_WASM="$LIB/target/wasm32-unknown-unknown/release/spacekit_growformer_agent.wasm"
GROWFORMER_BG_WASM="$GROWFORMER_PKG/growformer_bg.wasm"
GROWFORMER_JS="$GROWFORMER_PKG/growformer.js"

require_brain() {
  local label="$1"
  local path="$2"
  local hint="$3"
  if [[ ! -f "$path" ]]; then
    echo "Missing $label brain: $path" >&2
    echo "  Train with: $hint" >&2
    exit 1
  fi
}

echo "→ Verifying growformer brains ..."
require_brain "auto-tag" "$ROOT/auto-tag/agent/auto-tag-brain.bin" "cd auto-tag && ./scripts/train.sh"
require_brain "summarize" "$ROOT/summarize/agent/summarize-brain.bin" "cd summarize && ./scripts/train.sh"
require_brain "linker" "$ROOT/linker/agent/linker-brain.bin" "cd linker && ./scripts/train.sh"
echo "   ✅ tagger, summarizer, linker brains present"

if [[ "${CAIRN_SKIP_CONTRACT:-0}" != "1" ]]; then
  echo "→ Building smart contract WASM ..."
  if ! command -v rustc >/dev/null 2>&1; then
    echo "rustc not found — install Rust (https://rustup.rs/) or set CAIRN_SKIP_CONTRACT=1" >&2
    exit 1
  fi
  if [[ ! -f "$CONTRACT_SRC" ]]; then
    echo "Contract source not found: $CONTRACT_SRC" >&2
    exit 1
  fi
  rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
  rustc --crate-type cdylib --target wasm32-unknown-unknown -O "$CONTRACT_SRC" -o "$CONTRACT_OUT"
  echo "   ✅ $CONTRACT_OUT"
else
  echo "→ Skipping contract build (CAIRN_SKIP_CONTRACT=1)"
  if [[ ! -f "$CONTRACT_OUT" ]]; then
    echo "counter.wasm missing — run without CAIRN_SKIP_CONTRACT or compile manually." >&2
    exit 1
  fi
fi

if [[ "${CAIRN_SKIP_AGENT_WASM:-0}" != "1" ]]; then
  if [[ -f "$AGENT_WASM" ]]; then
    echo "→ Growformer agent WASM already built"
    echo "   ✅ $AGENT_WASM"
  else
    echo "→ Building spacekit_growformer_agent.wasm ..."
    if [[ ! -d "$LIB/agents/spacekit-growformer-agent" ]]; then
      echo "Set SPACEKIT_STANDARD_LIBRARY to your spacekit-standard-library checkout." >&2
      echo "  Expected: $LIB" >&2
      exit 1
    fi
    rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
    (cd "$LIB" && cargo build --release -p spacekit-growformer-agent --target wasm32-unknown-unknown)
    echo "   ✅ $AGENT_WASM"
  fi
else
  echo "→ Skipping agent WASM build (CAIRN_SKIP_AGENT_WASM=1)"
  if [[ ! -f "$AGENT_WASM" ]]; then
    echo "spacekit_growformer_agent.wasm missing at $AGENT_WASM" >&2
    exit 1
  fi
fi

echo "→ Verifying growformer inference runtime (spacekit-js growformer-pkg) ..."
for f in "$GROWFORMER_JS" "$GROWFORMER_BG_WASM"; do
  if [[ ! -f "$f" ]]; then
    echo "Missing $f" >&2
    echo "  Build with: cd spacekit-js && npm run build:growformer-wasm" >&2
    exit 1
  fi
done
echo "   ✅ growformer.js + growformer_bg.wasm"

echo ""
echo "✅ Cairn build artifacts ready"
