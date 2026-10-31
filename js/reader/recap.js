// "Where was I?" — when you come back to a book after a while, a small card
// reminds you where you are: the chapter, the last lines you read, and your
// latest note, with a one-tap way to hear the last paragraph again.
import { el } from "../core/util.js";
import { store } from "../data/store.js";
import { icon } from "../ui/icons.js";
import { annotationsFor } from "./annotate.js";
import { relTime } from "../core/util.js";

const AWAY = 6 * 3600 * 1000;

export async function maybeRecap(tab, lastOpened, { onListen } = {}) {
  const doc = tab.doc;
  if (!doc || !lastOpened || Date.now() - lastOpened < AWAY) return;
  if (store.settings().recap === false) return;
  const page = doc.lastPage || tab.currentPage();
  if (page <= 1 && !(doc.progress > 0.02)) return;
  const model = tab.model;
  if (!model) return;
  try { await model.ready?.(); } catch { return; }
  // the last few lines before where you stopped
  let paras = [];
  const isText = (b) => b.type === "p" && b.text?.length > 40;
  for (let p = page - 1; p >= Math.max(1, page - 3) && paras.reduce((n, b) => n + b.text.length, 0) < 380; p--) {
    paras = [...(await model.page(p)).filter(isText).slice(-2), ...paras];
  }
  if (!paras.length) paras = (await model.page(page)).filter(isText).slice(0, 1);
  paras = paras.slice(-2);
  const last = paras[paras.length - 1];
  let text = paras.map((b) => b.text).join(" ");
  if (text.length > 360) text = "…" + text.slice(text.length - 360).replace(/^\S*\s/, "");
  const chapter = await model.headingBefore(page).catch(() => "");
  const note = annotationsFor(tab.docId).filter((a) => a.page <= page).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  if (!text && !note) return;
  tab.el.querySelector(".recap")?.remove();
  const close = () => { card.classList.remove("in"); setTimeout(() => card.remove(), 220); };
  const card = el("aside.recap", { role: "note", "aria-label": "Where you left off" },
    el("div.recap-head", {},
      el("span.recap-kicker", {}, `Welcome back · last read ${relTime(lastOpened)}`),
      el("button.icon-btn.sm", { "aria-label": "Close", onclick: close }, icon("x", 16))),
    el("p.recap-where", {}, chapter ? el("strong", {}, chapter) : null, chapter ? " · " : "", `page ${page} of ${tab.pages}`),
    text ? el("p.recap-text", {}, text) : null,
    note ? el("p.recap-note", {}, el("span.muted", {}, "Your last note: "), `“${note.text.slice(0, 120)}${note.text.length > 120 ? "…" : ""}”`, note.note ? ` — ${note.note.slice(0, 100)}` : "") : null,
    el("div.recap-actions", {},
      last && onListen ? el("button.btn.sm", { onclick: () => { close(); onListen({ bid: last.id, offset: 0 }); } }, icon("headphones", 16), "Hear the last paragraph") : null,
      el("button.btn.sm.primary", { onclick: close }, "Keep reading")));
  tab.el.append(card);
  requestAnimationFrame(() => card.classList.add("in"));
  // it gets out of the way once you start reading
  setTimeout(() => {
    const away = () => close();
    tab.el.addEventListener("wheel", away, { once: true, passive: true });
    tab.el.addEventListener("keydown", away, { once: true });
  }, 1500);
  setTimeout(close, 25000);
}
