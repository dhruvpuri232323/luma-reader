// Dictionary lookups (Free Dictionary API) with an offline IndexedDB cache,
// plus helpers for saved words and spaced-repetition scheduling.

import { idb } from "./db.js";
import { store, now } from "./store.js";

const API = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const inflight = new Map();

export function normalizeWord(raw = "") {
  return raw
    .normalize("NFKC")
    .replace(/[’‘`´]/g, "'")
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")
    .replace(/'s$/i, "")
    .toLowerCase();
}

/** Plausible base forms to try when the exact form isn't in the dictionary. */
function candidates(w) {
  const out = [w];
  const add = (x) => x && x.length > 1 && !out.includes(x) && out.push(x);
  if (w.endsWith("ies")) add(w.slice(0, -3) + "y");
  if (w.endsWith("es")) add(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss")) add(w.slice(0, -1));
  if (w.endsWith("ied")) add(w.slice(0, -3) + "y");
  if (w.endsWith("ed")) { add(w.slice(0, -2)); add(w.slice(0, -1)); if (/(.)\1ed$/.test(w)) add(w.slice(0, -3)); }
  if (w.endsWith("ing")) { add(w.slice(0, -3)); add(w.slice(0, -3) + "e"); if (/(.)\1ing$/.test(w)) add(w.slice(0, -4)); }
  if (w.endsWith("ly")) { add(w.slice(0, -2)); if (w.endsWith("ily")) add(w.slice(0, -3) + "y"); }
  if (w.endsWith("er")) add(w.slice(0, -2));
  if (w.endsWith("est")) add(w.slice(0, -3));
  if (w.endsWith("ness")) add(w.slice(0, -4));
  return out;
}

function shape(entries, asked) {
  const first = entries[0];
  const phonetic = first.phonetic || entries.flatMap((e) => e.phonetics || []).find((p) => p.text)?.text || "";
  const audio = entries.flatMap((e) => e.phonetics || []).find((p) => p.audio)?.audio || "";
  const byPos = new Map();
  for (const e of entries) {
    for (const m of e.meanings || []) {
      const cur = byPos.get(m.partOfSpeech) || { pos: m.partOfSpeech, defs: [], synonyms: [], antonyms: [] };
      for (const d of m.definitions || []) {
        if (cur.defs.length < 6) cur.defs.push({ d: d.definition, ex: d.example || "" });
        cur.synonyms.push(...(d.synonyms || []));
        cur.antonyms.push(...(d.antonyms || []));
      }
      cur.synonyms.push(...(m.synonyms || []));
      cur.antonyms.push(...(m.antonyms || []));
      byPos.set(m.partOfSpeech, cur);
    }
  }
  const meanings = [...byPos.values()].map((m) => ({
    ...m,
    synonyms: [...new Set(m.synonyms)].slice(0, 10),
    antonyms: [...new Set(m.antonyms)].slice(0, 8),
  }));
  return { word: first.word || asked, asked, phonetic, audio, meanings, fetchedAt: Date.now() };
}

/**
 * Look up a word. Returns { status: "ok", entry } | { status: "missing" } |
 * { status: "offline" } | { status: "error" }.
 */
export async function lookup(raw) {
  const w = normalizeWord(raw);
  if (!w) return { status: "missing" };
  const cached = await idb.get("defs", w);
  if (cached?.entry) return { status: "ok", entry: cached.entry, cached: true };
  if (cached?.missing && Date.now() - cached.at < 7 * 864e5) return { status: "missing" };
  if (inflight.has(w)) return inflight.get(w);

  const p = (async () => {
    if (!navigator.onLine) return { status: "offline" };
    try {
      for (const c of candidates(w)) {
        const res = await fetch(API + encodeURIComponent(c));
        if (res.status === 404) continue;
        if (!res.ok) return { status: "error" };
        const entry = shape(await res.json(), w);
        await idb.put("defs", { id: w, entry });
        if (c !== w) await idb.put("defs", { id: c, entry });
        return { status: "ok", entry };
      }
      await idb.put("defs", { id: w, missing: true, at: Date.now() });
      return { status: "missing" };
    } catch {
      return { status: navigator.onLine ? "error" : "offline" };
    } finally {
      inflight.delete(w);
    }
  })();
  inflight.set(w, p);
  return p;
}

export function wordId(word) {
  return normalizeWord(word).replace(/[^\p{L}\p{N}'-]/gu, "-") || "word";
}

/** Save (or update) a word in the vocabulary. */
export async function saveWord({ word, entry, source }) {
  const id = wordId(entry?.word || word);
  const existing = store.get("words", id);
  const base = existing || {
    id,
    word: entry?.word || normalizeWord(word),
    status: "learning",
    createdAt: now(),
    customDef: "",
    mnemonic: "",
    srs: { due: Date.now(), interval: 0, ease: 2.5, reps: 0 },
  };
  return store.put("words", {
    ...base,
    phonetic: entry?.phonetic || base.phonetic || "",
    audio: entry?.audio || base.audio || "",
    meanings: entry?.meanings || base.meanings || [],
    source: source || base.source || null,
    sources: mergeSources(base.sources, source),
  });
}

function mergeSources(list = [], s) {
  if (!s) return list;
  const key = `${s.docId}:${s.page}`;
  return [s, ...list.filter((x) => `${x.docId}:${x.page}` !== key)].slice(0, 8);
}

/** Spaced repetition (SM-2 style). grade: 0 again · 1 hard · 2 good · 3 easy */
export function schedule(srs = {}, grade) {
  let { interval = 0, ease = 2.5, reps = 0 } = srs;
  const day = 864e5;
  if (grade === 0) {
    return { interval: 0, ease: Math.max(1.3, ease - 0.2), reps: 0, due: Date.now() + 10 * 60e3, last: Date.now() };
  }
  reps += 1;
  if (grade === 1) { ease = Math.max(1.3, ease - 0.15); interval = Math.max(1, Math.round((interval || 1) * 1.2)); }
  else if (grade === 2) interval = reps === 1 ? 1 : reps === 2 ? 3 : Math.round(interval * ease);
  else { ease += 0.15; interval = reps === 1 ? 3 : Math.round((interval || 1) * ease * 1.3); }
  return { interval, ease, reps, due: Date.now() + interval * day, last: Date.now() };
}

export const isDue = (w) => !w.srs || (w.srs.due || 0) <= Date.now();
