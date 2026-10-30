// Side-by-side comparison: a second book rendered page-by-page as images with
// its own page and zoom controls.
import { el, clamp, debounce, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { openPdf, renderPageToCanvas, closePdf } from "./pdf.js";
import { icon } from "../ui/icons.js";

const KEY = "luma.compare";

export class ComparePane {
  constructor({ onClose }) {
    this.onClose = onClose;
    this.pdf = null;
    this.docId = null;
    this.page = 1;
    this.zoom = 1;
    this.rendering = 0;
    this.el = el("aside.compare", { "aria-label": "Comparison pane" });
    this.canvasWrap = el("div.compare-canvas");
    this.ro = new ResizeObserver(debounce(() => this.draw(), 150));
    this.ro.observe(this.canvasWrap);
  }

  saveState() {
    localStorage.setItem(KEY, JSON.stringify({ docId: this.docId, page: this.page, zoom: this.zoom }));
  }
  static saved() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
  }

  async open(docId, page) {
    const prev = ComparePane.saved();
    docId ||= prev?.docId;
    if (!docId || !(await store.hasFile(docId))) return this.renderChooser();
    try {
      const blob = await store.getFile(docId);
      closePdf(this.pdf);
      this.pdf = await openPdf(blob);
      this.docId = docId;
      this.page = clamp(page || (prev?.docId === docId ? prev.page : 1) || 1, 1, this.pdf.numPages);
      this.zoom = prev?.docId === docId ? prev.zoom || 1 : 1;
      this.renderChrome();
      await this.draw();
    } catch (e) {
      setKids(this.el, el("p.muted.pad", {}, "This PDF couldn't be opened: " + (e.message || e)));
    }
  }

  async renderChooser() {
    const fileIds = await store.fileIds();
    const docs = store.list("docs").filter((d) => fileIds.has(d.id)).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
    setKids(this.el, 
      el("header.compare-head", {}, el("strong", {}, "Compare with…"),
        el("button.icon-btn", { "aria-label": "Close comparison", onclick: () => this.onClose() }, icon("x", 18))),
      docs.length
        ? el("ul.pick-list", {}, docs.map((d) => el("li", {}, el("button", { onclick: () => this.open(d.id, 1) }, d.title, el("span.muted.small", {}, `${d.pages || "?"} pages`)))))
        : el("p.muted.pad", {}, "Add another PDF to your library to compare two books side by side."));
  }

  renderChrome() {
    const doc = store.get("docs", this.docId);
    this.pageInput = el("input.page-input", {
      type: "number", min: 1, max: this.pdf.numPages, value: this.page, "aria-label": "Comparison page",
      onchange: (e) => this.go(Number(e.target.value)),
    });
    const docs = store.list("docs");
    const select = el("select.select.compare-doc", { "aria-label": "Book in comparison pane", onchange: (e) => this.open(e.target.value, 1) },
      docs.map((d) => el("option", { value: d.id, selected: d.id === this.docId }, d.title)));
    setKids(this.el, 
      el("header.compare-head", {}, select,
        el("button.icon-btn", { "aria-label": "Close comparison", onclick: () => this.onClose() }, icon("x", 18))),
      this.canvasWrap,
      el("footer.compare-foot", {},
        el("button.icon-btn", { "aria-label": "Previous page", onclick: () => this.go(this.page - 1) }, icon("left", 18)),
        el("span.pager", {}, this.pageInput, el("span.muted", {}, ` / ${this.pdf.numPages}`)),
        el("button.icon-btn", { "aria-label": "Next page", onclick: () => this.go(this.page + 1) }, icon("right", 18)),
        el("span.spacer"),
        el("button.icon-btn", { "aria-label": "Zoom out", onclick: () => this.setZoom(this.zoom / 1.2) }, icon("zoomOut", 18)),
        el("button.icon-btn", { "aria-label": "Zoom in", onclick: () => this.setZoom(this.zoom * 1.2) }, icon("zoomIn", 18))));
    if (doc) this.el.setAttribute("aria-label", `Comparison: ${doc.title}`);
    this.canvasWrap.onkeydown = (e) => {
      if (e.key === "ArrowRight" || e.key === "PageDown") this.go(this.page + 1);
      if (e.key === "ArrowLeft" || e.key === "PageUp") this.go(this.page - 1);
    };
    this.canvasWrap.tabIndex = 0;
  }

  go(p) {
    if (!this.pdf) return;
    this.page = clamp(p || 1, 1, this.pdf.numPages);
    if (this.pageInput) this.pageInput.value = this.page;
    this.canvasWrap.scrollTop = 0;
    this.saveState();
    this.draw();
  }

  setZoom(z) {
    this.zoom = clamp(z, 0.5, 4);
    this.saveState();
    this.draw();
  }

  async draw() {
    if (!this.pdf || !this.canvasWrap.isConnected) return;
    const width = Math.max(160, (this.canvasWrap.clientWidth - 24) * this.zoom);
    const my = ++this.rendering;
    const canvas = await renderPageToCanvas(this.pdf, this.page, width).catch(() => null);
    if (my !== this.rendering || !canvas) return;
    canvas.className = "compare-page";
    setKids(this.canvasWrap, canvas);
  }

  destroy() {
    this.ro.disconnect();
    closePdf(this.pdf);
    this.el.remove();
  }
}
