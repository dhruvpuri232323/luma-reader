// Loads PDF.js (vendored in /vendor/pdfjs) once and exposes helpers.

const base = new URL("../../vendor/pdfjs/", import.meta.url).href;
let libPromise;
let viewerPromise;

export function pdfjs() {
  libPromise ||= import(base + "pdf.min.mjs").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";
    globalThis.pdfjsLib = lib;
    return lib;
  });
  return libPromise;
}

/** PDF.js viewer components (PDFViewer, EventBus, PDFLinkService, PDFFindController). */
export function pdfViewerLib() {
  viewerPromise ||= pdfjs().then(() => import(base + "web/pdf_viewer.mjs"));
  return viewerPromise;
}

export async function openPdf(source) {
  const lib = await pdfjs();
  const data = source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : source;
  const task = lib.getDocument({
    data,
    cMapUrl: base + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: base + "standard_fonts/",
    wasmUrl: base + "wasm/",
    iccUrl: base + "iccs/",
    isEvalSupported: false,
  });
  return task.promise;
}

/** Render one page to a canvas sized to `width` CSS px. */
export async function renderPageToCanvas(pdf, pageNumber, width, { rotation = 0, canvas, scale: forcedScale } = {}) {
  const page = await pdf.getPage(pageNumber);
  const base1 = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
  const scale = forcedScale || width / base1.width;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const viewport = page.getViewport({ scale: scale * dpr, rotation: (page.rotate + rotation) % 360 });
  canvas ||= document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = Math.floor(viewport.width / dpr) + "px";
  canvas.style.height = Math.floor(viewport.height / dpr) + "px";
  const task = page.render({ canvas, viewport });
  await task.promise;
  return canvas;
}

/** Plain text of one page, in reading order, with line breaks between lines. */
export async function pageText(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const tc = await page.getTextContent();
  let out = "";
  let lastY = null;
  for (const item of tc.items) {
    if (!("str" in item)) continue;
    const y = item.transform?.[5];
    if (lastY != null && Math.abs(y - lastY) > 2 && !out.endsWith("\n")) out += "\n";
    out += item.str;
    if (item.hasEOL) out += "\n";
    lastY = y;
  }
  return out;
}

/** Paragraph-ish blocks for reflow mode. */
export async function pageParagraphs(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const tc = await page.getTextContent();
  const lines = [];
  let cur = null;
  for (const item of tc.items) {
    if (!("str" in item)) continue;
    const [, , , d, x, y] = item.transform;
    const h = Math.abs(d) || item.height || 10;
    if (!cur || Math.abs(y - cur.y) > h * 0.5) {
      cur = { y, x, h, text: "" };
      lines.push(cur);
    }
    cur.text += item.str;
    if (item.hasEOL) cur = null;
  }
  const paras = [];
  let buf = "";
  let prev = null;
  const flush = () => { if (buf.trim()) paras.push(buf.replace(/\s+/g, " ").trim()); buf = ""; };
  for (const ln of lines) {
    const t = ln.text.trim();
    if (!t) { flush(); prev = null; continue; }
    if (prev) {
      const gap = prev.y - ln.y;
      const bigGap = gap > prev.h * 1.75 || gap < 0;
      const indent = ln.x - prev.x > prev.h * 1.2;
      const endsSentence = /[.!?:"”)]$/.test(prev.text.trim());
      if (bigGap || (indent && endsSentence)) flush();
    }
    if (buf.endsWith("-") && /^[a-z]/.test(t)) buf = buf.slice(0, -1) + t;
    else buf += (buf ? " " : "") + t;
    prev = ln;
  }
  flush();
  return paras;
}

export async function makeCover(pdf) {
  try {
    const canvas = await renderPageToCanvas(pdf, 1, 220, { scale: null });
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}

/** Release a document and its worker resources. */
export function closePdf(pdf) {
  try { (pdf?.loadingTask || pdf)?.destroy?.(); } catch { /* already closed */ }
}
