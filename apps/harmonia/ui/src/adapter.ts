import type { AgentName } from "./types";

// ============================================================
// Spacekit adapter — the only surface you need to implement
// ============================================================
export interface SpacekitAdapter {
  storage: {
    put(key: string, value: unknown): Promise<string>;   // returns content-id / hash
    get<T = unknown>(key: string): Promise<T | null>;
    list(prefix?: string): Promise<string[]>;
    delete(key: string): Promise<void>;
  };
  messaging: {
    publish(topic: string, msg: unknown): Promise<void>;
    subscribe(topic: string, cb: (msg: unknown) => void): () => void; // returns unsubscribe
  };
  contracts: {
    anchor(noteId: string, contentHash: string): Promise<{ tx: string; timestamp: number }>;
    verify(noteId: string): Promise<{ verified: boolean; timestamp?: number; tx?: string }>;
  };
  agents: {
    invoke<T = unknown>(agent: AgentName, payload: unknown): Promise<T>;
  };
}

// ============================================================
// MemoryAdapter — dev/preview implementation.
// Lets the CRM run before SpaceKit bindings are wired in, and
// doubles as the reference for adapter semantics.
// ============================================================
export class MemoryAdapter implements SpacekitAdapter {
  private kv = new Map<string, unknown>();
  private subs = new Map<string, Set<(msg: unknown) => void>>();
  private anchors = new Map<string, { tx: string; timestamp: number }>();

  storage = {
    put: async (key: string, value: unknown): Promise<string> => {
      this.kv.set(key, JSON.parse(JSON.stringify(value)));
      return `mem:${key}:${Date.now().toString(36)}`;
    },
    get: async <T = unknown>(key: string): Promise<T | null> => {
      const v = this.kv.get(key);
      return v === undefined ? null : (JSON.parse(JSON.stringify(v)) as T);
    },
    list: async (prefix?: string): Promise<string[]> => {
      const keys = [...this.kv.keys()];
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    },
    delete: async (key: string): Promise<void> => {
      this.kv.delete(key);
    },
  };

  messaging = {
    publish: async (topic: string, msg: unknown): Promise<void> => {
      const set = this.subs.get(topic);
      if (set) for (const cb of set) queueMicrotask(() => cb(msg));
    },
    subscribe: (topic: string, cb: (msg: unknown) => void): (() => void) => {
      let set = this.subs.get(topic);
      if (!set) { set = new Set(); this.subs.set(topic, set); }
      set.add(cb);
      return () => { set?.delete(cb); };
    },
  };

  contracts = {
    anchor: async (noteId: string, _contentHash: string) => {
      const rec = {
        tx: "0x" + Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map((b) => b.toString(16).padStart(2, "0")).join(""),
        timestamp: Date.now(),
      };
      this.anchors.set(noteId, rec);
      return rec;
    },
    verify: async (noteId: string) => {
      const rec = this.anchors.get(noteId);
      return rec ? { verified: true, ...rec } : { verified: false };
    },
  };

  agents = {
    invoke: async <T = unknown>(agent: AgentName, payload: unknown): Promise<T> => {
      // Canned responses so the UI is fully exercisable offline.
      switch (agent) {
        case "contact.enrich":
          return {
            enrichment: {
              summary: "Public profile found on the network. Active publisher; 3 packages in the marketplace.",
              links: ["spacekit://profile/unknown"],
              updatedAt: Date.now(),
            },
          } as T;
        case "thread.summarize":
          return { summary: "Recent notes cover pricing questions and a pilot timeline. Next step: send proposal." } as T;
        case "followup.draft": {
          const p = payload as { contact?: { name?: string } };
          return {
            subject: "Following up on our conversation",
            body: `Hi ${p.contact?.name ?? "there"},\n\nThanks for the time earlier. As discussed, I'm attaching the proposal — happy to walk through it whenever suits.\n\nBest,`,
          } as T;
        }
        case "deal.score":
          return { score: 72, rationale: "Engaged contact, budget confirmed, timeline unconfirmed." } as T;
      }
    },
  };
}
