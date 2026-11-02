// Several words at once: "fastest human", "kick the bucket", "Reserve Bank of India".
// The phrase as a whole (an idiom or a set phrase in the dictionary), each word on
// its own (with its base word, so "fastest" is explained through "fast"), and a
// plain sentence that puts them together when the pattern is clear.
import { lookup, lookupPhrase } from "./dictionary.js";
import { anatomy, sumUp } from "./morphology.js";
import { lexiconReady } from "./etymology.js";

const FUNCTION_WORDS = new Set("a an the of to in on at for and or but nor is are was were be been being am with by from as that this these those it its into onto than then so such not no do does did has have had will would shall should can could may might must i you he she we they me him her us them my your his our their".split(" "));

export const tokens = (text) => String(text || "").match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)?.map((w) => w.replace(/[.’']+$/, "")) || [];
export const isPhrase = (text) => { const n = tokens(text).length; return n >= 2 && n <= 8; };

/** The phrase with its words in their base form, for idioms in another tense ("gave up" → "give up"). */
export function phraseVariants(text) {
  const ws = tokens(text).map((w) => w.toLowerCase());
  const baseOf = (w) => { const a = anatomy(w); return a?.base && !a.classical ? a.base : w; };
  const first = [baseOf(ws[0]), ...ws.slice(1)].join(" ");
  const all = ws.map((w) => (FUNCTION_WORDS.has(w) ? w : baseOf(w))).join(" ");
  return [...new Set([ws.join(" "), first, all])];
}

/** The phrase as one dictionary entry, if it is one. */
export async function phraseMeaning(text) {
  await lexiconReady();
  return lookupPhrase(text, phraseVariants(text)).catch(() => ({ status: "error" }));
}

/**
 * Each word on its own: [{ word, parts: anatomy, sum, base, entry, baseEntry }].
 * Small words (the, of, to…) are left out unless the phrase is only two words.
 */
export async function wordByWord(text) {
  await lexiconReady();
  const ws = tokens(text);
  const keep = ws.filter((w) => ws.length <= 2 || !FUNCTION_WORDS.has(w.toLowerCase()));
  return Promise.all(keep.slice(0, 8).map(async (word) => {
    const lw = word.toLowerCase();
    const a = anatomy(lw);
    const base = a?.base && a.base !== lw ? a.base : null;
    const [res, baseRes] = await Promise.all([
      lookup(word).catch(() => null),
      base ? lookup(base).catch(() => null) : Promise.resolve(null),
    ]);
    const entry = res?.status === "ok" && res.entry.source !== "wikipedia" ? res.entry : null;
    const baseEntry = baseRes?.status === "ok" && baseRes.entry.source !== "wikipedia" ? baseRes.entry : null;
    return { word, parts: a, sum: a && (a.parts.length > 1 || a.change) ? sumUp(a) : "", base, entry, baseEntry, offline: res?.status === "offline" };
  }));
}

const posOf = (e) => (e?.meanings || []).map((m) => (m.pos || "").toLowerCase());
export const firstDef = (e) => e?.meanings?.[0]?.defs?.[0]?.d || "";
/** A meaning trimmed to its first clause, for one-line use. */
export const shortDef = (e) => {
  const d = firstDef(e).replace(/\s*\([^)]*\)\s*/g, " ").trim();
  const cut = d.split(/[.;:]/)[0].trim();
  return cut.length > 90 ? cut.slice(0, cut.lastIndexOf(" ", 88)) + "…" : cut;
};

/**
 * One sentence for "fastest human" style phrases: a superlative and the thing it describes.
 * "the human that is faster than any other". Only when the pattern is clear.
 */
export function together(text, words) {
  const ws = tokens(text).map((w) => w.toLowerCase());
  if (ws.length < 2 || ws.length > 4) return "";
  const nounInfo = words.find((x) => x.word.toLowerCase() === ws[ws.length - 1]);
  const nounPos = posOf(nounInfo?.entry);
  const isNoun = nounPos.includes("noun") || nounPos.includes("proper noun") || !nounInfo?.entry;
  if (!isNoun) return "";
  const noun = ws[ws.length - 1];
  // "most beautiful woman", "least likely winner"
  const mi = ws.findIndex((w) => w === "most" || w === "least");
  if (mi >= 0 && mi < ws.length - 2) {
    const adj = ws.slice(mi + 1, -1).join(" ");
    return `the ${noun} that is ${ws[mi] === "most" ? "more" : "less"} ${adj} than any other`;
  }
  // "fastest human", "biggest city", "happiest day"
  const sup = ws.slice(0, -1).find((w) => /est$/.test(w) && words.find((x) => x.word.toLowerCase() === w)?.parts?.parts?.some((p) => p.text === "-est"));
  if (sup) {
    const comparative = sup.replace(/est$/, "er");
    return `the ${noun} that is ${comparative} than any other`;
  }
  return "";
}
