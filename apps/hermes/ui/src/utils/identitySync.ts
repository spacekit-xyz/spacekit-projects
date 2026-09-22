/**
 * Unified identity — embedded Hermes reads/writes parent localStorage via SDK bridge.
 */

export type IdentitySnapshot = {
  myDid: string;
  displayName: string;
  publicOptIn: boolean;
  didRegistered: boolean;
};

const LS_DID = "spacekit.messaging.myDid";
const LS_NAME = "spacekit.messaging.displayName";
const LS_REGISTERED = "spacekit.messaging.didRegistered";
const LS_PUBLIC = "spacekit.messaging.publicOptIn";

function isEmbedded(): boolean {
  return typeof window !== "undefined" && Boolean((window as Window & { spacekit?: { identity?: { getState?: () => Promise<IdentitySnapshot> } } }).spacekit?.identity?.getState);
}

function readLocalSnapshot(): IdentitySnapshot {
  return {
    myDid: localStorage.getItem(LS_DID) || "did:spacekit:user:local-dev",
    displayName: localStorage.getItem(LS_NAME) || "",
    publicOptIn: localStorage.getItem(LS_PUBLIC) === "1",
    didRegistered: localStorage.getItem(LS_REGISTERED) === "1",
  };
}

export async function loadIdentitySnapshot(): Promise<IdentitySnapshot> {
  if (isEmbedded()) {
    try {
      const state = await window.spacekit!.identity!.getState!();
      if (state?.myDid) return state;
    } catch {
      /* fall through */
    }
  }
  return readLocalSnapshot();
}

export async function persistIdentitySnapshot(partial: Partial<IdentitySnapshot>): Promise<IdentitySnapshot> {
  if (isEmbedded()) {
    try {
      const state = await window.spacekit!.identity!.setState!(partial);
      if (state?.myDid) return state;
    } catch {
      /* fall through */
    }
  }
  const next = { ...readLocalSnapshot(), ...partial };
  localStorage.setItem(LS_DID, next.myDid);
  localStorage.setItem(LS_NAME, next.displayName);
  localStorage.setItem(LS_PUBLIC, next.publicOptIn ? "1" : "0");
  localStorage.setItem(LS_REGISTERED, next.didRegistered ? "1" : "0");
  return next;
}

export function subscribeIdentityChanges(onChange: (state: IdentitySnapshot) => void): () => void {
  const onMessage = (e: MessageEvent) => {
    if (e.data?.type === "spacekit-identity-changed" && e.data.state) {
      onChange(e.data.state as IdentitySnapshot);
    }
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

declare global {
  interface Window {
    spacekit?: {
      identity?: {
        did?: () => Promise<string>;
        getState?: () => Promise<IdentitySnapshot>;
        setState?: (partial: Partial<IdentitySnapshot>) => Promise<IdentitySnapshot>;
        authHeaders?: () => Promise<Record<string, string>>;
      };
    };
  }
}

export {};
