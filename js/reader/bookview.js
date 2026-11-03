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
import { typeFor, splitHeading, numberWords, roman } from "../core/typeset.js";
import { icon } from "../ui/icons.js";
import { wordAtPoint } from "./lookup.js";
import { feelFor, playTurn } from "../core/bookfeel.js";
import { beginTurn } from "./pageturn.js";
import { PageCurl, CurlHand } from "./pagecurl.js";
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
    this.cols = 1; // text columns on screen
    this.pages = 1; // pages on screen (2 in a spread)
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
    this.hand = new CurlHand(this.#curlAdapter());
    this.zoomPill = el("div.bk-zoom-pill", { "aria-live": "polite", hidden: true });
    this.el.append(this.zoomPill);
    this.#wireInput();
    this.#wireScroll();
  }

  // ───────── taking a page by hand (see pagecurl.js) ─────────
  #curlAdapter() {
    return {
      host: () => this.el,
      pageRect: () => this.sheet.getBoundingClientRect(),
      spread: () => this.pages === 2,
      enabled: () => Boolean(this.geom) && !this.scroll && this.visible && feelFor(this.tab.doc).turn === "curl" && !this.turnPending,
      canTurn: (dir) => this.#canTurn(dir),
      snapshot: () => this.sheet.cloneNode(true),
      begin: (dir) => this.#beginHandTurn(dir),
      fresh: () => this.sheet.cloneNode(true),
      revert: () => this.#revertHandTurn(),
      sound: (dir) => { const f = feelFor(this.tab.doc); playTurn(f.sound, { dir, volume: f.volume }); },
      committed: (dir) => { this.handBack = null; this.#counted(dir); },
      stiffness: () => feelFor(this.tab.doc).stiffness || 1,
      copy: (n) => n.cloneNode(true),
      hotWidth: () => clamp(Math.round((this.geom?.margin ?? 48) * 1.1), 40, 76),
      hasSelection: () => hasSelection(),
      turn: (dir, corner) => (dir > 0 ? this.next({ corner }) : this.prev({ corner })),
    };
  }

  #canTurn(dir) {
    if (!this.geom || this.scroll) return false;
    return dir > 0 ? this.spread < this.totalSpreads - 1 || this.chunk < this.lastChunk : this.spread > 0 || this.chunk > 0;
  }

  /** What moves the book one page (or spread) that way, or null at the end. */
  #stepApply(dir) {
    if (dir > 0) {
      if (this.spread < this.totalSpreads - 1) return () => this.#show(this.spread + 1, { animate: true });
      if (this.chunk < this.lastChunk) return () => this.#swapChunk(this.chunk + 1, "next");
    } else {
      if (this.spread > 0) return () => this.#show(this.spread - 1, { animate: true });
      if (this.chunk > 0) return () => this.#swapChunk(this.chunk - 1, "prev");
    }
    return null;
  }

  async #beginHandTurn(dir) {
    bus.emit("user-nav", this.tab);
    this.handBack = { chunk: this.chunk, spread: this.spread };
    if (dir > 0) this.moved = true;
    const apply = this.#stepApply(dir);
    this.turnPending = true;
    try { await apply?.(); } finally { this.turnPending = false; }
  }

  /** The page was let go before it turned: put the old one back (still hidden under the curl). */
  async #revertHandTurn() {
    const b = this.handBack;
    this.handBack = null;
    if (!b) return;
    if (this.chunk !== b.chunk) await this.loadChunk(b.chunk);
    this.#show(b.spread, { animate: false });
  }

  /** Reading speed, from how long each page took (forward turns by hand). */
  #counted(dir, auto = false) {
    const now = Date.now();
    const dt = now - this.lastTurn;
    if (dir > 0 && !auto && dt > 4000 && dt < 600000) {
      const sample = clamp(this.visibleWords() / (dt / 60000), 80, 700);
      this.wpm = Math.round(this.wpm * 0.8 + sample * 0.2);
      localStorage.setItem(WPM_KEY, String(this.wpm));
    }
    this.lastTurn = now;
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
    const ty = typeFor(feelFor(this.tab.doc), s);
    const W = this.el.clientWidth, H = this.el.clientHeight;
    const phone = W < 720;
    const fs = Math.round((this.sizeOverride ?? s.reflowSize) * ty.k * 10) / 10;
    const leading = Math.round(s.reflowLeading * ty.leadK * 100) / 100;
    const scroll = s.bookLayout === "scroll";
    const spread = !scroll && !phone && W >= 1000 && s.bookSpread !== "single";
    const pages = spread ? 2 : 1;
    const outer = phone ? 0 : 64;
    const margin = Math.round((phone ? 22 : clamp(Math.round(W * 0.035), 36, 64)) * (phone ? Math.min(1.1, Math.max(0.8, ty.marginK)) : ty.marginK));
    const pageAvail = (W - outer * 2) / pages - margin * 2; // text width one page can hold
    const measureW = (MEASURE[s.reflowWidth] || 32) * fs;
    let perPage = 1, colW = Math.floor(Math.min(measureW, pageAvail)), gap = margin * 2;
    if (!scroll && ty.perPage === 2) {
      // two columns on each page, as long as each still holds a comfortable line
      const inner = Math.round(fs * (pages === 2 ? 2.1 : 1.6));
      const two = Math.floor((Math.min(pageAvail, measureW * 1.55) - inner) / 2);
      if (two >= fs * (ty.colsChosen ? 9.5 : 12.5)) { perPage = 2; colW = two; gap = inner; }
    }
    const cols = pages * perPage;
    const headH = phone ? 34 : 46, footH = phone ? 34 : 46;
    const vpad = phone ? 6 : 22;
    const listening = Boolean(this.el.closest(".listening"));
    const below = listening ? (phone ? 128 : 78) : 0;
    const flowH = Math.max(160, Math.floor(H - vpad * 2 - headH - footH - below));
    return { W, H, cols, pages, perPage, colW, gap, margin, flowH, flowW: cols * colW + (cols - 1) * gap, step: colW + gap, phone, headH, footH, vpad, below, scroll, fs, leading, lineH: fs * leading, ty };
  }

  #applyGeometry() {
    const s = store.settings();
    const g = (this.geom = this.#measure());
    const ty = g.ty;
    this.cols = g.cols;
    this.pages = g.pages;
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
    set("--bk-font", ty.stack);
    set("--bk-head-font", ty.headStack);
    set("--bk-size", g.fs + "px");
    set("--bk-leading", g.leading);
    set("--bk-line", g.lineH + "px");
    set("--bk-weight", { medium: 500, bold: 600 }[s.textWeight] || 400);
    set("--bk-tracking", { tight: "-0.012em", loose: "0.03em" }[s.letterSpacing] || "0em");
    set("--bk-words", { tight: "-0.04em", loose: "0.12em" }[s.wordSpacing] || "0em");
    set("--bk-ornament", JSON.stringify(ty.ornament));
    const d = this.el.dataset;
    d.design = ty.design;
    d.folio = ty.folio;
    this.el.classList.toggle("spread", g.pages === 2);
    this.el.classList.toggle("cols2", g.perPage === 2);
    this.el.classList.toggle("phone", g.phone);
    this.el.classList.toggle("scroll", g.scroll);
    this.el.classList.toggle("justify", s.justify !== false);
    this.el.classList.toggle("spaced", s.paraStyle === "spaced");
    this.el.classList.toggle("no-hyphens", s.hyphens === false);
    this.el.classList.toggle("no-heads", !ty.heads);
    this.el.classList.toggle("no-drop", !ty.drop);
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
      bus.emit("toast", this.scroll ? "Scroll to read · pinch to change the text size · tap a word to define it" : "Swipe to turn the page · pinch to change the text size · tap a word to define it");
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
          node = el(`h${blk.level}.bk-b.bk-h`, { dataset: { bid: blk.id, page: p }, lang: blk.translated ? trLang : null }, ...headingParts(blk.text, blk.level));
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
          node = el("p.bk-b" + (blk.cont ? ".cont" : "") + (afterHeading ? ".first" : "") + (afterHeading === "chapter" ? ".chap" : "") + (afterHeading === "chapter" && blk.text.length >= 120 && /^[\p{L}\p{N}]/u.test(blk.text) && !both ? ".drop" : ""),
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
    this.viewModel.headingBefore(a - 1).then((t) => { this.chapterBefore = splitHeading(t)?.title || t; this.#updateRunning(); }).catch(() => {});
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

  async next({ auto = false, corner } = {}) {
    if (!this.geom) return;
    this.moved = true;
    if (!auto) bus.emit("user-nav", this.tab);
    if (this.hand?.busy || this.turnPending) return; // a page is already in your hand
    this.#counted(1, auto);
    if (this.scroll) {
      this.clip.scrollBy({ top: this.clip.clientHeight - this.geom.lineH * 2, behavior: reduced() ? "auto" : "smooth" });
      return;
    }
    const apply = this.#stepApply(1);
    if (apply) return this.#turn(1, apply, { auto, corner });
  }

  async prev({ corner } = {}) {
    if (!this.geom) return;
    bus.emit("user-nav", this.tab);
    if (this.hand?.busy || this.turnPending) return;
    this.lastTurn = Date.now();
    if (this.scroll) {
      this.clip.scrollBy({ top: -(this.clip.clientHeight - this.geom.lineH * 2), behavior: reduced() ? "auto" : "smooth" });
      return;
    }
    const apply = this.#stepApply(-1);
    if (apply) return this.#turn(-1, apply, { corner });
  }

  /** A page turn in this book's feel: the sound, then the animation (slide is
   *  the text gliding along; curl is the page taken by its corner; the others
   *  are drawn over the page). */
  async #turn(dir, apply, { auto = false, silent = false, corner = "bottom" } = {}) {
    if (this.hand?.busy || this.turnPending) return;
    const f = feelFor(this.tab.doc);
    if (!silent) playTurn(f.sound, { dir, volume: f.volume * (auto ? 0.45 : 1) });
    const style = f.turn;
    if (style === "slide" || style === "none" || !f.ms || !this.sheet.animate || !this.visible) return apply();
    const r = this.sheet.getBoundingClientRect();
    const host = this.el.getBoundingClientRect();
    const rect = { left: r.left - host.left, top: r.top - host.top, width: r.width, height: r.height };
    if (style === "curl") {
      this.hand?.unpeek(true);
      const curl = new PageCurl(this.el, rect, { dir, spread: this.pages === 2, corner, oldNode: this.sheet.cloneNode(true), stiffness: f.stiffness || 1 });
      this.turnPending = true;
      try { await apply(); } finally { this.turnPending = false; }
      curl.ready(this.sheet.cloneNode(true));
      await curl.play(f.ms);
      curl.finish();
      return;
    }
    const turn = beginTurn(this.el, rect, this.sheet.cloneNode(true));
    this.turning = turn;
    await apply();
    await turn.run({ style, ms: f.ms, dir, spread: this.pages === 2, newNode: this.sheet.cloneNode(true), paper: getComputedStyle(this.sheet).backgroundColor });
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
    const left = this.pages === 2 ? Math.round(prog * N) : 0;
    const right = this.pages === 2 ? N - left : Math.max(1, Math.round((1 - prog) * N));
    const line = "rgb(60 45 25 / .16)";
    const layers = [];
    for (let i = 1; i <= Math.max(left, right); i++) {
      const c = i % 2 ? "var(--paper)" : line;
      if (i <= left) layers.push(`${-i}px ${i * 0.45}px 0 ${c}`);
      if (i <= right) layers.push(`${i}px ${i * 0.45}px 0 ${c}`);
    }
    // the cover (drawn behind the pages, see editions.css) reaches just past the thickest edge
    const cover = pane.dataset.cover;
    const n = Math.max(left, right);
    const pad = { device: 18, leather: n + 14, cloth: n + 11, paper: Math.round(n * 0.5) + 2 }[cover] ?? 0;
    this.sheet.style.setProperty("--cover-pad", pad + "px");
    if (cover === "none") layers.push("0 26px 50px -16px rgb(0 0 0 / .5)");
    else layers.push("0 1px 2px rgb(0 0 0 / .12)");
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

  /** Go straight to a block (a chapter heading): its page, or the top of the screen when scrolling. */
  async goToBlock(bid) {
    if (!bid || !this.geom) return false;
    const node = await this.ensureBlock(bid).catch(() => null);
    const rect = node && [...node.getClientRects()].find((r) => r.width > 0 || r.height > 0);
    if (!rect) return false;
    this.moved = true;
    if (this.scroll) { this.#scrollToRect(rect, 0.04, false); this.#afterMove(); }
    else this.#show(Math.floor(this.#colOfRect(rect) / this.cols), { animate: false });
    return true;
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

  async relayout({ at = null } = {}) {
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
    this.el.__turn?.finish?.();
    this.hand?.unpeek(true);
    // keep the same words in front of you: the word under your fingers (pinch),
    // else the first word on the page
    const caret = at || this.#caretAnchor();
    const anchor = this.visibleBlocks()[0]?.dataset.bid;
    this.#applyGeometry();
    if (this.scroll) {
      if (!(caret && this.#restoreCaret(caret))) {
        const target = anchor && this.flow.querySelector(`[data-bid="${anchor}"]`);
        if (target) this.#scrollToRect(target.getBoundingClientRect(), 0.04, false);
      }
    } else {
      this.flow.classList.remove("animate");
      this.flow.style.transform = "translate3d(0,0,0)";
      this.#countCols();
      if (!(caret && this.#restoreCaret(caret))) {
        const target = anchor && this.flow.querySelector(`[data-bid="${anchor}"]`);
        const rect = target?.getClientRects()[0];
        this.#show(rect ? Math.floor(this.#colOfRect(rect) / this.cols) : 0, { animate: false });
      }
    }
    this.refreshHighlights();
    this.refreshVocab();
    this.refreshHard();
  }

  /** A point in the text to hold on to while the pages are set again. */
  #caretAnchor(x, y) {
    if (!this.geom) return null;
    const cr = this.clip.getBoundingClientRect();
    const pts = [];
    if (x != null && x > cr.left && x < cr.right && y > cr.top && y < cr.bottom) pts.push([x, y]);
    if (!this.scroll && !pts.length) {
      // paged: the first letter on the page (a chapter opening can leave the top of a page empty)
      const c = this.#caretAtCol(this.spread * this.cols);
      const rect = c && charRect(c.node, c.offset);
      if (rect) return { node: c.node, offset: c.offset, dy: rect.top - cr.top };
    }
    for (const k of [0.5, 1.5, 2.5]) pts.push([cr.left + 4, cr.top + this.geom.lineH * k]);
    for (const [px, py] of pts) {
      const pt = caretAt(px, py);
      if (pt?.node?.nodeType !== 3 || !this.flow.contains(pt.node)) continue;
      const rect = charRect(pt.node, pt.offset);
      if (!rect) continue;
      return { node: pt.node, offset: pt.offset, dy: rect.top - cr.top };
    }
    return null;
  }

  #restoreCaret(a) {
    if (!a.node.isConnected) return false;
    const rect = charRect(a.node, a.offset);
    if (!rect) return false;
    if (this.scroll) {
      this.clip.scrollTop += rect.top - this.clip.getBoundingClientRect().top - a.dy;
      this.#afterMove();
    } else this.#show(Math.floor(this.#colOfRect(rect) / this.cols), { animate: false });
    return true;
  }

  /** Pinch from anywhere on the reading screen (the bars too). */
  pinch(f, x, y) { this.#zoomBy(f, x, y); }

  /** Pinch: make the text bigger or smaller, live, keeping your place. */
  #zoomBy(f, x, y) {
    if (!this.geom || !isFinite(f) || f <= 0) return;
    const s = store.settings();
    const z = (this.zoomState ||= { size: this.sizeOverride ?? s.reflowSize, at: null });
    z.at ||= this.#caretAnchor(x, y);
    z.size = clamp(z.size * f, 12, 40);
    const px = Math.round(z.size);
    if (px !== (this.sizeOverride ?? s.reflowSize)) {
      this.sizeOverride = px;
      if (!z.raf) z.raf = requestAnimationFrame(() => { z.raf = 0; this.relayout({ at: z.at }); });
      this.zoomPill.hidden = false;
      this.zoomPill.textContent = `Text ${px} px`;
      this.zoomPill.classList.add("on");
    }
    clearTimeout(z.timer);
    z.timer = setTimeout(() => this.#endZoom(), 520);
  }

  async #endZoom() {
    const z = this.zoomState;
    this.zoomState = null;
    this.zoomPill.classList.remove("on");
    clearTimeout(this.pillTimer);
    this.pillTimer = setTimeout(() => { if (!this.zoomPill.classList.contains("on")) this.zoomPill.hidden = true; }, 400);
    const px = this.sizeOverride;
    if (px == null) return;
    if (z?.raf) { cancelAnimationFrame(z.raf); await this.relayout({ at: z.at }); }
    if (px !== store.settings().reflowSize) await store.setSettings({ reflowSize: px }); // keeps it for every book, on every device
    this.sizeOverride = null;
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
      if (n.matches("h2, h3")) chapter = headingText(n);
    }
    if (firstVis?.matches("h2, h3")) chapter = headingText(firstVis);
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
    this.timeLeft = left;
    if (this.scroll) {
      setKids(this.headL, el("span.run-c", {}, chapter || doc?.title || ""));
      setKids(this.headR);
      setKids(this.footL, el("span.run-s.a", {}, `p. ${page} of ${total} · ${pct}%`), el("span.run-s.b", {}, left));
      setKids(this.footR);
      return;
    }
    // the page number of each page on screen (the right page starts where its first line is)
    const mid = this.sheet.getBoundingClientRect().left + this.sheet.getBoundingClientRect().width / 2;
    let rightPage = page;
    if (g.pages === 2) {
      const first = vis.find((n) => [...n.getClientRects()].some((r) => r.width > 0 && r.left >= mid));
      rightPage = Number(first?.dataset.page) || page;
    }
    const ty = g.ty;
    // the recto's chapter: the last heading before its first line
    let chapterR = chapter;
    if (g.pages === 2 && vis.length) {
      for (const n of vis) {
        if ([...n.getClientRects()].some((r) => r.width > 0 && r.left >= mid)) break;
        if (n.matches("h2, h3")) chapterR = headingText(n);
      }
      const firstR = vis.find((n) => [...n.getClientRects()].some((r) => r.width > 0 && r.left >= mid));
      if (firstR?.matches("h2, h3")) chapterR = headingText(firstR);
    }
    const base = this.spread * g.cols;
    const catchL = g.pages === 2 ? this.#firstWordOfCol(base + g.perPage) : "";
    const catchR = this.#firstWordOfCol(base + g.cols);
    const title = doc?.title || "";
    const item = (k, side) => {
      const v = { t: title, c: (side === "r" && g.pages === 2 ? chapterR : chapter) || title, f: String(side === "r" ? rightPage : page), w: side === "r" ? catchR : catchL }[k];
      return v ? el("span.run-" + k, {}, v) : null;
    };
    const run = RUN[ty.design] || RUN.modern;
    const heads = ty.heads ? (g.pages === 2 ? [run.hl, run.hr] : [run.h1, []]) : [[], []];
    let foots;
    if (ty.folio === "stats") foots = null;
    else if (ty.folio === "off") foots = [[], []];
    else foots = g.pages === 2 ? [run.fl, run.fr] : [run.f1, []];
    const folioInHead = (ks) => ks.filter((k) => k !== "f" || ty.folio === "book");
    setKids(this.headL, ...folioInHead(heads[0]).map((k) => item(k, g.pages === 2 ? "l" : "r")));
    setKids(this.headR, ...folioInHead(heads[1]).map((k) => item(k, "r")));
    if (foots) {
      setKids(this.footL, ...foots[0].map((k) => item(k, g.pages === 2 ? "l" : "r")));
      setKids(this.footR, ...foots[1].map((k) => item(k, "r")));
    } else if (g.pages === 2) {
      setKids(this.footL, el("span.run-s", {}, `p. ${page} of ${total}`));
      setKids(this.footR, el("span.run-s", {}, `${pct}% · ${left}`));
    } else {
      setKids(this.footL, el("span.run-s.a", {}, `p. ${page} of ${total} · ${pct}%`), el("span.run-s.b", {}, left));
      setKids(this.footR);
    }
    this.sheet.style.setProperty("--bk-progress", (page / total).toFixed(4));
  }

  /** The first word of a column (for catchwords), or "". */
  #firstWordOfCol(ci) {
    const c = this.#caretAtCol(ci);
    if (!c) return "";
    const rest = c.node.data.slice(c.offset).trimStart();
    const w = (/^[^\s]+/.exec(rest) || [""])[0].replace(/[,.;:!?)”’"]+$/, "");
    return w.length > 18 ? w.slice(0, 18) : w;
  }

  /** The first character of text in a column: { node, offset }, or null. */
  #caretAtCol(ci) {
    const g = this.geom;
    if (!g || ci >= this.totalCols) return null;
    const fr = this.flow.getBoundingClientRect();
    const x0 = fr.left + ci * g.step - 1;
    const inCol = (r) => r.width > 0 && r.left >= x0 && r.left < x0 + g.colW + 2;
    for (const b of this.flow.children) {
      const rects = [...b.getClientRects()];
      if (!rects.some(inCol)) { if (rects.some((r) => r.width > 0 && r.left > x0 + g.colW)) return null; continue; }
      if (b.matches(".bk-fig, .bk-break")) return null;
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.length) continue;
        range.selectNodeContents(n);
        if (![...range.getClientRects()].some(inCol)) continue;
        let lo = 0, hi = n.length - 1;
        while (lo < hi) {
          const m = (lo + hi) >> 1;
          range.setStart(n, m); range.setEnd(n, m + 1);
          const r = [...range.getClientRects()].find((q) => q.width > 0);
          if (r && r.left >= x0) hi = m; else lo = m + 1;
        }
        return { node: n, offset: lo };
      }
      return null;
    }
    return null;
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
    const touches = new Map(); // pointers on the screen (two fingers = pinch)
    let pinch = null;
    this.el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2) {
        // two fingers: pinch the text bigger or smaller
        this.hand.cancel();
        if (down?.drag) this.#show(this.spread);
        down = null;
        const [a, b] = [...touches.values()];
        pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]), f: 1 };
        return;
      }
      if (e.button !== 0 || e.target.closest(".bk-turn, .fn")) return;
      if (!this.scroll && this.hand.down(e)) { down = { hand: true }; return; }
      down = { x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType, drag: false };
    });
    this.el.addEventListener("pointermove", (e) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && touches.size === 2) {
        const [a, b] = [...touches.values()];
        const f = Math.hypot(a[0] - b[0], a[1] - b[1]) / (pinch.d0 || 1);
        this.#zoomBy(f / pinch.f, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        pinch.f = f;
        return;
      }
      if (e.pointerType === "mouse" && !e.buttons) {
        if (!this.listening) this.placeRuler(e.clientY, e.clientX);
        if (!this.scroll) this.hand.hover(e.clientX, e.clientY);
      }
      if (!down) return;
      if (down.hand || down.curl) { this.hand.move(e); return; }
      if (down.type === "mouse" || this.scroll) return;
      if (!down.drag && this.hand.move(e)) { down.curl = true; return; } // the page follows your finger
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
    const lift = (e) => {
      touches.delete(e.pointerId);
      if (pinch) { if (touches.size < 2) pinch = null; return true; }
      return false;
    };
    const end = (e) => {
      if (lift(e)) return;
      const d = down;
      down = null;
      if (!d) { this.hand.up(e); return; }
      if (d.hand || d.curl) { this.hand.up(e); e.stopPropagation(); return; }
      this.hand.up(e);
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
      const corner = e.clientY > r.top + r.height * 0.55 ? "bottom" : "top";
      if (fx < 0.09) { e.stopPropagation(); this.prev({ corner }); return; }
      if (fx > 0.91) { e.stopPropagation(); this.next({ corner }); return; }
      if (wordAtPoint(e.clientX, e.clientY, this.el)) return;
      if (fx < 0.22) { e.stopPropagation(); this.prev({ corner }); }
      else if (fx > 0.78) { e.stopPropagation(); this.next({ corner }); }
      else bus.emit("book-tap-center", this.tab);
    };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", (e) => {
      lift(e);
      if (down?.drag) this.#show(this.spread);
      this.hand.cancel();
      down = null;
    });
    this.el.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !down) this.hand.leave(); });

    let acc = 0, lock = 0;
    this.el.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) {
        // a trackpad pinch (or Ctrl + wheel): the text grows or shrinks where you are
        e.preventDefault();
        this.#zoomBy(clamp(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.006)), 0.9, 1.1), e.clientX, e.clientY);
        return;
      }
      if (this.scroll) { bus.emit("user-nav", this.tab); return; } // native scrolling
      e.preventDefault();
      if (this.hand.wheel(e)) { bus.emit("user-nav", this.tab); return; } // a two-finger swipe takes the page with it
      if (performance.now() < lock || this.hand.busy) return;
      acc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(acc) > 70) {
        if (acc > 0) this.next(); else this.prev();
        acc = 0;
        lock = performance.now() + 420;
      }
    }, { passive: false });
    // Safari's trackpad pinch
    let gScale = 1;
    this.el.addEventListener("gesturestart", (e) => { e.preventDefault(); gScale = 1; });
    this.el.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      this.#zoomBy(e.scale / gScale, e.clientX, e.clientY);
      gScale = e.scale;
    });
    this.el.addEventListener("gestureend", (e) => e.preventDefault());
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

// Where each design puts its running heads and page numbers (spread: left and
// right page; single: one page). t title · c chapter · f page number · w catchword.
const RUN = {
  modern: { hl: ["t"], hr: ["c"], h1: ["c"], fl: ["f"], fr: ["f"], f1: ["f"] },
  trade: { hl: ["f", "t"], hr: ["c", "f"], h1: ["c", "f"], fl: [], fr: [], f1: [] },
  fine: { hl: ["t"], hr: ["c"], h1: ["c"], fl: ["f"], fr: ["f"], f1: ["f"] },
  pocket: { hl: ["f", "t"], hr: ["c", "f"], h1: ["c", "f"], fl: [], fr: [], f1: [] },
  antique: { hl: ["f", "t"], hr: ["c", "f"], h1: ["c", "f"], fl: ["w"], fr: ["w"], f1: ["w"] },
  magazine: { hl: ["t"], hr: ["c"], h1: ["t"], fl: ["f", "t"], fr: ["c", "f"], f1: ["c", "f"] },
  ereader: { hl: ["t"], hr: ["c"], h1: ["t"], fl: ["f"], fr: ["f"], f1: ["f"] },
};

/** A chapter heading as number + title, so each design can set them its own way. */
function headingParts(text, level) {
  const sp = level === 2 ? splitHeading(text) : null;
  if (!sp) return [el("span.ch-title", {}, text)];
  return [
    el("span.ch-num", { dataset: { words: numberWords(sp.n), roman: roman(sp.n), n: String(sp.n), ...(sp.label ? { label: sp.label } : {}) } }, sp.lead),
    el("span.ch-sep", {}, sp.sep),
    el("span.ch-title", {}, sp.title),
  ];
}
const headingText = (h) => h.querySelector(".ch-title")?.textContent || h.textContent;

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

/** The box of one character of a text node (null when it isn't laid out). */
function charRect(node, offset) {
  const r = document.createRange();
  const o = clamp(offset, 0, Math.max(0, node.length - 1));
  r.setStart(node, o);
  r.setEnd(node, Math.min(node.length, o + 1));
  return [...r.getClientRects()].find((q) => q.height > 0) || null;
}

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}
