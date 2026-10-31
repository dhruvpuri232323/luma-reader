// The dictionary card: shown on hover/tap in the reader. Falls back from the
// dictionary to Wiktionary, WordNet and Wikipedia; if nothing knows the word it
// offers close spellings, a Google search and a box to add your own meaning.
import { el, isNarrow, bus, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { lookup, saveWord, wordId, normalizeWord, googleUrl } from "../data/dictionary.js";
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

function render(res) {
  const { word: w, raw, source } = current;
  const entry = res.entry;
  const headword = entry?.word || w;
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

  const head = el("div.def-head", {},
    entry?.thumb ? el("img.def-thumb", { src: entry.thumb, alt: "", referrerpolicy: "no-referrer" }) : null,
    el("div.def-title", {},
      el("h3.def-word", {}, headword),
      entry?.phonetic ? el("span.def-phon", {}, entry.phonetic) : null),
    el("div.def-actions", {}, speak, saveBtn,
      el("button.icon-btn.def-close", { "aria-label": "Close", onclick: hideDefinition }, icon("x", 18))));

  const google = el("a.def-google", { href: googleUrl(entry?.source === "wikipedia" ? headword : raw || w), target: "_blank", rel: "noopener" },
    el("span.g-logo", { "aria-hidden": "true" }), el("span", {}, "Search Google"));

  let body;
  if (res.status === "ok") {
    const isWiki = entry.source === "wikipedia";
    const baseForm = !isWiki && entry.word && entry.word.toLowerCase() !== w;
    body = el("div.def-body", {},
      baseForm ? el("p.def-base.muted.small", {}, `“${w}” is a form of “${entry.word}”`) : null,
      saved?.customDef ? el("div.def-mine", {}, el("strong", {}, "Your definition"), el("p", {}, saved.customDef)) : null,
      isWiki
        ? el("section.def-sense", {},
            el("p.def-pos", {}, entry.meanings[0].pos),
            el("p.def-extract", {}, entry.meanings[0].defs[0].d))
        : entry.meanings.slice(0, 4).map((m) =>
            el("section.def-sense", {},
              m.pos ? el("p.def-pos", {}, m.pos) : null,
              el("ol", {}, m.defs.slice(0, 3).map((d) => el("li", {}, d.d, d.ex ? el("q.def-ex", {}, d.ex) : null))),
              m.synonyms?.length ? el("p.def-rel", {}, el("span", {}, "Similar"), " ", m.synonyms.slice(0, 6).join(", ")) : null,
              m.antonyms?.length ? el("p.def-rel", {}, el("span", {}, "Opposite"), " ", m.antonyms.slice(0, 4).join(", ")) : null)),
      entry.wiki ? el("details.def-wiki", {},
        el("summary", {}, `Also: ${entry.wiki.title} on Wikipedia`),
        el("p", {}, entry.wiki.extract)) : null);
    const foot = el("div.def-foot", {},
      el("span.def-src", {}, `From ${SOURCE_LABEL[entry.source] || "dictionary"}`, res.cached ? " · works offline" : ""),
      entry.sourceUrl ? el("a.def-more", { href: entry.sourceUrl, target: "_blank", rel: "noopener" }, "Read more") : null,
      el("span.spacer"), google);
    setKids(card, head, body, foot);
  } else {
    const msg = {
      missing: `“${w}” isn't in the dictionaries yet.`,
      offline: `You're offline and “${w}” hasn't been looked up on this device before.`,
      error: "The dictionaries didn't respond. Try again in a moment.",
    }[res.status];
    const ta = el("textarea.input", { rows: 2, placeholder: "Write the meaning in your own words (or paste it from Google)" });
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
    body = el("div.def-body", {},
      saved?.customDef ? el("div.def-mine", {}, el("strong", {}, "Your definition"), el("p", {}, saved.customDef)) : el("p.muted", {}, msg),
      !saved && res.suggestions?.length ? el("p.def-sugg", {}, "Did you mean ",
        res.suggestions.map((sug, i) => [i ? ", " : "", el("button.link", {
          onclick: () => { const r = current.anchorRect, s = current.source; hideDefinition(); showDefinition(sug, r, s, { sticky: true }); },
        }, sug)]), "?") : null,
      google,
      own);
    setKids(card, head, body);
    card.classList.add("sticky"); // stays open while you type
  }
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
