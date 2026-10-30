// Sync engine: mirrors the synced IndexedDB stores to the signed-in user's
// Firestore collections in both directions.
//
//  • Pull: a live listener per collection merges remote changes (last write wins
//    on `updatedAt`). Deletions travel as tombstones ({ deleted: true }).
//  • Push: every local change is queued in the IndexedDB outbox and flushed when
//    signed in and online, so edits made offline or before signing in are kept.

import { idb, SYNCED } from "../data/db.js";
import { store } from "../data/store.js";
import { bus, debounce } from "../core/util.js";
import { firebaseConfigured, createFirebaseAdapter } from "./firebase.js";

const state = {
  adapter: null,
  user: null,
  status: "local", // local | setup | signed-out | syncing | synced | offline | error
  error: null,
  unsubs: [],
  remoteSeen: new Map(),
  pending: 0,
  initialPulls: new Set(),
  uploads: new Map(), // docId -> progress 0..1
};

export const sync = {
  get user() { return state.user; },
  get status() { return state.status; },
  get error() { return state.error; },
  get available() { return Boolean(state.adapter); },
  get cloudPdfs() { return Boolean(state.adapter?.cloudPdfs && state.user); },
  get pending() { return state.pending; },
  uploadProgress: (docId) => state.uploads.get(docId),

  async init() {
    try {
      if (window.__LUMA_TEST_ADAPTER__) state.adapter = window.__LUMA_TEST_ADAPTER__;
      else if (firebaseConfigured()) state.adapter = await createFirebaseAdapter();
    } catch (e) {
      console.error("Firebase failed to load", e);
      state.error = navigator.onLine ? "Couldn't load Firebase. Check js/firebase-config.js." : "Offline — sync starts when you reconnect.";
      setStatus(navigator.onLine ? "error" : "offline");
      window.addEventListener("online", () => location.reload(), { once: true });
      return;
    }
    if (!state.adapter) return setStatus(firebaseConfigured() ? "error" : "local");

    setStatus("signed-out");
    state.adapter.onAuth((user) => {
      state.user = user;
      stop();
      if (user) start();
      else setStatus("signed-out");
      bus.emit("account", user);
    });
    bus.on("outbox", scheduleFlush);
    window.addEventListener("online", () => { if (state.user) { setStatus("syncing"); flush(); } });
    window.addEventListener("offline", () => state.user && setStatus("offline"));
    await refreshPending();
  },

  async signIn() {
    if (!state.adapter) throw new Error("Sync isn't set up yet — add your Firebase settings first.");
    state.error = null;
    await state.adapter.signIn();
  },

  async signOut() {
    await state.adapter?.signOut();
  },

  flushNow: () => flush(),

  async uploadPdf(docId) {
    if (!this.cloudPdfs || state.uploads.has(docId)) return;
    const blob = await store.getFile(docId);
    if (!blob) return;
    state.uploads.set(docId, 0);
    bus.emit("upload", { docId, progress: 0 });
    try {
      await state.adapter.uploadPdf(state.user.uid, docId, blob, (p) => {
        state.uploads.set(docId, p);
        bus.emit("upload", { docId, progress: p });
      });
      await store.patch("docs", docId, { cloud: true });
    } finally {
      state.uploads.delete(docId);
      bus.emit("upload", { docId, progress: null });
    }
  },

  async downloadPdf(docId) {
    if (!this.cloudPdfs) throw new Error("Sign in with cloud PDFs turned on to download this book.");
    const blob = await state.adapter.downloadPdf(state.user.uid, docId);
    await store.putFile(docId, blob);
    return blob;
  },
};

function setStatus(s) {
  state.status = s;
  bus.emit("sync-status", s);
}

function start() {
  const uid = state.user.uid;
  setStatus(navigator.onLine ? "syncing" : "offline");
  state.initialPulls = new Set(SYNCED);
  for (const coll of SYNCED) {
    const unsub = state.adapter.listen(
      uid,
      coll,
      async (recs) => {
        for (const rec of recs) {
          const key = `${coll}/${rec.id}`;
          state.remoteSeen.set(key, Math.max(state.remoteSeen.get(key) || 0, rec.updatedAt || 0));
          await store.applyRemote(coll, rec);
        }
        if (state.initialPulls.delete(coll) && state.initialPulls.size === 0) {
          await flush();
          autoUploadPdfs();
        }
      },
      (err) => {
        console.error("Sync listener", coll, err);
        state.error = err?.code === "permission-denied"
          ? "Firestore refused access. Publish the rules in firebase/firestore.rules."
          : err?.message || String(err);
        setStatus("error");
      }
    );
    state.unsubs.push(unsub);
  }
}

function stop() {
  state.unsubs.forEach((u) => { try { u(); } catch {} });
  state.unsubs = [];
  state.remoteSeen.clear();
}

let flushing = false;
let again = false;
const scheduleFlush = debounce(() => flush(), 600);

async function flush() {
  if (!state.user || !state.adapter) return refreshPending();
  if (flushing) { again = true; return; }
  if (!navigator.onLine) { setStatus("offline"); return refreshPending(); }
  flushing = true;
  setStatus("syncing");
  try {
    const items = await idb.getAll("outbox");
    for (const item of items) {
      const rec = store.raw(item.coll).find((r) => r.id === item.docId);
      if (rec) {
        const seen = state.remoteSeen.get(item.id) || 0;
        if (seen <= (rec.updatedAt || 0)) {
          await withTimeout(state.adapter.write(state.user.uid, item.coll, JSON.parse(JSON.stringify(rec))), 20000);
          state.remoteSeen.set(item.id, rec.updatedAt || 0);
          if (item.coll === "docs" && rec.deleted && state.adapter.cloudPdfs) state.adapter.deletePdf(state.user.uid, rec.id);
        }
      }
      // Only clear the entry if it wasn't re-queued while we were writing.
      const latest = await idb.get("outbox", item.id);
      if (latest && latest.at === item.at) await idb.delete("outbox", item.id);
    }
    if (state.status !== "error") setStatus("synced");
  } catch (e) {
    console.warn("Flush paused:", e);
    state.error = e?.code === "permission-denied" ? "Firestore refused the write. Publish firebase/firestore.rules." : null;
    setStatus(state.error ? "error" : navigator.onLine ? "syncing" : "offline");
  } finally {
    flushing = false;
    await refreshPending();
    if (again) { again = false; scheduleFlush(); }
  }
}

async function refreshPending() {
  state.pending = (await idb.keys("outbox")).length;
  bus.emit("sync-pending", state.pending);
}

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function autoUploadPdfs() {
  if (!sync.cloudPdfs || !store.settings().autoUploadPdfs) return;
  const files = await store.fileIds();
  for (const d of store.list("docs")) {
    if (!d.cloud && files.has(d.id)) {
      try { await sync.uploadPdf(d.id); } catch (e) { console.warn("Upload failed", d.id, e); break; }
    }
  }
}

bus.on("doc-imported", (docId) => {
  if (sync.cloudPdfs && store.settings().autoUploadPdfs) sync.uploadPdf(docId).catch((e) => console.warn(e));
});
