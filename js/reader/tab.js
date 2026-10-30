// One open book: a PDF.js viewer (continuous scroll, text layer, find) plus an
// optional reflowed-text view of the same book.
import { el, debounce, clamp, bus, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { recordPosition } from "../data/library.js";
import { openPdf, pdfViewerLib, pageText, pageParagraphs, closePdf } from "./pdf.js";

const zoomKey = (id) => `luma.zoom.${id}`;
const rotKey = (id) => `luma.rot.${id}`;

export class Tab {
  constructor(docId) {
    this.docId = docId;
    this.pdf = null;
    this.viewer = null;
    this.mode = "pdf"; // pdf | reflow
    this.state = "idle"; // idle | loading | ready | missing | error
    this.textCache = new Map();
    this.el = el("div.tab-pane", { dataset: { doc: docId } });
    this.container = el("div.pdf-scroller", { tabindex: "0" }, el("div.pdfViewer"));
    this.reflowEl = el("div.reflow", { tabindex: "0", hidden: true });
    this.el.append(this.container, this.reflowEl);
    this.savePosition = debounce((p) => recordPosition(this.docId, p), 900);
  }

  get doc() { return store.get("docs", this.docId); }
  get page() { return this.viewer?.currentPageNumber || 1; }
  get pages() { return this.pdf?.numPages || this.doc?.pages || 0; }

  async load(startPage) {
    if (this.state === "loading" || this.state === "ready") return;
    this.state = "loading";
    this.emit();
    const blob = await store.getFile(this.docId);
    if (!blob) { this.state = "missing"; this.emit(); return; }
    try {
      const [lib, pdf] = await Promise.all([pdfViewerLib(), openPdf(blob)]);
      this.pdf = pdf;
      const eventBus = new lib.EventBus();
      const linkService = new lib.PDFLinkService({ eventBus, externalLinkTarget: 2 /* blank */ });
      const findController = new lib.PDFFindController({ eventBus, linkService });
      this.eventBus = eventBus;
      this.linkService = linkService;
      this.findController = findController;
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

      eventBus.on("pagesinit", () => {
        const z = localStorage.getItem(zoomKey(this.docId));
        this.viewer.currentScaleValue = z || (matchMedia("(max-width: 760px)").matches ? "page-width" : "auto");
        const rot = Number(localStorage.getItem(rotKey(this.docId)) || 0);
        if (rot) this.viewer.pagesRotation = rot;
        const page = clamp(startPage || this.doc?.lastPage || 1, 1, pdf.numPages);
        if (page > 1) this.viewer.currentPageNumber = page;
        this.state = "ready";
        this.emit();
        bus.emit("tab-ready", this);
      });
      eventBus.on("pagechanging", ({ pageNumber }) => {
        this.savePosition(pageNumber);
        bus.emit("tab-page", this);
      });
      eventBus.on("scalechanging", () => bus.emit("tab-scale", this));
      eventBus.on("rotationchanging", () => bus.emit("tab-rotation", this));
      eventBus.on("textlayerrendered", ({ pageNumber }) => bus.emit("page-layer", { tab: this, pageNumber }));
      eventBus.on("pagerendered", ({ pageNumber }) => bus.emit("page-layer", { tab: this, pageNumber }));
      eventBus.on("updatefindmatchescount", ({ matchesCount }) => bus.emit("find-count", { tab: this, ...matchesCount }));
      eventBus.on("updatefindcontrolstate", (e) => bus.emit("find-state", { tab: this, ...e }));

      if (this.doc && this.doc.pages !== pdf.numPages) store.patch("docs", this.docId, { pages: pdf.numPages });
      if (this.doc) store.patch("docs", this.docId, { openedAt: Date.now() });
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
    if (this.viewer && this.state === "ready") {
      const v = localStorage.getItem(zoomKey(this.docId));
      if (v && isNaN(Number(v))) this.viewer.currentScaleValue = v;
      this.viewer.update();
    }
  }

  goTo(page) {
    page = clamp(Math.round(page), 1, this.pages || 1);
    if (this.mode === "reflow") {
      this.reflowEl.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: "start" });
      this.savePosition(page);
      this.reflowPage = page;
      bus.emit("tab-page", this);
      return;
    }
    if (this.viewer) this.viewer.currentPageNumber = page;
  }
  next() { this.mode === "reflow" ? this.goTo(this.currentPage() + 1) : this.viewer?.nextPage(); }
  prev() { this.mode === "reflow" ? this.goTo(this.currentPage() - 1) : this.viewer?.previousPage(); }
  currentPage() { return this.mode === "reflow" ? this.reflowPage || this.page : this.page; }

  zoom(dir) {
    if (!this.viewer) return;
    if (dir > 0) this.viewer.increaseScale(); else this.viewer.decreaseScale();
    this.rememberZoom();
  }
  setZoom(value) {
    if (!this.viewer) return;
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
    const v = this.viewer.currentScaleValue;
    localStorage.setItem(zoomKey(this.docId), String(v));
  }
  rotate() {
    if (!this.viewer) return;
    this.viewer.pagesRotation = (this.viewer.pagesRotation + 90) % 360;
    localStorage.setItem(rotKey(this.docId), String(this.viewer.pagesRotation));
  }
  get rotation() { return this.viewer?.pagesRotation || 0; }

  async text(page) {
    if (!this.textCache.has(page)) this.textCache.set(page, pageText(this.pdf, page).catch(() => ""));
    return this.textCache.get(page);
  }

  async outline() {
    if (!this.pdf) return [];
    try { return (await this.pdf.getOutline()) || []; } catch { return []; }
  }

  async goToDest(dest) {
    if (!this.linkService) return;
    if (this.mode === "reflow") this.setMode("pdf");
    await this.linkService.goToDestination(dest);
  }

  find(query, { again = false, previous = false, highlightAll = true } = {}) {
    if (!this.eventBus) return;
    this.eventBus.dispatch("find", {
      source: this,
      type: again ? "again" : "",
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll,
      findPrevious: previous,
      matchDiacritics: false,
    });
  }
  clearFind() {
    this.eventBus?.dispatch("findbarclose", { source: this });
  }

  async setMode(mode) {
    if (mode === this.mode) return;
    const page = this.currentPage();
    this.mode = mode;
    this.container.hidden = mode !== "pdf";
    this.reflowEl.hidden = mode !== "reflow";
    if (mode === "reflow") {
      await this.buildReflow(page);
    } else {
      this.viewer?.update();
      requestAnimationFrame(() => { if (page !== this.page) this.goTo(page); });
    }
    bus.emit("tab-mode", this);
  }

  async buildReflow(startPage) {
    if (this.reflowBuilt) { this.goTo(startPage); return; }
    this.reflowBuilt = true;
    const body = el("div.reflow-text");
    const status = el("p.reflow-status.muted", {}, "Extracting text…");
    setKids(this.reflowEl, status, body);
    let chars = 0;
    const sections = [];
    for (let p = 1; p <= this.pdf.numPages; p++) {
      const sec = el("section.reflow-page", { dataset: { page: p } }, el("div.reflow-pno", {}, `Page ${p}`));
      body.append(sec);
      sections.push(sec);
    }
    const fill = async (p) => {
      const paras = (await pageParagraphs(this.pdf, p).catch(() => []))
        .filter((t, i, all) => !((i === 0 || i === all.length - 1) && /^(page\s*)?[\divxlc]{1,5}$/i.test(t.trim())));
      chars += paras.join("").length;
      const sec = sections[p - 1];
      if (!paras.length) sec.append(el("p.muted.small", {}, "No text on this page."));
      else paras.forEach((t) => sec.append(el("p", {}, t)));
    };
    // Fill the pages around the reader first, then the rest in the background.
    const order = [];
    for (let d = 0; d < this.pdf.numPages; d++) {
      const a = startPage + d, b = startPage - d;
      if (a <= this.pdf.numPages) order.push(a);
      if (d && b >= 1) order.push(b);
    }
    for (const p of order.slice(0, 3)) await fill(p);
    sections[startPage - 1]?.scrollIntoView({ block: "start" });
    this.reflowPage = startPage;
    const io = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (vis && this.mode === "reflow") {
        const p = Number(vis.target.dataset.page);
        if (p !== this.reflowPage) { this.reflowPage = p; this.savePosition(p); bus.emit("tab-page", this); }
      }
    }, { root: this.reflowEl, rootMargin: "0px 0px -70% 0px" });
    sections.forEach((s) => io.observe(s));
    for (const p of order.slice(3)) {
      await fill(p);
      if (p % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    status.textContent = chars < this.pdf.numPages * 25
      ? "This PDF has little or no selectable text — it is probably scanned images. Reflow and the dictionary need real text; use page view instead."
      : "";
    status.hidden = !status.textContent;
  }

  destroy() {
    try { this.viewer?.cleanup(); } catch {}
    closePdf(this.pdf);
    this.el.remove();
  }
}
