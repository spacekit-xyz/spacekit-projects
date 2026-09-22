# Quay

> A place to dock your files. Decentralized cloud storage and sharing, built on the Spacekit network.

Quay is a React/TypeScript files app designed to compete with Google Drive, Dropbox, OneDrive, iCloud, MEGA, pCloud, and Sync.com — and beat them on the things they can't easily change: **content-addressed storage, native end-to-end encryption, and verifiable provenance**, all on the Spacekit blockchain network.

> The name is a working title. A quay (pronounced "key") is a sturdy dock where vessels load and unload — files dock here to be stored, shared, and retrieved.

---

## Why Quay

| Competitor | What they're good at | Where Quay wins |
|---|---|---|
| Google Drive | Easy sharing, collab | Same sharing UX, but links are signed and revocable on-chain; no Google account, no scanning your files |
| Dropbox | Rock-solid sync | Content-addressed sync — every chunk has a CID, dedupe is free, no central server to throttle you |
| OneDrive | Office integration | Open file formats first; Microsoft Office can still open them, but the data isn't held hostage |
| iCloud | Seamless on Apple devices | Works on every platform; not locked to one vendor's hardware |
| MEGA | End-to-end encryption | Same E2E guarantees, but encryption keys are auditable and recovery is user-controlled — not "trust us" |
| pCloud | Lifetime plans | Pay-per-CID at the storage node — closer to a true lifetime model without a single point of failure |
| Sync.com | Zero-knowledge encryption | Same zero-knowledge property, plus on-chain proof a file existed at time T |

---

## What's implemented

This is what's working in `ui/src/QuayApp.tsx` today with the bundled mock adapter:

### Storage & UI
- ✅ Drag-and-drop upload with per-file progress
- ✅ Click-to-upload via toolbar
- ✅ Folders, nested arbitrarily deep, breadcrumb navigation
- ✅ Grid view and list view, toggle in toolbar
- ✅ Star / trash / restore / delete forever
- ✅ Rename
- ✅ Sidebar views: All, Starred, Shared, Recent, Trash (with counts)
- ✅ Search across filenames in the current view
- ✅ Click to select, ⌘/Ctrl-click multi-select
- ✅ Keyboard shortcuts (see below)
- ✅ Status bar with save state and upload progress
- ✅ Storage usage indicator
- ✅ VSCode-style dark theme

### Inline previews (new)
- ✅ **Images** — `<img>` with object URL
- ✅ **Video / audio** — native `<video>` / `<audio>` controls
- ✅ **PDFs** — embedded via `<embed>`
- ✅ **Text / code** — first 50KB rendered as `<pre>`, with truncation notice
- ✅ Click-to-load (doesn't auto-decrypt every selection)
- ✅ Object URLs properly revoked on unmount and entry switch
- ⚠️ Markdown is rendered as plain text — wire `marked` if you want HTML rendering
- ⚠️ Code highlighting falls back to monospace plain text — wire Monaco or Shiki if you want syntax colors

### Versioning UI (new)
- ✅ "↻ New version" button uploads a replacement file
- ✅ Current state snapshotted into `versions[]` before replacement
- ✅ Version history shown in details pane (date, size, content-hash prefix)
- ✅ Download any historical version (filename auto-stamped)
- ✅ Restore a historical version → kept current goes back into history
- ✅ Replacing a file clears its on-chain anchor (new ciphertext = new hash; user re-anchors)

### Encryption
- ✅ AES-256-GCM via Web Crypto, every file encrypted before leaving the browser
- ✅ Per-file random keys
- ✅ Each version has its own ciphertext / key / IV (you can't decrypt v1 with v2's key)
- ✅ Owner-wrapped keys stored on the file record
- ✅ SHA-256 of ciphertext computed for anchoring

### Sharing
- ✅ Share dialog with public link or direct-to-pubkey
- ✅ Read or read+write permissions
- ✅ Optional expiry date
- ✅ Revoke active shares
- ✅ Active shares listed in details pane
- ✅ Public links produce a URL pattern: `/s/{token}#k={base64key}` (key in URL fragment, never sent to network)
- ✅ `<ShareReceiver />` component for the recipient route (see below)

### Smart-contract anchoring
- ✅ "⬢ Anchor" button writes `{ fileId, sha256(ciphertext), timestamp }` via the contracts adapter
- ✅ Anchor tx + timestamp shown in details pane
- ✅ Replacing or restoring a version clears the anchor (intentional — must re-anchor)

### Agents
- ✅ "Suggest folders" (organizer) — heuristic group by MIME family in the mock
- ✅ "Find duplicates" (dedup) — groups by content hash
- ✅ Agent invocation interface is generic — swap mocks for real on-chain agents one by one
- ⚠️ `extractor`, `summarizer`, `similarity-search` are defined in the adapter type but only the mock stubs run; wire real implementations to use

### ShareReceiver (new)
- ✅ Looks up share record by token (mock: scans file records; production: contract call)
- ✅ Reads decryption key from URL fragment for public shares
- ✅ Validates expiry and revocation
- ✅ "Preview" and "Download" actions with the same inline-preview logic
- ✅ Designed to be dropped into a route like `/s/:token`

---

## What still needs filling in

Things deliberately stubbed or skipped. Listed roughly in order of importance:

### Security-critical — don't ship without these
- ❌ **Real `wrapKey` / `unwrapKey`.** The mock just base64-encodes the raw key. Production needs ECDH or RSA-OAEP against the recipient's public key. Replace the entire `cryptoImpl.wrapKey` and `cryptoImpl.unwrapKey` implementations before any user uploads a real file. Marked with a comment in the code.
- ❌ **Direct share key delivery.** Right now `ShareReceiver` falls back to the owner's wrapped key for direct shares because the mock has no recipient PKI. In production: when a direct share is created, the file key should be re-wrapped to the recipient's public key and stored on the `Share` record (not on the file). `ShareReceiver` then unwraps with the recipient's private key.
- ❌ **Password-protected public links.** The dialog has a `passwordHash` field in `ShareInput` but the UI doesn't collect a password and `ShareReceiver` doesn't prompt for one. Both sides need: derive a key from password (PBKDF2/Argon2), use it to encrypt the share-link key, store hash on-chain for verification.
- ❌ **Share record on-chain.** `createShare` only returns a tx hash; the actual share data still lives on the file record. In production the share record itself should be the on-chain primitive so revocation is enforceable by the contract, not just the UI.

### Performance / scale — needed for real usage
- ⏸ **Chunked / resumable uploads.** Current `putBlob` is one-shot. Real implementation chunks into ~4MB pieces, each its own CID, then stores a manifest. The adapter's `putBlob` signature accepts an `onProgress` callback but doesn't pause/resume.
- ❌ **Selective sync.** No "available offline" marker. Once chunked uploads exist, this becomes "pin these CIDs locally."
- ❌ **Blob garbage collection.** When a file is `Delete forever`'d, the metadata record is removed but the blob stays in IndexedDB (and would stay on the storage node). Need a reference-counting sweep across all entries to know when it's safe to unpin a CID.

### UX gaps — nice-to-haves
- ❌ **Drag-to-move between folders.** Drag-and-drop only handles uploads from the OS, not reorganization.
- ❌ **Multi-select bulk actions.** Selection works but bulk star/trash/share isn't wired in the UI.
- ❌ **Sort options** (by size, date, name). Currently folders-first then name-asc.
- ❌ **Right-click context menus.** All actions live in the details pane.
- ❌ **Inline rename** (currently uses `prompt()`).
- ❌ **Trash auto-empty after N days.**
- ❌ **Quota / billing UI.** Storage usage is shown but there's no concept of a quota.

### Integrations
- ⏸ **Spacekit nodes.** Implement the four `SpacekitAdapter` surfaces against real storage, messaging, and contract clients.
- ❌ **WebDAV gateway.** For legacy desktop sync clients.
- ❌ **Mobile clients.** Adapter is portable, but the UI is desktop-first. React Native version would reuse the adapter and rebuild the chrome.
- ❌ **Web clipper / OS file-watcher.** For automatic backup of local folders.

---

## Quick start

### Prerequisites

- Node.js 18+
- The SpaceKit CLI (`spacekit`) on your `PATH`, to package and deploy

### Run locally

```bash
cd ui
npm install
npm run dev
```

The app starts with the bundled mock adapter, which stores files in IndexedDB, so you can try everything without SpaceKit nodes.

### Package and deploy

```bash
./scripts/package.sh    # builds ui/dist and packages it as ui/quay-<version>.spkg
./scripts/deploy.sh     # uploads to the storage node and publishes to the marketplace
```

`deploy.sh` removes any previous deployment of the same app ID first. Use `./scripts/undeploy.sh <app-id>` to remove a deployment by hand.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SPACEKIT_STORAGE_NODE_URL` | From the website `.env`, else `http://localhost:3030` | Storage node to deploy to |
| `QUAY_VERSION` | `ui/package.json` version | Package version |
| `QUAY_PUBLISH` | `1` | Set to `0` to upload without publishing |

### Use the component in your own app

```tsx
import FilesApp, { ShareReceiver, createMockAdapter, type SpacekitAdapter } from './QuayApp';

// Standalone (mock adapter — IndexedDB-backed)
<FilesApp />

// With real Spacekit nodes
const adapter: SpacekitAdapter = { /* … */ };
<FilesApp adapter={adapter} ownerPubkey={user.pubkey} />
```

### Wiring ShareReceiver into your router

```tsx
// React Router example
<Route path="/s/:token" element={<ShareReceiverPage />} />

function ShareReceiverPage() {
  const { token } = useParams();
  // The decryption key is in the URL fragment (#k=...), never sent to the network
  const k = new URLSearchParams(window.location.hash.slice(1)).get('k') ?? undefined;
  return <ShareReceiver shareToken={token!} decryptKey={k} adapter={adapter} />;
}
```

The hash fragment (`#k=...`) is critical — browsers do not transmit URL fragments to servers, so the storage node and contracts never see the decryption key. Public-link shares depend on this.

---

## The Spacekit adapter

Quay talks to your infrastructure through one interface. Implement it once and the app doesn't care whether you're on local mocks, a testnet, or production:

```ts
interface SpacekitAdapter {
  storage: {
    putBlob(blob: Blob, opts?: { onProgress?: (loaded: number, total: number) => void }): Promise<{ cid: string; size: number }>;
    getBlob(cid: string, opts?: { onProgress?: (loaded: number, total: number) => void }): Promise<Blob>;
    putRecord(key: string, value: unknown): Promise<string>;
    getRecord<T>(key: string): Promise<T | null>;
    listRecords(prefix?: string): Promise<string[]>;
    deleteRecord(key: string): Promise<void>;
  };
  messaging: {
    publish(topic: string, msg: unknown): Promise<void>;
    subscribe(topic: string, cb: (msg: unknown) => void): () => void;
  };
  contracts: {
    anchor(fileId: string, contentHash: string): Promise<{ tx: string; timestamp: number }>;
    verify(fileId: string): Promise<{ verified: boolean; timestamp?: number; tx?: string }>;
    createShare(share: ShareInput): Promise<{ shareId: string; tx: string }>;
    revokeShare(shareId: string): Promise<{ tx: string }>;
  };
  agents: {
    invoke<T>(agent: AgentName, payload: unknown): Promise<T>;
  };
  crypto: {
    generateFileKey(): Promise<CryptoKey>;
    encrypt(blob: Blob, key: CryptoKey): Promise<{ ciphertext: Blob; iv: Uint8Array }>;
    decrypt(ciphertext: Blob, key: CryptoKey, iv: Uint8Array): Promise<Blob>;
    wrapKey(key: CryptoKey, recipientPubkey: string): Promise<string>;
    unwrapKey(wrapped: string): Promise<CryptoKey>;
  };
}

type AgentName = 'organizer' | 'extractor' | 'summarizer' | 'dedup' | 'similarity-search';
```

### Agent contracts

| Agent | Payload | Returns | Status |
|---|---|---|---|
| `organizer` | `{ files: FileEntry[] }` | `{ fileId, suggestedFolder, confidence }[]` | Mock heuristic |
| `extractor` | `{ cid, mimeType }` | `{ text, language?, pages? }` | Stub |
| `summarizer` | `{ text }` | `string` | Stub |
| `dedup` | `{ files: FileEntry[] }` | `{ groups: string[][] }` | Real (content-hash) |
| `similarity-search` | `{ query, corpus }` | `{ fileId, score }[]` | Mock substring |

---

## Data model

```ts
interface FileEntry {
  id: string;
  name: string;
  parentId: string | null;          // folder ID; null = root
  type: 'file' | 'folder';
  size?: number;                    // bytes (files only)
  mimeType?: string;
  cid?: string;                     // content ID on storage node
  encrypted?: boolean;
  wrappedKey?: string;              // file key wrapped to owner's pubkey
  iv?: string;                      // base64 IV for AES-GCM
  contentHash?: string;             // sha256 of ciphertext
  anchorTx?: string;                // smart-contract tx if anchored
  anchorTime?: number;              // unix ms
  starred?: boolean;
  trashed?: boolean;
  trashedAt?: number;
  versions?: VersionEntry[];        // newest first; current version is on the entry itself
  shares?: Share[];
  createdAt: number;
  updatedAt: number;
}

interface VersionEntry {
  cid: string;
  size: number;
  mimeType?: string;
  contentHash: string;
  wrappedKey: string;               // per-version key — each version is its own ciphertext
  iv: string;
  createdAt: number;
}

interface Share {
  id: string;
  kind: 'public' | 'direct';
  recipientPubkey?: string;
  publicToken?: string;             // path component for /s/:token URLs
  permissions: 'read' | 'write';
  passwordProtected?: boolean;
  expiresAt?: number;
  createdAt: number;
  revokedAt?: number;
}
```

File records are stored under `file:{id}`. Blob ciphertext lives on the storage node, addressed by CID. Anchors are stored under `anchor:{fileId}`.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + U` | Upload files |
| `Ctrl/Cmd + Shift + N` | New folder |
| `Ctrl/Cmd + D` | Star selected |
| `Delete` / `Backspace` | Move selected to trash |
| `Enter` | Open folder / download file |
| `Escape` | Clear selection |

---

## Encryption model

By default, every file uploaded to Quay is encrypted client-side before it leaves the browser.

1. Generate a random AES-256-GCM **file key** per file (or per version)
2. Encrypt the blob; upload ciphertext to the storage node, receive a CID
3. Wrap the file key to the owner's public key; store the wrapped key in the file record
4. Anchor `sha256(ciphertext)` on-chain for a timestamped existence proof

For shares:
- **Direct shares** — re-wrap the file key to the recipient's public key, store on the share record (TODO)
- **Public links** — generate a share-specific key, derive a URL fragment that holds it (`#k=...`), so the storage node never sees the key

The storage node only ever sees ciphertext. Even the smart contract only sees hashes. The keys live on the user's devices.

---

## Project structure

```
quay/
├── ui/
│   ├── src/QuayApp.tsx   # Everything: main component, adapter interface, mocks,
│   │                     #   PreviewBlock, ShareDialog, ShareReceiver, DetailsPane
│   ├── src/main.tsx      # App entry for the packaged build
│   └── vite.config.ts
├── scripts/              # package.sh · deploy.sh · undeploy.sh
├── contracts/            # Template contract
└── spacekit.toml
```

The component is a single file on purpose. If you want to break it up:

- `adapter.ts` — `SpacekitAdapter` interface + `createMockAdapter`
- `crypto.ts` — Web Crypto wrappers + `materializeBlob` helper
- `agents.ts` — agent types + mock implementations
- `components/` — `FileTree`, `FileGrid`, `DetailsPane`, `PreviewBlock`, `ShareDialog`, `UploadDropzone`
- `pages/ShareReceiver.tsx` — the recipient page

---

## Status

Pre-alpha. The component is functional with the mock adapter; production usage requires implementing the `SpacekitAdapter` surfaces — including the `crypto` module, which is security-critical and should be reviewed before any user data hits it. See **What still needs filling in** above for the explicit list of stubs. Treat the API as unstable until 1.0.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
