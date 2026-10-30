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
  newsreader: { name: "Newsreader", stack: '"Newsreader", Georgia, serif' },
  literata: { name: "Literata", stack: '"Literata", "Iowan Old Style", Georgia, serif' },
  atkinson: { name: "Atkinson Hyperlegible", stack: '"Atkinson Hyperlegible", system-ui, sans-serif' },
  lexend: { name: "Lexend", stack: '"Lexend", system-ui, sans-serif' },
  system: { name: "Device font", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
};

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");

export function resolvedTheme(s = store.settings()) {
  return s.theme === "auto" ? (darkQuery.matches ? "dark" : "light") : s.theme;
}

export function applyAppearance() {
  const s = store.settings();
  const root = document.documentElement;
  const theme = resolvedTheme(s);
  root.dataset.theme = theme;
  root.dataset.accent = s.accent;
  root.dataset.motion = s.reduceMotion || motionQuery.matches ? "reduce" : "full";
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg || "#F5F6F8");
  bus.emit("appearance", theme);
}

darkQuery.addEventListener("change", applyAppearance);
motionQuery.addEventListener("change", applyAppearance);
bus.on("settings", applyAppearance);
bus.on("change", ({ coll, source }) => { if (coll === "settings" && source === "remote") applyAppearance(); });

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
