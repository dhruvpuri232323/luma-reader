// Turns a fixed-layout PDF into clean, book-like text: paragraphs joined across
// line breaks, hyphenation undone, headings detected by font size, running
// headers/footers and page numbers removed, picture-only pages kept as images.
// Used by Book view and by read-aloud.

const normLine = (s) => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
const PAGE_NO = /^(page\s*)?[#ivxlc]{1,6}(\s*(of|\/)\s*#)?$/i;
const LIST = /^([•●▪◦‣–—*-]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s/;
const NOTE_MARK = /^[\d*†‡§]{1,3}$/;
const NOTE_START = /^(\d{1,3}|[*†‡§]{1,3})[.)]?\s+(\S.*)$/;
// Footnote markers ride inside the text as private-use brackets until a block is finished.
const M_OPEN = "\uE000", M_CLOSE = "\uE001";
const MARKS = /\uE000([^\uE001]*)\uE001/g;
const stripMarks = (s) => s.replace(MARKS, "$1");

export class BookModel {
  constructor(pdf) {
    this.pdf = pdf;
    this.raw = new Map(); // page → Promise<{lines, w, h}>
    this.blocks = new Map(); // page → Promise<block[]>
    this.readyPromise = null;
    this.bodySize = 10;
    this.repeated = new Set();
    this.avgChars = 1500;
    this.avgWords = 250;
    this.textPages = 0;
    this.sampleCount = 0;
  }

  get numPages() { return this.pdf.numPages; }

  lines(p) {
    if (!this.raw.has(p)) this.raw.set(p, this.#readLines(p));
    return this.raw.get(p);
  }

  async #readLines(p) {
    const page = await this.pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const lines = [];
    let cur = null;
    for (const item of tc.items) {
      if (!("str" in item)) continue;
      const [, , c, d, x, y] = item.transform;
      const size = Math.hypot(c, d) || item.height || 10;
      if (!item.str.trim()) {
        if (cur && item.str && !cur.text.endsWith(" ")) cur.text += " ";
        if (item.hasEOL) cur = null;
        continue;
      }
      // superscript note marker (a small raised number or symbol inside a line)
      if (cur && size < cur.size * 0.8 && y - cur.y > cur.size * 0.15 && NOTE_MARK.test(item.str.trim())) {
        cur.text += M_OPEN + item.str.trim() + M_CLOSE;
        cur.end = x + (item.width || 0);
        if (item.hasEOL) cur = null;
        continue;
      }
      if (!cur || Math.abs(y - cur.y) > Math.max(size, cur.size) * 0.5) {
        cur = { y, x, size, text: "", end: x };
        lines.push(cur);
      } else if (x > cur.end + size * 0.18 && !cur.text.endsWith(" ") && !item.str.startsWith(" ")) {
        cur.text += " ";
      }
      cur.text += item.str;
      cur.size = Math.max(cur.size, size);
      cur.end = x + (item.width || 0);
      if (item.hasEOL) cur = null;
    }
    return { lines: lines.filter((l) => l.text.trim()), w: vp.width, h: vp.height };
  }

  /** Learn body font size and repeating headers/footers from a sample of pages. */
  ready() {
    this.readyPromise ||= (async () => {
      const n = this.numPages;
      const step = Math.max(1, Math.floor(n / 24));
      const sample = [];
      for (let p = 1; p <= n && sample.length < 24; p += step) sample.push(p);
      const counts = new Map();
      const sizes = new Map();
      let chars = 0, words = 0, textPages = 0;
      const read = await Promise.all(sample.map((p) => this.lines(p))); // all at once — the PDF engine queues them
      for (const { lines } of read) {
        let pc = 0;
        for (const l of lines) {
          const k = Math.round(l.size * 2) / 2;
          sizes.set(k, (sizes.get(k) || 0) + l.text.length);
          pc += l.text.length;
          words += l.text.split(/\s+/).filter(Boolean).length;
        }
        chars += pc;
        if (pc > 200) textPages++;
        const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)]);
        for (const l of edge) {
          const k = normLine(l.text);
          if (k.length < 100) counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
      this.bodySize = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
      const minRepeat = Math.max(3, Math.ceil(sample.length * 0.3));
      this.repeated = new Set([...counts].filter(([, c]) => c >= minRepeat).map(([k]) => k));
      this.avgChars = Math.max(200, chars / sample.length);
      this.avgWords = Math.max(30, words / sample.length);
      this.textPages = textPages;
      this.sampleCount = sample.length;
    })();
    return this.readyPromise;
  }

  /** True when the PDF is mostly scanned images (no real text). */
  get looksScanned() {
    return this.sampleCount > 0 && this.textPages / this.sampleCount < 0.2;
  }

  /**
   * Blocks for one page: { id, page, type: "h"|"p"|"img", level, text, cont, aspect }
   * `cont` marks a paragraph continuing from the previous page.
   */
  page(p) {
    if (!this.blocks.has(p)) this.blocks.set(p, this.#buildPage(p));
    return this.blocks.get(p);
  }

  async #buildPage(p) {
    await this.ready();
    const { lines, w, h } = await this.lines(p);
    const keep = lines.filter((l, i) => {
      const edge = i < 2 || i >= lines.length - 2;
      if (!edge) return true;
      const k = normLine(l.text);
      return !this.repeated.has(k) && !PAGE_NO.test(k);
    });
    const total = keep.reduce((n, l) => n + l.text.trim().length, 0);
    if (total < 40) return [{ id: `${p}:0`, page: p, type: "img", aspect: w / h, text: "" }];

    const body = this.bodySize;
    // Footnotes: a run of small lines at the foot of the page that starts "1 …"
    const notes = new Map();
    let footStart = keep.length;
    while (footStart > 0 && keep[footStart - 1].size <= body * 0.88 && keep[footStart - 1].y < h * 0.45) footStart--;
    if (footStart < keep.length && footStart > 0 && NOTE_START.test(stripMarks(keep[footStart].text).trim())) {
      let curNote = null;
      for (const l of keep.slice(footStart)) {
        const t = stripMarks(l.text).replace(/\s+/g, " ").trim();
        const m = t.match(NOTE_START);
        if (m) { curNote = m[1]; notes.set(curNote, m[2]); }
        else if (curNote) notes.set(curNote, (notes.get(curNote) + " " + t).replace(/(\p{L})- (\p{Ll})/gu, "$1$2"));
      }
      keep.splice(footStart);
    }
    const isHeading = (l) => l.size >= body * 1.22 && l.text.trim().length < 140;
    const blocks = [];
    let para = null;
    let prev = null;
    const flush = () => {
      if (para && para.text.trim()) blocks.push(para);
      para = null;
    };
    for (const l of keep) {
      const t = l.text.replace(/\s+/g, " ").trim();
      if (isHeading(l)) {
        const ht = stripMarks(t);
        flush();
        const last = blocks[blocks.length - 1];
        if (last?.type === "h" && prev && isHeading(prev) && prev.y - l.y < l.size * 2.2) last.text += " " + ht;
        else blocks.push({ type: "h", level: l.size >= body * 1.6 ? 2 : 3, text: ht, page: p });
        prev = l;
        continue;
      }
      let breakHere = !para;
      if (para && prev) {
        const gap = prev.y - l.y;
        const lineGap = Math.max(l.size, prev.size) * 1.85;
        const indented = l.x - prev.x > l.size * 1.2;
        const ended = /[.!?:"”’)]$/.test(stripMarks(prev.text).trim());
        if (gap > lineGap || gap < -2 || (indented && ended) || LIST.test(t) || (ended && prev.end < para.maxEnd - l.size * 6)) breakHere = true;
      }
      if (breakHere) {
        flush();
        para = { type: "p", text: t, page: p, maxEnd: l.end };
        if (LIST.test(stripMarks(t))) para.list = true;
      } else if (/\p{L}-$/u.test(para.text) && /^\p{Ll}/u.test(t)) {
        para.text = para.text.slice(0, -1) + t;
      } else {
        para.text += " " + t;
      }
      para.maxEnd = Math.max(para.maxEnd, l.end);
      prev = l;
    }
    flush();
    blocks.forEach((b, i) => {
      b.id = `${p}:${i}`;
      delete b.maxEnd;
      if (b.type !== "p" || !b.text.includes(M_OPEN)) return;
      // pull markers out of the text; keep the ones that have a footnote
      let out = "", last = 0;
      const found = [];
      for (const m of b.text.matchAll(MARKS)) {
        out += b.text.slice(last, m.index);
        last = m.index + m[0].length;
        if (notes.has(m[1])) found.push({ at: out.length, n: m[1], text: notes.get(m[1]) });
        else out += m[1];
      }
      b.text = out + b.text.slice(last);
      if (found.length) b.notes = found;
    });

    // Does this page start mid-paragraph?
    const first = blocks.find((b) => b.type === "p");
    if (first && p > 1 && blocks[0] === first) {
      const prevLines = (await this.lines(p - 1).catch(() => ({ lines: [] }))).lines;
      const tail = [...prevLines].reverse().find((l, i) => {
        const k = normLine(l.text);
        return !(i < 2 && (this.repeated.has(k) || PAGE_NO.test(k))) && l.size > body * 0.88;
      });
      if (tail && tail.size < body * 1.22 && (!/[.!?:"”’)]$/.test(stripMarks(tail.text).trim()) || /^\p{Ll}/u.test(first.text))) first.cont = true;
    }
    return blocks;
  }

  /** Nearest heading at or before a page (only looks at pages already built or cheap to build). */
  async headingBefore(p, maxLookback = 12) {
    for (let q = p; q >= Math.max(1, p - maxLookback); q--) {
      const blocks = await this.page(q);
      const h = [...blocks].reverse().find((b) => b.type === "h" && b.level === 2) || [...blocks].reverse().find((b) => b.type === "h");
      if (h) return h.text;
    }
    return "";
  }

  async pageText(p) {
    return (await this.page(p)).map((b) => b.text || "").filter(Boolean).join("\n");
  }

  wordsLeft(fromPage) {
    return Math.max(0, (this.numPages - fromPage + 1) * this.avgWords);
  }
}

export const wordCount = (s) => (s.match(/\S+/g) || []).length;
