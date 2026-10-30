// Importing PDFs into the library and reading-progress helpers.
import { store, now } from "./store.js";
import { sha256, cleanTitle, bus, hashHue } from "../core/util.js";
import { openPdf, makeCover, closePdf } from "../reader/pdf.js";

/**
 * Import PDF files. Returns [{ id, status: "added" | "linked" | "duplicate" | "error", title, error }]
 * "linked" = the book was already known (synced from another device) and this
 * device now has its file.
 */
export async function importFiles(fileList, onProgress) {
  const files = [...fileList].filter((f) => f && (f.type === "application/pdf" || /\.pdf$/i.test(f.name || "")));
  const results = [];
  let i = 0;
  for (const file of files) {
    onProgress?.(i++, files.length, file.name);
    try {
      const buf = await file.arrayBuffer();
      const id = await sha256(buf);
      const known = store.get("docs", id);
      const haveFile = await store.hasFile(id);
      if (known && haveFile) {
        results.push({ id, status: "duplicate", title: known.title });
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
        await store.put("docs", {
          id,
          title,
          fileName: file.name || "document.pdf",
          size: blob.size,
          pages: pdf.numPages,
          hue: hashHue(id),
          addedAt: now(),
          openedAt: 0,
          lastPage: 1,
          maxPage: 0,
          pinned: false,
          completedAt: 0,
          cloud: false,
        });
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
  if (!doc?.pages) return 0;
  if (doc.completedAt) return 1;
  return Math.min(1, (doc.maxPage || 0) / doc.pages);
}

export function statusOf(doc) {
  if (doc.completedAt || (doc.pages && doc.maxPage >= doc.pages)) return "completed";
  if ((doc.maxPage || 0) > 1 || doc.openedAt) return "reading";
  return "new";
}

export const STATUS_LABEL = { new: "Not started", reading: "Reading", completed: "Finished" };

export async function recordPosition(docId, page) {
  const d = store.get("docs", docId);
  if (!d) return;
  const maxPage = Math.max(d.maxPage || 0, page);
  const finishing = !d.completedAt && d.pages && maxPage >= d.pages;
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
