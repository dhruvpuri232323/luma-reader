// Minimal promise wrapper around IndexedDB. Everything the app knows lives here
// first; the cloud is a mirror of the synced stores.

const DB_NAME = "luma-reader";
const DB_VERSION = 2;

/** Stores that are mirrored to Firestore (one record = one Firestore doc). */
export const SYNCED = ["docs", "words", "annotations", "bookmarks", "settings"];
/** Device-only stores. */
const LOCAL = ["files", "covers", "defs", "outbox", "kv", "texts", "freq"];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [...SYNCED, ...LOCAL]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer version of Luma opened in another window needs to upgrade the
      // database: step aside so it isn't left waiting, and ask for a reload.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        window.dispatchEvent(new CustomEvent("luma-db-replaced"));
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // An older copy of Luma is still open somewhere and holds the database.
    // The upgrade continues by itself as soon as that window or tab is closed.
    req.onblocked = () => {
      console.warn("IndexedDB upgrade blocked by another tab");
      window.dispatchEvent(new CustomEvent("luma-db-blocked"));
    };
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const idb = {
  get: (store, id) => tx(store, "readonly", (s) => reqP(s.get(id))),
  getAll: (store) => tx(store, "readonly", (s) => reqP(s.getAll())),
  put: (store, value) => tx(store, "readwrite", (s) => reqP(s.put(value))),
  putMany: (store, values) => tx(store, "readwrite", (s) => Promise.all(values.map((v) => reqP(s.put(v))))),
  delete: (store, id) => tx(store, "readwrite", (s) => reqP(s.delete(id))),
  clear: (store) => tx(store, "readwrite", (s) => reqP(s.clear())),
  keys: (store) => tx(store, "readonly", (s) => reqP(s.getAllKeys())),
};

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* not supported */ }
}
