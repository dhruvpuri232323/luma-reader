// The dictionary card: shown on hover/tap in the reader. Falls back from the
// dictionary to Wiktionary, WordNet and Wikipedia; if nothing knows the word it
// offers close spellings, an in-app look-up (Wikipedia, your books, the web)
// and a box to add your own meaning.
import { el, isNarrow, bus, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { lookup, saveWord, wordId, normalizeWord } from "../data/dictionary.js";
import { openResearch } from "./research.js";
import { storyInCard, tappable } from "./wordstory.js";
import { phraseBody, fullFormBlock, factsTable } from "./phrasecard.js";
import { wikiFacts } from "../data/wiki.js";
import { isPhrase } from "../data/phrases.js";
import { isAbbreviation } from "../data/abbrev.js";
import { translateBody } from "./translatecard.js";
import { detectLang } from "../data/translate.js";
import { cue } from "../core/feel.js";
import { speakOnce } from "../core/voice.js";
import { icon } from "./icons.js";
import { toast } from "./overlay.js";

let card = null;
let current = null; // { word, anchorRect, source }
let hideTimer = null;
let seq = 0;

const SOURCE_LABEL = {
  dictionary: "Dictionary",
  wiktionary: "Wiktionary",
  wordnet: "WordNet",
  wikipedia: "Wikipedia",
};

export function isDefinitionOpen() { return Boolean(card); }
export function definitionEl() { return card; }

export function hideDefinition() {
  clearTimeout(hideTimer);
  if (!card) return;
  const c = card;
  card = null;
  current = null;
  c.classList.remove("in");
  setTimeout(() => c.remove(), 160);
  bus.emit("definition-closed");
}

export function scheduleHide(ms = 280) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideDefinition, ms);
}
export function cancelHide() { clearTimeout(hideTimer); }

/**
 * Show a definition for `word` near `anchorRect`. `source` is
 * { docId, title, page, context } used when saving. `phrase` is a proper
 * noun around the word ("Adam Smith"), looked up on Wikipedia first.
 */
export async function showDefinition(word, anchorRect, source, { sticky = false, phrase = null } = {}) {
  const w = normalizeWord(word);
  if (!w || w.length < 2 || /^\d+$/.test(w)) return;
  const key = phrase || w;
  if (current?.key === key && card) { cancelHide(); return; }
  const my = ++seq;
  hideDefinition();
  current = { key, word: w, raw: word, anchorRect, source, phrase };
  card = el("div.defcard" + (sticky || isNarrow() ? ".sticky" : ""), { role: "dialog", "aria-label": `Definition of ${phrase || w}` });
  card.addEventListener("pointerenter", cancelHide);
  card.addEventListener("pointerleave", () => { if (!card?.classList.contains("sticky")) scheduleHide(400); });
  document.body.append(card);
  renderLoading(phrase || w);
  position(anchorRect);
  requestAnimationFrame(() => card?.classList.add("in"));

  if (source?.docId) bus.emit("lookup", { docId: source.docId, page: source.page, word: phrase || w });
  if (isForeign(word)) { renderTranslate(); position(anchorRect); return; } // a Hindi (or other) word: its English
  if (!phrase && isPhrase(word)) { renderPhrase(); position(anchorRect); return; }
  const res = await lookup(word, { phrase });
  if (my !== seq || !card) return;
  render(res);
  position(anchorRect);
}

function position(rect) {
  if (!card) return;
  if (isNarrow()) { card.style.left = card.style.top = ""; return; }
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let left = rect.left + rect.width / 2 - cw / 2;
  left = Math.max(10, Math.min(left, innerWidth - cw - 10));
  let top = rect.bottom + 10;
  card.dataset.side = "below";
  if (top + ch > innerHeight - 10 && rect.top - ch - 10 > 10) { top = rect.top - ch - 10; card.dataset.side = "above"; }
  top = Math.max(10, Math.min(top, innerHeight - ch - 10));
  card.style.left = left + "px";
  card.style.top = top + "px";
}

function renderLoading(w) {
  setKids(card,
    el("div.def-head", {}, el("h3.def-word", {}, w)),
    el("div.def-skel", {}, el("span"), el("span"), el("span.short")));
}

/** Look up another word inside the card (a word you didn't know in a definition). */
async function goTo(word, { back = false, translate = false } = {}) {
  if (!card || !current) return;
  const w = normalizeWord(word);
  if (!w || w.length < 2 || (w === current.word && !back)) return;
  const trail = current.trail || [];
  if (!back) trail.push({ word: current.translate ? current.raw.slice(0, 40) : current.word, raw: current.raw, phrase: current.phrase, translate: current.translate });
  const my = ++seq;
  current = { ...current, key: w, word: w, raw: word, phrase: null, trail, translate };
  card.classList.add("sticky");
  if (translate) { renderTranslate(); position(current.anchorRect); return; }
  renderLoading(w);
  if (isForeign(word)) { renderTranslate(); position(current.anchorRect); return; }
  if (isPhrase(word)) { renderPhrase(); position(current.anchorRect); return; }
  const res = await lookup(word);
  if (my !== seq || !card) return;
  render(res);
  position(current.anchorRect);
}
function goBack() {
  const prev = current?.trail?.pop();
  if (prev) goTo(prev.raw || prev.word, { back: true, translate: prev.translate });
}

function render(res) {
  const { word: w, raw, source } = current;
  const my = seq;
  const onWord = (x) => goTo(x);
  const entry = res.entry;
  const abbr = isAbbreviation(raw);
  const headword = abbr ? String(raw).trim() : entry?.word || w;
  const onArticle = (title) => { hideDefinition(); openResearch(title, { source, article: title }); };
  const fullBox = (onFound) => abbr ? fullFormBlock(String(raw).trim(), { docId: source?.docId, onWord, onArticle, alive: () => card && seq === my, onFound }) : null;
  const id = wordId(entry?.source === "wikipedia" ? headword : headword);
  const saved = store.get("words", id) || store.get("words", wordId(w));
  const rerender = () => card && render(res);

  const saveBtn = el("button.def-save" + (saved ? ".on" : ""), {
    "aria-label": saved ? "Remove from words" : "Save word",
    title: saved ? "Saved — click to remove" : "Save to your words",
    onclick: async () => {
      if (saved) {
        await store.remove("words", saved.id);
        cue("remove");
        toast(`Removed “${saved.word}”`);
      } else if (res.status === "ok") {
        const rec = await saveWord({ word: w, entry, source });
        cue("save");
        toast(`Saved “${rec.word}”`, { action: "Add note", onAction: () => bus.emit("edit-word", rec.id) });
      } else {
        card.querySelector(".def-own textarea")?.focus();
        return;
      }
      rerender();
    },
  }, icon(saved ? "bookmarkOn" : "bookmark", 17), el("span", {}, saved ? "Saved" : "Save"));

  const speak = el("button.icon-btn", { "aria-label": "Pronounce", title: "Pronounce", onclick: () => playWord(headword, entry?.audio) }, icon("speak", 18));

  const prev = current.trail?.[current.trail.length - 1];
  const head = el("div.def-head", {},
    prev ? el("button.icon-btn.def-back", { "aria-label": `Back to “${prev.word}”`, title: `Back to “${prev.word}”`, onclick: goBack }, icon("back", 18)) : null,
    entry?.thumb ? el("img.def-thumb", { src: entry.thumb, alt: "", referrerpolicy: "no-referrer" }) : null,
    el("div.def-title", {},
      el("h3.def-word", {}, headword),
      entry?.phonetic ? el("span.def-phon", {}, entry.phonetic) : null),
    el("div.def-actions", {}, speak, saveBtn,
      el("button.icon-btn.def-close", { "aria-label": "Close", onclick: hideDefinition }, icon("x", 18))));

  // look further without leaving the app: Wikipedia, your books, and Google one tap on
  const lookFurther = (article) => { const q = entry?.source === "wikipedia" ? headword : (raw || w).trim(); hideDefinition(); openResearch(q, { source, article }); };
  const google = el("button.def-google", { type: "button", title: "Wikipedia, your books and notes, and the web — without leaving Luma", onclick: () => lookFurther(null) },
    icon("search", 15), el("span", {}, "Look it up"));

  let body;
  if (res.status === "ok") {
    const isWiki = entry.source === "wikipedia";
    const story = el("div.def-story");
    const factsSlot = el("div");
    if (isWiki) wikiFacts(headword).then((f) => { if (card && seq === my && f?.facts?.length) { factsSlot.replaceWith(el("div.ph-factbox", {}, el("p.ph-sub", {}, "Key facts"), factsTable(f.facts, { limit: 5 }))); position(current.anchorRect); } }).catch(() => {});
    let hasFull = false;
    body = el("div.def-body", {},
      fullBox((list) => { if (list.length) { hasFull = true; story.remove(); } }),
      story,
      saved?.customDef ? el("div.def-mine", {}, el("strong", {}, "Your definition"), el("p", {}, saved.customDef)) : null,
      isWiki
        ? el("section.def-sense", {},
            el("p.def-pos", {}, entry.meanings[0].pos),
            el("p.def-extract", {}, tappable(entry.meanings[0].defs[0].d, onWord)),
            factsSlot)
        : entry.meanings.slice(0, 4).map((m) =>
            el("section.def-sense", {},
              m.pos ? el("p.def-pos", {}, m.pos) : null,
              el("ol", {}, m.defs.slice(0, 3).map((d) => el("li", {}, tappable(d.d, onWord), d.ex ? el("q.def-ex", {}, d.ex) : null))),
              m.synonyms?.length ? el("p.def-rel", {}, el("span", {}, "Similar"), " ", m.synonyms.slice(0, 6).join(", ")) : null,
              m.antonyms?.length ? el("p.def-rel", {}, el("span", {}, "Opposite"), " ", m.antonyms.slice(0, 4).join(", ")) : null)),
      entry.wiki ? el("details.def-wiki", {},
        el("summary", {}, `Also: ${entry.wiki.title} on Wikipedia`),
        el("p", {}, entry.wiki.extract),
        el("button.link.small", { type: "button", onclick: () => { hideDefinition(); openResearch(entry.wiki.title, { source, article: entry.wiki.title }); } }, "Read the article")) : null);
    const foot = el("div.def-foot", {},
      el("span.def-src", {}, `From ${SOURCE_LABEL[entry.source] || "dictionary"}`, res.cached ? " · works offline" : ""),
      isWiki
        ? el("button.def-more", { type: "button", onclick: () => lookFurther(headword) }, "Read the article")
        : entry.sourceUrl ? el("a.def-more", { href: entry.sourceUrl, target: "_blank", rel: "noopener" }, "Read more") : null,
      el("span.spacer"), google);
    setKids(card, head, body, foot);
    if (!isWiki && !hasFull) storyInCard(story, w, { entry, onWord, onStory: () => { hideDefinition(); openResearch(w, { source, story: w }); }, alive: () => card && seq === my }).then(() => card && seq === my && position(current.anchorRect)).catch((e) => console.warn("Word story:", e));
  } else {
    const msg = {
      missing: `“${w}” isn't in the dictionaries yet.`,
      offline: `You're offline and “${w}” hasn't been looked up on this device before.`,
      error: "The dictionaries didn't respond. Try again in a moment.",
    }[res.status];
    const ta = el("textarea.input", { rows: 2, placeholder: "Write the meaning in your own words (or paste one you found)" });
    if (saved?.customDef) ta.value = saved.customDef;
    const own = el("form.def-own", {
      onsubmit: async (e) => {
        e.preventDefault();
        const meaning = ta.value.trim();
        if (!meaning) { ta.focus(); return; }
        const rec = await saveWord({ word: w, entry: null, source, customDef: meaning });
        cue("save");
        toast(`Saved “${rec.word}” with your meaning`);
        rerender();
      },
    }, ta, el("button.btn.sm.primary", { type: "submit" }, icon("plus", 16), el("span", {}, saved ? "Update meaning" : "Add word")));
    const story = el("div.def-story");
    const msgEl = el("p.muted", {}, msg);
    body = el("div.def-body", {},
      fullBox((list) => { if (list.length) { msgEl.remove(); story.remove(); } }),
      story,
      saved?.customDef ? el("div.def-mine", {}, el("strong", {}, "Your definition"), el("p", {}, saved.customDef)) : msgEl,
      !saved && res.suggestions?.length ? el("p.def-sugg", {}, "Did you mean ",
        res.suggestions.map((sug, i) => [i ? ", " : "", el("button.link", {
          onclick: () => { const r = current.anchorRect, s = current.source; hideDefinition(); showDefinition(sug, r, s, { sticky: true }); },
        }, sug)]), "?") : null,
      google,
      own);
    setKids(card, head, body);
    card.classList.add("sticky"); // stays open while you type
    // even an unknown word can often be worked out from its parts
    storyInCard(story, w, { entry: null, onWord, onStory: () => { hideDefinition(); openResearch(w, { source, story: w }); }, alive: () => card && seq === my })
      .then((explained) => { if (explained && res.status === "missing") msgEl.remove(); if (card && seq === my) position(current.anchorRect); }).catch(() => {});
  }
}

/** Words in another script (Hindi, Bengali, Arabic…): translate rather than look up in the English dictionary. */
const isForeign = (text) => /[^\u0000-\u024F\u1E00-\u1EFF\u2000-\u206F]/u.test(String(text)) && detectLang(text) !== "en";

/**
 * Translate a passage (English ⇄ your other language), in the card.
 * `rect` is where it came from; `source` = { docId, page, … }.
 */
export function showTranslation(text, anchorRect, source = null) {
  const t = String(text || "").trim();
  if (!t) return;
  seq++;
  hideDefinition();
  current = { key: "tr:" + t, word: normalizeWord(t) || t, raw: t, anchorRect, source, translate: true };
  card = el("div.defcard.sticky", { role: "dialog", "aria-label": "Translation" });
  card.addEventListener("pointerenter", cancelHide);
  document.body.append(card);
  renderTranslate();
  position(anchorRect);
  requestAnimationFrame(() => card?.classList.add("in"));
}

function renderTranslate() {
  const { raw, source } = current;
  const text = String(raw).trim();
  const my = seq;
  const onWord = (x) => goTo(x);
  const body = translateBody(text, { onWord, alive: () => card && seq === my });
  const single = !/\s/.test(text);
  const saveBtn = single || text.split(/\s+/).length <= 6 ? el("button.def-save", {
    "aria-label": "Save with its translation", title: "Save to your words, with the translation as its meaning",
    onclick: async () => {
      const r = body.result();
      if (!r?.text) { toast("Wait for the translation first"); return; }
      const entry = { word: text, asked: text, phonetic: "", audio: "", source: "translation", sourceUrl: "", meanings: [{ pos: `${r.from} → ${r.to}`, defs: [{ d: r.text, ex: "" }], synonyms: [], antonyms: [] }] };
      const rec = await saveWord({ word: text, entry, source });
      cue("save");
      toast(`Saved “${rec.word}”`);
      saveBtn.classList.add("on");
      setKids(saveBtn, icon("bookmarkOn", 17), el("span", {}, "Saved"));
    },
  }, icon("bookmark", 17), el("span", {}, "Save")) : null;
  const prev = current.trail?.[current.trail.length - 1];
  const head = el("div.def-head", {},
    prev ? el("button.icon-btn.def-back", { "aria-label": `Back to “${prev.word}”`, title: `Back to “${prev.word}”`, onclick: goBack }, icon("back", 18)) : null,
    el("div.def-title", {}, el("h3.def-word.def-phrase", {}, icon("translate", 18), " Translate")),
    el("div.def-actions", {}, saveBtn,
      el("button.icon-btn.def-close", { "aria-label": "Close", onclick: hideDefinition }, icon("x", 18))));
  setKids(card, head, el("div.def-body", {}, body));
  card.classList.add("sticky");
  const ro = new ResizeObserver(() => { if (card && seq === my) position(current.anchorRect); else ro.disconnect(); });
  ro.observe(card);
}

/** Several words at once: the phrase, each word, and what Wikipedia says. */
function renderPhrase() {
  const { raw, source } = current;
  const text = String(raw).replace(/\s+/g, " ").trim();
  const my = seq;
  const onWord = (x) => goTo(x);
  const onArticle = (title) => { hideDefinition(); openResearch(title, { source, article: title }); };
  const body = phraseBody(text, { docId: source?.docId, onWord, onArticle, alive: () => card && seq === my });
  const id = wordId(text);
  const saved = store.get("words", id);
  const saveBtn = el("button.def-save" + (saved ? ".on" : ""), {
    "aria-label": saved ? "Saved" : "Save phrase", title: saved ? "In your words" : "Save to your words, with its meaning",
    onclick: async () => {
      if (store.get("words", id)) { toast("Already in your words"); return; }
      const meaning = body.summary();
      const entry = { word: text, asked: text, phonetic: "", audio: "", source: "phrase", sourceUrl: "", meanings: [{ pos: "phrase", defs: [{ d: meaning || text, ex: "" }], synonyms: [], antonyms: [] }] };
      const rec = await saveWord({ word: text, entry, source });
      cue("save");
      toast(`Saved “${rec.word}”`);
      saveBtn.classList.add("on");
      setKids(saveBtn, icon("bookmarkOn", 17), el("span", {}, "Saved"));
    },
  }, icon(saved ? "bookmarkOn" : "bookmark", 17), el("span", {}, saved ? "Saved" : "Save"));
  const prev = current.trail?.[current.trail.length - 1];
  const head = el("div.def-head", {},
    prev ? el("button.icon-btn.def-back", { "aria-label": `Back to “${prev.word}”`, title: `Back to “${prev.word}”`, onclick: goBack }, icon("back", 18)) : null,
    el("div.def-title", {}, el("h3.def-word.def-phrase", {}, text)),
    el("div.def-actions", {},
      el("button.icon-btn", { "aria-label": "Pronounce", title: "Pronounce", onclick: () => speakOnce(text) }, icon("speak", 18)),
      saveBtn,
      el("button.icon-btn.def-close", { "aria-label": "Close", onclick: hideDefinition }, icon("x", 18))));
  const foot = el("div.def-foot", {},
    el("span.def-src", {}, "Dictionary · Wikipedia"),
    el("span.spacer"),
    el("button.def-google", { type: "button", title: "Wikipedia, your books and notes, and the web — without leaving Luma", onclick: () => { hideDefinition(); openResearch(text, { source }); } },
      icon("search", 15), el("span", {}, "Look it up")));
  setKids(card, head, el("div.def-body", {}, body), foot);
  card.classList.add("sticky");
  // the card grows as answers arrive: keep it on screen
  const ro = new ResizeObserver(() => { if (card && seq === my) position(current.anchorRect); else ro.disconnect(); });
  ro.observe(card);
}

export function playWord(word, audioUrl) {
  if (audioUrl && navigator.onLine) {
    const a = new Audio(audioUrl);
    a.play().catch(() => speakOnce(word));
  } else {
    speakOnce(word);
  }
}

window.addEventListener("resize", () => current && card && position(current.anchorRect));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && card) hideDefinition(); });
