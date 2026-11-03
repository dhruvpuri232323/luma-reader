// How each kind of book is set: its typeface, margins, line spacing, columns,
// running heads, page numbers, chapter openings, drop caps and ornaments —
// so a paperback, a hardcover, a magazine and an e-reader each look like the
// real thing. Every part can be changed for one book (Book feel → Make it your own).
import { REFLOW_FONTS } from "./feel.js";

// size factors so each face looks the same size as Literata at the same setting
const FACE_K = { literata: 1, garamond: 1.1, newsreader: 1.03, baskerville: 0.92, sourceserif: 0.98, fell: 1.09, atkinson: 0.96, lexend: 0.95, dyslexic: 0.9, system: 0.99 };

const HEAD = {
  ui: 'var(--ui)',
  same: null,
  playfair: '"Playfair Display", "Didot", "Bodoni 72", Georgia, serif',
  fellsc: '"IM Fell English SC", "IM FELL English SC", "IM Fell English", "EB Garamond", serif',
};

export const DESIGNS = {
  modern: { name: "Modern", note: "Clean and contemporary", face: "literata", head: "ui", margin: 1, leading: 1, cols: 1, heads: "on", folio: "stats", drop: false, ornament: "dots" },
  trade: { name: "Paperback", note: "A classic trade paperback", face: "garamond", head: "same", margin: 1, leading: 1.03, cols: 1, heads: "on", folio: "book", drop: true, ornament: "asterism" },
  fine: { name: "Fine press", note: "Generous margins, set with care", face: "baskerville", head: "same", margin: 1.3, leading: 1.07, cols: 1, heads: "on", folio: "book", drop: true, ornament: "fleuron" },
  pocket: { name: "Pocket", note: "Compact, for reading on the go", face: "newsreader", head: "same", margin: 0.68, leading: 0.92, cols: 1, heads: "on", folio: "book", drop: false, ornament: "stars" },
  antique: { name: "Antique", note: "Set by hand, two centuries ago", face: "fell", head: "fellsc", margin: 1.18, leading: 1.02, cols: 1, heads: "on", folio: "book", drop: true, ornament: "hedera" },
  magazine: { name: "Magazine", note: "Bold headlines, columns of text", face: "sourceserif", head: "playfair", size: 0.9, margin: 0.92, leading: 0.95, cols: 2, heads: "on", folio: "book", drop: true, ornament: "square" },
  ereader: { name: "E-reader", note: "Calm and simple, like an e-ink screen", face: "literata", head: "same", margin: 0.82, leading: 1, cols: 1, heads: "on", folio: "stats", drop: false, ornament: "dots" },
};

export const ORNAMENTS = { asterism: "⁂", fleuron: "❦", hedera: "❧", stars: "* * *", dots: "· · ·", square: "■", rule: "—" };
export const ORNAMENT_NAMES = { auto: "The design's own", asterism: "⁂", fleuron: "❦", hedera: "❧", stars: "* * *", dots: "· · ·", rule: "—" };
export const FOLIOS = { auto: "The design's own", book: "Page numbers", stats: "Page, % and time left", off: "Off" };

/** Everything Book view needs to set this book: faces, sizes, columns and page furniture. */
export function typeFor(f, s) {
  const D = DESIGNS[f.design] || DESIGNS.modern;
  const own = s.editionFonts !== false && D.face;
  const faceKey = own ? D.face : s.reflowFont;
  const face = REFLOW_FONTS[faceKey] || REFLOW_FONTS.literata;
  const head = D.head === "same" || !own ? null : HEAD[D.head];
  const pick = (k, v) => (f[k] == null || f[k] === "auto" ? D[k] : v);
  return {
    design: f.design in DESIGNS ? f.design : "modern",
    D,
    faceKey,
    stack: face.stack,
    headStack: head || face.stack,
    k: (own ? FACE_K[faceKey] || 1 : 1) * (D.size || 1),
    marginK: D.margin,
    leadK: D.leading,
    perPage: Number(pick("cols", f.cols)) === 2 ? 2 : 1,
    colsChosen: f.cols != null && f.cols !== "auto", // asked for: two columns even on narrower pages
    heads: pick("heads", f.heads) !== "off",
    folio: pick("folio", f.folio),
    drop: pick("drop", f.drop) !== false && pick("drop", f.drop) !== "off",
    ornament: ORNAMENTS[pick("ornament", f.ornament)] || ORNAMENTS[D.ornament],
  };
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
export function numberWords(n) {
  if (!(n > 0 && n < 100)) return String(n);
  return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
}
export function roman(n) {
  if (!(n > 0 && n < 4000)) return String(n);
  const map = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  for (const [v, r] of map) while (n >= v) { out += r; n -= v; }
  return out;
}

/**
 * A chapter heading split into its number and its title, keeping every
 * character (so highlights and read-aloud still line up):
 * "Chapter 3: The Storm" → { num: "Chapter 3", sep: ": ", title: "The Storm", n: 3 }
 */
export function splitHeading(text) {
  const m = /^\s*((?:chapter|part|book|section|letter)\s+)?(\d{1,3}|[ivxlc]{1,7}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b([.:\-–—]\s*|\s+)(?=\S)(.*)$/i.exec(text || "");
  if (!m || m[4].length < 2 || m[4].length > 120) return null;
  if (!m[1] && /^[ivxlc]+$/i.test(m[2]) && !/[.:\-–—]/.test(m[3])) return null; // "I went…" isn't a numeral
  const raw = m[2];
  const word = ONES.findIndex((w) => w && w.toLowerCase() === raw.toLowerCase());
  const n = /^\d+$/.test(raw) ? Number(raw) : word > 0 ? word : romanValue(raw);
  return { label: (m[1] || "").trim(), num: raw, sep: m[3], title: m[4], n, lead: (m[1] || "") + raw };
}

function romanValue(s) {
  const v = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let total = 0;
  const t = s.toLowerCase();
  for (let i = 0; i < t.length; i++) { const a = v[t[i]], b = v[t[i + 1]] || 0; total += a < b ? -a : a; }
  return total;
}
