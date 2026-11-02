// "Translate this book": English → your language, or your language (or any other)
// → English. The whole book is translated on the computer, paragraph by paragraph,
// then shown in Book view as the original, the translation, or both side by side.
// The translation syncs, so it can be read on the phone too.
import { el, setKids, isNarrow, bus } from "../core/util.js";
import { icon } from "./icons.js";
import { closeMenus, toast, confirmDialog } from "./overlay.js";
import { navigate } from "./router.js";
import { nativeName, langName, deviceStatus } from "../data/translate.js";
import { bookLanguage, pairFor, savedTranslation, translationJob, translateBook, prepare, forgetTranslation } from "../reader/booktranslate.js";
import { etaText } from "../reader/ocr.js";

const modeKey = (docId) => `luma.tr.${docId}`;
export const savedMode = (docId) => { try { return localStorage.getItem(modeKey(docId)) || "original"; } catch { return "original"; } };

/** Show the book in Book view as its original, the translation, or both. */
export async function setBookTranslation(tab, mode) {
  try { localStorage.setItem(modeKey(tab.docId), mode); } catch {}
  tab.bookLang ||= await bookLanguage(tab.model);
  const pair = pairFor(tab.bookLang);
  const t = mode === "original" ? null : await savedTranslation(tab.docId, pair.to);
  if (tab.mode !== "book") await tab.setMode("book");
  await tab.book?.setTranslation({ mode: t ? mode : "original", map: t?.map || null, from: t?.from || pair.from, to: t?.to || pair.to });
}

/** Start translating the whole book. Call from a tap: the language may need downloading first. */
export function startBookTranslation(tab, pair, { onDownload, onStart } = {}) {
  const ready = prepare(pair.from, pair.to, onDownload); // must start before anything else waits
  return ready.then(async () => {
    const job = translateBook(tab, pair);
    onStart?.(job);
    if (tab.mode !== "book") await tab.setMode("book");
    tab.book?.showTranslating(job);
    const t = await job.promise.catch(() => null); // the reader says what went wrong
    tab.book?.hideTranslating();
    if (t) {
      try { localStorage.setItem(modeKey(tab.docId), "both"); } catch {}
      await tab.book?.setTranslation({ mode: "both", map: t.map, from: t.from, to: t.to });
      toast(`Translated into ${langName(t.to)} — showing both, paragraph by paragraph`);
    }
    return t;
  });
}

export function translatePopover(anchor, tab) {
  if (!tab) return;
  closeMenus();
  document.querySelectorAll(".popover").forEach((p) => p.remove());
  const pop = el("div.menu.popover.tr-pop", { role: "dialog", "aria-label": "Translate this book" });
  const body = el("div.tr-pop-body", {}, el("div.rs-skel", {}, el("span"), el("span.short")));
  const close = () => { pop.remove(); offs.forEach((f) => f()); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", esc); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  const outside = (e) => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
  setKids(pop, el("div.pop-title", {}, el("strong", {}, icon("translate", 16), " Translate this book"), el("button.icon-btn.sm", { "aria-label": "Close", onclick: () => close() }, icon("x", 16))), body);

  let state = null;
  const draw = () => {
    if (!state) return;
    const { pair, saved, job, dev } = state;
    const mode = tab.book?.tr.mode && tab.mode === "book" ? tab.book.tr.mode : savedMode(tab.docId);
    const kids = [
      el("p.tr-pair.big", {}, el("span", {}, nativeName(pair.from)), el("span.tr-arrow", { "aria-hidden": "true" }, "→"), el("span", {}, nativeName(pair.to)),
        el("button.link.small", { type: "button", onclick: () => { close(); navigate("#/settings?page=translation"); } }, "Change language")),
    ];
    if (saved) {
      kids.push(el("div.seg.tr-modes", { role: "group", "aria-label": "Show" },
        [["original", "Original"], ["both", "Both"], ["translation", nativeName(pair.to)]].map(([m, label]) =>
          el("button" + (mode === m ? ".on" : ""), { type: "button", "aria-pressed": String(mode === m), onclick: async () => { await setBookTranslation(tab, m); draw(); } }, label))),
        el("p.muted.small", {}, mode === "both" ? "Each paragraph, then its translation. Tap any word for its meaning." : mode === "translation" ? `Only the ${langName(pair.to)} — Listen reads it in a ${langName(pair.to)} voice.` : "The book as written."),
        el("div.row.wrap", {},
          el("button.link.small", { type: "button", onclick: async () => {
            if (!(await confirmDialog("Remove this translation?", "It will be removed from all your devices. You can translate the book again any time.", { confirm: "Remove", danger: true }))) return;
            await forgetTranslation(tab.docId, pair.to); await setBookTranslation(tab, "original"); refresh();
          } }, "Remove translation")));
    } else if (job) {
      kids.push(el("p", {}, `Translating… ${job.done} of ${job.total || "?"} paragraphs · ${etaText(job.eta())}`),
        el("button.btn.sm", { type: "button", onclick: () => { close(); tab.setMode("book"); } }, icon("openBook", 15), "See the progress"));
    } else if (dev === "none") {
      kids.push(el("p.small", {}, "Whole books are translated on a computer, in Chrome or Edge — on the device, free and offline. Translate this book there and the translation appears here too."),
        el("p.muted.small", {}, "Here: select any passage and tap ", el("strong", {}, "Translate"), "."));
    } else if (dev === "unavailable") {
      kids.push(el("p.small", {}, `This browser can't translate ${langName(pair.from)} → ${langName(pair.to)} on the device.`));
    } else {
      const bar = el("span.ocr-bar-fill");
      const go = el("button.btn.primary.sm", {
        type: "button",
        onclick: () => {
          go.disabled = true;
          const first = dev !== "available";
          if (first) body.append(el("p.small", {}, `Downloading ${langName(pair.from === "en" ? pair.to : pair.from)} for this computer (one time)…`), el("div.ocr-bar", {}, bar));
          startBookTranslation(tab, pair, { onDownload: (x) => { bar.style.width = Math.round(x * 100) + "%"; }, onStart: () => close() }).catch(() => {
            go.disabled = false;
            toast("The translator couldn't start. Try again — the first time, the language needs a moment to download.", { tone: "warn" });
          });
        },
      }, icon("translate", 15), "Translate the whole book");
      kids.push(el("p.small", {}, "Every paragraph is translated whole, on this computer — private, and it works offline. When it's done you can read the original, the translation, or both."),
        go, el("p.muted.small", {}, "Then it syncs: open the book on your phone and the translation is there."));
    }
    setKids(body, ...kids);
  };
  const refresh = async () => {
    tab.bookLang ||= await bookLanguage(tab.model);
    const pair = pairFor(tab.bookLang);
    const [saved, dev] = await Promise.all([savedTranslation(tab.docId, pair.to), deviceStatus(pair.from, pair.to)]);
    state = { pair, saved, job: translationJob(tab.docId, pair.to), dev };
    if (pop.isConnected) draw();
  };
  const offs = [bus.on("tr-progress", (e) => { if (e.docId === tab.docId && state) { state.job = translationJob(tab.docId, e.to); draw(); } }),
    bus.on("tr-done", (e) => { if (e.docId === tab.docId) refresh(); })];
  document.body.append(pop);
  if (isNarrow()) pop.classList.add("sheet");
  else {
    const r = anchor.getBoundingClientRect();
    Object.assign(pop.style, { left: Math.max(8, Math.min(r.left - 160, innerWidth - 340)) + "px", top: Math.min(r.bottom + 8, innerHeight - 300) + "px" });
  }
  requestAnimationFrame(() => pop.classList.add("in"));
  setTimeout(() => { document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", esc); }, 0);
  refresh().catch(() => setKids(body, el("p.muted.small", {}, "This book's text isn't ready yet.")));
  return pop;
}
