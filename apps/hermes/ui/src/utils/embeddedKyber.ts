import { initKyber, isKyberInitialized } from "@spacekit/sdk/kyber";

type SpacekitEmbed = {
  parentOrigin?: string;
  wasmUrl?: string;
  /** Base64-encoded Kyber WASM module (injected by WebPackageFrame from packaged assets). */
  kyberWasmBase64?: string;
  assetUrls?: Record<string, string>;
};

function decodeBase64Wasm(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Resolve Kyber WASM bytes/URL for standalone vs embedded `.spkg` iframe. */
export async function resolveKyberWasmInput(): Promise<string | Uint8Array | undefined> {
  if (typeof window === "undefined") return undefined;
  const embed = (window as Window & { __SPACEKIT_EMBED__?: SpacekitEmbed }).__SPACEKIT_EMBED__;
  if (!embed) return undefined;

  if (embed.kyberWasmBase64) {
    return decodeBase64Wasm(embed.kyberWasmBase64);
  }

  if (embed.wasmUrl?.startsWith("blob:")) {
    const buf = await fetch(embed.wasmUrl).then((r) => r.arrayBuffer());
    return new Uint8Array(buf);
  }

  for (const [path, url] of Object.entries(embed.assetUrls ?? {})) {
    if (path.endsWith(".wasm") && url.startsWith("blob:")) {
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      return new Uint8Array(buf);
    }
  }

  return embed.wasmUrl;
}

/** Initialize Kyber once; safe to call from effects. */
export async function ensureEmbeddedKyber(): Promise<void> {
  if (isKyberInitialized()) return;
  const input = await resolveKyberWasmInput();
  await initKyber(input);
}