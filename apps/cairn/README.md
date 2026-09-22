# Cairn — Notes with On-Device Agents

Cairn is a markdown notes app for the SpaceKit network, in the spirit of Obsidian, Evernote and Keep. Notes live in your own SpaceKit storage, sync across devices over SpaceKit messaging, and can be anchored on-chain to prove what a note said and when.

Three small Growformer "micro-brains" ship inside the app package and run in the browser through WebAssembly:

| Agent | Brain | What it does |
|-------|-------|--------------|
| Tagger | [`auto-tag/`](auto-tag) | Suggests 3–6 topical tags for a note |
| Summarizer | [`summarize/`](summarize) | Writes a short summary of a note |
| Linker | [`linker/`](linker) | Suggests related notes from your collection |

## Features

- Markdown editing (Monaco) with live preview and split view
- `[[wiki links]]`, backlinks and a graph view
- Tags, pinned notes and search
- Import and export
- Cross-device sync over SpaceKit messaging
- On-chain anchoring and verification of a note's content hash
- Runs standalone with a mock adapter, so you can try the UI without any SpaceKit nodes

## Layout

```
cairn/
├── ui/                     # React + Vite app
│   ├── src/CairnApp.tsx    # Main component, SpacekitAdapter interface, mock adapter
│   ├── src/agents/         # WASM agent runtime + dev fallback
│   └── vite-growformer-agents.ts   # Dev-only proxy to `spacekit agent infer`
├── auto-tag/               # Tagger brain: corpus builder, training data, manifest
├── summarize/              # Summarizer brain
├── linker/                 # Linker brain
├── contracts/counter.rs    # Anchoring contract (compiled to WASM)
├── scripts/                # build.sh · package.sh · deploy.sh · undeploy.sh
└── spacekit.toml
```

## Prerequisites

- Node.js 18+
- The SpaceKit CLI (`spacekit`) on your `PATH`
- Rust with the `wasm32-unknown-unknown` target (to build the contract)
- To package the agents, checkouts of these repos next to `spacekit-projects`:
  - `spacekit-standard-library` (builds `spacekit_growformer_agent.wasm`)
  - `spacekit-js` (provides the `growformer-pkg` inference runtime)

## Run the UI locally

```bash
cd ui
npm install
npm run dev
```

The app starts with a mock adapter backed by browser storage. In dev mode, agent calls go to a local Vite proxy that shells out to `spacekit agent infer`. Set `SPACEKIT_BIN` if the CLI isn't on your `PATH`.

## Train the brains

Trained brains (`*.bin`) are not committed. Train each one before building or packaging:

```bash
(cd auto-tag  && python3 scripts/build_corpus.py && ./scripts/train.sh)
(cd summarize && python3 scripts/build_corpus.py && ./scripts/train.sh)
(cd linker    && python3 scripts/build_corpus.py && ./scripts/train.sh)
```

Each takes a few minutes on a laptop. Try a brain from the command line:

```bash
cd auto-tag
spacekit agent infer --project auto-tag.gf.toml --brain agent/auto-tag-brain.bin \
  --prompt "Meeting with design on Cairn wiki links — need auto-tag before publish."
# → ["meeting","design","cairn","wiki","planning"]
```

See [`auto-tag/README.md`](auto-tag/README.md) for the training data format.

## Build, package and deploy

```bash
./scripts/build.sh      # checks brains, compiles the contract and agent WASM
./scripts/package.sh    # builds the UI and bundles UI + contract + agents into ui/cairn-<version>.spkg
./scripts/deploy.sh     # uploads the package and publishes it to the marketplace
```

`deploy.sh` removes any previous deployment of the same app ID first, because the storage node keeps old manifests on redeploy. Use `./scripts/undeploy.sh <app-id>` to remove a deployment by hand.

### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `SPACEKIT_STORAGE_NODE_URL` | `http://localhost:3030` | Storage node to deploy to |
| `SPACEKIT_STANDARD_LIBRARY` | `../../../spacekit-standard-library` | Path to the standard library checkout |
| `SPACEKIT_JS` | `../../../spacekit-js` | Path to the spacekit-js checkout |
| `SPACEKIT_BIN` | `spacekit` on `PATH` | CLI used by the dev agent proxy |
| `CAIRN_VERSION` | `ui/package.json` version | Package version |
| `CAIRN_PUBLISH` | `1` | Set to `0` to upload without publishing to the marketplace |
| `CAIRN_SKIP_CONTRACT` | `0` | Skip compiling the contract (uses the existing `counter.wasm`) |
| `CAIRN_SKIP_AGENT_WASM` | `0` | Skip building the agent WASM |

## Connecting to real SpaceKit nodes

`CairnApp` takes an optional `adapter` prop. Without one it uses the mock adapter. Inside SpaceKit it uses the host's `window.spacekit` bindings:

| Surface | Used for |
|---------|----------|
| `storage` | Notes, attachments and settings |
| `messaging` | Sync events between your devices |
| `contracts` | `anchor(noteId, hash)` and `verify(noteId)` |
| `agents` | Tagger, summarizer and linker |

## License

Apache 2.0 — see [LICENSE](LICENSE).
