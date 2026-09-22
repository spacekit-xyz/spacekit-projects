// NotesApp.tsx
// A notes app component built to compete with Obsidian / Evernote / OneNote / Keep,
// designed for the Spacekit blockchain network (smart contracts, storage node,
// messaging node, narrow agents).
//
// Install:
//   npm install @monaco-editor/react monaco-editor marked
//
// Usage with mock adapter (runs standalone):
//   <NotesApp />
//
// Usage with real Spacekit nodes:
//   <NotesApp adapter={mySpacekitAdapter} />

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { Monaco } from '@monaco-editor/react';
import type { editor, IPosition } from 'monaco-editor';
import { marked } from 'marked';
import { inferAutoTagsViaApi, inferLinksViaApi, inferSummaryViaApi, warmWasmAgents } from './agents/growformerAgents';
import { extractiveNoteSummary } from './agents/noteText';

/** Matches SpaceKit AuthenticatedHome appshell palette. */
const SK = {
  bg: '#0c1020',
  rail: '#0a0d18',
  panel2: '#111626',
  line: '#1d233c',
  lineSoft: '#161b30',
  ink: '#eef0f7',
  ink2: '#a6acc2',
  ink3: '#6b7390',
  gold: '#f3c879',
  goldDeep: '#e0a948',
  good: '#74e0a8',
  plasma: '#7fd7e6',
  aurora: '#9a7cff',
  font: '"Hanken Grotesk", system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
} as const;

declare global {
  interface Window {
    spacekit?: {
      appId?: string;
      storage?: {
        get: (key: string) => Promise<unknown>;
        set: (key: string, value: unknown) => Promise<unknown>;
        list?: (prefix?: string) => Promise<string[]>;
        delete?: (key: string) => Promise<unknown>;
        ready?: () => Promise<{ ready: boolean; noteCount: number }>;
      };
      messaging?: {
        publish: (topic: string, msg: unknown) => Promise<void>;
        subscribe: (topic: string, cb: (msg: unknown) => void) => () => void;
      };
      contracts?: {
        anchor: (noteId: string, contentHash: string) => Promise<{ tx: string; timestamp: number }>;
        verify: (noteId: string) => Promise<{ verified: boolean; timestamp?: number; tx?: string }>;
      };
    };
    __skTopicSubs?: Record<string, Array<{ id: string; cb: (msg: unknown) => void }>>;
  }
}

function isSpacekitEmbedded(): boolean {
  return typeof window !== 'undefined' && Boolean(window.spacekit?.storage);
}

export interface Note {
  id: string;
  title: string;
  content: string;          // markdown body
  manualTags: string[];     // tags added explicitly (in addition to inline #hashtags)
  folder?: string;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  // Spacekit provenance
  contentHash?: string;
  anchorTx?: string;        // smart-contract tx hash if anchored
  anchorTime?: number;
  // Storage node attachments
  attachments?: { name: string; cid: string; size: number }[];
}

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

export type AgentName = 'tagger' | 'summarizer' | 'linker' | 'semantic-search';

// ============================================================
// Mock adapter — works in-browser, no backend needed
// ============================================================
export function createMockSpacekitAdapter(prefix = 'spacekit'): SpacekitAdapter {
  const k = (key: string) => `${prefix}:${key}`;
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(prefix) : null;
  const subscribers = new Map<string, Set<(m: unknown) => void>>();
  channel?.addEventListener('message', (e) => {
    const { topic, msg } = e.data ?? {};
    subscribers.get(topic)?.forEach(cb => cb(msg));
  });

  return {
    storage: {
      async put(key, value) {
        const json = JSON.stringify(value);
        localStorage.setItem(k(key), json);
        return await sha256(json);
      },
      async get(key) {
        const raw = localStorage.getItem(k(key));
        return raw ? JSON.parse(raw) : null;
      },
      async list(p = '') {
        const out: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)!;
          const expected = k(p);
          if (key.startsWith(expected)) out.push(key.slice(prefix.length + 1));
        }
        return out;
      },
      async delete(key) { localStorage.removeItem(k(key)); },
    },
    messaging: {
      async publish(topic, msg) { channel?.postMessage({ topic, msg }); },
      subscribe(topic, cb) {
        if (!subscribers.has(topic)) subscribers.set(topic, new Set());
        subscribers.get(topic)!.add(cb);
        return () => subscribers.get(topic)?.delete(cb);
      },
    },
    contracts: {
      async anchor(noteId, contentHash) {
        const tx = '0x' + (await sha256(noteId + contentHash + Date.now())).slice(0, 40);
        const record = { tx, timestamp: Date.now(), contentHash };
        localStorage.setItem(k(`anchor:${noteId}`), JSON.stringify(record));
        return { tx, timestamp: record.timestamp };
      },
      async verify(noteId) {
        const raw = localStorage.getItem(k(`anchor:${noteId}`));
        if (!raw) return { verified: false };
        const r = JSON.parse(raw);
        return { verified: true, timestamp: r.timestamp, tx: r.tx };
      },
    },
    agents: { invoke: wrapAgentsWithGrowformer(mockAgents) },
  };
}

function createSpacekitSdkAdapter(appId: string): SpacekitAdapter {
  const mock = createMockSpacekitAdapter(`cairn-sdk-${appId}`);
  const sk = window.spacekit!;

  return {
    storage: {
      async put(key, value) {
        await sk.storage!.set(key, value);
        return sha256(JSON.stringify(value));
      },
      async get(key) {
        const val = await sk.storage!.get(key);
        return (val ?? null) as never;
      },
      async list(p = '') {
        if (sk.storage?.list) return sk.storage.list(p);
        return mock.storage.list(p);
      },
      async delete(key) {
        if (sk.storage?.delete) {
          await sk.storage.delete(key);
        } else {
          await sk.storage!.set(key, null);
        }
      },
    },
    messaging: sk.messaging
      ? {
          publish: (topic, msg) => sk.messaging!.publish(topic, msg),
          subscribe: (topic, cb) => sk.messaging!.subscribe(topic, cb),
        }
      : mock.messaging,
    contracts: sk.contracts
      ? {
          anchor: (noteId, contentHash) => sk.contracts!.anchor(noteId, contentHash),
          verify: (noteId) => sk.contracts!.verify(noteId),
        }
      : mock.contracts,
    agents: { invoke: wrapAgentsWithGrowformer(mockAgents) },
  };
}

function resolveAdapter(explicit?: SpacekitAdapter): SpacekitAdapter {
  if (explicit) return explicit;
  if (isSpacekitEmbedded() && window.spacekit?.appId) {
    return createSpacekitSdkAdapter(window.spacekit.appId);
  }
  return createMockSpacekitAdapter('cairn');
}

// ----- agents: growformer WASM in browser (packaged .spkg) + dev CLI proxy fallback -----
function wrapAgentsWithGrowformer(
  base: typeof mockAgents
): SpacekitAdapter['agents']['invoke'] {
  return async (agent, payload) => {
    if (agent === 'tagger') {
      const content = (payload as { content?: string }).content ?? '';
      const tags = await inferAutoTagsViaApi(content);
      if (tags) return tags;
      console.warn('[cairn] growformer tagger unavailable — using keyword mock');
    }
    if (agent === 'summarizer') {
      const content = (payload as { content?: string }).content ?? '';
      const summary = await inferSummaryViaApi(content);
      if (summary) return summary;
      console.warn('[cairn] growformer summarizer unavailable or low-confidence — using extractive fallback');
      return extractiveNoteSummary(content);
    }
    if (agent === 'linker') {
      const p = payload as { content?: string; noteId?: string; corpus?: Note[] };
      const related = await inferLinksViaApi(
        p.content ?? '',
        p.noteId ?? '',
        (p.corpus ?? []).map(n => ({ id: n.id, title: n.title, content: n.content }))
      );
      if (related) return related;
      console.warn('[cairn] growformer linker unavailable — using overlap mock');
    }
    return base(agent, payload);
  };
}

// ----- mock narrow agents (client-side heuristics; swap for real on-chain agents) -----
const STOPWORDS = new Set('the of and a to in is you that it he was for on are with as i his they be at one have this from or had by hot but some what there we can out other were all your when up use word how said an each she which do their time if will way about many then them write would like so these her long make thing see him two has look more day could go come did number sound no most people my over know water than call first who may down side been now find any new work part take get place made live where after back little only round man year came show every good me give our under name very through just form sentence great think say help low line differ turn cause much mean before move right boy old too same tell does set three want air well also play small end put home read hand port large spell add even land here must big high such follow act why ask men change went light kind off need house picture try us again animal point mother world near build self earth father'.split(' '));

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter(t => !STOPWORDS.has(t));
}

function splitSentencesNoLookbehind(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  const s = text || "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if ((ch === "." || ch === "!" || ch === "?") && (i + 1 === s.length || /\s/.test(s[i + 1]!))) {
      const chunk = s.slice(start, i + 1).trim();
      if (chunk) parts.push(chunk);
      while (i + 1 < s.length && /\s/.test(s[i + 1]!)) i++;
      start = i + 1;
    }
  }
  const tail = s.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

async function mockAgents(agent: AgentName, payload: any): Promise<any> {
  await new Promise(r => setTimeout(r, 200)); // simulate latency
  if (agent === 'tagger') {
    const tokens = tokenize(payload.content || '');
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
  }
  if (agent === 'summarizer') {
    const sentences = splitSentencesNoLookbehind(payload.content || '');
    if (sentences.length <= 2) return sentences.join(' ');
    // Score by word overlap with overall frequency
    const tokens = tokenize(payload.content || '');
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
    const scored = sentences.map((s: string) => ({
      s,
      score: tokenize(s).reduce((sum, t) => sum + (freq.get(t) || 0), 0) / Math.max(1, tokenize(s).length),
    }));
    const top = scored.sort((a: { score: number }, b: { score: number }) => b.score - a.score).slice(0, 3).map((x: { s: string }) => x.s) as string[];
    return top.join(' ');
  }
  if (agent === 'linker' || agent === 'semantic-search') {
    const target = new Set(tokenize(payload.query || payload.content || ''));
    const ranked: { id: string; title: string; score: number }[] = [];
    for (const note of payload.corpus || []) {
      if (note.id === payload.noteId) continue;
      const noteTokens = new Set(tokenize(note.content + ' ' + note.title));
      let overlap = 0;
      for (const t of target) if (noteTokens.has(t)) overlap++;
      if (overlap > 0) ranked.push({ id: note.id, title: note.title, score: overlap });
    }
    return ranked.sort((a, b) => b.score - a.score).slice(0, 8);
  }
  return null;
}

// ============================================================
// Utilities
// ============================================================
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const uid = () => Math.random().toString(36).slice(2, 10);

function extractWikiLinks(content: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) out.push(m[1].trim());
  return [...new Set(out)];
}

function extractHashTags(content: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) out.push(m[1]);
  return [...new Set(out)];
}

function allTags(n: Note): string[] {
  return [...new Set([...extractHashTags(n.content), ...n.manualTags])];
}

function renderPreview(content: string, notes: Note[]): string {
  // Pre-process [[wiki-links]] → markdown links with data attr
  const byTitle = new Map(notes.map(n => [n.title.toLowerCase(), n]));
  const processed = content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, label) => {
    const t = target.trim();
    const found = byTitle.get(t.toLowerCase());
    const display = (label || t).trim();
    const cls = found ? 'wiki-link' : 'wiki-link missing';
    const id = found?.id || '';
    return `<a class="${cls}" data-note-id="${id}" data-title="${t}" href="#">${display}</a>`;
  });
  return marked.parse(processed, { async: false }) as string;
}

// ============================================================
// Component
// ============================================================
interface Props {
  adapter?: SpacekitAdapter;
  height?: string | number;
}

type RightTab = 'preview' | 'backlinks' | 'graph' | 'agents';

const STABLE_SEED_IDS = new Set(['seed-welcome', 'seed-journal', 'seed-ideas']);

function dedupeLoadedNotes(notes: Note[]): Note[] {
  const preferred = new Map<string, Note>();
  for (const n of notes) {
    if (STABLE_SEED_IDS.has(n.id)) {
      preferred.set(n.title.trim().toLowerCase(), n);
    }
  }
  const sorted = [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = new Map<string, Note>();
  const seenTitles = new Set<string>();
  for (const n of sorted) {
    const titleKey = n.title.trim().toLowerCase() || `__id:${n.id}`;
    const pref = preferred.get(titleKey);
    if (pref && n.id !== pref.id) continue;
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);
    kept.set(n.id, n);
  }
  return [...kept.values()];
}

const MOBILE_MAX_WIDTH = 768;
const STATUS_BAR_H = 28;

export default function NotesApp({ adapter, height }: Props) {
  const embedded = isSpacekitEmbedded();
  const adapterRef = useRef<SpacekitAdapter>(resolveAdapter(adapter));
  const rootHeight = height ?? (embedded ? '100%' : '100vh');
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>('preview');
  const [rightOpen, setRightOpen] = useState(true);
  const [agentResults, setAgentResults] = useState<{ tags?: string[]; summary?: string; related?: any[] }>({});
  const [agentBusy, setAgentBusy] = useState<AgentName | null>(null);
  const [saveStatus, setSaveStatus] = useState('Ready');
  const persistTimer = useRef<number | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`).matches,
  );
  const [mobilePane, setMobilePane] = useState<'list' | 'editor'>('list');

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
    const onChange = () => {
      setIsNarrow(mq.matches);
      if (!mq.matches) setMobilePane('list');
    };
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    void warmWasmAgents();
  }, []);

  useEffect(() => {
    if (isNarrow) setRightOpen(false);
  }, [isNarrow]);

  useEffect(() => {
    const layout = () => requestAnimationFrame(() => editorRef.current?.layout());
    layout();
    window.addEventListener('resize', layout);
    return () => window.removeEventListener('resize', layout);
  }, [activeId, rightOpen, isNarrow, mobilePane]);

  const openNote = useCallback((id: string) => {
    setActiveId(id);
    if (isNarrow) setMobilePane('editor');
  }, [isNarrow]);

  // ---- Load on mount + subscribe to remote updates ----
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const a = adapterRef.current;
      if (embedded && window.spacekit?.storage?.ready) {
        try {
          await window.spacekit.storage.ready();
        } catch { /* continue with list */ }
      }
      if (cancelled) return;

      const keys = await a.storage.list('note:');
      const loadedById = new Map<string, Note>();
      for (const k of keys) {
        const id = k.replace(/^note:/, '');
        if (loadedById.has(id)) continue;
        const n = await a.storage.get<Note>('note:' + id);
        if (n) loadedById.set(id, n);
      }
      const loaded = dedupeLoadedNotes([...loadedById.values()]);
      if (loaded.length === 0 && !embedded) {
        const seed = makeSeedNotes();
        for (const n of seed) await a.storage.put('note:' + n.id, n);
        if (!cancelled) {
          setNotes(seed);
          setActiveId(seed[0]?.id ?? null);
        }
      } else if (!cancelled) {
        setNotes(loaded.sort((a, b) => b.updatedAt - a.updatedAt));
        setActiveId(loaded[0]?.id ?? null);
      }
    })();

    const unsub = adapterRef.current.messaging.subscribe('notes:update', (msg: any) => {
      if (msg?.deletedId) {
        setNotes(prev => {
          const next = prev.filter(n => n.id !== msg.deletedId);
          setActiveId(aid => (aid === msg.deletedId ? next[0]?.id ?? null : aid));
          return next;
        });
        return;
      }
      if (msg?.note) setNotes(prev => {
        const i = prev.findIndex(n => n.id === msg.note.id);
        if (i < 0) return [msg.note, ...prev];
        const next = [...prev]; next[i] = msg.note; return next;
      });
    });
    return unsub;
  }, [embedded]);

  const active = useMemo(() => notes.find(n => n.id === activeId) ?? null, [notes, activeId]);

  // ---- Persist (debounced) ----
  const schedulePersist = useCallback((note: Note) => {
    setSaveStatus('Saving…');
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(async () => {
      const hash = await sha256(note.content + note.title);
      const final = { ...note, contentHash: hash, updatedAt: Date.now() };
      const existing = await adapterRef.current.storage.get<Note>('note:' + final.id);
      if (!existing) return;
      await adapterRef.current.storage.put('note:' + final.id, final);
      await adapterRef.current.messaging.publish('notes:update', { note: final });
      setNotes(prev => {
        const i = prev.findIndex(n => n.id === final.id);
        if (i < 0) return prev;
        const next = [...prev]; next[i] = final;
        return next;
      });
      setSaveStatus('Saved · ' + new Date().toLocaleTimeString());
    }, 400);
  }, []);

  // ---- Mutations ----
  const updateActive = (patch: Partial<Note>) => {
    if (!active) return;
    const next = { ...active, ...patch };
    setNotes(prev => prev.map(n => n.id === next.id ? next : n));
    schedulePersist(next);
  };

  const createNote = async () => {
    const n: Note = {
      id: uid(), title: 'Untitled', content: '', manualTags: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    setNotes(prev => [n, ...prev]);
    setActiveId(n.id);
    if (isNarrow) setMobilePane('editor');
    await adapterRef.current.storage.put('note:' + n.id, n);
    await adapterRef.current.messaging.publish('notes:update', { note: n });
  };

  const deleteNote = async (id: string) => {
    if (!embedded && !confirm('Delete this note?')) return;
    if (persistTimer.current != null) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    await adapterRef.current.storage.delete('note:' + id);
    await adapterRef.current.messaging.publish('notes:update', { deletedId: id });
    setNotes(prev => {
      const next = prev.filter(n => n.id !== id);
      setActiveId(aid => (aid === id ? next[0]?.id ?? null : aid));
      return next;
    });
    setSaveStatus('Deleted');
  };

  const togglePin = (id: string) => {
    const n = notes.find(x => x.id === id);
    if (!n) return;
    const next = { ...n, pinned: !n.pinned };
    setNotes(prev => prev.map(x => x.id === id ? next : x));
    schedulePersist(next);
  };

  // ---- Smart-contract anchor ----
  const anchorOnChain = async () => {
    if (!active) return;
    setSaveStatus('Anchoring on Spacekit…');
    const hash = await sha256(active.content + active.title);
    const { tx, timestamp } = await adapterRef.current.contracts.anchor(active.id, hash);
    updateActive({ contentHash: hash, anchorTx: tx, anchorTime: timestamp });
    setSaveStatus(`Anchored ${tx.slice(0, 10)}…`);
  };

  // ---- Agents ----
  const runAgent = async (agent: AgentName) => {
    if (!active) return;
    setAgentBusy(agent);
    try {
      if (agent === 'tagger') {
        const tags = await adapterRef.current.agents.invoke<string[]>('tagger', { content: active.content });
        setAgentResults(r => ({ ...r, tags }));
      } else if (agent === 'summarizer') {
        const summary = await adapterRef.current.agents.invoke<string>('summarizer', { content: active.content });
        setAgentResults(r => ({ ...r, summary }));
      } else if (agent === 'linker') {
        const related = await adapterRef.current.agents.invoke<any[]>('linker', {
          noteId: active.id, content: active.content, corpus: notes,
        });
        setAgentResults(r => ({ ...r, related }));
      }
    } finally { setAgentBusy(null); }
  };

  const acceptSuggestedTag = (tag: string) => {
    if (!active || active.manualTags.includes(tag)) return;
    updateActive({ manualTags: [...active.manualTags, tag] });
  };

  // ---- Derived ----
  const filteredNotes = useMemo(() => {
    let list = [...notes];
    if (tagFilter) list = list.filter(n => allTags(n).includes(tagFilter));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(n =>
        n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
    return list;
  }, [notes, search, tagFilter]);

  const allTagsList = useMemo(() => {
    const s = new Set<string>();
    for (const n of notes) for (const t of allTags(n)) s.add(t);
    return [...s].sort();
  }, [notes]);

  const backlinks = useMemo(() => {
    if (!active) return [];
    return notes.filter(n =>
      n.id !== active.id && extractWikiLinks(n.content).some(l => l.toLowerCase() === active.title.toLowerCase())
    );
  }, [notes, active]);

  const outboundLinks = useMemo(() => {
    if (!active) return [] as Note[];
    const titles = extractWikiLinks(active.content);
    return titles
      .map(t => notes.find(n => n.title.toLowerCase() === t.toLowerCase()))
      .filter((n): n is Note => !!n);
  }, [notes, active]);

  // ---- Monaco autocomplete for [[wiki-links]] ----
  const handleEditorBeforeMount = (monaco: Monaco) => {
    configureMonacoNotesTheme(monaco);
  };

  const handleEditorMount = (ed: editor.IStandaloneCodeEditor, monaco: Monaco) => {
    editorRef.current = ed;
    configureMonacoNotesTheme(monaco);
    ed.updateOptions({ fontFamily: SK.mono.replace(/"/g, '') });
    requestAnimationFrame(() => ed.layout());
    monaco.languages.registerCompletionItemProvider('markdown', {
      triggerCharacters: ['['],
      provideCompletionItems: (model: editor.ITextModel, position: IPosition) => {
        const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        if (!/\[\[$/.test(line) && !/\[\[[^\]]*$/.test(line)) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const suggestions = notes.map(n => ({
          label: n.title,
          kind: monaco.languages.CompletionItemKind.Reference,
          insertText: n.title + ']]',
          range,
          detail: 'Note link',
        }));
        return { suggestions };
      },
    });
  };

  const showList = !isNarrow || mobilePane === 'list';
  const showEditor = !isNarrow || mobilePane === 'editor';

  return (
    <div
      style={{
        ...S.root,
        height: rootHeight,
        width: '100%',
        minHeight: embedded ? 0 : undefined,
      }}
    >
      <div
        style={{
          ...S.frame,
          flexDirection: isNarrow ? 'column' : 'row',
        }}
      >
      {/* ---- Sidebar ---- */}
      {showList ? (
      <aside style={{
        ...S.sidebar,
        ...(isNarrow ? { width: '100%', flex: '1 1 auto' } : {}),
      }}>
        <div style={S.sidebarHeader}>
          <strong style={S.sidebarTitle}>Notes</strong>
          <button style={S.iconBtn} onClick={createNote} title="New note (Ctrl+N)">＋</button>
        </div>
        <input
          style={S.searchInput}
          placeholder="Search notes…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {tagFilter && (
          <div style={S.filterChip}>
            #{tagFilter}
            <button style={S.chipX} onClick={() => setTagFilter(null)}>×</button>
          </div>
        )}
        <div style={S.noteList}>
          {filteredNotes.map(n => (
            <div
              key={n.id}
              style={{ ...S.noteItem, ...(n.id === activeId ? S.noteItemActive : {}) }}
              onClick={() => openNote(n.id)}
            >
              <div style={S.noteTitle}>
                {n.pinned && <span style={{ color: '#f4c430', marginRight: 4 }}>★</span>}
                {n.title || 'Untitled'}
                {n.anchorTx && <span title="Anchored on-chain" style={S.anchorDot}>⬢</span>}
              </div>
              <div style={S.noteSnippet}>{n.content.slice(0, 90).replace(/\n/g, ' ')}</div>
              {allTags(n).length > 0 && (
                <div style={S.noteTagsRow}>
                  {allTags(n).slice(0, 3).map(t => <span key={t} style={S.tinyTag}>#{t}</span>)}
                </div>
              )}
            </div>
          ))}
          {filteredNotes.length === 0 && <div style={S.empty}>No notes match.</div>}
        </div>
        <div style={S.tagBar}>
          {allTagsList.slice(0, 20).map(t => (
            <span
              key={t}
              style={{ ...S.tagPill, ...(tagFilter === t ? S.tagPillActive : {}) }}
              onClick={() => setTagFilter(tagFilter === t ? null : t)}
            >#{t}</span>
          ))}
        </div>
      </aside>
      ) : null}

      {/* ---- Main editor ---- */}
      {showEditor ? (
      <main style={S.main}>
        {active ? (
          <>
            <div style={S.titleBar}>
              {isNarrow ? (
                <button
                  type="button"
                  style={S.iconBtn}
                  onClick={() => setMobilePane('list')}
                  aria-label="Back to notes"
                >
                  ←
                </button>
              ) : null}
              <input
                style={S.titleInput}
                value={active.title}
                onChange={e => updateActive({ title: e.target.value })}
                placeholder="Note title"
              />
              <button style={S.iconBtn} onClick={() => togglePin(active.id)} title="Pin">
                {active.pinned ? '★' : '☆'}
              </button>
              <button style={S.btn} onClick={anchorOnChain} title="Anchor on Spacekit chain">
                ⬢ Anchor
              </button>
              <button style={S.btn} onClick={() => deleteNote(active.id)} title="Delete">🗑</button>
              <button
                style={{ ...S.iconBtn, color: rightOpen ? '#cccccc' : '#858585' }}
                onClick={() => setRightOpen(o => !o)}
                title="Toggle right pane"
              >◧</button>
            </div>
            <div style={{ ...S.workspace, ...(isNarrow ? { flexDirection: 'column' } : {}) }}>
              <div className="cairn-editor-host" style={S.editorShell}>
                <Editor
                  height="100%"
                  width="100%"
                  theme="spacekit-notes"
                  language="markdown"
                  value={active.content}
                  onChange={v => updateActive({ content: v ?? '' })}
                  beforeMount={handleEditorBeforeMount}
                  onMount={handleEditorMount}
                  loading={<div style={S.editorLoading} aria-hidden />}
                  options={{
                    fontSize: 14,
                    fontFamily: '"SF Mono", Menlo, Monaco, Consolas, monospace',
                    minimap: { enabled: false },
                    wordWrap: 'on',
                    lineNumbers: 'off',
                    glyphMargin: false,
                    folding: false,
                    lineDecorationsWidth: 12,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    padding: { top: 16, bottom: 16 },
                  }}
                />
              </div>
              {rightOpen && (
                <div style={{
                  ...S.rightPane,
                  ...(isNarrow
                    ? {
                        width: '100%',
                        flex: '1 1 0',
                        borderLeft: 'none',
                        borderTop: `1px solid ${SK.lineSoft}`,
                      }
                    : {}),
                }}>
                  <div style={S.rightTabs}>
                    {(['preview', 'backlinks', 'graph', 'agents'] as RightTab[]).map(t => (
                      <button
                        key={t}
                        style={{ ...S.tabBtn, ...(rightTab === t ? S.tabBtnActive : {}) }}
                        onClick={() => setRightTab(t)}
                      >{t}</button>
                    ))}
                  </div>
                  <div className="cairn-scroll" style={S.rightBody}>
                    {rightTab === 'preview' && (
                      <PreviewPane note={active} notes={notes} onJumpToNote={openNote} />
                    )}
                    {rightTab === 'backlinks' && (
                      <BacklinksPane
                        backlinks={backlinks}
                        outbound={outboundLinks}
                        onJumpToNote={openNote}
                      />
                    )}
                    {rightTab === 'graph' && (
                      <GraphPane
                        active={active}
                        backlinks={backlinks}
                        outbound={outboundLinks}
                        onJumpToNote={openNote}
                      />
                    )}
                    {rightTab === 'agents' && (
                      <AgentsPane
                        active={active}
                        busy={agentBusy}
                        results={agentResults}
                        onRun={runAgent}
                        onAcceptTag={acceptSuggestedTag}
                        onJumpToNote={openNote}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={S.emptyEditor}>
            <div style={S.emptyIcon}>📝</div>
            <h2 style={S.emptyHeading}>Notes & docs that sync across your apps</h2>
            <p style={S.emptyCopy}>Encrypted, versioned, and yours on the SpaceKit network.</p>
            <button style={S.btnPrimary} onClick={createNote}>New note</button>
          </div>
        )}
      </main>
      ) : null}
      </div>

      {/* ---- Status bar ---- */}
      <div style={S.statusBar}>
        <span>SpaceKit · {notes.length} notes</span>
        {active?.anchorTx && (
          <span title={`Tx ${active.anchorTx}`}>⬢ anchored {new Date(active.anchorTime!).toLocaleString()}</span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ opacity: 0.85, fontSize: 11 }}>{saveStatus}</span>
      </div>
    </div>
  );
}

// ============================================================
// Right-pane subcomponents
// ============================================================
function PreviewPane({ note, notes, onJumpToNote }: {
  note: Note; notes: Note[]; onJumpToNote: (id: string) => void;
}) {
  const html = useMemo(() => renderPreview(note.content, notes), [note.content, notes]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('.wiki-link') as HTMLAnchorElement | null;
      if (!target) return;
      e.preventDefault();
      const id = target.dataset.noteId;
      if (id) onJumpToNote(id);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [onJumpToNote, html]);
  return <div ref={ref} style={S.previewBody} className="md-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

function BacklinksPane({ backlinks, outbound, onJumpToNote }: {
  backlinks: Note[]; outbound: Note[]; onJumpToNote: (id: string) => void;
}) {
  return (
    <div style={S.paneScroll}>
      <div style={S.sectionLabel}>← Linked from ({backlinks.length})</div>
      {backlinks.length === 0 && <div style={S.dim}>No backlinks yet.</div>}
      {backlinks.map(n => (
        <div key={n.id} style={S.linkRow} onClick={() => onJumpToNote(n.id)}>
          <div style={{ fontWeight: 500 }}>{n.title || 'Untitled'}</div>
          <div style={S.linkSnippet}>{n.content.slice(0, 120)}</div>
        </div>
      ))}
      <div style={{ ...S.sectionLabel, marginTop: 16 }}>→ Outbound ({outbound.length})</div>
      {outbound.length === 0 && <div style={S.dim}>This note doesn't link anywhere yet. Use [[Note Title]] to link.</div>}
      {outbound.map(n => (
        <div key={n.id} style={S.linkRow} onClick={() => onJumpToNote(n.id)}>
          <div style={{ fontWeight: 500 }}>{n.title || 'Untitled'}</div>
        </div>
      ))}
    </div>
  );
}

function GraphPane({ active, backlinks, outbound, onJumpToNote }: {
  active: Note; backlinks: Note[]; outbound: Note[]; onJumpToNote: (id: string) => void;
}) {
  // Radial layout: active in center, neighbors on a circle
  const neighbors = useMemo(() => {
    const all = [...backlinks.map(n => ({ n, dir: 'in' as const })), ...outbound.map(n => ({ n, dir: 'out' as const }))];
    // Dedupe by id
    const seen = new Set<string>();
    return all.filter(({ n }) => seen.has(n.id) ? false : (seen.add(n.id), true));
  }, [backlinks, outbound]);

  const cx = 160, cy = 160, r = 110;
  return (
    <div style={S.paneScroll}>
      <div style={S.sectionLabel}>Graph view</div>
      <svg width={320} height={320} style={{ background: '#111', borderRadius: 6 }}>
        {neighbors.map((nb, i) => {
          const a = (i / Math.max(1, neighbors.length)) * Math.PI * 2 - Math.PI / 2;
          const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
          const color = nb.dir === 'in' ? '#4a90e2' : '#f48771';
          return (
            <g key={nb.n.id} style={{ cursor: 'pointer' }} onClick={() => onJumpToNote(nb.n.id)}>
              <line x1={cx} y1={cy} x2={x} y2={y} stroke="#3a3d41" strokeWidth={1} />
              <circle cx={x} cy={y} r={10} fill={color} />
              <text x={x} y={y + 24} fontSize={10} fill="#ccc" textAnchor="middle">
                {nb.n.title.slice(0, 14)}
              </text>
            </g>
          );
        })}
        <circle cx={cx} cy={cy} r={16} fill="#0078d4" stroke="white" strokeWidth={2} />
        <text x={cx} y={cy + 32} fontSize={11} fill="white" textAnchor="middle" fontWeight={600}>
          {active.title.slice(0, 18)}
        </text>
      </svg>
      <div style={{ ...S.dim, marginTop: 8, fontSize: 11 }}>
        <span style={{ color: '#4a90e2' }}>● backlinks</span> ·{' '}
        <span style={{ color: '#f48771' }}>● outbound</span>
      </div>
    </div>
  );
}

function AgentsPane({ active, busy, results, onRun, onAcceptTag, onJumpToNote }: {
  active: Note;
  busy: AgentName | null;
  results: { tags?: string[]; summary?: string; related?: any[] };
  onRun: (a: AgentName) => void;
  onAcceptTag: (t: string) => void;
  onJumpToNote: (id: string) => void;
}) {
  return (
    <div style={S.paneScroll}>
      <div style={S.sectionLabel}>Narrow agents</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
        <button style={S.btnPrimary} onClick={() => onRun('tagger')} disabled={busy === 'tagger'}>
          {busy === 'tagger' ? '…' : '🏷'} Auto-tag
        </button>
        <button style={S.btnPrimary} onClick={() => onRun('summarizer')} disabled={busy === 'summarizer'}>
          {busy === 'summarizer' ? '…' : '✎'} Summarize
        </button>
        <button style={S.btnPrimary} onClick={() => onRun('linker')} disabled={busy === 'linker'}>
          {busy === 'linker' ? '…' : '⇄'} Suggest links
        </button>
      </div>

      {results.tags && (
        <>
          <div style={S.sectionLabel}>Suggested tags</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {results.tags.map(t => (
              <button key={t} style={S.tagPill} onClick={() => onAcceptTag(t)} title="Click to add">
                +#{t}
              </button>
            ))}
          </div>
        </>
      )}
      {results.summary && (
        <>
          <div style={S.sectionLabel}>Summary</div>
          <div style={{ ...S.dim, marginBottom: 12, lineHeight: 1.5 }}>{results.summary}</div>
        </>
      )}
      {results.related && results.related.length > 0 && (
        <>
          <div style={S.sectionLabel}>Related notes</div>
          {results.related.map((r: any) => (
            <div key={r.id} style={S.linkRow} onClick={() => onJumpToNote(r.id)}>
              <div style={{ fontWeight: 500 }}>{r.title}</div>
              <div style={S.linkSnippet}>relevance score: {r.score}</div>
            </div>
          ))}
        </>
      )}
      {!results.tags && !results.summary && !results.related && (
        <div style={S.dim}>Pick an agent above. Results stream from your Spacekit agent nodes.</div>
      )}
    </div>
  );
}

// ============================================================
// Seed
// ============================================================
function makeSeedNotes(): Note[] {
  const now = Date.now();
  return [
    {
      id: uid(), createdAt: now, updatedAt: now, manualTags: ['intro'],
      title: 'Welcome to Notes on Spacekit',
      content: `# Welcome 👋

This notes app runs on the **Spacekit** network:

- Storage node holds your notes
- Messaging node syncs them across your devices
- Smart contracts can **anchor** any note for a tamper-proof timestamp
- Narrow agents auto-tag, summarize, and suggest links

Try linking notes with [[Daily Journal]] or [[Project Ideas]]. Add tags with #intro or #welcome.
`,
    },
    {
      id: uid(), createdAt: now - 1000, updatedAt: now - 1000, manualTags: [],
      title: 'Daily Journal',
      content: `# Daily Journal

Today I started using Spacekit notes. The graph view shows how [[Welcome to Notes on Spacekit]] connects to my other ideas. #journal #daily`,
    },
    {
      id: uid(), createdAt: now - 2000, updatedAt: now - 2000, manualTags: [],
      title: 'Project Ideas',
      content: `# Project Ideas

- Decentralized notes with on-chain provenance
- Agent-driven research assistant
- Realtime collab via messaging node

See [[Daily Journal]] for context. #ideas #projects`,
    },
  ];
}

// ============================================================
// Monaco theme (define before first paint to avoid white flash)
// ============================================================
function configureMonacoNotesTheme(monaco: Monaco): void {
  monaco.editor.defineTheme('spacekit-notes', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': SK.bg,
      'editor.foreground': SK.ink,
      'editorLineNumber.foreground': SK.ink3,
      'editor.selectionBackground': 'rgba(243,200,121,0.22)',
      'editorCursor.foreground': SK.gold,
    },
  });
  monaco.editor.setTheme('spacekit-notes');
}

// ============================================================
// Styles
// ============================================================
const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'grid',
    gridTemplateRows: `1fr ${STATUS_BAR_H}px`,
    width: '100%',
    height: '100%',
    background: SK.bg,
    color: SK.ink,
    fontFamily: SK.font,
    fontSize: 14,
    overflow: 'hidden',
    minHeight: 0,
    position: 'relative',
  },
  frame: {
    gridRow: 1,
    display: 'flex',
    flexDirection: 'row',
    minHeight: 0,
    overflow: 'hidden',
  },
  sidebar: {
    width: 260,
    flex: '0 0 260px',
    background: SK.rail,
    borderRight: `1px solid ${SK.lineSoft}`,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  },
  sidebarHeader: {
    padding: '12px 14px 8px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sidebarTitle: { fontFamily: SK.font, fontWeight: 600, color: SK.ink, fontSize: 15 },
  iconBtn: {
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${SK.lineSoft}`,
    color: SK.ink2,
    cursor: 'pointer',
    borderRadius: 8,
    fontSize: 16,
  },
  searchInput: {
    margin: '0 12px 8px',
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${SK.lineSoft}`,
    color: SK.ink,
    padding: '8px 10px',
    borderRadius: 10,
    fontSize: 13,
    outline: 'none',
    fontFamily: SK.font,
  },
  filterChip: {
    margin: '0 12px 8px',
    padding: '4px 10px',
    background: 'rgba(243,200,121,0.14)',
    color: SK.gold,
    borderRadius: 999,
    fontSize: 11,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    border: `1px solid rgba(243,200,121,0.25)`,
  },
  chipX: { background: 'none', border: 'none', color: SK.gold, cursor: 'pointer', fontSize: 14, padding: 0, marginLeft: 4 },
  noteList: { flex: 1, overflowY: 'auto', padding: '4px 0' },
  noteItem: { padding: '9px 12px', cursor: 'pointer', borderLeft: '3px solid transparent' },
  noteItemActive: { background: 'rgba(243,200,121,0.12)', borderLeftColor: SK.gold },
  noteTitle: { fontWeight: 600, color: SK.ink, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 4, fontSize: 14 },
  noteSnippet: { fontSize: 12, color: SK.ink3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  noteTagsRow: { display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' },
  tinyTag: {
    fontSize: 10,
    color: SK.plasma,
    background: 'rgba(127,215,230,0.1)',
    padding: '1px 6px',
    borderRadius: 999,
  },
  anchorDot: { marginLeft: 'auto', color: SK.good, fontSize: 11 },
  tagBar: {
    padding: 8,
    borderTop: `1px solid ${SK.lineSoft}`,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    maxHeight: 120,
    overflowY: 'auto',
  },
  tagPill: {
    fontSize: 11,
    color: SK.ink2,
    background: 'rgba(255,255,255,0.04)',
    padding: '3px 9px',
    borderRadius: 999,
    cursor: 'pointer',
    border: `1px solid ${SK.lineSoft}`,
  },
  tagPillActive: { background: SK.ink, color: '#0b0e18', borderColor: 'transparent' },

  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    background: SK.bg,
    overflow: 'hidden',
  },
  titleBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px',
    borderBottom: `1px solid ${SK.lineSoft}`,
    background: SK.panel2,
    flexWrap: 'wrap',
    minWidth: 0,
    flexShrink: 0,
  },
  titleInput: {
    flex: 1,
    minWidth: 0,
    background: 'transparent',
    border: 'none',
    color: SK.ink,
    fontSize: 20,
    fontWeight: 500,
    outline: 'none',
    padding: 4,
    fontFamily: '"Fraunces", Georgia, serif',
  },
  btn: {
    background: 'rgba(255,255,255,0.04)',
    color: SK.ink2,
    border: `1px solid ${SK.lineSoft}`,
    padding: '6px 12px',
    borderRadius: 9,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: SK.font,
  },
  btnPrimary: {
    background: `linear-gradient(180deg, ${SK.gold}, ${SK.goldDeep})`,
    color: '#241a05',
    border: 'none',
    padding: '8px 14px',
    borderRadius: 9,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 700,
    fontFamily: SK.font,
  },

  workspace: { flex: 1, display: 'flex', minHeight: 0, minWidth: 0, overflow: 'hidden' },
  editorShell: {
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 0,
    background: SK.bg,
    overflow: 'hidden',
    position: 'relative',
  },
  editorLoading: { width: '100%', height: '100%', background: SK.bg },
  rightPane: {
    width: 340,
    flex: '0 0 340px',
    minHeight: 0,
    minWidth: 0,
    borderLeft: `1px solid ${SK.lineSoft}`,
    display: 'flex',
    flexDirection: 'column',
    background: SK.panel2,
    overflow: 'hidden',
  },
  rightTabs: { display: 'flex', flexShrink: 0, background: SK.rail, borderBottom: `1px solid ${SK.lineSoft}` },
  tabBtn: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    color: SK.ink3,
    padding: '9px 4px',
    cursor: 'pointer',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontFamily: SK.font,
    fontWeight: 600,
  },
  tabBtnActive: { color: SK.ink, borderBottom: `2px solid ${SK.gold}`, background: SK.panel2 },
  rightBody: { flex: '1 1 0', minHeight: 0 },
  paneScroll: { padding: 12 },
  sectionLabel: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    color: SK.ink3,
    marginBottom: 6,
    fontWeight: 700,
  },
  linkRow: { padding: '7px 8px', cursor: 'pointer', borderRadius: 8, marginBottom: 2 },
  linkSnippet: { fontSize: 11, color: SK.ink3, marginTop: 2 },
  dim: { color: SK.ink3, fontSize: 12 },
  previewBody: { padding: '12px 16px', color: SK.ink2, fontSize: 13, lineHeight: 1.6 },

  empty: { padding: 16, color: SK.ink3, fontSize: 12, textAlign: 'center' },
  emptyEditor: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: SK.ink3,
    gap: 10,
    padding: 24,
    textAlign: 'center',
  },
  emptyIcon: {
    width: 84,
    height: 84,
    borderRadius: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 40,
    background: `linear-gradient(135deg, ${SK.good}, #2f9d6e)`,
    marginBottom: 8,
  },
  emptyHeading: {
    fontFamily: '"Fraunces", Georgia, serif',
    fontWeight: 400,
    color: SK.ink,
    fontSize: 24,
    margin: 0,
  },
  emptyCopy: { maxWidth: '42ch', margin: '0 0 12px', color: SK.ink2, lineHeight: 1.5, fontSize: 14 },
  statusBar: {
    gridRow: 2,
    height: STATUS_BAR_H,
    boxSizing: 'border-box',
    background: SK.rail,
    color: SK.ink3,
    borderTop: `1px solid ${SK.lineSoft}`,
    display: 'flex',
    alignItems: 'center',
    padding: '0 14px',
    fontSize: 12,
    gap: 16,
    userSelect: 'none',
    fontFamily: SK.mono,
  },
};

// ============================================================
// Global CSS for markdown preview (inject once)
// ============================================================
if (typeof document !== 'undefined' && !document.getElementById('notes-app-md-styles')) {
  const s = document.createElement('style');
  s.id = 'notes-app-md-styles';
  s.textContent = `
    .cairn-scroll {
      flex: 1 1 0%;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
    }
    .cairn-editor-host {
      flex: 1 1 0%;
      min-height: 0;
      min-width: 0;
      position: relative;
      overflow: hidden;
    }
    .cairn-editor-host > section {
      height: 100% !important;
    }
    .md-preview h1, .md-preview h2, .md-preview h3 { color: ${SK.ink}; margin-top: 1em; font-family: "Fraunces", Georgia, serif; font-weight: 400; }
    .md-preview h1 { font-size: 1.6em; border-bottom: 1px solid ${SK.lineSoft}; padding-bottom: 4px; }
    .md-preview h2 { font-size: 1.3em; }
    .md-preview a { color: ${SK.plasma}; text-decoration: none; }
    .md-preview a:hover { text-decoration: underline; }
    .md-preview .wiki-link { color: ${SK.plasma}; background: rgba(127,215,230,0.1); padding: 1px 6px; border-radius: 6px; }
    .md-preview .wiki-link.missing { color: ${SK.gold}; background: rgba(243,200,121,0.12); }
    .md-preview code { background: rgba(255,255,255,0.06); padding: 1px 6px; border-radius: 6px; font-family: ${SK.mono}; font-size: 0.9em; }
    .md-preview pre { background: ${SK.rail}; padding: 12px; border-radius: 10px; overflow-x: auto; border: 1px solid ${SK.lineSoft}; }
    .md-preview pre code { background: transparent; padding: 0; }
    .md-preview blockquote { border-left: 3px solid ${SK.gold}; padding-left: 12px; color: ${SK.ink2}; margin-left: 0; }
    .md-preview ul, .md-preview ol { padding-left: 24px; }
    .monaco-editor, .monaco-editor .margin, .monaco-editor-background,
    .monaco-editor .overflow-guard { background-color: ${SK.bg} !important; }
  `;
  document.head.appendChild(s);
}
