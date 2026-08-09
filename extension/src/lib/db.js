/**
 * Capture handoff store.
 *
 * The service worker captures; the editor page renders. They share the
 * extension origin, so IndexedDB is the cheapest way to move a multi-megabyte
 * capture between them — no messaging size limits, no base64 bloat, and
 * nothing ever leaves the browser profile.
 *
 * Captures are deleted the moment the editor has them. Nothing persists
 * unless the user explicitly saves a file to disk themselves.
 */

const DB_NAME = 'blackbar';
const DB_VERSION = 1;
const STORE = 'captures';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function putCapture(capture) {
  const db = await open();
  await tx(db, 'readwrite', (s) => s.put(capture));
  db.close();
  return capture.id;
}

export async function takeCapture(id) {
  const db = await open();
  const rec = await tx(db, 'readonly', (s) => s.get(id));
  if (rec) await tx(db, 'readwrite', (s) => s.delete(id));
  db.close();
  return rec;
}

/** Sweep anything older than 5 minutes — a crashed editor shouldn't leave pixels behind. */
export async function sweep(maxAgeMs = 5 * 60 * 1000) {
  const db = await open();
  const all = await tx(db, 'readonly', (s) => s.getAll());
  const cutoff = Date.now() - maxAgeMs;
  const stale = (all || []).filter((r) => r.createdAt < cutoff);
  if (stale.length) {
    await tx(db, 'readwrite', (s) => { stale.forEach((r) => s.delete(r.id)); return null; });
  }
  db.close();
  return stale.length;
}
