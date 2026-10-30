// The dictionary card: shown on hover/tap in the reader, and reused in the
// vocabulary view.
import { el, isNarrow, bus, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { lookup, saveWord, wordId, normalizeWord } from "../data/dictionary.js";
import { speech, cue } from "../core/feel.js";
import { icon } from "./icons.js";
import { toast } from "./overlay.js";

let card = null;
let current = null; // { word, anchorRect, source }
let hideTimer = null;
let seq = 0;

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
 * Show a definition for `word` near `anchorRect` (DOMRect). `source` is
 * { docId, title, page, context } used when saving.
 */
export async function showDefinition(word, anchorRect, source, { sticky = false } = {}) {
  const w = normalizeWord(word);
  if (!w || w.length < 2 || /^\d+$/.test(w)) return;
  if (current?.word === w && card) { cancelHide(); return; }
  const my = ++seq;
  hideDefinition();
  current = { word: w, anchorRect, source };
  card = el("div.defcard" + (sticky || isNarrow() ? ".sticky" : ""), { role: "dialog", "aria-label": `Definition of ${w}` });
  card.addEventListener("pointerenter", cancelHide);
  card.addEventListener("pointerleave", () => { if (!card?.classList.contains("sticky")) scheduleHide(350); });
  document.body.append(card);
  renderLoading(w);
  position(anchorRect);
  requestAnimationFrame(() => card?.classList.add("in"));

  const res = await lookup(w);
  if (my !== seq || !card) return;
  render(w, res, source);
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

function render(w, res, source) {
  const entry = res.entry;
  const id = wordId(entry?.word || w);
  const saved = store.get("words", id);
  const saveBtn = el("button.icon-btn.def-save" + (saved ? ".on" : ""), {
    "aria-label": saved ? "Remove from words" : "Save word",
    title: saved ? "Saved — click to remove" : "Save word",
    onclick: async () => {
      if (store.get("words", id)) {
        await store.remove("words", id);
        cue("remove");
        toast(`Removed “${w}” from your words`);
      } else {
        await saveWord({ word: w, entry, source });
        cue("save");
        toast(`Saved “${entry?.word || w}”`, { action: "Add note", onAction: () => bus.emit("edit-word", id) });
      }
      if (card) render(w, res, source);
    },
  }, icon(saved ? "bookmarkOn" : "bookmark", 18), el("span", {}, saved ? "Saved" : "Save"));

  const speak = speech.supported
    ? el("button.icon-btn", { "aria-label": "Pronounce", title: "Pronounce", onclick: () => playWord(entry?.word || w, entry?.audio) }, icon("speak", 18))
    : null;

  const head = el("div.def-head", {},
    el("div", {},
      el("h3.def-word", {}, entry?.word || w),
      entry?.phonetic ? el("span.def-phon", {}, entry.phonetic) : null),
    el("div.def-actions", {}, speak, saveBtn,
      el("button.icon-btn.def-close", { "aria-label": "Close", onclick: hideDefinition }, icon("x", 18))));

  let body;
  if (res.status === "ok") {
    body = el("div.def-body", {},
      saved?.customDef ? el("div.def-mine", {}, el("strong", {}, "Your definition"), el("p", {}, saved.customDef)) : null,
      entry.meanings.slice(0, 4).map((m) =>
        el("section.def-sense", {},
          el("p.def-pos", {}, m.pos),
          el("ol", {}, m.defs.slice(0, 3).map((d) => el("li", {}, d.d, d.ex ? el("q.def-ex", {}, d.ex) : null))),
          m.synonyms.length ? el("p.def-rel", {}, el("span", {}, "Similar"), " ", m.synonyms.slice(0, 6).join(", ")) : null,
          m.antonyms.length ? el("p.def-rel", {}, el("span", {}, "Opposite"), " ", m.antonyms.slice(0, 4).join(", ")) : null)),
      res.cached ? el("p.def-foot", {}, "Saved on this device · works offline") : null);
  } else {
    const msg = {
      missing: `No dictionary entry for “${w}”. Save it and write your own definition.`,
      offline: `You're offline and “${w}” hasn't been looked up on this device before.`,
      error: "The dictionary didn't respond. Try again in a moment.",
    }[res.status];
    body = el("div.def-body", {},
      saved?.customDef ? el("div.def-mine", {}, el("strong", {}, "Your definition"), el("p", {}, saved.customDef)) : null,
      el("p.muted", {}, msg));
  }
  setKids(card, head, body);
}

let audioEl;
export function playWord(word, audioUrl) {
  if (audioUrl && navigator.onLine) {
    audioEl ||= new Audio();
    audioEl.src = audioUrl;
    audioEl.play().catch(() => speech.say(word));
  } else {
    speech.say(word);
  }
}

window.addEventListener("resize", () => current && card && position(current.anchorRect));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && card) hideDefinition(); });
