// Appearance (theme, accent, motion), tiny synthesized sound cues and speech.
import { store } from "../data/store.js";
import { bus } from "./util.js";

export const ACCENTS = {
  lamp: { name: "Lamp", hex: "#C98A12" },
  tide: { name: "Tide", hex: "#1C7F86" },
  iris: { name: "Iris", hex: "#5B54D6" },
  fern: { name: "Fern", hex: "#3C8250" },
  ember: { name: "Ember", hex: "#C4472F" },
};

export const REFLOW_FONTS = {
  literata: { name: "Literata", note: "Made for long reading on screens", stack: '"Literata", "Iowan Old Style", Georgia, serif' },
  garamond: { name: "EB Garamond", note: "Classic printed-book feel", stack: '"EB Garamond", Garamond, "Times New Roman", serif' },
  newsreader: { name: "Newsreader", note: "Crisp and editorial", stack: '"Newsreader", Georgia, serif' },
  atkinson: { name: "Atkinson Hyperlegible", note: "Easiest letters to tell apart", stack: '"Atkinson Hyperlegible", system-ui, sans-serif' },
  lexend: { name: "Lexend", note: "Calm, open sans-serif", stack: '"Lexend", system-ui, sans-serif' },
  baskerville: { name: "Libre Baskerville", note: "Stately, like a fine hardback", stack: '"Libre Baskerville", Baskerville, "Baskerville Old Face", Georgia, serif' },
  sourceserif: { name: "Source Serif", note: "Even and modern, magazine-like", stack: '"Source Serif 4", "Source Serif Pro", Georgia, serif' },
  fell: { name: "IM Fell English", note: "Old printed books, inked by hand", stack: '"IM Fell English", "IM FELL English", "EB Garamond", Garamond, serif' },
  dyslexic: { name: "OpenDyslexic", note: "Weighted letters that don't flip or swap", stack: '"OpenDyslexic", "Atkinson Hyperlegible", sans-serif' },
  system: { name: "Device font", note: "Your phone or laptop's own font", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
};

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");

// Reading themes. Each sits on one of the three base themes (light, sepia, dark)
// and gives the app and the page its own colours.
export const THEMES = {
  light: { name: "Light", base: "light", paper: "#FFFFFF", ink: "#1F2328", note: "Bright paper, for daytime" },
  sepia: { name: "Sepia", base: "sepia", paper: "#F7EFDD", ink: "#3A2E21", note: "Warm paper, easy on the eyes" },
  calm: { name: "Calm", base: "sepia", paper: "#EFE6D6", ink: "#4B4034", note: "Soft beige, gentle contrast" },
  sage: { name: "Sage", base: "light", paper: "#EAF1E8", ink: "#1F2D23", note: "Pale green, kind to tired eyes" },
  quiet: { name: "Quiet", base: "light", paper: "#E4E5E3", ink: "#2B2C2E", note: "Soft grey, like a page in the shade" },
  dark: { name: "Dark", base: "dark", paper: "#1A1E25", ink: "#D8DCE2", note: "Light text on a dark page" },
  dusk: { name: "Midnight", base: "dark", paper: "#152036", ink: "#E9E1CB", note: "Deep blue with cream text" },
  espresso: { name: "Espresso", base: "dark", paper: "#231A14", ink: "#EAD9BE", note: "Warm brown, for evenings" },
  black: { name: "True black", base: "dark", paper: "#000000", ink: "#CFCFCF", note: "Pure black, for phones at night" },
};

export function resolvedTheme(s = store.settings()) {
  if (s.theme === "auto") return darkQuery.matches ? "dark" : "light";
  return THEMES[s.theme]?.base || s.theme;
}
/** The named palette on top of the base theme ("" for the plain ones). */
export function paletteOf(s = store.settings()) {
  const t = THEMES[s.theme];
  return t && t.base !== s.theme ? s.theme : "";
}

// The light switch: one tap on the logo moves to the next of these.
export const MODES = [
  { id: "light", name: "Light", theme: "light", warm: "off", note: "Bright paper, for daytime" },
  { id: "sepia", name: "Sepia", theme: "sepia", warm: "off", note: "Warm paper, easy on the eyes" },
  { id: "dark", name: "Dark", theme: "dark", warm: "off", note: "Light text on a dark page" },
  { id: "night", name: "Night light", theme: "dark", warm: "on", note: "Dark with a warm amber glow, for late at night" },
  { id: "auto", name: "Auto", theme: "auto", warm: "night", note: "Follows your device; night light after 8 pm" },
];
export function currentMode(s = store.settings()) {
  if (s.theme === "auto") return "auto";
  if (s.theme === "dark" && s.warm === "on") return "night";
  if (MODES.some((m) => m.id === s.theme)) return s.theme;
  return THEMES[s.theme]?.base === "dark" ? "dark" : THEMES[s.theme]?.base === "sepia" ? "sepia" : "light";
}

export function applyAppearance() {
  const s = store.settings();
  const root = document.documentElement;
  const theme = resolvedTheme(s);
  root.dataset.theme = theme;
  const palette = paletteOf(s);
  if (palette) root.dataset.palette = palette; else delete root.dataset.palette;
  root.dataset.mode = currentMode(s);
  root.dataset.accent = s.accent;
  root.dataset.motion = s.reduceMotion || motionQuery.matches ? "reduce" : "full";
  const h = new Date().getHours();
  root.dataset.warm = s.warm === "on" || (s.warm === "night" && (h >= 20 || h < 7)) ? "1" : "";
  root.style.setProperty("--warmth", String(s.warmth ?? 0.35));
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg || "#F5F6F8");
  bus.emit("appearance", theme);
}

darkQuery.addEventListener("change", applyAppearance);
setInterval(() => { if (store.settings().warm === "night") applyAppearance(); }, 5 * 60 * 1000);
motionQuery.addEventListener("change", applyAppearance);
bus.on("settings", applyAppearance);
bus.on("change", ({ coll, rec, source }) => { if (coll === "settings" && rec?.id === "settings" && source === "remote") applyAppearance(); });

// ── Sound: short sine "glints", generated so there are no audio files ──
let ctx;
const CUES = {
  save: [[880, 0], [1320, 0.07]],
  bookmark: [[660, 0], [990, 0.06]],
  remove: [[520, 0], [390, 0.07]],
  flip: [[740, 0]],
  done: [[660, 0], [880, 0.08], [1175, 0.16]],
};
export function cue(name) {
  if (!store.settings().sounds) return;
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    const t0 = ctx.currentTime;
    for (const [freq, at] of CUES[name] || CUES.flip) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.08, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + at);
      o.stop(t0 + at + 0.25);
    }
  } catch { /* audio unavailable */ }
}

// ── Speech ──
export const speech = {
  get supported() { return "speechSynthesis" in window; },
  get speaking() { return this.supported && speechSynthesis.speaking; },
  say(text, { onend, lang = "en" } = {}) {
    if (!this.supported || !text) return;
    speechSynthesis.cancel();
    // Long text is split into sentences: some engines stop after ~15 s.
    const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    const chunks = [];
    let buf = "";
    for (const p of parts) {
      if ((buf + p).length > 220) { if (buf) chunks.push(buf); buf = p; } else buf += p;
    }
    if (buf.trim()) chunks.push(buf);
    const voice = speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith(lang) && v.localService)
      || speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith(lang));
    chunks.forEach((c, i) => {
      const u = new SpeechSynthesisUtterance(c);
      u.rate = store.settings().speechRate || 1;
      if (voice) u.voice = voice;
      if (i === chunks.length - 1) u.onend = () => onend?.();
      speechSynthesis.speak(u);
    });
  },
  stop() { if (this.supported) speechSynthesis.cancel(); },
};
