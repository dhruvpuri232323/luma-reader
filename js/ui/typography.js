// Reading appearance controls, shared by the reader's "Aa" panel and Settings.
// Every change applies instantly and is shown in a live preview, so you can see
// exactly what Book view will look like.
import { el, bus, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { REFLOW_FONTS, ACCENTS, THEMES } from "../core/feel.js";
import { DESIGNS } from "../core/typeset.js";
import { feelFor } from "../core/bookfeel.js";
import { icon } from "./icons.js";

const PREVIEW = "The lamplighter walked the quiet street at dusk, his ladder balanced on one shoulder. Each lamp he touched grew luminous, and the cobbles shone like wet slate. Critics called the ending ambiguous, yet its perspicacious narrator had warned us from the first chapter.";

/** The theme picker: little pages in each theme's paper and ink. */
export function themeGrid({ compact = false } = {}) {
  const s = store.settings();
  const opts = [["auto", { name: "Auto", note: "Follows your device", paper: "linear-gradient(135deg, #FFFFFF 50%, #1A1E25 50%)", ink: "#7A8391" }], ...Object.entries(THEMES)];
  return el("div.theme-grid" + (compact ? ".compact" : ""), { role: "radiogroup", "aria-label": "Theme" }, opts.map(([k, t]) =>
    el("button.theme-opt" + (s.theme === k ? ".on" : ""), {
      role: "radio", "aria-checked": String(s.theme === k), title: t.note,
      onclick: () => store.setSettings({ theme: k }),
    }, el("span.theme-chip", { style: { background: t.paper, color: t.ink } }, "Aa"), el("span.theme-name", {}, t.name))));
}

export function typographyControls({ preview = true, compact = false, onSwitchToBook, tab = null } = {}) {
  const wrap = el("div.typo" + (compact ? ".compact" : ""));
  const set = (p) => store.setSettings(p);

  const draw = () => {
    const s = store.settings();
    const seg = (key, opts) => el("div.seg.small", { role: "group" }, opts.map(([v, l]) =>
      el("button" + (s[key] === v ? ".on" : ""), { "aria-pressed": String(s[key] === v), onclick: () => set({ [key]: v }) }, l)));
    const range = (key, min, max, step, fmt, label) => {
      const out = el("span.pop-val", {}, fmt(s[key]));
      return el("label.typo-row", {}, el("span.typo-label", {}, label),
        el("button.icon-btn.sm", { "aria-label": `Less ${label.toLowerCase()}`, onclick: (e) => { e.preventDefault(); set({ [key]: Math.max(min, +(s[key] - step).toFixed(2)) }); } }, icon("zoomOut", 16)),
        el("input", { type: "range", min, max, step, value: s[key], "aria-label": label,
          oninput: (e) => { out.textContent = fmt(Number(e.target.value)); },
          onchange: (e) => set({ [key]: Number(e.target.value) }) }),
        el("button.icon-btn.sm", { "aria-label": `More ${label.toLowerCase()}`, onclick: (e) => { e.preventDefault(); set({ [key]: Math.min(max, +(s[key] + step).toFixed(2)) }); } }, icon("zoomIn", 16)),
        out);
    };
    const toggle = (key, label) => el("label.typo-row.switch-row", {}, el("span.typo-label", {}, label),
      el("span.switch", {}, el("input", { type: "checkbox", role: "switch", checked: s[key] !== false, onchange: (e) => set({ [key]: e.target.checked }) }), el("span.knob")));

    setKids(wrap,
      preview ? el("div.typo-preview", {
        style: {
          fontFamily: (s.editionFonts !== false && REFLOW_FONTS[DESIGNS[feelFor(tab?.doc).design]?.face]?.stack) || REFLOW_FONTS[s.reflowFont]?.stack, fontSize: s.reflowSize + "px", lineHeight: s.reflowLeading,
          fontWeight: { medium: 500, bold: 600 }[s.textWeight] || 400, letterSpacing: { tight: "-0.012em", loose: "0.03em" }[s.letterSpacing] || "0", wordSpacing: { tight: "-0.04em", loose: "0.12em" }[s.wordSpacing] || "0",
          hyphens: s.hyphens === false ? "manual" : "auto",
          textAlign: s.justify !== false ? "justify" : "left", maxWidth: { narrow: "27em", balanced: "32em", wide: "40em" }[s.reflowWidth],
        },
      }, el("p", {}, PREVIEW)) : null,
      onSwitchToBook ? el("div.typo-note", {}, icon("openBook", 18),
        el("span", {}, "Fonts and sizes apply to Book view, where the PDF is set as text."),
        el("button.btn.sm.primary", { onclick: onSwitchToBook }, "Open Book view")) : null,
      el("div.typo-group", {},
        el("p.typo-head", {}, "Typeface"),
        el("div.font-grid", {},
          (() => {
            const design = DESIGNS[feelFor(tab?.doc).design] || null;
            const face = design && REFLOW_FONTS[design.face];
            const on = s.editionFonts !== false;
            return el("button.font-opt.edition-font" + (on ? ".on" : ""), { "aria-pressed": String(on), onclick: () => set({ editionFonts: true }), title: "Each kind of book — paperback, antique, magazine… — is set in its own typeface" },
              el("span.font-name", { style: { fontFamily: face?.stack } }, tab && face ? `${design.name}: ${face.name}` : "Each edition's own"),
              compact ? null : el("span.font-note", {}, "The typeface that suits the book"));
          })(),
          Object.entries(REFLOW_FONTS).map(([k, f]) => {
            const on = s.editionFonts === false && s.reflowFont === k;
            return el("button.font-opt" + (on ? ".on" : ""), { "aria-pressed": String(on), onclick: () => set({ reflowFont: k, editionFonts: false }) },
              el("span.font-name", { style: { fontFamily: f.stack } }, f.name),
              compact ? null : el("span.font-note", {}, f.note));
          }))),
      el("div.typo-group", {},
        range("reflowSize", 12, 40, 1, (v) => `${v}px`, "Text size"),
        el("p.typo-tip", {}, "Tip: pinch on your trackpad or screen to change it right on the page."),
        range("reflowLeading", 1.3, 2.2, 0.05, (v) => Number(v).toFixed(2), "Line spacing"),
        el("div.typo-row", {}, el("span.typo-label", {}, "Weight"), seg("textWeight", [["regular", "Regular"], ["medium", "Medium"], ["bold", "Bold"]])),
        el("div.typo-row", {}, el("span.typo-label", {}, "Letters"), seg("letterSpacing", [["tight", "Tight"], ["normal", "Normal"], ["loose", "Airy"]])),
        el("div.typo-row", {}, el("span.typo-label", {}, "Words"), seg("wordSpacing", [["tight", "Tight"], ["normal", "Normal"], ["loose", "Airy"]])),
        el("div.typo-row", {}, el("span.typo-label", {}, "Margins"), seg("reflowWidth", [["wide", "Narrow"], ["balanced", "Normal"], ["narrow", "Wide"]])),
        el("div.typo-row", {}, el("span.typo-label", {}, "Paragraphs"), seg("paraStyle", [["indent", "Indented"], ["spaced", "Spaced"]])),
        el("div.typo-row", {}, el("span.typo-label", {}, "Layout"), seg("bookLayout", [["pages", "Pages"], ["scroll", "Scroll"]])),
        s.bookLayout !== "scroll" ? el("div.typo-row", {}, el("span.typo-label", {}, "Pages"), seg("bookSpread", [["auto", "Two on wide screens"], ["single", "Always one"]])) : null,
        toggle("justify", "Justify text"),
        toggle("hyphens", "Hyphenate long words"),
        toggle("ruler", "Reading ruler"),
        toggle("underlineSaved", "Underline words I've saved")),
      el("div.typo-group", {},
        el("p.typo-head", {}, "Theme"),
        themeGrid({ compact }),
        el("div.typo-row", {}, el("span.typo-label", {}, "Warm light"), seg("warm", [["off", "Off"], ["night", "After 8 pm"], ["on", "Always"]])),
        s.warm !== "off" ? range("warmth", 0.1, 0.8, 0.05, (v) => `${Math.round(v * 100)}%`, "Warmth") : null,
        el("div.typo-row", {}, el("span.typo-label", {}, "Accent"), el("div.swatches", {}, Object.entries(ACCENTS).map(([k, a]) =>
          el("button.swatch" + (s.accent === k ? ".on" : ""), { style: { "--c": a.hex }, "aria-label": a.name, title: a.name, onclick: () => set({ accent: k }) }))))));
  };

  draw();
  const off = bus.on("settings", draw);
  // stop listening once removed from the page
  const mo = new MutationObserver(() => { if (!wrap.isConnected) { off(); mo.disconnect(); } });
  requestAnimationFrame(() => mo.observe(document.body, { childList: true, subtree: true }));
  return wrap;
}
