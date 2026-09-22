/**
 * Encrypted conversation archive for SpaceKit Messaging.
 *
 * Architecture:
 *   1. **Personal archive** — PBKDF2(DID) → AES-256-GCM. Restored by the same user on any device.
 *   2. **Transcript backup** — parallel server-envelope copy via `/api/messaging/transcript-backup`
 *      (admin-readable with `X-API-Secret` + `GET /api/admin/messaging/transcripts/:slug` after
 *      storage server key rotation re-wraps envelope headers).
 *   3. Attachments use `POST /files/shared-upload` (server-envelope, participant-readable).
 *
 * Web Crypto (SubtleCrypto) is used throughout — no external deps.
 */

const PBKDF2_ITERATIONS = 210_000;
const ARCHIVE_SALT_UTF8 = "spacekit-messaging-archive-v1";
const IV_BYTES = 12;

function bytesToBase64(u8: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]!);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveArchiveKey(did: string, mode: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(did),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(ARCHIVE_SALT_UTF8),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    [mode],
  );
}

export type ArchiveEnvelope = {
  v: 1;
  ivB64: string;
  ciphertextB64: string;
  /** ISO-8601 timestamp of when this archive was written. */
  archivedAt: string;
};

export async function encryptArchive(plainJson: string, did: string): Promise<ArchiveEnvelope> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveArchiveKey(did, "encrypt");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plainJson),
  );
  return {
    v: 1,
    ivB64: bytesToBase64(iv),
    ciphertextB64: bytesToBase64(new Uint8Array(ciphertext)),
    archivedAt: new Date().toISOString(),
  };
}

export async function decryptArchive(envelope: ArchiveEnvelope, did: string): Promise<string> {
  const ivRaw = base64ToBytes(envelope.ivB64);
  const ctRaw = base64ToBytes(envelope.ciphertextB64);
  const iv = ivRaw.slice().buffer as ArrayBuffer;
  const ciphertext = ctRaw.slice().buffer as ArrayBuffer;
  const key = await deriveArchiveKey(did, "decrypt");
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

/**
 * DID → safe document-id slug for the storage node.
 * `did:spacekit:user:local-dev` → `did-spacekit-user-local-dev`.
 */
export function didToArchiveSlug(did: string): string {
  return did.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
