// Reader view: tabs, Page/Book switch, toolbar, side panel (contents,
// bookmarks, notes, search), comparison pane, selection toolbar, focus mode,
// and the Listen player.
import { el, $, $$, bus, debounce, isNarrow, clamp, downloadBlob, relTime, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { sync } from "../sync/sync.js";
import { drive } from "../sync/drive.js";
import { indexInBackground } from "../data/fulltext.js";
import { importFiles, ACCEPT } from "../data/library.js";
import { Tab } from "./tab.js";
import { ComparePane } from "./compare.js";
import { attachLookup, wordAtPoint, contextAround } from "./lookup.js";
import {
  COLORS, rangeText, renderPageHighlights, rerenderAll, createHighlight, createTextHighlight, highlightAt, annotationsFor,
  bookmarksFor, isBookmarked, toggleBookmark,
} from "./annotate.js";
import { showDefinition, hideDefinition } from "../ui/definition.js";
import { openResearch } from "../ui/research.js";
import { feelPopover } from "../ui/feelpanel.js";
import { lightPopover } from "../ui/lightswitch.js";
import { attachActivity } from "../data/activity.js";
import { timerChip } from "../ui/timer.js";
import { feelFor, EDITIONS } from "../core/bookfeel.js";
import { icon } from "../ui/icons.js";
import { toast, menu, dialog, confirmDialog, closeMenus } from "../ui/overlay.js";
import { cue, MODES, currentMode } from "../core/feel.js";
import { player, audiobookDialog, pronunciationsDialog } from "./player.js";
import { warmUp } from "../core/voice.js";
import { AutoScroll } from "./autoscroll.js";
import { maybeRecap } from "./recap.js";
import { renderWordsHere } from "./hardwords.js";
import { quoteCardDialog } from "../ui/quotecard.js";
import { exportNotesMenu } from "../ui/export.js";
import { typographyControls } from "../ui/typography.js";
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
  // reading time, pages and pace, measured quietly while you read
  attachActivity({
    getTab: () => (player.state === "playing" && player.tab ? player.tab : activeTab()),
    isListening: () => player.state === "playing",
    root,
  });
  root.append(
    el("header.reader-top", {},
      el("button.icon-btn", { "aria-label": "Back to library", title: "Library", onclick: () => navigate("#/library") }, icon("back")),
      el("div.tabstrip", { role: "tablist", "aria-label": "Open books" }),
      el("button.tab-switch", { onclick: (e) => tabMenu(e.currentTarget), "aria-label": "Switch book" }),
      el("div.mode-seg", { role: "group", "aria-label": "View" }),
      el("div.reader-actions")),
    el("div.reader-body", {},
      el("div.stage"),
      el("aside.side-panel", { hidden: true, "aria-label": "Reader panel" })),
    el("footer.reader-bottom", {}),
    el("button.focus-exit", { onclick: () => setFocus(false), "aria-label": "Exit focus mode" }, icon("focus", 18), el("span", {}, "Exit focus")),
  );
  renderActions();
  player.mount(root);
  R.auto = new AutoScroll(root);

  attachLookup($(".stage", root), (node) => {
    const pane = node.parentElement.closest(".tab-pane");
    const tab = pane && R.tabs.get(pane.dataset.doc);
    if (!tab) return null;
    let page = tab.currentPage();
    const pageDiv = node.parentElement.closest(".page, .bk-b");
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
  bus.on("tab-mode", (tab) => {
    if (tab.docId !== R.active) return;
    if (player.active) player.stop();
    if (R.auto?.on) R.auto.stop();
    if (tab.mode === "book" && R.search.query && R.search.docId === tab.docId) tab.book?.highlightQuery(R.search.query);
    if (tab.mode === "pdf") setTimeout(() => rerenderAll(tab), 60);
    renderActions(); renderBottom();
    if (R.panel) renderPanel();
  });
  bus.on("book-tap-center", (tab) => { if (tab.docId === R.active) setFocus(!R.focus, { quiet: true }); });
  bus.on("note-last", (docId) => {
    const last = annotationsFor(docId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    if (last) editAnnotation(last);
  });
  bus.on("book-unavailable", (tab) => {
    if (tab.docId !== R.active || tab.ocrJob) return;
    toast(store.settings().readScans === false
      ? "This PDF is scanned page images. Turn on Settings → Reading → “Read scanned books” to read it as text."
      : "This PDF's scanned pages couldn't be read as text. Showing the original pages.");
  });
  // scanned books: read once, then everything works
  bus.on("ocr-done", ({ docId, ok, cancelled }) => {
    const tab = R.tabs.get(docId);
    if (!tab || cancelled) return;
    if (!ok) { toast("Luma couldn't read this scanned book's pages. You can still read the original pages.", { tone: "warn" }); return; }
    if (docId === R.active && tab.mode !== "book") {
      toast("Your scanned book is ready as text — look up words, listen and search", { action: "Book view", onAction: () => tab.setMode("book"), duration: 8000 });
    }
  });
  bus.on("tab-ready", (tab) => {
    if (tab.docId === R.active) { renderActions(); if (R.panel) renderPanel(); }
    setTimeout(() => indexInBackground(tab).catch(() => {}), 2500);
    warmUp();
    pendingListen(tab);
    pendingPanel(tab);
    // on a phone, PDF pages are tiny: point to Book view once
    if (isNarrow() && tab.kind === "pdf" && !localStorage.getItem("luma.tipBook")) {
      setTimeout(() => {
        if (tab.mode !== "pdf" || tab.docId !== R.active || document.documentElement.dataset.view !== "reader") return;
        localStorage.setItem("luma.tipBook", "1");
        toast("Text small? Book view sets this PDF in your own font and size.", { action: "Try it", onAction: () => openBookView(), duration: 9000 });
      }, 1500);
    }
    if (tab.recapFrom) {
      const from = tab.recapFrom;
      tab.recapFrom = null;
      setTimeout(() => maybeRecap(tab, from, { onListen: (start) => toggleListen(start) }), 900);
    }
    pendingFind(tab);
  });
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
      else if (R.tabs.has(rec.id)) { renderTabs(); R.tabs.get(rec.id).refreshFeel(); if (rec.id === R.active) renderBottom(); }
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
  bus.on("settings", () => { for (const t of R.tabs.values()) t.refreshFeel(); });
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
  const lastOpened = doc.openedAt;
  activate(docId);
  const tab = R.tabs.get(docId);
  if (tab.state === "idle") {
    if (!page) tab.recapFrom = lastOpened;
    await tab.load(page);
  } else if (page) tab.goTo(page);
  if (tab.state === "ready") { pendingFind(tab); pendingListen(tab); pendingPanel(tab); }
  saveSession();
}

function activate(docId) {
  R.active = docId;
  for (const [id, t] of R.tabs) {
    const on = id === docId;
    if (!on && t.el.classList.contains("active")) t.hidden();
    t.el.classList.toggle("active", on);
    t.el.inert = !on;
    if (on) requestAnimationFrame(() => t.shown());
  }
  hideDefinition();
  if (player.active && player.tab?.docId !== docId) player.stop();
  if (R.auto?.on && R.auto.tab?.docId !== docId) R.auto.stop();
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
    const canDrive = drive.enabled && doc?.driveId;
    const canCloud = (sync.cloudPdfs && doc?.cloud) || canDrive;
    const pick = el("input", { type: "file", accept: ACCEPT, hidden: true, onchange: async (e) => {
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
          ? "This book was added on another device and its file hasn't been uploaded yet. Open the app on that device while signed in, or add the same file here."
          : "This book was added on another device. Add the same file here — or turn on Google Drive book sync in Settings — and your progress, notes and words connect to it automatically."),
      el("p.small.muted", {}, `Last read at page ${doc?.lastPage || 1}${doc?.pages ? ` of ${doc.pages}` : ""}`),
      el("div.row", {},
        canCloud ? el("button.btn.primary", { onclick: async (e) => {
          e.currentTarget.disabled = true;
          e.currentTarget.textContent = "Downloading…";
          try { await (canDrive ? drive.downloadBook(tab.docId) : sync.downloadPdf(tab.docId)); } catch (err) { toast(err.message || "Download failed", { tone: "warn" }); renderPaneState(tab); }
        } }, icon(canDrive ? "drive" : "cloud", 18), el("span", {}, canDrive ? "Download from Google Drive" : "Download from cloud")) : null,
        el("button.btn" + (canCloud ? "" : ".primary"), { onclick: () => pick.click() }, icon("upload", 18), el("span", {}, "Choose the file")),
        pick));
  } else if (tab.state === "error") {
    setKids(msg, el("h2", {}, "This book couldn't be opened"), el("p.muted", {}, tab.error || "The file may be damaged or password-protected."),
      el("button.btn", { onclick: () => closeTab(tab.docId) }, "Close tab"));
  }
}

// ───────────────────────── toolbar ─────────────────────────

function actionBtn(name, label, onClick, { on = false, cls = "" } = {}) {
  return el("button.icon-btn" + (on ? ".on" : "") + cls, { "aria-label": label, title: label, onclick: onClick, "aria-pressed": on ? "true" : null, dataset: { action: name } }, icon(name === "bookmark" && on ? "bookmarkOn" : name));
}

function renderModeSeg() {
  const box = $(".mode-seg", R.root);
  if (!box) return;
  const tab = activeTab();
  const ready = tab?.state === "ready";
  const mode = tab?.mode || "pdf";
  if (tab && tab.doc && tab.kind !== "pdf") {
    const label = tab.kind === "epub" ? "EPUB" : tab.doc.source ? "Article" : "Text";
    setKids(box, el("span.mode-chip", { title: "Text books always open in Book view" }, icon("openBook", 17), el("span", {}, label)));
    return;
  }
  setKids(box,
    el("button" + (mode === "pdf" ? ".on" : ""), { disabled: !ready, "aria-pressed": String(mode === "pdf"), title: "Original pages", onclick: () => tab?.setMode("pdf") },
      icon("pages", 17), el("span", {}, "Page")),
    el("button" + (mode === "book" ? ".on" : ""), { disabled: !ready, "aria-pressed": String(mode === "book"), title: "Set as a book: your font, size and page turns", onclick: () => openBookView() },
      icon("openBook", 17), el("span", {}, "Book")));
}

async function openBookView() {
  const tab = activeTab();
  if (!tab || tab.state !== "ready") return;
  await tab.setMode("book");
}

function renderActions() {
  renderModeSeg();
  const box = $(".reader-actions", R.root);
  if (!box) return;
  const tab = activeTab();
  const ready = tab?.state === "ready";
  const narrow = isNarrow();
  const page = tab?.currentPage() || 1;
  const bm = tab && isBookmarked(tab.docId, page);
  const items = [
    actionBtn("headphones", player.active ? "Stop listening (L)" : "Listen — read aloud (L)", () => toggleListen(), { on: player.active }),
    narrow ? null : actionBtn("search", "Search in book (Ctrl+F)", () => togglePanel("search"), { on: R.panel === "search" }),
    actionBtn("toc", "Contents, bookmarks & notes", () => togglePanel(R.panel && R.panel !== "search" ? R.panel : "contents"), { on: R.panel && R.panel !== "search" }),
    narrow ? null : actionBtn("bookmark", bm ? "Remove bookmark (B)" : "Bookmark this page (B)", () => bookmarkCurrent(), { on: bm }),
  ];
  const secondary = [
    actionBtn("type", "Fonts, size & theme", (e) => appearancePopover(e.currentTarget)),
    actionBtn("compare", "Compare with another PDF", () => toggleCompare(), { on: Boolean(R.compare) }),
    actionBtn("focus", "Focus mode (F)", () => setFocus(true)),
  ];
  const more = el("button.icon-btn", { "aria-label": "More", title: "More", onclick: (e) => moreMenu(e.currentTarget) }, icon("more"));
  setKids(box, ...items, ...(narrow ? [] : [el("span.divider"), ...secondary]), more);
  box.querySelectorAll("button").forEach((b) => { if (b !== more && !["compare", "type", "toc"].includes(b.dataset.action)) b.disabled = !ready; });
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
  const book = tab?.mode === "book";
  const ready = tab?.state === "ready";
  const bm = tab && isBookmarked(tab.docId, tab.currentPage());
  const s = store.settings();
  const ext = tab?.kind === "epub" ? "epub" : tab?.kind === "text" ? "json" : "pdf";
  menu(anchor, [
    narrow ? { label: "Search in book", icon: "search", onClick: () => togglePanel("search") } : null,
    narrow ? { label: bm ? "Remove bookmark" : "Bookmark this page", icon: bm ? "bookmarkOn" : "bookmark", onClick: bookmarkCurrent } : null,
    narrow ? { label: "Fonts, size & theme", icon: "type", onClick: () => appearancePopover(anchor) } : null,
    narrow && tab?.hasPages !== false ? { label: R.compare ? "Close comparison" : "Compare with another PDF", icon: "compare", onClick: toggleCompare } : null,
    narrow ? { label: "Focus mode", icon: "focus", onClick: () => setFocus(true) } : null,
    narrow ? "-" : null,
    ready ? { label: R.auto?.on ? "Stop auto-scroll (A)" : "Auto-scroll at reading speed (A)", icon: "down", checked: R.auto?.on, onClick: () => toggleAuto() } : null,
    ready && book ? { label: "Reading ruler (R)", icon: "ruler", checked: Boolean(s.ruler), onClick: () => toggleRuler() } : null,
    ready ? { label: "Words worth knowing here", icon: "words", onClick: () => { R.panel = "words"; renderPanel(); renderActions(); } } : null,
    tab ? { label: `Book feel · ${EDITIONS[feelFor(tab.doc).edition]?.name || "Modern"}…`, icon: "sparkle", onClick: () => feelPopover(anchor, tab) } : null,
    { label: `Reading light · ${MODES.find((m) => m.id === currentMode())?.name}…`, icon: "moon", onClick: () => lightPopover(anchor) },
    { label: "Look something up (K)", icon: "globe", onClick: () => lookUpSelection() },
    ready ? "-" : null,
    book || !tab ? null : { label: "Rotate pages", icon: "rotate", onClick: () => tab?.rotate() },
    book || !tab ? null : { label: "Fit page width", icon: "fit", onClick: () => tab?.setZoom("page-width") },
    book || !tab ? null : { label: "Fit whole page", icon: "focus", onClick: () => tab?.setZoom("page-fit") },
    book || !tab ? null : "-",
    ready ? { label: "Save as an audiobook…", icon: "headphones", onClick: () => audiobookDialog(tab) } : null,
    { label: "Pronunciations…", icon: "sound", onClick: () => pronunciationsDialog() },
    { label: "Export notes…", icon: "file", onClick: () => exportNotesMenu(anchor, { docIds: [tab?.docId], title: tab?.doc?.title || "Notes" }) },
    tab ? { label: `Download the ${tab.kind === "pdf" ? "PDF" : tab.kind === "epub" ? "EPUB" : "book file"}`, icon: "download", onClick: async () => {
      const b = await store.getFile(tab.docId);
      if (b) downloadBlob(b, tab.doc?.fileName || `${(tab.doc?.title || "book").replace(/[\\/:*?"<>|]+/g, "-")}.${ext}`);
    } } : null,
    tab ? { label: "Close this book", icon: "x", onClick: () => tab && closeTab(tab.docId) } : null,
  ]);
}

function toggleAuto() {
  const tab = activeTab();
  if (!tab) return;
  if (!R.auto.on && player.active) player.stop();
  R.auto.toggle(tab);
}

async function toggleRuler() {
  const on = !store.settings().ruler;
  await store.setSettings({ ruler: on });
  toast(on ? "Reading ruler on — it follows your pointer or finger" : "Reading ruler off", { duration: 2200 });
}

function renderBottom() {
  const foot = $(".reader-bottom", R.root);
  const tab = activeTab();
  if (!foot) return;
  if (!tab || tab.state !== "ready") { setKids(foot); return; }
  const page = tab.currentPage();
  const total = tab.pages;
  const book = tab.mode === "book";
  const input = el("input.page-input", {
    type: "number", inputmode: "numeric", min: 1, max: total, value: page, "aria-label": "Page number",
    onchange: (e) => tab.goTo(Number(e.target.value)),
    onkeydown: (e) => { if (e.key === "Enter") { tab.goTo(Number(e.target.value)); e.target.blur(); } },
  });
  const scale = tab.viewer?.currentScale || 1;
  setKids(foot,
    el("div.progress-line", { style: { "--p": total ? page / total : 0 } }),
    (R.timer ||= timerChip(activeTab)),
    el("div.pager", {},
      el("button.icon-btn", { "aria-label": book ? "Previous page" : "Previous page", onclick: () => tab.prev(), disabled: !book && page <= 1 }, icon("left")),
      el("label.page-box", {}, input, el("span.muted", {}, `of ${total}`)),
      el("button.icon-btn", { "aria-label": "Next page", onclick: () => tab.next(), disabled: !book && page >= total }, icon("right"))),
    el("span.spacer"),
    el("button.btn.sm.feel-btn", { title: "How this book feels: hardcover, paperback, antique… page turns, sounds, paper and light", onclick: (e) => feelPopover(e.currentTarget, tab) },
      icon("sparkle", 16), el("span", {}, EDITIONS[feelFor(tab.doc).edition]?.name || "Feel")),
    book
      ? el("div.bk-bottom-meta", {},
          el("span.muted.small.time-left", {}, tab.book?.timeLeft || ""),
          el("button.btn.sm", { onclick: (e) => appearancePopover(e.currentTarget) }, el("span.aa", {}, "Aa"), el("span", {}, "Text")))
      : el("div.zoom", {},
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
      : el("div.seg", { role: "tablist" }, [["contents", "Contents"], ["bookmarks", "Marks"], ["notes", "Notes"], ["words", "Words"]].map(([k, l]) =>
          el("button" + (R.panel === k ? ".on" : ""), { role: "tab", "aria-selected": String(R.panel === k), onclick: () => { R.panel = k; renderPanel(); } }, l))),
    el("button.icon-btn", { "aria-label": "Close panel", onclick: () => togglePanel(R.panel) }, icon("x", 18)));
  const body = el("div.panel-body");
  setKids(panel, head, body);
  ({ contents: renderContents, bookmarks: renderBookmarks, notes: renderNotes, search: renderSearch, words: (b, t) => renderWordsHere(b, t, { book: t.mode === "book" ? t.book : null }) })[R.panel](body, tab);
}

async function renderContents(body, tab) {
  if (tab.state !== "ready") { body.append(el("p.muted.pad", {}, "Open the book to see its contents.")); return; }
  const outline = await tab.outline();
  if (!outline.length) {
    body.append(el("p.muted.pad", {}, tab.kind === "pdf" ? "This PDF has no built-in table of contents. Use bookmarks to mark chapters yourself." : "No chapters were found in this book."));
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
      el("button.link.small", { onclick: (e) => exportNotesMenu(e.currentTarget, { docIds: [tab.docId], title: tab.doc?.title || "Notes" }) }, "Export…")),
    el("ul.item-list", {}, list.map((a) => el("li.item.note-item", { dataset: { color: a.color } },
      el("button.item-main", { onclick: () => { jumpToAnnotation(tab, a); if (isNarrow()) togglePanel(R.panel); } },
        el("span.item-page", {}, `p. ${a.page}`),
        el("span.item-quote", {}, a.starred ? el("span.star", { "aria-label": "Starred" }, "★ ") : null, a.text),
        a.note ? el("span.item-note", {}, a.note) : null,
        a.tags?.length ? el("span.item-tags", {}, a.tags.map((t) => el("span.tag", {}, "#" + t))) : null),
      el("button.icon-btn", { "aria-label": "Edit note", onclick: () => editAnnotation(a) }, icon("edit", 16))))));
}

function jumpToAnnotation(tab, a) {
  if (tab.mode === "book") { tab.goTo(a.page); return; }
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
        el("button.icon-btn", { type: "button", "aria-label": "Previous match", onclick: () => stepMatch(tab, -1) }, icon("left", 18)),
        el("button.icon-btn", { type: "button", "aria-label": "Next match", onclick: () => stepMatch(tab, 1) }, icon("right", 18)),
        el("span.find-count.muted.small"))),
    results);
  if (R.search.docId === tab.docId) drawResults(results, tab);
}

async function runSearch(tab, query, previous = false) {
  query = query.trim();
  if (!query || tab.state !== "ready") return;
  if (R.search.query === query && R.search.docId === tab.docId && R.search.results.length) {
    stepMatch(tab, previous ? -1 : 1);
    return;
  }
  R.search = { query, results: [], docId: tab.docId, running: (R.search.running || 0) + 1, done: false, index: -1 };
  const run = R.search.running;
  if (tab.mode === "book") tab.book?.highlightQuery(query, tab.currentPage());
  else tab.find(query);
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

/** Next/previous match: Page view uses the PDF's own finder; Book view walks the results. */
function stepMatch(tab, dir) {
  if (tab.mode !== "book") { tab.find(R.search.query, { again: true, previous: dir < 0 }); return; }
  const list = R.search.results;
  if (!list.length) return;
  const cur = tab.currentPage();
  let i = R.search.index;
  if (i < 0) i = dir > 0 ? list.findIndex((r) => r.page >= cur) : list.length - 1 - [...list].reverse().findIndex((r) => r.page <= cur);
  else i = (i + dir + list.length) % list.length;
  if (i < 0 || i >= list.length) i = 0;
  R.search.index = i;
  goToMatch(tab, list[i]);
  $(".find-count", R.root)?.replaceChildren(`${i + 1} of ${list.length}`);
}

async function goToMatch(tab, r) {
  if (tab.mode === "book") {
    await tab.book.goToPage(r.page, { animate: false });
    tab.book.highlightQuery(R.search.query, r.page);
  } else {
    tab.goTo(r.page);
    tab.find(R.search.query, { highlightAll: true });
  }
}

function drawResults(box, tab) {
  const { results, done, query } = R.search;
  setKids(box, 
    el("p.muted.small.pad-x", {}, results.length ? `${results.length}${results.length >= 400 ? "+" : ""} matches${done ? "" : " so far…"}` : done ? `No matches for “${query}”.` : "Searching…"),
    el("ul.item-list", {}, results.slice(0, 400).map((r) =>
      el("li.item", {}, el("button.item-main", { onclick: () => {
        R.search.index = results.indexOf(r);
        goToMatch(tab, r);
        if (isNarrow()) togglePanel("search");
      } }, el("span.item-page", {}, `p. ${r.page}`), el("span.item-text", {}, "…" + r.before, el("mark", {}, r.match), r.after + "…"))))));
}

/** Arriving from a library-wide search: open this book's search on the same words. */
/** Arriving from the library's "Listen" button: start reading aloud once the book is open. */
function pendingListen(tab) {
  let id = null;
  try { id = sessionStorage.getItem("luma.autolisten"); } catch {}
  if (id !== tab.docId || tab.state !== "ready") return;
  sessionStorage.removeItem("luma.autolisten");
  setTimeout(() => { if (!player.active && R.active === tab.docId) toggleListen(); }, tab.kind === "pdf" ? 900 : 500);
}

/** Arriving from Insights' "Preview the words": open the Words panel here. */
function pendingPanel(tab) {
  let p;
  try { p = JSON.parse(sessionStorage.getItem("luma.panel") || "null"); } catch {}
  if (!p || p.docId !== tab.docId || tab.state !== "ready") return;
  sessionStorage.removeItem("luma.panel");
  setTimeout(() => { if (R.active !== tab.docId) return; R.panel = p.panel; renderPanel(); renderActions(); }, 700);
}

function pendingFind(tab) {
  let p;
  try { p = JSON.parse(sessionStorage.getItem("luma.find") || "null"); } catch {}
  if (!p || p.docId !== tab.docId) return;
  sessionStorage.removeItem("luma.find");
  setTimeout(() => {
    R.panel = "search";
    R.search.query = "";
    renderPanel();
    renderActions();
    const input = $(".side-panel .search-input", R.root);
    if (input) input.value = p.q;
    runSearch(tab, p.q);
  }, 400);
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

function appearancePopover(anchor) {
  closeMenus();
  document.querySelectorAll(".popover").forEach((p) => p.remove());
  const tab = activeTab();
  const pop = el("div.menu.popover.typo-pop", { role: "dialog", "aria-label": "Fonts, size and theme" },
    el("div.pop-title", {}, el("strong", {}, "Reading appearance"),
      el("button.icon-btn.sm", { "aria-label": "Close", onclick: () => pop.remove() }, icon("x", 16))),
    tab ? el("button.feel-link", { onclick: () => { pop.remove(); feelPopover(anchor, tab); } },
      icon("sparkle", 17), el("span", {}, el("strong", {}, "Book feel"), el("span.muted.small", {}, ` · ${EDITIONS[feelFor(tab.doc).edition]?.name} — page turns, sounds, paper and light`)), icon("right", 16)) : null,
    typographyControls({
      preview: tab?.mode !== "book",
      compact: true,
      onSwitchToBook: tab?.mode === "book" || tab?.state !== "ready" ? null : () => { pop.remove(); openBookView(); },
    }));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  if (isNarrow()) pop.classList.add("sheet");
  else {
    const top = r.bottom + 6 + pop.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - pop.offsetHeight - 6) : r.bottom + 6;
    Object.assign(pop.style, { left: Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + "px", top: top + "px" });
  }
  requestAnimationFrame(() => pop.classList.add("in"));
  setTimeout(() => document.addEventListener("pointerdown", function out(e) {
    if (!pop.contains(e.target) && !e.target.closest(".menu")) { pop.remove(); document.removeEventListener("pointerdown", out, true); }
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
  requestAnimationFrame(() => { const t = activeTab(); if (t?.mode === "book") t.book?.relayout(); else t?.viewer?.update(); });
}
export function restoreCompare() {
  if (localStorage.getItem("luma.compareOpen") && !R.compare) toggleCompare();
}

async function toggleListen(from) {
  const tab = activeTab();
  if (player.active && !from) { player.stop(); renderActions(); return; }
  if (!tab || tab.state !== "ready") return;
  let start = from;
  if (!start) start = tab.mode === "book" ? tab.book.startPoint() || { page: tab.currentPage() } : { page: tab.currentPage() };
  if (R.auto?.on) R.auto.stop();
  await player.start(tab, start);
  renderActions();
}
bus.on("player-stopped", () => renderActions());

function setFocus(on, { quiet = false } = {}) {
  R.focus = on;
  document.documentElement.classList.toggle("focus-mode", on);
  if (on && !quiet) toast(isNarrow() ? "Tap the middle of the page to bring the controls back" : "Focus mode — press Esc or F to exit", { duration: 2400 });
  requestAnimationFrame(() => { const t = activeTab(); if (t?.mode === "book") t.book?.relayout(); else t?.viewer?.update(); });
}

// ───────────────────── selection & highlights ─────────────────────

let selBar = null;
function hideSelBar() { selBar?.remove(); selBar = null; }
window.addEventListener("hashchange", () => hideSelBar()); // leaving the book leaves its selection behind

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
    if (!tab) return;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    const a = tab.mode === "book" ? tab.book?.annotationAt(e.clientX, e.clientY) : highlightAt(tab, e.clientX, e.clientY);
    if (a) { e.preventDefault(); e.stopPropagation(); hideDefinition(); annotationPopover(a, e.clientX, e.clientY); }
  });
}

function showSelBar(range, text) {
  hideDefinition();
  const tab = activeTab();
  const inPdf = tab?.mode === "pdf" && range.startContainer.parentElement?.closest(".textLayer");
  const inBook = tab?.mode === "book" && range.startContainer.parentElement?.closest(".book-text");
  const make = (r, opts) => (inBook ? createTextHighlight(tab, r, opts) : createHighlight(tab, r, opts));
  const words = text.split(/\s+/).length;
  hideSelBar();
  selBar = el("div.selbar", { role: "toolbar", "aria-label": "Selection actions" });
  if (inPdf || inBook) {
    for (const [k, c] of Object.entries(COLORS)) {
      selBar.append(el("button.selbar-color", { style: { "--c": c.hex }, "aria-label": `Highlight ${c.name.toLowerCase()}`, title: `Highlight ${c.name.toLowerCase()}`,
        onmousedown: (e) => e.preventDefault(),
        onclick: async () => { const r = range.cloneRange(); hideSelBar(); document.getSelection().removeAllRanges(); await make(r, { color: k }); } }));
    }
    selBar.append(el("button.selbar-btn", {
      onmousedown: (e) => e.preventDefault(),
      onclick: async () => {
        const r = range.cloneRange();
        hideSelBar();
        const res = await noteDialog("Add a note", "", text);
        document.getSelection().removeAllRanges();
        if (res != null) {
          const rec = await make(r, { color: "sun", note: res.note.trim() });
          if (rec && res.tags.length) await store.patch("annotations", rec.id, { tags: res.tags });
          toast("Note saved");
        }
      } }, icon("note", 16), el("span", {}, "Note")));
  }
  if (words <= 8) { // one word, a phrase, a name or an abbreviation
    selBar.append(el("button.selbar-btn", {
      title: words > 1 ? "What these words mean — together and one by one" : "Meaning",
      onmousedown: (e) => e.preventDefault(),
      onclick: () => {
        const rect = range.getBoundingClientRect();
        const node = range.startContainer;
        const page = Number(node.parentElement?.closest(".page")?.dataset.pageNumber || node.parentElement?.closest(".bk-b")?.dataset.page || tab.currentPage());
        hideSelBar();
        showDefinition(text, rect, { docId: tab.docId, title: tab.doc?.title, page, context: node.nodeType === 3 ? contextAround(node, text) : "" }, { sticky: true });
      } }, icon("words", 16), el("span", {}, "Define")));
  }
  if (words <= 12) {
    selBar.append(el("button.selbar-btn", {
      title: "Wikipedia, your books and the web — without leaving Luma (K)",
      onmousedown: (e) => e.preventDefault(),
      onclick: () => {
        const node = range.startContainer;
        const page = Number(node.parentElement?.closest(".page")?.dataset.pageNumber || node.parentElement?.closest(".bk-b")?.dataset.page || tab?.currentPage() || 1);
        hideSelBar();
        document.getSelection().removeAllRanges();
        openResearch(text, { source: tab ? { docId: tab.docId, title: tab.doc?.title, page, context: node.nodeType === 3 ? contextAround(node, text) : "" } : null });
      } }, icon("globe", 16), el("span", {}, "Look up")));
  }
  selBar.append(el("button.selbar-btn", {
    onmousedown: (e) => e.preventDefault(),
    onclick: async () => { await navigator.clipboard?.writeText(text).catch(() => {}); hideSelBar(); toast("Copied"); } }, icon("copy", 16), el("span", {}, "Copy")));
  if (words >= 4) {
    selBar.append(el("button.selbar-btn", {
      onmousedown: (e) => e.preventDefault(),
      onclick: () => {
        const pg = Number(range.startContainer.parentElement?.closest(".page")?.dataset.pageNumber || range.startContainer.parentElement?.closest(".bk-b")?.dataset.page || tab.currentPage());
        hideSelBar();
        quoteCardDialog({ text, title: tab.doc?.title, author: tab.doc?.author, page: pg });
      } }, icon("image", 16), el("span", {}, "Card")));
  }
  if (inBook) {
    const blockEl = range.startContainer.parentElement?.closest(".bk-b");
    selBar.append(el("button.selbar-btn", {
      onmousedown: (e) => e.preventDefault(),
      onclick: () => {
        hideSelBar();
        const offset = blockEl ? range.startOffset : 0;
        document.getSelection().removeAllRanges();
        toggleListen(blockEl ? { bid: blockEl.dataset.bid, offset } : { page: tab.currentPage() });
      } }, icon("headphones", 16), el("span", {}, "Listen from here")));
  }
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

function allTags() {
  const count = new Map();
  for (const a of store.list("annotations")) for (const t of a.tags || []) count.set(t, (count.get(t) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

const parseTags = (s) => [...new Set(String(s || "").split(/[,#\n]/).map((t) => t.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean))].slice(0, 12);

/** Note editor: your thoughts, plus tags. Resolves { note, tags } or null. */
function noteDialog(title, value, quote, tags = []) {
  return dialog({
    title,
    body: (c, done) => {
      const ta = el("textarea.input", { rows: 5, placeholder: "Your thoughts on this passage" });
      ta.value = value || "";
      const tagInput = el("input.input.tag-input", { placeholder: "Tags, e.g. idea, quote, chapter-3", value: tags.join(", "), "aria-label": "Tags" });
      const save = () => done({ note: ta.value, tags: parseTags(tagInput.value) });
      ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); });
      const known = allTags().slice(0, 14);
      c.append(
        quote ? el("blockquote.quote", {}, quote.length > 280 ? quote.slice(0, 280) + "…" : quote) : "",
        ta,
        el("label.field.tags-field", {}, el("span", {}, "Tags"), tagInput),
        known.length ? el("div.chips.tag-suggest", {}, known.map((t) => el("button.chip.sm", { type: "button", onclick: () => {
          const cur = parseTags(tagInput.value);
          if (!cur.includes(t)) tagInput.value = [...cur, t].join(", ");
        } }, "#" + t))) : null);
    },
    actions: [{ label: "Cancel", value: null }, { label: "Save note", primary: true, value: (c) => ({ note: c.querySelector("textarea").value, tags: parseTags(c.querySelector(".tag-input").value) }) }],
  });
}

export async function editAnnotation(a) {
  const res = await noteDialog(a.note ? "Edit note" : "Add a note", a.note, a.text, a.tags || []);
  if (res != null) { await store.patch("annotations", a.id, { note: res.note.trim(), tags: res.tags }); toast("Note saved"); }
}

function annotationPopover(a, x, y) {
  closeMenus();
  const anchor = el("span", { style: { position: "fixed", left: x + "px", top: y + "px", width: "1px", height: "1px" } });
  document.body.append(anchor);
  const m = menu(anchor, [
    { label: a.note ? "Edit note" : "Add a note", icon: "note", onClick: () => editAnnotation(a) },
    ...Object.entries(COLORS).map(([k, c]) => ({ label: c.name, icon: "highlight", checked: a.color === k, onClick: () => store.patch("annotations", a.id, { color: k }) })),
    { label: "Copy text", icon: "copy", onClick: () => navigator.clipboard?.writeText(a.text).then(() => toast("Copied")) },
    { label: a.starred ? "Unstar" : "Star — add to your commonplace book", icon: "star", onClick: () => store.patch("annotations", a.id, { starred: !a.starred }).then(() => toast(a.starred ? "Unstarred" : "Starred — find it under Notes › Starred")) },
    { label: "Make a quote card", icon: "image", onClick: () => { const d = store.get("docs", a.docId); quoteCardDialog({ text: a.text, title: d?.title, author: d?.author, page: a.page }); } },
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
    const book = tab.mode === "book";
    // while listening: Space plays/pauses, Shift+arrows move by sentence
    if (player.active && k === " ") { e.preventDefault(); player.toggle(); return; }
    if (player.active && e.shiftKey && (k === "ArrowRight" || k === "ArrowLeft")) { e.preventDefault(); player.skip(k === "ArrowRight" ? 1 : -1); return; }
    const paged = book || tab.paged;
    if (k === "ArrowRight" || (paged && (k === "PageDown" || k === " " || (k === "ArrowDown" && !tab.el.classList.contains("zoomed"))))) { e.preventDefault(); tab.next(); }
    else if (k === "ArrowLeft" || (paged && (k === "PageUp" || (k === "ArrowUp" && !tab.el.classList.contains("zoomed"))))) { e.preventDefault(); tab.prev(); }
    else if (k === "l" || k === "L") toggleListen();
    else if (k === "v" || k === "V") tab.setMode(book ? "pdf" : "book");
    else if (k === "Home" && e.shiftKey) tab.goTo(1);
    else if (k === "End" && e.shiftKey) tab.goTo(tab.pages);
    else if (k === "+" || k === "=") tab.zoom(1);
    else if (k === "-") tab.zoom(-1);
    else if (k === "b" || k === "B") bookmarkCurrent();
    else if (k === "f" || k === "F") setFocus(!R.focus);
    else if (k === "R" && !book && e.shiftKey) tab.rotate();
    else if ((k === "r" || k === "R") && book && !e.shiftKey) toggleRuler();
    else if (k === "a" || k === "A") toggleAuto();
    else if (k === "k" || k === "K") { e.preventDefault(); lookUpSelection(); }
  });
}

/** K, or the menu: look up what's selected (or open an empty search). */
function lookUpSelection() {
  const tab = activeTab();
  const sel = document.getSelection();
  const text = sel && !sel.isCollapsed ? sel.toString().replace(/\s+/g, " ").trim() : "";
  hideSelBar();
  hideDefinition();
  openResearch(text.split(" ").length <= 12 ? text : "", { source: tab ? { docId: tab.docId, title: tab.doc?.title, page: tab.currentPage() } : null });
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
