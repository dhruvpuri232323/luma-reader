// A word's story: how it's made (each part and what it means), what the base
// word means, the road it took into English, Skeat's entry from his
// Etymological Dictionary (1901), and other words from the same root.
import { el, setKids } from "../core/util.js";
import { lookup } from "../data/dictionary.js";
import { wordStory, lexiconReady, skeat } from "../data/etymology.js";
import { anatomy, sumUp, isKnown, ROOTS, PREFIXES, SUFFIXES, ENDINGS } from "../data/morphology.js";
import { icon } from "./icons.js";

const firstDef = (entry) => entry?.meanings?.[0]?.defs?.[0]?.d || "";
const posOf = (entry) => (entry?.meanings || []).map((m) => (m.pos || "").toLowerCase());

const STOPW = new Set("the and for from with that this which also into upon able more most some thing things".split(" "));
/** Put Skeat's entry that matches today's meaning first (fast "quick", not fast "firm"). */
export function rankSkeat(list, ...entries) {
  if (!list?.length) return [];
  const text = entries.flatMap((e) => (e?.meanings || []).flatMap((m) => m.defs.map((d) => d.d))).join(" ").toLowerCase();
  const score = (e) => text ? ((`${e.g || ""} ${e.l || ""}`).toLowerCase().match(/[a-z]{3,}/g) || [])
    .filter((x) => !STOPW.has(x)).filter((x) => new RegExp(`\\b${x.slice(0, Math.max(4, x.length - 2))}`).test(text)).length : 0;
  return list.map((e, i) => ({ e, i, s: score(e) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => ({ ...x.e, matched: x.s > 0 }));
}

/** Make every word in a piece of text tappable. */
export function tappable(text, onWord) {
  const out = [];
  for (const piece of String(text || "").split(/([A-Za-z][A-Za-z'’-]*)/)) {
    if (/^[A-Za-z][A-Za-z'’-]*$/.test(piece) && piece.length >= 3) {
      out.push(el("span.tap-w", { role: "button", tabindex: "0", title: `What does “${piece}” mean?`, onclick: (e) => { e.stopPropagation(); onWord(piece); }, onkeydown: (e) => { if (e.key === "Enter") onWord(piece); } }, piece));
    } else if (piece) out.push(piece);
  }
  return out;
}

/** Like tappable, but only for words we know are English (etymologies are full of Latin). */
function tappableKeep(text, onWord) {
  return String(text || "").split(/([A-Za-z][a-z'’-]*)/).map((piece) =>
    /^[A-Za-z][a-z'’-]{2,}$/.test(piece) && isKnown(piece.toLowerCase()) && !/^(From|from|Old|Middle|English|French|Latin|Greek|German|Proto|Ancient)$/.test(piece)
      ? el("span.tap-w", { role: "button", tabindex: "0", onclick: (e) => { e.stopPropagation(); onWord(piece); }, onkeydown: (e) => { if (e.key === "Enter") onWord(piece); } }, piece)
      : piece);
}

/** Affix and root meanings for a part named by Wiktionary ("-est", "un-", "spect"). */
export function partMeaning(text) {
  const t = text.toLowerCase();
  if (t.startsWith("-")) {
    const f = t.slice(1);
    const end = ENDINGS[f];
    if (end) return { type: "ending", meaning: end.meaning, note: end.note };
    const sf = SUFFIXES.find((x) => x.form === f);
    return sf ? { type: "suffix", meaning: sf.meaning, from: sf.from } : { type: "suffix" };
  }
  if (t.endsWith("-")) {
    const pf = PREFIXES.find((x) => x.form === t.slice(0, -1));
    return pf ? { type: "prefix", meaning: pf.meaning, from: pf.from } : { type: "prefix" };
  }
  if (ROOTS[t]) return { type: "root", meaning: ROOTS[t].meaning, from: ROOTS[t].from };
  return { type: "base" };
}

/** The parts of a word as chips: [fast] + [-est · the most]. */
export function partsRow(parts, onWord) {
  return el("div.ws-parts", {}, parts.map((p, i) => [
    i ? el("span.ws-plus", { "aria-hidden": "true" }, "+") : null,
    el("span.ws-part." + p.type, {},
      p.type === "base" || p.link
        ? el("button.ws-part-word", { type: "button", onclick: () => onWord(p.link || p.text), title: `What does “${p.link || p.text}” mean?` }, p.text)
        : el("strong", {}, p.text),
      p.meaning ? el("span.ws-part-mean", {}, p.meaning) : p.type === "base" ? el("span.ws-part-mean.muted", {}, "the base word") : null),
  ]));
}

/** "Greek → Latin → French → English" */
export function routeRow(route) {
  if (!route?.length) return null;
  const list = [...route].reverse();
  if (!/^(Modern )?English$/.test(list[list.length - 1])) list.push("English");
  return el("div.ws-route", {}, list.map((l, i) => [i ? el("span.ws-arrow", { "aria-hidden": "true" }, "→") : null, el("span.ws-lang", {}, l)]));
}

/** Refine an "-er" ending once we know what the base word is (faster vs teacher). */
function refineEr(a, baseEntry) {
  if (!baseEntry || !a?.parts) return;
  const pos = posOf(baseEntry);
  const er = a.parts.find((p) => p.text === "-er" && p.type === "ending");
  if (er && (pos.includes("adjective") || pos.includes("adverb"))) { er.meaning = "more"; er.note = "comparative"; }
  else if (er && pos.includes("verb")) { er.meaning = "a person or thing that does it"; er.note = "doer"; }
  // lovely, friendly, costly: a thing-word + -ly describes, it doesn't say "how"
  const ly = a.parts.find((p) => p.text === "-ly" && p.type === "ending");
  if (ly && pos.includes("noun") && !pos.includes("adjective")) { ly.meaning = "having the qualities of"; ly.note = "like"; }
}

/** Compact version for the definition card: parts, the base meaning, and the origin. */
export async function storyInCard(box, word, { entry, onWord, onStory, alive }) {
  await lexiconReady();
  if (!alive()) return;
  let a = anatomy(word);
  // the dictionary itself may say "superlative form of fast"
  const formOf = !a && /(?:form|tense|participle|plural|comparative|superlative|spelling|degree) of ["“]?([a-z][a-z-]+)/i.exec(firstDef(entry))?.[1];
  if (!a && formOf) a = { word, base: formOf.toLowerCase(), parts: [{ text: formOf.toLowerCase(), type: "base", link: formOf.toLowerCase() }], change: firstDef(entry).split(/[.;:]/)[0] };
  if (!a && entry?.word && entry.word.toLowerCase() !== word) a = { word, base: entry.word.toLowerCase(), parts: [{ text: entry.word.toLowerCase(), type: "base", link: entry.word.toLowerCase() }], change: "a form of" };
  const base = a?.base && a.base !== word ? a.base : null;
  const baseRes = base ? await lookup(base).catch(() => null) : null;
  if (!alive()) return;
  if (baseRes?.status === "ok") refineEr(a, baseRes.entry);
  const story = wordStory(word).catch(() => null);
  const parts = [];
  if (a?.parts?.length > 1 || a?.change) {
    parts.push(el("div.ws-block", {},
      el("p.ws-label", {}, "How it's made"),
      a.parts.length > 1 ? partsRow(a.parts, onWord) : null,
      el("p.ws-sum", {}, el("strong", {}, word), " = ", sumUp(a))));
  }
  if (base && baseRes?.status === "ok") {
    const be = baseRes.entry;
    parts.push(el("div.ws-block.ws-basebox", {},
      el("p.ws-label", {}, `First, “${base}”`),
      el("p.ws-base", {}, el("button.ws-base-word", { type: "button", onclick: () => onWord(base) }, base),
        be.meanings[0]?.pos ? el("em", {}, ` ${be.meanings[0].pos}`) : null, " — ", tappable(firstDef(be), onWord))));
  }
  if (parts.length) setKids(box, ...parts);
  const explained = !!(base && baseRes?.status === "ok");
  const s = await story;
  if (!alive() || !s) return explained;
  // Wiktionary names parts we couldn't work out ourselves
  if (!a && s.wiktionary?.parts?.length >= 2) {
    const wkParts = s.wiktionary.parts.map((t) => ({ text: t, ...partMeaning(t), link: /^-|-$/.test(t) ? null : t }));
    box.prepend(el("div.ws-block", {}, el("p.ws-label", {}, "How it's made"), partsRow(wkParts, onWord)));
  }
  const ranked = rankSkeat(s.skeat, entry, baseRes?.entry);
  const sk = ranked[0];
  const senses = sk?.matched ? [sk] : ranked.slice(0, 2);
  const glosses = [...new Set(senses.map((e) => e.g).filter(Boolean))];
  // today's dictionaries first, then Skeat (1901); both list the newest language first
  const route = s.wiktionary?.route?.length ? s.wiktionary.route : s.baseWiktionary?.route?.length ? s.baseWiktionary.route : sk?.route?.length ? sk.route : null;
  if (route || sk) {
    box.append(el("div.ws-block.ws-origin", {},
      el("p.ws-label", {}, "Where it comes from"),
      route ? routeRow(route) : null,
      glosses.length ? el("p.ws-skeat", {}, el("span.muted", {}, `In 1901${s.skeatFor !== word ? `, “${s.skeatFor}”` : ""}: `), glosses.join(" · ")) : null,
      sk?.l ? el("p.ws-skeat", {}, el("span.muted", {}, "Originally: "), `“${sk.l}”`) : null,
      el("button.link.small.ws-more", { type: "button", onclick: onStory }, icon("book", 14), " The word's full story")));
  } else if (s.wiktionary?.text) {
    box.append(el("div.ws-block.ws-origin", {}, el("p.ws-label", {}, "Where it comes from"),
      el("p.ws-skeat", {}, s.wiktionary.text.split(/(?<=\.)\s/)[0]),
      el("button.link.small.ws-more", { type: "button", onclick: onStory }, icon("book", 14), " The word's full story")));
  }
  return explained;
}

/** The full story (in the look-up panel). */
export async function renderStory(box, word, { onWord, alive = () => true } = {}) {
  setKids(box, el("div.rs-skel", {}, el("span"), el("span"), el("span.short")));
  await lexiconReady();
  const [s, res] = await Promise.all([wordStory(word).catch(() => null), lookup(word).catch(() => null)]);
  if (!alive()) return;
  let a = s?.anatomy;
  const baseRes = s?.base ? await lookup(s.base).catch(() => null) : null;
  if (baseRes?.status === "ok") refineEr(a, baseRes.entry);
  if (!a && s?.wiktionary?.parts?.length >= 2) a = { word, parts: s.wiktionary.parts.map((t) => ({ text: t, ...partMeaning(t), link: /^-|-$/.test(t) ? null : t })) };
  const entry = res?.status === "ok" ? res.entry : null;
  const out = [
    el("header.ws-head", {}, el("p.ws-kicker", {}, "Word story"), el("h2.ws-word", {}, word),
      entry ? el("p.ws-meaning", {}, entry.meanings[0]?.pos ? el("em", {}, `${entry.meanings[0].pos} · `) : null, tappable(firstDef(entry), onWord)) : null),
  ];
  out.push(el("section.ws-sec", {}, el("h3", {}, "How it's made"),
    a?.parts?.length > 1 || a?.change
      ? [a.parts.length > 1 ? partsRow(a.parts, onWord) : null, el("p.ws-sum", {}, el("strong", {}, word), " = ", sumUp(a))]
      : el("p.muted", {}, "A single building block — it isn't made from smaller English words. Its history is below.")));
  if (s?.base && baseRes?.status === "ok") {
    out.push(el("section.ws-sec", {}, el("h3", {}, `What “${s.base}” means`),
      baseRes.entry.meanings.slice(0, 2).map((m) => el("p.ws-base", {}, m.pos ? el("em", {}, `${m.pos} — `) : null, tappable(m.defs[0]?.d || "", onWord)))));
  }
  const sk = rankSkeat(s?.skeat || [], entry, baseRes?.entry);
  const wk = s?.wiktionary;
  const bwk = s?.baseWiktionary;
  out.push(el("section.ws-sec", {}, el("h3", {}, "Where it comes from"),
    routeRow(wk?.route?.length ? wk.route : bwk?.route?.length ? bwk.route : sk[0]?.route),
    [wk, s?.base && !wk?.route?.length ? bwk : null].filter((x) => x?.text).map((x, i) => el("div.ws-src", {},
      el("p.ws-src-name", {}, i ? `Today's dictionaries — “${s.base}”` : "Today's dictionaries (Wiktionary)"),
      el("p", {}, tappableKeep(x.text, onWord)), el("a.small", { href: x.url, target: "_blank", rel: "noopener" }, "Read more on Wiktionary"))),
    sk.length ? sk.map((e) => el("div.ws-src.skeat", {},
      el("p.ws-src-name", {}, `Skeat's Etymological Dictionary (1901)${s.skeatFor !== word ? ` — under “${s.skeatFor}”` : ""}${e.p ? `, p. ${e.p}` : ""}`),
      el("p", {}, el("strong", {}, e.w), e.n ? ` (${e.n})` : "", e.g ? `, ${e.g}` : "", e.r ? el("span.muted", {}, ` (${e.r})`) : null),
      e.l ? el("p", {}, el("span.muted", {}, "Originally meant "), `“${e.l}”`) : null,
      e.x ? el("details.ws-skeat-full", {}, el("summary", {}, "Skeat's full entry"), el("p", {}, e.x), el("p.muted.small", {}, "Read from the scanned book, so some foreign spellings may have come out wrong.")) : null))
      : !wk?.text && !bwk?.text ? el("p.muted", {}, navigator.onLine ? "No history found for this word." : "Connect to the internet for today's dictionaries; Skeat's 1901 dictionary has no entry for this word.") : null));
  // other words built on the same root
  const r = a?.parts?.find((p) => p.type === "root");
  if (r) {
    const fam = await family(r.text, r.meaning, word).catch(() => []);
    if (fam.length) out.push(el("section.ws-sec", {}, el("h3", {}, `Other words from “${r.text}” (${r.meaning})`),
      el("div.chips", {}, fam.map((w) => el("button.chip", { onclick: () => onWord(w, { story: true }) }, w)))));
  }
  if (alive()) setKids(box, ...out);
}

const IRREGULAR_STEMS = { choose: ["chos"], write: ["writ", "wrot"], speak: ["spok", "spee"], break: ["brok", "brea"], take: ["took"], give: ["gav", "gift"], bear: ["bor", "birth"], run: ["ran"], fall: ["fell"], lead: ["led"], send: ["sent"], seek: ["sought"], see: ["seen", "sight"], say: ["said"], tell: ["told"], hold: ["held"], fly: ["flew", "flight"], draw: ["drew", "drawn"], throw: ["threw", "thrown"], know: ["knew", "known"], grow: ["grew", "grown"], find: ["found"], bind: ["bound"], tear: ["tore", "torn"] };
/** Words from the same root: Skeat's headwords containing the root whose entries say the same thing ("choose" for leg-). */
async function family(rootForm, meaning, word) {
  const list = await fetch(`vendor/skeat/index.json?v=1`).then((r) => r.json()).catch(() => []);
  const cands = list.filter((w) => w !== word && w.length > rootForm.length + 1 && w.includes(rootForm) && !/[^a-z]/.test(w)).slice(0, 40);
  const keys = ((meaning || "").toLowerCase().match(/[a-z]{3,}/g) || []).filter((x) => !STOPW.has(x))
    .flatMap((x) => [x.slice(0, Math.max(4, x.length - 2)), ...(IRREGULAR_STEMS[x] || [])]);
  if (!keys.length) return cands.slice(0, 12);
  const out = [];
  for (const w of cands) {
    const entries = await skeat(w);
    const text = entries.map((e) => `${e.g || ""} ${e.l || ""} ${e.x || ""}`).join(" ").toLowerCase();
    if (keys.some((k) => new RegExp(`\\b${k}`).test(text))) out.push(w);
    if (out.length >= 16) break;
  }
  return out;
}
export { skeat };
