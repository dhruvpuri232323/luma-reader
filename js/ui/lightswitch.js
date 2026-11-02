// The light switch: the Luma logo changes the light you read by — Light,
// Sepia, Dark, Night light (dark with a warm amber glow) or Auto. One tap moves
// to the next; a long press (or right-click) shows them all, with the warmth.
import { el, setKids, isNarrow, bus } from "../core/util.js";
import { store } from "../data/store.js";
import { MODES, currentMode } from "../core/feel.js";
import { closeMenus, toast } from "./overlay.js";
import { icon } from "./icons.js";

/** Move to a mode, with the new light spreading out from where you tapped. */
export async function setMode(id, from) {
  const m = MODES.find((x) => x.id === id) || MODES[0];
  const apply = () => store.setSettings({ theme: m.theme, warm: m.warm });
  const root = document.documentElement;
  if (!document.startViewTransition || root.dataset.motion === "reduce" || !from) { await apply(); return m; }
  const r = from.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  root.classList.add("switching");
  const vt = document.startViewTransition(() => apply());
  vt.ready.then(() => {
    root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
      { duration: 560, easing: "cubic-bezier(.3,.6,.2,1)", pseudoElement: "::view-transition-new(root)" });
  }).catch(() => {});
  vt.finished.finally(() => root.classList.remove("switching"));
  await vt.updateCallbackDone.catch(() => {});
  return m;
}

export async function cycleMode(from) {
  const i = MODES.findIndex((m) => m.id === currentMode());
  const m = await setMode(MODES[(i + 1) % MODES.length].id, from);
  toast(`${m.name} · ${m.note}`, { duration: 2200 });
}

/** All the modes at once, with the warmth of the night light. */
export function lightPopover(anchor) {
  closeMenus();
  document.querySelectorAll(".popover").forEach((p) => p.remove());
  const pop = el("div.menu.popover.light-pop", { role: "dialog", "aria-label": "Light" });
  const draw = () => {
    const s = store.settings();
    const cur = currentMode(s);
    const out = el("span.pop-val", {}, `${Math.round((s.warmth ?? 0.35) * 100)}%`);
    setKids(pop,
      el("div.pop-title", {}, el("strong", {}, "Reading light"), el("button.icon-btn.sm", { "aria-label": "Close", onclick: () => close() }, icon("x", 16))),
      el("div.light-modes", { role: "radiogroup" }, MODES.map((m) => el("button.light-mode" + (cur === m.id ? ".on" : ""), {
        role: "radio", "aria-checked": String(cur === m.id), title: m.note,
        onclick: (e) => setMode(m.id, e.currentTarget),
      }, el("span.light-swatch", { dataset: { mode: m.id } }, el("span.brand-mark.sm", { dataset: { mode: m.id } })), el("span.light-name", {}, m.name)))),
      el("p.light-note", {}, MODES.find((m) => m.id === cur)?.note),
      cur === "night" || cur === "auto" || s.warm !== "off" ? el("label.light-warm", {},
        el("span", {}, "Warmth"),
        el("input", { type: "range", min: 0.1, max: 0.8, step: 0.05, value: s.warmth ?? 0.35, "aria-label": "Warmth of the night light",
          oninput: (e) => { out.textContent = `${Math.round(e.target.value * 100)}%`; document.documentElement.style.setProperty("--warmth", e.target.value); },
          onchange: (e) => store.setSettings({ warmth: Number(e.target.value) }) }), out) : null,
      el("p.muted.small", {}, "Tip: tap the Luma logo to step through these."));
  };
  const off = bus.on("settings", () => pop.isConnected && draw());
  const close = () => { pop.remove(); off(); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", esc); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  const outside = (e) => { if (!pop.contains(e.target) && !e.target.closest(".brand, .light-btn")) close(); };
  draw();
  document.body.append(pop);
  if (isNarrow()) pop.classList.add("sheet");
  else {
    const r = anchor.getBoundingClientRect();
    Object.assign(pop.style, { left: Math.min(r.right + 10, innerWidth - pop.offsetWidth - 8) + "px", top: Math.max(8, Math.min(r.top, innerHeight - pop.offsetHeight - 8)) + "px" });
  }
  requestAnimationFrame(() => pop.classList.add("in"));
  setTimeout(() => { document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", esc); }, 0);
  return pop;
}

/** Tap: next mode. Long press or right-click: all of them. */
export function wireSwitch(btn) {
  let timer = null, long = false;
  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    long = false;
    timer = setTimeout(() => { long = true; lightPopover(btn); }, 520);
  });
  const cancel = () => clearTimeout(timer);
  btn.addEventListener("pointerup", cancel);
  btn.addEventListener("pointerleave", cancel);
  btn.addEventListener("click", (e) => { e.preventDefault(); if (long) { long = false; return; } cycleMode(btn); });
  btn.addEventListener("contextmenu", (e) => { e.preventDefault(); cancel(); lightPopover(btn); });
  const label = () => {
    const cur = MODES.find((m) => m.id === currentMode());
    const next = MODES[(MODES.indexOf(cur) + 1) % MODES.length];
    btn.title = `Light: ${cur.name}. Tap for ${next.name}; hold for all`;
    btn.setAttribute("aria-label", btn.title);
  };
  label();
  bus.on("settings", label);
  return btn;
}
