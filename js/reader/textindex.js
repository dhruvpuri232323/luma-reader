// Maps a run of DOM elements to one searchable string, so text found in the
// string (a highlight, a sentence being read aloud) can be turned back into DOM
// Ranges. Matching ignores case, whitespace differences, curly quotes and
// end-of-line hyphenation ("ephem- eral" matches "ephemeral").

const QUOTES = { "’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-" };

export class TextIndex {
  /** @param {Element[]} elements in reading order */
  constructor(elements) {
    this.segs = []; // { node, start } in raw coordinates
    let raw = "";
    elements.forEach((elm, i) => {
      if (i && raw && !/\s$/.test(raw)) raw += " ";
      const w = document.createTreeWalker(elm, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        this.segs.push({ node: n, start: raw.length });
        raw += n.data;
      }
    });
    this.raw = raw;
    // normalized text + map back to raw offsets
    let norm = "";
    const map = [];
    for (let i = 0; i < raw.length; i++) {
      let ch = raw[i];
      if (ch === "-" && /\p{L}/u.test(raw[i - 1] || "") && /\s/.test(raw[i + 1] || "")) {
        let j = i + 1;
        while (/\s/.test(raw[j] || "")) j++;
        if (/\p{Ll}/u.test(raw[j] || "")) { i = j - 1; continue; } // drop "- " hyphenation break
      }
      if (/\s/.test(ch)) {
        if (norm.endsWith(" ") || !norm) continue;
        ch = " ";
      }
      norm += (QUOTES[ch] || ch).toLowerCase();
      map.push(i);
    }
    this.norm = norm;
    this.map = map;
  }

  static normalize(s) {
    return s.replace(/(\p{L})-\s+(\p{Ll})/gu, "$1$2").replace(/\s+/g, " ").trim()
      .replace(/[’‘“”–—]/g, (c) => QUOTES[c]).toLowerCase();
  }

  /** Raw [start, end) of the first match at or after `from` (raw offset), or null. */
  find(needle, from = 0) {
    const n = TextIndex.normalize(needle);
    if (!n) return null;
    let nFrom = 0;
    if (from) { nFrom = this.map.findIndex((r) => r >= from); if (nFrom < 0) return null; }
    const i = this.norm.indexOf(n, nFrom);
    if (i < 0) return null;
    return [this.map[i], this.map[i + n.length - 1] + 1];
  }

  /** Locate raw offset → { node, offset } */
  point(offset) {
    let lo = 0, hi = this.segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segs[mid].start <= offset) lo = mid; else hi = mid - 1;
    }
    const s = this.segs[lo];
    if (!s) return null;
    return { node: s.node, offset: Math.min(offset - s.start, s.node.data.length) };
  }

  range(start, end) {
    const a = this.point(start);
    const b = this.point(end);
    if (!a || !b) return null;
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  }

  rangeOf(needle, from = 0) {
    const hit = this.find(needle, from);
    return hit ? this.range(hit[0], hit[1]) : null;
  }
}

/** Leaf text spans of a PDF.js text layer, in reading order. */
export function textLayerSpans(layer) {
  return [...layer.querySelectorAll("span")].filter((s) => !s.querySelector("span") && s.textContent);
}

// ── CSS Custom Highlight API helpers (no DOM changes; graceful no-op if unsupported) ──
export const highlightsSupported = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

export function setHighlight(name, ranges) {
  if (!highlightsSupported()) return;
  const list = (ranges || []).filter(Boolean);
  if (!list.length) { CSS.highlights.delete(name); return; }
  CSS.highlights.set(name, new Highlight(...list));
}

export function clearHighlight(name) {
  if (highlightsSupported()) CSS.highlights.delete(name);
}

// ── Sentences ──
const ABBR = /\b(mr|mrs|ms|dr|st|prof|sr|jr|vs|etc|e\.g|i\.e|no|fig|pp|vol|ch|inc|ltd|co|mt|ft|approx|dept|est|gen|gov|lt|col|sgt|capt|rev|u\.s|u\.k)\.$/i;
const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;

/** Split text into sentence spans [{ start, end }] tuned for listening. */
export function sentenceSpans(text) {
  let spans = [];
  if (segmenter) {
    for (const s of segmenter.segment(text)) spans.push({ start: s.index, end: s.index + s.segment.length });
  } else {
    const re = /[^.!?]+[.!?]+["'”’)]*\s*|[^.!?]+$/g;
    let m;
    while ((m = re.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length });
  }
  // merge abbreviation splits and very short fragments
  const merged = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    const prevText = prev ? text.slice(prev.start, prev.end).trim() : "";
    if (prev && (ABBR.test(prevText) || /^[a-z]/.test(text.slice(s.start, s.end).trim()) || prevText.length < 18)) prev.end = s.end;
    else merged.push({ ...s });
  }
  // split very long sentences at ; or , near the middle so the voice breathes
  const out = [];
  for (const s of merged) {
    let { start, end } = s;
    while (end - start > 320) {
      const chunk = text.slice(start, end);
      const mid = Math.floor(chunk.length / 2);
      let cut = -1;
      for (const sep of ["; ", ": ", ", ", " — ", " "]) {
        const after = chunk.indexOf(sep, mid - 60);
        if (after > 60 && after < chunk.length - 40) { cut = after + sep.length; break; }
      }
      if (cut < 0) break;
      out.push({ start, end: start + cut });
      start += cut;
    }
    out.push({ start, end });
  }
  return out.filter((s) => text.slice(s.start, s.end).trim());
}

/** Text as it should be spoken. */
export function speakable(text) {
  return text
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/\[\d+(?:[,–-]\d+)*\]/g, "")
    .replace(/(\p{Ll})(\d{1,3})(?=[\s.,;:)]|$)/gu, "$1")
    .replace(/\be\.g\.,?/gi, "for example,")
    .replace(/\bi\.e\.,?/gi, "that is,")
    .replace(/\betc\./gi, "et cetera.")
    .replace(/\bvs\./gi, "versus")
    .replace(/\bfig\./gi, "figure")
    .replace(/\bp\.\s?(\d)/g, "page $1")
    .replace(/\bpp\.\s?(\d)/g, "pages $1")
    .replace(/&/g, " and ")
    .replace(/(\d)\s?%/g, "$1 percent")
    .replace(/[*†‡§¶•■●◦]/g, " ")
    .replace(/\.{3,}|…/g, "… ")
    .replace(/\s+/g, " ")
    .trim();
}
