/**
 * IndexedDB-backed chat storage for SpaceKit Messaging.
 *
 * Primary local persistence layer — messages survive page reloads and tab closes
 * without requiring a reachable storage node. The storage node archive becomes an
 * *opportunistic* encrypted backup for cross-device recovery.
 *
 * Database layout:
 *   DB name:  `spacekit-messaging-{didSlug}`
 *   Store:    `threads`   — one record per peer/group key, value is the message array
 *   Store:    `meta`      — singleton metadata (lastSyncedAt, version, …)
 */

const DB_VERSION = 1;
const THREADS_STORE = "threads";
const META_STORE = "meta";

type ThreadMsg = {
  id: string;
  role: "user" | "peer";
  content: string;
  createdAt: string;
};

export type ThreadsState = Record<string, ThreadMsg[]>;

function dbName(did: string): string {
  return `spacekit-messaging-${did.replace(/[^a-zA-Z0-9-]/g, "-")}`;
}

function openDb(did: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(did), DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(THREADS_STORE)) {
        db.createObjectStore(THREADS_STORE);
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Persist a single thread (peer key → messages array). */
export async function putThread(did: string, peerKey: string, messages: ThreadMsg[]): Promise<void> {
  const db = await openDb(did);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(THREADS_STORE, "readwrite");
    tx.objectStore(THREADS_STORE).put(messages, peerKey);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Persist all threads at once (bulk write). */
export async function putAllThreads(did: string, threads: ThreadsState): Promise<void> {
  const db = await openDb(did);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(THREADS_STORE, "readwrite");
    const store = tx.objectStore(THREADS_STORE);
    store.clear();
    for (const [key, msgs] of Object.entries(threads)) {
      store.put(msgs, key);
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Load all threads from IndexedDB. */
export async function getAllThreads(did: string): Promise<ThreadsState> {
  const db = await openDb(did);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(THREADS_STORE, "readonly");
    const store = tx.objectStore(THREADS_STORE);
    const cursorReq = store.openCursor();
    const result: ThreadsState = {};
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        result[cursor.key as string] = cursor.value;
        cursor.continue();
      } else {
        db.close();
        resolve(result);
      }
    };
    cursorReq.onerror = () => { db.close(); reject(cursorReq.error); };
  });
}

/** Delete a single thread. */
export async function deleteThread(did: string, peerKey: string): Promise<void> {
  const db = await openDb(did);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(THREADS_STORE, "readwrite");
    tx.objectStore(THREADS_STORE).delete(peerKey);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Read/write metadata (e.g. lastSyncedAt). */
export async function getMeta(did: string, key: string): Promise<unknown> {
  const db = await openDb(did);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readonly");
    const req = tx.objectStore(META_STORE).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function setMeta(did: string, key: string, value: unknown): Promise<void> {
  const db = await openDb(did);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/**
 * Merge remote threads into local threads.
 * For each peer key, messages are merged by ID (deduped) and sorted chronologically.
 */
export function mergeThreads(local: ThreadsState, remote: ThreadsState): ThreadsState {
  const merged: ThreadsState = { ...local };
  for (const [key, remoteMsgs] of Object.entries(remote)) {
    const localMsgs = merged[key] ?? [];
    const ids = new Set(localMsgs.map((m) => m.id));
    const combined = [...localMsgs];
    for (const msg of remoteMsgs) {
      if (!ids.has(msg.id)) combined.push(msg);
    }
    combined.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    merged[key] = combined.slice(-200);
  }
  return merged;
}
