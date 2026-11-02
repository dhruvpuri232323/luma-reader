// One open book: the original pages (PDF.js viewer) and, on demand, the same
// book set as text (Book view). Remembers which view you used for each book.
import { el, debounce, clamp, bus } from "../core/util.js";
import { store } from "../data/store.js";
import { recordPosition } from "../data/library.js";
import { openPdf, pdfViewerLib, pageText, closePdf } from "./pdf.js";
import { BookModel } from "./bookmodel.js";
import { savedOcr, readScanned, ocrJob, overlayPage } from "./ocr.js";
import { forget as forgetText, indexInBackground } from "../data/fulltext.js";
import { BookView } from "./bookview.js";
import { TextBookModel } from "./textmodel.js";
import { parseEpub } from "../data/importers.js";
import { feelFor, applyFeel } from "../core/bookfeel.js";
import { turnPdf } from "./pageturn.js";
import { wordAtPoint } from "./lookup.js";
import { icon } from "../ui/icons.js";

const zoomKey = (id) => `luma.zoom.${id}`;
const rotKey = (id) => `luma.rot.${id}`;
const modeKey = (id) => `luma.mode.${id}`;

export class Tab {
  constructor(docId) {
    this.docId = docId;
    this.pdf = null;
    this.viewer = null;
    this.model = null;
    this.book = null;
    this.mode = "pdf"; // pdf | book
    this.state = "idle"; // idle | loading | ready | missing | error
    this.textCache = new Map();
    this.el = el("div.tab-pane", { dataset: { doc: docId } });
    this.container = el("div.pdf-scroller", { tabindex: "0" }, el("div.pdfViewer"));
    this.el.append(this.container);
    this.savePosition = debounce((p, opts) => recordPosition(this.docId, p, opts), 900);
    this.pdfLayout = "scroll";
    this.#wirePaged();
    applyFeel(this);
  }

  /** The book's feel changed (here or on another device), or the theme did. */
  refreshFeel() {
    const f = applyFeel(this);
    if (!f) return;
    if (this.viewer && this.state === "ready" && (f.pdfPages || "scroll") !== this.pdfLayout) this.setPdfLayout(f.pdfPages || "scroll");
    this.book?.updateEdges();
  }

  get doc() { return store.get("docs", this.docId); }
  get kind() { return this.doc?.kind || "pdf"; }
  get hasPages() { return this.kind === "pdf"; }
  get page() { return this.viewer?.currentPageNumber || 1; }
  get pages() { return this.pdf?.numPages || this.model?.numPages || this.doc?.pages || 0; }

  async load(startPage) {
    if (this.state === "loading" || this.state === "ready") return;
    this.state = "loading";
    this.emit();
    const blob = await store.getFile(this.docId);
    if (!blob) { this.state = "missing"; this.emit(); return; }
    if (this.kind !== "pdf") return this.#loadText(blob, startPage);
    try {
      const [lib, pdf] = await Promise.all([pdfViewerLib(), openPdf(blob)]);
      this.pdf = pdf;
      this.model = new BookModel(pdf);
      const eventBus = new lib.EventBus();
      const linkService = new lib.PDFLinkService({ eventBus, externalLinkTarget: 2 });
      const findController = new lib.PDFFindController({ eventBus, linkService });
      this.eventBus = eventBus;
      this.linkService = linkService;
      this.viewer = new lib.PDFViewer({
        container: this.container,
        eventBus,
        linkService,
        findController,
        textLayerMode: 1,
        annotationMode: 1,
        removePageBorders: false,
        maxCanvasPixels: 2 ** 24,
        enableHWA: true,
      });
      linkService.setViewer(this.viewer);
      linkService.setDocument(pdf, null);
      this.viewer.setDocument(pdf);

      const start = clamp(startPage || this.doc?.lastPage || 1, 1, pdf.numPages);
      eventBus.on("pagesinit", async () => {
        const z = localStorage.getItem(zoomKey(this.docId));
        this.viewer.currentScaleValue = z || (matchMedia("(max-width: 760px)").matches ? "page-width" : "auto");
        const rot = Number(localStorage.getItem(rotKey(this.docId)) || 0);
        if (rot) this.viewer.pagesRotation = rot;
        if (start > 1) this.viewer.currentPageNumber = start;
        const layout = feelFor(this.doc).pdfPages;
        if (layout && layout !== "scroll") this.setPdfLayout(layout);
        this.state = "ready";
        this.emit();
        bus.emit("tab-ready", this);
        this.scanCheck = this.#checkScanned();
        const scanned = await this.scanCheck;
        const wanted = this.doc?.view || localStorage.getItem(modeKey(this.docId)) || store.settings().defaultMode;
        // a scanned book being read for the first time opens on Book view, which shows the progress and then the book
        if (wanted === "book" || scanned === "reading") this.setMode("book", { page: start, quiet: true });
      });
      eventBus.on("pagechanging", ({ pageNumber }) => {
        if (this.mode !== "pdf") return;
        this.savePosition(pageNumber, { end: this.pages > 1 && pageNumber >= this.pages && this.moved });
        this.moved = true;
        bus.emit("tab-page", this);
        if (this.paged) requestAnimationFrame(() => this.#checkZoomed());
      });
      eventBus.on("scalechanging", () => { bus.emit("tab-scale", this); requestAnimationFrame(() => this.#checkZoomed()); });
      eventBus.on("rotationchanging", () => bus.emit("tab-rotation", this));
      eventBus.on("textlayerrendered", ({ pageNumber }) => { this.#overlayOcr(pageNumber); bus.emit("page-layer", { tab: this, pageNumber, text: true }); });
      eventBus.on("pagerendered", ({ pageNumber }) => { this.#overlayOcr(pageNumber); bus.emit("page-layer", { tab: this, pageNumber }); });
      eventBus.on("updatefindmatchescount", ({ matchesCount }) => bus.emit("find-count", { tab: this, ...matchesCount }));

      if (this.doc && this.doc.pages !== pdf.numPages) store.patch("docs", this.docId, { pages: pdf.numPages });
    } catch (e) {
      console.error(e);
      this.state = "error";
      this.error = e?.message || String(e);
      this.emit();
    }
  }

  /** EPUB, article or text: Book view only. */
  async #loadText(blob, startPage) {
    try {
      if (this.kind === "epub") {
        const { blocks, toc } = await parseEpub(blob);
        this.objectUrls = blocks.map((b) => b.src).filter((u) => u?.startsWith("blob:"));
        this.model = new TextBookModel(blocks, { toc });
      } else {
        const data = JSON.parse(await blob.text());
        this.model = new TextBookModel(data.blocks || []);
      }
      this.container.hidden = true;
      this.state = "ready";
      if (this.doc && this.doc.pages !== this.model.numPages) store.patch("docs", this.docId, { pages: this.model.numPages });
      this.emit();
      bus.emit("tab-ready", this);
      const start = clamp(startPage || this.doc?.lastPage || 1, 1, this.model.numPages);
      await this.setMode("book", { page: start, quiet: true });
    } catch (e) {
      console.error(e);
      this.state = "error";
      this.error = e?.message || String(e);
      this.emit();
    }
  }

  emit() { bus.emit("tab-state", this); }

  /** Called when the pane becomes visible again after being hidden. */
  shown() {
    if (this.state !== "ready") return;
    if (this.mode === "book") this.book?.activate();
    else this.viewer?.update();
  }
  hidden() {
    this.book?.deactivate();
  }

  currentPage() { return this.mode === "book" && this.book?.chunk >= 0 ? this.book.page : this.page; }

  goTo(page) {
    page = clamp(Math.round(page) || 1, 1, this.pages || 1);
    if (this.mode === "book") return this.book.goToPage(page);
    if (this.viewer) this.viewer.currentPageNumber = page;
  }
  /** Page view showing a page (or two) at a time, like a book. */
  get paged() { return this.mode === "pdf" && this.pdfLayout !== "scroll" && this.viewer?.scrollMode === 3; }
  next({ auto = false } = {}) {
    if (this.mode === "book") return this.book.next({ auto });
    if (this.paged) return turnPdf(this, 1, () => this.viewer.nextPage(), { auto });
    return this.viewer?.nextPage();
  }
  prev() {
    if (this.mode === "book") return this.book.prev();
    if (this.paged) return turnPdf(this, -1, () => this.viewer.previousPage());
    return this.viewer?.previousPage();
  }

  /** Page view layout for this book: continuous scroll, one page at a time, or
   *  two pages side by side like an open book. */
  setPdfLayout(layout = "scroll") {
    const v = this.viewer;
    this.pdfLayout = layout;
    if (!v) return;
    const paged = layout === "single" || layout === "spread";
    const page = v.currentPageNumber;
    try {
      v.scrollMode = paged ? 3 : 0;
      // books start with a page on its own, like a cover; shorter papers pair 1–2, 3–4
      v.spreadMode = layout === "spread" ? (this.pages > 24 ? 2 : 1) : 0;
    } catch (e) { console.warn("Page layout:", e); }
    const ok = !paged || v.scrollMode === 3;
    this.el.classList.toggle("pdf-paged", paged && ok);
    if (paged && ok) v.currentScaleValue = "page-fit";
    else v.currentScaleValue = localStorage.getItem(zoomKey(this.docId)) || (matchMedia("(max-width: 760px)").matches ? "page-width" : "auto");
    if (v.currentPageNumber !== page) v.currentPageNumber = page;
    requestAnimationFrame(() => this.#checkZoomed());
    bus.emit("tab-page", this);
  }

  #checkZoomed() {
    const c = this.container;
    this.el.classList.toggle("zoomed", this.paged && (c.scrollHeight > c.clientHeight + 6 || c.scrollWidth > c.clientWidth + 6));
    this.pvPrev && (this.pvPrev.disabled = !this.viewer || this.viewer.currentPageNumber <= 1);
    this.pvNext && (this.pvNext.disabled = !this.viewer || this.viewer.currentPageNumber >= this.viewer.pagesCount);
  }

  /** Turning pages in Page view's page-at-a-time layouts: swipe, tap the edges,
   *  the wheel or trackpad, or the arrows that appear on hover. */
  #wirePaged() {
    const c = this.container;
    let acc = 0, lock = 0;
    c.addEventListener("wheel", (e) => {
      if (!this.paged || e.ctrlKey || e.metaKey || this.el.classList.contains("zoomed")) return;
      e.preventDefault();
      if (performance.now() < lock) return;
      acc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(acc) > 60) {
        if (acc > 0) this.next(); else this.prev();
        acc = 0;
        lock = performance.now() + 450;
      }
    }, { passive: false });
    let down = null;
    c.addEventListener("pointerdown", (e) => {
      if (!this.paged || e.button !== 0 || e.pointerType === "mouse") return;
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    c.addEventListener("pointerup", (e) => {
      if (!down) return;
      const d = down;
      down = null;
      if (this.el.classList.contains("zoomed") || document.getSelection()?.toString()) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) { if (dx < 0) this.next(); else this.prev(); return; }
      if (performance.now() - d.t > 350 || Math.hypot(dx, dy) > 10 || e.target.closest("a, .linkAnnotation, .annotationLayer section")) return;
      const r = c.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const word = wordAtPoint(e.clientX, e.clientY, c);
      if (fx < 0.1 || (fx < 0.22 && !word)) { e.stopPropagation(); this.prev(); }
      else if (fx > 0.9 || (fx > 0.78 && !word)) { e.stopPropagation(); this.next(); }
    });
    c.addEventListener("pointercancel", () => { down = null; });
    this.pvPrev = el("button.bk-turn.pv-turn.prev", { "aria-label": "Previous page", onclick: () => this.prev() }, icon("left", 26));
    this.pvNext = el("button.bk-turn.pv-turn.next", { "aria-label": "Next page", onclick: () => this.next() }, icon("right", 26));
    this.el.append(this.pvPrev, this.pvNext);
    new ResizeObserver(debounce(() => {
      const v = this.viewer;
      if (!v || this.mode !== "pdf" || c.hidden) return;
      const val = String(v.currentScaleValue);
      if (["page-fit", "page-width", "auto"].includes(val)) v.currentScaleValue = val; // fit again to the new size
      this.#checkZoomed();
    }, 150)).observe(c);
  }

  /**
   * Scanned PDFs: use the text read from its pages before, or read the whole book now.
   * Resolves to "text" (a normal PDF), "ready" (scanned, text available), "reading" or "off".
   */
  async #checkScanned() {
    await this.model.ready();
    if (!this.model.looksScanned || this.destroyed) return "text";
    this.scanned = true;
    const saved = await savedOcr(this.docId);
    if (saved) { this.#useOcr(saved, { fresh: false }); return "ready"; }
    if (store.settings().readScans === false) return "off";
    this.ocrJob = readScanned(this.docId, this.pdf);
    bus.emit("tab-ocr", this);
    this.ocrJob.promise.then((pages) => { if (pages && !this.destroyed) this.#useOcr(pages, { fresh: true }); }).catch(() => bus.emit("tab-ocr", this));
    return "reading";
  }

  /** Read (or read again) a scanned book now. */
  readScannedNow() {
    if (!this.pdf || ocrJob(this.docId)) return;
    this.scanned = true;
    this.ocrJob = readScanned(this.docId, this.pdf);
    bus.emit("tab-ocr", this);
    this.ocrJob.promise.then((pages) => { if (pages && !this.destroyed) this.#useOcr(pages, { fresh: true }); }).catch(() => bus.emit("tab-ocr", this));
    return this.ocrJob;
  }

  #useOcr(pages, { fresh }) {
    this.model.useOcr(pages);
    this.ocrPages = pages;
    this.ocrJob = null;
    // the words go over the page images in Page view, and into search
    this.container?.querySelectorAll(".page[data-page-number]").forEach((div) => this.#overlayOcr(Number(div.dataset.pageNumber)));
    if (fresh) forgetText(this.docId).then(() => indexInBackground(this)).catch(() => {});
    else indexInBackground(this).catch(() => {});
    bus.emit("tab-ocr", this);
  }

  #overlayOcr(pageNumber) {
    if (!this.ocrPages) return;
    const div = this.container?.querySelector(`.page[data-page-number="${pageNumber}"]`);
    if (div) overlayPage(div, this.ocrPages[pageNumber - 1]);
  }

  async setMode(mode, { page, quiet = false } = {}) {
    if (mode === this.mode || this.state !== "ready") return true;
    if (mode === "pdf" && !this.hasPages) { bus.emit("toast", "Page view shows a PDF's original layout — this book is text, so it opens in Book view."); return false; }
    const from = page || this.currentPage();
    if (mode === "book") {
      if (!this.book) {
        this.book = new BookView(this);
        this.el.append(this.book.el);
      }
      this.mode = "book";
      this.el.classList.add("mode-book");
      this.container.hidden = true;
      this.book.el.hidden = false;
      bus.emit("tab-mode", this); // the switch shows Book straight away (a scanned book shows its progress here)
      const ok = await this.book.open(from);
      if (!ok) {
        // scanned PDF: stay on the original pages
        setTimeout(() => { if (this.mode === "book") this.setMode("pdf"); }, quiet ? 0 : 2600);
        bus.emit("book-unavailable", this);
      }
    } else {
      this.mode = "pdf";
      this.el.classList.remove("mode-book");
      this.book?.deactivate();
      if (this.book) this.book.el.hidden = true;
      this.container.hidden = false;
      this.viewer?.update();
      requestAnimationFrame(() => { if (this.viewer && this.viewer.currentPageNumber !== from) this.viewer.currentPageNumber = from; });
    }
    if (!quiet) {
      localStorage.setItem(modeKey(this.docId), this.mode);
      if (this.doc && this.doc.view !== this.mode) store.patch("docs", this.docId, { view: this.mode }); // follows you to your other devices
    }
    bus.emit("tab-mode", this);
    return true;
  }

  zoom(dir) {
    if (!this.viewer || this.mode !== "pdf") return;
    if (dir > 0) this.viewer.increaseScale(); else this.viewer.decreaseScale();
    this.rememberZoom();
  }
  setZoom(value) {
    if (!this.viewer) return;
    if (this.mode !== "pdf") this.setMode("pdf");
    if (typeof value === "number") this.viewer.currentScale = clamp(value, 0.25, 6);
    else this.viewer.currentScaleValue = value;
    this.rememberZoom();
  }
  scaleBy(factor, origin) {
    if (!this.viewer) return;
    this.viewer.updateScale({ scaleFactor: factor, origin });
    this.rememberZoom();
  }
  rememberZoom() {
    if (this.paged) return; // page-at-a-time keeps the whole page in view; your scroll-mode zoom stays as it was
    localStorage.setItem(zoomKey(this.docId), String(this.viewer.currentScaleValue));
  }
  rotate() {
    if (!this.viewer) return;
    this.viewer.pagesRotation = (this.viewer.pagesRotation + 90) % 360;
    localStorage.setItem(rotKey(this.docId), String(this.viewer.pagesRotation));
  }
  get rotation() { return this.viewer?.pagesRotation || 0; }

  /** Page text for search: the original PDF text in Page view, the clean book text otherwise. */
  async text(page) {
    const key = `${this.mode === "book" || !this.pdf ? "b" : "p"}${page}`;
    if (!this.textCache.has(key)) {
      this.textCache.set(key, (this.mode === "book" || !this.pdf ? this.model.pageText(page) : pageText(this.pdf, page)).then((t) => t || "").catch(() => ""));
    }
    return this.textCache.get(key);
  }

  async outline() {
    if (!this.pdf) {
      // build a nested list from the text book's table of contents
      const root = [];
      const stack = [{ depth: -1, items: root }];
      for (const t of this.model?.toc || []) {
        const node = { title: t.title, dest: t.page, items: [] };
        while (stack.length > 1 && stack[stack.length - 1].depth >= t.depth) stack.pop();
        stack[stack.length - 1].items.push(node);
        stack.push({ depth: t.depth, items: node.items });
      }
      return root;
    }
    try { return (await this.pdf.getOutline()) || []; } catch { return []; }
  }

  async goToDest(dest) {
    if (typeof dest === "number" && !this.pdf) return this.book?.goToPage(dest);
    if (!this.linkService) return;
    if (this.mode === "book") {
      try {
        const explicit = typeof dest === "string" ? await this.pdf.getDestination(dest) : dest;
        const ref = explicit?.[0];
        const idx = typeof ref === "object" ? await this.pdf.getPageIndex(ref) : Number(ref);
        if (Number.isFinite(idx)) return this.book.goToPage(idx + 1);
      } catch { /* fall back to page view */ }
      await this.setMode("pdf");
    }
    await this.linkService.goToDestination(dest);
  }

  find(query, { again = false, previous = false, highlightAll = true } = {}) {
    if (!this.eventBus) return;
    this.eventBus.dispatch("find", {
      source: this, type: again ? "again" : "", query, caseSensitive: false, entireWord: false,
      highlightAll, findPrevious: previous, matchDiacritics: false,
    });
  }

  destroy() {
    this.book?.deactivate();
    this.book?.destroy();
    try { this.viewer?.cleanup(); } catch {}
    closePdf(this.pdf);
    (this.objectUrls || []).forEach((u) => URL.revokeObjectURL(u));
    this.destroyed = true;
    this.el.remove();
  }
}
