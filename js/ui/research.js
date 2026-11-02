// "Look it up": answers from the free web inside the app, so a question doesn't
// send you off to a browser. Wikipedia articles (with pictures, readable right
// here), the dictionary, and what's in your own books and notes. Google is still
// one tap away for anything else — in a side window on laptops.
import { el, setKids, isNarrow } from "../core/util.js";
import { store } from "../data/store.js";
import { lookup, saveWord, wordId } from "../data/dictionary.js";
import { searchBooks, searchNotes } from "../data/fulltext.js";
import { navigate } from "./router.js";
import { renderStory } from "./wordstory.js";
import { wikiSearch, wikiArticle, wikiFacts, wikiMedia, wikiRelated } from "../data/wiki.js";
import { phraseBody, fullFormBlock, factsTable } from "./phrasecard.js";
import { isPhrase } from "../data/phrases.js";
import { isAbbreviation } from "../data/abbrev.js";
import { cue } from "../core/feel.js";
import { speakOnce } from "../core/voice.js";
import { icon } from "./icons.js";
import { toast } from "./overlay.js";

const RECENT = "luma.lookups";

let panel = null;
let state = null; // { query, context, source, view: "results" | "article" | "story", article, seq }

export { wikiSearch, wikiArticle };

// ───────── the panel ─────────

export const isResearchOpen = () => Boolean(panel);

export function closeResearch() {
  if (!panel) return;
  const p = panel;
  panel = null;
  state = null;
  p.classList.remove("in");
  setTimeout(() => p.remove(), 200);
  document.documentElement.classList.remove("researching");
}

/**
 * Open the look-up panel. `query` may be empty (just a search box).
 * `source` = { docId, title, page, context } — where the words came from, for saving.
 */
export function openResearch(query = "", { source = null, article = null, story = null } = {}) {
  const q = String(query || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!panel) {
    panel = el("aside.research", { role: "dialog", "aria-label": "Look it up" });
    document.body.append(panel);
    requestAnimationFrame(() => panel?.classList.add("in"));
    document.documentElement.classList.add("researching");
  }
  state = { query: q, source, view: story ? "story" : "results", story, article: null, seq: (state?.seq || 0) + 1, scroll: 0 };
  render();
  if (q) remember(q);
  else panel.querySelector(".rs-input")?.focus({ preventScroll: true });
  if (article) openArticle(article);
}

function remember(q) {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(RECENT) || "[]"); } catch {}
  list = [q, ...list.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 10);
  try { localStorage.setItem(RECENT, JSON.stringify(list)); } catch {}
}

function recent() {
  try { return JSON.parse(localStorage.getItem(RECENT) || "[]"); } catch { return []; }
}

function header() {
  const input = el("input.input.rs-input", {
    type: "search", value: state.query, placeholder: "Look up a word, a name, an idea…", "aria-label": "Look something up",
    enterkeyhint: "search", autocomplete: "off", spellcheck: false,
  });
  const form = el("form.rs-search", {
    role: "search",
    onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) openResearch(v, { source: state.source }); input.blur(); },
  }, icon("search", 17), input);
  return el("header.rs-head", {},
    state.view === "article" || state.view === "story"
      ? el("button.icon-btn", { "aria-label": "Back to results", title: "Back to results", onclick: backToResults }, icon("back", 19))
      : null,
    form,
    el("button.icon-btn", { "aria-label": "Close", title: "Close (Esc)", onclick: closeResearch }, icon("x", 19)));
}

function backToResults() {
  if (!state) return;
  state.view = "results";
  state.article = null;
  render();
  requestAnimationFrame(() => { const b = panel?.querySelector(".rs-body"); if (b) b.scrollTop = state.scroll || 0; });
}

function render() {
  if (!panel || !state) return;
  const body = el("div.rs-body");
  setKids(panel, header(), body);
  if (state.view === "story") {
    const seq = state.seq, word = state.story;
    renderStory(body, word, { alive: () => panel && state && state.seq === seq && state.view === "story", onWord: (w) => openResearch(w, { source: state.source, story: w }) });
  } else if (state.view === "article") renderArticle(body, state.article);
  else if (!state.query) renderStart(body);
  else renderResults(body);
}

function renderStart(body) {
  const list = recent();
  body.append(
    el("p.rs-intro", {}, "Look up anything without leaving your book: Wikipedia articles, the dictionary, and what's in your own books and notes."),
    list.length ? el("section.rs-sec", {},
      el("h3.rs-label", {}, "Recent"),
      el("div.chips", {}, list.map((x) => el("button.chip", { onclick: () => openResearch(x, { source: state.source }) }, x)))) : null,
    el("p.muted.small.rs-tip", {}, "Tip: select words in a book and choose ", el("strong", {}, "Look up"), ", or press ", el("kbd", {}, "K"), "."));
}

const words = (q) => q.split(/\s+/).filter(Boolean).length;

function renderResults(body) {
  const { query: q, seq } = state;
  const live = () => panel && state && state.seq === seq && state.view === "results";
  const meaningBox = el("div");
  const wikiBox = el("section.rs-sec", { "aria-label": "From Wikipedia" },
    el("h3.rs-label", {}, el("span.wp-logo", { "aria-hidden": "true" }, "W"), "Wikipedia"),
    el("div.rs-skel", {}, el("span"), el("span"), el("span.short")));
  const booksBox = el("div");
  const notesBox = el("div");
  body.append(meaningBox, wikiBox, booksBox, notesBox, webFooter(q));

  // 1 · what it means: a phrase as a whole and word by word, a word in the dictionary, an abbreviation's full form
  const onWord = (w) => openResearch(w, { source: state.source });
  if (isPhrase(q)) {
    meaningBox.replaceWith(el("section.rs-sec.rs-phrase", { "aria-label": "Meaning" },
      el("div.rs-mean-head", {}, el("h3.rs-word", {}, q),
        el("button.icon-btn", { "aria-label": "Pronounce", title: "Pronounce", onclick: () => speakOnce(q) }, icon("speak", 18))),
      phraseBody(q, { docId: state.source?.docId, onWord, onArticle: openArticle, alive: live, compact: false, wikiMore: false })));
  } else if (/\p{L}/u.test(q)) {
    const fullBox = isAbbreviation(q) ? fullFormBlock(q, { docId: state.source?.docId, onWord, onArticle: openArticle, alive: live }) : null;
    if (fullBox) { const holder = el("section.rs-sec.rs-full", {}, fullBox); meaningBox.before(holder); }
    lookup(q).then((res) => {
      if (!live() || res.status !== "ok" || res.entry.source === "wikipedia") return;
      meaningBox.replaceWith(meaningCard(res.entry, q));
    }).catch(() => {});
  }

  // 2 · Wikipedia
  wikiSearch(q).then((list) => {
    if (!live()) return;
    if (!list.length) { setKids(wikiBox, wikiBox.firstChild, el("p.muted.small", {}, `No Wikipedia article matches “${q}”.`)); return; }
    setKids(wikiBox, wikiBox.firstChild, el("ul.rs-list", {}, list.map((r, i) => el("li", {},
      el("button.rs-hit" + (i === 0 ? ".top" : ""), { onclick: () => openArticle(r.title) },
        r.thumb ? el("img.rs-thumb", { src: r.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : el("span.rs-thumb.blank", { "aria-hidden": "true" }, r.title[0]),
        el("span.rs-hit-main", {},
          el("span.rs-title", {}, r.title),
          r.description ? el("span.rs-desc", {}, r.description) : null,
          r.extract && i < 3 ? el("span.rs-extract", {}, r.extract) : null))))));
  }).catch(() => {
    if (!live()) return;
    setKids(wikiBox, wikiBox.firstChild, navigator.onLine
      ? el("p.muted.small", {}, "Wikipedia didn't answer. ", el("button.link", { onclick: () => openResearch(q, { source: state.source }) }, "Try again"))
      : el("p.muted.small", {}, "You're offline — Wikipedia results will appear when you're back online. Here's what's in your own books and notes."));
  });

  // 3 · your books and notes (on this device, works offline)
  searchBooks(q, { perDoc: 2, maxDocs: 4 }).then((found) => {
    if (!live() || !found.length) return;
    booksBox.replaceWith(el("section.rs-sec", { "aria-label": "In your books" },
      el("h3.rs-label", {}, icon("library", 15), "In your books"),
      el("ul.rs-list", {}, found.flatMap(({ doc, hits, total }) => hits.slice(0, 2).map((h, k) => el("li", {},
        el("button.rs-hit.small", { onclick: () => openInBook(doc.id, h.page, q) },
          el("span.rs-hit-main", {},
            el("span.rs-title.sm", {}, doc.title, el("span.muted", {}, ` · p. ${h.page}${k === 0 && total > 2 ? ` · ${total} mentions` : ""}`)),
            el("span.rs-extract", {}, "…" + h.before, el("mark", {}, h.match), h.after + "…")))))))));
  }).catch(() => {});
  const notes = searchNotes(q).slice(0, 4);
  if (notes.length) {
    notesBox.replaceWith(el("section.rs-sec", { "aria-label": "In your notes" },
      el("h3.rs-label", {}, icon("note", 15), "In your notes"),
      el("ul.rs-list", {}, notes.map(({ ann, doc }) => el("li", {},
        el("button.rs-hit.small", { onclick: () => { closeResearch(); navigate(`#/read/${doc.id}/${ann.page}`); } },
          el("span.rs-hit-main", {},
            el("span.rs-title.sm", {}, doc.title, el("span.muted", {}, ` · p. ${ann.page}`)),
            el("span.rs-extract", {}, ann.text),
            ann.note ? el("span.rs-note", {}, ann.note) : null)))))));
  }
}

function meaningCard(entry, q) {
  const saved = store.get("words", wordId(entry.word || q));
  const save = el("button.btn.sm" + (saved ? ".on" : ""), {
    onclick: async (e) => {
      if (store.get("words", wordId(entry.word || q))) { toast("Already in your words"); return; }
      const rec = await saveWord({ word: q, entry, source: state?.source });
      cue("save");
      toast(`Saved “${rec.word}”`);
      e.currentTarget.classList.add("on");
      setKids(e.currentTarget, icon("check", 15), "Saved");
    },
  }, icon(saved ? "check" : "plus", 15), saved ? "Saved" : "Save word");
  return el("section.rs-sec.rs-meaning", { "aria-label": "Meaning" },
    el("div.rs-mean-head", {},
      el("div", {},
        el("h3.rs-word", {}, entry.word || q),
        entry.phonetic ? el("span.rs-phon", {}, entry.phonetic) : null),
      el("div.row", {},
        el("button.icon-btn", { "aria-label": "Pronounce", title: "Pronounce", onclick: () => speakOnce(entry.word || q) }, icon("speak", 18)),
        save)),
    el("button.link.small", { type: "button", onclick: () => openResearch(q, { source: state?.source, story: q }) }, icon("book", 14), " How it's made and where it comes from"),
    entry.meanings.slice(0, 2).map((m) => el("p.rs-def", {}, m.pos ? el("em", {}, m.pos + " ") : null, m.defs[0]?.d || "")));
}

function webFooter(q) {
  return el("footer.rs-web", {},
    el("p.muted.small", {}, "Need the whole web?"),
    el("div.row.wrap", {},
      el("button.btn.sm", { onclick: () => openWeb(`https://www.google.com/search?q=${encodeURIComponent(q)}`) },
        el("span.g-logo", { "aria-hidden": "true" }), "Search Google"),
      el("button.btn.sm.ghost", { onclick: () => openWeb(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`) }, icon("image", 15), "Images")));
}

/** Open a web page in a slim window beside the app on laptops (a normal tab on phones). */
export function openWeb(url) {
  if (!isNarrow() && window.screen?.availWidth > 1000) {
    const w = Math.min(560, Math.round(screen.availWidth * 0.36));
    const h = Math.min(screen.availHeight - 40, Math.max(600, window.outerHeight || 800));
    const left = Math.max(0, (window.screenX || 0) + (window.outerWidth || screen.availWidth) - w);
    const top = Math.max(0, window.screenY || 0);
    const win = window.open(url, "luma-web", `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
    if (win) { try { win.focus(); } catch {} return; }
  }
  window.open(url, "_blank", "noopener");
}

function openInBook(docId, page, q) {
  try { sessionStorage.setItem("luma.find", JSON.stringify({ docId, q })); } catch {}
  closeResearch();
  navigate(`#/read/${docId}/${page}`);
}

async function openArticle(title) {
  if (!state) return;
  state.scroll = panel?.querySelector(".rs-body")?.scrollTop || 0;
  state.view = "article";
  state.article = { title, loading: true };
  render();
  const seq = state.seq;
  let art = null, failed = false;
  try { art = await wikiArticle(title); } catch { failed = true; }
  if (!panel || !state || state.seq !== seq || state.view !== "article") return;
  state.article = art || { title, failed: true, offline: failed && !navigator.onLine };
  render();
}

function renderArticle(body, art) {
  if (art.loading) {
    body.append(el("article.rs-article", {}, el("h2.rs-art-title", {}, art.title), el("div.rs-skel", {}, el("span"), el("span"), el("span"), el("span.short"))));
    return;
  }
  if (art.failed) {
    body.append(el("p.muted.rs-intro", {}, art.offline ? "You're offline and this article hasn't been opened on this device before." : "This article couldn't be loaded. ",
      art.offline ? null : el("button.link", { onclick: () => openArticle(art.title) }, "Try again")));
    return;
  }
  const [lead, ...rest] = art.sections;
  const saved = store.get("words", wordId(art.title));
  const summary = (lead?.paras || []).join(" ");
  const save = el("button.btn.sm" + (saved ? ".on" : ""), {
    title: "Save to your words, with this summary as its meaning",
    onclick: async (e) => {
      if (store.get("words", wordId(art.title))) { toast("Already in your words"); return; }
      const short = summary.length > 600 ? summary.slice(0, summary.lastIndexOf(". ", 600) + 1 || 600) : summary;
      const entry = { word: art.title, asked: art.title, phonetic: "", audio: "", source: "wikipedia", sourceUrl: art.url, thumb: art.thumb,
        meanings: [{ pos: art.description || "encyclopedia", defs: [{ d: short, ex: "" }], synonyms: [], antonyms: [] }] };
      const rec = await saveWord({ word: art.title, entry, source: state?.source });
      cue("save");
      toast(`Saved “${rec.word}” to your words`);
      e.currentTarget.classList.add("on");
      setKids(e.currentTarget, icon("check", 15), "Saved");
    },
  }, icon(saved ? "check" : "plus", 15), saved ? "Saved" : "Save to words");
  const listen = el("button.btn.sm.ghost", { title: "Read the summary aloud", onclick: () => speakOnce(summary.slice(0, 900)) }, icon("speak", 15), "Listen");
  // sections: the top level is folded so long articles stay easy to scan
  const groups = [];
  for (const s of rest) {
    if (s.level <= 2 || !groups.length) groups.push({ head: s, subs: [] });
    else groups[groups.length - 1].subs.push(s);
  }
  const factsSlot = el("div.rs-slot"), gallerySlot = el("div.rs-slot"), relatedSlot = el("div.rs-slot");
  const seq = state.seq;
  const here = () => panel && state && state.seq === seq && state.view === "article";
  body.append(el("article.rs-article", {},
    art.thumb ? el("img.rs-hero", { src: art.thumb, alt: "", referrerpolicy: "no-referrer" }) : null,
    el("h2.rs-art-title", {}, art.title),
    art.description ? el("p.rs-art-desc", {}, art.description) : null,
    el("div.row.wrap.rs-art-actions", {}, save, listen),
    (lead?.paras || []).map((t) => el("p", {}, t)),
    factsSlot, gallerySlot,
    groups.map((g) => el("details.rs-sect", {},
      el("summary", {}, g.head.title),
      g.head.paras.map((t) => el("p", {}, t)),
      g.subs.map((s) => [el("h4", {}, s.title), s.paras.map((t) => el("p", {}, t))]))),
    relatedSlot,
    el("p.rs-credit.muted.small", {}, "From Wikipedia, the free encyclopedia (CC BY-SA). ",
      el("a", { href: art.url, target: "_blank", rel: "noopener" }, "Open on Wikipedia"))));
  // the facts box, the pictures and related articles arrive after the text
  wikiFacts(art.title).then((f) => {
    if (!here() || !f?.facts?.length) return;
    factsSlot.replaceWith(el("section.rs-facts", { "aria-label": "Key facts" },
      el("h3.rs-label", {}, "Key facts"),
      factsTable(f.facts, { limit: 24 })));
  }).catch(() => {});
  wikiMedia(art.title).then((list) => {
    const pics = (list || []).filter((p) => p.src !== art.thumb).slice(0, 12);
    if (!here() || pics.length < 1) return;
    gallerySlot.replaceWith(el("section.rs-gallery", { "aria-label": "Pictures" },
      el("h3.rs-label", {}, icon("image", 15), `Pictures (${pics.length})`),
      el("div.rs-pics", {}, pics.map((p) => el("button.rs-pic", { type: "button", title: p.caption || "Picture", onclick: () => lightbox(p) },
        el("img", { src: p.src, alt: p.caption || "", loading: "lazy", referrerpolicy: "no-referrer" }))))));
  }).catch(() => {});
  wikiRelated(art.title).then((list) => {
    if (!here() || !list?.length) return;
    relatedSlot.replaceWith(el("section.rs-related", { "aria-label": "Related articles" },
      el("h3.rs-label", {}, "Related articles"),
      el("ul.rs-list", {}, list.slice(0, 6).map((r) => el("li", {},
        el("button.rs-hit.small", { onclick: () => openArticle(r.title) },
          r.thumb ? el("img.rs-thumb.sm", { src: r.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : el("span.rs-thumb.sm.blank", { "aria-hidden": "true" }, r.title[0]),
          el("span.rs-hit-main", {}, el("span.rs-title.sm", {}, r.title), r.description ? el("span.rs-desc", {}, r.description) : null)))))));
  }).catch(() => {});
}

/** A picture from the article, large, with its caption. */
function lightbox(p) {
  const dlg = el("dialog.lightbox", { "aria-label": p.caption || "Picture", onclick: () => dlg.close(), onclose: () => dlg.remove() },
    el("img", { src: p.full || p.src, alt: p.caption || "", referrerpolicy: "no-referrer" }),
    p.caption ? el("p", {}, p.caption) : null,
    el("button.icon-btn.lightbox-x", { "aria-label": "Close" }, icon("x", 20)));
  document.body.append(dlg);
  dlg.showModal();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && panel && !document.querySelector("dialog.lightbox[open]")) {
    if (state?.view === "article") backToResults(); else closeResearch();
  }
});
