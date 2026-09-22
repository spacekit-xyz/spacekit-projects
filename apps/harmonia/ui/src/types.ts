// ============================================================
// @spacekit/crm — domain types
// ============================================================

/** Agents the CRM knows how to invoke through SpacekitAdapter.agents. */
export type AgentName =
  | "contact.enrich"      // payload: Contact            → Partial<Contact>
  | "thread.summarize"    // payload: { notes: Note[] }  → { summary: string }
  | "followup.draft"      // payload: { contact, notes } → { subject: string; body: string }
  | "deal.score";         // payload: { deal, notes }    → { score: number; rationale: string }

export type Stage = "lead" | "qualified" | "proposal" | "won" | "lost";

export const STAGES: readonly Stage[] = ["lead", "qualified", "proposal", "won", "lost"];

export const STAGE_LABEL: Record<Stage, string> = {
  lead: "Lead",
  qualified: "Qualified",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};

export interface Contact {
  id: string;
  name: string;
  org?: string;
  role?: string;
  email?: string;
  /** SpaceKit messaging address — lets you reach them over the network itself. */
  skAddress?: string;
  tags: string[];
  /** Filled by the contact.enrich agent. */
  enrichment?: { summary?: string; links?: string[]; updatedAt?: number };
  createdAt: number;
  updatedAt: number;
}

export interface Deal {
  id: string;
  contactId: string;
  title: string;
  valueUsd: number;
  stage: Stage;
  /** Filled by the deal.score agent (0–100). */
  score?: { value: number; rationale: string; at: number };
  createdAt: number;
  updatedAt: number;
}

/** Proof that a note's content existed at a point in time, anchored on-chain. */
export interface Anchor {
  tx: string;
  timestamp: number;
  /** sha-256 of the canonical note content that was anchored. */
  contentHash: string;
}

export interface Note {
  id: string;
  contactId: string;
  body: string;
  author: string;
  createdAt: number;
  anchor?: Anchor;
}

export type ActivityKind =
  | "contact.created" | "contact.updated"
  | "deal.created"    | "deal.staged"
  | "note.created"    | "note.anchored"
  | "agent.ran";

export interface Activity {
  id: string;
  kind: ActivityKind;
  /** Human-readable line, e.g. `Moved "Pilot rollout" to Proposal`. */
  line: string;
  refId?: string;
  at: number;
  actor: string;
}

/** Message broadcast on the sync topic after any local mutation. */
export interface SyncMsg {
  scope: "contact" | "deal" | "note" | "activity";
  id: string;
  /** Random id of the store instance that made the change (to skip self). */
  origin: string;
}

export const SYNC_TOPIC = "crm.sync.v1";
