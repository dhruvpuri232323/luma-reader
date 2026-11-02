// Translating a whole book — any kind: PDF, EPUB, web article, pasted text or a
// scanned book (they all become paragraphs in Book view). Every paragraph is
// translated whole (a paragraph that runs over a page break is joined first, so no
// sentence is cut in half), headings and quotes keep their place, and the result
// is saved with the book and synced, so a book translated on the laptop can be
// read in translation on the phone.
import { store } from "../data/store.js";
import { bus } from "../core/util.js";
import { translate, detectLang, otherLang, deviceTranslator, deviceStatus, hasDeviceTranslator } from "../data/translate.js";

const jobs = new Map(); // `${docId}:${lang}` → job
const LOCAL = (docId, lang) => `tr:${docId}:${lang}`;
const TEXT = new Set(["p", "h", "quote"]);

/** The language a book is written in, from a sample of its paragraphs. */
export async function bookLanguage(model) {
  await model.ready();
  let sample = "";
  const n = model.numPages;
  for (let p = Math.min(n, 2); p <= n && p < 16 && sample.length < 4000; p++) {
    const blocks = await model.page(p).catch(() => []);
    sample += " " + blocks.filter((b) => TEXT.has(b.type)).map((b) => b.text).join(" ");
  }
  return detectLang(sample);
}

/** Which way a book is translated: English → your language, anything else → English. */
export const pairFor = (bookLang, other = otherLang()) => (bookLang === "en" ? { from: "en", to: other } : { from: bookLang, to: "en" });

/** A book's saved translation: { map: Map(blockId → text), from, to }, from this device or synced from another. */
export async function savedTranslation(docId, to) {
  const local = await store.kvGet(LOCAL(docId, to)).catch(() => null);
  if (local?.map) return { map: new Map(Object.entries(local.map)), from: local.from, to: local.to, at: local.at, complete: local.complete !== false };
  const parts = store.list("settings").filter((r) => r.kind === "translation" && r.docId === docId && r.to === to);
  if (!parts.length || parts.length < parts[0].parts) return null;
  const map = new Map();
  for (const r of parts.sort((a, b) => a.part - b.part)) for (const [k, v] of Object.entries(r.map || {})) map.set(k, v);
  const t = { map, from: parts[0].from, to, at: parts[0].at, complete: true };
  store.kvSet(LOCAL(docId, to), { map: Object.fromEntries(map), from: t.from, to, at: t.at }).catch(() => {});
  return t;
}

/** Save locally, and as synced records small enough for the cloud (a few hundred KB each). */
async function saveTranslation(docId, from, to, map, complete) {
  const at = Date.now();
  await store.kvSet(LOCAL(docId, to), { map: Object.fromEntries(map), from, to, at, complete });
  if (!complete) return;
  const parts = [];
  let cur = {}, size = 0;
  for (const [k, v] of map) {
    const s = k.length + v.length + 8;
    if (size + s > 300_000 && size) { parts.push(cur); cur = {}; size = 0; }
    cur[k] = v; size += s;
  }
  parts.push(cur);
  const old = store.list("settings").filter((r) => r.kind === "translation" && r.docId === docId && r.to === to);
  for (let i = 0; i < parts.length; i++) {
    await store.put("settings", { id: `${LOCAL(docId, to)}:${i}`, kind: "translation", docId, from, to, part: i, parts: parts.length, at, map: parts[i] });
  }
  for (const r of old) if (r.part >= parts.length) await store.remove("settings", r.id).catch(() => {});
}

export async function forgetTranslation(docId, to) {
  jobs.get(`${docId}:${to}`)?.cancel();
  await store.kvSet(LOCAL(docId, to), null).catch(() => {});
  for (const r of store.list("settings").filter((x) => x.kind === "translation" && x.docId === docId && x.to === to)) await store.remove("settings", r.id).catch(() => {});
}

export const translationJob = (docId, to) => jobs.get(`${docId}:${to}`) || null;

/** The units a translator works on: whole paragraphs (joined across page breaks), headings, quotes. */
async function unitsOf(model) {
  const units = [];
  let last = null;
  for (let p = 1; p <= model.numPages; p++) {
    const blocks = await model.page(p).catch(() => []);
    for (const b of blocks) {
      if (!TEXT.has(b.type) || !b.text?.trim()) { if (b.type !== "p") last = null; continue; }
      if (b.cont && last?.type === "p") { last.ids.push(b.id); last.text += (/\p{L}-$/u.test(last.text) ? "" : " ") + b.text; continue; }
      last = { ids: [b.id], text: b.text, type: b.type };
      units.push(last);
    }
  }
  return units;
}

/**
 * Get the built-in translator ready — call straight from a tap, because the first
 * time the language downloads and browsers only allow that after a tap.
 */
export function prepare(from, to, onProgress) {
  if (!hasDeviceTranslator()) return Promise.reject(new Error("no-device"));
  return deviceTranslator(from, to, { onProgress });
}

/**
 * Translate the whole book, then show it. → job { total, done, state, promise, cancel(), eta() }
 * Emits "tr-progress" { docId, to, done, total } and "tr-done" { docId, to, ok }.
 */
export function translateBook(tab, { from, to }) {
  const key = `${tab.docId}:${to}`;
  if (jobs.has(key)) return jobs.get(key);
  const job = { docId: tab.docId, from, to, total: 0, done: 0, state: "running", startedAt: Date.now(), cancelled: false };
  let stopped;
  const whenStopped = new Promise((r) => { stopped = r; });
  job.cancel = () => {
    if (job.state !== "running") return;
    job.cancelled = true; job.state = "cancelled"; jobs.delete(key); stopped(null);
    bus.emit("tr-done", { docId: tab.docId, to, ok: false, cancelled: true });
  };
  job.eta = () => {
    if (job.done < 3) return null;
    const per = (Date.now() - job.startedAt) / job.done;
    return Math.round((per * (job.total - job.done)) / 1000);
  };
  jobs.set(key, job);
  const work = (async () => {
    try {
      if ((await deviceStatus(from, to)) === "unavailable") throw new Error(`The built-in translator can't translate ${from} → ${to}`);
      const units = await unitsOf(tab.model);
      job.total = units.length;
      bus.emit("tr-progress", { docId: tab.docId, to, done: 0, total: job.total });
      const map = new Map();
      let lastSave = Date.now();
      for (const u of units) {
        if (job.cancelled) return null;
        const r = await translate(u.text, { from, to, allowOnline: false });
        map.set(u.ids[0], r.text);
        for (const id of u.ids.slice(1)) map.set(id, "");
        job.done++;
        bus.emit("tr-progress", { docId: tab.docId, to, done: job.done, total: job.total });
        if (Date.now() - lastSave > 20000) { lastSave = Date.now(); await saveTranslation(tab.docId, from, to, map, false).catch(() => {}); } // a long book survives a closed tab
      }
      await saveTranslation(tab.docId, from, to, map, true);
      job.state = "done";
      bus.emit("tr-done", { docId: tab.docId, to, ok: true });
      return { map, from, to, complete: true };
    } catch (e) {
      job.state = "error";
      job.error = e?.message || String(e);
      bus.emit("tr-done", { docId: tab.docId, to, ok: false, error: job.error });
      throw e;
    } finally {
      if (jobs.get(key) === job) jobs.delete(key);
    }
  })();
  job.promise = Promise.race([work, whenStopped]);
  work.catch(() => {});
  return job;
}

/**
 * The book's model as seen in translation: the same blocks (same ids, so position,
 * read-aloud and the page counter all still work) with the translated text.
 */
export function translatedModel(model, map) {
  const swap = (blocks) => blocks.map((b) => (TEXT.has(b.type) && map.has(b.id) ? { ...b, text: map.get(b.id), notes: undefined, translated: true } : b));
  const cache = new Map();
  const page = (p) => { if (!cache.has(p)) cache.set(p, model.page(p).then(swap)); return cache.get(p); };
  return new Proxy(model, {
    get(t, k) {
      if (k === "page") return page;
      if (k === "pageText") return async (p) => (await page(p)).map((b) => b.text || "").filter(Boolean).join("\n");
      if (k === "headingBefore") return async (p, back = 12) => {
        for (let q = p; q >= Math.max(1, p - back); q--) {
          const bl = await page(q);
          const h = [...bl].reverse().find((b) => b.type === "h" && b.level === 2) || [...bl].reverse().find((b) => b.type === "h");
          if (h) return h.text;
        }
        return "";
      };
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
