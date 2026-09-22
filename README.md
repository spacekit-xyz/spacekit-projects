# SpaceKit Projects

A collection of SpaceKit projects that show how to build, train and deploy apps and agents on SpaceKit.

There are two kinds of project here:

- **Web apps and games.** These are packaged as signed `.spkg` bundles and published to the SpaceKit marketplace. They use the SDK bridge (`window.spacekit`) for identity, storage, messaging and contracts.
- **Agents.** These are Growformer micro-brains that you train from the JSONL data in each project and deploy to the SpaceKit Agent Hub.

Each project has its own README with setup, run and deploy instructions.

## What's included

### Apps

| Project | What it is | Shows you how to use |
|---------|------------|----------------------|
| [`apps/webapp`](apps/webapp) | **Hello SpaceKit**, a single-file starter app. **Start here.** | Identity, app-scoped storage, packaging and deploying |
| [`apps/quay`](apps/quay) | **Quay**, encrypted file storage and sharing (a Drive / Dropbox alternative) | Content-addressed storage, client-side encryption, share links, on-chain anchoring |
| [`apps/cairn`](apps/cairn) | **Cairn**, markdown notes with wiki links, backlinks and graph view | Cross-device sync over messaging, on-chain anchoring, three in-browser AI agents (tagger, summarizer, linker) |
| [`apps/hermes`](apps/hermes) | **Hermes**, the SpaceKit messenger | DID-addressed DMs, groups and channels, post-quantum (Kyber) end-to-end encryption, wallet linking |
| [`apps/harmonia`](apps/harmonia) | **Harmonia**, a CRM with no backend (also usable as the `@spacekit/crm` React component) | Storage, messaging sync, note anchoring, agent hooks |

### Games

| Project | What it is |
|---------|------------|
| [`games/dragon-layerz`](games/dragon-layerz) | **Dragon Layerz**, a retro arcade shooter in a single HTML file. It saves your progress and scores to SpaceKit storage. |

### Companion agents

Pet companions for the Agent Hub. Each has a character bible, training data, a trained-brain manifest and a 3D video-chat UI.

| Project | Character |
|---------|-----------|
| [`companions/luna`](companions/luna) | **Luna**, a cat. The reference companion that the other two follow. |
| [`companions/pete`](companions/pete) | **Pete**, a gentle cosmic dragon with a medieval storyteller's voice |
| [`companions/kitsu`](companions/kitsu) | **Kitsu**, a street-smart Shiba Inu from Tokyo |

### Sentiment agents

| Project | What it classifies |
|---------|--------------------|
| [`sentiment/crypto`](sentiment/crypto) | Crypto, blockchain and DeFi text, including slang, sarcasm and scam talk |
| [`sentiment/fintech`](sentiment/fintech) | Traditional finance text: markets, banking, corporate finance and support conversations |

Both return a label (positive or negative, strong or mild, neutral, mixed or sarcastic) with a short explanation.

## Repository layout

```
spacekit-projects/
├── apps/          # Web apps packaged for the SpaceKit marketplace
├── games/         # Browser games packaged the same way
├── companions/    # Pet companion agents for the Agent Hub
└── sentiment/     # Sentiment analysis agents
```

## Prerequisites

- **SpaceKit CLI** (`spacekit`) on your `PATH`. Every project uses it to package, train or deploy.
- **Node.js 18+** for the web apps
- **Python 3** to regenerate agent training data
- **Rust** with the `wasm32-unknown-unknown` target, for projects that compile a contract or agent WASM
- A **SpaceKit storage node**. A local node on `http://localhost:3030` works for development.

Some projects also expect these SpaceKit repos checked out next to this one:

```
your-workspace/
├── spacekit-projects/           # this repo
├── spacekit-sdk/                # used by Hermes
├── spacekit-js/                 # used by Cairn (Growformer WASM runtime)
└── spacekit-standard-library/   # builds the agent WASM used when deploying agents
```

## Common workflows

### Web apps and games

Most apps have the same three scripts:

```bash
cd apps/<name>
./scripts/package.sh    # build the UI and create a signed .spkg
./scripts/deploy.sh     # upload to the storage node and publish to the marketplace
./scripts/undeploy.sh   # remove a deployment
```

Set `SPACEKIT_STORAGE_NODE_URL` to choose which storage node to deploy to. The starter `apps/webapp` uses `npm run package` and `npm run deploy` instead.

### Agents

Every agent project has a `*.gf.toml` manifest for training and inference, and a `deploy.toml` for the Agent Hub:

```bash
cd companions/luna                                    # or any agent project
spacekit agent --train-brain --project luna.gf.toml   # train the brain into agent/*.bin
spacekit agent infer --project luna.gf.toml --prompt "Hey Luna"
spacekit storage deploy --package deploy.toml          # deploy to the Agent Hub
```

Before deploying, edit `deploy.toml` so it points at your agent WASM and your storage node.

## What isn't in the repo

The root [`.gitignore`](.gitignore) keeps these out of version control. You generate them locally:

- **Trained brains** (`*.bin`). Train them from each project's data. Some are hundreds of megabytes.
- **Build output and dependencies**: `node_modules/`, `dist/`, `target/`, `*.spkg`
- **Deploy state**: `deploy-receipt.json` and logs
- **Local secrets and environment files**: `.env*` (except `.env.example`) and key files

## Learn more

- [SpaceKit documentation](https://docs.spacekit.xyz)
- [CLI reference](https://docs.spacekit.xyz/cli)

## License

Each project is licensed under the Apache License 2.0. See the `LICENSE` file in each project folder.
