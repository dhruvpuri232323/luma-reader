// Translation between English and one other language (Hindi by default), both ways.
// Works the way a translator does:
//  • whole units — a paragraph at a time, split only at sentence ends when it's long,
//    so tense, pronouns and meaning carry across;
//  • memory — every translated passage is kept, so repeats are instant and identical,
//    and your own corrections are reused;
//  • checks — numbers must survive; if they don't, the passage is redone sentence by sentence.
// Engines, best first: the translator built into Chrome / Edge on computers (on the
// device, free, offline once the language is downloaded), then a free online service
// for short passages (phones), with a daily allowance.
import { idb } from "./db.js";
import { store } from "./store.js";

/** Languages the built-in translator offers (Chrome's list), with their own names. */
export const LANGUAGES = {
  hi: ["Hindi", "हिन्दी"], bn: ["Bengali", "বাংলা"], mr: ["Marathi", "मराठी"], ta: ["Tamil", "தமிழ்"], te: ["Telugu", "తెలుగు"],
  kn: ["Kannada", "ಕನ್ನಡ"], gu: ["Gujarati", "ગુજરાતી"], ur: ["Urdu", "اردو"], ar: ["Arabic", "العربية"], fr: ["French", "Français"],
  de: ["German", "Deutsch"], es: ["Spanish", "Español"], pt: ["Portuguese", "Português"], it: ["Italian", "Italiano"], nl: ["Dutch", "Nederlands"],
  ru: ["Russian", "Русский"], uk: ["Ukrainian", "Українська"], pl: ["Polish", "Polski"], tr: ["Turkish", "Türkçe"], ja: ["Japanese", "日本語"],
  ko: ["Korean", "한국어"], zh: ["Chinese (Simplified)", "简体中文"], "zh-Hant": ["Chinese (Traditional)", "繁體中文"], vi: ["Vietnamese", "Tiếng Việt"],
  th: ["Thai", "ไทย"], id: ["Indonesian", "Bahasa Indonesia"], el: ["Greek", "Ελληνικά"], he: ["Hebrew", "עברית"], sv: ["Swedish", "Svenska"],
  da: ["Danish", "Dansk"], no: ["Norwegian", "Norsk"], fi: ["Finnish", "Suomi"], cs: ["Czech", "Čeština"], ro: ["Romanian", "Română"],
  hu: ["Hungarian", "Magyar"], bg: ["Bulgarian", "Български"], hr: ["Croatian", "Hrvatski"], sk: ["Slovak", "Slovenčina"], sl: ["Slovenian", "Slovenščina"],
  lt: ["Lithuanian", "Lietuvių"],
};
export const langName = (code) => (code === "en" ? "English" : LANGUAGES[code]?.[0] || code);
export const nativeName = (code) => (code === "en" ? "English" : LANGUAGES[code]?.[1] || code);
/** The language you read alongside English (Settings → Translation). */
export const otherLang = () => store.settings().trLang || "hi";

// ───────── which language is this? ─────────
const SCRIPTS = [
  [/[ऀ-ॿ]/g, ["hi", "mr", "ne"]], [/[ঀ-৿]/g, ["bn"]], [/[਀-੿]/g, ["pa"]], [/[઀-૿]/g, ["gu"]],
  [/[஀-௿]/g, ["ta"]], [/[ఀ-౿]/g, ["te"]], [/[ಀ-೿]/g, ["kn"]], [/[ഀ-ൿ]/g, ["ml"]],
  [/[؀-ۿ]/g, ["ar", "ur"]], [/[֐-׿]/g, ["he"]], [/[Ѐ-ӿ]/g, ["ru", "uk", "bg"]], [/[Ͱ-Ͽ]/g, ["el"]],
  [/[฀-๿]/g, ["th"]], [/[가-힯]/g, ["ko"]], [/[぀-ヿ]/g, ["ja"]], [/[一-鿿]/g, ["zh"]],
];
const LATIN_HINTS = {
  fr: /\b(le|la|les|des|est|et|une|dans|pour|que|qui|avec|pas|sur|au|aux|ce|cette|être|été)\b/gi,
  de: /\b(der|die|das|und|ist|nicht|ein|eine|mit|auf|für|von|zu|sich|auch|wird|dem|den)\b/gi,
  es: /\b(el|los|las|del|que|y|es|una|por|con|para|como|pero|más|está|son)\b/gi,
  pt: /\b(o|os|as|do|da|que|e|é|um|uma|para|com|não|mais|por|dos|das)\b/gi,
  it: /\b(il|lo|gli|della|che|e|è|un|una|per|con|non|più|sono|nel|alla)\b/gi,
  en: /\b(the|and|is|of|to|in|that|it|was|for|with|as|on|be|this|are|by|his|her)\b/gi,
};
/** Best guess at a text's language: by its script, then by its common words. */
export function detectLang(text, prefer = otherLang()) {
  const t = String(text || "").slice(0, 2000);
  let best = null, n = 0;
  for (const [re, langs] of SCRIPTS) {
    const c = (t.match(re) || []).length;
    if (c > n) { n = c; best = langs.includes(prefer) ? prefer : langs[0]; }
  }
  const letters = (t.match(/\p{L}/gu) || []).length || 1;
  if (best && n / letters > 0.3) return best;
  let lb = "en", ln = 0;
  for (const [code, re] of Object.entries(LATIN_HINTS)) {
    const c = (t.match(re) || []).length;
    if (c > ln) { ln = c; lb = code; }
  }
  return lb;
}
/** English text goes to your other language; anything else comes to English. */
export function directionFor(text, other = otherLang()) {
  const from = detectLang(text, other);
  return from === "en" ? { from: "en", to: other } : { from, to: "en" };
}

// ───────── splitting into translatable units ─────────
/** Sentences, keeping "Mr.", "e.g.", "U.S." and decimals inside their sentence. */
export function sentences(text) {
  const out = [];
  const re = /[^.!?।॥]+(?:[.!?।॥]+["”’')\]]*|$)/gu;
  let buf = "";
  for (const m of String(text).matchAll(re)) {
    buf += m[0];
    const tail = buf.trimEnd();
    if (/\b(Mr|Mrs|Ms|Dr|Prof|St|Mt|Jr|Sr|vs|etc|e\.g|i\.e|No|Fig|p|pp|vol|ch)\.$/i.test(tail) || /(^|[\s(])\p{L}\.$/u.test(tail) || /\d\.$/.test(tail) && /^\d/.test(text.slice(m.index + m[0].length))) continue;
    out.push(buf); buf = "";
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}
/** Chunks of whole sentences no longer than `max` characters. */
export function chunks(text, max = 1000) {
  const out = [];
  let cur = "";
  for (const s of sentences(text)) {
    if (cur && cur.length + s.length + 1 > max) { out.push(cur); cur = ""; }
    if (s.length > max) { // one very long sentence: split at commas or spaces
      let rest = s;
      while (rest.length > max) {
        let cut = Math.max(rest.lastIndexOf(", ", max), rest.lastIndexOf("; ", max));
        if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
        if (cut <= 0) cut = max;
        out.push(rest.slice(0, cut + 1).trim()); rest = rest.slice(cut + 1);
      }
      cur = rest;
    } else cur = cur ? cur + " " + s : s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ───────── memory ─────────
function hash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
const norm = (s) => String(s).replace(/\s+/g, " ").trim();
const tmKey = (text, from, to) => `tm:${from}>${to}:${hash(norm(text))}`;
export async function remembered(text, from, to) {
  const r = await idb.get("defs", tmKey(text, from, to)).catch(() => null);
  return r && r.src === norm(text).slice(0, 160) ? r : null;
}
async function remember(text, from, to, out, engine, edited = false) {
  await idb.put("defs", { id: tmKey(text, from, to), src: norm(text).slice(0, 160), out, engine, edited, at: Date.now() }).catch(() => {});
}
/** Your own correction of a translation: used from now on for this passage. */
export const saveCorrection = (text, from, to, out) => remember(text, from, to, out, "you", true);

// ───────── checks ─────────
const DEV_DIGITS = "०१२३४५६७८९";
const asciiDigits = (s) => s.replace(/[०-९]/g, (d) => String(DEV_DIGITS.indexOf(d)));
const numbersIn = (s) => (asciiDigits(s).match(/\d+(?:[.,:]\d+)*/g) || []).map((n) => n.replace(/[.,:]/g, ""));
/** Did the numbers (dates, amounts, page numbers) come through unchanged? */
export function numbersKept(src, out) {
  const a = numbersIn(src), b = numbersIn(out);
  return a.every((n) => b.includes(n));
}

// ───────── engines ─────────
export const hasDeviceTranslator = () => typeof globalThis.Translator?.create === "function";
const devices = new Map(); // "en>hi" → Promise<translator>

/** "available" | "downloadable" | "downloading" | "unavailable" | "none" (this browser has no built-in translator) */
const statusMemo = new Map();
const within = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
export async function deviceStatus(from, to) {
  if (!hasDeviceTranslator()) return "none";
  const k = `${from}>${to}`;
  if (statusMemo.get(k) === "stuck") return "unavailable";
  try {
    // some browsers have the API but never answer (no translation component): don't wait forever
    const st = await within(globalThis.Translator.availability({ sourceLanguage: from, targetLanguage: to }), 4000, "stuck");
    statusMemo.set(k, st);
    return st === "stuck" ? "unavailable" : st;
  } catch { return "unavailable"; }
}

/**
 * The built-in translator for a pair. The first time, the language downloads — the
 * browser only allows that straight after a tap, so call this from a click.
 */
export function deviceTranslator(from, to, { onProgress } = {}) {
  const k = `${from}>${to}`;
  if (!devices.has(k)) {
    devices.set(k, globalThis.Translator.create({
      sourceLanguage: from, targetLanguage: to,
      monitor(m) { m.addEventListener("downloadprogress", (e) => onProgress?.(e.loaded ?? 0)); },
    }).catch((e) => { devices.delete(k); throw e; }));
  }
  return devices.get(k);
}

const decode = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const bytes = (s) => new TextEncoder().encode(s).length;

/** Pieces of at most ~450 bytes (the online service's limit), at sentence ends where possible. */
function smallPieces(text) {
  const out = [];
  for (const c of chunks(text, 400)) {
    if (bytes(c) <= 450) { out.push(c); continue; }
    let cur = "";
    for (const w of c.split(/(\s+)/)) {
      if (bytes(cur + w) > 450 && cur.trim()) { out.push(cur.trim()); cur = ""; }
      cur += w;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

export class QuotaError extends Error {}
async function online(text, from, to) {
  if (!navigator.onLine) throw new Error("offline");
  const out = [];
  for (const piece of smallPieces(text)) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(piece)}&langpair=${from}|${to === "zh" ? "zh-CN" : to === "zh-Hant" ? "zh-TW" : to}`;
    const res = await fetch(url);
    const data = res.ok ? await res.json() : null;
    const t = data?.responseData?.translatedText || "";
    if (!data || data.quotaFinished || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(t) || Number(data.responseStatus) >= 400) {
      throw new QuotaError("The free online translator's daily allowance is used up. It resets tomorrow — or translate on your computer.");
    }
    out.push(decode(t));
  }
  return out.join(" ");
}

async function onDevice(text, from, to, opts) {
  const tr = await deviceTranslator(from, to, opts);
  const parts = [];
  const timed = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("The translator stopped answering")), 90000))]);
  for (const c of chunks(text, 1000)) {
    let t = await timed(tr.translate(c));
    // a check a reviewer would make: numbers must survive. If not, redo it sentence by sentence.
    if (!numbersKept(c, t) && sentences(c).length > 1) {
      const redo = [];
      for (const s of sentences(c)) redo.push(await tr.translate(s));
      const joined = redo.join(" ");
      if (numbersKept(c, joined)) t = joined;
    }
    parts.push(t);
  }
  return parts.join(" ");
}

/**
 * Translate a passage. → { text, from, to, engine: "memory" | "device" | "online" | "you" }
 * `from`/`to` default to English ⇄ your other language, decided from the text itself.
 * `allowOnline` false keeps it on the device (whole books).
 */
export async function translate(text, { from, to, allowOnline = store.settings().trOnline !== false, onProgress } = {}) {
  const src = String(text || "").trim();
  if (!src) return { text: "", from, to, engine: "memory" };
  if (!from || !to) ({ from, to } = directionFor(src));
  if (from === to) return { text: src, from, to, engine: "same" };
  // paragraphs are translated one by one so the layout survives
  // lines broken by the page layout belong to one paragraph; blank lines separate paragraphs
  const paras = src.replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2").split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  const outs = [];
  let engine = "memory";
  for (const p of paras) {
    const hit = await remembered(p, from, to);
    if (hit) { outs.push(hit.out); if (hit.edited) engine = "you"; continue; }
    let out = null, used = null;
    if (hasDeviceTranslator() && (await deviceStatus(from, to)) !== "unavailable") {
      try { out = await onDevice(p, from, to, { onProgress }); used = "device"; } catch (e) { if (!allowOnline) throw e; }
    }
    if (out == null) {
      if (!allowOnline) throw new Error(hasDeviceTranslator() ? "The language hasn't been downloaded to this device yet" : "This browser can't translate on the device — turn on the online translator in Settings → Translation");
      out = await online(p, from, to);
      used = "online";
    }
    await remember(p, from, to, out, used);
    outs.push(out);
    engine = engine === "you" ? "you" : used;
  }
  return { text: outs.join("\n\n"), from, to, engine };
}

/** A Hindi (or other) word in the dictionary: Wiktionary's English meanings for it. */
export async function foreignWord(word, lang) {
  const w = String(word || "").trim();
  if (!w || !navigator.onLine) return null;
  const key = `fw:${lang}:${w}`;
  const cached = await idb.get("defs", key).catch(() => null);
  if (cached && Date.now() - cached.at < 30 * 864e5) return cached.entry;
  let entry = null;
  try {
    const res = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w)}?redirect=true`);
    if (res.ok) {
      const data = await res.json();
      const secs = data?.[lang] || Object.values(data || {}).flat().filter((x) => x?.language && x.language === langName(lang));
      const strip = (h) => new DOMParser().parseFromString(`<body>${h || ""}</body>`, "text/html").body.textContent.replace(/\s+/g, " ").trim();
      const meanings = (secs || []).map((s) => ({ pos: String(s.partOfSpeech || "").toLowerCase(), defs: (s.definitions || []).map((d) => strip(d.definition)).filter(Boolean).slice(0, 3) })).filter((m) => m.defs.length);
      if (meanings.length) entry = { word: w, meanings, url: `https://en.wiktionary.org/wiki/${encodeURIComponent(w)}#${encodeURIComponent(langName(lang))}` };
    }
  } catch {}
  await idb.put("defs", { id: key, entry, at: Date.now() }).catch(() => {});
  return entry;
}
