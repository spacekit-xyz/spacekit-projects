import type { SpacekitAdapter } from "./adapter";
import {
  SYNC_TOPIC,
  type Activity, type ActivityKind, type AgentName, type Anchor,
  type Contact, type Deal, type Note, type Stage, type SyncMsg,
} from "./types";

// ------------------------------------------------------------
// Key scheme (everything the CRM owns lives under "crm/"):
//   crm/contacts/{contactId}
//   crm/deals/{dealId}
//   crm/notes/{contactId}/{noteId}
//   crm/activity/{ts}-{id}
// ------------------------------------------------------------
const K = {
  contact: (id: string) => `crm/contacts/${id}`,
  contacts: "crm/contacts/",
  deal: (id: string) => `crm/deals/${id}`,
  deals: "crm/deals/",
  note: (contactId: string, id: string) => `crm/notes/${contactId}/${id}`,
  notesOf: (contactId: string) => `crm/notes/${contactId}/`,
  notes: "crm/notes/",
  activity: (at: number, id: string) => `crm/activity/${String(at).padStart(15, "0")}-${id}`,
  activities: "crm/activity/",
};

function id(): string {
  return (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
}

/** Canonical sha-256 of a note's content — this is what gets anchored on-chain. */
export async function noteContentHash(n: Pick<Note, "id" | "contactId" | "body" | "author" | "createdAt">): Promise<string> {
  const canonical = JSON.stringify({
    id: n.id, contactId: n.contactId, body: n.body, author: n.author, createdAt: n.createdAt,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return "0x" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CrmStoreOptions {
  /** Shown as the author on notes and activity. Default "you". */
  actor?: string;
}

/**
 * CrmStore — all reads/writes go through the SpacekitAdapter.
 * Every mutation broadcasts a SyncMsg so other devices/tabs running
 * the same pkg converge without a central server.
 */
export class CrmStore {
  readonly origin = id();
  readonly actor: string;

  constructor(private sk: SpacekitAdapter, opts: CrmStoreOptions = {}) {
    this.actor = opts.actor ?? "you";
  }

  // ---- sync ------------------------------------------------
  /** Subscribe to remote changes. Returns unsubscribe. */
  onRemoteChange(cb: (msg: SyncMsg) => void): () => void {
    return this.sk.messaging.subscribe(SYNC_TOPIC, (raw) => {
      const msg = raw as SyncMsg;
      if (msg && typeof msg === "object" && msg.origin !== this.origin) cb(msg);
    });
  }

  private async broadcast(scope: SyncMsg["scope"], idv: string): Promise<void> {
    try {
      await this.sk.messaging.publish(SYNC_TOPIC, { scope, id: idv, origin: this.origin } satisfies SyncMsg);
    } catch {
      // Messaging being down must never block a local write.
    }
  }

  private async log(kind: ActivityKind, line: string, refId?: string): Promise<void> {
    const a: Activity = { id: id(), kind, line, refId, at: Date.now(), actor: this.actor };
    await this.sk.storage.put(K.activity(a.at, a.id), a);
    void this.broadcast("activity", a.id);
  }

  // ---- contacts --------------------------------------------
  async listContacts(): Promise<Contact[]> {
    const keys = await this.sk.storage.list(K.contacts);
    const out: Contact[] = [];
    for (const k of keys) {
      const c = await this.sk.storage.get<Contact>(k);
      if (c) out.push(c);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getContact(cid: string): Promise<Contact | null> {
    return this.sk.storage.get<Contact>(K.contact(cid));
  }

  async saveContact(input: Partial<Contact> & { name: string }): Promise<Contact> {
    const now = Date.now();
    const existing = input.id ? await this.getContact(input.id) : null;
    const c: Contact = {
      id: existing?.id ?? input.id ?? id(),
      name: input.name,
      org: input.org ?? existing?.org,
      role: input.role ?? existing?.role,
      email: input.email ?? existing?.email,
      skAddress: input.skAddress ?? existing?.skAddress,
      tags: input.tags ?? existing?.tags ?? [],
      enrichment: input.enrichment ?? existing?.enrichment,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.sk.storage.put(K.contact(c.id), c);
    await this.log(existing ? "contact.updated" : "contact.created",
      existing ? `Updated ${c.name}` : `Added ${c.name}`, c.id);
    void this.broadcast("contact", c.id);
    return c;
  }

  // ---- deals -----------------------------------------------
  async listDeals(): Promise<Deal[]> {
    const keys = await this.sk.storage.list(K.deals);
    const out: Deal[] = [];
    for (const k of keys) {
      const d = await this.sk.storage.get<Deal>(k);
      if (d) out.push(d);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createDeal(input: { contactId: string; title: string; valueUsd: number }): Promise<Deal> {
    const now = Date.now();
    const d: Deal = { id: id(), stage: "lead", createdAt: now, updatedAt: now, ...input };
    await this.sk.storage.put(K.deal(d.id), d);
    await this.log("deal.created", `Opened "${d.title}"`, d.id);
    void this.broadcast("deal", d.id);
    return d;
  }

  async moveDeal(dealId: string, stage: Stage): Promise<Deal | null> {
    const d = await this.sk.storage.get<Deal>(K.deal(dealId));
    if (!d || d.stage === stage) return d;
    const next: Deal = { ...d, stage, updatedAt: Date.now() };
    await this.sk.storage.put(K.deal(dealId), next);
    await this.log("deal.staged", `Moved "${d.title}" to ${stage}`, dealId);
    void this.broadcast("deal", dealId);
    return next;
  }

  // ---- notes -----------------------------------------------
  async listNotes(contactId: string): Promise<Note[]> {
    const keys = await this.sk.storage.list(K.notesOf(contactId));
    const out: Note[] = [];
    for (const k of keys) {
      const n = await this.sk.storage.get<Note>(k);
      if (n) out.push(n);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async addNote(contactId: string, body: string): Promise<Note> {
    const n: Note = { id: id(), contactId, body, author: this.actor, createdAt: Date.now() };
    await this.sk.storage.put(K.note(contactId, n.id), n);
    await this.log("note.created", "Added a note", contactId);
    void this.broadcast("note", contactId);
    return n;
  }

  /** Anchor a note's content hash on-chain and persist the proof on the note. */
  async anchorNote(note: Note): Promise<Note> {
    const contentHash = await noteContentHash(note);
    const { tx, timestamp } = await this.sk.contracts.anchor(note.id, contentHash);
    const anchor: Anchor = { tx, timestamp, contentHash };
    const next: Note = { ...note, anchor };
    await this.sk.storage.put(K.note(note.contactId, note.id), next);
    await this.log("note.anchored", "Anchored a note on-chain", note.contactId);
    void this.broadcast("note", note.contactId);
    return next;
  }

  /** Re-check a note against the chain AND against its stored content hash. */
  async verifyNote(note: Note): Promise<{ verified: boolean; tamperedLocally: boolean; tx?: string; timestamp?: number }> {
    const chain = await this.sk.contracts.verify(note.id);
    const tamperedLocally = note.anchor
      ? (await noteContentHash(note)) !== note.anchor.contentHash
      : false;
    return { verified: chain.verified && !tamperedLocally, tamperedLocally, tx: chain.tx, timestamp: chain.timestamp };
  }

  // ---- activity --------------------------------------------
  async listActivity(limit = 50): Promise<Activity[]> {
    const keys = (await this.sk.storage.list(K.activities)).sort().reverse().slice(0, limit);
    const out: Activity[] = [];
    for (const k of keys) {
      const a = await this.sk.storage.get<Activity>(k);
      if (a) out.push(a);
    }
    return out;
  }

  // ---- agents ----------------------------------------------
  async enrichContact(c: Contact): Promise<Contact> {
    const patch = await this.sk.agents.invoke<Partial<Contact>>("contact.enrich", c);
    const next = await this.saveContact({ ...c, ...patch, id: c.id, name: patch.name ?? c.name });
    await this.log("agent.ran", `Enriched ${c.name}`, c.id);
    return next;
  }

  async summarizeThread(notes: Note[]): Promise<string> {
    const r = await this.sk.agents.invoke<{ summary: string }>("thread.summarize", { notes });
    return r.summary;
  }

  async draftFollowup(contact: Contact, notes: Note[]): Promise<{ subject: string; body: string }> {
    return this.sk.agents.invoke<{ subject: string; body: string }>("followup.draft", { contact, notes });
  }

  async scoreDeal(deal: Deal, notes: Note[]): Promise<Deal> {
    const r = await this.sk.agents.invoke<{ score: number; rationale: string }>("deal.score", { deal, notes });
    const next: Deal = { ...deal, score: { value: r.score, rationale: r.rationale, at: Date.now() }, updatedAt: Date.now() };
    await this.sk.storage.put(K.deal(deal.id), next);
    await this.log("agent.ran", `Scored "${deal.title}" at ${r.score}`, deal.id);
    void this.broadcast("deal", deal.id);
    return next;
  }

  /** Send a message to a contact over SpaceKit messaging (topic = their address). */
  async messageContact(contact: Contact, subject: string, body: string): Promise<boolean> {
    if (!contact.skAddress) return false;
    await this.sk.messaging.publish(contact.skAddress, { from: this.actor, subject, body, at: Date.now() });
    await this.log("agent.ran", `Sent "${subject}" to ${contact.name}`, contact.id);
    return true;
  }
}

export type { AgentName };
