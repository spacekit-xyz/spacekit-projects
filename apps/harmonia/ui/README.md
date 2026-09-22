# @spacekit/crm

A customer relations manager that runs entirely on SpaceKit. No backend, no SaaS database — contacts, deals, and notes live in **your** SpaceKit storage, sync over SpaceKit **messaging**, and notes can be **anchored on-chain** so you can prove what was agreed and when. Package it with `../scripts/package.sh` and publish it to the marketplace.

## What's inside

| File | Purpose |
|---|---|
| `src/adapter.ts` | `SpacekitAdapter` — the only surface to implement — plus `MemoryAdapter` for dev |
| `src/types.ts` | Contact, Deal, Note, Anchor, Activity, `AgentName`, sync message |
| `src/store.ts` | `CrmStore` — key scheme, CRUD, cross-device sync, anchoring, agent calls |
| `src/useCrm.ts` | React hook: loads state, subscribes to remote changes |
| `src/components/CRM.tsx` | `<CRM/>` — the whole app (Contacts / Pipeline / Activity) |
| `src/components/ui.tsx` | SpaceKit design tokens + primitives, incl. the `AnchorSeal` trust mark |
| `src/embedAdapter.ts` | Uses `window.spacekit` when embedded in SpaceKit, otherwise `MemoryAdapter` |
| `src/main.tsx` | App entry for the packaged build |

## Quick start

```bash
npm install
npm run typecheck     # strict, passes
npm run build         # → dist/
../scripts/package.sh # → harmonia-<version>.spkg
../scripts/deploy.sh  # upload + publish
```

```tsx
import { CRM, MemoryAdapter } from "@spacekit/crm";

// dev: MemoryAdapter. prod: the runtime's bindings (e.g. window.spacekit)
<CRM adapter={window.spacekit ?? new MemoryAdapter()} actor="ada" />
```

## How each SpaceKit surface is used

**storage** — everything under a `crm/` prefix so the app coexists with other pkgs in the same store:

```
crm/contacts/{contactId}
crm/deals/{dealId}
crm/notes/{contactId}/{noteId}
crm/activity/{zero-padded-ts}-{id}     ← sorts chronologically via list()
```

**messaging** — every mutation publishes `{scope, id, origin}` on topic `crm.sync.v1`. Other devices running your CRM subscribe and refresh; `origin` (a per-instance random id) prevents echo loops. Messaging being down never blocks a local write. The same surface is used to send agent-drafted follow-ups directly to a contact's `skAddress`.

**contracts** — "Anchor on-chain" computes a canonical SHA-256 of the note (`id, contactId, body, author, createdAt`) and calls `contracts.anchor(noteId, hash)`. The returned `{tx, timestamp}` is stored on the note and rendered as the **AnchorSeal**. "Verify" re-checks both the chain (`contracts.verify`) *and* that the local content still matches the anchored hash — if either fails the seal turns red ("Tampered").

**agents** — four typed agent calls (`AgentName`):

| Agent | Payload → Result |
|---|---|
| `contact.enrich` | Contact → Partial\<Contact\> (public context) |
| `thread.summarize` | { notes } → { summary } |
| `followup.draft` | { contact, notes } → { subject, body } (sendable via messaging) |
| `deal.score` | { deal, notes } → { score, rationale } (shown on the deal card) |

`MemoryAdapter.agents` returns canned responses so the whole UI is exercisable offline before the real agent runtime is wired in.

## Notes for production

- **Conflict policy** is last-write-wins per key. If two devices edit the same contact offline, the later `updatedAt` wins. If you need merging, add a vector clock to the records and resolve in `saveContact`.
- **List scaling**: `storage.list(prefix)` is called per view. Past a few thousand records, maintain an index record (e.g. `crm/index/contacts`) updated on write instead of listing.
- **Privacy**: nothing leaves the user's storage except sync messages (ids only, no content) and explicit sends to a contact's address. If your storage layer isn't encrypted at rest by default, encrypt values before `put`.
- **Anchoring costs**: anchor is per-note and user-initiated, never automatic — each call is a chain transaction.
- **Accessibility/quality floor**: keyboard-operable controls, labeled inputs, empty states that direct the next action, errors that say what to do.
