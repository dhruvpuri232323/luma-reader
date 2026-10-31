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
    bus.on("voice-state", () => this.renderBar());
    bus.on("voice-prefs", () => { this.#dropCache(); this.renderBar(); });
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
    this.renderBar();
    this.#run(++this.token);
  }

  pause() {
    if (this.state !== "playing") return;
    this.token++;
    this.wordToken++;
    voice.stopAll();
    voice.keepAlive(false);
    this.state = "paused";
    this.renderBar();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  }

  resume() {
    if (this.state !== "paused") return;
    voice.unlockAudio();
    if (isTouch()) voice.keepAlive(true);
    this.state = "playing";
    this.renderBar();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    this.#run(++this.token);
  }

  toggle() { this.state === "playing" ? this.pause() : this.resume(); }

  async skip(delta) {
    if (!this.active) return;
    this.token++;
    this.wordToken++;
    voice.stopAll();
    if (delta > 0) await this.#extend(this.i + delta + 3);
    this.i = clamp(this.i + delta, 0, Math.max(0, this.sentences.length - 1));
    this.following = true;
    if (this.state === "playing") this.#run(++this.token);
    else this.#show(this.sentences[this.i]);
  }

  stop(silent = false) {
    this.token++;
    this.wordToken++;
    voice.stopAll();
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

  setRate(r) {
    store.setSettings({ speechRate: r });
    this.#dropCache();
    if (this.state === "playing") { this.token++; voice.stopAll(); this.#run(++this.token); }
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

  // ───────── playback loop ─────────
  async #run(token) {
    while (token === this.token) {
      if (this.i >= this.sentences.length - 4) await this.#extend(this.i + 10);
      if (token !== this.token) return;
      const s = this.sentences[this.i];
      if (!s) { this.#finished(); return; }
      if (this.sleepChapter && s.heading && this.i > this.startI) {
        this.pause();
        this.sleepChapter = false;
        this.sleepLabel = "";
        toast("Sleep timer — paused at the end of the chapter");
        return;
      }
      await this.#show(s);
      if (token !== this.token) return;
      this.speaker = s.parts[0]?.speaker || null;
      this.renderBar();
      this.#prefetch();
      await this.#speak(s, this.i, token);
      if (token !== this.token) return;
      // natural pauses: longer after headings and paragraph ends
      const gap = s.heading ? 650 : s.paraEnd ? 380 : 90;
      await new Promise((r) => setTimeout(r, gap / (voice.prefs.rate || 1)));
      if (token !== this.token) return;
      this.i++;
      const next = this.sentences[this.i];
      if (next && next.page !== s.page) this.tab.savePosition(next.page);
    }
  }

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

  #audioFor(i, k) {
    const part = this.sentences[i]?.parts[k];
    if (!part) return null;
    const v = this.#voiceFor(part);
    const key = `${i}.${k}|${v.id}|${voice.prefs.rate}`;
    if (!this.cache.has(key)) {
      const p = voice.synthNatural(speechText(part.text), v.id);
      p.catch(() => {});
      this.cache.set(key, p);
    }
    return this.cache.get(key);
  }

  #prefetch() {
    if (!this.#useNatural()) return;
    for (let j = this.i; j <= this.i + 3; j++) (this.sentences[j]?.parts || []).forEach((_, k) => this.#audioFor(j, k));
    for (const key of this.cache.keys()) if (Number(key.split(".")[0]) < this.i) this.cache.delete(key);
  }

  #dropCache() {
    voice.cancelNatural([...this.cache.values()]);
    this.cache.clear();
  }

  async #speak(s, i, token) {
    this.wordFrom = this.sentenceStart ?? 0;
    for (let k = 0; k < s.parts.length; k++) {
      if (token !== this.token) return;
      const part = s.parts[k];
      if (part.speaker !== this.speaker) { this.speaker = part.speaker; this.renderBar(); }
      const words = this.#wordsFor(part);
      const v = this.#voiceFor(part);
      // a short record of who said what (shown in "Who's who" and used by tests)
      (this.trail ||= []).push({ text: part.text, speaker: part.speaker?.name || null, voice: v.id || null });
      if (this.trail.length > 60) this.trail.shift();
      if (v.engine === "natural") {
        try {
          const audio = await this.#audioFor(i, k);
          if (token !== this.token) return;
          this.current = voice.playPcm(audio);
          this.#trackWords(words, this.current, this.current.duration);
          await this.current.done;
          if (voice.naturalSpeed() > 1.25 && !this.warnedSlow) {
            this.warnedSlow = true;
            toast("The natural voice is slower than speech on this device, so there may be short gaps.", { action: "Use device voice", onAction: () => { voice.prefs.engine = "system"; }, duration: 9000 });
          }
          continue;
        } catch { /* fall back to the device voice for this part */ }
      }
      if (token !== this.token) return;
      const sys = v.engine === "system" ? v : part.speaker ? this.cast.voiceFor(part.speaker, false) : {};
      const text = speechText(part.text);
      const spokenWords = (text.match(/\S+/g) || []).length || 1;
      let heard = false;
      this.current = voice.speakSystem(text, {
        voiceId: sys.id, pitch: sys.pitch || 1,
        onBoundary: (ci) => {
          heard = true;
          this.wordToken++;
          const n = (text.slice(0, ci).match(/\S+/g) || []).length;
          this.#markWord(words[Math.min(words.length - 1, Math.round((n * words.length) / spokenWords))]);
        },
      });
      // some voices (online ones) don't report word timing — estimate it instead
      const handle = this.current;
      setTimeout(() => { if (!heard && handle === this.current && token === this.token) this.#trackWords(words, handle, text.length / (14.5 * (voice.prefs.rate || 1))); }, 450);
      await this.current.done;
    }
    this.wordToken++;
  }

  #finished() {
    const last = this.sentences[this.sentences.length - 1];
    if (last) this.tab?.savePosition(last.page, { end: true });
    this.stop();
    toast("Finished reading aloud — that's the end of the book");
  }

  // ───────── word by word ─────────
  #wordsFor(part) {
    if (store.settings().wordHighlight === false) return [];
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
    if (!words.length || !duration) return;
    const weight = (w) => w.text.length + 2 + (/[,;:—–]["”’)]?$/.test(w.text) ? 4 : /[.!?…]["”’)]?$/.test(w.text) ? 6 : 0);
    const total = words.reduce((n, w) => n + weight(w), 0);
    const lead = Math.min(0.12, duration * 0.04), usable = Math.max(0.2, duration - lead - Math.min(0.2, duration * 0.06));
    const starts = [];
    let acc = 0;
    for (const w of words) { starts.push(lead + (acc / total) * usable); acc += weight(w); }
    const tok = ++this.wordToken;
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
      line1 = `Downloading natural voice · ${Math.round(ns.progress * 100)}% (one time) — device voice until then`;
      progress = ns.progress;
    }
    const rate = voice.prefs.rate;
    setKids(this.bar,
      progress != null ? el("div.pl-progress", { style: { "--p": progress } }) : null,
      el("div.pl-controls", {},
        el("button.icon-btn.pl-skip", { "aria-label": "Previous sentence", title: "Previous sentence", onclick: () => this.skip(-1) }, icon("skipBack", 20)),
        el("button.pl-play", { "aria-label": this.state === "playing" ? "Pause" : "Play", onclick: () => this.toggle() }, icon(this.state === "playing" ? "pause" : "play", 22)),
        el("button.icon-btn.pl-skip", { "aria-label": "Next sentence", title: "Next sentence", onclick: () => this.skip(1) }, icon("skipFwd", 20))),
      el("div.pl-info", {},
        el("p.pl-line1", {}, line1),
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
      { label: "Save this chapter as audio", icon: "download", onClick: () => exportChapterAudio(this.tab, this.sentences[this.i]?.page) },
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

/** Save from here to the end of the chapter as an audio file (natural voice, made on this device). */
export async function exportChapterAudio(tab, fromPage) {
  if (!tab?.model) return;
  if (voice.naturalState().status !== "ready") {
    const ok = await confirmDialog("Save as audio", "Audio files are made with the natural voice, which downloads once (about 90 MB) and then works offline. Download it now?", { confirm: "Download the voice" });
    if (!ok) return;
    try { await voice.loadNatural(); } catch (e) { toast(e.message, { tone: "warn" }); return; }
  }
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
  let cancelled = false;
  let closeDialog;
  const bar = el("div.pl-progress.static", { style: { "--p": 0 } });
  const label = el("p.muted.small", {}, "Starting…");
  dialog({
    title: "Saving this chapter as audio",
    body: (c, done) => { closeDialog = done; c.append(el("p", {}, `“${chapter}” — ${list.length} sentences. Made on this device, so it can take a few minutes. You can keep reading meanwhile.`), bar, label); },
    actions: [{ label: "Cancel", onClick: () => { cancelled = true; } }],
  }).then(() => { cancelled = true; });
  const chunks = [];
  let rate = 24000;
  const t0 = performance.now();
  for (let i = 0; i < list.length && !cancelled; i++) {
    const s = list[i];
    for (const part of s.parts) {
      if (cancelled) break;
      const v = store.settings().characterVoices !== false && part.speaker ? cast.voiceFor(part.speaker, true) : { id: voice.prefs.natural };
      try {
        const a = await voice.synthNatural(speechText(part.text), v.id);
        rate = a.rate;
        chunks.push(a.pcm);
      } catch { /* skip this bit */ }
    }
    chunks.push(new Float32Array(Math.round(rate * (s.heading ? 0.8 : s.paraEnd ? 0.45 : 0.12))));
    const done = (i + 1) / list.length;
    bar.style.setProperty("--p", done);
    const elapsed = (performance.now() - t0) / 1000;
    const left = (elapsed / done) * (1 - done);
    label.textContent = `${Math.round(done * 100)}% · about ${left > 90 ? Math.round(left / 60) + " min" : Math.max(1, Math.round(left)) + " s"} left`;
  }
  if (cancelled) return;
  closeDialog?.();
  const name = `${(tab.doc?.title || "Book").slice(0, 60)} — ${chapter.slice(0, 50)}.wav`.replace(/[\\/:*?"<>|]/g, "");
  downloadBlob(voice.encodeWav(chunks, rate), name);
  toast("Audio saved — it plays in any music or podcast app");
}
