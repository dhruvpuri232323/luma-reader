// The app's single source of truth. Synced collections are held in memory for
// instant UI, persisted to IndexedDB, and every local change is queued in the
// outbox so the sync engine can mirror it to Firestore — even if the change
// happened while signed out or offline.

import { idb, SYNCED } from "./db.js";
import { bus } from "../core/util.js";

const mem = Object.fromEntries(SYNCED.map((c) => [c, new Map()]));

export const DEFAULT_SETTINGS = {
  id: "settings",
  theme: "auto", // auto | light | dark | sepia
  accent: "lamp", // lamp | tide | iris | fern | ember
  sounds: true,
  reduceMotion: false,
  hoverLookup: true,
  hoverDelay: 450,
  tapLookup: true,
  reflowFont: "literata",
  reflowSize: 19,
  reflowLeading: 1.6,
  reflowWidth: "balanced", // narrow | balanced | wide (text column width in Book view)
  justify: true,
  paraStyle: "indent", // indent | spaced
  bookSpread: "auto", // auto (two pages on wide screens) | single
  underlineSaved: true,
  defaultMode: "pdf", // view for books opened for the first time: pdf | book
  bookLayout: "pages", // pages | scroll
  pageTurn: "slide", // slide | curl | none (older single setting; the Modern edition still follows it)
  bookFeel: "auto", // edition for books you haven't set up: auto (match the book) | modern | paperback | hardcover | pocket | antique | magazine | ereader
  pageSounds: true, // page-turn sounds (each book can still turn its own off)
  trackReading: true, // measure reading time, pages and pace (for the timer and Insights)
  readScans: true, // read scanned PDFs with on-device text recognition
  readGoal: 20, // minutes a day
  ruler: false,
  warm: "off", // off | night | on
  warmth: 0.35,
  recap: true,
  markHard: false,
  speechRate: 1,
  wordHighlight: true,
  characterVoices: true,
  skipCitations: true,
  skipCaptions: true,
  pronunciations: {},
  reviewReminder: false,
  reminderHour: 19,
  dailyGoal: 10,
  autoUploadPdfs: true,
  updatedAt: 0,
};

let clock = 0;
/** Monotonic timestamp so two quick edits never share an updatedAt. */
export function now() {
  clock = Math.max(Date.now(), clock + 1);
  return clock;
}

export const store = {
  async init() {
    await Promise.all(
      SYNCED.map(async (c) => {
        const rows = await idb.getAll(c);
        for (const r of rows) mem[c].set(r.id, r);
      })
    );
  },

  /** Live (non-deleted) records */
  list(coll) {
    return [...mem[coll].values()].filter((r) => !r.deleted);
  },

  /** Includes tombstones — used by sync and backup */
  raw(coll) {
    return [...mem[coll].values()];
  },

  get(coll, id) {
    const r = mem[coll].get(id);
    return r && !r.deleted ? r : null;
  },

  async put(coll, rec) {
    const next = { ...rec, updatedAt: now() };
    mem[coll].set(next.id, next);
    await idb.put(coll, next);
    await idb.put("outbox", { id: `${coll}/${next.id}`, coll, docId: next.id, at: next.updatedAt });
    bus.emit("change", { coll, rec: next, source: "local" });
    bus.emit("outbox");
    return next;
  },

  async patch(coll, id, partial) {
    const cur = mem[coll].get(id);
    if (!cur) return null;
    return this.put(coll, { ...cur, ...partial });
  },

  /** Soft delete so the deletion reaches other devices. */
  async remove(coll, id) {
    const cur = mem[coll].get(id);
    if (!cur) return;
    await this.put(coll, { id, deleted: true, ...(coll === "annotations" || coll === "bookmarks" ? { docId: cur.docId } : {}) });
    if (coll === "docs") await dropLocalFile(id);
  },

  /** Merge a record that came from the cloud. Last write wins. */
  async applyRemote(coll, rec) {
    if (!mem[coll] || !rec?.id) return false;
    const cur = mem[coll].get(rec.id);
    if (cur && (cur.updatedAt || 0) >= (rec.updatedAt || 0)) return false;
    mem[coll].set(rec.id, rec);
    await idb.put(coll, rec);
    if (coll === "docs" && rec.deleted) await dropLocalFile(rec.id);
    bus.emit("change", { coll, rec, source: "remote" });
    return true;
  },

  settings() {
    return { ...DEFAULT_SETTINGS, ...(mem.settings.get("settings") || {}) };
  },

  async setSettings(partial) {
    const next = await this.put("settings", { ...this.settings(), ...partial });
    bus.emit("settings", next);
    return next;
  },

  // Device-only file storage
  async getFile(docId) {
    const r = await idb.get("files", docId);
    return r?.blob || null;
  },
  async putFile(docId, blob) {
    await idb.put("files", { id: docId, blob });
    bus.emit("files", docId);
  },
  async hasFile(docId) {
    return (await idb.keys("files")).includes(docId);
  },
  async fileIds() {
    return new Set(await idb.keys("files"));
  },
  async getCover(docId) {
    return (await idb.get("covers", docId))?.dataUrl || null;
  },
  async putCover(docId, dataUrl) {
    await idb.put("covers", { id: docId, dataUrl });
  },

  // Small local key/value (session, sync cursor, etc.)
  async kvGet(key, fallback = null) {
    return (await idb.get("kv", key))?.value ?? fallback;
  },
  async kvSet(key, value) {
    await idb.put("kv", { id: key, value });
  },
};

async function dropLocalFile(docId) {
  await idb.delete("files", docId);
  await idb.delete("covers", docId);
  bus.emit("files", docId);
}
