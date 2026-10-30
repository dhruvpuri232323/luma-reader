// Reader view: tabs, toolbar, side panel (contents, bookmarks, notes, search),
// comparison pane, selection toolbar, focus mode and read-aloud.
import { el, $, $$, bus, debounce, isNarrow, clamp, downloadBlob, relTime, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { sync } from "../sync/sync.js";
import { importFiles } from "../data/library.js";
import { Tab } from "./tab.js";
import { ComparePane } from "./compare.js";
import { attachLookup, wordAtPoint, contextAround } from "./lookup.js";
import {
  COLORS, rangeText, renderPageHighlights, rerenderAll, createHighlight, highlightAt, annotationsFor,
  bookmarksFor, isBookmarked, toggleBookmark,
} from "./annotate.js";
import { showDefinition, hideDefinition } from "../ui/definition.js";
import { icon } from "../ui/icons.js";
import { toast, menu, dialog, confirmDialog, closeMenus } from "../ui/overlay.js";
import { speech, cue, REFLOW_FONTS, ACCENTS } from "../core/feel.js";
import { navigate } from "../ui/router.js";

const SESSION_KEY = "luma.session";
const MAX_TABS = 8;

const R = {
  root: null,
  tabs: new Map(),
  order: [],
  active: null,
  panel: null, // null | contents | bookmarks | notes | search
  compare: null,
  focus: false,
  speaking: false,
  search: { query: "", results: [], running: 0, index: 0 },
};

const activeTab = () => R.tabs.get(R.active) || null;

export function mountReader(root) {
  R.root = root;
  root.append(
    el("header.reader-top", {},
      el("button.icon-btn", { "aria-label": "Back to library", title: "Library", onclick: () => navigate("#/library") }, icon("back")),
      el("div.tabstrip", { role: "tablist", "aria-label": "Open books" }),
      el("button.tab-switch", { onclick: (e) => tabMenu(e.currentTarget), "aria-label": "Switch book" }),
      el("div.reader-actions")),
    el("div.reader-body", {},
      el("div.stage"),
      el("aside.side-panel", { hidden: true, "aria-label": "Reader panel" })),
    el("footer.reader-bottom", {}),
    el("button.focus-exit", { onclick: () => setFocus(false), "aria-label": "Exit focus mode" }, icon("focus", 18), el("span", {}, "Exit focus")),
  );
  renderActions();

  attachLookup($(".stage", root), (node) => {
    const pane = node.parentElement.closest(".tab-pane");
    const tab = pane && R.tabs.get(pane.dataset.doc);
    if (!tab) return null;
    let page = tab.currentPage();
    const pageDiv = node.parentElement.closest(".page, .reflow-page");
    if (pageDiv) page = Number(pageDiv.dataset.pageNumber || pageDiv.dataset.page) || page;
    return { docId: tab.docId, title: tab.doc?.title || "", page };
  });

  wireSelection();
  wireGestures();
  wireKeys();

  bus.on("tab-state", (tab) => { renderPaneState(tab); if (tab.docId === R.active) { renderTabs(); renderBottom(); renderActions(); } });
  bus.on("tab-page", (tab) => { if (tab.docId === R.active) { renderBottom(); updateBookmarkButton(); if (R.panel === "bookmarks") renderPanel(); } });
  bus.on("tab-scale", (tab) => tab.docId === R.active && renderBottom());
  bus.on("tab-rotation", (tab) => rerenderAll(tab));
  bus.on("tab-mode", (tab) => { if (tab.docId === R.active) { renderActions(); renderBottom(); } });
  bus.on("tab-ready", (tab) => { if (tab.docId === R.active) { renderActions(); if (R.panel) renderPanel(); } });
  bus.on("page-layer", ({ tab, pageNumber }) => renderPageHighlights(tab, pageNumber));
  bus.on("annotations-changed", (docId) => {
    const t = R.tabs.get(docId);
    if (t) rerenderAll(t);
    if (docId === R.active && R.panel === "notes") renderPanel();
  });
  bus.on("change", ({ coll, rec }) => {
    if (coll === "bookmarks" && rec.docId === R.active) { updateBookmarkButton(); if (R.panel === "bookmarks") renderPanel(); }
    if (coll === "docs") {
      if (rec.deleted && R.tabs.has(rec.id)) closeTab(rec.id);
      else if (R.tabs.has(rec.id)) renderTabs();
    }
  });
  bus.on("files", (docId) => {
    const t = R.tabs.get(docId);
    if (t && t.state === "missing") { t.state = "idle"; t.load(); }
  });
  bus.on("find-count", ({ tab, current, total }) => {
    if (tab.docId === R.active) { R.search.count = { current, total }; $(".find-count", R.root)?.replaceChildren(total ? `${current} of ${total}` : ""); }
  });
  window.addEventListener("resize", debounce(() => { renderActions(); renderTabs(); }, 150));
}

// ───────────────────────── tabs ─────────────────────────

export async function openDoc(docId, page) {
  const doc = store.get("docs", docId);
  if (!doc) { toast("That book isn't in your library."); navigate("#/library", { replace: true }); return; }
  if (!R.tabs.has(docId)) {
    if (R.order.length >= MAX_TABS) {
      const oldest = R.order.find((id) => id !== R.active);
      if (oldest) closeTab(oldest, { silent: true });
    }
    const tab = new Tab(docId);
    R.tabs.set(docId, tab);
    R.order.push(docId);
    $(".stage", R.root).append(tab.el);
  }
  activate(docId);
  const tab = R.tabs.get(docId);
  if (tab.state === "idle") await tab.load(page);
  else if (page) tab.goTo(page);
  saveSession();
}

function activate(docId) {
  R.active = docId;
  for (const [id, t] of R.tabs) {
    const on = id === docId;
    t.el.classList.toggle("active", on);
    t.el.inert = !on;
    if (on) requestAnimationFrame(() => t.shown());
  }
  hideDefinition();
  stopSpeaking();
  renderTabs();
  renderActions();
  renderBottom();
  if (R.panel) renderPanel();
  const tab = activeTab();
  if (tab) renderPaneState(tab);
  saveSession();
  markOpened(docId);
}

const markOpened = debounce((docId) => {
  const d = store.get("docs", docId);
  if (d && Date.now() - (d.openedAt || 0) > 3000) store.patch("docs", docId, { openedAt: Date.now() });
}, 400);

export function switchTo(docId) {
  if (location.hash !== `#/read/${docId}`) navigate(`#/read/${docId}`);
}

function closeTab(docId, { silent = false } = {}) {
  const tab = R.tabs.get(docId);
  if (!tab) return;
  tab.destroy();
  R.tabs.delete(docId);
  const idx = R.order.indexOf(docId);
  R.order.splice(idx, 1);
  saveSession();
  if (silent) return renderTabs();
  if (R.active === docId) {
    R.active = null;
    const next = R.order[idx] || R.order[idx - 1];
    if (next) navigate(`#/read/${next}`, { replace: true });
    else navigate("#/library", { replace: true });
  } else renderTabs();
}

function saveSession() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ order: R.order, active: R.active }));
}

/** Re-open the tabs from last time (without loading inactive ones). */
export function restoreSession() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch {}
  if (!s?.order?.length) return null;
  for (const id of s.order) {
    if (!store.get("docs", id) || R.tabs.has(id)) continue;
    const tab = new Tab(id);
    tab.el.inert = true;
    R.tabs.set(id, tab);
    R.order.push(id);
    $(".stage", R.root).append(tab.el);
  }
  renderTabs();
  return s.active && R.tabs.has(s.active) ? s.active : R.order[0] || null;
}

export const hasTabs = () => R.order.length > 0;
export const lastActive = () => R.active || R.order[R.order.length - 1] || null;

function renderTabs() {
  const strip = $(".tabstrip", R.root);
  const switcher = $(".tab-switch", R.root);
  if (!strip) return;
  setKids(strip, ...R.order.map((id) => {
    const d = store.get("docs", id);
    const on = id === R.active;
    return el("div.tab" + (on ? ".on" : ""), { role: "tab", "aria-selected": String(on) },
      el("button.tab-label", { onclick: () => switchTo(id), title: d?.title || "" }, d?.title || "Book"),
      el("button.tab-close", { "aria-label": `Close ${d?.title || "book"}`, onclick: (e) => { e.stopPropagation(); closeTab(id); } }, icon("x", 14)));
  }));
  const cur = store.get("docs", R.active);
  setKids(switcher, el("span.tab-switch-title", {}, cur?.title || ""), R.order.length > 1 ? el("span.count", {}, R.order.length) : null, icon("down", 16));
}

function tabMenu(anchor) {
  menu(anchor, [
    ...R.order.map((id) => ({ label: store.get("docs", id)?.title || "Book", icon: "book", checked: id === R.active, onClick: () => switchTo(id) })),
    "-",
    { label: "Open another book", icon: "library", onClick: () => navigate("#/library") },
    R.active ? { label: "Close this book", icon: "x", onClick: () => closeTab(R.active) } : null,
  ], { align: "start" });
}

function renderPaneState(tab) {
  let msg = tab.el.querySelector(":scope > .pane-msg");
  if (tab.state === "ready" || tab.state === "idle") { msg?.remove(); tab.container.hidden = tab.mode !== "pdf"; return; }
  tab.container.hidden = tab.state !== "loading";
  if (!msg) { msg = el("div.pane-msg"); tab.el.append(msg); }
  const doc = tab.doc;
  if (tab.state === "loading") {
    setKids(msg, el("div.spinner", { "aria-label": "Opening" }), el("p.muted", {}, "Opening…"));
  } else if (tab.state === "missing") {
    const canCloud = sync.cloudPdfs && doc?.cloud;
    const pick = el("input", { type: "file", accept: "application/pdf,.pdf", hidden: true, onchange: async (e) => {
      const res = await importFiles(e.target.files);
      const r = res[0];
      if (r?.id === tab.docId) { cue("save"); toast("Book linked to this device"); }
      else if (r?.id) toast("That's a different PDF — it was added to your library as a new book.", { action: "Open it", onAction: () => navigate(`#/read/${r.id}`) });
    } });
    setKids(msg, 
      el("h2", {}, doc?.title || "This book"),
      el("p.muted", {}, canCloud
        ? "This book was added on another device. Download it here to keep reading where you left off."
        : sync.cloudPdfs
          ? "This book was added on another device and its PDF hasn't been uploaded yet. Open the app on that device while signed in, or add the same PDF here."
          : "This book was added on another device. Add the same PDF file here and your progress, notes and words connect to it automatically."),
      el("p.small.muted", {}, `Last read at page ${doc?.lastPage || 1}${doc?.pages ? ` of ${doc.pages}` : ""}`),
      el("div.row", {},
        canCloud ? el("button.btn.primary", { onclick: async (e) => {
          e.currentTarget.disabled = true;
          e.currentTarget.textContent = "Downloading…";
          try { await sync.downloadPdf(tab.docId); } catch (err) { toast(err.message || "Download failed", { tone: "warn" }); renderPaneState(tab); }
        } }, icon("cloud", 18), el("span", {}, "Download from cloud")) : null,
        el("button.btn" + (canCloud ? "" : ".primary"), { onclick: () => pick.click() }, icon("upload", 18), el("span", {}, "Choose the PDF")),
        pick));
  } else if (tab.state === "error") {
    setKids(msg, el("h2", {}, "This PDF couldn't be opened"), el("p.muted", {}, tab.error || "The file may be damaged or password-protected."),
      el("button.btn", { onclick: () => closeTab(tab.docId) }, "Close tab"));
  }
}

// ───────────────────────── toolbar ─────────────────────────

function actionBtn(name, label, onClick, { on = false, cls = "" } = {}) {
  return el("button.icon-btn" + (on ? ".on" : "") + cls, { "aria-label": label, title: label, onclick: onClick, "aria-pressed": on ? "true" : null, dataset: { action: name } }, icon(name === "bookmark" && on ? "bookmarkOn" : name));
}

function renderActions() {
  const box = $(".reader-actions", R.root);
  if (!box) return;
  const tab = activeTab();
  const ready = tab?.state === "ready";
  const narrow = isNarrow();
  const reflow = tab?.mode === "reflow";
  const page = tab?.currentPage() || 1;
  const bm = tab && isBookmarked(tab.docId, page);
  const items = [
    actionBtn("search", "Search in book (Ctrl+F)", () => togglePanel("search"), { on: R.panel === "search" }),
    actionBtn("toc", "Contents, bookmarks & notes", () => togglePanel(R.panel && R.panel !== "search" ? R.panel : "contents"), { on: R.panel && R.panel !== "search" }),
    actionBtn("bookmark", bm ? "Remove bookmark (B)" : "Bookmark this page (B)", () => bookmarkCurrent(), { on: bm }),
  ];
  const secondary = [
    actionBtn("reflow", reflow ? "Show original pages" : "Reflow text", () => toggleReflow(), { on: reflow }),
    actionBtn("compare", "Compare with another PDF", () => toggleCompare(), { on: Boolean(R.compare) }),
    actionBtn("type", "Reading appearance", (e) => appearancePopover(e.currentTarget)),
    actionBtn("speak", R.speaking ? "Stop reading aloud" : "Read this page aloud", () => toggleSpeak(), { on: R.speaking }),
    actionBtn("focus", "Focus mode (F)", () => setFocus(true)),
  ];
  const more = el("button.icon-btn", { "aria-label": "More", title: "More", onclick: (e) => moreMenu(e.currentTarget) }, icon("more"));
  setKids(box, ...items, ...(narrow ? [] : [el("span.divider"), ...secondary]), more);
  box.querySelectorAll("button").forEach((b) => { if (b !== more && b.dataset.action !== "compare" && b.dataset.action !== "type") b.disabled = !ready && b.dataset.action !== "toc"; });
}

function updateBookmarkButton() {
  const tab = activeTab();
  const b = $('.reader-actions [data-action="bookmark"]', R.root);
  if (!tab || !b) return;
  const on = isBookmarked(tab.docId, tab.currentPage());
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
  b.title = b.ariaLabel = on ? "Remove bookmark (B)" : "Bookmark this page (B)";
  setKids(b, icon(on ? "bookmarkOn" : "bookmark"));
}

function moreMenu(anchor) {
  const tab = activeTab();
  const narrow = isNarrow();
  const reflow = tab?.mode === "reflow";
  menu(anchor, [
    narrow ? { label: reflow ? "Show original pages" : "Reflow text", icon: "reflow", onClick: toggleReflow } : null,
    narrow ? { label: R.compare ? "Close comparison" : "Compare with another PDF", icon: "compare", onClick: toggleCompare } : null,
    narrow ? { label: "Reading appearance", icon: "type", onClick: () => appearancePopover(anchor) } : null,
    narrow ? { label: R.speaking ? "Stop reading aloud" : "Read this page aloud", icon: "speak", onClick: toggleSpeak } : null,
    narrow ? { label: "Focus mode", icon: "focus", onClick: () => setFocus(true) } : null,
    narrow ? "-" : null,
    { label: "Rotate pages", icon: "rotate", onClick: () => tab?.rotate() },
    { label: "Fit page width", icon: "fit", onClick: () => tab?.setZoom("page-width") },
    { label: "Fit whole page", icon: "focus", onClick: () => tab?.setZoom("page-fit") },
    "-",
    { label: "Export notes as Markdown", icon: "file", onClick: () => exportDocNotes(tab?.docId) },
    { label: "Download PDF", icon: "download", onClick: async () => {
      const b = await store.getFile(tab.docId);
      if (b) downloadBlob(b, tab.doc?.fileName || "book.pdf");
    } },
    { label: "Close this book", icon: "x", onClick: () => tab && closeTab(tab.docId) },
  ]);
}

function renderBottom() {
  const foot = $(".reader-bottom", R.root);
  const tab = activeTab();
  if (!foot) return;
  if (!tab || tab.state !== "ready") { setKids(foot, ); return; }
  const page = tab.currentPage();
  const total = tab.pages;
  const reflow = tab.mode === "reflow";
  const input = el("input.page-input", {
    type: "number", inputmode: "numeric", min: 1, max: total, value: page, "aria-label": "Page number",
    onchange: (e) => tab.goTo(Number(e.target.value)),
    onkeydown: (e) => { if (e.key === "Enter") { tab.goTo(Number(e.target.value)); e.target.blur(); } },
  });
  const scale = tab.viewer?.currentScale || 1;
  setKids(foot, 
    el("div.progress-line", { style: { "--p": total ? page / total : 0 } }),
    el("div.pager", {},
      el("button.icon-btn", { "aria-label": "Previous page", onclick: () => tab.prev(), disabled: page <= 1 }, icon("left")),
      el("label.page-box", {}, input, el("span.muted", {}, `of ${total}`)),
      el("button.icon-btn", { "aria-label": "Next page", onclick: () => tab.next(), disabled: page >= total }, icon("right"))),
    el("span.spacer"),
    reflow ? el("span.muted.small", {}, "Reflowed text") : el("div.zoom", {},
      el("button.icon-btn", { "aria-label": "Zoom out (−)", onclick: () => tab.zoom(-1) }, icon("zoomOut")),
      el("button.zoom-val", { "aria-label": "Zoom options", onclick: (e) => zoomMenu(e.currentTarget, tab) }, `${Math.round(scale * 100)}%`),
      el("button.icon-btn", { "aria-label": "Zoom in (+)", onclick: () => tab.zoom(1) }, icon("zoomIn"))));
}

function zoomMenu(anchor, tab) {
  menu(anchor, [
    { label: "Fit width", onClick: () => tab.setZoom("page-width") },
    { label: "Fit page", onClick: () => tab.setZoom("page-fit") },
    { label: "Automatic", onClick: () => tab.setZoom("auto") },
    "-",
    ...[0.75, 1, 1.25, 1.5, 2, 3].map((z) => ({ label: `${z * 100}%`, onClick: () => tab.setZoom(z) })),
  ]);
}

// ───────────────────────── panel ─────────────────────────

function togglePanel(name) {
  R.panel = R.panel === name ? null : name;
  renderPanel();
  renderActions();
  if (R.panel === "search") setTimeout(() => $(".side-panel .search-input", R.root)?.focus(), 30);
}

function renderPanel() {
  const panel = $(".side-panel", R.root);
  const tab = activeTab();
  panel.hidden = !R.panel;
  R.root.classList.toggle("panel-open", Boolean(R.panel));
  if (!R.panel || !tab) return;
  const head = el("header.panel-head", {},
    R.panel === "search"
      ? el("strong", {}, "Search")
      : el("div.seg", { role: "tablist" }, [["contents", "Contents"], ["bookmarks", "Bookmarks"], ["notes", "Notes"]].map(([k, l]) =>
          el("button" + (R.panel === k ? ".on" : ""), { role: "tab", "aria-selected": String(R.panel === k), onclick: () => { R.panel = k; renderPanel(); } }, l))),
    el("button.icon-btn", { "aria-label": "Close panel", onclick: () => togglePanel(R.panel) }, icon("x", 18)));
  const body = el("div.panel-body");
  setKids(panel, head, body);
  ({ contents: renderContents, bookmarks: renderBookmarks, notes: renderNotes, search: renderSearch })[R.panel](body, tab);
}

async function renderContents(body, tab) {
  if (tab.state !== "ready") { body.append(el("p.muted.pad", {}, "Open the book to see its contents.")); return; }
  const outline = await tab.outline();
  if (!outline.length) {
    body.append(el("p.muted.pad", {}, "This PDF has no built-in table of contents. Use bookmarks to mark chapters yourself."));
    return;
  }
  const build = (items, depth = 0) => el("ul.toc" + (depth ? ".sub" : ""), {}, items.map((it) =>
    el("li", {},
      el("button.toc-item", { onclick: () => { tab.goToDest(it.dest); if (isNarrow()) togglePanel(R.panel); } }, it.title || "Untitled"),
      it.items?.length && depth < 4 ? build(it.items, depth + 1) : null)));
  body.append(build(outline));
}

function renderBookmarks(body, tab) {
  const list = bookmarksFor(tab.docId);
  const cur = tab.currentPage();
  body.append(
    el("button.btn.block", { onclick: bookmarkCurrent }, icon(isBookmarked(tab.docId, cur) ? "bookmarkOn" : "bookmark", 18),
      el("span", {}, isBookmarked(tab.docId, cur) ? `Remove bookmark on page ${cur}` : `Bookmark page ${cur}`)),
    list.length
      ? el("ul.item-list", {}, list.map((b) => el("li.item" + (b.page === cur ? ".current" : ""), {},
          el("button.item-main", { onclick: () => { tab.goTo(b.page); if (isNarrow()) togglePanel(R.panel); } },
            el("span.item-page", {}, `p. ${b.page}`),
            el("span.item-text", {}, b.label || "Bookmarked page"),
            el("span.item-meta", {}, relTime(b.createdAt))),
          el("button.icon-btn", { "aria-label": `Remove bookmark on page ${b.page}`, onclick: () => store.remove("bookmarks", b.id).then(() => cue("remove")) }, icon("x", 16)))))
      : el("p.muted.pad", {}, "No bookmarks yet. Press B or the bookmark button to save the page you're on."));
}

function renderNotes(body, tab) {
  const list = annotationsFor(tab.docId).sort((a, b) => a.page - b.page || (a.rects?.[0]?.y || 0) - (b.rects?.[0]?.y || 0));
  if (!list.length) {
    body.append(el("p.muted.pad", {}, "Select text in the book to highlight it or add a note. Everything you mark shows up here."));
    return;
  }
  body.append(
    el("div.row.pad-x", {}, el("span.muted.small", {}, `${list.length} ${list.length === 1 ? "highlight" : "highlights"}`), el("span.spacer"),
      el("button.link.small", { onclick: () => exportDocNotes(tab.docId) }, "Export Markdown")),
    el("ul.item-list", {}, list.map((a) => el("li.item.note-item", { dataset: { color: a.color } },
      el("button.item-main", { onclick: () => { jumpToAnnotation(tab, a); if (isNarrow()) togglePanel(R.panel); } },
        el("span.item-page", {}, `p. ${a.page}`),
        el("span.item-quote", {}, a.text),
        a.note ? el("span.item-note", {}, a.note) : null),
      el("button.icon-btn", { "aria-label": "Edit note", onclick: () => editAnnotation(a) }, icon("edit", 16))))));
}

function jumpToAnnotation(tab, a) {
  if (tab.mode === "reflow") tab.setMode("pdf");
  const r = a.rects?.[0];
  if (r && tab.viewer) {
    tab.viewer.scrollPageIntoView({ pageNumber: a.page, destArray: null });
    requestAnimationFrame(() => {
      const div = tab.viewer.getPageView(a.page - 1)?.div;
      if (div) {
        const top = div.offsetTop + r.y * div.offsetHeight - tab.container.clientHeight * 0.3;
        tab.container.scrollTo({ top: Math.max(0, top) });
        setTimeout(() => div.querySelectorAll(`.hl[data-id="${a.id}"]`).forEach((h) => { h.classList.remove("flash"); void h.offsetWidth; h.classList.add("flash"); }), 120);
      }
    });
  } else tab.goTo(a.page);
}

function renderSearch(body, tab) {
  const input = el("input.input.search-input", {
    type: "search", placeholder: "Find words in this book", value: R.search.query, "aria-label": "Search text",
    onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(tab, input.value, e.shiftKey); } },
  });
  const results = el("div.search-results");
  body.append(
    el("form.search-form", { onsubmit: (e) => { e.preventDefault(); runSearch(tab, input.value); } },
      el("label.search-wrap", {}, icon("search", 18), input),
      el("div.row", {},
        el("button.icon-btn", { type: "button", "aria-label": "Previous match", onclick: () => tab.find(R.search.query, { again: true, previous: true }) }, icon("left", 18)),
        el("button.icon-btn", { type: "button", "aria-label": "Next match", onclick: () => tab.find(R.search.query, { again: true }) }, icon("right", 18)),
        el("span.find-count.muted.small"))),
    results);
  if (R.search.docId === tab.docId) drawResults(results, tab);
}

async function runSearch(tab, query, previous = false) {
  query = query.trim();
  if (!query || tab.state !== "ready") return;
  if (R.search.query === query && R.search.docId === tab.docId && R.search.results.length) {
    tab.find(query, { again: true, previous });
    return;
  }
  R.search = { query, results: [], docId: tab.docId, running: (R.search.running || 0) + 1, done: false };
  const run = R.search.running;
  if (tab.mode === "reflow") tab.setMode("pdf");
  tab.find(query);
  const box = $(".search-results", R.root);
  const q = query.toLowerCase();
  for (let p = 1; p <= tab.pages; p++) {
    if (R.search.running !== run) return;
    const text = (await tab.text(p)).replace(/\s+/g, " ");
    const lower = text.toLowerCase();
    let i = lower.indexOf(q);
    while (i >= 0 && R.search.results.length < 400) {
      R.search.results.push({ page: p, before: text.slice(Math.max(0, i - 50), i), match: text.slice(i, i + query.length), after: text.slice(i + query.length, i + query.length + 70) });
      i = lower.indexOf(q, i + q.length);
    }
    if (p % 10 === 0 || p === tab.pages) { if (box?.isConnected) drawResults(box, tab); await new Promise((r) => setTimeout(r)); }
  }
  R.search.done = true;
  if (box?.isConnected) drawResults(box, tab);
}

function drawResults(box, tab) {
  const { results, done, query } = R.search;
  setKids(box, 
    el("p.muted.small.pad-x", {}, results.length ? `${results.length}${results.length >= 400 ? "+" : ""} matches${done ? "" : " so far…"}` : done ? `No matches for “${query}”.` : "Searching…"),
    el("ul.item-list", {}, results.slice(0, 400).map((r) =>
      el("li.item", {}, el("button.item-main", { onclick: () => {
        tab.goTo(r.page);
        tab.find(query, { highlightAll: true });
        if (isNarrow()) togglePanel("search");
      } }, el("span.item-page", {}, `p. ${r.page}`), el("span.item-text", {}, "…" + r.before, el("mark", {}, r.match), r.after + "…"))))));
}

// ───────────────────────── features ─────────────────────────

async function bookmarkCurrent() {
  const tab = activeTab();
  if (!tab || tab.state !== "ready") return;
  const page = tab.currentPage();
  const on = await toggleBookmark(tab, page);
  toast(on ? `Bookmarked page ${page}` : `Bookmark removed`);
  updateBookmarkButton();
}

async function toggleReflow() {
  const tab = activeTab();
  if (!tab || tab.state !== "ready") return;
  await tab.setMode(tab.mode === "reflow" ? "pdf" : "reflow");
  applyReflowStyle();
}

export function applyReflowStyle() {
  const s = store.settings();
  const root = document.documentElement;
  root.style.setProperty("--reflow-font", REFLOW_FONTS[s.reflowFont]?.stack || REFLOW_FONTS.newsreader.stack);
  root.style.setProperty("--reflow-size", s.reflowSize + "px");
  root.style.setProperty("--reflow-leading", s.reflowLeading);
  root.style.setProperty("--reflow-measure", { narrow: "34em", balanced: "40em", wide: "50em" }[s.reflowWidth] || "40em");
}
bus.on("settings", applyReflowStyle);
bus.on("change", ({ coll }) => coll === "settings" && applyReflowStyle());

function appearancePopover(anchor) {
  closeMenus();
  const s = store.settings();
  const tab = activeTab();
  const set = (p) => store.setSettings(p);
  const pop = el("div.menu.popover", { role: "dialog", "aria-label": "Reading appearance" });
  const seg = (label, key, opts) => el("div.pop-row", {}, el("span.pop-label", {}, label),
    el("div.seg.small", {}, opts.map(([v, l]) => el("button" + (store.settings()[key] === v ? ".on" : ""), {
      onclick: (e) => { set({ [key]: v }); e.currentTarget.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.currentTarget)); },
    }, l))));
  const range = (label, key, min, max, step, fmt) => {
    const out = el("span.pop-val", {}, fmt(s[key]));
    return el("label.pop-row", {}, el("span.pop-label", {}, label),
      el("input", { type: "range", min, max, step, value: s[key], oninput: (e) => { const v = Number(e.target.value); out.textContent = fmt(v); set({ [key]: v }); } }), out);
  };
  pop.append(
    seg("Theme", "theme", [["light", "Light"], ["sepia", "Sepia"], ["dark", "Dark"], ["auto", "Auto"]]),
    el("div.pop-row", {}, el("span.pop-label", {}, "Accent"), el("div.swatches", {}, Object.entries(ACCENTS).map(([k, a]) =>
      el("button.swatch" + (s.accent === k ? ".on" : ""), { style: { "--c": a.hex }, "aria-label": a.name, title: a.name, onclick: (e) => {
        set({ accent: k }); pop.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("on", b === e.currentTarget));
      } })))),
    el("hr"),
    el("p.pop-sub", {}, tab?.mode === "reflow" ? "Reflowed text" : "Reflowed text (turn on with the reflow button)"),
    el("label.pop-row", {}, el("span.pop-label", {}, "Font"),
      el("select.select", { onchange: (e) => set({ reflowFont: e.target.value }) }, Object.entries(REFLOW_FONTS).map(([k, f]) =>
        el("option", { value: k, selected: s.reflowFont === k }, f.name)))),
    range("Size", "reflowSize", 14, 30, 1, (v) => `${v}px`),
    range("Spacing", "reflowLeading", 1.3, 2.2, 0.05, (v) => v.toFixed(2)),
    seg("Width", "reflowWidth", [["narrow", "Narrow"], ["balanced", "Balanced"], ["wide", "Wide"]]),
  );
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  if (isNarrow()) pop.classList.add("sheet");
  else Object.assign(pop.style, { left: Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + "px", top: r.bottom + 6 + "px" });
  requestAnimationFrame(() => pop.classList.add("in"));
  setTimeout(() => document.addEventListener("pointerdown", function out(e) {
    if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("pointerdown", out, true); }
  }, true), 0);
}

async function toggleCompare() {
  const body = $(".reader-body", R.root);
  if (R.compare) {
    R.compare.destroy();
    R.compare = null;
    body.classList.remove("comparing");
    localStorage.removeItem("luma.compareOpen");
  } else {
    R.compare = new ComparePane({ onClose: toggleCompare });
    body.insertBefore(R.compare.el, $(".side-panel", body));
    body.classList.add("comparing");
    localStorage.setItem("luma.compareOpen", "1");
    await R.compare.open();
  }
  renderActions();
  requestAnimationFrame(() => activeTab()?.viewer?.update());
}
export function restoreCompare() {
  if (localStorage.getItem("luma.compareOpen") && !R.compare) toggleCompare();
}

async function toggleSpeak() {
  const tab = activeTab();
  if (!speech.supported) { toast("This browser can't read aloud."); return; }
  if (R.speaking) { stopSpeaking(); return; }
  if (!tab || tab.state !== "ready") return;
  const page = tab.currentPage();
  const text = (await tab.text(page)).replace(/-\n/g, "").replace(/\s+/g, " ").trim();
  if (!text) { toast("There's no text on this page to read."); return; }
  R.speaking = true;
  renderActions();
  speech.say(text, { onend: () => {
    R.speaking = false;
    renderActions();
  } });
}
function stopSpeaking() {
  if (!R.speaking) return;
  speech.stop();
  R.speaking = false;
  renderActions();
}

function setFocus(on) {
  R.focus = on;
  document.documentElement.classList.toggle("focus-mode", on);
  if (on) toast("Focus mode — press Esc or F to exit", { duration: 2200 });
  requestAnimationFrame(() => activeTab()?.viewer?.update());
}

// ───────────────────── selection & highlights ─────────────────────

let selBar = null;
function hideSelBar() { selBar?.remove(); selBar = null; }

function wireSelection() {
  const stage = $(".stage", R.root);
  const check = debounce(() => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hideSelBar();
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    if (!stage.contains(node)) return hideSelBar();
    const text = rangeText(range);
    if (!text) return hideSelBar();
    showSelBar(range, text);
  }, 180);
  document.addEventListener("selectionchange", check);
  stage.addEventListener("click", (e) => {
    const tab = activeTab();
    if (!tab || tab.mode !== "pdf") return;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    const a = highlightAt(tab, e.clientX, e.clientY);
    if (a) { e.preventDefault(); annotationPopover(a, e.clientX, e.clientY); }
  });
}

function showSelBar(range, text) {
  hideDefinition();
  const tab = activeTab();
  const inPdf = tab?.mode === "pdf" && range.startContainer.parentElement?.closest(".textLayer");
  const words = text.split(/\s+/).length;
  hideSelBar();
  selBar = el("div.selbar", { role: "toolbar", "aria-label": "Selection actions" });
  if (inPdf) {
    for (const [k, c] of Object.entries(COLORS)) {
      selBar.append(el("button.selbar-color", { style: { "--c": c.hex }, "aria-label": `Highlight ${c.name.toLowerCase()}`, title: `Highlight ${c.name.toLowerCase()}`,
        onmousedown: (e) => e.preventDefault(),
        onclick: async () => { const r = range.cloneRange(); hideSelBar(); document.getSelection().removeAllRanges(); await createHighlight(tab, r, { color: k }); } }));
    }
    selBar.append(el("button.selbar-btn", {
      onmousedown: (e) => e.preventDefault(),
      onclick: async () => {
        const r = range.cloneRange();
        hideSelBar();
        const note = await noteDialog("Add a note", "", text);
        document.getSelection().removeAllRanges();
        if (note != null) { await createHighlight(tab, r, { color: "sun", note: note.trim() }); toast("Note saved"); }
      } }, icon("note", 16), el("span", {}, "Note")));
  }
  if (words <= 3) {
    selBar.append(el("button.selbar-btn", {
      onmousedown: (e) => e.preventDefault(),
      onclick: () => {
        const rect = range.getBoundingClientRect();
        const node = range.startContainer;
        const page = Number(node.parentElement?.closest(".page")?.dataset.pageNumber || node.parentElement?.closest(".reflow-page")?.dataset.page || tab.currentPage());
        hideSelBar();
        showDefinition(text, rect, { docId: tab.docId, title: tab.doc?.title, page, context: node.nodeType === 3 ? contextAround(node, text) : "" }, { sticky: true });
      } }, icon("words", 16), el("span", {}, "Define")));
  }
  selBar.append(el("button.selbar-btn", {
    onmousedown: (e) => e.preventDefault(),
    onclick: async () => { await navigator.clipboard?.writeText(text).catch(() => {}); hideSelBar(); toast("Copied"); } }, icon("copy", 16), el("span", {}, "Copy")));
  if (!inPdf && tab?.mode === "reflow") selBar.append(el("span.selbar-hint", {}, "Highlight in page view"));
  document.body.append(selBar);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0);
  const last = rects[rects.length - 1] || range.getBoundingClientRect();
  const first = rects[0] || last;
  const w = selBar.offsetWidth, h = selBar.offsetHeight;
  // On touch screens the OS menu sits above the selection, so put ours below.
  let top = matchMedia("(pointer: coarse)").matches ? last.bottom + 14 : first.top - h - 10;
  if (top < 8) top = last.bottom + 12;
  if (top + h > innerHeight - 8) top = Math.max(8, first.top - h - 10);
  const left = clamp(first.left + (last.right - first.left) / 2 - w / 2, 8, innerWidth - w - 8);
  Object.assign(selBar.style, { left: left + "px", top: top + "px" });
  requestAnimationFrame(() => selBar?.classList.add("in"));
}

function noteDialog(title, value, quote) {
  return dialog({
    title,
    body: (c, done) => {
      const ta = el("textarea.input", { rows: 5, placeholder: "Your thoughts on this passage" });
      ta.value = value || "";
      ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) done(ta.value); });
      c.append(quote ? el("blockquote.quote", {}, quote.length > 280 ? quote.slice(0, 280) + "…" : quote) : "", ta);
    },
    actions: [{ label: "Cancel", value: null }, { label: "Save note", primary: true, value: (c) => c.querySelector("textarea").value }],
  });
}

export async function editAnnotation(a) {
  const note = await noteDialog(a.note ? "Edit note" : "Add a note", a.note, a.text);
  if (note != null) { await store.patch("annotations", a.id, { note: note.trim() }); toast("Note saved"); }
}

function annotationPopover(a, x, y) {
  closeMenus();
  const anchor = el("span", { style: { position: "fixed", left: x + "px", top: y + "px", width: "1px", height: "1px" } });
  document.body.append(anchor);
  const m = menu(anchor, [
    { label: a.note ? "Edit note" : "Add a note", icon: "note", onClick: () => editAnnotation(a) },
    ...Object.entries(COLORS).map(([k, c]) => ({ label: c.name, icon: "highlight", checked: a.color === k, onClick: () => store.patch("annotations", a.id, { color: k }) })),
    { label: "Copy text", icon: "copy", onClick: () => navigator.clipboard?.writeText(a.text).then(() => toast("Copied")) },
    "-",
    { label: "Delete highlight", icon: "trash", danger: true, onClick: async () => { await store.remove("annotations", a.id); cue("remove"); toast("Highlight deleted"); } },
  ], { align: "start" });
  if (a.note) m.prepend(el("p.menu-note", {}, a.note));
  [...m.querySelectorAll(".menu-item")].slice(1, 5).forEach((b, i) => {
    const c = Object.values(COLORS)[i];
    b.querySelector(".ic").style.color = c.hex;
  });
  anchor.remove();
}

export function exportDocNotes(docId) {
  if (!docId) return;
  const doc = store.get("docs", docId);
  const anns = annotationsFor(docId).sort((a, b) => a.page - b.page);
  const bms = bookmarksFor(docId);
  const lines = [`# ${doc?.title || "Notes"}`, "", `_Exported from Luma Reader on ${new Date().toLocaleDateString()}_`, ""];
  if (anns.length) {
    lines.push("## Highlights and notes", "");
    for (const a of anns) {
      lines.push(`> ${a.text.replace(/\n/g, " ")}`, `> — page ${a.page} (${COLORS[a.color]?.name.toLowerCase() || a.color})`, "");
      if (a.note) lines.push(a.note, "");
    }
  }
  if (bms.length) {
    lines.push("## Bookmarks", "");
    bms.forEach((b) => lines.push(`- Page ${b.page}${b.label ? ` — ${b.label}` : ""}`));
  }
  if (!anns.length && !bms.length) { toast("This book has no notes or bookmarks yet."); return; }
  downloadBlob(new Blob([lines.join("\n")], { type: "text/markdown" }), `${(doc?.title || "notes").replace(/[\\/:*?"<>|]+/g, "-")} – notes.md`);
}

// ───────────────────────── input ─────────────────────────

function wireGestures() {
  const stage = $(".stage", R.root);
  // Ctrl/⌘ + wheel or trackpad pinch
  stage.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const tab = activeTab();
    if (!tab?.viewer || tab.mode !== "pdf") return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025));
    tab.scaleBy(factor, [e.clientX, e.clientY]);
  }, { passive: false });

  // Two-finger pinch on touch screens: preview with a CSS transform, then re-render.
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  stage.addEventListener("touchstart", (e) => {
    const tab = activeTab();
    if (e.touches.length !== 2 || !tab?.viewer || tab.mode !== "pdf") return;
    const viewerEl = tab.container.querySelector(".pdfViewer");
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const b = viewerEl.getBoundingClientRect();
    pinch = { tab, d0: dist(e.touches), f: 1, cx, cy, viewerEl };
    viewerEl.style.transformOrigin = `${cx - b.left}px ${cy - b.top}px`;
  }, { passive: true });
  stage.addEventListener("touchmove", (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    pinch.f = clamp(dist(e.touches) / pinch.d0, 0.3, 4);
    pinch.viewerEl.style.transform = `scale(${pinch.f})`;
  }, { passive: false });
  const end = () => {
    if (!pinch) return;
    const { tab, f, cx, cy, viewerEl } = pinch;
    pinch = null;
    viewerEl.style.transform = "";
    if (Math.abs(f - 1) > 0.03) tab.scaleBy(f, [cx, cy]);
  };
  stage.addEventListener("touchend", end);
  stage.addEventListener("touchcancel", end);
}

function wireKeys() {
  document.addEventListener("keydown", (e) => {
    if (!R.root.closest(".view")?.classList.contains("active")) return;
    const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
    const tab = activeTab();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      if (R.panel !== "search") togglePanel("search"); else $(".side-panel .search-input", R.root)?.select();
      return;
    }
    if (e.key === "Escape") {
      if (R.focus) setFocus(false);
      else if (selBar) hideSelBar();
      return;
    }
    if (typing || e.altKey || !tab) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); tab.zoom(1); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === "-") { e.preventDefault(); tab.zoom(-1); return; }
    if (e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k === "ArrowRight" || (k === "PageDown" && tab.mode === "reflow")) { e.preventDefault(); tab.next(); }
    else if (k === "ArrowLeft" || (k === "PageUp" && tab.mode === "reflow")) { e.preventDefault(); tab.prev(); }
    else if (k === "Home" && e.shiftKey) tab.goTo(1);
    else if (k === "End" && e.shiftKey) tab.goTo(tab.pages);
    else if (k === "+" || k === "=") tab.zoom(1);
    else if (k === "-") tab.zoom(-1);
    else if (k === "b" || k === "B") bookmarkCurrent();
    else if (k === "f" || k === "F") setFocus(!R.focus);
    else if (k === "r" && tab.mode !== "reflow" && e.shiftKey) tab.rotate();
  });
}

export function readerActive() {
  return activeTab();
}

export function afterShow() {
  activeTab()?.shown();
  renderActions();
  renderBottom();
}

// tests & debugging
window.__luma = Object.assign(window.__luma || {}, { reader: R });
