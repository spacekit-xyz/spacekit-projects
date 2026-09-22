/**
 * Conversation archive service — saves/restores encrypted thread state to/from the storage node.
 *
 * Storage layout:
 *   Collection: `messaging_archive`
 *   Document ID: DID slug (e.g. `did-spacekit-user-local-dev`)
 *   Body: {@link ArchiveEnvelope} (v1 AES-256-GCM ciphertext of serialised threads JSON)
 */

import type { ArchiveEnvelope } from "./messagingCrypto";
import {
  encryptArchive,
  decryptArchive,
  didToArchiveSlug,
} from "./messagingCrypto";

const ARCHIVE_COLLECTION = "messaging_archive";

type ThreadMsg = {
  id: string;
  role: "user" | "peer";
  content: string;
  createdAt: string;
};

type ThreadsState = Record<string, ThreadMsg[]>;

function storageDocUrl(storageBase: string, collection: string, docId: string): string {
  const base = storageBase.replace(/\/$/, "");
  const apiOrigin = base.endsWith("/api/storage") ? base.slice(0, -"/api/storage".length) : base;
  return `${apiOrigin}/api/documents/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`;
}

/**
 * Encrypt and PUT the current threads to the storage node.
 * Also writes a server-envelope transcript backup (admin-readable after key rotation).
 * @returns `true` on success.
 */
export async function saveConversationArchive(
  storageBase: string,
  did: string,
  threads: ThreadsState,
  messagingApiBase?: string,
): Promise<boolean> {
  const slug = didToArchiveSlug(did);
  const plainJson = JSON.stringify(threads);
  const envelope = await encryptArchive(plainJson, did);
  const url = storageDocUrl(storageBase, ARCHIVE_COLLECTION, slug);

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `DID ${did}`,
    },
    body: JSON.stringify(envelope),
  });
  const ok = res.ok;

  if (messagingApiBase && Object.keys(threads).length > 0) {
    const backupUrl = `${messagingApiBase.replace(/\/$/, "")}/api/messaging/transcript-backup`;
    void fetch(backupUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "owner-did": did.trim().toLowerCase(),
      },
      body: plainJson,
    }).catch(() => {});
  }

  return ok;
}

/**
 * Fetch and decrypt the thread archive for this DID from the storage node.
 * @returns restored threads, or `null` if no archive exists or decryption fails.
 */
export async function loadConversationArchive(
  storageBase: string,
  did: string,
): Promise<ThreadsState | null> {
  const slug = didToArchiveSlug(did);
  const url = storageDocUrl(storageBase, ARCHIVE_COLLECTION, slug);

  const res = await fetch(url, {
    headers: { Authorization: `DID ${did}` },
  });
  if (!res.ok) return null;

  try {
    const json = await res.json() as { document?: { data?: ArchiveEnvelope } };
    const envelope = json?.document?.data;
    if (!envelope || envelope.v !== 1) return null;
    const plainJson = await decryptArchive(envelope, did);
    const parsed = JSON.parse(plainJson) as ThreadsState;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}
