import { useEffect, useMemo, useState } from "react";
import type { SpacekitAdapter } from "../adapter";
import { useCrm } from "../useCrm";
import type { Contact, Deal, Note, Stage } from "../types";
import { STAGES, STAGE_LABEL } from "../types";
import { AnchorSeal, Btn, Empty, T, Tag, fmtUsd, styles, timeAgo } from "./ui";

type View = "contacts" | "pipeline" | "activity";

function useIsMobile(breakpoint = 768): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(`(max-width: ${breakpoint}px)`).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [breakpoint]);
  return mobile;
}

export interface CRMProps {
  /** Your SpaceKit bindings. Use MemoryAdapter while developing. */
  adapter: SpacekitAdapter;
  /** Display name used as note author / activity actor. */
  actor?: string;
  /** Fill the host pane edge-to-edge (SpaceKit website embed). */
  embedded?: boolean;
}

/**
 * <CRM/> — the whole app. Mount it as the root of your webapp,
 * `npm run build`, package dist/ as CRM.pkg, publish to the marketplace.
 */
export function CRM({ adapter, actor, embedded = false }: CRMProps) {
  const crm = useCrm(adapter, actor);
  const mobile = useIsMobile();
  const [view, setView] = useState<View>("contacts");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = crm.contacts.find((c) => c.id === selectedId) ?? null;

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%", minHeight: embedded ? 0 : 560,
      background: T.bg, color: T.ink, fontFamily: T.sans, borderRadius: embedded ? 0 : 14, overflow: "hidden",
      border: embedded ? "none" : `1px solid ${T.line}`,
    }}>
      <style>{`
        @media (max-width: 768px) {
          .harmonia-header { flex-wrap: wrap; gap: 10px !important; padding: 10px 12px !important; }
          .harmonia-header nav { margin-left: 0 !important; width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
          .harmonia-header nav button { flex: 1; min-width: 88px; min-height: 40px; }
          .harmonia-header-tagline { display: none !important; }
          .harmonia-contacts-grid { grid-template-columns: 1fr !important; }
          .harmonia-contacts-list { border-right: none !important; border-bottom: 1px solid ${T.line}; max-height: 42vh; }
          .harmonia-contacts-list--solo { max-height: none; border-bottom: none; }
          .harmonia-search-row { flex-direction: column; align-items: stretch !important; }
          .harmonia-search-row input { width: 100%; min-height: 44px; font-size: 16px; }
          .harmonia-search-row button { width: 100%; min-height: 44px; }
          .harmonia-detail { padding: 14px !important; }
          .harmonia-note-row { flex-direction: column !important; align-items: stretch !important; }
          .harmonia-note-row input { min-height: 44px; font-size: 16px; }
          .harmonia-note-row button { width: 100%; min-height: 44px; }
          .harmonia-pipeline-grid { grid-template-columns: repeat(${STAGES.length}, minmax(220px, 1fr)) !important; }
        }
      `}</style>
      <header className="harmonia-header" style={{
        display: "flex", alignItems: "center", gap: 16, padding: "12px 18px",
        borderBottom: `1px solid ${T.line}`, background: T.panel,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexShrink: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Relations</span>
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.teal, letterSpacing: "0.1em" }}>
            ON SPACEKIT
          </span>
        </div>
        <nav style={{ display: "flex", gap: 4, marginLeft: 12 }} aria-label="Sections">
          {(["contacts", "pipeline", "activity"] as const).map((v) => (
            <button
              key={v}
              onClick={() => { setView(v); if (v !== "contacts") setSelectedId(null); }}
              style={{
                background: view === v ? T.panelRaised : "transparent",
                border: `1px solid ${view === v ? T.line : "transparent"}`,
                color: view === v ? T.ink : T.dim, borderRadius: 8,
                padding: "6px 12px", fontSize: 13, cursor: "pointer", fontFamily: T.sans,
              }}
            >
              {v === "contacts" ? "Contacts" : v === "pipeline" ? "Pipeline" : "Activity"}
            </button>
          ))}
        </nav>
        <div className="harmonia-header-tagline" style={{ marginLeft: "auto", fontSize: 11, color: T.faint }}>
          Your data stays in your SpaceKit storage
        </div>
      </header>

      {crm.error && (
        <div style={{
          padding: "8px 18px", background: `${T.red}14`, color: T.red, fontSize: 12,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span>{crm.error}</span>
          <Btn small onClick={crm.clearError}>Dismiss</Btn>
        </div>
      )}

      <main style={{ flex: 1, overflow: "auto" }}>
        {crm.loading ? (
          <Empty title="Loading your workspace" hint="Reading contacts, deals, and notes from storage" />
        ) : view === "contacts" ? (
          <ContactsView
            crm={crm}
            selected={selected}
            onSelect={setSelectedId}
            mobile={mobile}
          />
        ) : view === "pipeline" ? (
          <PipelineView crm={crm} onOpenContact={(cid) => { setSelectedId(cid); setView("contacts"); }} />
        ) : (
          <ActivityView crm={crm} />
        )}
      </main>
    </div>
  );
}

// ============================================================
// Contacts
// ============================================================
function ContactsView({ crm, selected, onSelect, mobile }: {
  crm: ReturnType<typeof useCrm>; selected: Contact | null; onSelect: (id: string | null) => void; mobile: boolean;
}) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return crm.contacts;
    return crm.contacts.filter((c) =>
      [c.name, c.org, c.email, ...c.tags].filter(Boolean).some((s) => s!.toLowerCase().includes(q)),
    );
  }, [crm.contacts, query]);

  const showList = !mobile || (!selected && !adding);
  const showDetail = !mobile || !!selected || adding;

  return (
    <div className="harmonia-contacts-grid" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 320px) 1fr", height: "100%" }}>
      {showList ? (
      <div className={`harmonia-contacts-list${showDetail && mobile ? "" : " harmonia-contacts-list--solo"}`} style={{ borderRight: `1px solid ${T.line}`, display: "flex", flexDirection: "column" }}>
        <div className="harmonia-search-row" style={{ padding: 12, display: "flex", gap: 8 }}>
          <input
            style={styles.input}
            placeholder="Search contacts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search contacts"
          />
          <Btn kind="primary" onClick={() => { setAdding(true); onSelect(null); }}>Add</Btn>
        </div>
        <div style={{ overflow: "auto", flex: 1, WebkitOverflowScrolling: "touch" }}>
          {filtered.length === 0 ? (
            <Empty title="No contacts yet" hint='Use "Add" to create your first contact' />
          ) : filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => { setAdding(false); onSelect(c.id); }}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "12px 14px",
                background: selected?.id === c.id ? T.panelRaised : "transparent",
                border: "none", borderBottom: `1px solid ${T.line}`,
                color: T.ink, cursor: "pointer", fontFamily: T.sans,
                minHeight: 44,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
              <div style={{ fontSize: 11, color: T.dim, marginTop: 2 }}>
                {[c.role, c.org].filter(Boolean).join(" · ") || c.email || "—"}
              </div>
            </button>
          ))}
        </div>
      </div>
      ) : null}

      {showDetail ? (
      <div className="harmonia-detail" style={{ overflow: "auto", WebkitOverflowScrolling: "touch" }}>
        {mobile && (selected || adding) ? (
          <div style={{ padding: "10px 14px 0" }}>
            <Btn small onClick={() => { setAdding(false); onSelect(null); }}>← Back to contacts</Btn>
          </div>
        ) : null}
        {adding ? (
          <ContactForm crm={crm} onDone={(id) => { setAdding(false); onSelect(id); }} onCancel={() => setAdding(false)} />
        ) : selected ? (
          <ContactDetail key={selected.id} crm={crm} contact={selected} mobile={mobile} />
        ) : (
          <Empty title="Pick a contact" hint="Select someone on the left, or add a new contact" />
        )}
      </div>
      ) : null}
    </div>
  );
}

function ContactForm({ crm, onDone, onCancel }: {
  crm: ReturnType<typeof useCrm>; onDone: (id: string) => void; onCancel: () => void;
}) {
  const [f, setF] = useState({ name: "", org: "", role: "", email: "", skAddress: "", tags: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  const save = async () => {
    if (!f.name.trim()) return;
    setBusy(true);
    try {
      const c = await crm.store.saveContact({
        name: f.name.trim(), org: f.org || undefined, role: f.role || undefined,
        email: f.email || undefined, skAddress: f.skAddress || undefined,
        tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      await crm.refresh();
      onDone(c.id);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ padding: 20, maxWidth: 480, display: "grid", gap: 12 }}>
      <div style={{ fontSize: 15, fontWeight: 700 }}>New contact</div>
      {([
        ["name", "Name", "Ada Okafor"],
        ["org", "Organization", "Lumen Audio"],
        ["role", "Role", "Head of Distribution"],
        ["email", "Email", "ada@lumen.audio"],
        ["skAddress", "SpaceKit address", "sk:ada.lumen"],
        ["tags", "Tags (comma-separated)", "music, partner"],
      ] as const).map(([k, label, ph]) => (
        <label key={k} style={{ display: "grid", gap: 4 }}>
          <span style={styles.label}>{label}</span>
          <input style={styles.input} value={f[k]} onChange={set(k)} placeholder={ph} />
        </label>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn kind="primary" onClick={() => void save()} disabled={busy || !f.name.trim()}>
          {busy ? "Saving…" : "Save contact"}
        </Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}

// ============================================================
// Contact detail: profile, agents, notes with anchoring
// ============================================================
function ContactDetail({ crm, contact, mobile = false }: { crm: ReturnType<typeof useCrm>; contact: Contact; mobile?: boolean }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [followup, setFollowup] = useState<{ subject: string; body: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, "verified" | "tampered">>({});

  const loadNotes = async () => setNotes(await crm.store.listNotes(contact.id));
  useEffect(() => { void loadNotes(); /* eslint-disable-next-line */ }, [contact.id]);
  useEffect(() => crm.store.onRemoteChange((m) => { if (m.scope === "note" && m.id === contact.id) void loadNotes(); }),
    /* eslint-disable-next-line */ [contact.id]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await fn(); } catch (e) {
      setSummary(e instanceof Error ? `Agent failed: ${e.message}` : "Agent failed. Try again.");
    } finally { setBusy(null); }
  };

  const deals = crm.deals.filter((d) => d.contactId === contact.id);

  return (
    <div style={{ padding: mobile ? 14 : 20, display: "grid", gap: 16, maxWidth: 760 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{contact.name}</div>
          <div style={{ fontSize: 12, color: T.dim, marginTop: 2 }}>
            {[contact.role, contact.org].filter(Boolean).join(" · ") || "No role set"}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {contact.email && <Tag>{contact.email}</Tag>}
            {contact.skAddress && <Tag color={T.teal}>{contact.skAddress}</Tag>}
            {contact.tags.map((t) => <Tag key={t}>{t}</Tag>)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn small onClick={() => void run("enrich", async () => { await crm.store.enrichContact(contact); await crm.refresh(); })}
            disabled={busy !== null} title="Ask the network's enrichment agent for public context">
            {busy === "enrich" ? "Enriching…" : "Enrich"}
          </Btn>
          <Btn small onClick={() => void run("summarize", async () => setSummary(await crm.store.summarizeThread(notes)))}
            disabled={busy !== null || notes.length === 0}>
            {busy === "summarize" ? "Summarizing…" : "Summarize notes"}
          </Btn>
          <Btn small onClick={() => void run("draft", async () => setFollowup(await crm.store.draftFollowup(contact, notes)))}
            disabled={busy !== null}>
            {busy === "draft" ? "Drafting…" : "Draft follow-up"}
          </Btn>
        </div>
      </div>

      {contact.enrichment?.summary && (
        <div style={{ ...styles.card, borderColor: `${T.violet}55` }}>
          <span style={{ ...styles.label, color: T.violet }}>Agent enrichment</span>
          <div style={{ fontSize: 13, marginTop: 6, color: T.ink }}>{contact.enrichment.summary}</div>
        </div>
      )}
      {summary && (
        <div style={styles.card}>
          <span style={styles.label}>Thread summary</span>
          <div style={{ fontSize: 13, marginTop: 6 }}>{summary}</div>
        </div>
      )}
      {followup && (
        <div style={styles.card}>
          <span style={styles.label}>Draft follow-up</span>
          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6 }}>{followup.subject}</div>
          <pre style={{ fontSize: 12, color: T.dim, whiteSpace: "pre-wrap", fontFamily: T.sans, margin: "6px 0 10px" }}>
            {followup.body}
          </pre>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn small kind="primary"
              disabled={!contact.skAddress || busy !== null}
              title={contact.skAddress ? `Send over SpaceKit messaging to ${contact.skAddress}` : "Add a SpaceKit address to send"}
              onClick={() => void run("send", async () => {
                await crm.store.messageContact(contact, followup.subject, followup.body);
                setFollowup(null); await crm.refresh();
              })}>
              {busy === "send" ? "Sending…" : "Send via SpaceKit"}
            </Btn>
            <Btn small onClick={() => setFollowup(null)}>Discard</Btn>
          </div>
        </div>
      )}

      {deals.length > 0 && (
        <div style={styles.card}>
          <span style={styles.label}>Deals</span>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {deals.map((d) => (
              <div key={d.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span>{d.title}</span>
                <span style={{ color: T.dim }}>{fmtUsd(d.valueUsd)} · {STAGE_LABEL[d.stage]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <span style={styles.label}>Notes</span>
        <div className="harmonia-note-row" style={{ display: "flex", gap: 8, margin: "8px 0 12px" }}>
          <input
            style={styles.input}
            placeholder={`Note about ${contact.name}…`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { void crm.store.addNote(contact.id, draft.trim()).then(loadNotes); setDraft(""); } }}
            aria-label="New note"
          />
          <Btn kind="primary" disabled={!draft.trim()}
            onClick={() => { void crm.store.addNote(contact.id, draft.trim()).then(loadNotes); setDraft(""); }}>
            Add note
          </Btn>
        </div>

        {notes.length === 0 ? (
          <Empty title="No notes yet" hint="Notes can be anchored on-chain to prove when they were written" />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {notes.map((n) => {
              const verdict = verdicts[n.id];
              return (
                <div key={n.id} style={styles.card}>
                  <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{n.body}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: T.faint }}>{n.author} · {timeAgo(n.createdAt)}</span>
                    {n.anchor ? (
                      <>
                        <AnchorSeal tx={n.anchor.tx} timestamp={n.anchor.timestamp}
                          state={verdict ?? "anchored"} />
                        <Btn small disabled={busy !== null}
                          onClick={() => void run("verify", async () => {
                            const r = await crm.store.verifyNote(n);
                            setVerdicts((p) => ({ ...p, [n.id]: r.verified ? "verified" : "tampered" }));
                          })}>
                          Verify
                        </Btn>
                      </>
                    ) : (
                      <Btn small disabled={busy !== null}
                        title="Write this note's content hash to the chain — proof it existed now"
                        onClick={() => void run("anchor", async () => { await crm.store.anchorNote(n); await loadNotes(); })}>
                        Anchor on-chain
                      </Btn>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Pipeline (kanban)
// ============================================================
function PipelineView({ crm, onOpenContact }: {
  crm: ReturnType<typeof useCrm>; onOpenContact: (contactId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ contactId: "", title: "", valueUsd: "" });
  const [busy, setBusy] = useState(false);
  const byStage = (s: Stage) => crm.deals.filter((d) => d.stage === s);
  const nameOf = (cid: string) => crm.contacts.find((c) => c.id === cid)?.name ?? "Unknown";

  const create = async () => {
    const value = Number(f.valueUsd);
    if (!f.contactId || !f.title.trim() || !Number.isFinite(value) || value < 0) return;
    setBusy(true);
    try {
      await crm.store.createDeal({ contactId: f.contactId, title: f.title.trim(), valueUsd: value });
      await crm.refresh();
      setAdding(false); setF({ contactId: "", title: "", valueUsd: "" });
    } finally { setBusy(false); }
  };

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={styles.label}>Pipeline · {crm.deals.length} deals · {fmtUsd(crm.deals.filter((d) => d.stage !== "lost").reduce((s, d) => s + d.valueUsd, 0))} open</span>
        <Btn kind="primary" small onClick={() => setAdding((v) => !v)} disabled={crm.contacts.length === 0}
          title={crm.contacts.length === 0 ? "Add a contact first" : undefined}>
          {adding ? "Close" : "New deal"}
        </Btn>
      </div>

      {adding && (
        <div style={{ ...styles.card, display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
          <select style={{ ...styles.input, width: 200 }} value={f.contactId}
            onChange={(e) => setF((p) => ({ ...p, contactId: e.target.value }))} aria-label="Deal contact">
            <option value="">Contact…</option>
            {crm.contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input style={{ ...styles.input, width: 220 }} placeholder="Deal title" value={f.title}
            onChange={(e) => setF((p) => ({ ...p, title: e.target.value }))} />
          <input style={{ ...styles.input, width: 120 }} placeholder="Value (USD)" inputMode="decimal" value={f.valueUsd}
            onChange={(e) => setF((p) => ({ ...p, valueUsd: e.target.value }))} />
          <Btn kind="primary" small onClick={() => void create()} disabled={busy}>Create deal</Btn>
        </div>
      )}

      <div className="harmonia-pipeline-grid" style={{ display: "grid", gridTemplateColumns: `repeat(${STAGES.length}, minmax(180px, 1fr))`, gap: 10, overflowX: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 4 }}>
        {STAGES.map((s) => (
          <div key={s} style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 12, padding: 10, minHeight: 200 }}>
            <div style={{ ...styles.label, color: s === "won" ? T.teal : s === "lost" ? T.red : T.faint, marginBottom: 8 }}>
              {STAGE_LABEL[s]} · {byStage(s).length}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {byStage(s).map((d) => <DealCard key={d.id} deal={d} crm={crm} contactName={nameOf(d.contactId)} onOpenContact={onOpenContact} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DealCard({ deal, crm, contactName, onOpenContact }: {
  deal: Deal; crm: ReturnType<typeof useCrm>; contactName: string; onOpenContact: (cid: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const move = async (s: Stage) => {
    setBusy(true);
    try { await crm.store.moveDeal(deal.id, s); await crm.refresh(); } finally { setBusy(false); }
  };
  const score = async () => {
    setBusy(true);
    try {
      const notes = await crm.store.listNotes(deal.contactId);
      await crm.store.scoreDeal(deal, notes);
      await crm.refresh();
    } finally { setBusy(false); }
  };

  return (
    <div style={{ background: T.panelRaised, border: `1px solid ${T.line}`, borderRadius: 10, padding: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{deal.title}</div>
      <button onClick={() => onOpenContact(deal.contactId)}
        style={{ background: "none", border: "none", color: T.teal, fontSize: 11, cursor: "pointer", padding: 0, marginTop: 2, fontFamily: T.sans }}>
        {contactName}
      </button>
      <div style={{ fontSize: 12, color: T.dim, marginTop: 4 }}>{fmtUsd(deal.valueUsd)}</div>
      {deal.score && (
        <div title={deal.score.rationale} style={{ marginTop: 6 }}>
          <Tag color={deal.score.value >= 60 ? T.teal : T.amber}>Score {deal.score.value}/100</Tag>
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        <select
          aria-label="Move deal stage"
          style={{ ...styles.input, width: "auto", padding: "4px 6px", fontSize: 11 }}
          value={deal.stage}
          disabled={busy}
          onChange={(e) => void move(e.target.value as Stage)}
        >
          {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
        <Btn small disabled={busy} onClick={() => void score()} title="Ask the deal-scoring agent">
          {busy ? "…" : "Score"}
        </Btn>
      </div>
    </div>
  );
}

// ============================================================
// Activity
// ============================================================
function ActivityView({ crm }: { crm: ReturnType<typeof useCrm> }) {
  if (crm.activity.length === 0) {
    return <Empty title="Nothing here yet" hint="Every change you make is logged here — and synced to your other devices" />;
  }
  return (
    <div style={{ padding: 20, maxWidth: 640 }}>
      <span style={styles.label}>Recent activity</span>
      <div style={{ marginTop: 10 }}>
        {crm.activity.map((a) => (
          <div key={a.id} style={{ display: "flex", gap: 10, padding: "8px 0", borderBottom: `1px solid ${T.line}`, fontSize: 13 }}>
            <span style={{ color: a.kind === "note.anchored" ? T.teal : a.kind === "agent.ran" ? T.violet : T.dim, fontFamily: T.mono, fontSize: 10, paddingTop: 3, minWidth: 90 }}>
              {a.kind}
            </span>
            <span style={{ flex: 1 }}>{a.line}</span>
            <span style={{ color: T.faint, fontSize: 11, whiteSpace: "nowrap" }}>{timeAgo(a.at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
