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
// The model runs in background workers so the page never stutters. Browsers
// give each worker one processor core, so on laptops several workers make
// audio in parallel — the voice stays well ahead of the listener. "Fast" mode
// runs the model on the graphics chip instead (WebGPU), where available.
const nat = { status: "none", progress: 0, error: "", pool: [], queue: [], pending: new Map(), seq: 0, loading: null, rtf: [], mode: "standard" };
const MODES = {
  standard: { dtype: "q8", device: "wasm", size: "about 90 MB" },
  fast: { dtype: "fp32", device: "webgpu", size: "about 330 MB" },
};

export function naturalState() {
  return { status: nat.status, progress: nat.progress, error: nat.error, downloaded: prefs.naturalDownloaded, mode: nat.mode, workers: nat.pool.filter((w) => w.ready).length };
}

/** Is the graphics-chip mode possible on this device? */
export async function fastModeAvailable() {
  try { return Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}
export const naturalMode = () => localStorage.getItem("luma.voice.mode") || "standard";

/** What this computer is: used to give the right advice about the fast voice. */
let infoCache = null;
export async function deviceInfo() {
  if (infoCache) return infoCache;
  const out = { fast: await fastModeAvailable(), arch: "", platform: "", gpu: "" };
  try {
    const h = await navigator.userAgentData?.getHighEntropyValues?.(["architecture", "platform"]);
    out.arch = h?.architecture || "";
    out.platform = h?.platform || navigator.userAgentData?.platform || "";
  } catch {}
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    out.gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "") : "";
  } catch {}
  // Snapdragon (Qualcomm Adreno) laptops run Windows on Arm
  out.snapdragon = /adreno|qualcomm|snapdragon/i.test(out.gpu) || (out.platform === "Windows" && out.arch === "arm");
  // the Intel/AMD build of the browser running on an Arm laptop (slow, emulated)
  out.emulated = out.snapdragon && out.arch === "x86";
  out.edge = /Edg\//.test(navigator.userAgent);
  return (infoCache = out);
}
export const MODE_SIZE = (m) => MODES[m]?.size || "";

/** How many workers this device can comfortably run at once. */
function poolSize(mode) {
  if (mode === "fast") return 1;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 8;
  const phone = matchMedia("(pointer: coarse)").matches && innerWidth < 900;
  let n = Math.max(1, Math.min(cores >= 10 && mem >= 8 ? 4 : 3, Math.floor(cores / 2) - 1));
  if (phone || mem <= 4) n = Math.min(n, 2);
  if (mem <= 2) n = 1;
  return window.__LUMA_TTS_WORKERS__ || n;
}

function spawn(mode, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(new URL("./tts-worker.js", import.meta.url), { type: "module" }); }
    catch { reject(new Error("This browser can't run the natural voice.")); return; }
    const w = { worker, ready: false, busy: null };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") onProgress?.(data.p || {});
      else if (data.type === "ready") { w.ready = true; resolve(w); }
      else if (data.type === "error") { try { worker.terminate(); } catch {} reject(new Error(data.error || "load failed")); }
      else if (data.type === "audio" || data.type === "audio-error") {
        w.busy = null;
        const job = nat.pending.get(data.id);
        nat.pending.delete(data.id);
        if (job) {
          if (data.type === "audio") {
            const secs = data.pcm.length / data.rate;
            if (secs > 0.4) { nat.rtf.push(data.ms / 1000 / secs); if (nat.rtf.length > 10) nat.rtf.shift(); }
            job.resolve({ pcm: data.pcm, rate: data.rate });
          } else job.reject(new Error(data.error));
        }
        pump();
      }
    };
    worker.onerror = (e) => {
      if (!w.ready) { reject(new Error(e.message || "worker error")); return; }
      w.ready = false;
      nat.pool = nat.pool.filter((x) => x !== w);
      if (w.busy) { nat.pending.get(w.busy)?.reject(new Error("voice stopped")); nat.pending.delete(w.busy); }
      if (!nat.pool.length) {
        nat.queue.forEach((j) => j.reject(new Error("voice stopped")));
        nat.queue = [];
        nat.loading = null;
        if (nat.mode === "fast") {
          // the graphics chip gave up: carry on with the standard voice
          localStorage.setItem("luma.voice.mode", "standard");
          nat.status = "none";
          bus.emit("toast", "The graphics chip stopped working for the voice — switched to the standard voice.");
          bus.emit("voice-state");
          loadNatural().catch(() => {});
          return;
        }
        nat.status = "error";
        nat.error = "The natural voice stopped.";
        bus.emit("voice-state");
      }
      pump();
    };
    const m = MODES[mode];
    worker.postMessage({ type: "load", urls: window.__LUMA_KOKORO_URLS__ || KOKORO_URLS, model: MODEL, dtype: m.dtype, device: m.device });
  });
}

export function loadNatural() {
  if (nat.status === "ready") return Promise.resolve();
  if (nat.loading) return nat.loading;
  nat.status = "loading";
  nat.error = "";
  nat.progress = 0;
  nat.mode = naturalMode();
  bus.emit("voice-state");
  const files = new Map();
  const onProgress = (p) => {
    if (p.file && p.total) files.set(p.file, [p.loaded || 0, p.total]);
    let l = 0, t = 0;
    files.forEach(([a, b]) => { l += a; t += b; });
    nat.progress = t ? Math.min(0.99, l / t) : nat.progress;
    bus.emit("voice-state");
  };
  nat.loading = (async () => {
    let first;
    try {
      first = await spawn(nat.mode, onProgress);
    } catch (e) {
      if (nat.mode === "fast") {
        // the graphics chip didn't work out — fall back to the standard engine
        localStorage.setItem("luma.voice.mode", "standard");
        nat.mode = "standard";
        bus.emit("toast", "Fast mode isn't available on this device — using the standard natural voice.");
        try { first = await spawn("standard", onProgress); } catch (e2) { e = e2; }
      }
      if (!first) {
        nat.status = "error";
        nat.error = navigator.onLine ? "The natural voice couldn't be downloaded. " + (e?.message || "") : "You're offline — the natural voice downloads the first time you're online.";
        nat.loading = null;
        bus.emit("voice-state");
        throw new Error(nat.error);
      }
    }
    nat.pool = [first];
    nat.status = "ready";
    nat.progress = 1;
    localStorage.setItem(LS.ready, "1");
    bus.emit("voice-state");
    nat.grown = false;
    pump();
  })();
  return nat.loading;
}

/** More workers once reading starts — the model is already downloaded, so each starts quickly. */
function grow() {
  if (nat.grown || nat.status !== "ready") return;
  nat.grown = true;
  const want = poolSize(nat.mode);
  for (let k = nat.pool.length; k < want; k++) {
    spawn(nat.mode).then((w) => { if (nat.status === "ready") { nat.pool.push(w); bus.emit("voice-state"); pump(); } else w.worker.terminate(); }).catch(() => {});
  }
}

/** Get the natural voice ready in the background while you read, so Listen starts at once. */
export function warmUp() {
  if (prefs.engine !== "natural" || !prefs.naturalDownloaded || nat.status !== "none") return;
  const go = () => loadNatural().catch(() => {});
  if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 4000 }); else setTimeout(go, 1500);
}

/** Switch between the standard (processor) and fast (graphics chip) engines. */
export async function setNaturalMode(mode) {
  localStorage.setItem("luma.voice.mode", mode);
  for (const w of nat.pool) { try { w.worker.terminate(); } catch {} }
  nat.pool = [];
  nat.queue.forEach((j) => j.reject(new Error("cancelled")));
  nat.queue = [];
  nat.pending.forEach((j) => j.reject(new Error("cancelled")));
  nat.pending.clear();
  nat.status = "none";
  nat.loading = null;
  nat.grown = false;
  nat.rtf = [];
  bus.emit("voice-state");
  return loadNatural();
}

function pump() {
  for (const w of nat.pool) {
    if (!w.ready || w.busy || !nat.queue.length) continue;
    const job = nat.queue.shift();
    w.busy = job.id;
    nat.pending.set(job.id, job);
    w.worker.postMessage({ type: "say", id: job.id, text: job.text, voice: job.voice, speed: job.speed });
  }
}

/** Real-time factor for the whole pool: time to make a second of speech (lower is better; > 1 means slower than speaking). */
export const naturalSpeed = () => {
  if (!nat.rtf.length) return 0;
  const avg = nat.rtf.reduce((a, b) => a + b, 0) / nat.rtf.length;
  return avg / Math.max(1, nat.pool.filter((w) => w.ready).length);
};

export function synthNatural(text, voiceId = prefs.natural, speed = prefs.rate, { urgent = false } = {}) {
  if (nat.status !== "ready" || !nat.pool.length) return Promise.reject(new Error("not ready"));
  const id = ++nat.seq;
  let job;
  const p = new Promise((resolve, reject) => { job = { id, text, voice: voiceId, speed: Math.max(0.5, Math.min(2, speed)), resolve, reject }; });
  p.jobId = id;
  if (urgent) nat.queue.unshift(job); else nat.queue.push(job);
  pump();
  // give the first sentence a head start, then bring in more workers
  if (!nat.grown && !nat.growTimer) nat.growTimer = setTimeout(() => { nat.growTimer = null; grow(); }, window.__LUMA_TTS_WORKERS__ ? 0 : 900);
  return p;
}

export function cancelNatural(promises) {
  const ids = new Set(promises.map((p) => p?.jobId).filter(Boolean));
  if (!ids.size) return;
  nat.queue = nat.queue.filter((j) => { if (ids.has(j.id)) { j.reject(new Error("cancelled")); return false; } return true; });
  // jobs already running finish in the worker; their results are simply dropped
  for (const id of ids) { nat.pending.get(id)?.reject(new Error("cancelled")); nat.pending.delete(id); }
}

// ───────── audio output ─────────
let ctx = null;
const playing = new Set();

export function unlockAudio() {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "playback" });
    if (ctx.state === "suspended") ctx.resume();
  } catch { /* no audio */ }
  return ctx;
}

export const audioTime = () => ctx?.currentTime || 0;

/** Put a clip on the audio timeline at `when` (seconds, audio clock). Clips scheduled back to back play with no gap. */
export function schedulePcm({ pcm, rate }, when = 0) {
  unlockAudio();
  const buf = ctx.createBuffer(1, pcm.length, rate);
  buf.copyToChannel(pcm, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const start = Math.max(ctx.currentTime + 0.02, when);
  const handle = { start, end: start + pcm.length / rate, stop: () => { try { src.stop(); } catch {} playing.delete(handle); } };
  src.onended = () => playing.delete(handle);
  playing.add(handle);
  src.start(start);
  return handle;
}

export function playPcm(audio) {
  const h = schedulePcm(audio);
  const done = new Promise((resolve) => setTimeout(resolve, Math.max(0, (h.end - ctx.currentTime) * 1000)));
  return { done, stop: h.stop, elapsed: () => ctx.currentTime - h.start, duration: h.end - h.start };
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

/** Speak with a device voice. Several can be queued; each starts the moment the previous one ends. */
export function speakSystem(text, { rate = prefs.rate, voiceId, pitch = 1, onBoundary, onStart } = {}) {
  if (!("speechSynthesis" in window)) return { done: Promise.resolve(false), stop() {} };
  const u = new SpeechSynthesisUtterance(text);
  const v = (voiceId && systemVoices().find((x) => x.id === voiceId)) || currentSystemVoice();
  if (v) { u.voice = v.v; u.lang = v.v.lang; }
  u.rate = rate;
  u.pitch = Math.max(0.5, Math.min(1.6, pitch));
  if (onBoundary) u.onboundary = (e) => { if (e.name !== "sentence") onBoundary(e.charIndex); };
  let t0 = performance.now();
  u.onstart = () => { t0 = performance.now(); onStart?.(); };
  keep.add(u);
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  u.onend = () => { keep.delete(u); resolveDone(true); };
  u.onerror = () => { keep.delete(u); resolveDone(false); };
  speechSynthesis.resume();
  speechSynthesis.speak(u);
  return { done, utterance: u, stop: () => { speechSynthesis.cancel(); keep.delete(u); resolveDone(false); }, elapsed: () => (performance.now() - t0) / 1000 };
}

export function stopAll() {
  playing.forEach((h) => h.stop());
  playing.clear();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

/** Say a single word or short phrase with the best voice available right now. */
export async function speakOnce(text) {
  bus.emit("voice-interrupt");
  stopAll();
  if (prefs.engine === "natural" && nat.status === "ready") {
    try { return await playPcm(await synthNatural(text, prefs.natural, 0.95, { urgent: true })).done; } catch { /* fall through */ }
  }
  return speakSystem(text, { rate: 0.95 }).done;
}

export const SAMPLE = "Each lamp he touched grew luminous, and the cobbles shone like wet slate.";

export async function preview({ engine, id }) {
  bus.emit("voice-interrupt");
  stopAll();
  unlockAudio();
  if (engine === "natural") {
    await loadNatural();
    return playPcm(await synthNatural(SAMPLE, id, prefs.rate, { urgent: true })).done;
  }
  return speakSystem(SAMPLE, { voiceId: id }).done;
}
