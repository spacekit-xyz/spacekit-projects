/**
 * Bearer + owner-did headers for website-api routes (`/api/did/*`, `/api/social/*`, …).
 * Embedded Hermes reads the parent session via the SDK identity bridge.
 */

const LS_SESSION = "spacekit:sessionToken";
const LS_DID = "spacekit.messaging.myDid";

function readLocalAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const did = localStorage.getItem(LS_DID) || localStorage.getItem("spacekit:identityDid") || "";
  if (did && !did.includes(":local-dev") && !did.includes(":preview:")) {
    headers["owner-did"] = did;
  }
  const token = localStorage.getItem(LS_SESSION) || "";
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function loadWebsiteAuthHeaders(
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const embedded = Boolean(window.spacekit?.identity?.authHeaders);
  if (embedded) {
    try {
      const auth = await window.spacekit!.identity!.authHeaders!();
      if (auth && typeof auth === "object") {
        return { ...(auth as Record<string, string>), ...extra };
      }
    } catch {
      /* fall through */
    }
  }
  return { ...readLocalAuthHeaders(), ...extra };
}
