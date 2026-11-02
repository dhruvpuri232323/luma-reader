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

/** Base forms for plain inflections only (plural, past, -ing, -ly) — never
 * meaning-changing suffixes like -er or -ness. */
function candidates(w) {
  const out = [w];
  const add = (x) => x && x.length > 2 && !out.includes(x) && out.push(x);
  if (w.endsWith("ies")) add(w.slice(0, -3) + "y");
  if (/(s|x|z|ch|sh)es$/.test(w)) add(w.slice(0, -2));
  if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) add(w.slice(0, -1));
  if (w.endsWith("ied")) add(w.slice(0, -3) + "y");
  if (w.endsWith("ed")) { add(w.slice(0, -1)); add(w.slice(0, -2)); if (/(.)\1ed$/.test(w)) add(w.slice(0, -3)); }
  if (w.endsWith("ing")) { add(w.slice(0, -3) + "e"); add(w.slice(0, -3)); if (/(.)\1ing$/.test(w)) add(w.slice(0, -4)); }
  if (w.endsWith("ily")) add(w.slice(0, -3) + "y");
  else if (w.endsWith("ly")) add(w.slice(0, -2));
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

const WIKTIONARY = "https://en.wiktionary.org/api/rest_v1/page/definition/";
const WIKIPEDIA = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const DATAMUSE = "https://api.datamuse.com/";

const stripHtml = (html = "") => {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
};

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  return res.json();
}

async function freeDictionary(w, { stems = true } = {}) {
  for (const c of stems ? candidates(w).slice(1) : [w]) {
    const res = await fetch(API + encodeURIComponent(c));
    if (res.status === 404) continue;
    if (!res.ok) throw new Error("dictionary " + res.status);
    return { ...shape(await res.json(), w), source: "dictionary" };
  }
  return null;
}

export async function wiktionary(w, raw) {
  for (const t of [...new Set([w, raw])]) {
    if (!t) continue;
    const data = await getJson(WIKTIONARY + encodeURIComponent(t.replace(/ /g, "_")) + "?redirect=true").catch(() => null);
    const en = data?.en || Object.values(data || {}).flat().filter((x) => x?.language === "English");
    if (!en?.length) continue;
    const meanings = en.map((sec) => ({
      pos: String(sec.partOfSpeech || "").toLowerCase(),
      defs: (sec.definitions || []).map((d) => ({ d: stripHtml(d.definition), ex: stripHtml(d.examples?.[0] || d.parsedExamples?.[0]?.example || "") }))
        .filter((d) => d.d && !/^(plural|alternative|obsolete) (form|spelling) of\b/i.test(d.d) || false).slice(0, 4),
      synonyms: [], antonyms: [],
    })).filter((m) => m.defs.length);
    // If only "plural of X"-style entries exist, keep them rather than nothing.
    const fallback = en.map((sec) => ({ pos: String(sec.partOfSpeech || "").toLowerCase(), defs: (sec.definitions || []).map((d) => ({ d: stripHtml(d.definition), ex: "" })).filter((d) => d.d).slice(0, 3), synonyms: [], antonyms: [] })).filter((m) => m.defs.length);
    const list = meanings.length ? meanings : fallback;
    if (list.length) return { word: t, asked: w, phonetic: "", audio: "", meanings: list.slice(0, 4), source: "wiktionary", sourceUrl: `https://en.wiktionary.org/wiki/${encodeURIComponent(t)}`, fetchedAt: Date.now() };
  }
  return null;
}

async function wikipedia(title) {
  if (!title) return null;
  const d = await getJson(WIKIPEDIA + encodeURIComponent(title.trim().replace(/ /g, "_")) + "?redirect=true").catch(() => null);
  if (!d || d.type === "disambiguation" || !d.extract) return null;
  return {
    word: d.title, asked: title, phonetic: "", audio: "",
    meanings: [{ pos: d.description || "encyclopedia", defs: [{ d: d.extract, ex: "" }], synonyms: [], antonyms: [] }],
    source: "wikipedia", sourceUrl: d.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    thumb: d.thumbnail?.source || "", fetchedAt: Date.now(),
  };
}

async function wordnet(w) {
  const rows = await getJson(`${DATAMUSE}words?sp=${encodeURIComponent(w)}&md=dp&max=1`).catch(() => null);
  const row = rows?.[0];
  if (!row || row.word.toLowerCase() !== w || !row.defs?.length) return null;
  const POS = { n: "noun", v: "verb", adj: "adjective", adv: "adverb", u: "" };
  const by = new Map();
  for (const line of row.defs) {
    const [code, def] = line.split("\t");
    const pos = POS[code] ?? code;
    if (!by.has(pos)) by.set(pos, { pos, defs: [], synonyms: [], antonyms: [] });
    if (by.get(pos).defs.length < 4) by.get(pos).defs.push({ d: def, ex: "" });
  }
  return { word: w, asked: w, phonetic: "", audio: "", meanings: [...by.values()], source: "wordnet", sourceUrl: "", fetchedAt: Date.now() };
}

export async function suggestions(w) {
  const rows = await getJson(`${DATAMUSE}sug?s=${encodeURIComponent(w)}&max=6`).catch(() => null);
  return (rows || []).map((r) => r.word).filter((x) => x && x.toLowerCase() !== w).slice(0, 5);
}

export const googleUrl = (word) => `https://www.google.com/search?q=${encodeURIComponent(`${word} meaning`)}`;

/**
 * Look up a word (or a name like "Adam Smith"). Tries, in order: the
 * dictionary, Wiktionary, WordNet and Wikipedia. Returns
 * { status: "ok", entry } | { status: "missing", suggestions } | { status: "offline" } | { status: "error" }.
 */
export async function lookup(raw, { phrase } = {}) {
  const w = normalizeWord(raw);
  if (!w) return { status: "missing", suggestions: [] };
  const key = phrase ? "~" + phrase.toLowerCase() : w;
  const cached = await idb.get("defs", key);
  if (cached?.entry) return { status: "ok", entry: cached.entry, cached: true };
  if (cached?.missing && Date.now() - cached.at < 3 * 864e5) return { status: "missing", suggestions: cached.suggestions || [] };
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    if (!navigator.onLine) return { status: "offline" };
    try {
      // Ask the sources side by side rather than one after another, so a word
      // that isn't in the first dictionary doesn't cost several round trips.
      const said = String(raw).trim();
      const capitalised = /^\p{Lu}\p{Ll}/u.test(said);
      const quiet = (p) => p.catch(() => null);
      const pPhrase = phrase ? quiet(wikipedia(phrase)) : null;
      const pDict = quiet(freeDictionary(w, { stems: false }));
      const pWp = capitalised ? quiet(wikipedia(said)) : null; // likely a name or place
      let pWk = null;
      const hedge = setTimeout(() => { pWk ||= quiet(wiktionary(w, said)); }, 300); // the dictionary is slow today: ask Wiktionary too
      let entry = pPhrase ? await pPhrase : null;
      if (!entry) entry = await pDict;
      clearTimeout(hedge);
      if (!entry) {
        pWk ||= quiet(wiktionary(w, said));
        const pStem = quiet(freeDictionary(w));
        const pNet = quiet(wordnet(w));
        const pWiki = pWp || (w.length > 3 ? quiet(wikipedia(said)) : Promise.resolve(null));
        const [wk, wp] = await Promise.all([pWk, pWiki]);
        entry = wk || (await pStem) || (await pNet) || wp;
        if (entry && wp && entry !== wp) entry.wiki = { title: wp.word, extract: wp.meanings[0].defs[0].d, thumb: wp.thumb, url: wp.sourceUrl, description: wp.meanings[0].pos };
      }
      if (entry) {
        await idb.put("defs", { id: key, entry });
        return { status: "ok", entry };
      }
      const sugg = await suggestions(w);
      await idb.put("defs", { id: key, missing: true, at: Date.now(), suggestions: sugg });
      return { status: "missing", suggestions: sugg };
    } catch {
      return { status: navigator.onLine ? "error" : "offline" };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * A phrase or idiom as a dictionary entry ("kick the bucket", "ice cream", "gave up" → "give up").
 * { status: "ok", entry, as } | { status: "missing" } | { status: "offline" }
 */
export async function lookupPhrase(text, variants = []) {
  const t = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return { status: "missing" };
  const key = "~p:" + t;
  const cached = await idb.get("defs", key).catch(() => null);
  if (cached?.entry) return { status: "ok", entry: cached.entry, as: cached.as, cached: true };
  if (cached?.missing && Date.now() - cached.at < 7 * 864e5) return { status: "missing" };
  if (!navigator.onLine) return { status: "offline" };
  for (const v of [...new Set([t, ...variants.map((x) => x.toLowerCase())])]) {
    const [wk, fd] = await Promise.all([wiktionary(v, v).catch(() => null), freeDictionary(v, { stems: false }).catch(() => null)]);
    const entry = wk || fd;
    if (entry?.meanings?.length) {
      await idb.put("defs", { id: key, entry, as: v }).catch(() => {});
      return { status: "ok", entry, as: v };
    }
  }
  await idb.put("defs", { id: key, missing: true, at: Date.now() }).catch(() => {});
  return { status: "missing" };
}

export function wordId(word) {
  return normalizeWord(word).replace(/[^\p{L}\p{N}'-]/gu, "-") || "word";
}

/** Save (or update) a word in the vocabulary. */
export async function saveWord({ word, entry, source, customDef }) {
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
    origin: entry?.source || base.origin || (customDef ? "mine" : ""),
    ...(customDef ? { customDef } : {}),
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
