import { isKyberInitialized } from "@spacekit/sdk/kyber";
import { ensureEmbeddedKyber } from "./embeddedKyber";

function attachmentTagForFile(file: File): string {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (file.type.startsWith("image/")) return "img";
  if (file.type.startsWith("video/")) return "video";
  if (file.type === "application/pdf" || ext === "pdf") return "pdf";
  if (["md", "markdown"].includes(ext)) return "md";
  return "file";
}

/**
 * Upload a chat attachment as a **server-envelope** (`POST /files/shared-upload`).
 * The storage node encrypts to its own Kyber key so any participant with PQ keys can
 * challenge+stream+decrypt, and ops can admin-stream after server key rotation re-wrap.
 */
export async function uploadChatAttachment(
  file: File,
  myDid: string,
  storageBase: string,
): Promise<string> {
  if (!isKyberInitialized()) {
    await ensureEmbeddedKyber();
  }

  const res = await fetch(`${storageBase.replace(/\/$/, "")}/files/shared-upload`, {
    method: "POST",
    headers: {
      "owner-did": myDid.trim().toLowerCase(),
      filename: file.name,
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let msg = errText.trim();
    try {
      const j = JSON.parse(errText) as { error?: string };
      if (j.error) msg = j.error;
    } catch { /* use raw text */ }
    throw new Error(msg || `Upload failed: ${res.status}`);
  }

  const data = await res.json() as { file_id?: string };
  if (!data.file_id) throw new Error("Upload failed: no file_id");
  const tag = attachmentTagForFile(file);
  return `[${tag}:${file.name}](skfile:${data.file_id})`;
}

/** Kyber public keys in the SDK are base64; the storage node expects hex-encoded raw bytes. */
export function kyberPublicKeyBase64ToHex(publicKeyBase64: string): string {
  const bin = atob(publicKeyBase64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
