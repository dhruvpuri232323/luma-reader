// What several words mean together, and full forms of abbreviations — shared by
// the word card in the reader and the "Look it up" panel.
import { el, setKids } from "../core/util.js";
import { icon } from "./icons.js";
import { tappable } from "./wordstory.js";
import { isAbbreviation, fullForms } from "../data/abbrev.js";
import { wikiAnswer, wikiSummary, wikiFacts, sentences, contentWords } from "../data/wiki.js";
import { phraseMeaning, wordByWord, together, shortDef, firstDef, isPhrase } from "../data/phrases.js";
import { anatomy } from "../data/morphology.js";

const skel = () => el("div.rs-skel", {}, el("span"), el("span.short"));
const label = (t) => el("p.ws-label", {}, t);
const stripParen = (s) => s.replace(/\s*\(.*?\)\s*/g, " ").trim();
const firstSentences = (text, n) => sentences(text).slice(0, n).join(" ") || text.slice(0, 400);
const wpLabel = () => el("p.ws-label", {}, el("span.wp-logo", { "aria-hidden": "true" }, "W"), " Wikipedia");

/** Mark the words of the phrase inside a sentence. */
function marked(sentence, phrase) {
  const stems = contentWords(phrase).flatMap((w) => [w, anatomy(w)?.base].filter((x) => x && x.length >= 3));
  return sentence.split(/(\p{L}[\p{L}'’-]*)/u).map((piece) =>
    stems.some((st) => piece.toLowerCase().startsWith(st)) ? el("mark", {}, piece) : piece);
}

/** Key facts from the article's infobox, as a small table. */
export function factsTable(facts, { limit = 6 } = {}) {
  if (!facts?.length) return null;
  return el("dl.ph-facts", {}, facts.slice(0, limit).map((f) => [el("dt", {}, f.label), el("dd", {}, f.value)]));
}

/**
 * "GDP = Gross Domestic Product": where it's defined in this book, the built-in
 * list, Wiktionary or Wikipedia — and what the full form means. Removes itself if
 * nothing is found. `onFound(list)` is called with the full forms.
 */
export function fullFormBlock(raw, { docId, onWord, onArticle, alive, onFound = () => {} }) {
  const shown = String(raw).trim().replace(/(?<=[A-Z]{2})s$/, "");
  const box = el("div.ws-block.ph-full", {}, label("Full form"), skel());
  const FROM = {
    book: (x) => `as this book defines it, p. ${x.page}`,
    list: () => "common abbreviation",
    wiktionary: (x) => (x.note ? `Wiktionary · ${x.note}` : "Wiktionary"),
    wikipedia: () => "Wikipedia",
    roman: () => "Roman numeral",
  };
  fullForms(shown, { docId }).then(async (list) => {
    if (!alive()) return;
    onFound(list);
    if (!list.length) { box.remove(); return; }
    setKids(box, label(list.length > 1 ? "Full forms" : "Full form"),
      el("ul.ph-full-list", {}, list.map((x) => el("li", {},
        el("span.ph-abbr", {}, shown), el("span.ph-eq", { "aria-hidden": "true" }, "="),
        x.from === "roman" ? el("strong.ph-full-text", {}, x.full)
          : el("button.ph-full-btn", { type: "button", title: `What is “${stripParen(x.full)}”?`, onclick: () => onWord(stripParen(x.full)) }, x.full),
        el("span.ph-src" + (x.from === "book" ? ".book" : ""), {}, FROM[x.from](x))))));
    // what the first full form means
    const top = list.find((x) => x.from !== "roman");
    if (!top) return;
    const sum = top.summary || (await wikiSummary(stripParen(top.full)).catch(() => null));
    if (!alive() || !sum?.extract || sum.type === "disambiguation") return;
    box.append(el("div.ph-full-mean", {},
      el("p", {}, tappable(firstSentences(sum.extract, 2), onWord)),
      el("button.link.small", { type: "button", onclick: () => onArticle(sum.title) }, icon("globe", 13), ` “${sum.title}” on Wikipedia`)));
  }).catch(() => box.remove());
  return box;
}

/**
 * Everything about a phrase (or an abbreviation): its full form, its meaning as a
 * phrase, a plain sentence that puts it together, each word on its own, and what
 * Wikipedia says. The returned element has .summary() — the best one-line meaning.
 */
export function phraseBody(text, { docId = null, onWord, onArticle, alive = () => true, compact = true, wikiMore = true }) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const root = el("div.ph");
  const state = { exact: "", answer: "", topic: "", together: "", words: "", full: "" };
  if (!isPhrase(t) && isAbbreviation(t)) root.append(fullFormBlock(t, { docId, onWord, onArticle, alive, onFound: (l) => { state.full = l[0]?.full || ""; } }));

  const exact = el("div.ws-block.ph-exact", {}, skel());
  const tog = el("div.ph-tog");
  const wbw = el("details.ws-block.ph-words", { open: true }, el("summary.ws-label", {}, "Word by word"), skel());
  const wiki = el("div.ws-block.ph-wiki", {}, wpLabel(), skel());
  root.append(exact, tog, wbw, wiki);
  let settledWhole = false;
  const foldWords = () => { if (!settledWhole) { settledWhole = true; if (wbw.dataset.touched !== "1") wbw.open = false; } };
  wbw.addEventListener("click", (e) => { if (e.target.closest("summary")) wbw.dataset.touched = "1"; });

  // 1 · the phrase as one dictionary entry (an idiom, a set phrase)
  phraseMeaning(t).then((res) => {
    if (!alive()) return;
    if (res?.status !== "ok") { exact.remove(); return; }
    const e = res.entry;
    state.exact = firstDef(e);
    setKids(exact,
      label(res.as && res.as !== t.toLowerCase() ? `As a phrase — “${res.as}”` : "As a phrase"),
      e.meanings.slice(0, compact ? 2 : 4).map((m) => el("div.ph-sense", {},
        m.pos ? el("p.def-pos", {}, m.pos) : null,
        el("ol", {}, m.defs.slice(0, compact ? 2 : 3).map((d) => el("li", {}, tappable(d.d, onWord), d.ex ? el("q.def-ex", {}, d.ex) : null))))));
    foldWords();
  }).catch(() => exact.remove());

  // 2 · word by word, with the base word for forms like "fastest"
  wordByWord(t).then((words) => {
    if (!alive()) return;
    const line = together(t, words);
    if (line) tog.replaceWith(el("p.ph-together", {}, el("strong", {}, t), " = ", line));
    else tog.remove();
    state.together = line;
    state.words = words.map((x) => `${x.word}: ${shortDef(x.baseEntry || x.entry) || "?"}`).join("; ");
    setKids(wbw, el("summary.ws-label", {}, "Word by word"),
      el("ul.ph-wordlist", {}, words.map((x) => {
        const mean = x.base && x.baseEntry
          ? [el("button.ph-base", { type: "button", onclick: () => onWord(x.base) }, x.base), x.baseEntry.meanings[0]?.pos ? el("em", {}, ` ${x.baseEntry.meanings[0].pos}`) : null, " — ", tappable(shortDef(x.baseEntry), onWord)]
          : x.entry ? [x.entry.meanings[0]?.pos ? el("em", {}, `${x.entry.meanings[0].pos} — `) : null, tappable(shortDef(x.entry), onWord)]
          : [el("span.muted", {}, x.offline ? "look it up when you're online" : "not in the dictionaries")];
        return el("li.ph-word", {},
          el("button.ph-w", { type: "button", title: `More about “${x.word}”`, onclick: () => onWord(x.word) }, x.word),
          x.sum ? el("span.ph-sum", {}, x.sum) : null,
          el("span.ph-mean", {}, mean));
      })));
  }).catch(() => wbw.remove());

  // 3 · Wikipedia: the article on the phrase, or the sentence that uses it
  wikiAnswer(t).then(async (r) => {
    if (!alive()) return;
    if (!r || (!r.topic && !r.answer && !r.results?.length)) { wiki.remove(); return; }
    const kids = [wpLabel()];
    let used = null;
    if (r.topic) {
      used = r.topic.title;
      state.topic = firstSentences(r.topic.extract, 1);
      kids.push(el("div.ph-topic", {},
        r.topic.thumb ? el("img.ph-thumb", { src: r.topic.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null,
        el("div", {},
          el("button.ph-topic-title", { type: "button", onclick: () => onArticle(r.topic.title) }, r.topic.title),
          r.topic.description ? el("p.ph-desc", {}, r.topic.description) : null)),
        el("p.ph-extract", {}, tappable(compact ? firstSentences(r.topic.extract, 3) : r.topic.extract, onWord)));
      const factsBox = el("div");
      kids.push(factsBox);
      wikiFacts(r.topic.title).then((f) => { if (alive() && f?.facts?.length) factsBox.replaceWith(el("div.ph-factbox", {}, el("p.ph-sub", {}, "Key facts"), factsTable(f.facts, { limit: compact ? 5 : 12 }))); }).catch(() => {});
      kids.push(el("button.btn.sm.ghost.ph-read", { type: "button", onclick: () => onArticle(r.topic.title) }, icon("book", 14), "Read the whole article"));
      foldWords();
    } else if (r.answer) {
      used = r.answer.title;
      state.answer = r.answer.sentence;
      kids.push(el("blockquote.ph-answer", {}, marked(r.answer.sentence, t)),
        el("p.ph-cite", {}, "— from ", el("button.link", { type: "button", onclick: () => onArticle(r.answer.title) }, `“${r.answer.title}”`),
          r.answer.section ? el("span.muted", {}, ` · ${r.answer.section}`) : null));
    }
    const more = wikiMore ? (r.results || []).filter((x) => x.title !== used).slice(0, compact ? 3 : 5) : [];
    if (!used && !more.length) { wiki.remove(); return; }
    if (more.length) kids.push(el("p.ph-sub", {}, used ? "Also on Wikipedia" : "On Wikipedia"),
      el("ul.ph-more", {}, more.map((x) => el("li", {},
        el("button.ph-more-btn", { type: "button", onclick: () => onArticle(x.title) },
          el("strong", {}, x.title), x.description ? el("span.muted", {}, ` — ${x.description}`) : null)))));
    setKids(wiki, ...kids);
  }).catch(() => {
    if (!alive()) return;
    if (navigator.onLine) wiki.remove();
    else setKids(wiki, wpLabel(), el("p.muted.small", {}, "You're offline — Wikipedia will answer when you're back online."));
  });

  // the best one-line meaning, for saving the phrase to your words
  root.summary = () => state.exact || state.full || (state.together && `${state.together}.${state.answer ? " " + state.answer : ""}`) || state.topic || state.answer || state.words || "";
  return root;
}
