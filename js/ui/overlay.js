// Toasts, dialogs and pop-up menus.
import { el } from "../core/util.js";
import { icon } from "./icons.js";

let toastHost;
export function toast(message, { action, onAction, duration = 3200, tone } = {}) {
  toastHost ||= document.body.appendChild(el("div.toasts", { role: "status", "aria-live": "polite" }));
  const t = el("div.toast" + (tone ? "." + tone : ""), {}, el("span", {}, message));
  if (action) {
    t.append(el("button.toast-action", { onclick: () => { onAction?.(); close(); } }, action));
  }
  toastHost.append(t);
  requestAnimationFrame(() => t.classList.add("in"));
  const close = () => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); };
  setTimeout(close, duration);
  return close;
}

/** Generic modal dialog. Resolves with whatever `done(value)` receives. */
export function dialog({ title, body, actions = [], className = "", dismissable = true }) {
  return new Promise((resolve) => {
    const dlg = el("dialog.dialog" + (className ? "." + className : ""));
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const head = el("header.dialog-head", {}, el("h2", {}, title),
      dismissable ? el("button.icon-btn", { onclick: () => done(null), "aria-label": "Close" }, icon("x")) : null);
    const content = el("div.dialog-body");
    dlg.append(content);
    const foot = actions.length
      ? el("footer.dialog-foot", {}, actions.map((a) =>
          el("button.btn" + (a.primary ? ".primary" : "") + (a.danger ? ".danger" : ""), {
            onclick: () => done(typeof a.value === "function" ? a.value(content) : a.value),
          }, a.label)))
      : null;
    dlg.prepend(head);
    if (foot) dlg.append(foot);
    if (typeof body === "function") body(content, done);
    else if (body) content.append(body);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); if (dismissable) done(null); });
    dlg.addEventListener("click", (e) => { if (e.target === dlg && dismissable) done(null); });
    document.body.append(dlg);
    dlg.showModal();
    const first = content.querySelector("input, textarea, select") || dlg.querySelector(".btn.primary");
    first?.focus();
  });
}

export function confirmDialog(title, message, { confirm = "Confirm", danger = false } = {}) {
  return dialog({
    title,
    body: el("p.muted", {}, message),
    actions: [
      { label: "Cancel", value: false },
      { label: confirm, value: true, primary: !danger, danger },
    ],
  });
}

export function promptDialog(title, { label, value = "", placeholder = "", confirm = "Save", multiline = false } = {}) {
  return dialog({
    title,
    body: (c, done) => {
      const input = multiline
        ? el("textarea.input", { rows: 5, placeholder })
        : el("input.input", { type: "text", placeholder });
      input.value = value;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); done(input.value); }
      });
      c.append(el("label.field", {}, label ? el("span", {}, label) : null, input));
    },
    actions: [
      { label: "Cancel", value: null },
      { label: confirm, primary: true, value: (c) => c.querySelector("input, textarea").value },
    ],
  });
}

/** Anchored pop-up menu. items: [{label, icon, onClick, danger, checked}] or "-" */
export function menu(anchor, items, { align = "end" } = {}) {
  closeMenus();
  const m = el("div.menu", { role: "menu" });
  for (const it of items) {
    if (it === "-") { m.append(el("div.menu-sep")); continue; }
    if (!it) continue;
    if (it.heading) { m.append(el("p.menu-head", {}, it.heading)); continue; }
    m.append(el("button.menu-item" + (it.danger ? ".danger" : ""), {
      role: "menuitem",
      onclick: (e) => { e.stopPropagation(); closeMenus(); it.onClick?.(); },
    }, it.icon ? icon(it.icon, 18) : el("span.ic"), el("span", {}, it.label), it.checked ? icon("check", 16) : null));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = align === "end" ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  let top = r.bottom + 6;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  Object.assign(m.style, { left: left + "px", top: top + "px" });
  requestAnimationFrame(() => m.classList.add("in"));
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  function outside(e) { if (!m.contains(e.target)) closeMenus(); }
  m._cleanup = () => document.removeEventListener("pointerdown", outside, true);
  m.querySelector("button")?.focus({ preventScroll: true });
  m.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenus(); anchor.focus(); } });
  return m;
}

export function closeMenus() {
  document.querySelectorAll(".menu").forEach((m) => { m._cleanup?.(); m.remove(); });
}
