// Listen: reads the book aloud like an audiobook. Sentence by sentence with
// natural pauses; characters get voices of their own; the current sentence and
// word are highlighted and the page scrolls or turns to follow the voice. If you
// scroll away, it waits for you ("Back to the voice"). Speed, voice, sleep timer,
// pronunciations, chapter audio files, and lock-screen/headset controls.
import { el, bus, setKids, clamp, downloadBlob, isTouch } from "../core/util.js";
import { store } from "../data/store.js";
import { icon } from "../ui/icons.js";
import { toast, menu, dialog, confirmDialog } from "../ui/overlay.js";
import { sentenceSpans, speakable, TextIndex, textLayerSpans, setHighlight } from "./textindex.js";
import { DialogueContext, Cast, splitParts } from "./dialogue.js";
import * as voice from "../core/voice.js";

const RATES = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2];
const ENDS = /[.!?:"”’)]\s*$/;
const CAPTION = /^(fig(ure)?|table|plate|chart|exhibit|image|photo|illustration|source|map|diagram)\.?\s*[\dIVXivx]+[a-z]?\s*[.:—–-]/i;
const CITATION = /\s?\((?:see\s|cf\.\s)?[A-Z][\p{L}'’-]+(?:\s(?:et al\.?|and|&)(?:\s[A-Z][\p{L}'’-]+)?)?,?\s(?:1[5-9]|20)\d\d[a-z]?(?:,\s?(?:p|pp)\.\s?\d+(?:[–-]\d+)?)?(?:;\s?[^()]{0,80})?\)/gu;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const smooth = () => (document.documentElement.dataset.motion === "reduce" ? "auto" : "smooth");

/** Text exactly as it should be spoken: citations skipped, your pronunciations applied. */
export function speechText(text) {
  const s = store.settings();
  let t = text;
  if (s.skipCitations !== false) t = t.replace(CITATION, "");
  t = speakable(t);
  for (const [w, say] of Object.entries(s.pronunciations || {})) {
    if (w && say) t = t.replace(new RegExp(`(?<![\\p{L}])${esc(w)}(?![\\p{L}])`, "giu"), say);
  }
  return t;
}

/** Turn a page of book blocks into spoken sentences, each split into narration and character parts. */
export function appendSentences(list, blocks, p, dctx) {
  const s = store.settings();
  const cast = s.characterVoices !== false && dctx;
  for (const b of blocks) {
    if (b.type === "img" || !b.text) continue;
    if (b.type === "h") {
      list.push({ text: b.text, page: p, heading: true, level: b.level, paraEnd: true, segs: [{ bid: b.id, start: 0, end: b.text.length }], parts: [{ bid: b.id, start: 0, end: b.text.length, text: b.text, speaker: null }] });
      if (dctx) dctx.carry = null;
      continue;
    }
    if (s.skipCaptions !== false && CAPTION.test(b.text)) continue;
    const quotes = cast ? dctx.analyze(b.text, { cont: b.cont }) : [];
    const spans = sentenceSpans(b.text);
    spans.forEach((sp, k) => {
      const text = b.text.slice(sp.start, sp.end).trim();
      const seg = { bid: b.id, start: sp.start, end: sp.end };
      const parts = splitParts(b.text, sp.start, sp.end, quotes)
        .map((pt) => ({ ...pt, bid: b.id, text: b.text.slice(pt.start, pt.end) }))
        .filter((pt) => /[\p{L}\p{N}]/u.test(pt.text));
      const prev = list[list.length - 1];
      if (k === 0 && b.cont && prev && !prev.heading && !ENDS.test(prev.text)) {
        prev.text += " " + text;
        prev.segs.push(seg);
        prev.parts.push(...parts);
        prev.paraEnd = spans.length === 1;
        return;
      }
      list.push({ text, page: p, segs: [seg], parts, paraEnd: k === spans.length - 1 });
    });
  }
}

/** When each word starts within a clip (seconds), from word lengths and punctuation pauses. */
function wordStarts(text, duration) {
  const words = text.match(/\S+/g) || [];
  if (!words.length || !duration) return [0];
  const weight = (w) => w.length + 2 + (/[,;:—–]["”’)]?$/.test(w) ? 4 : /[.!?…]["”’)]?$/.test(w) ? 6 : 0);
  const total = words.reduce((n, w) => n + weight(w), 0);
  const lead = Math.min(0.12, duration * 0.04), usable = Math.max(0.2, duration - lead - Math.min(0.2, duration * 0.06));
  const out = [];
  let acc = 0;
  for (const w of words) { out.push(lead + (acc / total) * usable); acc += weight(w); }
  return out;
}

class Player {
  constructor() {
    this.tab = null;
    this.sentences = [];
    this.i = 0;
    this.token = 0;
    this.wordToken = 0;
    this.state = "idle"; // idle | playing | paused
    this.nextPage = 1;
    this.cache = new Map();
    this.sleepTimer = null;
    this.sleepChapter = false;
    this.sleepLabel = "";
    this.following = true;
    this.layerIndex = new WeakMap();
    this.blockIndex = new WeakMap();
    this.speaker = null;
    bus.on("voice-state", () => {
      if (this.waitNatural && this.state === "playing") {
        if (this.#useNatural()) { this.waitNatural = false; this.#begin(this.i); return; }
        if (voice.naturalState().status === "error") { this.waitNatural = false; this.pause(); }
      }
      // the natural voice became ready while a device voice was reading: switch at the next sentence
      if (this.state === "playing" && this.engine === "system" && this.#useNatural()) this.switchPending = true;
      this.renderBar();
    });
    bus.on("voice-prefs", () => {
      this.#dropCache();
      if (this.state === "playing") { this.next0 = this.cur?.i >= 0 ? this.cur.i : this.i; this.#begin(this.next0); }
      this.renderBar();
    });
    bus.on("voice-interrupt", () => { if (this.state === "playing") this.pause(); });
    bus.on("user-nav", (tab) => { if (tab === this.tab) this.#userNav(); });
  }

  mount(root) { this.root = root; }
  get active() { return this.state !== "idle"; }

  // ───────── control ─────────
  async start(tab, from = {}) {
    if (!tab || tab.state !== "ready") return;
    this.stop(true);
    if (!voice.prefs.engine) {
      const choice = await chooseVoiceDialog();
      if (!choice) return;
    }
    voice.unlockAudio();
    this.tab = tab;
    this.sentences = [];
    this.cache.clear();
    this.dctx = new DialogueContext();
    this.cast = new Cast(tab.docId);
    this.following = true;
    const startPage = from.bid ? Number(from.bid.split(":")[0]) : from.page || tab.currentPage();
    // read a little of the page before so the speakers in a conversation are known
    this.nextPage = startPage;
    if (startPage > 1 && store.settings().characterVoices !== false) {
      const warm = [];
      appendSentences(warm, await tab.model.page(startPage - 1), startPage - 1, this.dctx);
    }
    this.state = "playing";
    if (tab.book) tab.book.listening = true;
    this.renderBar("Getting the text ready…");
    await this.#extend(12);
    let idx = 0;
    if (from.bid) idx = this.sentences.findIndex((s) => s.segs.some((g) => g.bid === from.bid && g.end > (from.offset || 0)));
    this.i = Math.max(0, idx);
    this.startI = this.i;
    if (!this.sentences.length) {
      toast("There's no readable text here. Scanned pages can't be read aloud yet.");
      this.stop();
      return;
    }
    if (voice.prefs.engine === "natural" && voice.naturalState().status !== "ready") {
      const first = !voice.prefs.naturalDownloaded;
      voice.loadNatural().then(() => { if (this.active) toast(first ? "Natural voice ready — switching over" : "Natural voice on"); }).catch((e) => {
        if (this.active) toast(e.message + " Using your device voice.", { tone: "warn", duration: 6000 });
      });
    }
    this.#watchManualScroll();
    this.#mediaSession();
    if (isTouch()) voice.keepAlive(true);
    this.next0 = this.i;
    this.#begin(this.i);
  }

  pause() {
    if (this.state !== "playing") return;
    // remember the sentence being read; resuming starts it again so nothing is missed
    const at = this.cur?.i >= 0 ? this.cur.i : this.i;
    this.#halt();
    this.i = at;
    voice.keepAlive(false);
    this.state = "paused";
    this.renderBar();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  }

  resume() {
    if (this.state !== "paused") return;
    voice.unlockAudio();
    if (isTouch()) voice.keepAlive(true);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    this.next0 = this.i;
    this.#begin(this.i);
  }

  toggle() { this.state === "playing" ? this.pause() : this.resume(); }

  async skip(delta) {
    if (!this.active) return;
    const from = this.cur?.i >= 0 ? this.cur.i : this.i;
    if (delta > 0) await this.#extend(from + delta + 3);
    const to = clamp(from + delta, 0, Math.max(0, this.sentences.length - 1));
    this.following = true;
    this.next0 = to;
    if (this.state === "playing") this.#begin(to);
    else { this.i = to; this.cur = { i: -1, k: -1 }; this.#enterSentence(to); this.renderBar(); }
  }

  stop(silent = false) {
    this.#halt();
    voice.keepAlive(false);
    this.#dropCache();
    clearTimeout(this.sleepTimer);
    clearTimeout(this.followTimer);
    this.unwatch?.();
    this.unwatch = null;
    this.sleepTimer = null;
    this.sleepChapter = false;
    this.sleepLabel = "";
    setHighlight("luma-speak", []);
    setHighlight("luma-word", []);
    if (this.tab?.book) this.tab.book.listening = false;
    this.state = "idle";
    this.bar?.remove();
    this.bar = null;
    this.backPill?.remove();
    this.backPill = null;
    if (this.root?.classList.contains("listening")) {
      this.root.classList.remove("listening");
      bus.emit("player-layout");
    }
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
    if (!silent) bus.emit("player-stopped");
  }

  async setRate(r) {
    await store.setSettings({ speechRate: r });
    this.#dropCache();
    const at = this.cur?.i >= 0 ? this.cur.i : this.i;
    this.next0 = at;
    if (this.state === "playing") this.#begin(at);
    this.renderBar();
  }

  setSleep(min) {
    clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.sleepChapter = false;
    this.sleepLabel = "";
    if (min === "chapter") { this.sleepChapter = true; this.sleepLabel = "End of chapter"; this.startI = this.i; }
    else if (min) {
      this.sleepLabel = `${min} min`;
      this.sleepTimer = setTimeout(() => { this.pause(); this.sleepLabel = ""; toast("Sleep timer — paused. Sleep well."); this.renderBar(); }, min * 60000);
    }
    this.renderBar();
  }

  /** Restart from the current sentence (after a setting that changes how text is spoken). */
  refresh() {
    if (!this.active) return;
    const keep = this.sentences[this.i]?.segs[0];
    this.#dropCache();
    const playing = this.state === "playing";
    this.start(this.tab, keep ? { bid: keep.bid, offset: keep.start } : {}).then(() => { if (!playing) this.pause(); });
  }

  // ───────── following the voice ─────────
  #userNav() {
    if (!this.active) return;
    this.following = false;
    clearTimeout(this.followTimer);
    // pick the voice back up on its own once you've stopped moving around
    this.followTimer = setTimeout(() => this.backToVoice(), 15000);
    this.renderBar();
  }

  backToVoice() {
    clearTimeout(this.followTimer);
    if (!this.active) return;
    this.following = true;
    const s = this.sentences[this.i];
    if (s) this.#show(s);
    this.renderBar();
  }

  #watchManualScroll() {
    const c = this.tab?.container;
    if (!c) return;
    const nav = () => { if (this.tab?.mode === "pdf") this.#userNav(); };
    const key = (e) => { if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(e.key)) nav(); };
    c.addEventListener("wheel", nav, { passive: true });
    c.addEventListener("touchmove", nav, { passive: true });
    c.addEventListener("keydown", key);
    this.unwatch = () => { c.removeEventListener("wheel", nav); c.removeEventListener("touchmove", nav); c.removeEventListener("keydown", key); };
  }

  // ───────── text → sentences ─────────
  async #extend(count) {
    const model = this.tab?.model;
    if (!model) return;
    while (this.sentences.length < count && this.nextPage <= model.numPages) {
      const p = this.nextPage++;
      appendSentences(this.sentences, await model.page(p), p, this.dctx);
    }
  }

  // ───────── playback ─────────
  // Natural voice: sentences are made ahead of time (several at once) and laid
  // end to end on the audio clock, so one flows into the next with only the
  // pause a narrator would leave. The highlight follows the clock.
  // Device voice: the next sentence is always queued, so there's no gap while
  // the app works out what comes next.

  #useNatural() {
    return voice.prefs.engine === "natural" && voice.naturalState().status === "ready";
  }

  /** Which voice reads a part: the narrator's, or the character's own. */
  #voiceFor(part) {
    const natural = this.#useNatural();
    const c = store.settings().characterVoices !== false && part.speaker ? this.cast.voiceFor(part.speaker, natural) : null;
    if (natural) return c?.engine === "natural" ? c : { engine: "natural", id: voice.prefs.natural };
    return c || { engine: "system" };
  }

  /** Audio for one part, made in the background: { state: pending | ok | failed, audio } */
  #audioFor(i, k) {
    const part = this.sentences[i]?.parts[k];
    if (!part) return null;
    const v = this.#voiceFor(part);
    if (v.engine !== "natural") return null;
    const key = `${i}.${k}|${v.id}|${voice.prefs.rate}`;
    let e = this.cache.get(key);
    if (!e) {
      const text = speechText(part.text);
      e = { state: "pending", voice: v.id };
      if (!text.trim()) { e.state = "ok"; e.audio = { pcm: new Float32Array(480), rate: 24000 }; }
      else {
        e.promise = voice.synthNatural(text, v.id);
        e.promise.then((a) => { e.state = "ok"; e.audio = a; }, () => { e.state = "failed"; });
      }
      this.cache.set(key, e);
    }
    return e;
  }

  #dropCache() {
    voice.cancelNatural([...this.cache.values()].map((e) => e.promise).filter(Boolean));
    this.cache.clear();
  }

  /** Stop all sound and timers (audio already made is kept). */
  #halt() {
    this.token++;
    this.wordToken++;
    voice.stopAll();
    cancelAnimationFrame(this.raf);
    clearInterval(this.loopTimer);
    this.clips = [];
    this.sysQueue = [];
    this.lastEnd = 0;
    this.stopAtI = null;
    this.switchPending = false;
    this.waitNatural = false;
    this.sysFails = 0;
  }

  /** Start reading from the beginning of sentence i. */
  #begin(i) {
    this.#halt();
    this.i = clamp(i, 0, Math.max(0, this.sentences.length - 1));
    this.next = { i: this.i, k: 0 };
    this.cur = { i: -1, k: -1 };
    this.state = "playing";
    this.buffering = false;
    this.engine = this.#useNatural() ? "natural" : "system";
    this.#enterSentence(this.i);
    this.renderBar();
    if (this.engine === "natural") {
      const token = this.token;
      const frame = () => { if (token !== this.token) return; this.#tick(); this.raf = requestAnimationFrame(frame); };
      this.raf = requestAnimationFrame(frame);
      this.loopTimer = setInterval(() => { if (token === this.token) this.#tick(); }, 250); // keeps going with the screen off
      this.#tick();
    } else this.#sysFill();
  }

  #gapBefore(i) {
    const prev = this.sentences[i - 1];
    if (!prev || i === this.next0) return 0;
    const g = prev.heading ? 0.6 : prev.paraEnd ? 0.3 : 0.05;
    return g / (voice.prefs.rate || 1);
  }

  #moreText() {
    const model = this.tab?.model;
    if (this.extending || !model || this.nextPage > model.numPages) return;
    this.extending = true;
    this.#extend(this.sentences.length + 24).finally(() => { this.extending = false; });
  }

  get #textDone() { return !this.extending && this.nextPage > (this.tab?.model?.numPages || 0); }

  #tick() {
    if (this.state !== "playing" || !this.tab) return;
    const now = voice.audioTime();
    if (this.next.i >= this.sentences.length - 10) this.#moreText();
    // make audio well ahead: about two minutes of reading, several sentences at a time
    let chars = 0;
    for (let j = this.cur.i >= 0 ? this.cur.i : this.i; j < this.sentences.length && chars < 2200; j++) {
      const s = this.sentences[j];
      s.parts.forEach((_, k) => this.#audioFor(j, k));
      chars += s.text.length;
    }
    for (const [key] of this.cache) if (Number(key.split(".")[0]) < this.i - 3) this.cache.delete(key);
    // lay ready clips on the timeline
    const horizon = document.hidden ? 75 : 30;
    while (!this.lastEnd || this.lastEnd - now < horizon) {
      const { i, k } = this.next;
      const s = this.sentences[i];
      if (!s) break;
      if (this.sleepChapter && k === 0 && s.heading && i > this.startI) { this.stopAtI = i; break; }
      const e = this.#audioFor(i, k);
      if (!e || e.state === "pending") break;
      if (e.state === "ok") {
        const gap = k === 0 ? this.#gapBefore(i) : 0.01;
        const when = this.lastEnd ? Math.max(now + 0.03, this.lastEnd + gap) : now + 0.06;
        const h = voice.schedulePcm(e.audio, when);
        const part = s.parts[k];
        this.clips.push({ i, k, start: h.start, end: h.end, starts: wordStarts(part.text, h.end - h.start) });
        this.lastEnd = h.end;
        (this.timeline ||= []).push({ i, k, start: h.start, end: h.end });
        if (this.timeline.length > 80) this.timeline.shift();
        (this.trail ||= []).push({ text: part.text, speaker: part.speaker?.name || null, voice: e.voice });
        if (this.trail.length > 60) this.trail.shift();
      }
      this.next = k + 1 < s.parts.length ? { i, k: k + 1 } : { i: i + 1, k: 0 };
    }
    // what's playing now
    while (this.clips.length > 1 && this.clips[1].start <= now) this.clips.shift();
    const clip = this.clips[0];
    if (clip && now >= clip.start - 0.03 && now < clip.end) {
      if (clip.i !== this.cur.i || clip.k !== this.cur.k) this.#enterPart(clip.i, clip.k);
      this.#wordAt(clip, now - clip.start);
      if (this.buffering) { this.buffering = false; this.renderBar(); }
      return;
    }
    const upcoming = this.clips.find((c) => c.start > now);
    if (upcoming || now < this.lastEnd) return; // a narrator's pause
    if (this.stopAtI != null) {
      this.i = this.stopAtI;
      this.pause();
      this.sleepChapter = false;
      this.sleepLabel = "";
      this.renderBar();
      toast("Sleep timer — paused at the end of the chapter");
      return;
    }
    if (this.next.i >= this.sentences.length && this.#textDone) { this.#finished(); return; }
    // nothing ready yet: say so instead of going silent without explanation
    if (!this.buffering) {
      this.buffering = true;
      this.waits = (this.waits || 0) + 1;
      this.renderBar();
      if (this.waits === 3) this.#suggestFaster();
    }
  }

  async #suggestFaster() {
    if (this.suggested || voice.naturalSpeed() < 0.75) return;
    this.suggested = true;
    if (voice.naturalMode() !== "fast" && (await voice.fastModeAvailable())) {
      toast("The natural voice is working hard on this device. Use your graphics chip to make it faster?", {
        action: "Make it faster", duration: 12000,
        onAction: () => {
          const at = this.i;
          voice.setNaturalMode("fast").then(() => { if (this.active) this.#begin(at); }).catch(() => {});
          toast(`Downloading the fast voice (${voice.MODE_SIZE("fast")}, one time)…`);
        },
      });
    } else {
      toast("This device makes the natural voice slowly, so it may pause now and then.", { action: "Use device voice", onAction: () => { voice.prefs.engine = "system"; if (this.active) this.#begin(this.i); }, duration: 10000 });
    }
  }

  #enterSentence(i) {
    const s = this.sentences[i];
    if (!s) return;
    const prevPage = this.sentences[this.i]?.page;
    this.i = i;
    this.showing = this.#show(s).then(() => { this.wordFrom = this.sentenceStart ?? 0; });
    if (s.page !== prevPage) this.tab?.savePosition(s.page);
  }

  #enterPart(i, k) {
    if (i !== this.cur.i) this.#enterSentence(i);
    this.cur = { i, k };
    const part = this.sentences[i]?.parts[k];
    if ((part?.speaker || null) !== this.speaker || k === 0) { this.speaker = part?.speaker || null; this.renderBar(); }
  }

  #wordAt(clip, t) {
    if (store.settings().wordHighlight === false) return;
    if (!clip.words) {
      if (clip.resolving) return;
      clip.resolving = true;
      this.showing?.then(() => { clip.words = this.#wordsFor(this.sentences[clip.i].parts[clip.k]); });
      return;
    }
    let n = 0;
    while (n + 1 < clip.starts.length && clip.starts[n + 1] <= t) n++;
    if (n !== clip.word) { clip.word = n; this.#markWord(clip.words[n]); }
  }

  // device voice: always one sentence queued behind the one being spoken
  #sysFill() {
    const token = this.token;
    while (this.sysQueue.length < 2) {
      const { i, k } = this.next;
      const s = this.sentences[i];
      if (!s) {
        if (!this.#textDone) { this.#moreText(); setTimeout(() => token === this.token && this.#sysFill(), 150); }
        else if (!this.sysQueue.length) this.#finished();
        return;
      }
      if (i >= this.sentences.length - 10) this.#moreText();
      if (this.sleepChapter && k === 0 && s.heading && i > this.startI) {
        if (!this.sysQueue.length) { this.i = i; this.pause(); this.sleepChapter = false; this.sleepLabel = ""; this.renderBar(); toast("Sleep timer — paused at the end of the chapter"); }
        return;
      }
      this.next = k + 1 < s.parts.length ? { i, k: k + 1 } : { i: i + 1, k: 0 };
      const part = s.parts[k];
      const text = speechText(part.text);
      if (!text.trim()) continue;
      const sys = store.settings().characterVoices !== false && part.speaker ? this.cast.voiceFor(part.speaker, false) : {};
      const item = { i, k, text };
      const spokenWords = (text.match(/\S+/g) || []).length || 1;
      item.h = voice.speakSystem(text, {
        voiceId: sys.id, pitch: sys.pitch || 1,
        onStart: () => {
          if (token !== this.token) return;
          item.started = true;
          this.sysFails = 0;
          this.#enterPart(i, k);
          item.heard = false;
          const tok = ++this.wordToken;
          this.showing.then(() => {
            if (tok !== this.wordToken) return;
            item.words = store.settings().wordHighlight === false ? [] : this.#wordsFor(part);
            // some voices (online ones) don't report word timing — estimate it instead
            setTimeout(() => { if (!item.heard && tok === this.wordToken) this.#trackWords(item.words, item.h, text.length / (14.5 * (voice.prefs.rate || 1))); }, 350);
          });
        },
        onBoundary: (ci) => {
          if (token !== this.token || !item.words) return;
          item.heard = true;
          const n = (text.slice(0, ci).match(/\S+/g) || []).length;
          this.#markWord(item.words[Math.min(item.words.length - 1, Math.round((n * item.words.length) / spokenWords))]);
        },
      });
      (this.trail ||= []).push({ text: part.text, speaker: part.speaker?.name || null, voice: sys.id || null });
      if (this.trail.length > 60) this.trail.shift();
      item.h.done.then((spoke) => {
        if (token !== this.token) return;
        this.sysQueue = this.sysQueue.filter((x) => x !== item);
        // the device voice refused to speak: stop rather than racing through the book
        if (spoke === false && !item.started && ++this.sysFails >= 2) {
          // the natural voice is on its way: wait for it rather than giving up
          if (voice.prefs.engine === "natural" && voice.naturalState().status === "loading") {
            const at = item.i;
            this.#halt();
            this.i = at;
            this.waitNatural = true;
            this.buffering = true;
            this.renderBar();
            return;
          }
          this.i = item.i;
          this.pause();
          toast("Your device's voice didn't start.", { action: "Use the natural voice", tone: "warn", duration: 10000, onAction: () => { voice.prefs.engine = "natural"; voice.loadNatural().then(() => this.resume()).catch((e) => toast(e.message, { tone: "warn" })); } });
          return;
        }
        if (this.switchPending && this.#useNatural()) { this.#begin(this.sysQueue[0]?.i ?? this.next.i); return; }
        this.#sysFill();
      });
      this.sysQueue.push(item);
    }
  }

  #finished() {
    const last = this.sentences[this.sentences.length - 1];
    if (last) this.tab?.savePosition(last.page, { end: true });
    this.stop();
    toast("Finished reading aloud — that's the end of the book");
  }

  // ───────── word by word ─────────
  #wordsFor(part) {
    if (!part || store.settings().wordHighlight === false) return [];
    const tab = this.tab;
    const out = [];
    const re = /\S+/g;
    if (tab.mode === "book" && tab.book) {
      const blockEl = tab.book.flow.querySelector(`[data-bid="${part.bid}"]`);
      if (!blockEl) return [];
      let idx = this.blockIndex.get(blockEl);
      if (!idx || idx.len !== blockEl.textContent.length) { idx = new TextIndex([blockEl]); idx.len = blockEl.textContent.length; this.blockIndex.set(blockEl, idx); }
      for (const m of part.text.matchAll(re)) {
        const a = part.start + m.index;
        out.push({ text: m[0], range: idx.range(a, a + m[0].length) });
      }
      return out;
    }
    // Page view: find each word in the PDF text layer, moving forward through the sentence
    const idx = this.pageIdx;
    if (!idx) return [];
    for (const m of part.text.matchAll(re)) {
      const w = m[0].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      const hit = w ? idx.find(w, this.wordFrom) : null;
      if (hit && hit[0] - this.wordFrom < 160) { out.push({ text: m[0], range: idx.range(hit[0], hit[1]) }); this.wordFrom = hit[1]; }
      else out.push({ text: m[0], range: null });
    }
    return out;
  }

  #trackWords(words, handle, duration) {
    if (!words?.length || !duration) return;
    const starts = wordStarts(words.map((w) => w.text).join(" "), duration);
    const tok = this.wordToken;
    let j = -1;
    const tick = () => {
      if (tok !== this.wordToken) return;
      const t = handle.elapsed?.() ?? 0;
      let n = j < 0 ? 0 : j;
      while (n + 1 < starts.length && starts[n + 1] <= t) n++;
      if (n !== j) { j = n; this.#markWord(words[n]); }
      if (t < duration + 0.3) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  #markWord(w) {
    if (!w?.range) return;
    setHighlight("luma-word", [w.range]);
    if (!this.following) return;
    this.#follow(w.range);
    if (this.tab?.mode === "book") this.tab.book?.rulerTo(w.range);
  }

  /** Keep the voice in view: turn the page, or scroll so it sits a third of the way down. */
  #follow(range) {
    const tab = this.tab;
    if (!range || !tab) return;
    if (tab.mode === "book" && tab.book) { tab.book.reveal(range); return; }
    const rect = [...range.getClientRects()].find((r) => r.width > 0);
    if (!rect) return;
    const cr = tab.container.getBoundingClientRect();
    const target = cr.top + cr.height * 0.33;
    const dy = rect.top - target;
    if (rect.top < cr.top + 20 || rect.bottom > cr.bottom - 110 || Math.abs(dy) > cr.height * 0.18) {
      tab.container.scrollBy({ top: dy, behavior: smooth() });
    }
  }

  // ───────── highlighting the sentence ─────────
  async #show(s) {
    if (!s || !this.tab) return;
    const tab = this.tab;
    setHighlight("luma-word", []);
    if (tab.mode === "book" && tab.book) {
      const ranges = [];
      for (const g of s.segs) {
        const blockEl = this.following ? await tab.book.ensureBlock(g.bid) : tab.book.flow.querySelector(`[data-bid="${g.bid}"]`);
        if (!blockEl) continue;
        const r = new TextIndex([blockEl]).range(g.start, g.end);
        if (r) ranges.push(r);
      }
      setHighlight("luma-speak", ranges);
      if (this.following) {
        tab.book.reveal(ranges[0]);
        tab.book.rulerTo(ranges[0]);
      }
      return;
    }
    // Page view: bring the page into view, then find the sentence on it
    if (this.following && tab.page !== s.page) {
      const div = tab.viewer?.getPageView(s.page - 1)?.div;
      const cr = tab.container.getBoundingClientRect();
      const r = div?.getBoundingClientRect();
      if (!r || r.bottom < cr.top || r.top > cr.bottom) tab.goTo(s.page);
    }
    const found = await this.#locateOnPage(s);
    this.pageIdx = found?.idx || null;
    this.sentenceStart = found?.hit?.[0] ?? 0;
    const range = found?.hit ? found.idx.range(found.hit[0], found.hit[1]) : null;
    setHighlight("luma-speak", range ? [range] : []);
    if (range && this.following) this.#follow(range);
  }

  async #locateOnPage(s) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const div = this.tab.viewer?.getPageView(s.page - 1)?.div;
      const layer = div?.querySelector(".textLayer");
      if (layer?.querySelector("span")) {
        let idx = this.layerIndex.get(layer);
        if (!idx || idx.count !== layer.childElementCount) {
          idx = new TextIndex(textLayerSpans(layer));
          idx.count = layer.childElementCount;
          this.layerIndex.set(layer, idx);
        }
        const hit = idx.find(s.text) || idx.find(s.text.slice(0, 60));
        return { idx, hit };
      }
      if (!this.following) return null;
      await new Promise((r) => setTimeout(r, 120));
    }
    return null;
  }

  // ───────── lock screen / headset ─────────
  async #mediaSession() {
    if (!("mediaSession" in navigator)) return;
    const doc = this.tab.doc;
    let artwork = [];
    try {
      const cover = await store.getCover(this.tab.docId);
      if (cover) artwork = [{ src: cover, sizes: "220x330", type: "image/jpeg" }];
    } catch {}
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: doc?.title || "Book", artist: doc?.author || "Luma Reader", album: "Reading aloud", artwork });
      navigator.mediaSession.playbackState = "playing";
      const h = {
        play: () => this.resume(), pause: () => this.pause(), stop: () => this.stop(),
        previoustrack: () => this.skip(-1), nexttrack: () => this.skip(1),
        seekbackward: () => this.skip(-2), seekforward: () => this.skip(2),
      };
      for (const [k, fn] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, fn); } catch {} }
    } catch {}
  }

  // ───────── UI ─────────
  renderBar(note) {
    if (!this.active || !this.root) return;
    if (!this.bar) {
      this.bar = el("div.player", { role: "region", "aria-label": "Reading aloud" });
      this.root.append(this.bar);
      this.root.classList.add("listening");
      bus.emit("player-layout");
    }
    const s = this.sentences[this.i];
    const ns = voice.naturalState();
    const usingNatural = this.#useNatural();
    const vName = usingNatural
      ? `${voice.NATURAL_VOICES.find((v) => v.id === voice.prefs.natural)?.name || "Natural"} · natural voice`
      : `${voice.currentSystemVoice()?.name || "Device voice"} · device voice`;
    const who = this.speaker?.name ? `${this.speaker.name.replace(/^\w/, (c) => c.toUpperCase())} speaking` : null;
    let line1 = note || (s ? `${s.heading ? "Heading" : "Page " + s.page} · ${who || vName}` : vName);
    let progress = null;
    if (voice.prefs.engine === "natural" && ns.status === "loading") {
      line1 = ns.downloaded ? "Starting the natural voice — device voice for a moment" : `Downloading natural voice · ${Math.round(ns.progress * 100)}% (one time) — device voice until then`;
      progress = ns.downloaded ? null : ns.progress;
    } else if (this.buffering && this.state === "playing") {
      line1 = "Preparing the voice…";
    }
    const rate = voice.prefs.rate;
    setKids(this.bar,
      progress != null ? el("div.pl-progress", { style: { "--p": progress } }) : null,
      el("div.pl-controls", {},
        el("button.icon-btn.pl-skip", { "aria-label": "Previous sentence", title: "Previous sentence", onclick: () => this.skip(-1) }, icon("skipBack", 20)),
        el("button.pl-play", { "aria-label": this.state === "playing" ? "Pause" : "Play", onclick: () => this.toggle() }, icon(this.state === "playing" ? "pause" : "play", 22)),
        el("button.icon-btn.pl-skip", { "aria-label": "Next sentence", title: "Next sentence", onclick: () => this.skip(1) }, icon("skipFwd", 20))),
      el("div.pl-info", {},
        el("p.pl-line1" + (this.buffering && this.state === "playing" ? ".busy" : ""), {}, line1),
        el("p.pl-line2", {}, s ? s.text : "")),
      el("div.pl-side", {},
        el("button.pl-chip", { "aria-label": "Reading speed", title: "Reading speed", onclick: (e) => menu(e.currentTarget, RATES.map((r) => ({ label: `${r}×${r === 1 ? " (normal)" : ""}`, checked: r === rate, onClick: () => this.setRate(r) }))) }, `${rate}×`),
        el("button.icon-btn", { "aria-label": "Voice", title: "Voice", onclick: (e) => voiceMenu(e.currentTarget) }, icon("user", 19)),
        el("button.icon-btn" + (this.sleepLabel ? ".on" : ""), { "aria-label": "Sleep timer", title: this.sleepLabel ? `Sleep timer: ${this.sleepLabel}` : "Sleep timer", onclick: (e) => menu(e.currentTarget, [
          { heading: "Stop reading after" },
          ...[["Off", 0], ["10 minutes", 10], ["20 minutes", 20], ["30 minutes", 30], ["45 minutes", 45], ["1 hour", 60], ["End of chapter", "chapter"]].map(([l, v]) => ({
            label: l, checked: (v === 0 && !this.sleepLabel) || (v === "chapter" ? this.sleepChapter : this.sleepLabel === `${v} min`), onClick: () => this.setSleep(v),
          })),
        ]) }, icon("moon", 19)),
        el("button.icon-btn.pl-more", { "aria-label": "Listening options", title: "Listening options", onclick: (e) => this.#optionsMenu(e.currentTarget) }, icon("more", 19)),
        el("button.icon-btn", { "aria-label": "Stop reading aloud", title: "Stop", onclick: () => this.stop() }, icon("x", 19))));
    // "Back to the voice" when you've wandered off
    if (!this.following && !this.backPill) {
      this.backPill = el("button.pl-back", { onclick: () => this.backToVoice() }, icon("headphones", 16), "Back to the voice");
      this.root.append(this.backPill);
    } else if (this.following && this.backPill) {
      this.backPill.remove();
      this.backPill = null;
    }
  }

  #optionsMenu(anchor) {
    const s = store.settings();
    const toggle = (key, label) => ({ label, checked: s[key] !== false, onClick: async () => { await store.setSettings({ [key]: s[key] === false }); this.refresh(); } });
    menu(anchor, [
      { heading: "While listening" },
      toggle("wordHighlight", "Highlight each word"),
      toggle("characterVoices", "Character voices for dialogue"),
      toggle("skipCitations", "Skip citations like (Smith, 2004)"),
      toggle("skipCaptions", "Skip figure & table captions"),
      "-",
      { label: "Who's who (character voices)…", icon: "user", onClick: () => castDialog(this) },
      { label: "Pronunciations…", icon: "sound", onClick: () => pronunciationsDialog() },
      { label: "Save as an audiobook…", icon: "download", onClick: () => audiobookDialog(this.tab) },
    ]);
  }
}

export const player = new Player();
window.__luma = Object.assign(window.__luma || {}, { player });

function voiceMenu(anchor) {
  const sys = voice.systemVoices().slice(0, 6);
  const nat = voice.prefs.engine === "natural";
  menu(anchor, [
    { heading: "Natural voices · on this device" },
    ...voice.NATURAL_VOICES.map((v) => ({ label: `${v.name} — ${v.desc}`, checked: nat && voice.prefs.natural === v.id, onClick: () => { voice.prefs.natural = v.id; voice.prefs.engine = "natural"; voice.loadNatural().catch(() => {}); } })),
    "-",
    { heading: "Device voices · instant" },
    ...sys.map((v) => ({ label: v.name + (v.natural ? " (natural)" : ""), checked: !nat && voice.currentSystemVoice()?.id === v.id, onClick: () => { voice.prefs.system = v.id; voice.prefs.engine = "system"; } })),
    "-",
    { label: "All voice settings", icon: "settings", onClick: () => { location.hash = "#/settings"; } },
  ]);
}

export function chooseVoiceDialog() {
  return dialog({
    title: "Choose a reading voice",
    className: "voice-dialog",
    body: (c, done) => {
      const option = (engine, title, text, badge) => el("button.voice-option", {
        onclick: () => { voice.prefs.engine = engine; if (engine === "natural") voice.loadNatural().catch(() => {}); done(engine); },
      }, el("span.vo-title", {}, title, badge ? el("span.vo-badge", {}, badge) : null), el("span.vo-text", {}, text));
      c.append(
        option("natural", "Natural voice", "Sounds like a real narrator — breathing, emphasis and all — with different voices for the characters. Downloads once (about 90 MB), then works offline. Starts with your device voice while it downloads.", "Recommended"),
        option("system", "Device voice", "Starts instantly with the voice built into this device. Sounds more robotic on most phones and laptops."),
        el("p.muted.small", {}, "You can switch any time from the voice button while listening, or in Settings."));
    },
  });
}

/** Your own pronunciations: "Hermione" → "her-my-oh-nee". Used by every voice. */
export function pronunciationsDialog() {
  return dialog({
    title: "Pronunciations",
    className: "pron-dialog",
    body: (c) => {
      const list = el("div.pron-list");
      const draw = () => {
        const map = store.settings().pronunciations || {};
        const rows = Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
        setKids(list, rows.length ? rows.map(([w, say]) => el("div.pron-row", {},
          el("span.pron-word", {}, w), el("span.pron-arrow", {}, "→"), el("span.pron-say", {}, say),
          el("button.icon-btn", { "aria-label": `Hear ${w}`, title: "Hear it", onclick: () => voice.speakOnce(say) }, icon("sound", 17)),
          el("button.icon-btn", { "aria-label": `Remove ${w}`, title: "Remove", onclick: async () => { const m = { ...(store.settings().pronunciations || {}) }; delete m[w]; await store.setSettings({ pronunciations: m }); draw(); } }, icon("trash", 17)),
        )) : el("p.muted", {}, "No pronunciations yet. Add a name or word the voice gets wrong."));
      };
      const word = el("input.input", { placeholder: "Word, e.g. Hermione", "aria-label": "Word" });
      const say = el("input.input", { placeholder: "Say it as, e.g. her my oh nee", "aria-label": "Say it as" });
      const add = async (e) => {
        e.preventDefault();
        const w = word.value.trim(), sv = say.value.trim();
        if (!w || !sv) return;
        await store.setSettings({ pronunciations: { ...(store.settings().pronunciations || {}), [w]: sv } });
        word.value = ""; say.value = "";
        draw();
        word.focus();
      };
      c.append(
        el("p.muted.small", {}, "Spell it the way it sounds. Applies to every book and every voice, on all your devices."),
        el("form.pron-add", { onsubmit: add }, word, say,
          el("button.btn.ghost", { type: "button", onclick: () => say.value.trim() && voice.speakOnce(say.value.trim()) }, icon("sound", 16), "Hear"),
          el("button.btn.primary", { type: "submit" }, "Add")),
        list);
      draw();
    },
    actions: [{ label: "Done", primary: true }],
  });
}

function castDialog(p) {
  const natural = voice.prefs.engine === "natural";
  const chars = [...(p.dctx?.chars.values() || [])].filter((c) => c.seen > 0 && !/^an? (man|woman)$/.test(c.name)).sort((a, b) => b.seen - a.seen).slice(0, 24);
  return dialog({
    title: "Who's who",
    className: "cast-dialog",
    body: (c) => {
      c.append(el("p.muted.small", {}, store.settings().characterVoices === false
        ? "Character voices are off — everyone is read by the narrator."
        : natural ? "Each character gets a natural voice of their own. Change any of them here." : "With the device voice, characters are told apart by pitch (or another device voice if you have one). The natural voice gives each character a real voice of their own."));
      if (!chars.length) c.append(el("p.muted", {}, "No characters have spoken yet. They appear here as the story is read."));
      for (const ch of chars) {
        const cur = p.cast.voiceFor(ch, natural);
        const sel = natural ? el("select.input", { "aria-label": `Voice for ${ch.name}`, onchange: () => { p.cast.map[ch.id] = { ...p.cast.map[ch.id], n: sel.value }; p.cast.save?.(); try { localStorage.setItem(`luma.cast.${p.tab.docId}`, JSON.stringify(p.cast.map)); } catch {} p.refresh(); } },
          voice.NATURAL_VOICES.map((v) => el("option", { value: v.id, selected: v.id === cur?.id }, `${v.name} — ${v.desc}`))) : null;
        c.append(el("div.cast-row", {},
          el("span.cast-name", {}, ch.name.replace(/^\w/, (x) => x.toUpperCase())),
          el("span.cast-g.muted.small", {}, ch.gender === "f" ? "she" : ch.gender === "m" ? "he" : ""),
          sel));
      }
    },
    actions: [{ label: "Done", primary: true }],
  });
}

// ───────── audiobook files ─────────
// Made on this device with the natural voice. Many parts are made at once (one
// per voice worker), a small card in the corner shows progress while you keep
// reading, and a whole book is saved as one file per chapter.

const SPEAK_CPS = 15; // characters spoken per second at normal speed

/** Ask what to save, with honest time estimates. */
export async function audiobookDialog(tab) {
  if (!tab?.model) return;
  const page = tab.currentPage();
  const chapterChars = await charsUntilChapterEnd(tab.model, page);
  const bookChars = (tab.model.numPages - page + 1) * (tab.model.avgChars || 1500);
  const est = (chars) => {
    const mins = chars / SPEAK_CPS / 60 / (voice.prefs.rate || 1);
    const rtf = voice.naturalSpeed();
    const listen = mins < 60 ? `${Math.max(1, Math.round(mins))} min` : `${(mins / 60).toFixed(1)} h`;
    if (!rtf) return `${listen} of audio`;
    const make = mins * rtf;
    return `${listen} of audio · about ${make < 1 ? "a minute" : make < 60 ? Math.round(make) + " min" : (make / 60).toFixed(1) + " h"} to make`;
  };
  const fast = voice.naturalMode() !== "fast" && (await voice.fastModeAvailable());
  return dialog({
    title: "Save as an audiobook",
    className: "audiobook-dialog",
    body: (c, done) => {
      const choice = (key, title, note) => el("button.voice-option", { onclick: () => done(key) }, el("span.vo-title", {}, title), el("span.vo-text", {}, note));
      c.append(
        choice("chapter", "This chapter, from where you are", est(chapterChars)),
        choice("book", "The rest of the book — one file per chapter", est(bookChars) + (window.showDirectoryPicker ? " · saved straight into a folder you choose" : "")),
        el("p.muted.small", {}, "Made on this device with the natural voice and your character voices, so nothing is uploaded. You can keep reading while it works."),
        fast ? el("p.small", {}, el("button.link", { onclick: () => { voice.setNaturalMode("fast").catch(() => {}); toast(`Switching to the fast voice — one-time download (${voice.MODE_SIZE("fast")})`); done(null); } }, "Make it much faster with your graphics chip"), ` (one-time ${voice.MODE_SIZE("fast")} download)`) : null);
    },
  }).then((scope) => (scope === "book" ? exportBookAudio(tab, page) : scope === "chapter" ? exportChapterAudio(tab, page) : null));
}

async function charsUntilChapterEnd(model, page) {
  let n = 0;
  for (let p = page; p <= model.numPages && p < page + 80; p++) {
    const blocks = await model.page(p);
    if (p > page && blocks.some((b) => b.type === "h" && b.level === 2)) break;
    n += blocks.reduce((a, b) => a + (b.text?.length || 0), 0);
  }
  return n;
}

async function readyVoice() {
  if (voice.naturalState().status === "ready") return true;
  const ok = await confirmDialog("Save as audio", `Audio files are made with the natural voice, which downloads once (${voice.MODE_SIZE(voice.naturalMode())}) and then works offline. Download it now?`, { confirm: "Download the voice" });
  if (!ok) return false;
  try { await voice.loadNatural(); return true; } catch (e) { toast(e.message, { tone: "warn" }); return false; }
}

/** A small progress card in the corner — reading carries on underneath. */
function taskCard(title) {
  let cancelled = false;
  const bar = el("div.pl-progress.static", { style: { "--p": 0 } });
  const label = el("p.muted.small", {}, "Starting…");
  const card = el("div.task-card", { role: "status" },
    el("div.row", {}, icon("download", 16), el("strong.small", {}, title), el("span.spacer"),
      el("button.icon-btn.sm", { "aria-label": "Cancel", title: "Cancel", onclick: () => { cancelled = true; card.remove(); toast("Audio file cancelled"); } }, icon("x", 16))),
    bar, label);
  document.body.append(card);
  const t0 = performance.now();
  return {
    get cancelled() { return cancelled; },
    progress(done, note = "") {
      bar.style.setProperty("--p", done);
      const elapsed = (performance.now() - t0) / 1000;
      const left = done > 0.02 ? (elapsed / done) * (1 - done) : null;
      label.textContent = `${Math.round(done * 100)}%` + (left != null ? ` · about ${left > 90 ? Math.round(left / 60) + " min" : Math.max(1, Math.round(left)) + " s"} left` : "") + (note ? ` · ${note}` : "");
    },
    close() { card.remove(); },
  };
}

/** Make audio for a list of sentences, keeping every voice worker busy. Returns Float32 chunks. */
async function renderAudio(list, cast, job, base = 0, total = list.length) {
  const chunks = [];
  let rate = 24000;
  const want = (s) => s.parts.map((part) => {
    const v = store.settings().characterVoices !== false && part.speaker ? cast.voiceFor(part.speaker, true) : { id: voice.prefs.natural };
    const text = speechText(part.text);
    const p = text.trim() ? voice.synthNatural(text, v.id) : Promise.resolve(null);
    p.catch(() => {});
    return p;
  });
  const AHEAD = 24; // sentences in flight
  const inflight = [];
  for (let i = 0; i < Math.min(AHEAD, list.length); i++) inflight.push(want(list[i]));
  for (let i = 0; i < list.length; i++) {
    if (job.cancelled) { voice.cancelNatural(inflight.flat()); return null; }
    if (i + AHEAD < list.length) inflight.push(want(list[i + AHEAD]));
    for (const p of inflight[i]) {
      try { const a = await p; if (a) { rate = a.rate; chunks.push(a.pcm); } } catch { /* skip this bit */ }
    }
    inflight[i] = [];
    const s = list[i];
    chunks.push(new Float32Array(Math.round(rate * (s.heading ? 0.8 : s.paraEnd ? 0.45 : 0.1))));
    job.progress((base + i + 1) / total);
  }
  return { chunks, rate };
}

const fileName = (title, part) => `${(title || "Book").slice(0, 60)} - ${String(part).slice(0, 60)}.wav`;

/** Save from here to the end of the chapter as one audio file. */
export async function exportChapterAudio(tab, fromPage) {
  if (!tab?.model || !(await readyVoice())) return;
  const start = fromPage || tab.currentPage();
  const dctx = new DialogueContext();
  const cast = new Cast(tab.docId);
  const list = [];
  let page = start;
  while (page <= tab.model.numPages && page < start + 80) {
    const before = list.length;
    appendSentences(list, await tab.model.page(page), page, dctx);
    const nextChapter = list.slice(Math.max(1, before)).findIndex((x) => x.heading && x.level === 2);
    if (nextChapter >= 0) { list.length = Math.max(1, before) + nextChapter; break; }
    page++;
  }
  if (!list.length) { toast("There's no text here to turn into audio."); return; }
  const chapter = (await tab.model.headingBefore(start)) || `from page ${start}`;
  const job = taskCard(`Saving “${chapter.slice(0, 40)}” as audio`);
  const out = await renderAudio(list, cast, job);
  if (!out) return;
  job.close();
  downloadBlob(voice.encodeWav(out.chunks, out.rate), fileName(tab.doc?.title, chapter));
  toast("Audio saved — it plays in any music or podcast app");
}

/** Save the rest of the book, one file per chapter (into a folder where the browser allows). */
export async function exportBookAudio(tab, fromPage = 1) {
  if (!tab?.model || !(await readyVoice())) return;
  let dir = null;
  if (window.showDirectoryPicker) {
    try { dir = await window.showDirectoryPicker({ id: "luma-audiobooks", mode: "readwrite" }); } catch { return; }
  }
  const model = tab.model;
  const dctx = new DialogueContext();
  const cast = new Cast(tab.docId);
  const job = taskCard(`Saving “${(tab.doc?.title || "book").slice(0, 36)}” as an audiobook`);
  const totalPages = model.numPages - fromPage + 1;
  let n = 0, list = [], title = (await model.headingBefore(fromPage)) || "Opening";
  const save = async () => {
    if (!list.length) return true;
    const out = await renderAudio(list, cast, { get cancelled() { return job.cancelled; }, progress: () => {} });
    if (!out) return false;
    n++;
    const name = fileName(`${String(n).padStart(2, "0")} ${tab.doc?.title || "Book"}`, title);
    const blob = voice.encodeWav(out.chunks, out.rate);
    if (dir) {
      const fh = await dir.getFileHandle(name.replace(/[\\/:*?"<>|]/g, "-"), { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
    } else downloadBlob(blob, name);
    return true;
  };
  for (let p = fromPage; p <= model.numPages; p++) {
    if (job.cancelled) return;
    const blocks = await model.page(p);
    for (const b of blocks) {
      if (b.type === "h" && b.level === 2 && list.some((s) => !s.heading)) {
        if (!(await save())) return;
        list = [];
        title = b.text;
      }
      appendSentences(list, [b], p, dctx);
    }
    job.progress((p - fromPage + 1) / totalPages, `chapter ${n + 1}`);
  }
  if (!(await save())) return;
  job.close();
  toast(dir ? `Saved ${n} chapter files to “${dir.name}”` : `Saved ${n} chapter files to your downloads`);
}
