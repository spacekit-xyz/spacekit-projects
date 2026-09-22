# Harmonia — CRM on SpaceKit

Harmonia is a customer relationship manager with no backend and no SaaS database. Contacts, deals and notes live in **your** SpaceKit storage and sync between your devices over SpaceKit messaging. You can anchor any note on-chain, so you can later prove what was agreed and when.

It ships two ways:

- **As an app.** Package `ui/dist` and publish it to the SpaceKit marketplace.
- **As a library.** Import the `<CRM/>` component (`@spacekit/crm`) into your own React app.

## Features

- **Contacts, Pipeline and Activity** views
- **Cross-device sync.** Every change publishes a small sync event (IDs only, no content) on `crm.sync.v1`.
- **On-chain anchoring.** Hashes a note and anchors it through the contracts surface, then shows a seal. "Verify" checks both the chain and that the local text still matches, and flags a tampered note.
- **Agent hooks**: contact enrichment, thread summaries, follow-up drafts and deal scoring
- **Offline dev mode.** `MemoryAdapter` returns canned agent responses, so every screen works without SpaceKit nodes.

## Layout

```
harmonia/
├── ui/
│   ├── src/adapter.ts       # SpacekitAdapter interface + MemoryAdapter
│   ├── src/embedAdapter.ts  # Picks window.spacekit when embedded, else MemoryAdapter
│   ├── src/store.ts         # CrmStore: storage keys, CRUD, sync, anchoring, agents
│   ├── src/useCrm.ts        # React hook
│   ├── src/components/      # <CRM/> and UI primitives
│   ├── src/main.tsx         # App entry used for the packaged build
│   └── README.md            # Library-level documentation
├── scripts/                 # package.sh · deploy.sh · deploy-app.sh · undeploy.sh
├── contracts/               # Template contract
└── spacekit.toml
```

See [`ui/README.md`](ui/README.md) for the storage key layout, the agent contracts and production notes (conflict policy, scaling, privacy).

## Prerequisites

- Node.js 18+
- The SpaceKit CLI (`spacekit`) on your `PATH`, to package and deploy

## Run locally

```bash
cd ui
npm install
npm run dev          # runs with MemoryAdapter
npm run typecheck
```

## Use as a component

```tsx
import { CRM, MemoryAdapter } from "@spacekit/crm";

<CRM adapter={window.spacekit ?? new MemoryAdapter()} actor="you" />
```

To connect it to your own backend, implement `SpacekitAdapter`. It has four surfaces:

| Surface | Used for |
|---------|----------|
| `storage` | Records under the `crm/` prefix (contacts, deals, notes, activity) |
| `messaging` | Sync events and sending follow-ups to a contact |
| `contracts` | `anchor(noteId, hash)` and `verify(noteId)` |
| `agents` | `contact.enrich`, `thread.summarize`, `followup.draft`, `deal.score` |

## Package and deploy

```bash
./scripts/package.sh    # builds ui/dist and packages it as ui/harmonia-<version>.spkg
./scripts/deploy.sh     # uploads to the storage node and publishes to the marketplace
```

`deploy.sh` removes any previous deployment of the same app ID first. Use `./scripts/undeploy.sh <app-id>` to remove a deployment by hand.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SPACEKIT_STORAGE_NODE_URL` | From the website `.env`, else `http://localhost:3030` | Storage node to deploy to |
| `HARMONIA_VERSION` | `ui/package.json` version | Package version |
| `HARMONIA_PUBLISH` | `1` | Set to `0` to upload without publishing |

## License

Apache 2.0 — see [LICENSE](LICENSE).
