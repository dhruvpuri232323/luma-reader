// "Words here": before you read a chapter, find the words in it you might not
// know — rare words, not names or everyday words — so you can learn them first
// or have them marked in the text. Frequencies come from Datamuse (free) and are
// cached on the device; with no connection it falls back to a careful guess.
import { el, setKids } from "../core/util.js";
import { idb } from "../data/db.js";
import { store } from "../data/store.js";
import { isCommon, baseForms } from "../data/common-words.js";
import { lookup, saveWord, wordId } from "../data/dictionary.js";
import { showDefinition } from "../ui/definition.js";
import { icon } from "../ui/icons.js";
import { toast } from "../ui/overlay.js";

const LEVELS = { hard: { label: "Rare words only", max: 1.2 }, unusual: { label: "Rare and unusual", max: 4 } };
const cache = new Map(); // `${docId}:${page}` → scan

export async function frequency(w) {
  const cached = await idb.get("freq", w).catch(() => null);
  if (cached && Date.now() - cached.at < 120 * 864e5) return cached.f;
  try {
    const r = await fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(w)}&md=f&max=1`);
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    const hit = data[0]?.word === w ? data[0] : null;
    const tag = hit?.tags?.find((t) => t.startsWith("f:"));
    const f = hit ? Number(tag?.slice(2) || 0) : 0;
    idb.put("freq", { id: w, f, at: Date.now() }).catch(() => {});
    return f;
  } catch {
    return null;
  }
}

function sentenceAround(text, i) {
  const a = Math.max(text.lastIndexOf(". ", i) + 1, text.lastIndexOf("? ", i) + 1, text.lastIndexOf("! ", i) + 1, 0);
  let b = text.slice(i).search(/[.!?](\s|$)/);
  b = b < 0 ? text.length : i + b + 1;
  const s = text.slice(a, b).trim();
  return s.length > 240 ? s.slice(Math.max(0, i - a - 110), i - a + 130).trim() + "…" : s;
}

/** Scan from a page to the end of its chapter (max ~30 pages) for words worth learning. */
export async function scanHardWords(tab, fromPage) {
  const model = tab.model;
  await model.ready?.();
  const start = fromPage || tab.currentPage();
  const key = `${tab.docId}:${start}`;
  if (cache.has(key)) return cache.get(key);
  const counts = new Map(), first = new Map(), caps = new Map();
  let end = start;
  for (let p = start; p <= model.numPages && p < start + 30; p++) {
    const blocks = await model.page(p);
    if (p > start + 2 && blocks.some((b) => b.type === "h" && b.level === 2)) break;
    end = p;
    for (const b of blocks) {
      if (b.type !== "p" && b.type !== "quote") continue;
      for (const m of b.text.matchAll(/[\p{L}][\p{L}’']*[\p{L}]/gu)) {
        const raw = m[0];
        const w = raw.toLowerCase().replace(/[’']s$/, "");
        if (w.length < 5 || /[’']/.test(w)) continue;
        const atStart = m.index === 0 || /[.!?“"‘(]\s*$/.test(b.text.slice(Math.max(0, m.index - 3), m.index));
        if (/^\p{Lu}/u.test(raw) && !atStart) caps.set(w, (caps.get(w) || 0) + 1);
        counts.set(w, (counts.get(w) || 0) + 1);
        if (!first.has(w)) first.set(w, { page: p, context: sentenceAround(b.text, m.index) });
      }
    }
  }
  const saved = new Set(store.list("words").map((x) => x.word));
  const savedHere = [];
  const cands = [];
  for (const [w, n] of counts) {
    if ((caps.get(w) || 0) >= n * 0.5) continue; // a name
    const forms = baseForms(w);
    const mine = forms.find((x) => saved.has(x));
    if (mine) { if (!savedHere.includes(mine)) savedHere.push(mine); continue; }
    if (isCommon(w)) continue;
    cands.push(w);
  }
  cands.sort((a, b) => b.length - a.length);
  const list = cands.slice(0, 260);
  const freqs = new Map();
  let offline = false;
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < list.length) {
      const w = list[i++];
      const f = await frequency(w);
      if (f == null) offline = true;
      freqs.set(w, f);
    }
  }));
  const words = list.map((w) => ({ word: w, count: counts.get(w), f: freqs.get(w), ...first.get(w) }))
    .filter((x) => (x.f == null ? x.word.length >= 10 : x.f > 0 && x.f < LEVELS.unusual.max))
    .sort((a, b) => (a.f ?? 0.5) - (b.f ?? 0.5) || b.word.length - a.word.length);
  const scan = { start, end, words, savedHere, offline: offline && !words.some((x) => x.f != null) };
  cache.set(key, scan);
  return scan;
}

/** The "Words here" side panel. */
export async function renderWordsHere(body, tab, { book } = {}) {
  const level = localStorage.getItem("luma.hardLevel") || "hard";
  const status = el("p.muted.small.pad-x", {}, "Looking for words you might not know…");
  const listBox = el("div");
  body.append(status, listBox);
  if (tab.state !== "ready") { status.textContent = "Open the book first."; return; }
  let scan;
  try { scan = await scanHardWords(tab, tab.currentPage()); } catch (e) { status.textContent = "Couldn't scan this part of the book."; return; }
  if (!body.isConnected) return;
  const words = scan.words.filter((x) => x.f == null || x.f < LEVELS[level].max);
  const marked = store.settings().markHard;
  book?.setHard(words.map((x) => x.word));
  const savedIds = new Set(store.list("words").map((w) => w.id));
  status.replaceWith(el("div.wh-head.pad-x", {},
    el("p.muted.small", {}, scan.offline
      ? `Offline — showing long words that may be unfamiliar on pages ${scan.start}–${scan.end}.`
      : `${words.length ? words.length : "No"} ${words.length === 1 ? "word" : "words"} worth knowing on pages ${scan.start}–${scan.end}.`),
    el("div.row.wrap", {},
      el("select.input.sm", { "aria-label": "Which words", onchange: (e) => { localStorage.setItem("luma.hardLevel", e.target.value); setKids(body); renderWordsHere(body, tab, { book }); } },
        Object.entries(LEVELS).map(([k, v]) => el("option", { value: k, selected: k === level }, v.label))),
      book ? el("label.check.small", {}, el("input", { type: "checkbox", checked: Boolean(marked), onchange: async (e) => { await store.setSettings({ markHard: e.target.checked }); book.refreshHard(); } }), "Underline them in the text") : null,
      words.length ? el("button.btn.sm", { onclick: async (e) => {
        e.currentTarget.disabled = true;
        let n = 0;
        for (const x of words) if (!savedIds.has(wordId(x.word))) { await saveOne(x, tab); n++; }
        toast(n ? `Saved ${n} words to review` : "They're all saved already");
        setKids(body); renderWordsHere(body, tab, { book });
      } }, icon("plus", 15), "Save all") : null)));
  const items = words.map((x) => {
    const isSaved = savedIds.has(wordId(x.word));
    const ctx = x.context || "";
    const at = ctx.toLowerCase().indexOf(x.word);
    const quote = at >= 0 ? [ctx.slice(0, at), el("mark", {}, ctx.slice(at, at + x.word.length)), ctx.slice(at + x.word.length)] : [ctx];
    const meaning = el("p.wh-meaning.small");
    const item = el("li.item.wh-item", {},
      el("div.item-main", {},
        el("span.wh-word", {}, x.word, el("span.muted.small", {}, x.count > 1 ? ` · ${x.count}×` : ""), x.f != null ? el("span.wh-rare", { title: `${x.f.toFixed(2)} per million words` }, x.f < 0.3 ? "very rare" : x.f < 1.2 ? "rare" : "unusual") : null),
        el("span.item-text.small", {}, ...quote),
        meaning),
      el("div.wh-actions", {},
        el("button.icon-btn", { "aria-label": `Define ${x.word}`, title: "Define", onclick: (e) => showDefinition(x.word, e.currentTarget.getBoundingClientRect(), { docId: tab.docId, title: tab.doc?.title, page: x.page, context: x.context }, { sticky: true }) }, icon("words", 17)),
        el("button.icon-btn" + (isSaved ? ".on" : ""), { "aria-label": isSaved ? `${x.word} is saved` : `Save ${x.word}`, title: isSaved ? "Saved" : "Save to review", onclick: async (e) => {
          const b = e.currentTarget;
          if (b.classList.contains("on")) return;
          b.disabled = true;
          await saveOne(x, tab);
          b.classList.add("on");
          setKids(b, icon("check", 17));
          b.disabled = false;
        } }, icon(isSaved ? "check" : "plus", 17))));
    // fill in a short meaning in the background
    lookup(x.word).then((res) => { const d = res?.entry?.meanings?.[0]?.defs?.[0]?.d; if (d && meaning.isConnected) meaning.textContent = d; }).catch(() => {});
    return item;
  });
  listBox.append(words.length ? el("ul.item-list", {}, items) : el("p.muted.pad", {}, "Nothing unusual here — enjoy the read."));
  if (scan.savedHere.length) {
    listBox.append(el("div.pad-x.wh-mine", {},
      el("p.muted.small", {}, "Words you're learning that appear here"),
      el("div.chips", {}, scan.savedHere.slice(0, 40).map((w) => el("button.chip", { onclick: (e) => showDefinition(w, e.currentTarget.getBoundingClientRect(), { docId: tab.docId, title: tab.doc?.title, page: tab.currentPage() }, { sticky: true }) }, w)))));
  }
}

async function saveOne(x, tab) {
  let entry = null;
  try { const res = await lookup(x.word); if (res.status === "ok") entry = res.entry; } catch {}
  await saveWord({ word: x.word, entry, source: { docId: tab.docId, title: tab.doc?.title || "", page: x.page, context: x.context } });
}
