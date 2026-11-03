// How a book feels: every book can be a hardcover, a paperback, a pocket book,
// an antique, a magazine or an e-reader — each with its own paper, texture,
// light, page turn and page-turn sound — and any of those can be changed for
// that one book. Sounds are made on the device (no audio files to download).
import { store } from "../data/store.js";
import { resolvedTheme, paletteOf } from "./feel.js";

// ───────── the editions ─────────
export const EDITIONS = {
  modern: { name: "Modern", note: "Clean white pages, a light curl", paper: "white", texture: "none", turn: "curl", sound: "soft", light: "none", lightK: 0.7, edges: false, cover: "none", weight: 0.9, stiffness: 1, design: "modern", desk: "none" },
  paperback: { name: "Paperback", note: "Creamy pages that curl, a soft rustle", paper: "cream", texture: "grain", turn: "curl", sound: "paperback", light: "daylight", lightK: 0.7, edges: true, cover: "paper", weight: 1, stiffness: 0.9, design: "trade", desk: "none" },
  hardcover: { name: "Hardcover", note: "Heavy ivory pages under a reading lamp", paper: "ivory", texture: "laid", turn: "curl", sound: "hardcover", light: "lamp", lightK: 0.75, edges: true, cover: "cloth", weight: 1.15, stiffness: 1.6, design: "fine", desk: "walnut" },
  pocket: { name: "Pocket book", note: "Thin yellowed pages that flick", paper: "pulp", texture: "newsprint", turn: "curl", sound: "pulp", light: "none", lightK: 0.6, edges: true, cover: "paper", weight: 0.8, stiffness: 0.7, design: "pocket", desk: "none" },
  antique: { name: "Antique", note: "An old book, set by hand, by candlelight", paper: "antique", texture: "antique", turn: "curl", sound: "parchment", light: "candle", lightK: 0.45, edges: true, cover: "leather", weight: 1.25, stiffness: 1.3, design: "antique", desk: "walnut" },
  magazine: { name: "Magazine", note: "Bright glossy pages, columns and headlines", paper: "bright", texture: "gloss", turn: "curl", sound: "glossy", light: "window", lightK: 0.6, edges: false, cover: "none", weight: 0.8, stiffness: 0.8, design: "magazine", desk: "none" },
  ereader: { name: "E-reader", note: "Calm grey screen, a gentle flash", paper: "eink", texture: "none", turn: "flash", sound: "off", light: "none", lightK: 0.6, edges: true, cover: "device", weight: 1, stiffness: 1, design: "ereader", desk: "none" },
};

export const TURNS = { curl: "Page curl", flip: "Hard flip", slide: "Slide", fade: "Fade", flash: "E-ink", none: "Instant" };
export const SPEEDS = { quick: ["Quick", 0.7], natural: ["Natural", 1], slow: ["Slow", 1.4] };
export const STIFFNESS = { 0.7: "Soft", 1: "Medium", 1.6: "Stiff" };
const BASE_MS = { flip: 720, curl: 720, slide: 440, fade: 340, flash: 320, none: 0 };

export const PAPERS = {
  white: { name: "White", bg: "#FFFFFF", ink: "#1F2328", tone: null },
  bright: { name: "Bright", bg: "#FCFCFA", ink: "#16191D", tone: null },
  cream: { name: "Cream", bg: "#FBF5E8", ink: "#29241D", tone: "#FBF4E4" },
  ivory: { name: "Ivory", bg: "#F7EFDC", ink: "#2A241B", tone: "#F7EDD6" },
  pulp: { name: "Aged", bg: "#F0E3C4", ink: "#2E281E", tone: "#EFE0BD" },
  parchment: { name: "Parchment", bg: "#ECDAB4", ink: "#36291A", tone: "#EAD5AA" },
  antique: { name: "Old paper", bg: "#F1E6CC", ink: "#2E2217", tone: "#EFE2C4" },
  eink: { name: "Grey", bg: "#E8E8E3", ink: "#232323", tone: "#E6E6E0" },
};

export const TEXTURES = { none: "None", grain: "Fine grain", laid: "Laid", linen: "Linen", newsprint: "Newsprint", antique: "Aged", parchment: "Parchment", gloss: "Gloss" };
export const LIGHTS = { none: "None", daylight: "Daylight", lamp: "Reading lamp", candle: "Candlelight", window: "Window" };

export const SOUNDS = {
  paperback: "Paperback", hardcover: "Hardcover", pulp: "Pocket book", parchment: "Old parchment",
  glossy: "Glossy page", soft: "Soft", click: "Soft click", off: "Off",
};

/** The edition a book gets when nothing has been chosen for it. */
export function autoEdition(doc) {
  if (!doc) return "modern";
  if (doc.kind === "epub") return "paperback";
  if (doc.kind === "text" && /^https?:\/\//.test(doc.source || "")) return "magazine"; // web articles
  return "modern";
}

/** Everything about how this book feels, with the book's own choices on top. */
export function feelFor(doc) {
  const s = store.settings();
  const own = doc?.feel || {};
  let edition = own.edition || s.bookFeel || "auto";
  if (edition === "auto") edition = autoEdition(doc);
  const base = EDITIONS[edition] || EDITIONS.modern;
  const f = { ...base, speed: "natural", volume: 0.6, pdfPages: "scroll" };
  for (const [k, v] of Object.entries(own)) if (v != null && k !== "edition") f[k] = v;
  f.edition = edition;
  // the old one-setting page turn still counts for books you haven't customised
  if (edition === "modern" && own.turn == null && s.pageTurn && s.pageTurn !== "slide") f.turn = s.pageTurn;
  if (document.documentElement.dataset.motion === "reduce" && f.turn !== "none") f.turn = f.turn === "flash" ? "flash" : "fade";
  if (s.pageSounds === false) f.sound = "off";
  f.explicitPaper = Boolean(own.edition || own.paper);
  f.ms = Math.round((BASE_MS[f.turn] ?? 500) * (SPEEDS[f.speed]?.[1] || 1) * (f.weight || 1));
  return f;
}

/** Save a change to this book's feel (synced with the book). */
export async function setFeel(docId, patch, { replace = false } = {}) {
  const doc = store.get("docs", docId);
  if (!doc) return;
  const feel = replace ? { ...patch } : { ...(doc.feel || {}), ...patch };
  for (const k of Object.keys(feel)) if (feel[k] == null) delete feel[k];
  await store.patch("docs", docId, { feel });
}

// ───────── paper textures (drawn on the device as SVG noise) ─────────
const svgUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
function noise({ freq = 0.9, oct = 2, rgb = [0.2, 0.15, 0.1], slope = 1.2, cut = -0.5, size = 220, seed = 7 } = {}) {
  return svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'><filter id='f' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='${oct}' seed='${seed}' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 ${rgb[0]} 0 0 0 0 ${rgb[1]} 0 0 0 0 ${rgb[2]} ${slope} 0 0 0 ${cut}'/></filter><rect width='100%' height='100%' filter='url(#f)'/></svg>`);
}
const texCache = new Map();
/** CSS background layers for a texture: { image, size } (or null for none). */
export function textureLayers(kind, dark = false) {
  const key = kind + (dark ? ":d" : "");
  if (texCache.has(key)) return texCache.get(key);
  const ink = dark ? [1, 1, 1] : [0.22, 0.15, 0.07];
  const line = dark ? "rgb(255 255 255 / .025)" : "rgb(70 50 20 / .045)";
  // alpha = slope × noise + cut: the noise sits around 0.5, so cut ≈ −slope/2 keeps
  // most of the page clean and lets only the faintest flecks through
  const grain = (k = 1, freq = 0.9) => noise({ freq, rgb: ink, slope: 0.55 * k, cut: -0.29 * k - (dark ? 0.04 : 0) });
  let t = null;
  switch (kind) {
    case "grain": t = { image: grain(), size: "220px 220px" }; break;
    case "laid": t = {
      image: [`repeating-linear-gradient(0deg, ${line} 0 1px, transparent 1px 4px)`, `repeating-linear-gradient(90deg, transparent 0 92px, ${line} 92px 94px)`, grain(0.9)].join(", "),
      size: "auto, auto, 220px 220px",
    }; break;
    case "linen": t = {
      image: [`repeating-linear-gradient(0deg, ${line} 0 1px, transparent 1px 3px)`, `repeating-linear-gradient(90deg, ${line} 0 1px, transparent 1px 3px)`, grain(0.8)].join(", "),
      size: "auto, auto, 220px 220px",
    }; break;
    case "newsprint": t = {
      image: [noise({ freq: 0.5, rgb: ink, slope: 2.6, cut: -1.82, seed: 3, size: 260 }), grain(1.2, 0.75)].join(", "),
      size: "260px 260px, 220px 220px",
    }; break;
    case "antique": t = {
      // old paper: it browns towards the edges, has a few faint foxing spots,
      // a gentle unevenness and fine fibres — never blotchy
      image: [
        dark ? "radial-gradient(130% 100% at 50% 46%, transparent 60%, rgb(0 0 0 / .22) 100%)"
          : "radial-gradient(135% 104% at 50% 46%, transparent 58%, rgb(150 100 42 / .10) 80%, rgb(122 76 24 / .24) 100%)",
        "radial-gradient(7px 6px at 13% 88%, rgb(140 88 32 / .16), transparent)",
        "radial-gradient(4px 4px at 84% 11%, rgb(140 88 32 / .15), transparent)",
        "radial-gradient(16px 11px at 71% 79%, rgb(150 100 40 / .06), transparent)",
        "radial-gradient(3px 3px at 33% 21%, rgb(120 76 26 / .16), transparent)",
        "radial-gradient(5px 4px at 61% 34%, rgb(140 92 36 / .08), transparent)",
        noise({ freq: 0.02, oct: 3, rgb: dark ? [1, 0.9, 0.7] : [0.46, 0.3, 0.1], slope: 0.22, cut: dark ? -0.14 : -0.1, size: 520, seed: 5 }),
        grain(1, 0.7),
      ].join(", "),
      size: "100% 100%, 100% 100%, 100% 100%, 100% 100%, 100% 100%, 100% 100%, 520px 520px, 220px 220px",
      size2: "50% 100%, 100% 100%, 100% 100%, 100% 100%, 100% 100%, 100% 100%, 520px 520px, 220px 220px",
    }; break;
    case "parchment": t = {
      image: [
        dark ? "radial-gradient(ellipse at 50% 45%, transparent 55%, rgb(0 0 0 / .25) 100%)" : "radial-gradient(ellipse at 50% 45%, transparent 52%, rgb(120 72 20 / .20) 100%)",
        noise({ freq: 0.007, oct: 4, rgb: dark ? [1, 0.9, 0.7] : [0.5, 0.3, 0.08], slope: 0.75, cut: dark ? -0.47 : -0.41, size: 640, seed: 11 }),
        grain(1.1),
      ].join(", "),
      size: "100% 100%, 640px 640px, 220px 220px",
    }; break;
    case "gloss": t = {
      image: dark
        ? "linear-gradient(118deg, transparent 34%, rgb(255 255 255 / .05) 47%, transparent 58%)"
        : "linear-gradient(118deg, rgb(0 0 0 / .025) 0%, transparent 36%, rgb(255 255 255 / .75) 47%, transparent 57%, rgb(0 0 0 / .02) 100%)",
      size: "100% 100%",
    }; break;
    default: t = null;
  }
  texCache.set(key, t);
  return t;
}

// ───────── desks: what the book lies on ─────────
export const DESKS = { none: "None", walnut: "Walnut", oak: "Oak", linen: "Linen", felt: "Green felt", slate: "Slate" };
const deskCache = new Map();
export function deskLayers(kind, dark = false) {
  const key = kind + (dark ? ":d" : "");
  if (deskCache.has(key)) return deskCache.get(key);
  const vignette = `radial-gradient(130% 110% at 50% 40%, transparent 50%, rgb(0 0 0 / ${dark ? 0.5 : 0.32}) 100%)`;
  const dim = dark ? "linear-gradient(rgb(0 0 0 / .45), rgb(0 0 0 / .45))" : null;
  let d = null;
  const wood = (base, dk, lt, seed) => ({
    color: base,
    image: [vignette, dim,
      noise({ freq: "0.0045 0.16", oct: 3, rgb: dk, slope: 1.1, cut: -0.42, size: 700, seed }),
      noise({ freq: "0.008 0.5", oct: 2, rgb: lt, slope: 0.9, cut: -0.5, size: 700, seed: seed + 7 }),
      noise({ freq: 0.9, oct: 1, rgb: [0, 0, 0], slope: 0.4, cut: -0.24, size: 200, seed: 3 }),
    ].filter(Boolean).join(", "),
    size: [dim ? "100% 100%, 100% 100%" : "100% 100%", "700px 700px", "700px 700px", "200px 200px"].join(", "),
  });
  switch (kind) {
    case "walnut": d = wood("#3B281C", [0.12, 0.06, 0.02], [0.55, 0.38, 0.24], 21); break;
    case "oak": d = wood("#8C6A45", [0.3, 0.18, 0.07], [0.85, 0.7, 0.5], 33); break;
    case "linen": d = {
      color: "#D6CEBE",
      image: [vignette, dim, "repeating-linear-gradient(0deg, rgb(90 70 40 / .07) 0 1px, transparent 1px 3px)", "repeating-linear-gradient(90deg, rgb(90 70 40 / .06) 0 1px, transparent 1px 3px)",
        noise({ freq: 0.5, oct: 2, rgb: [0.3, 0.22, 0.12], slope: 0.7, cut: -0.36, size: 240, seed: 9 })].filter(Boolean).join(", "),
      size: [dim ? "100% 100%, 100% 100%" : "100% 100%", "auto", "auto", "240px 240px"].join(", "),
    }; break;
    case "felt": d = {
      color: "#294A3A",
      image: [vignette, dim, noise({ freq: 0.85, oct: 2, rgb: [0.05, 0.12, 0.08], slope: 0.9, cut: -0.42, size: 220, seed: 4 }),
        noise({ freq: 0.03, oct: 3, rgb: [0.5, 0.75, 0.6], slope: 0.3, cut: -0.14, size: 500, seed: 8 })].filter(Boolean).join(", "),
      size: [dim ? "100% 100%, 100% 100%" : "100% 100%", "220px 220px", "500px 500px"].join(", "),
    }; break;
    case "slate": d = {
      color: "#2C3237",
      image: [vignette, dim, noise({ freq: 0.012, oct: 4, rgb: [0.6, 0.66, 0.7], slope: 0.45, cut: -0.2, size: 600, seed: 12 }),
        noise({ freq: 0.7, oct: 2, rgb: [0, 0, 0], slope: 0.6, cut: -0.32, size: 220, seed: 2 })].filter(Boolean).join(", "),
      size: [dim ? "100% 100%, 100% 100%" : "100% 100%", "600px 600px", "220px 220px"].join(", "),
    }; break;
    default: d = null;
  }
  deskCache.set(key, d);
  return d;
}

const LEATHER = noise({ freq: 0.75, oct: 3, rgb: [0.05, 0.02, 0], slope: 1.1, cut: -0.5, size: 180, seed: 17 });

// ───────── applying it to a reader tab ─────────
const coverOf = (f, doc) => {
  const h = doc?.hue ?? 210;
  return {
    cloth: `hsl(${h} 32% 27%)`, paper: `hsl(${h} 42% 46%)`, leather: "hsl(24 42% 21%)", device: "#1E1F22", none: "transparent",
  }[f.cover] || "transparent";
};

/** Put a book's paper, texture, light and cover onto its reader pane. */
export function applyFeel(tab) {
  const pane = tab?.el;
  if (!pane) return null;
  const f = feelFor(tab.doc);
  const theme = resolvedTheme();
  const dark = theme === "dark";
  const P = PAPERS[f.paper] || PAPERS.white;
  const st = pane.style;
  pane.classList.add("feel");
  pane.dataset.edition = f.edition;
  pane.dataset.light = f.light;
  pane.dataset.texture = f.texture;
  pane.dataset.turn = f.turn;
  pane.dataset.cover = f.cover;
  // the book's paper shows in the light theme (and in sepia when you chose it for this book)
  // a named theme (Sage, Calm, Midnight…) brings its own paper, unless you chose this book's
  const palette = paletteOf();
  const plain = theme === "light" && !palette;
  const usePaper = !dark && f.paper !== "white" && (plain || f.explicitPaper);
  if (usePaper) { st.setProperty("--paper", P.bg); st.setProperty("--paper-ink", P.ink); }
  else { st.removeProperty("--paper"); st.removeProperty("--paper-ink"); }
  // PDF pages: printed on the book's paper in the light theme (dark inverts the page; sepia tints it already)
  const pdfPaper = plain || (!dark && f.explicitPaper);
  const paletteTone = !dark && palette && !f.explicitPaper && theme === "light"; // Sage, Quiet: tint the PDF pages to match
  st.setProperty("--pdf-tone", paletteTone ? "var(--paper)" : (pdfPaper && P.tone) || "#FFFFFF");
  const tex = textureLayers(f.texture, dark);
  if (tex) { st.setProperty("--tex", tex.image); st.setProperty("--tex-size", tex.size); st.setProperty("--tex-size-2", tex.size2 || tex.size); }
  else { st.setProperty("--tex", "none"); st.setProperty("--tex-size", "auto"); st.setProperty("--tex-size-2", "auto"); }
  const desk = deskLayers(f.desk, dark);
  pane.dataset.desk = desk ? f.desk : "none";
  if (desk) { st.setProperty("--desk", desk.image); st.setProperty("--desk-size", desk.size); st.setProperty("--desk-color", desk.color); }
  else { st.removeProperty("--desk"); st.removeProperty("--desk-size"); st.removeProperty("--desk-color"); }
  st.setProperty("--leather-grain", LEATHER);
  const pdfTex = f.texture === "gloss" || !pdfPaper ? null : textureLayers(f.texture, false);
  st.setProperty("--pdf-tex", pdfTex ? pdfTex.image : "none");
  st.setProperty("--pdf-tex-size", pdfTex ? pdfTex.size : "auto");
  st.setProperty("--light-k", String(dark ? f.lightK * 0.6 : f.lightK));
  st.setProperty("--turn-ms", f.ms + "ms");
  st.setProperty("--cover", coverOf(f, tab.doc));
  pane.classList.toggle("feel-edges", Boolean(f.edges));
  pane.classList.toggle("feel-tone", (pdfPaper && Boolean(P.tone)) || Boolean(pdfTex) || paletteTone);
  if (!pane.querySelector(":scope > .feel-light")) pane.append(Object.assign(document.createElement("div"), { className: "feel-light", ariaHidden: "true" }));
  if (f.sound !== "off") warmSound(f.sound);
  return f;
}

// ───────── page-turn sounds, made on the device ─────────
// A page turn is a rustle (filtered noise with a grainy, crackly texture whose
// pitch sweeps as the page moves), then a soft settle as it lands. Each kind of
// paper changes the length, pitch, roughness and weight.
const PROFILES = {
  soft: { dur: 0.2, f: [2300, 3600, 2700], q: 0.7, grain: 0.18, grains: 8, thump: 0, hp: 650, peak: 0.42 },
  paperback: { dur: 0.3, f: [1700, 4100, 2500], q: 0.75, grain: 0.5, grains: 26, thump: 0.22, hp: 320, peak: 0.7 },
  hardcover: { dur: 0.44, f: [1100, 2900, 1700], q: 0.7, grain: 0.36, grains: 30, thump: 0.55, hp: 140, peak: 0.8 },
  pulp: { dur: 0.22, f: [2300, 5300, 3300], q: 0.9, grain: 0.78, grains: 36, thump: 0.12, hp: 480, peak: 0.66 },
  parchment: { dur: 0.56, f: [1300, 3300, 2000], q: 0.85, grain: 0.92, grains: 44, cracks: 9, thump: 0.3, hp: 240, peak: 0.74 },
  glossy: { dur: 0.25, f: [3200, 7200, 4600], q: 0.5, grain: 0.06, grains: 4, thump: 0.08, hp: 1600, peak: 0.46 },
  click: { dur: 0.035, f: [2600, 3200, 2400], q: 1.2, grain: 0, grains: 0, thump: 0.12, hp: 900, peak: 0.35 },
};
const SR = 44100;
const rendered = new Map(); // profile → Promise<AudioBuffer[]>
let actx = null;
export const soundStats = { played: 0, last: null };

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function renderOne(p, seed) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const len = Math.ceil((p.dur + 0.2) * SR);
  const oc = new OAC(1, len, SR);
  const r = rng(seed);
  const buf = oc.createBuffer(1, len, SR);
  const d = buf.getChannelData(0);
  const grains = [];
  for (let i = 0; i < p.grains; i++) grains.push({ t: Math.pow(r(), 0.85) * p.dur, a: 0.3 + r() * 0.8, w: 0.002 + r() * 0.012 });
  for (let i = 0; i < (p.cracks || 0); i++) grains.push({ t: r() * p.dur, a: 1.4 + r(), w: 0.0004 + r() * 0.0006 });
  const attack = Math.max(0.004, p.dur * 0.25);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let env = t < attack ? Math.pow(t / attack, 1.5) : Math.exp(-(t - attack) / (p.dur * 0.32));
    if (t > p.dur + 0.12) env *= Math.max(0, 1 - (t - p.dur - 0.12) / 0.06);
    let g = 0;
    for (const gr of grains) { const dt = t - gr.t; if (dt >= 0 && dt < gr.w * 6) g += gr.a * Math.exp(-dt / gr.w); }
    d[i] = (r() * 2 - 1) * env * ((1 - p.grain) + p.grain * Math.min(1.8, g));
  }
  const src = oc.createBufferSource();
  src.buffer = buf;
  const bp = oc.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = p.q;
  bp.frequency.setValueAtTime(p.f[0], 0);
  bp.frequency.linearRampToValueAtTime(p.f[1] * (0.9 + r() * 0.2), p.dur * 0.45);
  bp.frequency.linearRampToValueAtTime(p.f[2], p.dur);
  const hp = oc.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = p.hp;
  const air = oc.createBiquadFilter(); // a little open, airy hiss on top
  air.type = "highpass";
  air.frequency.value = 5200;
  const airG = oc.createGain();
  airG.gain.value = 0.12;
  src.connect(bp).connect(hp).connect(oc.destination);
  src.connect(air).connect(airG).connect(oc.destination);
  if (p.thump) {
    // the page settling: a soft, low puff of air
    const t0 = p.dur * 0.9;
    const tb = oc.createBuffer(1, Math.ceil(0.14 * SR), SR);
    const td = tb.getChannelData(0);
    for (let i = 0; i < td.length; i++) td[i] = (r() * 2 - 1) * Math.exp(-(i / SR) / 0.025);
    const ts = oc.createBufferSource();
    ts.buffer = tb;
    const lp = oc.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    const tg = oc.createGain();
    tg.gain.value = p.thump * 2.4;
    ts.connect(lp).connect(tg).connect(oc.destination);
    ts.start(t0);
    const o = oc.createOscillator();
    o.frequency.setValueAtTime(115, t0);
    o.frequency.exponentialRampToValueAtTime(55, t0 + 0.1);
    const og = oc.createGain();
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.exponentialRampToValueAtTime(p.thump * 0.3, t0 + 0.006);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    o.connect(og).connect(oc.destination);
    o.start(t0);
    o.stop(t0 + 0.13);
  }
  src.start(0);
  const out = await oc.startRendering();
  const ch = out.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  if (peak > 0) { const k = p.peak / peak; for (let i = 0; i < ch.length; i++) ch[i] *= k; }
  return out;
}

function variations(kind) {
  const p = PROFILES[kind];
  if (!p) return Promise.resolve([]);
  if (!rendered.has(kind)) {
    const seeds = [11, 23, 37, 51];
    rendered.set(kind, Promise.all(seeds.map((s) => renderOne(p, s + kind.length * 101))).catch((e) => { rendered.delete(kind); throw e; }));
  }
  return rendered.get(kind);
}

/** Make a sound ready ahead of time, when the device is idle. */
export function warmSound(kind) {
  if (!PROFILES[kind] || rendered.has(kind)) return;
  const go = () => variations(kind).catch(() => {});
  if ("requestIdleCallback" in window) requestIdleCallback(go, { timeout: 1500 }); else setTimeout(go, 200);
}

/** Play a page turn: `dir` 1 forward (sound moves right → left), -1 back. */
export async function playTurn(kind, { dir = 1, volume = 0.6 } = {}) {
  if (!kind || kind === "off" || !PROFILES[kind] || volume <= 0) return;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume().catch(() => {});
    const list = await variations(kind);
    if (!list.length) return;
    const b = list[Math.floor(Math.random() * list.length)];
    const src = actx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = 0.94 + Math.random() * 0.12;
    const g = actx.createGain();
    g.gain.value = Math.min(1, volume) * 1.2;
    let node = src;
    if (actx.createStereoPanner) {
      const pan = actx.createStereoPanner();
      const t = actx.currentTime;
      pan.pan.setValueAtTime(0.3 * dir, t);
      pan.pan.linearRampToValueAtTime(-0.3 * dir, t + b.duration * 0.8);
      node = node.connect(pan);
    }
    node.connect(g).connect(actx.destination);
    src.start();
    soundStats.played++;
    soundStats.last = kind;
  } catch { /* no audio here */ }
}

/** The rendered variations of a sound (for checks and previews). */
export const soundBuffers = (kind) => variations(kind);
