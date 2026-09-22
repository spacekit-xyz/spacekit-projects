// FilesApp.tsx
// A files app component built to compete with Google Drive / Dropbox / OneDrive /
// iCloud / MEGA / pCloud / Sync.com, designed for the Spacekit blockchain network.
//
// Install:
//   npm install
// (No extra deps required — uses Web Crypto API + IndexedDB natively.)
//
// Usage with mock adapter (runs standalone, IndexedDB-backed):
//   <FilesApp />
//
// Usage with real Spacekit nodes:
//   <FilesApp adapter={mySpacekitAdapter} />

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

declare global {
  interface Window {
    spacekit?: {
      appId?: string;
      storage?: {
        putBlob?: (blob: Blob) => Promise<{ cid: string; size: number }>;
        getBlob?: (cid: string) => Promise<Blob>;
        putRecord?: (key: string, value: unknown) => Promise<string>;
        getRecord?: <T = unknown>(key: string) => Promise<T | null>;
        listRecords?: (prefix?: string) => Promise<string[]>;
        deleteRecord?: (key: string) => Promise<void>;
        ready?: () => Promise<{ ready: boolean; entryCount?: number; noteCount?: number }>;
      };
      messaging?: {
        publish: (topic: string, msg: unknown) => Promise<void>;
        subscribe: (topic: string, cb: (msg: unknown) => void) => () => void;
      };
      contracts?: {
        anchor: (fileId: string, contentHash: string) => Promise<{ tx: string; timestamp: number }>;
        verify: (fileId: string) => Promise<{ verified: boolean; timestamp?: number; tx?: string }>;
        createShare?: (input: ShareInput) => Promise<{ shareId: string; tx: string }>;
        revokeShare?: (shareId: string) => Promise<{ tx: string }>;
      };
      crypto?: {
        encryptUpload: (blob: Blob, ownerPubkey?: string) => Promise<{
          ciphertext: Blob;
          ivB64: string;
          wrappedKey: string;
          contentHash: string;
          size: number;
        }>;
        decryptBlob: (cid: string, iv: string, wrappedKey: string) => Promise<{ plaintext: Blob }>;
      };
    };
    __skTopicSubs?: Record<string, Array<{ id: string; cb: (msg: unknown) => void }>>;
  }
}

function isSpacekitEmbedded(): boolean {
  return typeof window !== 'undefined' && Boolean(window.spacekit?.storage?.putRecord);
}

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

// ============================================================
// Domain types
// ============================================================
export interface FileEntry {
  id: string;
  name: string;
  parentId: string | null;
  type: 'file' | 'folder';
  size?: number;
  mimeType?: string;
  cid?: string;                 // content ID on storage node
  encrypted?: boolean;
  wrappedKey?: string;          // file key wrapped for owner
  iv?: string;                  // base64 IV for AES-GCM
  contentHash?: string;         // sha256 of ciphertext
  anchorTx?: string;
  anchorTime?: number;
  starred?: boolean;
  trashed?: boolean;
  trashedAt?: number;
  shares?: Share[];
  versions?: VersionEntry[];    // previous versions, newest first
  createdAt: number;
  updatedAt: number;
}

export interface VersionEntry {
  cid: string;
  size: number;
  mimeType?: string;
  contentHash: string;
  wrappedKey: string;           // each version is its own ciphertext, so its own key
  iv: string;
  createdAt: number;
}

export interface Share {
  id: string;
  kind: 'public' | 'direct';
  recipientPubkey?: string;
  publicToken?: string;
  permissions: 'read' | 'write';
  passwordProtected?: boolean;
  expiresAt?: number;
  createdAt: number;
  revokedAt?: number;
}

export interface ShareInput {
  fileId: string;
  kind: 'public' | 'direct';
  recipientPubkey?: string;
  permissions: 'read' | 'write';
  expiresAt?: number;
  passwordHash?: string;
}

export type AgentName = 'organizer' | 'extractor' | 'summarizer' | 'dedup' | 'similarity-search';

// ============================================================
// Spacekit adapter interface
// ============================================================
export interface SpacekitAdapter {
  storage: {
    putBlob(blob: Blob, opts?: { onProgress?: (loaded: number, total: number) => void }): Promise<{ cid: string; size: number }>;
    getBlob(cid: string, opts?: { onProgress?: (loaded: number, total: number) => void }): Promise<Blob>;
    putRecord(key: string, value: unknown): Promise<string>;
    getRecord<T = unknown>(key: string): Promise<T | null>;
    listRecords(prefix?: string): Promise<string[]>;
    deleteRecord(key: string): Promise<void>;
  };
  messaging: {
    publish(topic: string, msg: unknown): Promise<void>;
    subscribe(topic: string, cb: (msg: unknown) => void): () => void;
  };
  contracts: {
    anchor(fileId: string, contentHash: string): Promise<{ tx: string; timestamp: number }>;
    verify(fileId: string): Promise<{ verified: boolean; timestamp?: number; tx?: string }>;
    createShare(share: ShareInput): Promise<{ shareId: string; tx: string }>;
    revokeShare(shareId: string): Promise<{ tx: string }>;
  };
  agents: {
    invoke<T = unknown>(agent: AgentName, payload: unknown): Promise<T>;
  };
  crypto: {
    generateFileKey(): Promise<CryptoKey>;
    encrypt(blob: Blob, key: CryptoKey): Promise<{ ciphertext: Blob; iv: Uint8Array }>;
    decrypt(ciphertext: Blob, key: CryptoKey, iv: Uint8Array): Promise<Blob>;
    wrapKey(key: CryptoKey, recipientPubkey: string): Promise<string>;
    unwrapKey(wrapped: string): Promise<CryptoKey>;
  };
}

// ============================================================
// Web Crypto wrappers (real AES-GCM)
// ============================================================
function hasLocalSubtle(): boolean {
  const subtle = globalThis.crypto?.subtle;
  return Boolean(
    globalThis.isSecureContext &&
    subtle &&
    typeof subtle.generateKey === 'function',
  );
}

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto unavailable in this frame');
  }
  return subtle;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function base64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

const cryptoImpl: SpacekitAdapter['crypto'] = {
  async generateFileKey() {
    return getSubtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  },
  async encrypt(blob, key) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const buf = await blob.arrayBuffer();
    const ct = await getSubtle().encrypt({ name: 'AES-GCM', iv }, key, buf);
    return { ciphertext: new Blob([ct]), iv };
  },
  async decrypt(ciphertext, key, iv) {
    const buf = await ciphertext.arrayBuffer();
    const pt = await getSubtle().decrypt({ name: 'AES-GCM', iv }, key, buf);
    return new Blob([pt]);
  },
  async wrapKey(key, _recipientPubkey) {
    const raw = await getSubtle().exportKey('raw', key);
    return btoa(String.fromCharCode(...new Uint8Array(raw)));
  },
  async unwrapKey(wrapped) {
    const raw = Uint8Array.from(atob(wrapped), c => c.charCodeAt(0));
    return getSubtle().importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  },
};

async function sha256Blob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const hash = await getSubtle().digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Encrypt in iframe when subtle exists; embedded mode prefers parent-frame SDK bridge. */
async function encryptFileForUpload(
  a: SpacekitAdapter,
  file: File | Blob,
  ownerPubkey: string,
): Promise<{ ciphertext: Blob; iv: Uint8Array; wrappedKey: string; contentHash: string }> {
  const uploadBlob = file instanceof File ? file : new File([file], 'upload');
  const bridge = window.spacekit?.crypto;
  if (isSpacekitEmbedded() && bridge?.encryptUpload) {
    const r = await bridge.encryptUpload(uploadBlob, ownerPubkey);
    return {
      ciphertext: r.ciphertext,
      iv: base64ToBytes(r.ivB64),
      wrappedKey: r.wrappedKey,
      contentHash: r.contentHash,
    };
  }
  if (hasLocalSubtle()) {
    const fileKey = await a.crypto.generateFileKey();
    const { ciphertext, iv } = await a.crypto.encrypt(file, fileKey);
    const contentHash = await sha256Blob(ciphertext);
    const wrappedKey = await a.crypto.wrapKey(fileKey, ownerPubkey);
    return { ciphertext, iv, wrappedKey, contentHash };
  }
  if (bridge?.encryptUpload) {
    const r = await bridge.encryptUpload(uploadBlob, ownerPubkey);
    return {
      ciphertext: r.ciphertext,
      iv: base64ToBytes(r.ivB64),
      wrappedKey: r.wrappedKey,
      contentHash: r.contentHash,
    };
  }
  throw new Error('Web Crypto unavailable. Use https:// or http://localhost, or open Files from AuthenticatedHome.');
}

// ============================================================
// IndexedDB blob store (mock storage node)
// ============================================================
const DB_NAME = 'spacekit-quay';
const STORE_BLOBS = 'blobs';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, blob: Blob): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    tx.objectStore(STORE_BLOBS).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BLOBS, 'readonly');
    const req = tx.objectStore(STORE_BLOBS).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

// ============================================================
// Mock adapter
// ============================================================
export function createMockAdapter(prefix = 'quay'): SpacekitAdapter {
  const k = (key: string) => `${prefix}:${key}`;
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(prefix) : null;
  const subscribers = new Map<string, Set<(m: unknown) => void>>();
  channel?.addEventListener('message', (e: MessageEvent) => {
    const { topic, msg } = e.data ?? {};
    subscribers.get(topic)?.forEach(cb => cb(msg));
  });

  return {
    storage: {
      async putBlob(blob, opts) {
        const cid = 'bafy' + (await sha256Blob(blob)).slice(0, 52);
        opts?.onProgress?.(0, blob.size);
        await idbPut(cid, blob);
        opts?.onProgress?.(blob.size, blob.size);
        return { cid, size: blob.size };
      },
      async getBlob(cid, opts) {
        const b = await idbGet(cid);
        if (!b) throw new Error(`CID not found: ${cid}`);
        opts?.onProgress?.(b.size, b.size);
        return b;
      },
      async putRecord(key, value) {
        const json = JSON.stringify(value);
        localStorage.setItem(k(key), json);
        const hash = await getSubtle().digest('SHA-256', new TextEncoder().encode(json));
        return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
      },
      async getRecord(key) {
        const raw = localStorage.getItem(k(key));
        return raw ? JSON.parse(raw) : null;
      },
      async listRecords(p = '') {
        const out: string[] = [];
        const want = k(p);
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)!;
          if (key.startsWith(want)) out.push(key.slice(prefix.length + 1));
        }
        return out;
      },
      async deleteRecord(key) { localStorage.removeItem(k(key)); },
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
      async anchor(fileId, contentHash) {
        const tx = '0x' + (await sha256Hex(fileId + contentHash + Date.now())).slice(0, 40);
        const record = { tx, timestamp: Date.now(), contentHash };
        localStorage.setItem(k('anchor:' + fileId), JSON.stringify(record));
        return { tx, timestamp: record.timestamp };
      },
      async verify(fileId) {
        const raw = localStorage.getItem(k('anchor:' + fileId));
        if (!raw) return { verified: false };
        const r = JSON.parse(raw);
        return { verified: true, timestamp: r.timestamp, tx: r.tx };
      },
      async createShare(share) {
        const shareId = uid();
        const tx = '0x' + (await sha256Hex(JSON.stringify(share) + Date.now())).slice(0, 40);
        return { shareId, tx };
      },
      async revokeShare(_shareId) {
        const tx = '0x' + (await sha256Hex(_shareId + Date.now())).slice(0, 40);
        return { tx };
      },
    },
    agents: { invoke: mockAgents as SpacekitAdapter['agents']['invoke'] },
    crypto: cryptoImpl,
  };
}

function createSpacekitSdkAdapter(appId: string): SpacekitAdapter {
  const mock = createMockAdapter(`quay-sdk-${appId}`);
  const sk = window.spacekit!;

  return {
    storage: {
      async putBlob(blob, opts) {
        const result = await sk.storage!.putBlob!(blob);
        opts?.onProgress?.(result.size, result.size);
        return result;
      },
      async getBlob(cid, opts) {
        const blob = await sk.storage!.getBlob!(cid);
        opts?.onProgress?.(blob.size, blob.size);
        return blob;
      },
      async putRecord(key, value) {
        return sk.storage!.putRecord!(key, value);
      },
      async getRecord(key) {
        return sk.storage!.getRecord!(key);
      },
      async listRecords(p = '') {
        return sk.storage!.listRecords!(p);
      },
      async deleteRecord(key) {
        await sk.storage!.deleteRecord!(key);
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
          anchor: (fileId, contentHash) => sk.contracts!.anchor(fileId, contentHash),
          verify: (fileId) => sk.contracts!.verify(fileId),
          createShare: (input) =>
            sk.contracts!.createShare
              ? sk.contracts.createShare(input)
              : mock.contracts.createShare(input),
          revokeShare: (shareId) =>
            sk.contracts!.revokeShare
              ? sk.contracts.revokeShare(shareId)
              : mock.contracts.revokeShare(shareId),
        }
      : mock.contracts,
    agents: mock.agents,
    crypto: cryptoImpl,
  };
}

function resolveAdapter(explicit?: SpacekitAdapter): SpacekitAdapter {
  if (explicit) return explicit;
  if (isSpacekitEmbedded() && window.spacekit?.appId) {
    return createSpacekitSdkAdapter(window.spacekit.appId);
  }
  return createMockAdapter('quay');
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await getSubtle().digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ----- mock narrow agents -----
async function mockAgents(agent: AgentName, payload: any): Promise<any> {
  await new Promise(r => setTimeout(r, 200));
  if (agent === 'organizer') {
    return (payload.files as FileEntry[])
      .filter(f => f.type === 'file')
      .map(f => ({
        fileId: f.id,
        suggestedFolder: categorize(f.mimeType),
        confidence: 0.8,
      }));
  }
  if (agent === 'summarizer') {
    const t = (payload.text as string) || '';
    return t.length > 200 ? t.slice(0, 200) + '…' : t;
  }
  if (agent === 'extractor') {
    return { text: '(mock OCR not implemented — wire a real extractor agent)', language: 'en' };
  }
  if (agent === 'dedup') {
    const groups = new Map<string, string[]>();
    for (const f of payload.files as FileEntry[]) {
      if (!f.contentHash) continue;
      if (!groups.has(f.contentHash)) groups.set(f.contentHash, []);
      groups.get(f.contentHash)!.push(f.id);
    }
    return { groups: [...groups.values()].filter(g => g.length > 1) };
  }
  if (agent === 'similarity-search') {
    const q = (payload.query as string).toLowerCase();
    return (payload.corpus as FileEntry[])
      .filter(f => f.type === 'file' && f.name.toLowerCase().includes(q))
      .map(f => ({ fileId: f.id, score: 1 }));
  }
  return null;
}

function categorize(mime?: string): string {
  if (!mime) return 'Other';
  if (mime.startsWith('image/')) return 'Images';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime === 'application/pdf') return 'Documents';
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('javascript') || mime.includes('xml')) return 'Documents';
  return 'Other';
}

// ============================================================
// Utilities
// ============================================================
const uid = () => Math.random().toString(36).slice(2, 10);

function formatBytes(n?: number): string {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

function mimeIcon(entry: FileEntry): string {
  if (entry.type === 'folder') return '📁';
  const m = entry.mimeType ?? '';
  if (m.startsWith('image/')) return '🖼';
  if (m.startsWith('video/')) return '🎬';
  if (m.startsWith('audio/')) return '🎵';
  if (m === 'application/pdf') return '📄';
  if (m.startsWith('text/') || m.includes('json') || m.includes('javascript')) return '📝';
  if (m.includes('zip') || m.includes('archive')) return '🗜';
  return '📦';
}

function isTextLike(mime?: string): boolean {
  if (!mime) return false;
  return mime.startsWith('text/') ||
         mime.includes('json') ||
         mime.includes('javascript') ||
         mime.includes('typescript') ||
         mime.includes('xml') ||
         mime.includes('yaml') ||
         mime === 'application/x-sh';
}

/** Decrypt + materialize a stored file blob. Used by previews, download, share-receiver. */
async function materializeBlob(
  adapter: SpacekitAdapter,
  source: { cid?: string; encrypted?: boolean; wrappedKey?: string; iv?: string; rawKey?: CryptoKey }
): Promise<Blob> {
  if (!source.cid) throw new Error('No CID');
  const ct = await adapter.storage.getBlob(source.cid);
  if (!source.encrypted) return ct;
  if (!source.iv) throw new Error('Missing IV');
  if (!hasLocalSubtle() && window.spacekit?.crypto?.decryptBlob && source.wrappedKey) {
    if (source.wrappedKey === '__dev_plaintext__') return ct;
    const r = await window.spacekit.crypto.decryptBlob(source.cid, source.iv, source.wrappedKey);
    return r.plaintext;
  }
  if (!hasLocalSubtle()) {
    throw new Error('Web Crypto unavailable in iframe — reload Files tab after updating the website.');
  }
  const key = source.rawKey
    ?? (source.wrappedKey ? await adapter.crypto.unwrapKey(source.wrappedKey) : null);
  if (!key) throw new Error('Missing decryption key');
  return adapter.crypto.decrypt(ct, key, base64ToBytes(source.iv));
}

// ============================================================
// Component
// ============================================================
interface Props {
  adapter?: SpacekitAdapter;
  height?: string | number;
  /** Owner pubkey used for wrapping file keys. Demo: any string. */
  ownerPubkey?: string;
}

type SidebarView = 'all' | 'starred' | 'shared' | 'recent' | 'trash';
const MOBILE_MAX_WIDTH = 768;

export default function FilesApp({ adapter, height, ownerPubkey = 'demo-owner' }: Props) {
  const embedded = isSpacekitEmbedded();
  const adapterRef = useRef<SpacekitAdapter>(resolveAdapter(adapter));
  const rootHeight = height ?? (embedded ? '100%' : '100vh');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sidebarView, setSidebarView] = useState<SidebarView>('all');
  const [search, setSearch] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [shareDialogFor, setShareDialogFor] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Map<string, { name: string; loaded: number; total: number }>>(new Map());
  const [dragging, setDragging] = useState(false);
  const [saveStatus, setSaveStatus] = useState('Ready');
  const [agentResults, setAgentResults] = useState<{ organizer?: any[]; dedup?: any; summary?: string }>({});
  const [agentBusy, setAgentBusy] = useState<AgentName | null>(null);
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`).matches,
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const uploadInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
    const onChange = () => {
      setIsNarrow(mq.matches);
      if (!mq.matches) setMobileNavOpen(false);
    };
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (isNarrow) setDetailsOpen(false);
  }, [isNarrow]);

  // ---- Load on mount ----
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

      const keys = await a.storage.listRecords('file:');
      const loaded: FileEntry[] = [];
      for (const key of keys) {
        const id = key.replace(/^file:/, '');
        const e = await a.storage.getRecord<FileEntry>('file:' + id);
        if (e) loaded.push(e);
      }
      if (!cancelled) {
        setEntries(loaded.sort((a, b) => b.updatedAt - a.updatedAt));
      }
    })();

    const unsub = adapterRef.current.messaging.subscribe('files:update', (msg: any) => {
      if (msg?.entry) {
        setEntries(prev => {
          const i = prev.findIndex(e => e.id === msg.entry.id);
          if (i < 0) return [msg.entry, ...prev];
          const next = [...prev]; next[i] = msg.entry; return next;
        });
      }
      if (msg?.deletedId) setEntries(prev => prev.filter(e => e.id !== msg.deletedId));
    });
    return unsub;
  }, [embedded]);

  // ---- Persist a single entry ----
  const persistEntry = useCallback(async (e: FileEntry) => {
    setSaveStatus('Saving…');
    await adapterRef.current.storage.putRecord('file:' + e.id, e);
    await adapterRef.current.messaging.publish('files:update', { entry: e });
    setSaveStatus('Saved · ' + new Date().toLocaleTimeString());
  }, []);

  const upsertEntry = useCallback((e: FileEntry, persist = true) => {
    setEntries(prev => {
      const i = prev.findIndex(x => x.id === e.id);
      if (i < 0) return [e, ...prev];
      const next = [...prev]; next[i] = e; return next;
    });
    if (persist) persistEntry(e);
  }, [persistEntry]);

  // ---- Folder navigation ----
  const breadcrumb = useMemo(() => {
    const trail: FileEntry[] = [];
    let cur = currentFolderId;
    while (cur) {
      const f = entries.find(e => e.id === cur);
      if (!f) break;
      trail.unshift(f);
      cur = f.parentId;
    }
    return trail;
  }, [currentFolderId, entries]);

  const visibleEntries = useMemo(() => {
    let list = entries;
    if (sidebarView === 'all') {
      list = entries.filter(e => e.parentId === currentFolderId && !e.trashed);
    } else if (sidebarView === 'starred') {
      list = entries.filter(e => e.starred && !e.trashed);
    } else if (sidebarView === 'shared') {
      list = entries.filter(e => (e.shares?.length ?? 0) > 0 && !e.trashed);
    } else if (sidebarView === 'recent') {
      list = entries.filter(e => e.type === 'file' && !e.trashed)
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
    } else if (sidebarView === 'trash') {
      list = entries.filter(e => e.trashed);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(e => e.name.toLowerCase().includes(q));
    }
    return list.sort((a, b) =>
      Number(b.type === 'folder') - Number(a.type === 'folder') ||
      a.name.localeCompare(b.name)
    );
  }, [entries, currentFolderId, sidebarView, search]);

  // ---- Counts ----
  const counts = useMemo(() => ({
    all: entries.filter(e => !e.trashed).length,
    starred: entries.filter(e => e.starred && !e.trashed).length,
    shared: entries.filter(e => (e.shares?.length ?? 0) > 0 && !e.trashed).length,
    trash: entries.filter(e => e.trashed).length,
  }), [entries]);

  // ---- Upload ----
  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const a = adapterRef.current;
    for (const file of Array.from(files)) {
      const uploadId = uid();
      setUploads(prev => new Map(prev).set(uploadId, { name: file.name, loaded: 0, total: file.size }));
      try {
        const { ciphertext, iv, wrappedKey, contentHash } = await encryptFileForUpload(a, file, ownerPubkey);
        const { cid, size } = await a.storage.putBlob(ciphertext, {
          onProgress: (loaded, total) => {
            setUploads(prev => {
              const next = new Map(prev);
              next.set(uploadId, { name: file.name, loaded, total });
              return next;
            });
          },
        });
        const entry: FileEntry = {
          id: uid(),
          name: file.name,
          parentId: currentFolderId,
          type: 'file',
          size,
          mimeType: file.type || 'application/octet-stream',
          cid,
          encrypted: true,
          wrappedKey,
          iv: bytesToBase64(iv),
          contentHash,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        upsertEntry(entry);
      } catch (err) {
        console.error('Upload failed', err);
        alert(`Upload failed: ${(err as Error).message}`);
      } finally {
        setUploads(prev => { const next = new Map(prev); next.delete(uploadId); return next; });
      }
    }
  }, [currentFolderId, ownerPubkey, upsertEntry]);

  // ---- Download (decrypt + save) ----
  const downloadEntry = useCallback(async (entry: FileEntry) => {
    if (entry.type !== 'file' || !entry.cid) return;
    const a = adapterRef.current;
    setSaveStatus('Downloading…');
    try {
      const blob = await materializeBlob(a, entry);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = entry.name; link.click();
      URL.revokeObjectURL(url);
      setSaveStatus('Downloaded ' + entry.name);
    } catch (err) {
      setSaveStatus('Download failed');
      alert((err as Error).message);
    }
  }, []);

  // ---- Versioning ----
  const downloadVersion = useCallback(async (entry: FileEntry, version: VersionEntry) => {
    const a = adapterRef.current;
    setSaveStatus('Downloading version…');
    try {
      const blob = await materializeBlob(a, {
        cid: version.cid, encrypted: true, wrappedKey: version.wrappedKey, iv: version.iv,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const stamp = new Date(version.createdAt).toISOString().slice(0, 10);
      link.href = url;
      link.download = `${entry.name.replace(/(\.[^.]+)?$/, `.${stamp}$1`)}`;
      link.click();
      URL.revokeObjectURL(url);
      setSaveStatus('Downloaded version ' + stamp);
    } catch (err) {
      setSaveStatus('Download failed');
      alert((err as Error).message);
    }
  }, []);

  const replaceWithNewVersion = useCallback(async (target: FileEntry, file: File) => {
    const a = adapterRef.current;
    setSaveStatus('Uploading new version…');
    try {
      const { ciphertext, iv, wrappedKey, contentHash } = await encryptFileForUpload(a, file, ownerPubkey);
      const { cid, size } = await a.storage.putBlob(ciphertext);

      // Snapshot the current state as a version
      const prevVersion: VersionEntry | null = (target.cid && target.wrappedKey && target.iv && target.contentHash)
        ? {
            cid: target.cid,
            size: target.size ?? 0,
            mimeType: target.mimeType,
            contentHash: target.contentHash,
            wrappedKey: target.wrappedKey,
            iv: target.iv,
            createdAt: target.updatedAt,
          }
        : null;

      upsertEntry({
        ...target,
        cid, size,
        mimeType: file.type || target.mimeType,
        contentHash,
        encrypted: true,
        wrappedKey,
        iv: bytesToBase64(iv),
        versions: prevVersion ? [prevVersion, ...(target.versions ?? [])] : (target.versions ?? []),
        // New ciphertext invalidates any previous on-chain anchor; user can re-anchor.
        anchorTx: undefined,
        anchorTime: undefined,
        updatedAt: Date.now(),
      });
      setSaveStatus('New version uploaded');
    } catch (err) {
      setSaveStatus('Upload failed');
      alert((err as Error).message);
    }
  }, [ownerPubkey, upsertEntry]);

  const restoreVersion = useCallback((target: FileEntry, version: VersionEntry) => {
    if (!confirm(`Restore version from ${new Date(version.createdAt).toLocaleString()}? The current version will be kept in history.`)) return;
    const currentSnapshot: VersionEntry | null = (target.cid && target.wrappedKey && target.iv && target.contentHash)
      ? {
          cid: target.cid,
          size: target.size ?? 0,
          mimeType: target.mimeType,
          contentHash: target.contentHash,
          wrappedKey: target.wrappedKey,
          iv: target.iv,
          createdAt: target.updatedAt,
        }
      : null;
    const remaining = (target.versions ?? []).filter(v => v.cid !== version.cid);
    upsertEntry({
      ...target,
      cid: version.cid,
      size: version.size,
      mimeType: version.mimeType ?? target.mimeType,
      contentHash: version.contentHash,
      wrappedKey: version.wrappedKey,
      iv: version.iv,
      encrypted: true,
      versions: currentSnapshot ? [currentSnapshot, ...remaining] : remaining,
      anchorTx: undefined,
      anchorTime: undefined,
      updatedAt: Date.now(),
    });
  }, [upsertEntry]);

  // Trigger native file picker for "replace with new version"
  const versionUploadRef = useRef<HTMLInputElement>(null);
  const versionTargetRef = useRef<FileEntry | null>(null);
  const promptReplaceVersion = (entry: FileEntry) => {
    versionTargetRef.current = entry;
    versionUploadRef.current?.click();
  };
  const onVersionFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const target = versionTargetRef.current;
    e.target.value = '';
    if (!file || !target) return;
    replaceWithNewVersion(target, file);
  };

  // ---- Mutations ----
  const createFolder = () => {
    const name = prompt('Folder name?', 'New Folder');
    if (!name) return;
    const folder: FileEntry = {
      id: uid(), name, parentId: currentFolderId, type: 'folder',
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    upsertEntry(folder);
  };

  const rename = (entry: FileEntry) => {
    const name = prompt('Rename to:', entry.name);
    if (!name || name === entry.name) return;
    upsertEntry({ ...entry, name, updatedAt: Date.now() });
  };

  const toggleStar = (entry: FileEntry) => {
    upsertEntry({ ...entry, starred: !entry.starred, updatedAt: Date.now() });
  };

  const moveToTrash = (entry: FileEntry) => {
    upsertEntry({ ...entry, trashed: true, trashedAt: Date.now(), updatedAt: Date.now() });
  };

  const restore = (entry: FileEntry) => {
    upsertEntry({ ...entry, trashed: false, trashedAt: undefined, updatedAt: Date.now() });
  };

  const deleteForever = async (entry: FileEntry) => {
    if (!embedded && !confirm(`Delete "${entry.name}" forever? This cannot be undone.`)) return;
    await adapterRef.current.storage.deleteRecord('file:' + entry.id);
    await adapterRef.current.messaging.publish('files:update', { deletedId: entry.id });
    setEntries(prev => prev.filter(e => e.id !== entry.id));
    // Note: in production also unpin the blob from the storage node if no other entries reference it
  };

  const anchorOnChain = async (entry: FileEntry) => {
    if (!entry.contentHash) return;
    setSaveStatus('Anchoring on Spacekit…');
    const { tx, timestamp } = await adapterRef.current.contracts.anchor(entry.id, entry.contentHash);
    upsertEntry({ ...entry, anchorTx: tx, anchorTime: timestamp, updatedAt: Date.now() });
    setSaveStatus(`Anchored ${tx.slice(0, 10)}…`);
  };

  // ---- Sharing ----
  const createShare = async (input: Omit<ShareInput, 'fileId'> & { fileId: string }) => {
    const entry = entries.find(e => e.id === input.fileId);
    if (!entry) return;
    const { shareId, tx } = await adapterRef.current.contracts.createShare(input);
    const share: Share = {
      id: shareId,
      kind: input.kind,
      recipientPubkey: input.recipientPubkey,
      publicToken: input.kind === 'public' ? uid() + uid() : undefined,
      permissions: input.permissions,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
    };
    if (share.publicToken) {
      await adapterRef.current.storage.putRecord(`share:${share.publicToken}`, {
        fileId: entry.id,
        share,
      });
    }
    upsertEntry({ ...entry, shares: [...(entry.shares ?? []), share], updatedAt: Date.now() });
    setSaveStatus(`Share created · tx ${tx.slice(0, 10)}…`);
    return share;
  };

  const revokeShare = async (entry: FileEntry, shareId: string) => {
    await adapterRef.current.contracts.revokeShare(shareId);
    const shares = (entry.shares ?? []).map(s =>
      s.id === shareId ? { ...s, revokedAt: Date.now() } : s
    );
    const revoked = shares.find(s => s.id === shareId);
    if (revoked?.publicToken) {
      await adapterRef.current.storage.deleteRecord(`share:${revoked.publicToken}`);
    }
    upsertEntry({ ...entry, shares, updatedAt: Date.now() });
  };

  // ---- Agents ----
  const runAgent = async (agent: AgentName) => {
    setAgentBusy(agent);
    try {
      if (agent === 'organizer') {
        const res = await adapterRef.current.agents.invoke<any[]>('organizer', {
          files: entries.filter(e => e.type === 'file' && !e.trashed),
        });
        setAgentResults(r => ({ ...r, organizer: res }));
      } else if (agent === 'dedup') {
        const res = await adapterRef.current.agents.invoke<any>('dedup', {
          files: entries.filter(e => e.type === 'file' && !e.trashed),
        });
        setAgentResults(r => ({ ...r, dedup: res }));
      }
    } finally { setAgentBusy(null); }
  };

  // ---- Selection ----
  const onEntryClick = (e: React.MouseEvent, entry: FileEntry) => {
    if (e.metaKey || e.ctrlKey) {
      setSelected(prev => {
        const next = new Set(prev);
        next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id);
        return next;
      });
    } else {
      setSelected(new Set([entry.id]));
    }
  };
  const onEntryDouble = (entry: FileEntry) => {
    if (entry.type === 'folder') { setCurrentFolderId(entry.id); setSelected(new Set()); }
    else downloadEntry(entry);
  };

  // ---- Drag & drop ----
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = (e: React.DragEvent) => { if (e.currentTarget === e.target) setDragging(false); };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  };

  // ---- Keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (mod && e.key === 'u') { e.preventDefault(); uploadInputRef.current?.click(); }
      if (mod && e.shiftKey && e.key === 'N') { e.preventDefault(); createFolder(); }
      if (mod && e.key === 'd') { e.preventDefault(); selected.forEach(id => { const en = entries.find(e => e.id === id); if (en) toggleStar(en); }); }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        selected.forEach(id => { const en = entries.find(e => e.id === id); if (en && !en.trashed) moveToTrash(en); });
      }
      if (e.key === 'Enter') {
        const id = [...selected][0]; if (id) { const en = entries.find(e => e.id === id); if (en) onEntryDouble(en); }
      }
      if (e.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- Active entry for details pane ----
  const activeEntry = useMemo(() => {
    if (selected.size !== 1) return null;
    return entries.find(e => e.id === [...selected][0]) ?? null;
  }, [selected, entries]);

  return (
    <div
      style={{
        ...S.root,
        height: rootHeight,
        width: '100%',
        minHeight: embedded ? 0 : undefined,
        gridTemplateColumns: isNarrow ? '1fr' : '220px 1fr',
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isNarrow && mobileNavOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          style={S.mobileBackdrop}
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}
      {/* Sidebar */}
      <aside
        style={{
          ...S.sidebar,
          ...(isNarrow
            ? {
                position: 'fixed',
                top: 10,
                left: 0,
                bottom: 0,
                width: 260,
                zIndex: 50,
                transform: mobileNavOpen ? 'translate3d(0, 0, 0)' : 'translate3d(-100%, 0, 0)',
                transition: 'transform 0.2s ease',
                boxShadow: mobileNavOpen ? '8px 0 32px rgba(0,0,0,0.45)' : undefined,
              }
            : {}),
        }}
      >

        <button style={S.uploadBtn} onClick={() => uploadInputRef.current?.click()}>
          ⬆ Upload
        </button>
        <input
          ref={uploadInputRef} type="file" multiple style={{ display: 'none' }}
          onChange={e => e.target.files && handleFiles(e.target.files)}
        />
        <nav style={S.nav}>
          {[
            { id: 'all', label: 'All files', icon: '📁', count: counts.all },
            { id: 'starred', label: 'Starred', icon: '⭐', count: counts.starred },
            { id: 'shared', label: 'Shared', icon: '👥', count: counts.shared },
            { id: 'recent', label: 'Recent', icon: '🕒' },
            { id: 'trash', label: 'Trash', icon: '🗑', count: counts.trash },
          ].map(item => (
            <button
              key={item.id}
              style={{ ...S.navItem, ...(sidebarView === item.id ? S.navItemActive : {}) }}
              onClick={() => {
                setSidebarView(item.id as SidebarView);
                setCurrentFolderId(null);
                setSelected(new Set());
                if (isNarrow) setMobileNavOpen(false);
              }}
            >
              <span>{item.icon}</span>
              <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>
              {item.count != null && item.count > 0 && (
                <span style={S.navCount}>{item.count}</span>
              )}
            </button>
          ))}
        </nav>
        <div style={S.sidebarFooter}>
          <div style={{ fontSize: 11, color: SK.ink3, marginBottom: 4 }}>Storage</div>
          <div style={{ fontSize: 12, color: SK.ink2 }}>{formatBytes(entries.reduce((s, e) => s + (e.size ?? 0), 0))} used</div>
        </div>
      </aside>

      {/* Main */}
      <main style={S.main}>
        {/* Toolbar */}
        <div style={S.toolbar}>
          {isNarrow ? (
            <button
              type="button"
              style={S.iconBtn}
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
            >
              ☰
            </button>
          ) : null}
          <div style={S.breadcrumb}>
            <button style={S.crumbBtn} onClick={() => setCurrentFolderId(null)}>
              {sidebarView === 'all' ? 'Home' : sidebarLabels[sidebarView]}
            </button>
            {sidebarView === 'all' && breadcrumb.map(f => (
              <span key={f.id}>
                <span style={S.crumbSep}>/</span>
                <button style={S.crumbBtn} onClick={() => setCurrentFolderId(f.id)}>{f.name}</button>
              </span>
            ))}
          </div>
          <input
            style={S.searchInput}
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button style={S.iconBtn} onClick={createFolder} title="New folder (Ctrl+Shift+N)">📁＋</button>
          <button
            style={S.iconBtn}
            onClick={() => setView(v => v === 'grid' ? 'list' : 'grid')}
            title="Toggle view"
          >{view === 'grid' ? '☰' : '▦'}</button>
          <button
            style={{ ...S.iconBtn, color: detailsOpen ? SK.ink : SK.ink3 }}
            onClick={() => setDetailsOpen(o => !o)}
            title="Toggle details"
          >◧</button>
        </div>

        <div style={S.workspace}>
          {/* Center: file area */}
          <div style={S.fileArea}>
            {uploads.size > 0 && (
              <div style={S.uploadBar}>
                {[...uploads.entries()].map(([id, u]) => (
                  <div key={id} style={S.uploadItem}>
                    <span style={{ flex: 1 }}>↑ {u.name}</span>
                    <div style={S.progressBar}>
                      <div style={{ ...S.progressFill, width: `${(u.loaded / Math.max(1, u.total)) * 100}%` }} />
                    </div>
                    <span style={{ fontSize: 11, color: SK.ink3 }}>
                      {Math.round((u.loaded / Math.max(1, u.total)) * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            )}

            {visibleEntries.length === 0 ? (
              <div style={S.emptyArea}>
                <div style={{ fontSize: 48, opacity: 0.2 }}>📁</div>
                <div style={{ marginTop: 12 }}>
                  {sidebarView === 'trash' ? 'Trash is empty.' :
                   sidebarView === 'starred' ? 'No starred files.' :
                   'Drop files here or click Upload to get started.'}
                </div>
              </div>
            ) : view === 'grid' ? (
              <div style={{ ...S.grid, gridTemplateColumns: isNarrow ? 'repeat(auto-fill, minmax(104px, 1fr))' : S.grid.gridTemplateColumns, gap: isNarrow ? 8 : S.grid.gap }}>
                {visibleEntries.map(entry => (
                  <div
                    key={entry.id}
                    style={{ ...S.gridItem, ...(selected.has(entry.id) ? S.gridItemSelected : {}) }}
                    onClick={e => onEntryClick(e, entry)}
                    onDoubleClick={() => onEntryDouble(entry)}
                  >
                    <div style={S.gridIcon}>{mimeIcon(entry)}</div>
                    <div style={S.gridName} title={entry.name}>{entry.name}</div>
                    <div style={S.gridMeta}>
                      {entry.type === 'folder' ? 'Folder' : formatBytes(entry.size)}
                      {entry.starred && <span style={{ color: SK.gold, marginLeft: 4 }}>★</span>}
                      {entry.anchorTx && <span style={{ color: SK.good, marginLeft: 4 }} title="Anchored">⬢</span>}
                      {(entry.shares?.length ?? 0) > 0 && <span style={{ color: SK.plasma, marginLeft: 4 }} title="Shared">⇄</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={S.list}>
                <div style={S.listHeader}>
                  <div style={{ flex: 2 }}>Name</div>
                  <div style={{ width: 100 }}>Size</div>
                  <div style={{ width: 140 }}>Modified</div>
                  <div style={{ width: 80 }}></div>
                </div>
                {visibleEntries.map(entry => (
                  <div
                    key={entry.id}
                    style={{ ...S.listRow, ...(selected.has(entry.id) ? S.listRowSelected : {}) }}
                    onClick={e => onEntryClick(e, entry)}
                    onDoubleClick={() => onEntryDouble(entry)}
                  >
                    <div style={{ flex: 2, display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                      <span>{mimeIcon(entry)}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
                      {entry.starred && <span style={{ color: SK.gold }}>★</span>}
                    </div>
                    <div style={{ width: 100, color: SK.ink3, fontSize: 12 }}>
                      {entry.type === 'folder' ? '—' : formatBytes(entry.size)}
                    </div>
                    <div style={{ width: 140, color: SK.ink3, fontSize: 12 }}>
                      {new Date(entry.updatedAt).toLocaleDateString()}
                    </div>
                    <div style={{ width: 80, display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                      {entry.anchorTx && <span style={{ color: SK.good }} title="Anchored">⬢</span>}
                      {(entry.shares?.length ?? 0) > 0 && <span style={{ color: SK.plasma }} title="Shared">⇄</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right: details pane */}
          {detailsOpen && (
            <div style={isNarrow ? S.detailsOverlay : undefined}>
            <DetailsPane
              entry={activeEntry}
              entries={entries}
              adapter={adapterRef.current}
              agentResults={agentResults}
              agentBusy={agentBusy}
              onDownload={downloadEntry}
              onDownloadVersion={downloadVersion}
              onRestoreVersion={restoreVersion}
              onReplaceVersion={promptReplaceVersion}
              onStar={toggleStar}
              onRename={rename}
              onTrash={moveToTrash}
              onRestore={restore}
              onDeleteForever={deleteForever}
              onAnchor={anchorOnChain}
              onShare={(e) => setShareDialogFor(e.id)}
              onRunAgent={runAgent}
            />
            </div>
          )}
        </div>
      </main>

      {/* Hidden inputs */}
      <input
        ref={versionUploadRef}
        type="file"
        style={{ display: 'none' }}
        onChange={onVersionFile}
      />

      {/* Status bar */}
      <div style={S.statusBar}>
        <span>Quay · {entries.filter(e => !e.trashed).length} items</span>
        <span style={{ flex: 1 }} />
        {uploads.size > 0 && <span>{uploads.size} uploading…</span>}
        <span style={{ opacity: 0.85, fontSize: 11 }}>{saveStatus}</span>
      </div>

      {/* Drag overlay */}
      {dragging && (
        <div style={S.dropOverlay}>
          <div style={{ fontSize: 64 }}>⬇</div>
          <div style={{ fontSize: 20, marginTop: 12 }}>Drop to upload</div>
          <div style={{ fontSize: 12, color: SK.ink3, marginTop: 4 }}>Files are encrypted before leaving your device</div>
        </div>
      )}

      {/* Share dialog */}
      {shareDialogFor && (
        <ShareDialog
          entry={entries.find(e => e.id === shareDialogFor)!}
          onCreate={createShare}
          onRevoke={(id) => {
            const e = entries.find(e => e.id === shareDialogFor);
            if (e) revokeShare(e, id);
          }}
          onClose={() => setShareDialogFor(null)}
        />
      )}
    </div>
  );
}

const sidebarLabels: Record<SidebarView, string> = {
  all: 'Home', starred: 'Starred', shared: 'Shared', recent: 'Recent', trash: 'Trash',
};

// ============================================================
// Inline preview
// ============================================================
function PreviewBlock({ entry, adapter }: { entry: FileEntry; adapter: SpacekitAdapter }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  // Clean up the object URL on unmount or when switching entries
  useEffect(() => {
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [objectUrl]);

  useEffect(() => {
    setText(null); setError(null);
    setObjectUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
  }, [entry.id]);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const blob = await materializeBlob(adapter, entry);
      if (isTextLike(entry.mimeType)) {
        const t = await blob.text();
        setText(t.length > 50_000 ? t.slice(0, 50_000) + '\n\n[…truncated, download to see full file]' : t);
      } else {
        setObjectUrl(URL.createObjectURL(blob));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  };

  if (!entry.cid) {
    return <div style={S.previewPlaceholder}><div style={S.dim}>No content yet.</div></div>;
  }
  if (!text && !objectUrl && !loading && !error) {
    return (
      <div style={S.previewPlaceholder}>
        <button style={S.btnPrimary} onClick={load}>👁 Load preview</button>
        <div style={{ ...S.dim, fontSize: 11, marginTop: 6 }}>
          Decrypts {formatBytes(entry.size)} client-side
        </div>
      </div>
    );
  }
  if (loading) return <div style={S.previewPlaceholder}><div style={S.dim}>Decrypting…</div></div>;
  if (error) return <div style={S.previewPlaceholder}><div style={{ color: '#f48771', fontSize: 12 }}>{error}</div></div>;

  const mime = entry.mimeType ?? '';

  if (mime.startsWith('image/') && objectUrl) {
    return <div style={S.previewBox}><img src={objectUrl} alt={entry.name} style={S.previewImg} /></div>;
  }
  if (mime.startsWith('video/') && objectUrl) {
    return <div style={S.previewBox}><video controls src={objectUrl} style={S.previewMedia} /></div>;
  }
  if (mime.startsWith('audio/') && objectUrl) {
    return <div style={S.previewBox}><audio controls src={objectUrl} style={{ width: '100%' }} /></div>;
  }
  if (mime === 'application/pdf' && objectUrl) {
    return (
      <div style={S.previewBox}>
        <embed src={objectUrl} type="application/pdf" style={{ width: '100%', height: 320, border: 'none', borderRadius: 4 }} />
      </div>
    );
  }
  if (text != null) {
    return <div style={S.previewBox}><pre style={S.previewPre}>{text}</pre></div>;
  }
  return <div style={S.previewPlaceholder}><div style={S.dim}>No inline preview for this type — use Download.</div></div>;
}

// ============================================================
// Details pane
// ============================================================
function DetailsPane({
  entry, entries, adapter, agentResults, agentBusy,
  onDownload, onDownloadVersion, onRestoreVersion, onReplaceVersion,
  onStar, onRename, onTrash, onRestore, onDeleteForever,
  onAnchor, onShare, onRunAgent,
}: {
  entry: FileEntry | null;
  entries: FileEntry[];
  adapter: SpacekitAdapter;
  agentResults: any;
  agentBusy: AgentName | null;
  onDownload: (e: FileEntry) => void;
  onDownloadVersion: (e: FileEntry, v: VersionEntry) => void;
  onRestoreVersion: (e: FileEntry, v: VersionEntry) => void;
  onReplaceVersion: (e: FileEntry) => void;
  onStar: (e: FileEntry) => void;
  onRename: (e: FileEntry) => void;
  onTrash: (e: FileEntry) => void;
  onRestore: (e: FileEntry) => void;
  onDeleteForever: (e: FileEntry) => void;
  onAnchor: (e: FileEntry) => void;
  onShare: (e: FileEntry) => void;
  onRunAgent: (a: AgentName) => void;
}) {
  if (!entry) {
    return (
      <aside style={S.detailsPane}>
        <div style={{ padding: 16 }}>
          <div style={S.sectionLabel}>Agents</div>
          <button
            style={S.btnPrimary}
            onClick={() => onRunAgent('organizer')}
            disabled={agentBusy === 'organizer'}
          >🗂 {agentBusy === 'organizer' ? '…' : 'Suggest folders'}</button>
          <button
            style={{ ...S.btnPrimary, marginLeft: 6 }}
            onClick={() => onRunAgent('dedup')}
            disabled={agentBusy === 'dedup'}
          >🔁 {agentBusy === 'dedup' ? '…' : 'Find duplicates'}</button>

          {agentResults.organizer && (
            <>
              <div style={{ ...S.sectionLabel, marginTop: 16 }}>Suggested moves</div>
              {agentResults.organizer.slice(0, 10).map((r: any) => {
                const f = entries.find(e => e.id === r.fileId);
                if (!f) return null;
                return (
                  <div key={r.fileId} style={{ ...S.linkRow, fontSize: 12 }}>
                    {f.name} → <span style={{ color: SK.plasma }}>{r.suggestedFolder}</span>
                  </div>
                );
              })}
            </>
          )}
          {agentResults.dedup && (
            <>
              <div style={{ ...S.sectionLabel, marginTop: 16 }}>
                Duplicate groups ({agentResults.dedup.groups.length})
              </div>
              {agentResults.dedup.groups.length === 0 && <div style={S.dim}>No duplicates found.</div>}
              {agentResults.dedup.groups.slice(0, 5).map((group: string[], i: number) => (
                <div key={i} style={S.linkRow}>
                  {group.map(id => {
                    const f = entries.find(e => e.id === id);
                    return f ? <div key={id} style={{ fontSize: 12 }}>{f.name}</div> : null;
                  })}
                </div>
              ))}
            </>
          )}
          {!agentResults.organizer && !agentResults.dedup && (
            <div style={{ ...S.dim, marginTop: 8 }}>
              Select a file to see details, or run an agent across all files.
            </div>
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside style={S.detailsPane}>
      <div style={S.detailsHeader}>
        <div style={{ fontSize: 48, textAlign: 'center', marginBottom: 8 }}>{mimeIcon(entry)}</div>
        <div style={S.detailsName}>{entry.name}</div>
        <div style={S.dim}>
          {entry.type === 'folder' ? 'Folder' : formatBytes(entry.size)}
          {entry.mimeType && ' · ' + entry.mimeType}
        </div>
      </div>

      <div style={S.actionRow}>
        {!entry.trashed && entry.type === 'file' && (
          <button style={S.btn} onClick={() => onDownload(entry)}>⬇ Download</button>
        )}
        {!entry.trashed && entry.type === 'file' && (
          <button style={S.btn} onClick={() => onReplaceVersion(entry)} title="Upload a new version">↻ New version</button>
        )}
        {!entry.trashed && (
          <button style={S.btn} onClick={() => onStar(entry)}>
            {entry.starred ? '★ Starred' : '☆ Star'}
          </button>
        )}
        {!entry.trashed && entry.type === 'file' && (
          <button style={S.btn} onClick={() => onShare(entry)}>⇄ Share</button>
        )}
        {!entry.trashed && (
          <button style={S.btn} onClick={() => onRename(entry)}>✎ Rename</button>
        )}
        {!entry.trashed && entry.type === 'file' && entry.contentHash && (
          <button style={S.btn} onClick={() => onAnchor(entry)}>⬢ Anchor</button>
        )}
        {!entry.trashed && (
          <button style={S.btn} onClick={() => onTrash(entry)}>🗑 Trash</button>
        )}
        {entry.trashed && (
          <>
            <button style={S.btn} onClick={() => onRestore(entry)}>↩ Restore</button>
            <button style={{ ...S.btn, background: '#5a1d1d' }} onClick={() => onDeleteForever(entry)}>
              ✕ Delete forever
            </button>
          </>
        )}
      </div>

      <div style={S.detailsBody}>
        {entry.type === 'file' && (
          <Section label="Preview">
            <PreviewBlock entry={entry} adapter={adapter} />
          </Section>
        )}

        <Section label="Provenance">
          <KV k="Encrypted" v={entry.encrypted ? '✓ AES-256-GCM' : 'No'} />
          {entry.contentHash && <KV k="SHA-256" v={entry.contentHash.slice(0, 16) + '…'} mono />}
          {entry.cid && <KV k="CID" v={entry.cid.slice(0, 16) + '…'} mono />}
          {entry.anchorTx ? (
            <>
              <KV k="Anchored" v={'✓ ' + new Date(entry.anchorTime!).toLocaleString()} />
              <KV k="Tx" v={entry.anchorTx.slice(0, 16) + '…'} mono />
            </>
          ) : (
            entry.type === 'file' && <KV k="Anchored" v="No — click ⬢ Anchor to commit on-chain" />
          )}
        </Section>

        {(entry.versions?.length ?? 0) > 0 && (
          <Section label={`Version history (${entry.versions!.length})`}>
            <div style={{ ...S.dim, fontSize: 11, marginBottom: 6 }}>
              Each version stays on the storage node as its own CID. Restoring keeps the current version in history.
            </div>
            {entry.versions!.map((v, i) => (
              <div key={v.cid} style={S.versionRow}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: SK.ink2 }}>
                    {i === 0 ? 'Previous' : `${i + 1} ago`} · {formatBytes(v.size)}
                  </div>
                  <div style={{ fontSize: 11, color: SK.ink3 }}>
                    {new Date(v.createdAt).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 10, color: '#585858', fontFamily: 'SF Mono, monospace' }}>
                    {v.contentHash.slice(0, 12)}…
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <button style={S.miniBtn} onClick={() => onDownloadVersion(entry, v)} title="Download this version">⬇</button>
                  <button style={S.miniBtn} onClick={() => onRestoreVersion(entry, v)} title="Make current">↻</button>
                </div>
              </div>
            ))}
          </Section>
        )}

        {(entry.shares?.length ?? 0) > 0 && (
          <Section label={`Shares (${entry.shares!.filter(s => !s.revokedAt).length} active)`}>
            {entry.shares!.map(s => (
              <div key={s.id} style={{ ...S.linkRow, fontSize: 12, opacity: s.revokedAt ? 0.5 : 1 }}>
                <div>{s.kind === 'public' ? '🔗 Public link' : '👤 Direct share'}</div>
                <div style={S.dim}>
                  {s.permissions} {s.expiresAt && `· expires ${new Date(s.expiresAt).toLocaleDateString()}`}
                  {s.revokedAt && ' · revoked'}
                </div>
              </div>
            ))}
          </Section>
        )}

        <Section label="Info">
          <KV k="Created" v={new Date(entry.createdAt).toLocaleString()} />
          <KV k="Modified" v={new Date(entry.updatedAt).toLocaleString()} />
        </Section>
      </div>
    </aside>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={S.sectionLabel}>{label}</div>
      {children}
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', gap: 8 }}>
      <span style={{ color: SK.ink3 }}>{k}</span>
      <span style={{ color: SK.ink2, fontFamily: mono ? SK.mono : undefined, textAlign: 'right' }}>{v}</span>
    </div>
  );
}

// ============================================================
// Share dialog
// ============================================================
function sharePageOrigin(): string {
  const embed = (window as Window & { __SPACEKIT_EMBED__?: { parentOrigin?: string } }).__SPACEKIT_EMBED__;
  return embed?.parentOrigin ?? window.location.origin;
}

function buildPublicShareUrl(entry: FileEntry, share: Share): string | null {
  if (share.kind !== 'public' || !share.publicToken) return null;
  if (!entry.wrappedKey) return null;
  const origin = sharePageOrigin();
  return `${origin}/s/${share.publicToken}#k=${encodeURIComponent(entry.wrappedKey)}`;
}

function ShareDialog({ entry, onCreate, onRevoke, onClose }: {
  entry: FileEntry;
  onCreate: (input: ShareInput) => Promise<Share | undefined>;
  onRevoke: (shareId: string) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<'public' | 'direct'>('public');
  const [permissions, setPermissions] = useState<'read' | 'write'>('read');
  const [recipient, setRecipient] = useState('');
  const [expiry, setExpiry] = useState('');
  const [creating, setCreating] = useState(false);
  const [newShare, setNewShare] = useState<Share | null>(null);

  const submit = async () => {
    setCreating(true);
    try {
      const s = await onCreate({
        fileId: entry.id,
        kind,
        recipientPubkey: kind === 'direct' ? recipient : undefined,
        permissions,
        expiresAt: expiry ? new Date(expiry).getTime() : undefined,
      });
      if (s) setNewShare(s);
    } finally { setCreating(false); }
  };

  const linkUrl = newShare ? buildPublicShareUrl(entry, newShare) : null;

  return (
    <div style={S.modalBackdrop} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong>Share "{entry.name}"</strong>
          <button style={S.iconBtn} onClick={onClose}>×</button>
        </div>

        {newShare ? (
          <div>
            <div style={{ ...S.dim, marginBottom: 8 }}>Share created. Anchored on-chain.</div>
            {linkUrl && (
              <>
                <div style={S.label}>Public link</div>
                <input style={S.input} value={linkUrl} readOnly onClick={e => (e.target as HTMLInputElement).select()} />
                <div style={{ ...S.dim, marginTop: 4, fontSize: 11 }}>
                  Key lives in the URL fragment — never sent to the storage node.
                </div>
              </>
            )}
            {!linkUrl && newShare?.kind === 'public' && (
              <div style={{ ...S.dim, marginBottom: 8, fontSize: 12, color: '#f48771' }}>
                Could not build link — file is missing an encryption key.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button style={S.btn} onClick={() => setNewShare(null)}>Create another</button>
              <button style={S.btnPrimary} onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <>
            <div style={S.label}>Share type</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <button
                style={kind === 'public' ? S.segActive : S.seg}
                onClick={() => setKind('public')}
              >🔗 Public link</button>
              <button
                style={kind === 'direct' ? S.segActive : S.seg}
                onClick={() => setKind('direct')}
              >👤 Direct (by pubkey)</button>
            </div>

            {kind === 'direct' && (
              <>
                <div style={S.label}>Recipient public key</div>
                <input
                  style={S.input}
                  placeholder="0x… or did:…"
                  value={recipient}
                  onChange={e => setRecipient(e.target.value)}
                />
              </>
            )}

            <div style={S.label}>Permissions</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <button style={permissions === 'read' ? S.segActive : S.seg} onClick={() => setPermissions('read')}>Read only</button>
              <button style={permissions === 'write' ? S.segActive : S.seg} onClick={() => setPermissions('write')}>Read + write</button>
            </div>

            <div style={S.label}>Expires (optional)</div>
            <input
              style={S.input}
              type="date"
              value={expiry}
              onChange={e => setExpiry(e.target.value)}
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button style={S.btn} onClick={onClose}>Cancel</button>
              <button
                style={S.btnPrimary}
                onClick={submit}
                disabled={creating || (kind === 'direct' && !recipient)}
              >{creating ? 'Creating…' : 'Create share'}</button>
            </div>
          </>
        )}

        {(entry.shares?.length ?? 0) > 0 && !newShare && (
          <>
            <div style={{ ...S.sectionLabel, marginTop: 20 }}>Existing shares</div>
            {entry.shares!.map(s => (
              <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', fontSize: 12, opacity: s.revokedAt ? 0.5 : 1 }}>
                <span>
                  {s.kind === 'public' ? '🔗' : '👤'} {s.permissions}
                  {s.revokedAt && ' · revoked'}
                </span>
                {!s.revokedAt && (
                  <button style={{ ...S.btn, padding: '2px 8px', fontSize: 11 }} onClick={() => onRevoke(s.id)}>
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Styles
// ============================================================
const S: Record<string, CSSProperties> = {
  root: {
    display: 'grid',
    gridTemplateColumns: '220px 1fr',
    gridTemplateRows: '1fr 28px',
    background: SK.bg,
    color: SK.ink,
    fontFamily: SK.font,
    fontSize: 13,
    overflow: 'hidden',
    position: 'relative',
    minHeight: 0,
  },

  sidebar: {
    background: SK.rail,
    borderRight: `1px solid ${SK.lineSoft}`,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  sidebarTitle: {
    padding: '14px 16px 8px',
    fontWeight: 600,
    fontSize: 15,
    color: SK.ink,
    fontFamily: SK.font,
  },
  uploadBtn: {
    margin: '8px 12px 8px',
    paddingTop: 8,
    paddingRight: 12,
    paddingBottom: 8,
    paddingLeft: 12,
    background: `linear-gradient(135deg, ${SK.gold}, ${SK.goldDeep})`,
    color: '#0b0e18',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: SK.font,
  },
  nav: { flex: 1, padding: 6, display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '7px 10px',
    background: 'transparent',
    border: 'none',
    color: SK.ink2,
    cursor: 'pointer',
    borderRadius: 8,
    fontSize: 13,
    textAlign: 'left',
    fontFamily: SK.font,
  },
  navItemActive: { background: 'rgba(243,200,121,0.12)', color: SK.ink },
  navCount: {
    fontSize: 11,
    color: SK.ink3,
    background: 'rgba(255,255,255,0.04)',
    padding: '1px 6px',
    borderRadius: 10,
    border: `1px solid ${SK.lineSoft}`,
  },
  sidebarFooter: { padding: '8px 16px 12px', borderTop: `1px solid ${SK.lineSoft}` },

  main: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: SK.bg },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderBottom: `1px solid ${SK.lineSoft}`,
    background: SK.panel2,
    flexWrap: 'wrap',
    minWidth: 0,
  },
  breadcrumb: { flex: 1, display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' },
  crumbBtn: {
    background: 'none',
    border: 'none',
    color: SK.ink2,
    cursor: 'pointer',
    fontSize: 13,
    padding: '4px 6px',
    borderRadius: 6,
    fontFamily: SK.font,
  },
  crumbSep: { color: SK.ink3, margin: '0 2px' },
  searchInput: {
    flex: '1 1 140px',
    minWidth: 120,
    maxWidth: 280,
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${SK.lineSoft}`,
    color: SK.ink,
    padding: '5px 10px',
    borderRadius: 8,
    fontSize: 12,
    outline: 'none',
    fontFamily: SK.font,
  },
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
    fontSize: 14,
  },

  workspace: { flex: 1, display: 'flex', minHeight: 0, minWidth: 0 },
  detailsOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 60,
    background: 'rgba(6,8,15,0.92)',
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
  },
  mobileBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 40,
    border: 'none',
    padding: 0,
    margin: 0,
    background: 'rgba(0,0,0,0.5)',
    cursor: 'pointer',
  },
  fileArea: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  uploadBar: { padding: 8, borderBottom: `1px solid ${SK.lineSoft}`, background: SK.panel2 },
  uploadItem: { display: 'flex', alignItems: 'center', gap: 8, padding: 4, fontSize: 12, color: SK.ink2 },
  progressBar: { width: 120, height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', background: SK.gold, transition: 'width 0.1s' },

  emptyArea: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: SK.ink3 },

  grid: {
    flex: 1,
    overflowY: 'auto',
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: 8,
    padding: 16,
    alignContent: 'start',
    minHeight: 0,
  },
  gridItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    cursor: 'pointer',
    border: `1px solid transparent`,
    textAlign: 'center',
    overflow: 'hidden',
  },
  gridItemSelected: { background: 'rgba(243,200,121,0.12)', borderColor: SK.gold },
  gridIcon: { fontSize: 40, marginBottom: 8 },
  gridName: { fontSize: 12, color: SK.ink, wordBreak: 'break-word', maxHeight: 32, overflow: 'hidden' },
  gridMeta: { fontSize: 10, color: SK.ink3, marginTop: 4 },

  list: { flex: 1, overflowY: 'auto', minHeight: 0 },
  listHeader: {
    display: 'flex',
    padding: '8px 16px',
    fontSize: 11,
    color: SK.ink3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    borderBottom: `1px solid ${SK.lineSoft}`,
    background: SK.panel2,
    position: 'sticky',
    top: 0,
    gap: 8,
  },
  listRow: {
    display: 'flex',
    padding: '6px 16px',
    cursor: 'pointer',
    borderBottom: `1px solid ${SK.lineSoft}`,
    gap: 8,
    alignItems: 'center',
  },
  listRowSelected: { background: 'rgba(243,200,121,0.12)' },

  detailsPane: {
    width: 300,
    borderLeft: `1px solid ${SK.lineSoft}`,
    background: SK.rail,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  detailsHeader: { padding: 16, borderBottom: `1px solid ${SK.lineSoft}` },
  detailsName: { fontSize: 14, fontWeight: 500, textAlign: 'center', wordBreak: 'break-word', marginBottom: 4, color: SK.ink },
  actionRow: { padding: 12, borderBottom: `1px solid ${SK.lineSoft}`, display: 'flex', flexWrap: 'wrap', gap: 4 },
  detailsBody: { padding: 16, fontSize: 12, color: SK.ink2 },
  sectionLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: SK.ink3, marginBottom: 6 },
  linkRow: { padding: '6px 8px', borderRadius: 6, marginBottom: 4 },

  btn: {
    background: 'rgba(255,255,255,0.06)',
    color: SK.ink,
    border: `1px solid ${SK.lineSoft}`,
    padding: '4px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 11,
    fontFamily: SK.font,
  },
  btnPrimary: {
    background: `linear-gradient(135deg, ${SK.gold}, ${SK.goldDeep})`,
    color: '#0b0e18',
    border: 'none',
    padding: '5px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: SK.font,
  },
  miniBtn: {
    background: 'rgba(255,255,255,0.06)',
    color: SK.ink2,
    border: `1px solid ${SK.lineSoft}`,
    padding: '3px 7px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 10,
  },
  dim: { color: SK.ink3, fontSize: 12 },

  previewPlaceholder: { padding: 16, textAlign: 'center', background: SK.panel2, borderRadius: 8 },
  previewBox: { background: SK.panel2, borderRadius: 8, padding: 8, overflow: 'hidden' },
  previewImg: { maxWidth: '100%', maxHeight: 240, display: 'block', margin: '0 auto', borderRadius: 8 },
  previewMedia: { maxWidth: '100%', maxHeight: 240, display: 'block', margin: '0 auto', borderRadius: 8 },
  previewPre: {
    margin: 0,
    padding: 8,
    color: SK.ink2,
    fontSize: 11,
    fontFamily: SK.mono,
    maxHeight: 280,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },

  versionRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 6px', borderBottom: `1px solid ${SK.lineSoft}` },

  statusBar: {
    gridColumn: '1 / 3',
    background: SK.rail,
    color: SK.ink2,
    borderTop: `1px solid ${SK.lineSoft}`,
    display: 'flex',
    alignItems: 'center',
    padding: '0 12px',
    fontSize: 12,
    gap: 16,
    userSelect: 'none',
  },

  dropOverlay: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(243,200,121,0.12)',
    border: `3px dashed ${SK.gold}`,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
    pointerEvents: 'none',
    color: SK.gold,
  },

  modalBackdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modal: {
    background: SK.panel2,
    border: `1px solid ${SK.line}`,
    borderRadius: 12,
    padding: 20,
    width: 460,
    maxHeight: '80vh',
    overflowY: 'auto',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    color: SK.ink,
  },
  label: { fontSize: 11, color: SK.ink3, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4, marginTop: 8 },
  input: {
    width: '100%',
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${SK.lineSoft}`,
    color: SK.ink,
    padding: '6px 8px',
    borderRadius: 8,
    fontSize: 12,
    outline: 'none',
    boxSizing: 'border-box',
    fontFamily: SK.font,
  },
  seg: {
    flex: 1,
    background: 'rgba(255,255,255,0.04)',
    color: SK.ink2,
    border: `1px solid ${SK.lineSoft}`,
    padding: '6px 10px',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: SK.font,
  },
  segActive: {
    flex: 1,
    background: 'rgba(243,200,121,0.14)',
    color: SK.gold,
    border: `1px solid rgba(243,200,121,0.35)`,
    padding: '6px 10px',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: SK.font,
  },
};

// ============================================================
// ShareReceiver — drop this in a route like /s/:token
// ============================================================
//
// Usage with React Router:
//   <Route path="/s/:token" element={<ShareReceiverPage />} />
//
//   function ShareReceiverPage() {
//     const { token } = useParams();
//     // The decryption key arrives in the URL fragment (#k=...) so the storage
//     // node and contracts never see it. document.location.hash is client-only.
//     const hash = new URLSearchParams(window.location.hash.slice(1));
//     return <ShareReceiver shareToken={token!} decryptKey={hash.get('k') ?? undefined} />;
//   }

export interface ShareReceiverProps {
  /** Optional adapter override. Defaults to the mock for demo purposes. */
  adapter?: SpacekitAdapter;
  /** Share token from the URL path (e.g. /s/:token). */
  shareToken: string;
  /** Base64-encoded AES key from the URL fragment for public shares. */
  decryptKey?: string;
  /** Optional callback when the recipient successfully decrypts the file. */
  onDownloaded?: (entry: FileEntry, blob: Blob) => void;
}

export function ShareReceiver({ adapter, shareToken, decryptKey, onDownloaded }: ShareReceiverProps) {
  const adapterRef = useRef<SpacekitAdapter>(adapter ?? createMockAdapter());
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [entry, setEntry] = useState<FileEntry | null>(null);
  const [share, setShare] = useState<Share | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);

  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [previewUrl]);

  // Resolve the share token to a file entry.
  //
  // In production this would call a contract method like
  //   contracts.lookupShare(shareToken) → { fileId, permissions, expiresAt, revokedAt }
  // and then fetch the file record. For the mock, we scan all file records.
  useEffect(() => {
    (async () => {
      try {
        const a = adapterRef.current;
        let foundEntry: FileEntry | null = null;
        let foundShare: Share | null = null;

        const indexed = await a.storage.getRecord<{ fileId: string; share: Share }>(`share:${shareToken}`);
        if (indexed?.fileId && indexed.share) {
          foundShare = indexed.share;
          foundEntry = await a.storage.getRecord<FileEntry>('file:' + indexed.fileId);
        }

        if (!foundEntry || !foundShare) {
          const keys = await a.storage.listRecords('file:');
          for (const k of keys) {
            const id = k.replace(/^file:/, '');
            const e = await a.storage.getRecord<FileEntry>('file:' + id);
            const s = e?.shares?.find(s => s.publicToken === shareToken);
            if (e && s) { foundEntry = e; foundShare = s; break; }
          }
        }

        if (!foundEntry || !foundShare) throw new Error('Share not found.');
        if (foundShare.revokedAt) throw new Error('This share has been revoked.');
        if (foundShare.expiresAt && Date.now() > foundShare.expiresAt) {
          throw new Error('This share has expired.');
        }
        setEntry(foundEntry);
        setShare(foundShare);
        setState('ready');
      } catch (e) {
        setError((e as Error).message);
        setState('error');
      }
    })();
  }, [shareToken]);

  const obtainKey = async (): Promise<CryptoKey | null> => {
    const a = adapterRef.current;
    // Public link: key is in the URL fragment (never sent to network)
    if (share?.kind === 'public') {
      if (!decryptKey) throw new Error('Missing decryption key in URL fragment.');
      return a.crypto.unwrapKey(decryptKey);
    }
    // Direct share: the recipient unwraps using their own private key.
    // The wrappedKey lives on the file record under share metadata; in this
    // mock we fall back to the owner-wrapped key so the demo works.
    if (entry?.wrappedKey) return a.crypto.unwrapKey(entry.wrappedKey);
    return null;
  };

  const fetchAndDecrypt = async (): Promise<Blob> => {
    if (!entry) throw new Error('No entry');
    const a = adapterRef.current;
    const rawKey = await obtainKey();
    return materializeBlob(a, { ...entry, rawKey: rawKey ?? undefined });
  };

  const download = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      const blob = await fetchAndDecrypt();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = entry.name; link.click();
      URL.revokeObjectURL(url);
      onDownloaded?.(entry, blob);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const preview = async () => {
    if (!entry) return;
    setBusy(true); setError('');
    try {
      const blob = await fetchAndDecrypt();
      if (isTextLike(entry.mimeType)) {
        const t = await blob.text();
        setPreviewText(t.length > 50_000 ? t.slice(0, 50_000) + '\n\n[…truncated]' : t);
      } else {
        setPreviewUrl(URL.createObjectURL(blob));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const wrap: CSSProperties = {
    fontFamily: SK.font,
    background: SK.bg,
    color: SK.ink,
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  };
  const card: CSSProperties = {
    background: SK.panel2,
    border: `1px solid ${SK.lineSoft}`,
    borderRadius: 12,
    padding: 32,
    width: 520,
    maxWidth: '100%',
    textAlign: 'center',
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
  };

  if (state === 'loading') {
    return <div style={wrap}><div style={card}><div style={S.dim}>Looking up share…</div></div></div>;
  }
  if (state === 'error' || !entry || !share) {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>⚠</div>
          <div style={{ color: '#f48771', marginBottom: 8, fontSize: 16 }}>Cannot access this share</div>
          <div style={S.dim}>{error}</div>
        </div>
      </div>
    );
  }

  const mime = entry.mimeType ?? '';

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 64, marginBottom: 12 }}>{mimeIcon(entry)}</div>
        <div style={{ fontSize: 18, fontWeight: 500, marginBottom: 4 }}>{entry.name}</div>
        <div style={{ ...S.dim, marginBottom: 20 }}>
          {formatBytes(entry.size)}{mime && ' · ' + mime}
        </div>

        {/* Preview area */}
        {previewUrl && mime.startsWith('image/') && (
          <div style={{ marginBottom: 20 }}><img src={previewUrl} alt={entry.name} style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 4 }} /></div>
        )}
        {previewUrl && mime.startsWith('video/') && (
          <div style={{ marginBottom: 20 }}><video controls src={previewUrl} style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 4 }} /></div>
        )}
        {previewUrl && mime === 'application/pdf' && (
          <div style={{ marginBottom: 20 }}><embed src={previewUrl} type="application/pdf" style={{ width: '100%', height: 400, border: 'none', borderRadius: 4 }} /></div>
        )}
        {previewText != null && (
          <pre style={{ ...S.previewPre, marginBottom: 20, textAlign: 'left' }}>{previewText}</pre>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button
            style={{ ...S.btn, fontSize: 13, padding: '10px 20px' }}
            onClick={preview}
            disabled={busy}
          >{busy ? 'Decrypting…' : '👁 Preview'}</button>
          <button
            style={{ ...S.btnPrimary, fontSize: 13, padding: '10px 20px' }}
            onClick={download}
            disabled={busy}
          >{busy ? 'Decrypting…' : '⬇ Download'}</button>
        </div>

        {share.permissions === 'read' && (
          <div style={{ ...S.dim, marginTop: 12, fontSize: 11 }}>Read-only access</div>
        )}
        {entry.anchorTx && (
          <div style={{ ...S.dim, marginTop: 16, fontSize: 11 }}>
            ⬢ Anchored on Spacekit · {new Date(entry.anchorTime!).toLocaleString()}
          </div>
        )}
        <div style={{ ...S.dim, marginTop: 12, fontSize: 11, lineHeight: 1.4 }}>
          End-to-end encrypted. Decryption happens in your browser; the storage node and contracts never see the file contents.
        </div>
      </div>
    </div>
  );
}
