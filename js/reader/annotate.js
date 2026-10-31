// Highlights and notes drawn over the original PDF layout, plus bookmarks.
// Rects are stored normalized (0..1) in the page's unrotated frame so they
// survive zoom, rotation and different screen sizes.
import { el, uid, bus, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { cue } from "../core/feel.js";
import { TextIndex, textLayerSpans } from "./textindex.js";

export const COLORS = {
  sun: { name: "Yellow", hex: "#F7D148" },
  mint: { name: "Green", hex: "#7FD39B" },
  sky: { name: "Blue", hex: "#7DB8F5" },
  rose: { name: "Pink", hex: "#F59BB8" },
};

// rotation helpers on normalized rects {x,y,w,h}
function toDisplay(r, rot) {
  switch (rot) {
    case 90: return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
    case 180: return { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h };
    case 270: return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
    default: return r;
  }
}
function fromDisplay(r, rot) {
  switch (rot) {
    case 90: return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
    case 180: return { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h };
    case 270: return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
    default: return r;
  }
}

/**
 * Text of a range from the PDF text layer. Range.toString() glues lines
 * together ("had" + "warned"), so line breaks (<br> or a new span on a lower
 * line) become spaces, and end-of-line hyphenation is undone.
 */
export function rangeText(range) {
  const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  if (!root.closest?.(".textLayer") && !root.querySelector?.(".textLayer")) return range.toString().replace(/\s+/g, " ").trim();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let out = "";
  let lastTop = null;
  for (let n = walker.currentNode; n; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      if (n.tagName === "BR") out += "\n";
      continue;
    }
    if (!n.parentElement?.closest(".textLayer")) continue;
    let t = n.data;
    if (n === range.endContainer) t = t.slice(0, range.endOffset);
    if (n === range.startContainer) t = t.slice(range.startOffset);
    const top = Math.round(n.parentElement.getBoundingClientRect().top);
    if (lastTop != null && Math.abs(top - lastTop) > 3 && !/\s$/.test(out)) out += "\n";
    lastTop = top;
    out += t;
  }
  return out.replace(/(\w)-\n(\w)/g, "$1$2").replace(/\s+/g, " ").trim();
}

export function annotationsFor(docId, page) {
  return store.list("annotations").filter((a) => a.docId === docId && (page == null || a.page === page));
}

export function renderPageHighlights(tab, pageNumber) {
  const view = tab.viewer?.getPageView(pageNumber - 1);
  const div = view?.div;
  if (!div) return;
  let layer = div.querySelector(":scope > .hl-layer");
  if (!layer) {
    layer = el("div.hl-layer", { "aria-hidden": "true" });
    div.append(layer);
  }
  setKids(layer, );
  const rot = tab.rotation;
  // Highlights made in Book view carry only their text: find it on the page once.
  for (const a of annotationsFor(tab.docId, pageNumber)) {
    if ((!a.rects || !a.rects.length) && a.text && !located.has(a.id)) {
      const rects = locateRects(tab, pageNumber, a.text);
      if (rects?.length) { located.add(a.id); store.patch("annotations", a.id, { rects }); }
    }
  }
  for (const a of annotationsFor(tab.docId, pageNumber)) {
    for (const r0 of a.rects || []) {
      const r = toDisplay(r0, rot);
      layer.append(el("div.hl" + (a.note ? ".has-note" : ""), {
        dataset: { id: a.id, color: a.color },
        style: { left: r.x * 100 + "%", top: r.y * 100 + "%", width: r.w * 100 + "%", height: r.h * 100 + "%" },
      }));
    }
    if (a.note && a.rects?.length) {
      const r = toDisplay(a.rects[a.rects.length - 1], rot);
      layer.append(el("div.hl-pin", { dataset: { id: a.id, color: a.color }, style: { left: (r.x + r.w) * 100 + "%", top: r.y * 100 + "%" } }));
    }
  }
}

export function rerenderAll(tab) {
  if (!tab?.viewer) return;
  for (let i = 1; i <= tab.pages; i++) {
    const v = tab.viewer.getPageView(i - 1);
    if (v?.div?.querySelector(".hl-layer") || annotationsFor(tab.docId, i).length) renderPageHighlights(tab, i);
  }
}

/** Convert the current selection inside a tab into per-page normalized rects. */
export function selectionToPageRects(tab, range) {
  const pages = [...tab.container.querySelectorAll(".page")];
  const byPage = new Map();
  for (const cr of range.getClientRects()) {
    if (cr.width < 1 || cr.height < 1) continue;
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    const pageDiv = pages.find((p) => {
      const b = p.getBoundingClientRect();
      return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
    });
    if (!pageDiv) continue;
    const b = pageDiv.getBoundingClientRect();
    const n = Number(pageDiv.dataset.pageNumber);
    const r = { x: (cr.left - b.left) / b.width, y: (cr.top - b.top) / b.height, w: cr.width / b.width, h: cr.height / b.height };
    if (!byPage.has(n)) byPage.set(n, []);
    byPage.get(n).push(r);
  }
  const rot = tab.rotation;
  const out = [];
  for (const [page, rects] of byPage) out.push({ page, rects: mergeRects(rects).map((r) => round(fromDisplay(r, rot))) });
  return out.sort((a, b) => a.page - b.page);
}

const round = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 10000) / 10000]));

function mergeRects(rects) {
  const sorted = rects.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const overlapY = Math.min(last.y + last.h, r.y + r.h) - Math.max(last.y, r.y);
      const sameLine = overlapY > Math.min(last.h, r.h) * 0.5;
      const contained = r.x >= last.x - 0.002 && r.x + r.w <= last.x + last.w + 0.002 && sameLine;
      if (contained) continue;
      if (sameLine && r.x <= last.x + last.w + 0.012) {
        const x = Math.min(last.x, r.x), y = Math.min(last.y, r.y);
        last.w = Math.max(last.x + last.w, r.x + r.w) - x;
        last.h = Math.max(last.y + last.h, r.y + r.h) - y;
        last.x = x; last.y = y;
        continue;
      }
    }
    out.push({ ...r });
  }
  return out;
}

const located = new Set();

/** Normalized page rects for a piece of text on a rendered PDF page, or null. */
export function locateRects(tab, pageNumber, text) {
  const div = tab.viewer?.getPageView(pageNumber - 1)?.div;
  const layer = div?.querySelector(".textLayer");
  if (!layer || !layer.querySelector("span")) return null;
  const r = new TextIndex(textLayerSpans(layer)).rangeOf(text);
  if (!r) return null;
  const b = div.getBoundingClientRect();
  const rects = [...r.getClientRects()].filter((cr) => cr.width > 1 && cr.height > 1)
    .map((cr) => ({ x: (cr.left - b.left) / b.width, y: (cr.top - b.top) / b.height, w: cr.width / b.width, h: cr.height / b.height }));
  if (!rects.length) return null;
  return mergeRects(rects).map((x) => round(fromDisplay(x, tab.rotation)));
}

/** Highlight made in Book view: anchored by its text and page. */
export async function createTextHighlight(tab, range, { color = "sun", note = "" } = {}) {
  const text = range.toString().replace(/\s+/g, " ").trim();
  const startEl = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement).closest(".bk-b");
  const page = Number(startEl?.dataset.page) || tab.currentPage();
  if (!text) return null;
  const rec = await store.put("annotations", {
    id: uid("a"), docId: tab.docId, docTitle: tab.doc?.title || "", page, color, text, note, rects: [], createdAt: Date.now(),
  });
  cue("save");
  return rec;
}

export async function createHighlight(tab, range, { color = "sun", note = "" } = {}) {
  const text = rangeText(range);
  const parts = selectionToPageRects(tab, range);
  if (!parts.length) return [];
  const doc = tab.doc;
  const group = parts.length > 1 ? uid("g") : null;
  const created = [];
  for (const p of parts) {
    created.push(await store.put("annotations", {
      id: uid("a"),
      docId: tab.docId,
      docTitle: doc?.title || "",
      page: p.page,
      color,
      text: parts.length > 1 ? textForPage(range, tab, p.page) || text : text,
      note,
      rects: p.rects,
      group,
      createdAt: Date.now(),
    }));
  }
  cue("save");
  return created;
}

function textForPage(range, tab, page) {
  const pageDiv = tab.container.querySelector(`.page[data-page-number="${page}"]`);
  if (!pageDiv) return "";
  const r = range.cloneRange();
  const tl = pageDiv.querySelector(".textLayer");
  if (!tl) return "";
  if (!tl.contains(r.startContainer)) r.setStart(tl, 0);
  if (!tl.contains(r.endContainer)) r.setEnd(tl, tl.childNodes.length);
  return rangeText(r);
}

/** Find the highlight under a viewport point inside a tab. */
export function highlightAt(tab, x, y) {
  const pageDiv = document.elementsFromPoint(x, y).find((n) => n.classList?.contains("page"));
  if (!pageDiv || !tab.container.contains(pageDiv)) return null;
  const b = pageDiv.getBoundingClientRect();
  const nx = (x - b.left) / b.width, ny = (y - b.top) / b.height;
  const page = Number(pageDiv.dataset.pageNumber);
  const rot = tab.rotation;
  return annotationsFor(tab.docId, page).find((a) =>
    (a.rects || []).some((r0) => {
      const r = toDisplay(r0, rot);
      return nx >= r.x - 0.003 && nx <= r.x + r.w + 0.003 && ny >= r.y - 0.003 && ny <= r.y + r.h + 0.003;
    })) || null;
}

// ── Bookmarks ──
export const bookmarkId = (docId, page) => `${docId.slice(0, 24)}-${page}`;
export function bookmarksFor(docId) {
  return store.list("bookmarks").filter((b) => b.docId === docId).sort((a, b) => a.page - b.page);
}
export function isBookmarked(docId, page) {
  return Boolean(store.get("bookmarks", bookmarkId(docId, page)));
}
export async function toggleBookmark(tab, page) {
  const id = bookmarkId(tab.docId, page);
  if (store.get("bookmarks", id)) {
    await store.remove("bookmarks", id);
    cue("remove");
    return false;
  }
  let label = "";
  try {
    label = (await tab.text(page)).split("\n").map((s) => s.trim()).find((s) => s.length > 3) || "";
  } catch {}
  await store.put("bookmarks", { id, docId: tab.docId, docTitle: tab.doc?.title || "", page, label: label.slice(0, 90), createdAt: Date.now() });
  cue("bookmark");
  return true;
}

bus.on("change", ({ coll, rec }) => {
  if (coll === "annotations") bus.emit("annotations-changed", rec.docId);
});
