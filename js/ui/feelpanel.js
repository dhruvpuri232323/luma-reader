// "Book feel": choose what kind of book this is — hardcover, paperback, pocket
// book, antique, magazine, e-reader — and fine-tune its page turn, sound, paper,
// texture and light. Saved with the book, so it feels the same on every device.
import { el, setKids, isNarrow, bus } from "../core/util.js";
import { store } from "../data/store.js";
import { EDITIONS, TURNS, SPEEDS, STIFFNESS, PAPERS, TEXTURES, LIGHTS, SOUNDS, DESKS, feelFor, setFeel, textureLayers, deskLayers, playTurn, autoEdition } from "../core/bookfeel.js";
import { DESIGNS, ORNAMENT_NAMES, FOLIOS } from "../core/typeset.js";
import { icon } from "./icons.js";
import { closeMenus, toast } from "./overlay.js";

const COVER = { cloth: "hsl(var(--h) 32% 27%)", paper: "hsl(var(--h) 42% 46%)", leather: "hsl(24 42% 21%)", device: "#1E1F22", none: "transparent" };

/** A tiny page in an edition's paper, texture, light and cover. */
export function editionPreview(key, hue = 210) {
  const E = EDITIONS[key];
  const P = PAPERS[E.paper];
  const tex = textureLayers(E.texture, false);
  return el("span.feel-mini", {
    "aria-hidden": "true",
    dataset: { light: E.light, cover: E.cover },
    style: { "--h": hue, "--mini-paper": P.bg, "--mini-tex": tex?.image || "none", "--mini-tex-size": tex?.size || "auto", "--mini-cover": COVER[E.cover] },
  }, el("span.feel-mini-text"));
}

export function feelPopover(anchor, tab) {
  if (!tab) return;
  closeMenus();
  document.querySelectorAll(".popover").forEach((p) => p.remove());
  const pop = el("div.menu.popover.feel-pop", { role: "dialog", "aria-label": "Book feel" });
  let open = localStorage.getItem("luma.feelCustom") === "1";

  const draw = () => {
    const doc = tab.doc;
    if (!doc) return;
    const f = feelFor(doc);
    const own = doc.feel || {};
    const set = (patch) => setFeel(tab.docId, patch);
    const seg = (key, opts, cur) => el("div.seg.small", { role: "group" }, Object.entries(opts).map(([v, l]) =>
      el("button" + (cur === v ? ".on" : ""), { "aria-pressed": String(cur === v), onclick: () => set({ [key]: v }) }, Array.isArray(l) ? l[0] : l)));
    const row = (label, ...kids) => el("div.feel-row", {}, el("span.feel-label", {}, label), el("div.feel-ctl", {}, ...kids));
    const auto = !own.edition;
    const editions = el("div.feel-eds", { role: "radiogroup", "aria-label": "Kind of book" },
      Object.entries(EDITIONS).map(([k, E]) => el("button.feel-ed" + (f.edition === k ? ".on" : ""), {
        role: "radio", "aria-checked": String(f.edition === k), title: E.note,
        onclick: async () => {
          await setFeel(tab.docId, { edition: k, pdfPages: own.pdfPages }, { replace: true });
          const nf = feelFor(tab.doc);
          playTurn(nf.sound, { volume: nf.volume });
        },
      }, editionPreview(k, doc.hue ?? 210), el("span.feel-ed-name", {}, E.name), el("span.feel-ed-note", {}, E.note))));

    const volOut = el("span.pop-val", {}, `${Math.round((f.volume ?? 0.6) * 100)}%`);
    const lightOut = el("span.pop-val", {}, `${Math.round(f.lightK * 100)}%`);
    const custom = el("details.feel-custom", { open, ontoggle: (e) => { open = e.target.open; localStorage.setItem("luma.feelCustom", open ? "1" : "0"); } },
      el("summary", {}, icon("edit", 16), el("span", {}, `Make this ${EDITIONS[f.edition].name.toLowerCase()} your own`)),
      el("p.feel-sec", {}, "Pages"),
      row("Page design", el("select.select.sm", { "aria-label": "Page design", onchange: (e) => set({ design: e.target.value }) },
        Object.entries(DESIGNS).map(([k, D]) => el("option", { value: k, selected: f.design === k }, `${D.name} — ${D.note}`)))),
      row("Columns", el("div.seg.small", { role: "group" }, [["auto", "Design's"], ["1", "One"], ["2", "Two"]].map(([v, l]) => {
        const cur = own.cols == null ? "auto" : String(own.cols);
        return el("button" + (cur === v ? ".on" : ""), { "aria-pressed": String(cur === v), onclick: () => set({ cols: v === "auto" ? null : Number(v) }) }, l);
      }))),
      row("Running heads", el("div.seg.small", { role: "group" }, [["on", "On"], ["off", "Off"]].map(([v, l]) => {
        const cur = own.heads || "on";
        return el("button" + (cur === v ? ".on" : ""), { "aria-pressed": String(cur === v), onclick: () => set({ heads: v === "on" ? null : "off" }) }, l);
      }))),
      row("Page numbers", el("select.select.sm", { "aria-label": "Page numbers", onchange: (e) => set({ folio: e.target.value === "auto" ? null : e.target.value }) },
        Object.entries(FOLIOS).map(([k, l]) => el("option", { value: k, selected: (own.folio || "auto") === k }, l)))),
      row("Drop caps", el("div.seg.small", { role: "group" }, [["auto", "Design's"], ["on", "On"], ["off", "Off"]].map(([v, l]) => {
        const cur = own.drop == null ? "auto" : own.drop ? "on" : "off";
        return el("button" + (cur === v ? ".on" : ""), { "aria-pressed": String(cur === v), onclick: () => set({ drop: v === "auto" ? null : v === "on" }) }, l);
      }))),
      row("Ornament", el("div.seg.small.orn-seg", { role: "group" }, Object.entries(ORNAMENT_NAMES).map(([v, l]) => {
        const cur = own.ornament || "auto";
        return el("button" + (cur === v ? ".on" : ""), { "aria-pressed": String(cur === v), title: v === "auto" ? "The design's own" : l, onclick: () => set({ ornament: v === "auto" ? null : v }) }, v === "auto" ? "Auto" : l);
      }))),
      el("p.feel-sec", {}, "Turning"),
      row("Page turn", seg("turn", TURNS, f.turn)),
      f.turn === "curl" ? row("Paper", el("div.seg.small", { role: "group" }, Object.entries(STIFFNESS).map(([v, l]) => {
        const cur = Object.keys(STIFFNESS).reduce((a, k) => (Math.abs(k - (f.stiffness || 1)) < Math.abs(a - (f.stiffness || 1)) ? k : a), "1");
        return el("button" + (cur === v ? ".on" : ""), { "aria-pressed": String(cur === v), onclick: () => set({ stiffness: Number(v) }) }, l);
      }))) : null,
      row("Speed", seg("speed", SPEEDS, f.speed)),
      row("Sound",
        el("select.select.sm", { "aria-label": "Page-turn sound", onchange: (e) => { set({ sound: e.target.value }); playTurn(e.target.value, { volume: f.volume }); } },
          Object.entries(SOUNDS).map(([v, l]) => el("option", { value: v, selected: (own.sound ?? EDITIONS[f.edition].sound) === v }, l))),
        el("button.icon-btn.sm", { "aria-label": "Hear it", title: "Hear it", onclick: () => playTurn(feelFor(tab.doc).sound === "off" ? "paperback" : feelFor(tab.doc).sound, { volume: f.volume || 0.6 }) }, icon("play", 16)),
        el("input", { type: "range", min: 0, max: 1, step: 0.05, value: f.volume ?? 0.6, "aria-label": "Page-turn volume",
          oninput: (e) => { volOut.textContent = `${Math.round(e.target.value * 100)}%`; },
          onchange: (e) => { set({ volume: Number(e.target.value) }); playTurn(f.sound, { volume: Number(e.target.value) }); } }), volOut),
      store.settings().pageSounds === false ? el("p.feel-hint", {}, "Page-turn sounds are off for every book in Settings → Reading.") : null,
      el("p.feel-sec", {}, "Paper, light and desk"),
      row("Paper", el("div.swatches", {}, Object.entries(PAPERS).map(([k, P]) => el("button.swatch.paper-swatch" + (f.paper === k ? ".on" : ""), {
        style: { "--c": P.bg }, "aria-label": P.name, title: P.name, "aria-pressed": String(f.paper === k), onclick: () => set({ paper: k }),
      })))),
      document.documentElement.dataset.theme === "dark" ? el("p.feel-hint", {}, "Paper colours show in the Light and Sepia themes.") : null,
      row("Texture", seg("texture", TEXTURES, f.texture)),
      row("Light", seg("light", LIGHTS, f.light)),
      f.light !== "none" ? row("Brightness of the light",
        el("input", { type: "range", min: 0.2, max: 1, step: 0.05, value: f.lightK, "aria-label": "Strength of the light",
          oninput: (e) => { lightOut.textContent = `${Math.round(e.target.value * 100)}%`; tab.el.style.setProperty("--light-k", e.target.value); },
          onchange: (e) => set({ lightK: Number(e.target.value) }) }), lightOut) : null,
      row("Desk", el("div.swatches", {}, Object.entries(DESKS).map(([k, name]) => {
        const d = deskLayers(k, false);
        return el("button.swatch.desk-swatch" + (f.desk === k ? ".on" : ""), {
          style: { "--c": d?.color || "var(--stage)", backgroundImage: d ? d.image : "none", backgroundSize: d ? d.size : "auto" },
          "aria-label": name, title: name, "aria-pressed": String(f.desk === k), onclick: () => set({ desk: k }),
        });
      }))),
      row("Cover", seg("cover", { none: "None", paper: "Card", cloth: "Cloth", leather: "Leather", device: "Device" }, f.cover)),
      row("Page edges & cover", el("label.switch", {}, el("input", { type: "checkbox", role: "switch", checked: Boolean(f.edges), onchange: (e) => set({ edges: e.target.checked }) }), el("span.knob"))),
      el("p.feel-hint", {}, "Edges thicken on the left as you read; the cover shows around the pages on wider screens."));

    setKids(pop,
      el("div.pop-title", {},
        el("div", {}, el("strong", {}, "Book feel"), el("span.feel-sub", {}, doc.title)),
        el("button.icon-btn.sm", { "aria-label": "Close", onclick: () => close() }, icon("x", 16))),
      editions,
      auto ? el("p.feel-hint", {}, `Chosen for you: ${doc.kind === "epub" ? "EPUBs" : "this kind of book"} start as ${EDITIONS[autoEdition(doc)].name.toLowerCase()}${store.settings().bookFeel && store.settings().bookFeel !== "auto" ? " (your default)" : ""}. Pick another for this book.`) : null,
      tab.kind === "pdf" ? row("Page view", seg("pdfPages", { scroll: "Scroll", single: "One page", spread: "Two pages" }, f.pdfPages || "scroll")) : null,
      tab.kind === "pdf" && (f.pdfPages || "scroll") === "scroll" ? el("p.feel-hint", {}, "Choose One page or Two pages to turn the original PDF pages like a book.") : null,
      el("div.feel-try", {},
        el("span.muted.small", {}, "Try it"),
        el("button.btn.sm", { onclick: () => tab.prev() }, icon("left", 15), "Back"),
        el("button.btn.sm", { onclick: () => tab.next() }, "Turn a page", icon("right", 15))),
      custom,
      el("div.feel-foot", {},
        own.edition || Object.keys(own).some((k) => k !== "pdfPages") ? el("button.link.small", { onclick: () => setFeel(tab.docId, { pdfPages: own.pdfPages }, { replace: true }) }, "Back to the default") : null,
        el("span.spacer"),
        store.settings().bookFeel !== f.edition ? el("button.btn.sm", {
          title: "Every book you haven't set up yourself will feel like this",
          onclick: async () => { await store.setSettings({ bookFeel: f.edition }); toast(`Books you haven't set up will feel like ${EDITIONS[f.edition].name.toLowerCase()}s`); draw(); },
        }, `Make ${EDITIONS[f.edition].name} the default`) : el("span.muted.small", {}, "Your default for other books")));
  };

  const offDoc = bus.on("change", ({ coll, rec }) => { if (coll === "docs" && rec.id === tab.docId && pop.isConnected) draw(); });
  const offSet = bus.on("settings", () => pop.isConnected && draw());
  const close = () => { pop.remove(); offDoc(); offSet(); document.removeEventListener("pointerdown", out, true); document.removeEventListener("keydown", esc); };
  const out = (e) => { if (!pop.contains(e.target) && !e.target.closest(".menu, .feel-keep")) close(); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  draw();
  document.body.append(pop);
  if (isNarrow()) pop.classList.add("sheet");
  else {
    // sits above the button it came from and grows upwards when "Make it your own" opens
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const above = r.top > innerHeight / 2;
    Object.assign(pop.style, above
      ? { left: Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + "px", top: "auto", bottom: Math.max(8, innerHeight - r.top + 8) + "px", maxHeight: `calc(${Math.round(r.top - 16)}px)` }
      : { left: Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + "px", top: r.bottom + 8 + "px", maxHeight: `calc(100dvh - ${Math.round(r.bottom + 16)}px)` });
    pop.style.transformOrigin = above ? "bottom right" : "top right";
  }
  requestAnimationFrame(() => pop.classList.add("in"));
  setTimeout(() => { document.addEventListener("pointerdown", out, true); document.addEventListener("keydown", esc); }, 0);
  return pop;
}
