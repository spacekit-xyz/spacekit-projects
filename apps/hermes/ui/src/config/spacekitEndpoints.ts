/**
 * SpaceKit service base URLs (browser).
 *
 * - **Storage** — artifacts, documents, deployments (`VITE_SPACEKIT_STORAGE_NODE_URL`).
 * - **Website API (social, messaging proxy, storage proxy)** — In Vite dev, opening the app via a
 *   LAN IP (`http://192.168.x.x:5173`) uses **same-origin** `/api/…` so the dev server can proxy to
 *   website-api on loopback (avoids `ERR_CONNECTION_REFUSED` to `:3001` from phones).
 * - **Messaging** — If `VITE_API_URL` points to **localhost** and you are not running website-api,
 *   set `VITE_USE_MESSAGING_PROXY=true` only when the API is up; otherwise the app uses the
 *   **messaging port directly** (default `http://127.0.0.1:17000`).
 * - **Marketplace / social reads** — when `VITE_API_URL` is localhost and the local API is down,
 *   catalog and directory can fall back to production (`VITE_*` overrides below).
 *
 * `VITE_SPACEKIT_STORAGE_NODE_RPC` is accepted as a legacy alias for the storage base URL.
 */

const DEFAULT_STORAGE = "http://127.0.0.1:3030";
const DEFAULT_MESSAGING = "http://127.0.0.1:17000";
const DEFAULT_PRODUCTION_API = "https://api.spacekit.xyz";

type SpacekitEmbed = {
  parentOrigin?: string;
  messagingBase?: string;
  apiBase?: string;
};

function getEmbeddedConfig(): SpacekitEmbed | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { __SPACEKIT_EMBED__?: SpacekitEmbed }).__SPACEKIT_EMBED__ ?? null;
}

/** When running inside WebPackageFrame, route website-api calls via the parent origin. */
function getEmbeddedParentOrigin(): string | null {
  const embed = getEmbeddedConfig();
  const origin = embed?.parentOrigin?.trim();
  return origin ? trimSlash(origin) : null;
}

function isDevWebsiteHost(origin: string): boolean {
  try {
    const port = new URL(origin).port;
    return port === "5173" || port === "4173";
  } catch {
    return false;
  }
}

function trimSlash(u: string): string {
  return u.replace(/\/$/, "");
}

/** True when the URL is a local dev website API (usually :3001). */
export function isLocalhostApiUrl(url: string): boolean {
  if (!url.trim()) return false;
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * When the app is opened via a LAN hostname (e.g. `http://192.168.x.x:5173`) but env still uses
 * `localhost` / `127.0.0.1` for the website API or nodes, rewrite the host so the browser reaches
 * the dev machine (same behavior as `getApiBase()` in `encryptedFetch.ts`).
 */
export function resolveBrowserApiOrigin(url: string): string {
  const u = trimSlash(url);
  if (typeof window === "undefined") return u;
  const pageHost = window.location.hostname;
  const pageIsLoopback = pageHost === "localhost" || pageHost === "127.0.0.1";
  if (pageIsLoopback) return u;
  try {
    const parsed = new URL(u);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      parsed.hostname = pageHost;
      return trimSlash(parsed.toString());
    }
  } catch {
    /* ignore */
  }
  return u;
}

/** SpaceKit Storage Node HTTP origin (no trailing slash required). */
export function getSpacekitStorageNodeUrl(): string {
  const url =
    import.meta.env.VITE_SPACEKIT_STORAGE_NODE_URL?.trim() ||
    import.meta.env.VITE_SPACEKIT_STORAGE_NODE_RPC?.trim() ||
    "";
  return url || DEFAULT_STORAGE;
}

/**
 * Storage node origin for `/api/documents/{collection}/{id}` reads and writes.
 * Always targets the storage simulator directly (same as Messaging archive) — not the
 * website-api `/api/storage` proxy, which would produce `/api/storage/api/documents/…` 404s
 * when the proxy target is misconfigured or points at production.
 */
export function getStorageDocumentsOrigin(): string {
  return resolveBrowserApiOrigin(getSpacekitStorageNodeUrl());
}

/** Build `PUT/GET /api/documents/{collection}/{id}` on the storage node. */
export function buildStorageDocumentUrl(
  storageOrigin: string,
  collection: string,
  documentId: string,
): string {
  const base = trimSlash(resolveBrowserApiOrigin(storageOrigin));
  return `${base}/api/documents/${encodeURIComponent(collection)}/${encodeURIComponent(documentId)}`;
}

/** Direct messaging node (used when not proxying through the website API). */
export function getSpacekitMessagingNodeUrl(): string {
  return (
    import.meta.env.VITE_SPACEKIT_MESSAGING_NODE_URL?.trim() ||
    import.meta.env.VITE_SPACETIME_MESSAGING_URL?.trim() ||
    ""
  ) || DEFAULT_MESSAGING;
}

/** Website API base (e.g. https://api.spacekit.xyz) without trailing slash. */
export function getSpacekitApiBaseUrl(): string {
  return trimSlash(
    import.meta.env.VITE_API_URL?.trim() ||
      import.meta.env.VITE_API_BASE?.trim() ||
      import.meta.env.VITE_SPACEKIT_API_BASE?.trim() ||
      ""
  );
}

/**
 * Origin the browser uses for website-api routes (`/api/social`, `/api/messaging`, `/api/storage`, …).
 * In **Vite dev**, if the page is opened via a LAN host (e.g. `http://192.168.x.x:5173`) and the
 * configured API is reachable only on the dev machine (`localhost` / `127.0.0.1`, or **same LAN
 * hostname** as the page with a different port such as `:3001`), returns the **Vite dev server**
 * origin so requests use `http://…:5173/api/…` and Vite proxies to website-api on loopback.
 * On `localhost` / `127.0.0.1` pages, still uses `VITE_API_URL` directly (no proxy).
 *
 * @param overrideApiUrl — optional base (e.g. `VITE_SOCIAL_API_URL`) instead of `getSpacekitApiBaseUrl()`.
 */
export function getWebsiteApiBrowserOrigin(overrideApiUrl?: string): string {
  const embeddedParent = getEmbeddedParentOrigin();
  if (embeddedParent) {
    return embeddedParent;
  }

  const api = trimSlash(
    overrideApiUrl?.trim() || getSpacekitApiBaseUrl()
  );
  if (!api) return "";
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const pageHost = window.location.hostname;
    const pageIsLoopback =
      pageHost === "localhost" || pageHost === "127.0.0.1";
    if (!pageIsLoopback) {
      try {
        const parsed = new URL(api);
        const apiHost = parsed.hostname;
        const apiIsLoopback =
          apiHost === "localhost" || apiHost === "127.0.0.1";
        const sameHostAsPage = apiHost === pageHost;
        if (apiIsLoopback || sameHostAsPage) {
          return trimSlash(window.location.origin);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return resolveBrowserApiOrigin(api);
}

const MESSAGING_PROXY_SUFFIX = "/api/messaging";

/**
 * True when `base` is the website-api messaging proxy (`{origin}/api/messaging`).
 * In that case resource paths are `/messages/...` (proxied as `{node}/messages/...`), not
 * `/api/messages/...` (which would duplicate `api` in the browser URL and break some setups).
 */
export function isMessagingProxyBaseUrl(base: string): boolean {
  return trimSlash(base).endsWith(MESSAGING_PROXY_SUFFIX);
}

/**
 * Base URL for messaging HTTP.
 * - **Proxy** (returns `{api}/api/messaging`): use {@link getMessagingEnvelopeUrl} /
 *   {@link getMessagingStreamUrl} for correct paths.
 * - **Direct node**: same helpers resolve to `{node}/api/messages/...`.
 * - **Production** (`VITE_API_URL` is a real host): use `{api}/api/messaging` unless
 *   `VITE_USE_MESSAGING_PROXY` is `"false"`.
 * - **Local** (`VITE_API_URL` is localhost): use proxy **only** if `VITE_USE_MESSAGING_PROXY` is
 *   explicitly `"true"` (website-api is running). Otherwise go **direct** to the messaging
 *   simulator port so `ERR_CONNECTION_REFUSED` on :3001 does not break chat.
 */
export function getMessagingHttpBase(): string {
  const embedMessaging = getEmbeddedConfig()?.messagingBase?.trim();
  if (embedMessaging) return trimSlash(embedMessaging);

  const embeddedParent = getEmbeddedParentOrigin();
  const proxyFalse = import.meta.env.VITE_USE_MESSAGING_PROXY === "false";
  if (embeddedParent && isDevWebsiteHost(embeddedParent) && !proxyFalse) {
    return `${embeddedParent}${MESSAGING_PROXY_SUFFIX}`;
  }

  const api = getSpacekitApiBaseUrl();
  const proxyTrue = import.meta.env.VITE_USE_MESSAGING_PROXY === "true";

  if (api && !isLocalhostApiUrl(api)) {
    if (proxyFalse) {
      return resolveBrowserApiOrigin(getSpacekitMessagingNodeUrl());
    }
    return `${getWebsiteApiBrowserOrigin()}${MESSAGING_PROXY_SUFFIX}`;
  }

  if (api && isLocalhostApiUrl(api) && proxyTrue) {
    return `${getWebsiteApiBrowserOrigin()}${MESSAGING_PROXY_SUFFIX}`;
  }

  return resolveBrowserApiOrigin(getSpacekitMessagingNodeUrl());
}

/** POST chat envelope — correct path for proxy vs direct messaging base. */
export function getMessagingEnvelopeUrl(base?: string): string {
  const b = trimSlash(base ?? getMessagingHttpBase());
  if (isMessagingProxyBaseUrl(b)) {
    return `${b}/messages/envelope`;
  }
  return `${b}/api/messages/envelope`;
}

/** Website API origin for `/api/messaging/transcript-backup` (strip proxy suffix). */
export function getMessagingWebsiteApiBase(): string {
  const b = trimSlash(getMessagingHttpBase());
  const suffix = MESSAGING_PROXY_SUFFIX.replace(/\/$/, "");
  if (b.endsWith(suffix)) {
    return b.slice(0, -suffix.length);
  }
  if (b.endsWith("/api/messaging")) {
    return b.slice(0, -"/api/messaging".length);
  }
  return getWebsiteApiBrowserOrigin();
}

/** POST delete message — correct path for proxy vs direct messaging base. */
export function getMessagingDeleteUrl(base?: string): string {
  const b = trimSlash(base ?? getMessagingHttpBase());
  if (isMessagingProxyBaseUrl(b)) {
    return `${b}/messages/delete`;
  }
  return `${b}/api/messages/delete`;
}

/** SSE stream URL; includes `?did=` when `did` is non-empty. */
export function getMessagingStreamUrl(did: string, base?: string): string {
  const b = trimSlash(base ?? getMessagingHttpBase());
  const path = isMessagingProxyBaseUrl(b)
    ? `${b}/messages/stream`
    : `${b}/api/messages/stream`;
  const q = did ? `?did=${encodeURIComponent(did)}` : "";
  return `${path}${q}`;
}

/**
 * Public **read** API for marketplace catalog (`/api/marketplace/...`).
 * If `VITE_API_URL` is only localhost and you are not running the local API, falls back to
 * `VITE_MARKETPLACE_API_URL` or `https://api.spacekit.xyz` so the page still loads a catalog.
 */
export function getMarketplaceApiBase(): string {
  const explicit = import.meta.env.VITE_MARKETPLACE_API_URL?.trim();
  if (explicit) return trimSlash(explicit);
  const api = getSpacekitApiBaseUrl();
  if (api && !isLocalhostApiUrl(api)) {
    return getWebsiteApiBrowserOrigin();
  }
  if (api && isLocalhostApiUrl(api)) {
    if (import.meta.env.VITE_MARKETPLACE_USE_LOCAL_API === "true") {
      return getWebsiteApiBrowserOrigin();
    }
  }
  return trimSlash(
    import.meta.env.VITE_PRODUCTION_API_URL?.trim() || DEFAULT_PRODUCTION_API
  );
}

/**
 * Base URL for SpaceTime document storage fetches (`…/api/documents/...`).
 * Defaults to the **storage simulator** (`VITE_SPACEKIT_STORAGE_NODE_URL`) when the website API
 * is not in use on localhost.
 */
export function getSpaceTimeStorageBase(): string {
  const explicit = import.meta.env.VITE_SPACETIME_STORAGE_URL?.trim();
  if (explicit) return trimSlash(explicit);
  const api = getSpacekitApiBaseUrl();
  if (api && !isLocalhostApiUrl(api)) {
    return `${getWebsiteApiBrowserOrigin()}/api/storage`;
  }
  if (api && isLocalhostApiUrl(api) && import.meta.env.VITE_SPACETIME_USE_STORAGE_PROXY === "true") {
    return `${getWebsiteApiBrowserOrigin()}/api/storage`;
  }
  return getSpacekitStorageNodeUrl();
}

/**
 * Storage origin for chat attachment uploads (`POST /files/upload`).
 * Embedded `.spkg` apps must use the website-api `/api/storage` proxy (blob iframes cannot reach :3030).
 */
export function getChatAttachmentStorageBase(embedded: boolean): string {
  if (embedded) {
    const parent = getEmbeddedParentOrigin();
    if (parent) {
      return `${trimSlash(parent)}/api/storage`;
    }
    const api = getWebsiteApiBrowserOrigin();
    if (api) return `${trimSlash(api)}/api/storage`;
  }
  return trimSlash(resolveBrowserApiOrigin(getSpaceTimeStorageBase()));
}

/**
 * Base URL for **social directory** (`GET/POST` `/api/social/...`).
 * - Use local website API when `VITE_SOCIAL_USE_LOCAL_API === "true"`, or when it is unset and
 *   you already proxy messaging through localhost (`VITE_USE_MESSAGING_PROXY=true` + `VITE_API_URL`
 *   on localhost) so directory/register matches the same stack.
 * - Set `VITE_SOCIAL_USE_LOCAL_API=false` to force production directory while keeping other local settings.
 */
export function getSocialDirectoryApiBase(): string {
  const embedApi = getEmbeddedConfig()?.apiBase?.trim();
  if (embedApi) return trimSlash(embedApi);

  const explicit = import.meta.env.VITE_SOCIAL_API_URL?.trim();
  if (explicit) return getWebsiteApiBrowserOrigin(trimSlash(explicit));
  const api = getSpacekitApiBaseUrl();
  const socialFlag = import.meta.env.VITE_SOCIAL_USE_LOCAL_API;
  const useLocalSocial =
    socialFlag === "true" ||
    (socialFlag !== "false" &&
      import.meta.env.VITE_USE_MESSAGING_PROXY === "true" &&
      api !== "" &&
      isLocalhostApiUrl(api));
  if (api && isLocalhostApiUrl(api) && useLocalSocial) {
    return getWebsiteApiBrowserOrigin();
  }
  if (api && !isLocalhostApiUrl(api)) {
    return getWebsiteApiBrowserOrigin();
  }
  return getWebsiteApiBrowserOrigin(
    import.meta.env.VITE_PRODUCTION_API_URL?.trim() || DEFAULT_PRODUCTION_API,
  );
}
