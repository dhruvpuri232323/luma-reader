// Importing PDFs into the library and reading-progress helpers.
import { store, now } from "./store.js";
import { sha256, cleanTitle, bus, hashHue } from "../core/util.js";
import { openPdf, makeCover, closePdf } from "../reader/pdf.js";
import { TextBookModel } from "../reader/textmodel.js";
import { epubInfo, parseEpub, extractArticle, textToBlocks } from "./importers.js";

export const ACCEPT = ".pdf,.epub,.txt,.md,.markdown,.html,.htm,application/pdf,application/epub+zip,text/plain,text/markdown,text/html";

export function kindOf(file) {
  const n = (file.name || "").toLowerCase();
  if (file.type === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (file.type === "application/epub+zip" || n.endsWith(".epub")) return "epub";
  if (/\.(txt|md|markdown|html?)$/.test(n) || /^text\//.test(file.type)) return "text";
  return null;
}

function baseRecord(id, title, extra) {
  return {
    id, title, hue: hashHue(id), addedAt: now(), openedAt: 0, lastPage: 1, maxPage: 0,
    pinned: false, completedAt: 0, cloud: false, kind: "pdf", ...extra,
  };
}

async function coverFromImage(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const w = 220, h = Math.round((bmp.height / bmp.width) * 220);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(bmp, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.75);
  } catch { return null; }
}

/** Store a text-based document (article, Markdown, plain text) given its blocks. */
export async function importBlocks({ title, author = "", url = "", blocks, fileName = "" }) {
  const payload = JSON.stringify({ v: 1, title, author, url, blocks });
  const id = await sha256(new TextEncoder().encode(url ? "url:" + url : payload));
  const known = store.get("docs", id);
  await store.putFile(id, new Blob([payload], { type: "application/json" }));
  const pages = new TextBookModel(blocks).numPages;
  if (known) {
    await store.patch("docs", id, { pages });
    bus.emit("doc-imported", id);
    return { id, status: "linked", title: known.title };
  }
  await store.put("docs", baseRecord(id, title || "Untitled", { kind: "text", author, source: url, fileName: fileName || (title || "article") + ".json", size: payload.length, pages, view: "book" }));
  bus.emit("doc-imported", id);
  return { id, status: "added", title };
}

/**
 * Import files (PDF, EPUB, text, Markdown, HTML). Returns
 * [{ id, status: "added" | "linked" | "duplicate" | "error", title, error }]
 * "linked" = the book was already known (synced from another device) and this
 * device now has its file.
 */
export async function importFiles(fileList, onProgress) {
  const files = [...fileList].filter((f) => f && kindOf(f));
  const results = [];
  let i = 0;
  for (const file of files) {
    onProgress?.(i++, files.length, file.name);
    const kind = kindOf(file);
    try {
      if (kind === "text") {
        const raw = await file.text();
        let blocks, title = cleanTitle(file.name.replace(/\.(txt|md|markdown|html?)$/i, ""));
        let author = "";
        if (/\.html?$/i.test(file.name) || /^\s*<(!doctype|html)/i.test(raw)) {
          const art = extractArticle(new DOMParser().parseFromString(raw, "text/html"));
          blocks = art.blocks; title = art.title || title; author = art.author;
        } else blocks = textToBlocks(raw);
        const id = await sha256(new TextEncoder().encode(raw));
        if (store.get("docs", id) && (await store.hasFile(id))) { results.push({ id, status: "duplicate", title }); continue; }
        const payload = JSON.stringify({ v: 1, title, author, url: "", blocks });
        await store.putFile(id, new Blob([payload], { type: "application/json" }));
        const known = store.get("docs", id);
        const pages = new TextBookModel(blocks).numPages;
        if (known) { results.push({ id, status: "linked", title: known.title }); }
        else {
          await store.put("docs", baseRecord(id, title, { kind: "text", author, fileName: file.name, size: raw.length, pages, view: "book" }));
          results.push({ id, status: "added", title });
        }
        bus.emit("doc-imported", id);
        continue;
      }
      const buf = await file.arrayBuffer();
      const id = await sha256(buf);
      const known = store.get("docs", id);
      const haveFile = await store.hasFile(id);
      if (known && haveFile) {
        results.push({ id, status: "duplicate", title: known.title });
        continue;
      }
      if (kind === "epub") {
        const blob = new Blob([buf], { type: "application/epub+zip" });
        const info = await epubInfo(blob);
        const { blocks, toc } = await parseEpub(blob);
        const pages = new TextBookModel(blocks, { toc }).numPages;
        blocks.forEach((b) => b.src?.startsWith("blob:") && URL.revokeObjectURL(b.src));
        await store.putFile(id, blob);
        const cover = info.cover ? await coverFromImage(info.cover) : null;
        if (cover) await store.putCover(id, cover);
        const title = info.title || cleanTitle(file.name.replace(/\.epub$/i, ""));
        if (known) { await store.patch("docs", id, { pages }); results.push({ id, status: "linked", title: known.title }); }
        else {
          await store.put("docs", baseRecord(id, title, { kind: "epub", author: info.author, fileName: file.name, size: blob.size, pages, view: "book" }));
          results.push({ id, status: "added", title });
        }
        bus.emit("doc-imported", id);
        continue;
      }
      const blob = new Blob([buf], { type: "application/pdf" });
      const pdf = await openPdf(new Uint8Array(buf.slice(0)));
      let title = cleanTitle(file.name);
      try {
        const meta = await pdf.getMetadata();
        const t = meta?.info?.Title?.trim();
        if (t && t.length > 3 && t.length < 160 && !/^(untitled|microsoft word|document\d*|\.?pdf)/i.test(t) && !/\.(docx?|pdf|tex)$/i.test(t)) title = t;
      } catch {}
      const cover = await makeCover(pdf);
      await store.putFile(id, blob);
      if (cover) await store.putCover(id, cover);
      if (known) {
        await store.patch("docs", id, { pages: known.pages || pdf.numPages });
        results.push({ id, status: "linked", title: known.title });
      } else {
        await store.put("docs", baseRecord(id, title, { fileName: file.name || "document.pdf", size: blob.size, pages: pdf.numPages }));
        results.push({ id, status: "added", title });
      }
      closePdf(pdf);
      bus.emit("doc-imported", id);
    } catch (e) {
      console.error("Import failed", file.name, e);
      results.push({ status: "error", title: file.name, error: e?.message || String(e) });
    }
  }
  onProgress?.(files.length, files.length);
  return results;
}

export function progressOf(doc) {
  if (doc?.completedAt) return 1;
  if (!doc?.pages || doc.pages < 2) return 0;
  return Math.min(1, (doc.maxPage || 0) / doc.pages);
}

export function statusOf(doc) {
  if (doc.completedAt) return "completed";
  if ((doc.maxPage || 0) > 1 || doc.openedAt) return "reading";
  return "new";
}

export const STATUS_LABEL = { new: "Not started", reading: "Reading", completed: "Finished" };

/** Remember where you are. A book is "finished" when you actually reach its end — not just because it's short. */
export async function recordPosition(docId, page, { end = false } = {}) {
  const d = store.get("docs", docId);
  if (!d) return;
  const maxPage = Math.max(d.maxPage || 0, page);
  const finishing = !d.completedAt && end;
  if (d.lastPage === page && d.maxPage === maxPage) return;
  await store.patch("docs", docId, {
    lastPage: page,
    maxPage,
    openedAt: Date.now(),
    ...(finishing ? { completedAt: Date.now() } : {}),
  });
  if (finishing) bus.emit("doc-finished", docId);
}

export async function resetProgress(docId) {
  await store.patch("docs", docId, { lastPage: 1, maxPage: 0, completedAt: 0, openedAt: 0 });
}

export async function setCompleted(docId, done) {
  const d = store.get("docs", docId);
  await store.patch("docs", docId, { completedAt: done ? Date.now() : 0, maxPage: done ? d.pages || d.maxPage : Math.min(d.maxPage, (d.pages || 2) - 1) });
}
