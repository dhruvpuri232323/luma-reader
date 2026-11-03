// A book made from text (EPUB, web article, Markdown, plain text) with the same
// interface as BookModel, so Book view, Listen, search and notes work the same
// way. Text is grouped into "pages" of roughly a printed page each; chapters
// always start a new page.
import { wordCount } from "./bookmodel.js";

const PAGE_CHARS = 1800;

export class TextBookModel {
  constructor(blocks, { toc = [] } = {}) {
    this.pagesList = [];
    let cur = [];
    let chars = 0;
    const startOf = new Map(); // original block index → page
    const push = () => { if (cur.length) this.pagesList.push(cur); cur = []; chars = 0; };
    blocks.forEach((b, i) => {
      if ((b.type === "h" && b.level === 2 && chars > 300) || chars > PAGE_CHARS) push();
      startOf.set(i, this.pagesList.length + 1);
      cur.push({ ...b, at: i });
      chars += b.type === "img" ? 500 : (b.text || "").length;
    });
    push();
    if (!this.pagesList.length) this.pagesList.push([{ type: "p", text: "(This document has no text.)" }]);
    this.pagesList = this.pagesList.map((list, pi) => list.map((b, i) => ({ ...b, id: `${pi + 1}:${i}`, page: pi + 1 })));
    const all = this.pagesList.flat();
    const text = all.reduce((n, b) => n + (b.text || "").length, 0);
    const words = all.reduce((n, b) => n + wordCount(b.text || ""), 0);
    this.avgChars = Math.max(200, text / this.pagesList.length);
    this.avgWords = Math.max(30, words / this.pagesList.length);
    this.bodySize = 10;
    this.looksScanned = false;
    // the block each original block became (so a chapter mid-page can be reached exactly)
    const idOf = new Map();
    for (const b of all) if (b.at != null) idOf.set(b.at, b.id);
    this.toc = toc.length
      ? toc.map((t) => ({ title: t.title, page: startOf.get(t.block) || 1, depth: t.depth || 0, bid: idOf.get(t.block) }))
      : all.filter((b) => b.type === "h").map((b) => ({ title: b.text, page: b.page, depth: b.level === 2 ? 0 : 1, bid: b.id }));
  }

  get numPages() { return this.pagesList.length; }
  ready() { return Promise.resolve(); }
  async page(p) { return this.pagesList[p - 1] || []; }
  async pageText(p) { return (this.pagesList[p - 1] || []).map((b) => b.text || "").join("\n"); }

  async headingBefore(p) {
    for (let q = Math.min(p, this.numPages); q >= 1; q--) {
      const h = [...this.pagesList[q - 1]].reverse().find((b) => b.type === "h");
      if (h) return h.text;
    }
    return "";
  }

  wordsLeft(fromPage) { return Math.max(0, (this.numPages - fromPage + 1) * this.avgWords); }
}
