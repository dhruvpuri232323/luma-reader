// Reads the text on a scanned page, on the device (Tesseract 5, WebAssembly).
// Several of these run side by side so a whole book is read quickly.
// In:  { id, w, h, gray: Uint8Array (one byte per pixel), lang: "eng" | "hin" | "hin+eng" }
// Out: { id, lines: [{ x, y, w, h, b, p, words: [[x, y, w, h, text]] }], conf } — positions as fractions of the page
/* global TesseractCore */

const BASE = "../../vendor/ocr/";
const simd = (() => {
  try { // a tiny module that uses a SIMD instruction: does this browser accept it?
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch { return false; }
})();

let api = null;
let M = null;
let current = null; // the language(s) the engine is set up for, e.g. "eng" or "hin"
const loaded = new Set();
const core = (async () => {
  importScripts(BASE + (simd ? "tesseract-core-simd-lstm" : "tesseract-core-lstm") + ".js");
  M = await TesseractCore({ locateFile: (p) => BASE + p });
  api = new M.TessBaseAPI();
})();

/** Load a language's reading model (once) and set the engine up for it. */
async function useLang(lang) {
  await core;
  for (const l of lang.split("+")) {
    if (loaded.has(l)) continue;
    const res = await fetch(BASE + l + ".traineddata.gz");
    if (!res.ok) throw new Error("The reading model couldn't be downloaded");
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) { // still gzipped (most servers don't unpack it for us)
      bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    }
    M.FS.writeFile(l + ".traineddata", bytes);
    loaded.add(l);
  }
  if (current !== lang) {
    if (api.Init(null, lang) !== 0) throw new Error("The reading engine couldn't start");
    api.SetVariable("user_defined_dpi", "300");
    current = lang;
  }
}

function pgm(w, h, gray) {
  const head = new TextEncoder().encode(`P5\n${w} ${h}\n255\n`);
  const out = new Uint8Array(head.length + gray.length);
  out.set(head, 0);
  out.set(gray, head.length);
  return out;
}

function parse(tsv, W, H) {
  const lines = new Map();
  let confSum = 0, confN = 0;
  const r4 = (n) => Math.round(n * 1e4) / 1e4;
  for (const row of tsv.split("\n")) {
    const c = row.split("\t");
    if (c.length < 12) continue;
    const level = +c[0];
    const key = `${c[2]}.${c[3]}.${c[4]}`;
    const [x, y, w, h] = [+c[6], +c[7], +c[8], +c[9]];
    if (level === 4) lines.set(key, { x: r4(x / W), y: r4(y / H), w: r4(w / W), h: r4(h / H), b: +c[2], p: +c[3], words: [] });
    if (level === 5) {
      const text = c.slice(11).join("\t").trim();
      const conf = +c[10];
      if (text && conf >= 0) { confSum += conf; confN++; }
      if (!text || (conf < 20 && !/[\p{L}\p{N}]{2}/u.test(text))) continue; // specks of dust read as letters
      lines.get(key)?.words.push([r4(x / W), r4(y / H), r4(w / W), r4(h / H), text]);
    }
  }
  return { lines: [...lines.values()].filter((l) => l.words.length), conf: confN ? confSum / confN : 0 };
}

self.onmessage = async (e) => {
  const { id, w, h, gray, lang = "eng" } = e.data;
  try {
    await useLang(lang);
    M.FS.writeFile("/input", pgm(w, h, gray));
    if (api.SetImageFile(1, 0) === 1) throw new Error("The page image couldn't be read");
    api.Recognize(null);
    const { lines, conf } = parse(api.GetTSVText(0), w, h);
    api.Clear();
    self.postMessage({ id, lines, conf });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
