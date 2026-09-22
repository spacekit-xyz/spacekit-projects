# Hermes — SpaceKit Messenger

Hermes is the native messaging app for SpaceKit. Conversations are addressed by SpaceKit DID and encrypted end to end with post-quantum Kyber keys, so the messaging node relays ciphertext it can't read.

## Features

- **Direct messages** between SpaceKit DIDs. You can start a chat with `alice`, `@alice` or `did:spacekit:user:alice`.
- **Group chats and organization channels**, with invites. Channel history stays intact as members are added.
- **End-to-end encryption.** Hermes generates a Kyber key pair, registers the public key with the messaging node, and encrypts every message to the recipient's key.
- **Attachments**: images, video, PDFs, markdown and other files, previewed inline.
- **Public directory.** Opt in to be listed so other people can find you by name.
- **Wallet linking.** Connect an Ethereum wallet (WalletConnect / wagmi) and sign a message to link it to your SpaceKit identity.
- **Block list**, managed per DID.
- Layouts for both desktop and narrow screens, and it runs embedded inside the SpaceKit app shell.

## Layout

```
hermes/
├── ui/                    # React + Vite app
│   ├── src/HermesApp.tsx  # The whole messenger UI and client logic
│   ├── src/hermes.css
│   └── vite.config.ts     # Single-bundle build for sandboxed iframes
├── scripts/               # package.sh · deploy.sh · deploy-app.sh · undeploy.sh
├── contracts/             # Template contract (not used by the UI)
└── spacekit.toml
```

## Prerequisites

- Node.js 18+
- The SpaceKit CLI (`spacekit`) on your `PATH`
- A checkout of **`spacekit-sdk`** next to `spacekit-projects`. `ui/package.json` depends on it as `file:../../../../spacekit-sdk` for the Kyber helpers.
- A reachable SpaceKit messaging node and storage node

## Configuration

Vite reads `VITE_*` variables from `../../../../spacekit.xyz-website/.env`, so Hermes uses the same endpoints as the website by default. To run Hermes on its own, change `envDir` in `ui/vite.config.ts` or put a `.env` file there.

| Variable | Purpose |
|----------|---------|
| `VITE_API_URL` / `VITE_PRODUCTION_API_URL` | SpaceKit API base (DID registry, directory, wallet linking) |
| `VITE_SPACEKIT_MESSAGING_NODE_URL` | Messaging node |
| `VITE_USE_MESSAGING_PROXY` | Route messaging through the API proxy |
| `VITE_SPACETIME_MESSAGING_URL` | Spacetime messaging endpoint |
| `VITE_SPACEKIT_STORAGE_NODE_URL` / `VITE_SPACEKIT_STORAGE_NODE_RPC` | Storage node for attachments |
| `VITE_SOCIAL_API_URL` / `VITE_SOCIAL_USE_LOCAL_API` | Social directory API |
| `VITE_WALLETCONNECT_PROJECT_ID` | WalletConnect project ID for wallet linking |
| `VITE_USE_ANVIL` | Use a local Anvil chain for wallet features during development |

Don't commit a `.env` file. The root `.gitignore` excludes them.

## Run locally

```bash
cd ui
npm install
npm run dev
```

## Package and deploy

```bash
./scripts/package.sh    # builds ui/dist and packages it as ui/hermes-<version>.spkg
./scripts/deploy.sh     # uploads to the storage node and publishes to the marketplace
```

The build is a single JavaScript bundle (`inlineDynamicImports`) because apps run from a blob URL inside a sandboxed iframe, where relative dynamic imports can't be resolved.

`deploy.sh` removes any previous deployment of the same app ID first. Use `./scripts/undeploy.sh <app-id>` to remove a deployment by hand.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SPACEKIT_STORAGE_NODE_URL` | From the website `.env`, else `http://localhost:3030` | Storage node to deploy to |
| `HERMES_VERSION` | `ui/package.json` version | Package version |
| `HERMES_PUBLISH` | `1` | Set to `0` to upload without publishing |
| `HERMES_WEBSITE_ENV` | `../../../spacekit.xyz-website/.env` | Where to read the storage node URL from |

## License

Apache 2.0 — see [LICENSE](LICENSE).
