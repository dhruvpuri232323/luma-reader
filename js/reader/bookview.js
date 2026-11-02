// Book view: a book's text set as real pages — your font, size, spacing and
// margins; two-page spreads on wide screens; page turns in the book's own
// feel (flip, curl, slide, fade or an e-ink flash, with a page-turn sound)
// by tap, swipe, arrow keys or trackpad — or one continuous scroll. Running
// headers, time left, footnote pop-ups, a reading ruler, and highlight layers
// for notes, saved words, hard words, search and read-aloud.
import { el, bus, clamp, debounce, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { renderPageToCanvas } from "./pdf.js";
import { wordCount } from "./bookmodel.js";
import { TextIndex, setHighlight, highlightsSupported } from "./textindex.js";
import { annotationsFor, COLORS } from "./annotate.js";
import { REFLOW_FONTS } from "../core/feel.js";
import { icon } from "../ui/icons.js";
import { wordAtPoint } from "./lookup.js";
import { feelFor, playTurn } from "../core/bookfeel.js";
import { beginTurn } from "./pageturn.js";
import { etaText } from "./ocr.js";
import { translatedModel, bookLanguage, pairFor, savedTranslation } from "./booktranslate.js";

const WPM_KEY = "luma.wpm";
const MEASURE = { narrow: 27, balanced: 32, wide: 40 }; // max text column width, in em
const reduced = () => document.documentElement.dataset.motion === "reduce";

export function fmtDuration(min) {
  if (!isFinite(min)) return "";
  if (min < 1) return "less than a minute";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export class BookView {
  constructor(tab) {
    this.tab = tab;
    this.model = tab.model;
    this.tr = { mode: "original", map: null, from: null, to: null }; // translation: original | both | translation
    this.chunk = -1; // paged: the chunk on screen · scroll: chunk at the top of the screen
    this.loaded = []; // scroll mode: chunk indices currently in the page, in order
    this.spread = 0;
    this.cols = 1;
    this.totalCols = 1;
    this.geom = null;
    this.scroll = false;
    this.indexCache = new Map();
    this.annRanges = [];
    this.hardWords = [];
    this.query = "";
    this.wpm = clamp(Number(localStorage.getItem(WPM_KEY)) || 230, 80, 700);
    this.lastTurn = Date.now();

    this.flow = el("div.bk-flow.book-text", { lang: "en" });
    this.clip = el("div.bk-clip", {}, this.flow);
    this.headL = el("span.bk-run-l");
    this.headR = el("span.bk-run-r");
    this.footL = el("span.bk-run-l");
    this.footR = el("span.bk-run-r");
    this.ruler = el("div.bk-ruler", { hidden: true, "aria-hidden": "true" });
    this.sheet = el("div.bk-sheet", {},
      el("div.bk-head", {}, this.headL, this.headR),
      this.clip,
      el("div.bk-foot", {}, this.footL, this.footR),
      this.ruler);
    this.status = el("div.bk-status", { hidden: true });
    this.prevBtn = el("button.bk-turn.prev", { "aria-label": "Previous page", onclick: () => this.prev() }, icon("left", 26));
    this.nextBtn = el("button.bk-turn.next", { "aria-label": "Next page", onclick: () => this.next() }, icon("right", 26));
    this.el = el("div.bookview", { tabindex: "0", hidden: true }, this.sheet, this.prevBtn, this.nextBtn, this.status);

    this.ro = new ResizeObserver(debounce(() => this.relayout(), 120));
    this.ro.observe(this.el);
    this.offSettings = bus.on("settings", () => this.relayout());
    this.offPlayer = bus.on("player-layout", () => this.relayout());
    this.offChange = bus.on("change", ({ coll, rec, source }) => {
      if (coll === "settings" && rec?.id === "settings" && source === "remote") this.relayout();
      if (coll === "annotations" && rec.docId === this.tab.docId) this.refreshHighlights();
      if (coll === "words") this.refreshVocab();
    });
    document.fonts?.addEventListener?.("loadingdone", () => this.relayout());
    this.#wireInput();
    this.#wireScroll();
  }

  get visible() { return !this.el.hidden && this.el.clientWidth > 0; }

  /** The text shown: the book itself, or its translation. */
  get viewModel() {
    if (this.tr.mode !== "translation" || !this.tr.map) return this.model;
    if (this.trModel?.map !== this.tr.map || this.trModel.base !== this.model) this.trModel = { map: this.tr.map, base: this.model, model: translatedModel(this.model, this.tr.map) };
    return this.trModel.model;
  }

  /** Show the original, the translation, or both — paragraph by paragraph. */
  async setTranslation({ mode, map = this.tr.map, from = this.tr.from, to = this.tr.to }) {
    const page = this.chunk >= 0 || this.loaded.length ? this.page : this.tab.currentPage?.() || 1;
    this.tr = { mode: map ? mode : "original", map, from, to };
    this.flow.lang = this.tr.mode === "translation" ? to : this.tr.from && this.tr.mode === "original" ? this.tr.from : (this.bookLang || "en");
    this.el.dataset.tr = this.tr.mode;
    this.chunk = -1; this.loaded = []; this.indexCache.clear();
    if (this.scroll) setKids(this.flow);
    if (!this.el.hidden && this.tab.mode === "book") await this.goToPage(page, { animate: false });
  }

  pagesPerChunk() { return clamp(Math.round(22000 / this.model.avgChars), 3, 40); }
  chunkOf(p) { return Math.floor((p - 1) / this.pagesPerChunk()); }
  chunkRange(ci) {
    const n = this.pagesPerChunk();
    return [ci * n + 1, Math.min(this.model.numPages, (ci + 1) * n)];
  }
  get lastChunk() { return this.chunkOf(this.model.numPages); }
  /** Pages currently in the DOM. */
  get loadedRange() {
    if (this.scroll && this.loaded.length) return [this.chunkRange(this.loaded[0])[0], this.chunkRange(this.loaded[this.loaded.length - 1])[1]];
    return this.chunkRange(Math.max(0, this.chunk));
  }

  // ───────── geometry ─────────
  #measure() {
    const s = store.settings();
    const W = this.el.clientWidth, H = this.el.clientHeight;
    const phone = W < 720;
    const fs = s.reflowSize;
    const scroll = s.bookLayout === "scroll";
    const spread = !scroll && !phone && W >= 1000 && s.bookSpread !== "single";
    const cols = spread ? 2 : 1;
    const outer = phone ? 0 : 64;
    const margin = phone ? 22 : clamp(Math.round(W * 0.035), 36, 64);
    const avail = (W - outer * 2) / cols - margin * 2;
    const colW = Math.floor(Math.min((MEASURE[s.reflowWidth] || 32) * fs, avail));
    const gap = margin * 2;
    const headH = phone ? 34 : 46, footH = phone ? 34 : 46;
    const vpad = phone ? 6 : 22;
    const listening = Boolean(this.el.closest(".listening"));
    const below = listening ? (phone ? 128 : 78) : 0;
    const flowH = Math.max(160, Math.floor(H - vpad * 2 - headH - footH - below));
    return { W, H, cols, colW, gap, margin, flowH, flowW: cols * colW + (cols - 1) * gap, step: colW + gap, phone, headH, footH, vpad, below, scroll, lineH: fs * s.reflowLeading };
  }

  #applyGeometry() {
    const s = store.settings();
    const g = (this.geom = this.#measure());
    this.cols = g.cols;
    const st = this.el.style;
    const set = (k, v) => st.setProperty(k, v);
    set("--bk-col", g.colW + "px");
    set("--bk-gap", g.gap + "px");
    set("--bk-margin", g.margin + "px");
    set("--bk-flow-w", g.flowW + "px");
    set("--bk-flow-h", g.flowH + "px");
    set("--bk-head", g.headH + "px");
    set("--bk-foot", g.footH + "px");
    set("--bk-vpad", g.vpad + "px");
    set("--bk-below", g.below + "px");
    set("--bk-font", REFLOW_FONTS[s.reflowFont]?.stack || REFLOW_FONTS.literata.stack);
    set("--bk-size", s.reflowSize + "px");
    set("--bk-leading", s.reflowLeading);
    set("--bk-line", g.lineH + "px");
    this.el.classList.toggle("spread", g.cols === 2);
    this.el.classList.toggle("phone", g.phone);
    this.el.classList.toggle("scroll", g.scroll);
    this.el.classList.toggle("justify", s.justify !== false);
    this.el.classList.toggle("spaced", s.paraStyle === "spaced");
    this.ruler.hidden = !s.ruler;
    this.flow.style.columnCount = g.scroll ? "" : g.cols;
    this.#sizeFigures();
  }

  #sizeFigures() {
    const g = this.geom;
    if (!g) return;
    for (const fig of this.flow.querySelectorAll(".bk-fig:not(.src)")) {
      const ar = Number(fig.dataset.aspect) || 0.7;
      let w = g.colW, h = w / ar;
      if (h > g.flowH - 12) { h = g.flowH - 12; w = h * ar; }
      fig.style.width = Math.floor(w) + "px";
      fig.style.height = Math.floor(h) + "px";
    }
  }

  #countCols() {
    if (this.scroll) { this.totalCols = 1; return; }
    const g = this.geom;
    this.totalCols = Math.max(1, Math.round((this.flow.scrollWidth + g.gap) / g.step));
  }

  get totalSpreads() { return Math.max(1, Math.ceil(this.totalCols / this.cols)); }

  // ───────── content ─────────
  async open(page) {
    this.el.hidden = false;
    this.#setStatus("Setting the pages…");
    await this.model.ready();
    if (this.model.looksScanned || this.model.looksGarbled) {
      await this.tab.scanCheck?.catch(() => {});
      let job = this.tab.ocrJob;
      // stopped earlier: choosing Book view again reads it now
      if (this.model.looksScanned && job?.state !== "running" && store.settings().readScans !== false) job = this.tab.readScannedNow() || job;
      if ((this.model.looksScanned || this.model.looksGarbled) && job?.state === "running") {
        // read the whole book first, then show it
        this.#showReading(job);
        const pages = await job.promise.catch(() => null);
        this.#hideReading();
        if (pages) await this.model.ready();
      }
    }
    if (this.model.looksScanned) {
      this.#setStatus(this.tab.ocrJob?.error || store.settings().readScans === false
        ? "This PDF is made of scanned page images and its pages couldn't be read as text. Page view shows it as it is."
        : "This PDF is made of scanned page images, so there's no text to set as a book. Page view shows it as it is.", true);
      return false;
    }
    await this.#restoreTranslation().catch(() => {});
    this.#applyGeometry();
    const wantScroll = this.geom.scroll;
    if (wantScroll !== this.scroll || this.chunk < 0) { this.scroll = wantScroll; this.chunk = -1; this.loaded = []; }
    if (this.chunk >= 0 && !this.scroll) { this.flow.style.transform = "translate3d(0,0,0)"; this.#countCols(); }
    await this.goToPage(page || 1, { animate: false });
    if (this.geom.phone && !localStorage.getItem("luma.bookHint")) {
      localStorage.setItem("luma.bookHint", "1");
      bus.emit("toast", this.scroll ? "Scroll to read · tap a word to define it" : "Swipe or tap the margins to turn pages · tap a word to define it");
    }
    this.refreshHighlights();
    this.refreshVocab();
    this.#setStatus("");
    return true;
  }

  /** "Reading your scanned book — 34 of 210 pages · about 2 min left" */
  #showReading(job) {
    this.#setStatus("");
    const bar = el("span.ocr-bar-fill");
    const count = el("p.ocr-count");
    const card = el("div.ocr-card", { role: "status", "aria-live": "polite" },
      el("div.ocr-icon", { "aria-hidden": "true" }, icon("book", 28)),
      el("h3", {}, "Reading your scanned book"),
      el("p.ocr-sub", {}, "Luma is reading every page on this device, so you can look up words, listen and search. It's ready in one go, and only happens once."),
      el("div.ocr-bar", {}, bar),
      count,
      el("div.row.wrap.ocr-actions", {},
        el("button.btn.sm", { type: "button", onclick: () => this.tab.setMode("pdf") }, icon("pages", 15), "See the original pages meanwhile"),
        el("button.btn.sm.ghost", { type: "button", onclick: () => { job.cancel(); } }, "Stop")));
    const update = () => {
      const pct = job.total ? (job.done / job.total) * 100 : 0;
      bar.style.width = pct.toFixed(1) + "%";
      count.textContent = `${job.done} of ${job.total} pages · ${etaText(job.eta())}`;
    };
    update();
    this.offReading?.();
    this.offReading = bus.on("ocr-progress", (e) => { if (e.docId === this.tab.docId) update(); });
    this.readingEl?.remove();
    this.readingEl = el("div.ocr-screen", {}, card);
    this.el.append(this.readingEl);
  }

  /** Translating the whole book: one progress screen, then the book in both languages. */
  showTranslating(job) {
    this.hideTranslating();
    const bar = el("span.ocr-bar-fill");
    const count = el("p.ocr-count");
    const card = el("div.ocr-card", { role: "status", "aria-live": "polite" },
      el("div.ocr-icon", { "aria-hidden": "true" }, icon("translate", 28)),
      el("h3", {}, "Translating your book"),
      el("p.ocr-sub", {}, "Every paragraph is translated whole, on this computer. When it's done you'll see the original and the translation side by side — and it will be on your phone too."),
      el("div.ocr-bar", {}, bar),
      count,
      el("div.row.wrap.ocr-actions", {},
        el("button.btn.sm.ghost", { type: "button", onclick: () => job.cancel() }, "Stop")));
    const update = () => {
      bar.style.width = (job.total ? (job.done / job.total) * 100 : 0).toFixed(1) + "%";
      count.textContent = job.total ? `${job.done} of ${job.total} paragraphs · ${etaText(job.eta())}` : "Gathering the paragraphs…";
    };
    update();
    this.offTranslating = bus.on("tr-progress", (e) => { if (e.docId === this.tab.docId) update(); });
    this.translatingEl = el("div.ocr-screen.tr-screen", {}, card);
    this.el.append(this.translatingEl);
  }

  hideTranslating() {
    this.offTranslating?.();
    this.offTranslating = null;
    this.translatingEl?.remove();
    this.translatingEl = null;
  }

  /** Come back to a book the way you left it: original, translation, or both. */
  async #restoreTranslation() {
    let mode = "original";
    try { mode = localStorage.getItem(`luma.tr.${this.tab.docId}`) || "original"; } catch {}
    if (mode === "original" || this.tr.map) return;
    this.tab.bookLang ||= await bookLanguage(this.model).catch(() => "en");
    const pair = pairFor(this.tab.bookLang);
    const t = await savedTranslation(this.tab.docId, pair.to).catch(() => null);
    if (!t) return;
    this.tr = { mode, map: t.map, from: t.from, to: t.to };
    this.flow.lang = mode === "translation" ? t.to : t.from;
    this.el.dataset.tr = mode;
  }

  #hideReading() {
    this.offReading?.();
    this.offReading = null;
    this.readingEl?.remove();
    this.readingEl = null;
  }

  #setStatus(msg, sticky = false) {
    this.status.hidden = !msg;
    this.status.textContent = msg;
    this.status.classList.toggle("sticky", sticky);
  }

  /** Build the DOM for one chunk of pages. */
  async #renderChunk(ci) {
    const [a, b] = this.chunkRange(ci);
    const frag = document.createDocumentFragment();
    let words = 0;
    let afterHeading = false;
    let lastP = null;
    const pages = await Promise.all(Array.from({ length: b - a + 1 }, (_, n) => this.viewModel.page(a + n)));
    const both = this.tr.mode === "both" && this.tr.map;
    const trLang = this.tr.to;
    // the translation of a paragraph or heading, under it (side by side, paragraph by paragraph)
    const pair = (blk, p, tag = "p") => {
      const t = both ? this.tr.map.get(blk.id) : null;
      return t ? el(`${tag}.bk-tr` + (blk.type === "h" ? ".bk-tr-h" : ""), { lang: trLang, dataset: { for: blk.id, page: p } }, t) : null;
    };
    for (let p = a; p <= b; p++) {
      const blocks = pages[p - a];
      for (const blk of blocks) {
        let node;
        if (blk.type === "img" && blk.src) {
          node = el("figure.bk-b.bk-fig.src", { dataset: { bid: blk.id, page: p } }, el("img", { src: blk.src, alt: blk.alt || "", loading: "lazy", referrerpolicy: "no-referrer" }));
          afterHeading = false;
        } else if (blk.type === "img") {
          node = el("figure.bk-b.bk-fig", { dataset: { bid: blk.id, page: p, aspect: blk.aspect } }, el("img", { alt: `Page ${p}` }));
          afterHeading = false;
        } else if (blk.type === "hr") {
          node = el("div.bk-b.bk-break", { dataset: { bid: blk.id, page: p }, "aria-hidden": "true" });
          afterHeading = false;
        } else if (blk.type === "quote") {
          node = el("blockquote.bk-b.bk-quote", { dataset: { bid: blk.id, page: p }, lang: blk.translated ? trLang : null }, blk.text);
          afterHeading = false;
        } else if (blk.type === "h") {
          node = el(`h${blk.level}.bk-b.bk-h`, { dataset: { bid: blk.id, page: p }, lang: blk.translated ? trLang : null }, blk.text);
          afterHeading = blk.level === 2 ? "chapter" : "section";
        } else {
          const trailing = frag.lastChild?.classList?.contains("bk-tr") && frag.lastChild.dataset.for === lastP?.dataset.bid; // "both": the translation sits after its paragraph
          if (blk.cont && lastP && lastP.parentNode === frag && (frag.lastChild === lastP || trailing)) {
            // paragraph runs on from the previous PDF page: continue it seamlessly
            const span = el("span.bk-b.bk-cont", { dataset: { bid: blk.id, page: p } }, blk.text);
            addNotes(span, blk);
            lastP.append(" ", span);
            words += wordCount(blk.text);
            continue;
          }
          node = el("p.bk-b" + (blk.cont ? ".cont" : "") + (afterHeading ? ".first" : "") + (afterHeading === "chapter" && blk.text.length >= 120 && /^[\p{L}\p{N}]/u.test(blk.text) && !both ? ".drop" : ""),
            { dataset: { bid: blk.id, page: p }, lang: blk.translated ? trLang : null }, blk.text);
          addNotes(node, blk);
          lastP = node;
          afterHeading = false;
        }
        words += wordCount(blk.text || "");
        frag.append(node);
        if (both && (blk.type === "p" || blk.type === "h" || blk.type === "quote")) {
          const t = pair(blk, p, blk.type === "h" ? "div" : "p");
          if (t) { frag.append(t); words += wordCount(t.textContent); }
        }
      }
    }
    return { frag, words };
  }

  async loadChunk(ci) {
    ci = clamp(ci, 0, this.lastChunk);
    if (this.scroll) return this.#resetScroll(ci);
    if (ci === this.chunk) return;
    const { frag, words } = await this.#renderChunk(ci);
    this.chunk = ci;
    this.chunkWords = words;
    this.indexCache.clear();
    setKids(this.flow, frag);
    this.#applyGeometry();
    this.#countCols();
    this.#afterLoad();
  }

  #afterLoad() {
    this.#renderFigures();
    const [a] = this.loadedRange;
    this.chapterBefore = "";
    this.viewModel.headingBefore(a - 1).then((t) => { this.chapterBefore = t; this.#updateRunning(); }).catch(() => {});
    this.refreshHighlights();
    this.refreshVocab();
    this.refreshHard();
    if (this.query) this.highlightQuery(this.query);
  }

  // scroll layout: chunks are sections stacked vertically and loaded as you go
  async #resetScroll(ci) {
    if (this.loaded.includes(ci)) return;
    const { frag, words } = await this.#renderChunk(ci);
    this.loaded = [ci];
    this.chunk = ci;
    this.chunkWords = words;
    this.indexCache.clear();
    setKids(this.flow, el("section.bk-chunk", { dataset: { ci } }, frag));
    this.flow.style.transform = "";
    this.clip.scrollTop = 0;
    this.#applyGeometry();
    this.#afterLoad();
  }

  async #extendScroll(dir) {
    if (this.extending) return;
    const ci = dir > 0 ? this.loaded[this.loaded.length - 1] + 1 : this.loaded[0] - 1;
    if (ci < 0 || ci > this.lastChunk) return;
    this.extending = true;
    try {
      const { frag } = await this.#renderChunk(ci);
      const sec = el("section.bk-chunk", { dataset: { ci } }, frag);
      if (dir > 0) {
        this.flow.append(sec);
        this.loaded.push(ci);
        if (this.loaded.length > 4) { const first = this.flow.firstElementChild; const h = first.offsetHeight; first.remove(); this.loaded.shift(); this.clip.scrollTop -= h; }
      } else {
        const before = this.flow.scrollHeight;
        this.flow.prepend(sec);
        this.loaded.unshift(ci);
        this.clip.scrollTop += this.flow.scrollHeight - before;
        if (this.loaded.length > 4) { this.flow.lastElementChild.remove(); this.loaded.pop(); }
      }
      this.indexCache.clear();
      this.#sizeFigures();
      this.#afterLoad();
    } finally {
      this.extending = false;
    }
  }

  #wireScroll() {
    const onScroll = debounce(() => {
      if (!this.scroll) return;
      if (this.clip.scrollTop > 40) this.moved = true;
      const c = this.clip;
      if (c.scrollTop + c.clientHeight > c.scrollHeight - c.clientHeight * 1.5) this.#extendScroll(1);
      else if (c.scrollTop < c.clientHeight * 0.8) this.#extendScroll(-1);
      const first = this.visibleBlocks()[0];
      const sec = first?.closest(".bk-chunk");
      if (sec) this.chunk = Number(sec.dataset.ci);
      this.#afterMove();
    }, 90);
    this.clip.addEventListener("scroll", onScroll, { passive: true });
  }

  async #renderFigures() {
    for (const fig of [...this.flow.querySelectorAll(".bk-fig:not(.src)")]) {
      if (!this.tab.pdf) return;
      const img = fig.querySelector("img");
      if (img.src) continue;
      try {
        const canvas = await renderPageToCanvas(this.tab.pdf, Number(fig.dataset.page), Math.min(900, this.geom.colW * 1.5));
        img.src = canvas.toDataURL("image/jpeg", 0.86);
      } catch { /* skip */ }
    }
  }

  // ───────── navigation ─────────
  #show(spread, { animate = true } = {}) {
    if (this.scroll) return;
    this.spread = clamp(spread, 0, this.totalSpreads - 1);
    const x = this.spread * this.cols * this.geom.step;
    const style = feelFor(this.tab.doc).turn;
    this.flow.classList.toggle("animate", animate && style === "slide" && !reduced());
    this.flow.style.transform = `translate3d(${-x}px,0,0)`;
    this.#afterMove();
  }

  #afterMove() {
    if (this.scroll) {
      const c = this.clip;
      this.prevBtn.disabled = this.loaded[0] === 0 && c.scrollTop < 4;
      this.nextBtn.disabled = this.loaded[this.loaded.length - 1] === this.lastChunk && c.scrollTop + c.clientHeight >= c.scrollHeight - 4;
    } else {
      this.prevBtn.disabled = this.chunk <= 0 && this.spread <= 0;
      this.nextBtn.disabled = this.chunk >= this.lastChunk && this.spread >= this.totalSpreads - 1;
    }
    this.tab.savePosition(this.page, { end: this.moved && this.nextBtn.disabled });
    this.updateEdges();
    this.#updateRunning();
    bus.emit("tab-page", this.tab);
  }

  get atEnd() { return this.nextBtn.disabled; }

  /** Words visible right now (for reading speed and auto-advance). */
  visibleWords() {
    return this.visibleBlocks().reduce((n, b) => n + wordCount(b.textContent), 0);
  }

  async next({ auto = false } = {}) {
    if (!this.geom) return;
    this.moved = true;
    if (!auto) bus.emit("user-nav", this.tab);
    const now = Date.now();
    const dt = now - this.lastTurn;
    if (!auto && dt > 4000 && dt < 600000) {
      const sample = clamp(this.visibleWords() / (dt / 60000), 80, 700);
      this.wpm = Math.round(this.wpm * 0.8 + sample * 0.2);
      localStorage.setItem(WPM_KEY, String(this.wpm));
    }
    this.lastTurn = now;
    if (this.scroll) {
      this.clip.scrollBy({ top: this.clip.clientHeight - this.geom.lineH * 2, behavior: reduced() ? "auto" : "smooth" });
      return;
    }
    if (this.spread < this.totalSpreads - 1) return this.#turn(1, () => this.#show(this.spread + 1, { animate: true }), { auto });
    if (this.chunk < this.lastChunk) return this.#turn(1, () => this.#swapChunk(this.chunk + 1, "next"), { auto });
  }

  async prev() {
    if (!this.geom) return;
    bus.emit("user-nav", this.tab);
    this.lastTurn = Date.now();
    if (this.scroll) {
      this.clip.scrollBy({ top: -(this.clip.clientHeight - this.geom.lineH * 2), behavior: reduced() ? "auto" : "smooth" });
      return;
    }
    if (this.spread > 0) return this.#turn(-1, () => this.#show(this.spread - 1, { animate: true }));
    if (this.chunk > 0) return this.#turn(-1, () => this.#swapChunk(this.chunk - 1, "prev"));
  }

  /** A page turn in this book's feel: the sound, then the animation (slide is
   *  the text gliding along; the others are drawn over the page). */
  async #turn(dir, apply, { auto = false, silent = false } = {}) {
    const f = feelFor(this.tab.doc);
    if (!silent) playTurn(f.sound, { dir, volume: f.volume * (auto ? 0.45 : 1) });
    const style = f.turn;
    if (style === "slide" || style === "none" || !f.ms || !this.sheet.animate || !this.visible) return apply();
    const r = this.sheet.getBoundingClientRect();
    const host = this.el.getBoundingClientRect();
    const rect = { left: r.left - host.left, top: r.top - host.top, width: r.width, height: r.height };
    const turn = beginTurn(this.el, rect, this.sheet.cloneNode(true));
    this.turning = turn;
    await apply();
    await turn.run({ style, ms: f.ms, dir, spread: this.cols === 2, newNode: this.sheet.cloneNode(true), paper: getComputedStyle(this.sheet).backgroundColor });
    if (this.turning === turn) this.turning = null;
  }

  /** Page edges that thicken on the left as you read, and the book's cover
   *  around them (laptops and tablets, page layout). */
  updateEdges() {
    const pane = this.el.closest(".tab-pane");
    const on = pane?.classList.contains("feel-edges") && !this.scroll && !this.el.classList.contains("phone") && this.model?.numPages > 1;
    if (!on) { this.sheet.style.removeProperty("--sheet-shadow"); this.el.classList.remove("edged"); return; }
    const N = 7;
    const prog = clamp((this.page - 1) / Math.max(1, this.model.numPages - 1), 0, 1);
    const left = this.cols === 2 ? Math.round(prog * N) : 0;
    const right = this.cols === 2 ? N - left : Math.max(1, Math.round((1 - prog) * N));
    const line = "rgb(60 45 25 / .16)";
    const layers = [];
    for (let i = 1; i <= Math.max(left, right); i++) {
      const c = i % 2 ? "var(--paper)" : line;
      if (i <= left) layers.push(`${-i}px ${i * 0.45}px 0 ${c}`);
      if (i <= right) layers.push(`${i}px ${i * 0.45}px 0 ${c}`);
    }
    const cover = pane.dataset.cover;
    const n = Math.max(left, right);
    if (cover === "device") layers.push("0 0 0 16px var(--cover)", "0 0 0 17px rgb(255 255 255 / .06)");
    else if (cover === "leather") layers.push(`0 0 0 ${n + 6}px var(--cover)`, `0 0 0 ${n + 7}px #B8913A`, `0 0 0 ${n + 12}px var(--cover)`);
    else if (cover === "cloth") layers.push(`0 0 0 ${n + 9}px var(--cover)`, `0 0 0 ${n + 10}px rgb(0 0 0 / .25)`);
    else if (cover === "paper") layers.push(`0 0 0 ${n + 3}px var(--cover)`);
    layers.push("0 26px 50px -16px rgb(0 0 0 / .5)");
    this.sheet.style.setProperty("--sheet-shadow", layers.join(", "));
    this.el.classList.add("edged");
  }

  async #swapChunk(ci, dir) {
    const slide = feelFor(this.tab.doc).turn === "slide"; // the other turns cover the swap with a picture of the old page
    if (slide) this.flow.classList.add("fade");
    await this.loadChunk(ci);
    this.#show(dir === "next" ? 0 : this.totalSpreads - 1, { animate: false });
    requestAnimationFrame(() => this.flow.classList.remove("fade"));
  }

  #colOfRect(rect) {
    const fr = this.flow.getBoundingClientRect();
    return Math.floor((rect.left - fr.left + 2) / this.geom.step);
  }

  async goToPage(p, { animate = true } = {}) {
    p = clamp(Math.round(p) || 1, 1, this.model.numPages);
    const ci = this.chunkOf(p);
    if (this.scroll) {
      if (!this.loaded.includes(ci)) await this.#resetScroll(ci);
      const target = [...this.flow.querySelectorAll(".bk-b")].find((n) => Number(n.dataset.page) >= p);
      if (target) this.#scrollToRect(target.getBoundingClientRect(), 0.04, animate);
      this.#afterMove();
      return;
    }
    if (ci !== this.chunk) await this.loadChunk(ci);
    const target = [...this.flow.querySelectorAll(".bk-b")].find((n) => Number(n.dataset.page) >= p);
    const rect = target?.getClientRects()[0];
    const col = rect ? this.#colOfRect(rect) : 0;
    this.#show(Math.floor(col / this.cols), { animate });
  }

  #scrollToRect(rect, at = 0.32, smooth = true) {
    const cr = this.clip.getBoundingClientRect();
    const top = this.clip.scrollTop + (rect.top - cr.top) - cr.height * at;
    this.clip.scrollTo({ top: Math.max(0, top), behavior: smooth && !reduced() ? "smooth" : "auto" });
  }

  async ensureBlock(bid) {
    const page = Number(bid.split(":")[0]);
    const ci = this.chunkOf(page);
    if (this.scroll ? !this.loaded.includes(ci) : ci !== this.chunk) await this.loadChunk(ci);
    return this.flow.querySelector(`[data-bid="${bid}"]`);
  }

  /** Bring a range into view (read-aloud follows the voice with this). */
  reveal(range, { smooth = true } = {}) {
    if (!range || !this.geom) return;
    const rect = [...range.getClientRects()].find((r) => r.width > 0);
    if (!rect) return;
    if (this.scroll) {
      const cr = this.clip.getBoundingClientRect();
      // keep the voice a third of the way down, like a teleprompter
      if (rect.top < cr.top + cr.height * 0.18 || rect.bottom > cr.top + cr.height * 0.62) this.#scrollToRect(rect, 0.33, smooth);
      return;
    }
    const spread = Math.floor(this.#colOfRect(rect) / this.cols);
    if (spread !== this.spread) this.#turn(spread > this.spread ? 1 : -1, () => this.#show(spread), { silent: true }); // the voice turns the page; no rustle over it
  }

  /** Place the reading ruler on the line under a point (pointer, tap, or the word being read). */
  placeRuler(clientY, clientX) {
    if (this.ruler.hidden || !this.geom) return;
    const cr = this.clip.getBoundingClientRect();
    if (clientY < cr.top || clientY > cr.bottom) return;
    const lh = this.geom.lineH;
    let top = null, height = lh;
    const x = clientX ?? cr.left + cr.width / 2;
    const pt = caretAt(x, clientY);
    if (pt?.node?.nodeType === 3 && this.flow.contains(pt.node) && pt.node.length) {
      const r = document.createRange();
      const o = Math.min(pt.offset, pt.node.length - 1);
      r.setStart(pt.node, o); r.setEnd(pt.node, o + 1);
      const rect = [...r.getClientRects()].find((q) => q.height > 0);
      if (rect && Math.abs(rect.top + rect.height / 2 - clientY) < lh * 1.5) { top = rect.top + rect.height / 2 - lh / 2; }
    }
    if (top == null) {
      const off = this.scroll ? this.clip.scrollTop % lh : 0;
      top = cr.top + Math.floor((clientY - cr.top + off) / lh) * lh - off;
    }
    const sr = this.sheet.getBoundingClientRect();
    this.ruler.style.transform = `translateY(${Math.round(top - sr.top - lh * 0.08)}px)`;
    this.ruler.style.height = Math.round(height * 1.16) + "px";
    this.ruler.classList.add("on");
  }

  /** Ruler follows read-aloud: put it on the line of a range. */
  rulerTo(range) {
    if (this.ruler.hidden || !range) return;
    const rect = [...range.getClientRects()].find((r) => r.width > 0);
    if (rect) this.placeRuler(rect.top + rect.height / 2, rect.left + Math.min(4, rect.width / 2));
  }

  visibleBlocks() {
    const cr = this.clip.getBoundingClientRect();
    const out = [];
    const list = this.scroll ? this.flow.querySelectorAll(".bk-chunk > .bk-b") : this.flow.children;
    for (const n of list) {
      const hit = [...n.getClientRects()].some((r) => (this.scroll
        ? r.bottom > cr.top + 2 && r.top < cr.bottom - 2
        : r.right > cr.left + 1 && r.left < cr.right - 1) && r.width > 0);
      if (hit) out.push(n);
      else if (out.length) break;
    }
    return out;
  }

  get page() {
    const first = this.visibleBlocks()[0];
    return Number(first?.dataset.page) || this.loadedRange[0];
  }

  /** First block and character offset at the top of the current view (to start reading aloud). */
  startPoint() {
    const first = this.visibleBlocks()[0];
    if (!first) return null;
    const cr = this.clip.getBoundingClientRect();
    const rects = [...first.getClientRects()];
    let offset = 0;
    const startsBefore = this.scroll ? rects[0]?.top < cr.top - 1 : rects[0]?.left < cr.left - 1;
    if (startsBefore) {
      const pt = caretAt(cr.left + 4, cr.top + 6);
      if (pt && first.contains(pt.node)) offset = (new TextIndex([first]).segs.find((s) => s.node === pt.node)?.start ?? 0) + pt.offset;
    }
    return { bid: first.dataset.bid, offset };
  }

  async relayout() {
    if (!this.visible || this.chunk < 0) return;
    const wantScroll = store.settings().bookLayout === "scroll";
    const anchorPage = this.page;
    if (wantScroll !== this.scroll) {
      this.scroll = wantScroll;
      this.chunk = -1;
      this.loaded = [];
      this.#applyGeometry();
      await this.goToPage(anchorPage, { animate: false });
      return;
    }
    const anchor = this.visibleBlocks()[0]?.dataset.bid;
    this.#applyGeometry();
    if (this.scroll) {
      const target = anchor && this.flow.querySelector(`[data-bid="${anchor}"]`);
      if (target) this.#scrollToRect(target.getBoundingClientRect(), 0.04, false);
    } else {
      this.flow.classList.remove("animate");
      this.flow.style.transform = "translate3d(0,0,0)";
      this.#countCols();
      const target = anchor && this.flow.querySelector(`[data-bid="${anchor}"]`);
      const rect = target?.getClientRects()[0];
      this.#show(rect ? Math.floor(this.#colOfRect(rect) / this.cols) : 0, { animate: false });
    }
    this.refreshHighlights();
    this.refreshVocab();
    this.refreshHard();
  }

  #updateRunning() {
    const doc = this.tab.doc;
    const g = this.geom;
    if (!g) return;
    const vis = this.visibleBlocks();
    const all = [...this.flow.querySelectorAll(".bk-b:not(.bk-cont)")];
    let chapter = this.chapterBefore;
    const firstVis = vis[0];
    for (const n of all) {
      if (n === firstVis) break;
      if (n.matches("h2, h3")) chapter = n.textContent;
    }
    if (firstVis?.matches("h2, h3")) chapter = firstVis.textContent;
    const page = this.page;
    const total = this.model.numPages;
    const pct = Math.round((page / total) * 100);
    // time left in this chapter: words from here to the next chapter heading
    let chapterMin = null;
    const lastVis = vis[vis.length - 1];
    let passed = false, words = 0;
    for (const n of all) {
      if (n === lastVis) { passed = true; continue; }
      if (!passed) continue;
      if (n.matches("h2")) { chapterMin = words / this.wpm; break; }
      words += wordCount(n.textContent);
    }
    const bookMin = this.model.wordsLeft(page) / this.wpm;
    const left = chapterMin != null ? `${fmtDuration(chapterMin)} left in chapter` : `${fmtDuration(bookMin)} left in book`;
    if (g.cols === 2) {
      this.headL.textContent = doc?.title || "";
      this.headR.textContent = chapter || "";
      this.footL.textContent = `p. ${page} of ${total}`;
      this.footR.textContent = `${pct}% · ${left}`;
    } else {
      this.headL.textContent = chapter || doc?.title || "";
      this.headR.textContent = "";
      this.footL.textContent = `p. ${page} of ${total} · ${pct}%`;
      this.footR.textContent = left;
    }
    this.timeLeft = left;
  }

  // ───────── highlight layers ─────────
  indexForPage(p) {
    if (!this.indexCache.has(p)) {
      const els = [...this.flow.querySelectorAll(`.bk-b[data-page="${p}"]:not(.bk-fig)`)];
      this.indexCache.set(p, els.length ? new TextIndex(els) : null);
    }
    return this.indexCache.get(p);
  }

  refreshHighlights() {
    if (!highlightsSupported() || this.chunk < 0 || this.tab.mode !== "book") return;
    const [a, b] = this.loadedRange;
    const by = Object.fromEntries(Object.keys(COLORS).map((k) => [k, []]));
    this.annRanges = [];
    for (const ann of annotationsFor(this.tab.docId)) {
      if (ann.page < a || ann.page > b || !ann.text) continue;
      const idx = this.indexForPage(ann.page) || this.indexForPage(ann.page + 1);
      const r = idx?.rangeOf(ann.text);
      if (!r) continue;
      (by[ann.color] || by.sun).push(r);
      this.annRanges.push({ ann, range: r });
    }
    for (const [k, list] of Object.entries(by)) setHighlight(`luma-${k}`, list);
  }

  annotationAt(x, y) {
    const pt = caretAt(x, y);
    if (!pt) return null;
    return this.annRanges.find(({ range }) => {
      try { return range.isPointInRange(pt.node, pt.offset); } catch { return false; }
    })?.ann || null;
  }

  #wordRanges(words, limit = 1500) {
    const list = words.filter((w) => w && w.length > 2 && /^[\p{L}' -]+$/u.test(w));
    if (!list.length) return [];
    const esc = list.sort((x, y) => y.length - x.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`\\b(?:${esc.join("|")})(?:s|es|ed|d|ing|ly)?\\b`, "giu");
    const ranges = [];
    const walker = document.createTreeWalker(this.flow, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && ranges.length < limit; n = walker.nextNode()) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(n.data))) {
        const r = document.createRange();
        r.setStart(n, m.index);
        r.setEnd(n, m.index + m[0].length);
        ranges.push(r);
      }
    }
    return ranges;
  }

  refreshVocab() {
    if (!highlightsSupported() || this.chunk < 0 || this.tab.mode !== "book") return;
    if (store.settings().underlineSaved === false) { setHighlight("luma-vocab", []); return; }
    setHighlight("luma-vocab", this.#wordRanges(store.list("words").map((w) => w.word)));
  }

  /** Hard words found by the pre-scan (set by the "Words here" panel). */
  setHard(words) { this.hardWords = words || []; this.refreshHard(); }
  refreshHard() {
    if (!highlightsSupported() || this.tab.mode !== "book") return;
    const saved = new Set(store.list("words").map((w) => w.word));
    setHighlight("luma-hard", store.settings().markHard ? this.#wordRanges(this.hardWords.filter((w) => !saved.has(w)), 2500) : []);
  }

  /** Highlight search matches in the loaded text and show the first on `page`. */
  highlightQuery(q, page) {
    this.query = q || "";
    if (!highlightsSupported()) return;
    if (!q) { setHighlight("luma-find", []); return; }
    const needle = q.toLowerCase();
    const ranges = [];
    const walker = document.createTreeWalker(this.flow, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const hay = n.data.toLowerCase();
      let i = hay.indexOf(needle);
      while (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + needle.length);
        ranges.push(r);
        i = hay.indexOf(needle, i + needle.length);
      }
    }
    setHighlight("luma-find", ranges);
    if (page) {
      const first = ranges.find((r) => Number(r.startContainer.parentElement?.closest(".bk-b")?.dataset.page) >= page);
      if (first) this.reveal(first, { smooth: false });
    }
  }

  deactivate() {
    for (const k of Object.keys(COLORS)) setHighlight(`luma-${k}`, []);
    for (const k of ["luma-vocab", "luma-hard", "luma-find"]) setHighlight(k, []);
  }

  activate() { this.relayout(); }

  // ───────── input ─────────
  #wireInput() {
    let down = null;
    this.el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".bk-turn, .fn")) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType, drag: false };
    });
    this.el.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse" && !this.listening) this.placeRuler(e.clientY, e.clientX);
      if (!down || down.type === "mouse" || this.scroll) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.drag && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4 && !hasSelection()) {
        down.drag = true;
        this.flow.classList.remove("animate");
      }
      if (down.drag) {
        const x = this.spread * this.cols * this.geom.step;
        this.flow.style.transform = `translate3d(${-x + dx * 0.9}px,0,0)`;
      }
    });
    const end = (e) => {
      if (!down) return;
      const d = down;
      down = null;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (d.drag) {
        e.stopPropagation();
        if (dx < -50) { this.#show(this.spread, { animate: false }); this.next(); }
        else if (dx > 50) { this.#show(this.spread, { animate: false }); this.prev(); }
        else this.#show(this.spread);
        return;
      }
      const quick = performance.now() - d.t < 350 && Math.hypot(dx, dy) < 10;
      if (!quick || hasSelection()) return;
      if (d.type !== "mouse") this.placeRuler(e.clientY, e.clientX);
      if (d.type === "mouse" || this.scroll) {
        if (d.type !== "mouse" && !wordAtPoint(e.clientX, e.clientY, this.el)) bus.emit("book-tap-center", this.tab);
        return;
      }
      // Thin strips at the very edges always turn the page. Elsewhere a word
      // wins (tap = define); blank space in the outer fifths turns the page and
      // the middle shows/hides the controls.
      const r = this.el.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      if (fx < 0.09) { e.stopPropagation(); this.prev(); return; }
      if (fx > 0.91) { e.stopPropagation(); this.next(); return; }
      if (wordAtPoint(e.clientX, e.clientY, this.el)) return;
      if (fx < 0.22) { e.stopPropagation(); this.prev(); }
      else if (fx > 0.78) { e.stopPropagation(); this.next(); }
      else bus.emit("book-tap-center", this.tab);
    };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", () => { if (down?.drag) this.#show(this.spread); down = null; });

    let acc = 0, lock = 0;
    this.el.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) return;
      if (this.scroll) { bus.emit("user-nav", this.tab); return; } // native scrolling
      e.preventDefault();
      if (performance.now() < lock) return;
      acc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(acc) > 70) {
        if (acc > 0) this.next(); else this.prev();
        acc = 0;
        lock = performance.now() + 420;
      }
    }, { passive: false });
    this.clip.addEventListener("touchmove", () => { if (this.scroll) bus.emit("user-nav", this.tab); }, { passive: true });

    // footnote pop-ups
    this.el.addEventListener("click", (e) => {
      const fn = e.target.closest(".fn");
      if (!fn) return;
      e.stopPropagation();
      showNote(fn);
    });
  }

  destroy() {
    this.ro.disconnect();
    this.offSettings?.();
    this.offPlayer?.();
    this.offChange?.();
    this.el.remove();
  }
}

/** Insert footnote markers (no text of their own, so text offsets stay exact). */
function addNotes(node, blk) {
  if (!blk.notes?.length) return;
  const textNode = node.firstChild;
  if (!textNode || textNode.nodeType !== 3) return;
  const sorted = [...blk.notes].sort((a, b) => b.at - a.at);
  for (const n of sorted) {
    if (n.at < 0 || n.at > textNode.data.length) continue;
    const after = textNode.splitText(n.at);
    node.insertBefore(el("button.fn", { type: "button", dataset: { n: n.n, text: n.text }, "aria-label": `Footnote ${n.n}: ${n.text}` }), after);
  }
}

let notePop = null;
function showNote(fn) {
  notePop?.remove();
  const r = fn.getBoundingClientRect();
  notePop = el("div.fn-pop", { role: "note" }, el("strong", {}, fn.dataset.n), " ", fn.dataset.text);
  document.body.append(notePop);
  const w = notePop.offsetWidth, h = notePop.offsetHeight;
  notePop.style.left = clamp(r.left + r.width / 2 - w / 2, 10, innerWidth - w - 10) + "px";
  notePop.style.top = (r.top - h - 10 > 10 ? r.top - h - 10 : r.bottom + 10) + "px";
  requestAnimationFrame(() => notePop?.classList.add("in"));
  setTimeout(() => document.addEventListener("pointerdown", function off(e) {
    if (!notePop?.contains(e.target)) { notePop?.remove(); notePop = null; document.removeEventListener("pointerdown", off, true); }
  }, true), 0);
}

function hasSelection() {
  const s = document.getSelection();
  return Boolean(s && !s.isCollapsed && s.toString().trim());
}

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}
