// One open book: the original pages (PDF.js viewer) and, on demand, the same
// book set as text (Book view). Remembers which view you used for each book.
import { el, debounce, clamp, bus } from "../core/util.js";
import { store } from "../data/store.js";
import { recordPosition } from "../data/library.js";
import { openPdf, pdfViewerLib, pageText, closePdf } from "./pdf.js";
import { BookModel } from "./bookmodel.js";
import { BookView } from "./bookview.js";
import { TextBookModel } from "./textmodel.js";
import { parseEpub } from "../data/importers.js";

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
        this.state = "ready";
        this.emit();
        bus.emit("tab-ready", this);
        const wanted = this.doc?.view || localStorage.getItem(modeKey(this.docId)) || store.settings().defaultMode;
        if (wanted === "book") this.setMode("book", { page: start, quiet: true });
      });
      eventBus.on("pagechanging", ({ pageNumber }) => {
        if (this.mode !== "pdf") return;
        this.savePosition(pageNumber, { end: this.pages > 1 && pageNumber >= this.pages && this.moved });
        this.moved = true;
        bus.emit("tab-page", this);
      });
      eventBus.on("scalechanging", () => bus.emit("tab-scale", this));
      eventBus.on("rotationchanging", () => bus.emit("tab-rotation", this));
      eventBus.on("textlayerrendered", ({ pageNumber }) => bus.emit("page-layer", { tab: this, pageNumber, text: true }));
      eventBus.on("pagerendered", ({ pageNumber }) => bus.emit("page-layer", { tab: this, pageNumber }));
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
  next() { return this.mode === "book" ? this.book.next() : this.viewer?.nextPage(); }
  prev() { return this.mode === "book" ? this.book.prev() : this.viewer?.previousPage(); }

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
      this.container.hidden = true;
      this.book.el.hidden = false;
      const ok = await this.book.open(from);
      if (!ok) {
        // scanned PDF: stay on the original pages
        setTimeout(() => { if (this.mode === "book") this.setMode("pdf"); }, quiet ? 0 : 2600);
        bus.emit("book-unavailable", this);
      }
    } else {
      this.mode = "pdf";
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
