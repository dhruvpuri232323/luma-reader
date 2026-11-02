// Scanned books: read every page with on-device text recognition, all at once,
// several pages side by side, then hand the text to Book view, the word card,
// read-aloud and search — as if the PDF had had text all along. The result is
// kept on the device, so each book is read only once.
import { store } from "../data/store.js";
import { bus } from "../core/util.js";

const jobs = new Map(); // docId → job
const KEY = (docId) => "ocr:" + docId;
const V = 1;

/** Text read from this book before, or null. */
export async function savedOcr(docId) {
  const r = await store.kvGet(KEY(docId)).catch(() => null);
  return r?.v === V ? r.pages : null;
}

export const ocrJob = (docId) => jobs.get(docId) || null;

/** How many pages to read at once: most of the processor, gently on phones. */
function poolSize() {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 8;
  const phone = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 820;
  return Math.max(1, Math.min(phone ? 2 : 6, cores - 1, memory <= 4 ? 2 : 6));
}

/** One page as a greyscale image about 1800 pixels wide (≈ 300 dpi for a book page). */
async function renderGray(pdf, p) {
  const page = await pdf.getPage(p);
  const v1 = page.getViewport({ scale: 1 });
  const scale = Math.min(4, Math.max(1.2, 1800 / v1.width));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  await page.render({ canvas, viewport: vp }).promise;
  const { width: w, height: h } = canvas;
  const data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  canvas.width = canvas.height = 0;
  page.cleanup();
  return { w, h, gray, pw: v1.width, ph: v1.height };
}

/**
 * Read the whole book. Returns a job: { docId, total, done, state, startedAt, promise, cancel() }.
 * Emits "ocr-progress" { docId, done, total, eta } and "ocr-done" { docId, ok }.
 */
export function readScanned(docId, pdf, { lang = null } = {}) {
  if (jobs.has(docId)) return jobs.get(docId);
  const total = pdf.numPages;
  const job = { docId, total, done: 0, state: "running", startedAt: Date.now(), workers: [], cancelled: false };
  let stopped;
  const whenStopped = new Promise((r) => { stopped = r; });
  job.cancel = () => {
    if (job.state !== "running") return;
    job.cancelled = true; job.state = "cancelled";
    job.workers.forEach((w) => w.terminate());
    jobs.delete(docId);
    stopped(null);
    bus.emit("ocr-done", { docId, ok: false, cancelled: true });
  };
  job.eta = () => {
    if (job.done < 2) return null;
    const per = (Date.now() - job.startedAt) / job.done;
    return Math.round((per * (total - job.done)) / 1000);
  };
  jobs.set(docId, job);
  const work = (async () => {
    const pages = new Array(total);
    const n = Math.min(poolSize(), total);
    const queue = Array.from({ length: total }, (_, i) => i + 1);
    const spawn = () => {
      const worker = new Worker(new URL("./ocr-worker.js", import.meta.url));
      job.workers.push(worker);
      worker.ask = (msg) => new Promise((resolve, reject) => {
        worker.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data));
        worker.onerror = (e) => reject(new Error(e.message || "The reading engine stopped"));
        worker.postMessage(msg, [msg.gray.buffer]);
      });
      return worker;
    };
    const done = (p, img, res) => {
      pages[p - 1] = { w: img.pw, h: img.ph, lines: res.lines };
      job.done++;
      bus.emit("ocr-progress", { docId, done: job.done, total, eta: job.eta() });
    };
    try {
    // Which language is the book in? Read one page in English, and in Hindi if that went badly.
    const first = spawn();
    if (!lang) {
      const p = Math.min(2, total);
      const img = await renderGray(pdf, p);
      const copy = img.gray.slice();
      const eng = await first.ask({ id: p, w: img.w, h: img.h, gray: img.gray, lang: "eng" });
      let best = { lang: "eng", res: eng };
      if (eng.conf < 75 && !job.cancelled) {
        const hin = await first.ask({ id: p, w: img.w, h: img.h, gray: copy, lang: "hin" });
        if (hin.conf > eng.conf + 8) best = { lang: "hin", res: hin };
      }
      lang = best.lang;
      if (!job.cancelled) { done(p, img, best.res); queue.splice(queue.indexOf(p), 1); }
    }
    job.lang = lang;
    const loop = async (worker) => {
      while (queue.length && !job.cancelled) {
        const p = queue.shift();
        const img = await renderGray(pdf, p);
        if (job.cancelled) break;
        done(p, img, await worker.ask({ id: p, w: img.w, h: img.h, gray: img.gray, lang }));
      }
      worker.terminate();
    };
      await Promise.all([loop(first), ...Array.from({ length: n - 1 }, () => loop(spawn()))]);
      if (job.cancelled) return null;
      await store.kvSet(KEY(docId), { v: V, pages, lang, at: Date.now() }).catch(() => {});
      job.state = "done";
      bus.emit("ocr-done", { docId, ok: true });
      return pages;
    } catch (e) {
      job.state = "error";
      job.error = e?.message || String(e);
      job.workers.forEach((w) => w.terminate());
      bus.emit("ocr-done", { docId, ok: false, error: job.error });
      throw e;
    } finally {
      if (jobs.get(docId) === job) jobs.delete(docId);
    }
  })();
  job.promise = Promise.race([work, whenStopped]); // Stop settles it at once
  work.catch(() => {});
  return job;
}

export async function forgetOcr(docId) {
  jobs.get(docId)?.cancel();
  await store.kvSet(KEY(docId), null).catch(() => {});
}

/** "about 2 min left" */
export function etaText(sec) {
  if (sec == null) return "working out how long it will take";
  if (sec < 50) return "less than a minute left";
  const m = Math.round(sec / 60);
  return m < 60 ? `about ${m} min left` : `about ${Math.floor(m / 60)} h ${m % 60} min left`;
}

// ───────── Page view: an invisible text layer over the scanned image ─────────
const measure = document.createElement("canvas").getContext("2d");

/** Put the words read from a page over the page image, so they can be hovered, tapped and selected. */
export function overlayPage(pageDiv, ocrPage) {
  if (!pageDiv || !ocrPage?.lines?.length) return;
  let layer = pageDiv.querySelector(".textLayer");
  if (!layer) { layer = document.createElement("div"); layer.className = "textLayer"; pageDiv.append(layer); }
  if (layer.dataset.ocr === "1" && layer.querySelector(".ocr-l")) return;
  layer.textContent = "";
  layer.dataset.ocr = "1";
  layer.classList.add("ocrLayer");
  // sizes are in fractions of the page (%, and cqh for the text), so zooming needs no redraw
  const REF = 1000; // a reference page height for measuring how wide each line's text is
  const aspect = (ocrPage.w || 1) / (ocrPage.h || 1);
  const frag = document.createDocumentFragment();
  for (const l of ocrPage.lines) {
    // one span per word, each stretched to the word in the picture (justified lines space words unevenly)
    const fsFrac = Math.max(0.004, l.h * 0.86);
    measure.font = `${fsFrac * REF}px sans-serif`;
    l.words.forEach((w, i) => {
      const next = l.words[i + 1];
      const text = next ? w[4] + " " : w[4]; // the space keeps words apart when text is selected and copied
      const span = document.createElement("span");
      span.className = "ocr-l";
      span.textContent = text;
      span.style.left = w[0] * 100 + "%";
      span.style.top = l.y * 100 + "%";
      span.style.fontSize = fsFrac * 100 + "cqh";
      const natural = measure.measureText(w[4]).width || 1; // stretch the word itself to the word in the picture
      span.style.transform = `scaleX(${(w[2] * REF * aspect) / natural})`;
      frag.append(span);
    });
    frag.append(document.createElement("br"));
  }
  layer.append(frag);
}
