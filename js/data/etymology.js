// Where words come from. Two sources:
//  • Skeat's Concise Etymological Dictionary (1901) — read from the scanned book
//    and kept with the app (vendor/skeat), so it works offline;
//  • Wiktionary's etymology for the word, when online — modern, and it names
//    the parts a word was built from ("fast + -est").
import { idb } from "./db.js";
import { anatomy, addWords, isKnown } from "./morphology.js";
import { COMMON } from "./common-words.js";
import { store } from "./store.js";

const SKEAT = "vendor/skeat/";
const SKEAT_V = "1";
const shards = new Map(); // letter → Promise<entries[]>
let indexP = null;

/** Load the list of Skeat's headwords (to tell real words from fragments). */
export function lexiconReady() {
  if (!indexP) {
    addWords(COMMON);
    indexP = fetch(`${SKEAT}index.json?v=${SKEAT_V}`).then((r) => (r.ok ? r.json() : [])).then((list) => {
      addWords(list);
      addWords(store.list("words").map((w) => w.word));
      return true;
    }).catch(() => false);
  }
  return indexP;
}

function shard(letter) {
  if (!shards.has(letter)) {
    shards.set(letter, fetch(`${SKEAT}${letter}.json?v=${SKEAT_V}`).then((r) => (r.ok ? r.json() : [])).catch(() => { shards.delete(letter); return []; }));
  }
  return shards.get(letter);
}

/** Skeat's entries for a word (a word can have several: elder (1), elder (2)). */
export async function skeat(word) {
  const w = String(word || "").toLowerCase().trim();
  if (!/^[a-z]/.test(w)) return [];
  const list = await shard(w[0]);
  return list.filter((e) => e.w.toLowerCase() === w).map((e) => ({ ...e, route: routeOf(e.r) }));
}

// Skeat's language labels, e.g. "(F.–L.–Gk.)": English took it from French, French from Latin, Latin from Greek.
const LANGS = [
  [/^E$/, "English"], [/^M\.?\s?E$/, "Middle English"], [/^A\.?\s?S$/, "Old English"], [/^O\.?\s?F$/, "Old French"], [/^M\.?\s?F$/, "Middle French"], [/^A\.?\s?F$/, "Anglo-French"],
  [/^F$/, "French"], [/^Late\s?L$/, "Late Latin"], [/^Med\.?\s?L$/, "Medieval Latin"], [/^L$/, "Latin"], [/^Gk$/, "Greek"], [/^Scand$/, "Old Norse (Scandinavian)"],
  [/^Du$/, "Dutch"], [/^Low\s?G$/, "Low German"], [/^G$/, "German"], [/^Ital$/, "Italian"], [/^Span$/, "Spanish"], [/^Port$/, "Portuguese"], [/^Arab$/, "Arabic"],
  [/^Heb$/, "Hebrew"], [/^Pers$/, "Persian"], [/^Skt$/, "Sanskrit"], [/^Hind$/, "Hindi"], [/^Hindi$/, "Hindi"], [/^C$/, "Celtic"], [/^W$/, "Welsh"], [/^Gael$/, "Gaelic"],
  [/^Irish$/, "Irish"], [/^Turk$/, "Turkish"], [/^Russ$/, "Russian"], [/^Chin$/, "Chinese"], [/^Malay$/, "Malay"], [/^Mex$/, "Mexican (Nahuatl)"], [/^Peruv$/, "Peruvian (Quechua)"],
  [/^Hung$/, "Hungarian"], [/^Tamil$/, "Tamil"], [/^Egypt$/, "Egyptian"], [/^Teut$/, "Germanic"], [/^Amer\.?\s?Ind$/, "Native American"], [/^Bret$/, "Breton"], [/^Prov$/, "Provençal"],
  [/^Icel$/, "Icelandic"], [/^Swed$/, "Swedish"], [/^Dan$/, "Danish"], [/^Norw$/, "Norwegian"], [/^Celtic$/, "Celtic"], [/^Gaulish$/, "Gaulish"], [/^Ar$/, "Arabic"],
];
export function routeOf(tags) {
  if (!tags) return [];
  return tags.split(/\s*[-–—]\s*/).map((t) => t.replace(/\.$/, "").replace(/\.\s*/g, ". ").trim()).map((t) => {
    const k = t.replace(/\.\s*/g, ".").replace(/\.$/, "").replace(/\s+/g, " ");
    const hit = LANGS.find(([re]) => re.test(k.replace(/\./g, "")) || re.test(k));
    return hit ? hit[1] : t;
  }).filter(Boolean);
}

// ───────── Wiktionary ─────────
const WK = "https://en.wiktionary.org/api/rest_v1/page/html/";
const LANG_NAMES = /\b(Old English|Middle English|Early Modern English|Old French|Middle French|Anglo-Norman|Old Norse|Proto-Germanic|Proto-West Germanic|Proto-Indo-European|Latin|Late Latin|Medieval Latin|New Latin|Vulgar Latin|Ancient Greek|Greek|Byzantine Greek|French|Italian|Spanish|Portuguese|Dutch|Middle Dutch|German|Middle High German|Old High German|Arabic|Persian|Hindi|Sanskrit|Hebrew|Turkish|Japanese|Chinese|Malay|Nahuatl|Quechua|Old Irish|Irish|Welsh|Scottish Gaelic|Celtic|Gaulish|Etruscan|Yiddish|Russian|Tamil|Urdu|Bengali|Swedish|Danish|Norwegian|Icelandic)\b/g;

/** Wiktionary's etymology: { text, parts: ["fast", "-est"], route: ["Proto-Germanic", …], url } or null. */
export async function wiktionaryEtymology(word) {
  const w = String(word || "").trim().toLowerCase();
  if (!w) return null;
  const key = "ety:" + w;
  const cached = await idb.get("defs", key).catch(() => null);
  if (cached && Date.now() - (cached.at || 0) < 60 * 864e5) return cached.ety;
  if (!navigator.onLine) return null;
  let ety = null;
  try {
    const res = await fetch(WK + encodeURIComponent(w), { headers: { Accept: "text/html" } });
    if (res.ok) ety = parseWiktionary(await res.text(), w);
    else if (res.status !== 404) return null; // try again next time
  } catch { return null; }
  await idb.put("defs", { id: key, ety, at: Date.now() }).catch(() => {});
  return ety;
}

function parseWiktionary(html, w) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const h2 = doc.getElementById("English");
  const english = h2?.closest("section");
  if (!english) return null;
  const head = [...english.querySelectorAll("h3, h4")].find((h) => /^Etymology/i.test(h.textContent.trim()));
  if (!head) return null;
  const sec = head.closest("section");
  const paras = [...sec.children].filter((n) => n.tagName === "P" && n.textContent.trim());
  const p = paras[0];
  if (!p) return null;
  // the parts it was built from: mentions joined by "+" (fast + -est)
  let run = [], parts = [];
  const mentions = [...p.querySelectorAll("i.mention, i[class*='mention']")];
  mentions.forEach((m, i) => {
    const glue = i ? textBetween(mentions[i - 1], m) : "";
    if (i && glue.length < 8 && /\+/.test(glue)) run.push(m.textContent.trim());
    else { if (run.length >= 2 && !parts.length) parts = run; run = [m.textContent.trim()]; }
  });
  if (run.length >= 2 && !parts.length) parts = run;
  const text = paras.slice(0, 2).map((x) => x.textContent).join(" ")
    .replace(/\[\d+\]/g, "").replace(/\s+/g, " ").replace(/\s([,.;:])/g, "$1").trim();
  // the languages it came through: "from Middle French …, from Latin …" — not the cousins in "cognate with German fest"
  const route = [];
  const lineage = text.split(/\b(?:[Cc]ognate|[Cc]ompare|[Dd]oublet|[Rr]elated to|[Aa]kin to|[Ss]ee also|[Cc]f\.)/)[0];
  const FROM = new RegExp(String.raw`\b(?:[Ff]rom|via|[Ii]nherited from|[Bb]orrowed from)\s+(?:the\s+)?(?:an?\s+)?(?:[a-z]+\s+)?` + LANG_NAMES.source, "g");
  for (const m of lineage.matchAll(FROM)) if (!route.includes(m[1])) route.push(m[1]);
  return { text: text.length > 700 ? text.slice(0, text.lastIndexOf(". ", 700) + 1 || 700) + " …" : text, parts: parts.filter((x) => x && x.length < 30), route, url: `https://en.wiktionary.org/wiki/${encodeURIComponent(w)}#Etymology` };
}

function textBetween(a, b) {
  const r = (a.ownerDocument || document).createRange();
  try { r.setStartAfter(a); r.setEndBefore(b); return r.toString(); } catch { return ""; }
}

/** Everything about how a word was made and where it came from. */
export async function wordStory(word, { online = true } = {}) {
  await lexiconReady();
  const w = String(word || "").toLowerCase();
  const anat = anatomy(w);
  const base = anat?.base && anat.base !== w ? anat.base : null;
  const [own, fromBase, wk, baseWk] = await Promise.all([
    skeat(w),
    base ? skeat(base) : Promise.resolve([]),
    online ? wiktionaryEtymology(w).catch(() => null) : Promise.resolve(null),
    online && base ? wiktionaryEtymology(base).catch(() => null) : Promise.resolve(null),
  ]);
  return { word: w, anatomy: anat, base, skeat: own.length ? own : fromBase, skeatFor: own.length ? w : base, wiktionary: wk, baseWiktionary: baseWk, known: isKnown(w) };
}
