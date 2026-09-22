import type { SpacekitAdapter } from "./adapter";
import { MemoryAdapter } from "./adapter";

type SdkStorage = {
  set?(key: string, value: unknown): Promise<unknown>;
  get?(key: string): Promise<unknown>;
  list?(prefix?: string): Promise<string[]>;
  delete?(key: string): Promise<unknown>;
  putRecord?(key: string, value: unknown): Promise<string>;
  getRecord?(key: string): Promise<unknown>;
  listRecords?(prefix?: string): Promise<string[]>;
  deleteRecord?(key: string): Promise<void>;
};

type SdkMessaging = {
  publish(topic: string, msg: unknown): Promise<void>;
  subscribe(topic: string, cb: (msg: unknown) => void): () => void;
};

type SdkContracts = {
  anchor(noteId: string, contentHash: string): Promise<{ tx: string; timestamp: number }>;
  verify(noteId: string): Promise<{ verified: boolean; timestamp?: number; tx?: string }>;
};

type SdkHost = {
  storage?: SdkStorage;
  messaging?: SdkMessaging;
  contracts?: SdkContracts;
};

/** Map the parent-frame SpaceKit SDK to Harmonia's SpacekitAdapter surface. */
export function createEmbedAdapter(): SpacekitAdapter {
  const sk = (window as Window & { spacekit?: SdkHost }).spacekit;
  if (!sk?.storage) {
    throw new Error("SpaceKit embed SDK is missing storage bindings.");
  }

  const { storage } = sk;
  const memory = new MemoryAdapter();

  return {
    storage: {
      put: async (key, value) => {
        if (storage.putRecord) {
          const hash = await storage.putRecord(key, value);
          return String(hash ?? key);
        }
        if (storage.set) {
          await storage.set(key, value);
          return key;
        }
        throw new Error("SpaceKit storage.put is not available");
      },
      get: async <T,>(key: string) => {
        const raw = storage.getRecord
          ? await storage.getRecord(key)
          : storage.get
            ? await storage.get(key)
            : null;
        return (raw ?? null) as T | null;
      },
      list: async (prefix) => {
        if (storage.listRecords) return storage.listRecords(prefix ?? "");
        if (storage.list) return storage.list(prefix ?? "");
        return [];
      },
      delete: async (key) => {
        if (storage.deleteRecord) await storage.deleteRecord(key);
        else if (storage.delete) await storage.delete(key);
      },
    },
    messaging: sk.messaging ?? memory.messaging,
    contracts: sk.contracts ?? memory.contracts,
    agents: memory.agents,
  };
}

export function isEmbedHost(): boolean {
  return Boolean((window as Window & { __SPACEKIT_EMBED__?: unknown }).__SPACEKIT_EMBED__);
}

export function resolveAdapter(): SpacekitAdapter {
  if (isEmbedHost() && (window as Window & { spacekit?: SdkHost }).spacekit) {
    return createEmbedAdapter();
  }
  return new MemoryAdapter();
}
