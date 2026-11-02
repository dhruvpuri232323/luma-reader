// Search inside every book. Each book's text is saved on the device the first
// time you open it (quietly, in the background), so later you can search across
// your whole library — plus your notes and words — instantly and offline.
import { idb } from "./db.js";
import { store } from "./store.js";

const V = 1;
const mem = new Map(); // docId → pages[]
const running = new Set();

export async function indexInBackground(tab) {
  const id = tab.docId;
  if (running.has(id) || !tab.model) return;
  const have = mem.get(id) || (await idb.get("texts", id).catch(() => null));
  if (have && (have.v === V || Array.isArray(have)) && (have.pages?.length || have.length) === tab.model.numPages) {
    if (!mem.has(id)) mem.set(id, have.pages || have);
    return;
  }
  running.add(id);
  try {
    const pages = [];
    for (let p = 1; p <= tab.model.numPages; p++) {
      if (tab.destroyed) return;
      pages.push(await tab.model.pageText(p).catch(() => ""));
      if (p % 4 === 0) await idle();
    }
    mem.set(id, pages);
    await idb.put("texts", { id, v: V, pages, at: Date.now() });
  } finally {
    running.delete(id);
  }
}

const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 400 }) : setTimeout(r, 30)));

async function allTexts() {
  const recs = await idb.getAll("texts").catch(() => []);
  for (const r of recs) if (!mem.has(r.id)) mem.set(r.id, r.pages || []);
  return mem;
}

export async function indexedCount() {
  const docs = new Set(store.list("docs").map((d) => d.id));
  return [...(await allTexts()).keys()].filter((id) => docs.has(id)).length;
}

/** Matches inside books: [{ doc, total, hits: [{ page, before, match, after }] }] */
export async function searchBooks(query, { perDoc = 3, maxDocs = 30 } = {}) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const texts = await allTexts();
  const out = [];
  for (const doc of store.list("docs")) {
    const pages = texts.get(doc.id);
    if (!pages) continue;
    let total = 0;
    const hits = [];
    pages.forEach((raw, i) => {
      if (!raw) return;
      const text = raw.replace(/\s+/g, " ");
      const lower = text.toLowerCase();
      let at = lower.indexOf(q);
      while (at >= 0) {
        total++;
        if (hits.length < perDoc) hits.push({ page: i + 1, before: text.slice(Math.max(0, at - 60), at), match: text.slice(at, at + q.length), after: text.slice(at + q.length, at + q.length + 80) });
        at = lower.indexOf(q, at + q.length);
      }
    });
    if (total) out.push({ doc, total, hits });
  }
  return out.sort((a, b) => b.total - a.total).slice(0, maxDocs);
}

/** Which of your books a word appears in (for "your words in other books"). */
export async function booksWithWord(word, { exclude } = {}) {
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(s|es|ed|d|ing|ly)?\\b`, "i");
  const texts = await allTexts();
  const out = [];
  for (const doc of store.list("docs")) {
    if (doc.id === exclude) continue;
    const pages = texts.get(doc.id);
    if (!pages) continue;
    const i = pages.findIndex((t) => t && re.test(t));
    if (i >= 0) {
      const t = pages[i].replace(/\s+/g, " ");
      const m = t.match(re);
      const at = m.index;
      out.push({ doc, page: i + 1, context: (at > 70 ? "…" : "") + t.slice(Math.max(0, at - 70), at + m[0].length + 90) + "…" });
    }
  }
  return out;
}

export function searchNotes(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const docs = new Map(store.list("docs").map((d) => [d.id, d]));
  return store.list("annotations").filter((a) => docs.has(a.docId) && [a.text, a.note, ...(a.tags || [])].some((s) => (s || "").toLowerCase().includes(q)))
    .map((a) => ({ ann: a, doc: docs.get(a.docId) })).slice(0, 30);
}

export function searchWords(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return store.list("words").filter((w) => w.word.toLowerCase().includes(q) || (w.customDef || "").toLowerCase().includes(q)
    || (w.meanings || []).some((m) => (m.defs || []).some((d) => (d.d || "").toLowerCase().includes(q)))).slice(0, 30);
}

export async function forget(docId) {
  mem.delete(docId);
  await idb.delete("texts", docId).catch(() => {});
}

/** A book's page texts (if it has been opened on this device), or null. */
export async function bookPages(docId) {
  if (mem.has(docId)) return mem.get(docId);
  const r = await idb.get("texts", docId).catch(() => null);
  if (!r) return null;
  mem.set(docId, r.pages || r);
  return mem.get(docId);
}
