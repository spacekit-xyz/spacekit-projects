#!/usr/bin/env bash
# Package Cairn as one .spkg: UI dist + contract WASM + growformer agent WASM + three brains.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI="$ROOT/ui"
STAGING="$ROOT/package-staging"
LIB="${SPACEKIT_STANDARD_LIBRARY:-$ROOT/../../../spacekit-standard-library}"
JS="${SPACEKIT_JS:-$ROOT/../../../spacekit-js}"
GROWFORMER_PKG="$JS/growformer-pkg"
VERSION="${CAIRN_VERSION:-$(node -p "require('$UI/package.json').version")}"
OUTPUT="${CAIRN_PACKAGE_OUTPUT:-$UI/cairn-${VERSION}.spkg}"
AGENT_WASM="$LIB/target/wasm32-unknown-unknown/release/spacekit_growformer_agent.wasm"

if ! command -v spacekit >/dev/null 2>&1; then
  echo "spacekit CLI not found. Install/build spacekit-cli first." >&2
  exit 1
fi

stage_agent() {
  local kind="$1"
  local src="$2"
  local project_file="$3"
  local brain_rel="$4"
  local dest="$STAGING/agents/$kind"

  mkdir -p "$dest/agent" "$dest/data"
  cp "$src/$project_file" "$dest/"
  cp "$src/$brain_rel" "$dest/$brain_rel"
  cp "$src/data/inference.toml" "$dest/data/"
  cp "$src/data/knowledge_graph.toml" "$dest/data/"
}

write_manifest() {
  local manifest="$STAGING/agents/manifest.json"
  node -e "
    const fs = require('fs');
    const manifest = {
      version: 1,
      packaged_at: new Date().toISOString(),
      growformer: {
        js: 'agents/growformer/growformer.js',
        wasm: 'agents/growformer/growformer_bg.wasm',
      },
      contract_wasm: 'contracts/counter.wasm',
      agent_contract_wasm: 'agents/growformer-agent.wasm',
      agents: {
        tagger: {
          project: 'agents/tagger/auto-tag.gf.toml',
          brain: 'agents/tagger/agent/auto-tag-brain.bin',
        },
        summarizer: {
          project: 'agents/summarizer/summarize.gf.toml',
          brain: 'agents/summarizer/agent/summarize-brain.bin',
        },
        linker: {
          project: 'agents/linker/linker.gf.toml',
          brain: 'agents/linker/agent/linker-brain.bin',
        },
      },
    };
    fs.writeFileSync(process.argv[1], JSON.stringify(manifest, null, 2) + '\n');
  " "$manifest"
}

echo "→ Building Cairn artifacts (contract WASM, agent runtime, brains) ..."
"$ROOT/scripts/build.sh"

if [[ "${CAIRN_SKIP_UI:-0}" != "1" ]]; then
  echo ""
  echo "→ Building Cairn UI (v${VERSION}) ..."
  if [[ ! -x "$UI/node_modules/.bin/vite" ]]; then
    echo "→ Installing UI dependencies ..."
    (cd "$UI" && npm install)
  fi
  (cd "$UI" && npm run build)
  if [[ ! -f "$UI/dist/index.html" ]]; then
    echo "Build failed: $UI/dist/index.html not found." >&2
    exit 1
  fi
else
  echo ""
  echo "→ Skipping UI build (CAIRN_SKIP_UI=1)"
  if [[ ! -f "$UI/dist/index.html" ]]; then
    echo "UI dist missing — run npm run build in ui/ first." >&2
    exit 1
  fi
fi

echo ""
echo "→ Staging package (UI + contract + agents) ..."
rm -rf "$STAGING"
mkdir -p "$STAGING/contracts" "$STAGING/agents"

cp -R "$UI/dist/." "$STAGING/"
cp "$ROOT/contracts/counter.wasm" "$STAGING/contracts/"
mkdir -p "$STAGING/agents/growformer"
cp "$GROWFORMER_PKG/growformer.js" "$STAGING/agents/growformer/"
cp "$GROWFORMER_PKG/growformer_bg.wasm" "$STAGING/agents/growformer/"
cp "$AGENT_WASM" "$STAGING/agents/growformer-agent.wasm"

stage_agent "tagger" "$ROOT/auto-tag" "auto-tag.gf.toml" "agent/auto-tag-brain.bin"
stage_agent "summarizer" "$ROOT/summarize" "summarize.gf.toml" "agent/summarize-brain.bin"
stage_agent "linker" "$ROOT/linker" "linker.gf.toml" "agent/linker-brain.bin"
write_manifest

echo "   Staged:"
echo "   • UI dist (no embedded growformer — runtime loaded from spkg refs)"
echo "   • contracts/counter.wasm"
echo "   • agents/growformer/{growformer.js,growformer_bg.wasm}"
echo "   • agents/growformer-agent.wasm (contract stub)"
echo "   • agents/{tagger,summarizer,linker}/ (gf.toml + brain + inference configs)"
echo "   • agents/manifest.json"

echo ""
echo "→ Packaging ${OUTPUT} ..."
spacekit app package "$STAGING" \
  --name cairn \
  --entry index.html \
  --version "$VERSION" \
  --description "Cairn — SpaceKit notes with on-chain anchoring and growformer agents." \
  --category productivity \
  --keywords "notes,productivity,spacekit,markdown,growformer,agents" \
  -o "$OUTPUT"

if [[ "${CAIRN_KEEP_STAGING:-0}" != "1" ]]; then
  rm -rf "$STAGING"
fi

echo ""
echo "✅ Package ready: ${OUTPUT}"
echo "   Files dir:      ${OUTPUT}.files"
echo ""
echo "Next: SPACEKIT_STORAGE_NODE_URL=http://127.0.0.1:3030 ./scripts/deploy.sh"
