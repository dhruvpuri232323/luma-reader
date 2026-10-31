// Voices for reading aloud.
//  • Natural: Kokoro, an open neural text-to-speech model that runs on your own
//    device (downloaded once, ~90 MB, then offline). Sounds like a narrator.
//  • Device: the best voice your browser/OS already has, ranked so neural and
//    "Natural/Enhanced/Premium" voices come first and robotic ones last.
import { store } from "../data/store.js";
import { bus } from "./util.js";

export const NATURAL_VOICES = [
  { id: "af_heart", name: "Heart", desc: "Warm, expressive · American" },
  { id: "af_bella", name: "Bella", desc: "Bright, lively · American" },
  { id: "bf_emma", name: "Emma", desc: "Gentle · British" },
  { id: "af_nicole", name: "Nicole", desc: "Soft, close-up · American" },
  { id: "am_michael", name: "Michael", desc: "Calm · American" },
  { id: "am_fenrir", name: "Fenrir", desc: "Deep · American" },
  { id: "bm_george", name: "George", desc: "Classic narrator · British" },
  { id: "bm_fable", name: "Fable", desc: "Storyteller · British" },
];

const KOKORO_URLS = [
  "https://cdn.jsdelivr.net/npm/kokoro-js@1/dist/kokoro.web.js",
  "https://cdn.jsdelivr.net/npm/kokoro-js@1/+esm",
];
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const LS = { engine: "luma.voice.engine", system: "luma.voice.system", natural: "luma.voice.natural", ready: "luma.voice.naturalReady" };

export const prefs = {
  get engine() { return localStorage.getItem(LS.engine) || ""; }, // "" = not chosen yet
  set engine(v) { localStorage.setItem(LS.engine, v); bus.emit("voice-prefs"); },
  get natural() { return localStorage.getItem(LS.natural) || "af_heart"; },
  set natural(v) { localStorage.setItem(LS.natural, v); bus.emit("voice-prefs"); },
  get system() { return localStorage.getItem(LS.system) || ""; },
  set system(v) { localStorage.setItem(LS.system, v); bus.emit("voice-prefs"); },
  get naturalDownloaded() { return localStorage.getItem(LS.ready) === "1"; },
  get rate() { return store.settings().speechRate || 1; },
};

// ───────── Natural (Kokoro) ─────────
const nat = { status: "none", progress: 0, error: "", worker: null, pending: new Map(), seq: 0, loading: null, rtf: [] };

export function naturalState() {
  return { status: nat.status, progress: nat.progress, error: nat.error, downloaded: prefs.naturalDownloaded };
}

export function loadNatural() {
  if (nat.status === "ready") return Promise.resolve();
  if (nat.loading) return nat.loading;
  nat.status = "loading";
  nat.error = "";
  nat.progress = 0;
  bus.emit("voice-state");
  nat.loading = new Promise((resolve, reject) => {
    const fail = (msg) => {
      nat.status = "error";
      nat.error = msg;
      nat.loading = null;
      try { nat.worker?.terminate(); } catch {}
      nat.worker = null;
      bus.emit("voice-state");
      reject(new Error(msg));
    };
    let worker;
    try {
      worker = new Worker(new URL("./tts-worker.js", import.meta.url), { type: "module" });
    } catch (e) {
      fail("This browser can't run the natural voice.");
      return;
    }
    nat.worker = worker;
    const files = new Map();
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        const p = data.p || {};
        if (p.file && p.total) files.set(p.file, [p.loaded || 0, p.total]);
        let l = 0, t = 0;
        files.forEach(([a, b]) => { l += a; t += b; });
        nat.progress = t ? Math.min(0.99, l / t) : nat.progress;
        bus.emit("voice-state");
      } else if (data.type === "ready") {
        nat.status = "ready";
        nat.progress = 1;
        localStorage.setItem(LS.ready, "1");
        bus.emit("voice-state");
        resolve();
      } else if (data.type === "error") {
        fail(navigator.onLine ? "The natural voice couldn't be downloaded. " + (data.error || "") : "You're offline — the natural voice downloads the first time you're online.");
      } else if (data.type === "audio" || data.type === "audio-error") {
        const job = nat.pending.get(data.id);
        if (!job) return;
        nat.pending.delete(data.id);
        if (data.type === "audio") {
          const secs = data.pcm.length / data.rate;
          if (secs > 0.5) { nat.rtf.push(data.ms / 1000 / secs); if (nat.rtf.length > 6) nat.rtf.shift(); }
          job.resolve({ pcm: data.pcm, rate: data.rate });
        } else job.reject(new Error(data.error));
      }
    };
    worker.onerror = (e) => fail("The natural voice stopped: " + (e.message || "worker error"));
    worker.postMessage({ type: "load", urls: window.__LUMA_KOKORO_URLS__ || KOKORO_URLS, model: MODEL, dtype: "q8", device: "wasm" });
  });
  return nat.loading;
}

/** Real-time factor: generation time ÷ audio length (lower is better; > 1 means slower than speech). */
export const naturalSpeed = () => (nat.rtf.length ? nat.rtf.reduce((a, b) => a + b, 0) / nat.rtf.length : 0);

export function synthNatural(text, voiceId = prefs.natural, speed = prefs.rate) {
  if (nat.status !== "ready" || !nat.worker) return Promise.reject(new Error("not ready"));
  const id = ++nat.seq;
  const p = new Promise((resolve, reject) => nat.pending.set(id, { resolve, reject }));
  p.jobId = id;
  nat.worker.postMessage({ type: "say", id, text, voice: voiceId, speed: Math.max(0.5, Math.min(2, speed)) });
  return p;
}

export function cancelNatural(promises) {
  const ids = promises.map((p) => p?.jobId).filter(Boolean);
  if (!ids.length || !nat.worker) return;
  nat.worker.postMessage({ type: "cancel", ids });
  ids.forEach((id) => { nat.pending.get(id)?.reject(new Error("cancelled")); nat.pending.delete(id); });
}

// ───────── audio output ─────────
let ctx = null;
const playing = new Set();

export function unlockAudio() {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
  } catch { /* no audio */ }
}

export function playPcm({ pcm, rate }) {
  unlockAudio();
  const buf = ctx.createBuffer(1, pcm.length, rate);
  buf.copyToChannel(pcm, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const t0 = ctx.currentTime;
  let stop;
  const done = new Promise((resolve) => {
    src.onended = () => { playing.delete(handle); resolve(); };
    stop = () => { try { src.stop(); } catch {} resolve(); };
  });
  const handle = { stop };
  playing.add(handle);
  src.start();
  return { done, stop: () => handle.stop(), elapsed: () => ctx.currentTime - t0, duration: pcm.length / rate };
}

/** 16-bit mono WAV from Float32 samples. */
export function encodeWav(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + total * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, total * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 0x7fff, true);
  return new Blob([buf], { type: "audio/wav" });
}

// Phones pause web pages when the screen locks. A near-silent media track keeps
// the reading session alive in the background and puts play/pause on the lock
// screen and in the notification shade.
let keeper = null;
export function keepAlive(on) {
  try {
    if (on) {
      if (!keeper) {
        const rate = 8000, n = rate * 6, pcm = new Float32Array(n);
        for (let i = 0; i < n; i++) pcm[i] = (Math.random() - 0.5) * 0.00012;
        keeper = new Audio(URL.createObjectURL(encodeWav([pcm], rate)));
        keeper.loop = true;
        keeper.setAttribute("playsinline", "");
      }
      keeper.play().catch(() => {});
    } else keeper?.pause();
  } catch { /* not supported */ }
}

// ───────── Device voices ─────────
const BAD = /espeak|compact|eloquence|zarvox|whisper|bad news|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|bahh|albert|fred|junior|ralph|kathy|grandma|grandpa|rocko|shelley|\bflo\b|\breed\b|sandy|wobble/i;

function score(v) {
  const n = v.name.toLowerCase();
  const lang = (v.lang || "").toLowerCase().replace("_", "-");
  const mine = (navigator.language || "en-US").toLowerCase();
  let s = 0;
  if (!lang.startsWith("en")) s -= 200;
  if (/natural|neural/.test(n)) s += 70;
  if (/premium|enhanced|siri/.test(n)) s += 50;
  if (/online/.test(n)) s += 15;
  if (/google/.test(n)) s += 35;
  if (/microsoft/.test(n) && !/natural|online/.test(n)) s -= 10;
  if (BAD.test(n)) s -= 120;
  if (lang === mine) s += 10;
  if (lang === "en-us" || lang === "en-gb") s += 5;
  if (lang === "en-in") s += 6;
  if (v.default) s += 1;
  return s;
}

export function systemVoices() {
  if (!("speechSynthesis" in window)) return [];
  return speechSynthesis.getVoices()
    .filter((v) => (v.lang || "").toLowerCase().startsWith("en"))
    .map((v) => ({ v, id: v.voiceURI, name: v.name.replace(/^(Microsoft|Google)\s+/i, "").replace(/\s*-\s*English.*$/i, ""), lang: v.lang, score: score(v), natural: /natural|neural|premium|enhanced/i.test(v.name) }))
    .sort((a, b) => b.score - a.score);
}

export function voicesReady() {
  if (!("speechSynthesis" in window)) return Promise.resolve([]);
  if (speechSynthesis.getVoices().length) return Promise.resolve(systemVoices());
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(systemVoices()), 1500);
    speechSynthesis.addEventListener("voiceschanged", () => { clearTimeout(t); resolve(systemVoices()); }, { once: true });
  });
}

export function currentSystemVoice() {
  const list = systemVoices();
  return list.find((x) => x.id === prefs.system) || list[0] || null;
}

const keep = new Set(); // Chrome drops utterances that aren't referenced → onend never fires

export function speakSystem(text, { rate = prefs.rate, voiceId, pitch = 1, onBoundary } = {}) {
  if (!("speechSynthesis" in window)) return { done: Promise.resolve(false), stop() {} };
  const u = new SpeechSynthesisUtterance(text);
  const v = (voiceId && systemVoices().find((x) => x.id === voiceId)) || currentSystemVoice();
  if (v) { u.voice = v.v; u.lang = v.v.lang; }
  u.rate = rate;
  u.pitch = Math.max(0.5, Math.min(1.6, pitch));
  if (onBoundary) u.onboundary = (e) => { if (e.name !== "sentence") onBoundary(e.charIndex); };
  const t0 = performance.now();
  keep.add(u);
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  u.onend = () => { keep.delete(u); resolveDone(true); };
  u.onerror = () => { keep.delete(u); resolveDone(false); };
  speechSynthesis.resume();
  speechSynthesis.speak(u);
  return { done, stop: () => { speechSynthesis.cancel(); keep.delete(u); resolveDone(false); }, elapsed: () => (performance.now() - t0) / 1000 };
}

export function stopAll() {
  playing.forEach((h) => h.stop());
  playing.clear();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

/** Say a single word or short phrase with the best voice available right now. */
export async function speakOnce(text) {
  stopAll();
  if (prefs.engine === "natural" && nat.status === "ready") {
    try { return await playPcm(await synthNatural(text)).done; } catch { /* fall through */ }
  }
  return speakSystem(text, { rate: 0.95 }).done;
}

export const SAMPLE = "Each lamp he touched grew luminous, and the cobbles shone like wet slate.";

export async function preview({ engine, id }) {
  stopAll();
  unlockAudio();
  if (engine === "natural") {
    await loadNatural();
    return playPcm(await synthNatural(SAMPLE, id)).done;
  }
  return speakSystem(SAMPLE, { voiceId: id }).done;
}
