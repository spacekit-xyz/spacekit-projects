# Hello SpaceKit — Example WebApp

The smallest possible SpaceKit app: one `index.html` file with inline CSS and JavaScript. Start here if you want to see how a web app talks to the SpaceKit SDK bridge before looking at the larger apps in this repo.

The page reads the current user's DID, saves and loads key/value data in app-scoped storage, and logs every SDK call to an on-page activity feed.

## Prerequisites

- The SpaceKit CLI (`spacekit`) on your `PATH`
- A reachable SpaceKit storage node (a local node on `http://localhost:3030` works for development)
- Node.js, only if you want to use the `npm run` shortcuts

## Quick start

### 1. Preview locally

```bash
npm run preview        # serves the folder with `npx serve .`
```

You can also open `index.html` directly. Outside SpaceKit the SDK bridge isn't injected, so the page shows "SDK not available". That's expected.

### 2. Package

```bash
npm run package
# same as:
spacekit app package . --name "Hello SpaceKit" --entry index.html --version 1.0.0
```

This writes `hello-spacekit-1.0.0.spkg`, a signed app manifest that lists every file with its content hash.

### 3. Deploy

```bash
npm run deploy
# same as:
spacekit app deploy hello-spacekit-1.0.0.spkg --publish
```

Each file is uploaded to the storage node and the app is registered in the marketplace. Add `--storage-node <url>` to target a node other than your CLI default.

### 4. Open it

```
https://spacekit.xyz/app/<your-app-id>
```

The host loads the manifest, verifies the content hashes, injects the SDK bridge and renders the app in a sandboxed iframe.

## What the example uses

| Call | What it does |
|------|--------------|
| `spacekit.identity.did()` | Returns the signed-in user's DID |
| `spacekit.storage.set(key, value)` | Saves a value in storage scoped to this app |
| `spacekit.storage.get(key)` | Reads it back |

## Other SDK surfaces

Inside SpaceKit, `window.spacekit` also exposes messaging and payments. This example doesn't call them, but they follow the same pattern:

```javascript
// Messaging
await spacekit.messaging.send("did:spacekit:user:alice", "Hello!");
const threads = await spacekit.messaging.list();

// Payments
await spacekit.payments.charge(100, "ASTRA");
```

Every call is proxied over `postMessage` to the host frame, which routes it through the policy-gated host modules in the spacekit-js VM.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The whole app: markup, inline CSS and JS |
| `package.json` | `preview`, `package` and `deploy` shortcuts |

## Next steps

Once this works, look at the larger apps that follow the same pattern:

- [`apps/quay`](../quay) — encrypted file storage and sharing
- [`apps/cairn`](../cairn) — notes with on-device AI agents
- [`apps/hermes`](../hermes) — end-to-end encrypted messaging
- [`apps/harmonia`](../harmonia) — a CRM built on storage, messaging and contracts

## License

Apache 2.0 — see [LICENSE](LICENSE).
