import { SpacekitClient } from "@spacekit/sdk/client";
import {
  decryptWithKyber,
  type KyberAlgorithm,
  type EncryptedData,
} from "@spacekit/sdk/kyber";
import { ensureEmbeddedKyber } from "./embeddedKyber";
import { isKyberInitialized } from "@spacekit/sdk/kyber";
import { kyberPublicKeyBase64ToHex } from "./storageUpload";

type ChallengeApiResponse = {
  success: boolean;
  challenge_id?: string;
  encrypted_challenge?: {
    kem_ciphertext_hex: string;
    nonce_hex: string;
    ciphertext_hex: string;
  };
  error?: string;
};

function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

function hexToBase64(hex: string): string {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return uint8ToBase64(out);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function resolveKyberAlgorithm(raw?: string): KyberAlgorithm {
  const s = (raw ?? "kyber1024").trim().toLowerCase().replace(/[-\s]/g, "");
  if (s === "kyber512" || s === "kyber768" || s === "kyber1024") {
    return s as KyberAlgorithm;
  }
  return "kyber1024";
}

function guessMimeFromName(name?: string): string {
  const ext = name?.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    pdf: "application/pdf",
    md: "text/markdown",
    txt: "text/plain",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Extract a storage file id from `skfile:…` or `/files/{uuid}/…` URLs. */
export function parseStorageFileRef(url: string): { fileId: string; fileName?: string } | null {
  const trimmed = url.trim();
  const sk = trimmed.match(/^skfile:([0-9a-f-]{36})(?::(.+))?$/i);
  if (sk) return { fileId: sk[1], fileName: sk[2] };
  const path = trimmed.match(/\/files\/([0-9a-f-]{36})(?:\/|$|\?)/i);
  if (path) return { fileId: path[1] };
  return null;
}

function looksLikeStorageEncryptedJson(bytes: Uint8Array): boolean {
  try {
    const obj = JSON.parse(new TextDecoder().decode(bytes)) as {
      data?: unknown;
      kem_ciphertext?: unknown;
    };
    return Array.isArray(obj.data) && Array.isArray(obj.kem_ciphertext);
  } catch {
    return false;
  }
}

function storageJsonToEncryptedData(bytes: Uint8Array): EncryptedData | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(bytes)) as {
      data?: number[];
      kem_ciphertext?: number[];
      metadata?: { algorithm?: string };
    };
    if (!Array.isArray(obj.data) || !Array.isArray(obj.kem_ciphertext)) return null;
    const dataBytes = new Uint8Array(obj.data);
    if (dataBytes.length < 13) return null;
    const nonce = dataBytes.slice(0, 12);
    const ciphertext = dataBytes.slice(12);
    const kemCiphertext = new Uint8Array(obj.kem_ciphertext);
    const algorithm = resolveKyberAlgorithm(obj.metadata?.algorithm ?? "Kyber1024");
    return {
      kemCiphertext: uint8ToBase64(kemCiphertext),
      nonce: uint8ToBase64(nonce),
      ciphertext: uint8ToBase64(ciphertext),
      algorithm,
    };
  } catch {
    return null;
  }
}

async function decryptStorageBlob(
  bytes: Uint8Array,
  secretKey: string,
): Promise<Uint8Array | null> {
  if (!looksLikeStorageEncryptedJson(bytes)) return null;
  const enc = storageJsonToEncryptedData(bytes);
  if (!enc) return null;
  try {
    return await decryptWithKyber(secretKey, enc);
  } catch {
    return null;
  }
}

/** Legacy owner-key `/files/upload` ciphertext (pre–server-envelope attachments). */
async function fetchViaChallengeCiphertext(
  storageBase: string,
  fileId: string,
  myDid: string | undefined,
  publicKey: string,
  secretKey: string,
  algorithm: KyberAlgorithm,
): Promise<Uint8Array> {
  const base = storageBase.replace(/\/$/, "");
  const challengeHeaders: Record<string, string> = {
    "requester-public-key": publicKey,
  };
  const hexPk = kyberPublicKeyBase64ToHex(publicKey);
  if (hexPk) challengeHeaders["owner-public-key"] = hexPk;
  if (myDid) challengeHeaders["requester-did"] = myDid.trim().toLowerCase();

  const challengeRes = await fetch(`${base}/files/${fileId}/challenge`, {
    headers: challengeHeaders,
  });
  if (!challengeRes.ok) {
    const text = await challengeRes.text().catch(() => "");
    throw new Error(text || `Challenge failed (${challengeRes.status})`);
  }
  const challenge = (await challengeRes.json()) as ChallengeApiResponse;
  if (!challenge.success || !challenge.challenge_id || !challenge.encrypted_challenge) {
    throw new Error(challenge.error ?? "Challenge failed");
  }

  const enc = challenge.encrypted_challenge;
  const decryptedNonce = await decryptWithKyber(secretKey, {
    kemCiphertext: hexToBase64(enc.kem_ciphertext_hex),
    nonce: hexToBase64(enc.nonce_hex),
    ciphertext: hexToBase64(enc.ciphertext_hex),
    algorithm,
  });

  const ctRes = await fetch(`${base}/files/${fileId}/ciphertext`, {
    headers: {
      "challenge-id": challenge.challenge_id,
      "challenge-response": bytesToHex(decryptedNonce),
    },
  });
  if (!ctRes.ok) {
    const text = await ctRes.text().catch(() => "");
    throw new Error(text || `Ciphertext fetch failed (${ctRes.status})`);
  }
  return new Uint8Array(await ctRes.arrayBuffer());
}

/**
 * Load a chat attachment. Tries the website-api attachment proxy first (works for all
 * participants on shared-upload files), then legacy owner-key ciphertext decrypt.
 */
export async function fetchChatAttachmentBytes(
  refUrl: string,
  storageBase: string,
  myDid?: string,
  messagingApiBase?: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const parsed = parseStorageFileRef(refUrl);
  if (!parsed) throw new Error("Invalid attachment reference");

  if (messagingApiBase) {
    const proxyUrl = `${messagingApiBase.replace(/\/$/, "")}/api/messaging/attachments/${parsed.fileId}/stream`;
    const proxyRes = await fetch(proxyUrl, {
      headers: myDid ? { "owner-did": myDid.trim().toLowerCase() } : {},
    }).catch(() => null);
    if (proxyRes?.ok) {
      const bytes = new Uint8Array(await proxyRes.arrayBuffer());
      const ct = proxyRes.headers.get("content-type") ?? "";
      return {
        bytes,
        mimeType:
          ct.startsWith("image/") || ct.startsWith("video/") || ct === "application/pdf"
            ? ct
            : guessMimeFromName(parsed.fileName),
      };
    }
  }

  if (!isKyberInitialized()) await ensureEmbeddedKyber();
  const keys = SpacekitClient.getKyberKeys();
  if (!keys?.secretKey || !keys.publicKey) {
    throw new Error("Generate PQ keys in Settings before viewing attachments.");
  }
  const algorithm = resolveKyberAlgorithm(keys.algorithm);

  try {
    const ciphertext = await fetchViaChallengeCiphertext(
      storageBase,
      parsed.fileId,
      myDid,
      keys.publicKey,
      keys.secretKey,
      algorithm,
    );
    const plain = await decryptStorageBlob(ciphertext, keys.secretKey);
    if (plain) {
      return { bytes: plain, mimeType: guessMimeFromName(parsed.fileName) };
    }
  } catch {
    /* fall through */
  }

  throw new Error(
    "Could not decrypt attachment. Re-upload with a current Hermes build, or ensure your PQ keys match the uploader.",
  );
}
