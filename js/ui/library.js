// Library: import, browse, search and manage books.
import { el, $, debounce, relTime, downloadBlob, bus, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { importFiles, progressOf, statusOf, STATUS_LABEL, resetProgress, setCompleted } from "../data/library.js";
import { sync } from "../sync/sync.js";
import { icon } from "./icons.js";
import { toast, confirmDialog, promptDialog, menu } from "./overlay.js";
import { cue } from "../core/feel.js";
import { navigate } from "./router.js";

const ui = { query: "", filter: "all", sort: "recent" };
let root;
let fileIds = new Set();
const coverCache = new Map();

export function mountLibrary(container) {
  root = container;
  render();
  const rerender = debounce(render, 120);
  bus.on("change", ({ coll }) => coll === "docs" && rerender());
  bus.on("files", async () => { fileIds = await store.fileIds(); rerender(); });
  bus.on("upload", rerender);
  bus.on("account", rerender);
  store.fileIds().then((s) => { fileIds = s; render(); });
  const input = $("#file-input");
  input.addEventListener("change", async () => {
    const files = [...input.files];
    input.value = "";
    if (files.length) await runImport(files, { openAfter: files.length === 1 && !store.list("docs").length });
  });
}

export async function pickAndImport() {
  $("#file-input").click();
}

export async function runImport(files, { openAfter = false } = {}) {
  if (!files?.length) return [];
  const pdfs = [...files].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name || ""));
  if (!pdfs.length) { toast("Only PDF files can be added."); return []; }
  const close = toast(pdfs.length > 1 ? `Adding ${pdfs.length} PDFs…` : `Adding “${pdfs[0].name}”…`, { duration: 60000 });
  const results = await importFiles(pdfs);
  close();
  const added = results.filter((r) => r.status === "added").length;
  const linked = results.filter((r) => r.status === "linked").length;
  const dupes = results.filter((r) => r.status === "duplicate");
  const errors = results.filter((r) => r.status === "error");
  const parts = [];
  if (added) parts.push(`${added} added`);
  if (linked) parts.push(`${linked} matched to synced books`);
  if (dupes.length) parts.push(`${dupes.length} already in your library`);
  if (errors.length) parts.push(`${errors.length} couldn't be opened`);
  if (parts.length) toast(parts.join(" · ").replace(/^./, (c) => c.toUpperCase()), { tone: errors.length ? "warn" : "" });
  if (added || linked) cue("save");
  fileIds = await store.fileIds();
  render();
  const firstOk = results.find((r) => r.id);
  if (openAfter && firstOk) navigate(`#/read/${firstOk.id}`);
  return results;
}

function filtered() {
  const q = ui.query.trim().toLowerCase();
  let docs = store.list("docs");
  if (q) docs = docs.filter((d) => d.title.toLowerCase().includes(q) || (d.fileName || "").toLowerCase().includes(q));
  if (ui.filter === "pinned") docs = docs.filter((d) => d.pinned);
  else if (ui.filter !== "all") docs = docs.filter((d) => statusOf(d) === ui.filter);
  const by = {
    recent: (a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt),
    title: (a, b) => a.title.localeCompare(b.title),
    progress: (a, b) => progressOf(b) - progressOf(a),
    added: (a, b) => b.addedAt - a.addedAt,
  }[ui.sort];
  return docs.sort((a, b) => (b.pinned - a.pinned) || by(a, b));
}

function render() {
  if (!root) return;
  const all = store.list("docs");
  const docs = filtered();
  const counts = { all: all.length, reading: 0, new: 0, completed: 0, pinned: all.filter((d) => d.pinned).length };
  all.forEach((d) => counts[statusOf(d)]++);
  const current = all
    .filter((d) => statusOf(d) === "reading" && d.openedAt)
    .sort((a, b) => b.openedAt - a.openedAt)[0];

  const focusSearch = document.activeElement?.id === "lib-search";
  const caret = focusSearch ? document.activeElement.selectionStart : 0;

  setKids(root, 
    el("header.view-head", {},
      el("div.view-title", {}, el("h1", {}, "Library"),
        el("p.muted", {}, all.length ? `${all.length} ${all.length === 1 ? "book" : "books"}` : "Your PDFs, ready on every device")),
      el("div.head-actions", {},
        el("button.btn.primary", { onclick: pickAndImport, id: "import-btn" }, icon("plus", 18), el("span", {}, "Add PDFs")))
    ),
    all.length ? toolbar(counts) : null,
    all.length && current && !ui.query && ui.filter === "all" ? continueCard(current) : null,
    all.length
      ? docs.length
        ? el("div.shelf", { role: "list" }, docs.map(bookCard))
        : el("p.empty-line", {}, "No books match. ", el("button.link", { onclick: () => { ui.query = ""; ui.filter = "all"; render(); } }, "Clear filters"))
      : emptyState()
  );
  if (focusSearch) {
    const s = $("#lib-search", root);
    s.focus();
    s.setSelectionRange(caret, caret);
  }
}

function toolbar(counts) {
  const chip = (key, label) =>
    el("button.chip" + (ui.filter === key ? ".on" : ""), {
      onclick: () => { ui.filter = key; render(); },
      "aria-pressed": String(ui.filter === key),
    }, label, el("span.chip-count", {}, counts[key]));
  const search = el("input.input.search", {
    id: "lib-search", type: "search", placeholder: "Search titles", value: ui.query, "aria-label": "Search library",
    oninput: debounce((e) => { ui.query = e.target.value; render(); }, 120),
  });
  const sort = el("select.select", { "aria-label": "Sort books", onchange: (e) => { ui.sort = e.target.value; render(); } },
    [["recent", "Recently read"], ["added", "Recently added"], ["title", "Title A–Z"], ["progress", "Progress"]].map(([v, l]) =>
      el("option", { value: v, selected: ui.sort === v }, l)));
  return el("div.lib-tools", {},
    el("label.search-wrap", {}, icon("search", 18), search),
    el("div.chips", {}, chip("all", "All"), chip("reading", "Reading"), chip("new", "Not started"), chip("completed", "Finished"),
      counts.pinned ? chip("pinned", "Pinned") : null),
    sort);
}

function coverEl(doc, size = "") {
  const wrap = el("div.cover" + (size ? "." + size : ""), { style: { "--hue": doc.hue ?? 210 } });
  const known = coverCache.get(doc.id);
  const fill = (src) => {
    if (src) wrap.append(el("img", { src, alt: "", loading: "lazy", decoding: "async" }));
    else wrap.append(el("div.cover-type", {}, el("span.cover-title", {}, doc.title), el("span.cover-rule")));
  };
  if (known !== undefined) fill(known);
  else store.getCover(doc.id).then((src) => { coverCache.set(doc.id, src); fill(src); });
  const p = progressOf(doc);
  wrap.append(el("div.cover-progress", { style: { "--p": p } }));
  return wrap;
}

function continueCard(doc) {
  const p = Math.round(progressOf(doc) * 100);
  return el("section.continue", { "aria-label": "Continue reading" },
    coverEl(doc, "lg"),
    el("div.continue-body", {},
      el("p.muted.small", {}, `Last read ${relTime(doc.openedAt)}`),
      el("h2.continue-title", {}, doc.title),
      el("p.muted", {}, `Page ${doc.lastPage || 1} of ${doc.pages || "?"} · ${p}% read`),
      el("div.bar", {}, el("span", { style: { width: p + "%" } })),
      el("button.btn.primary", { onclick: () => navigate(`#/read/${doc.id}`) }, icon("book", 18), el("span", {}, "Continue reading"))
    ));
}

function bookCard(doc) {
  const status = statusOf(doc);
  const local = fileIds.has(doc.id);
  const up = sync.uploadProgress(doc.id);
  const pct = Math.round(progressOf(doc) * 100);
  const open = () => navigate(`#/read/${doc.id}`);
  const more = el("button.icon-btn.card-more", {
    "aria-label": `More actions for ${doc.title}`,
    onclick: (e) => { e.stopPropagation(); docMenu(e.currentTarget, doc, local); },
  }, icon("more", 18));
  return el("article.book" + (local ? "" : ".remote"), { role: "listitem", dataset: { id: doc.id } },
    el("button.book-open", { onclick: open, "aria-label": `Open ${doc.title}` }, coverEl(doc)),
    el("div.book-meta", {},
      el("h3.book-title", { title: doc.title }, doc.pinned ? icon("pin", 14) : null, doc.title),
      el("p.book-sub", {},
        el("span.status." + status, {}, STATUS_LABEL[status]),
        status === "reading" ? el("span", {}, ` · ${pct}%`) : null,
        !local ? el("span.badge", { title: "The PDF file isn't on this device yet" }, icon("cloud", 13), "Other device") : null,
        up != null ? el("span.badge", {}, `Uploading ${Math.round(up * 100)}%`) : null),
    ),
    more);
}

function docMenu(anchor, doc, local) {
  const status = statusOf(doc);
  menu(anchor, [
    { label: "Open", icon: "book", onClick: () => navigate(`#/read/${doc.id}`) },
    { label: "Rename", icon: "edit", onClick: () => renameDoc(doc) },
    { label: doc.pinned ? "Unpin" : "Pin to top", icon: "pin", onClick: () => store.patch("docs", doc.id, { pinned: !doc.pinned }) },
    { label: status === "completed" ? "Mark as not finished" : "Mark as finished", icon: "check", onClick: async () => {
      await setCompleted(doc.id, status !== "completed");
      if (status !== "completed") cue("done");
    } },
    { label: "Reset reading progress", icon: "reset", onClick: async () => {
      if (await confirmDialog("Reset progress?", `“${doc.title}” will start again from page 1. Notes and bookmarks stay.`, { confirm: "Reset" })) {
        await resetProgress(doc.id);
        toast("Progress reset");
      }
    } },
    "-",
    local ? { label: "Download PDF", icon: "download", onClick: async () => downloadBlob(await store.getFile(doc.id), doc.fileName || doc.title + ".pdf") } : null,
    local && sync.cloudPdfs && !doc.cloud ? { label: "Upload to cloud", icon: "cloud", onClick: () => sync.uploadPdf(doc.id).then(() => toast("Uploaded")).catch((e) => toast(e.message, { tone: "warn" })) } : null,
    !local && sync.cloudPdfs && doc.cloud ? { label: "Download from cloud", icon: "cloud", onClick: () => fetchFromCloud(doc) } : null,
    !local ? { label: "Add this PDF from device…", icon: "upload", onClick: pickAndImport } : null,
    "-",
    { label: "Delete", icon: "trash", danger: true, onClick: () => deleteDoc(doc) },
  ]);
}

async function fetchFromCloud(doc) {
  const close = toast(`Downloading “${doc.title}”…`, { duration: 60000 });
  try { await sync.downloadPdf(doc.id); close(); toast("Ready on this device"); }
  catch (e) { close(); toast(e.message || "Download failed", { tone: "warn" }); }
}

export async function renameDoc(doc) {
  const title = await promptDialog("Rename book", { label: "Title", value: doc.title, confirm: "Rename" });
  if (title?.trim()) await store.patch("docs", doc.id, { title: title.trim() });
}

export async function deleteDoc(doc) {
  const ok = await confirmDialog("Delete this book?", `“${doc.title}” and its highlights, notes and bookmarks will be removed from every synced device. Saved words stay in your vocabulary.`, { confirm: "Delete", danger: true });
  if (!ok) return;
  for (const a of store.list("annotations").filter((a) => a.docId === doc.id)) await store.remove("annotations", a.id);
  for (const b of store.list("bookmarks").filter((b) => b.docId === doc.id)) await store.remove("bookmarks", b.id);
  await store.remove("docs", doc.id);
  coverCache.delete(doc.id);
  bus.emit("doc-deleted", doc.id);
  cue("remove");
  toast("Book deleted");
}

function emptyState() {
  return el("section.empty", {},
    el("div.empty-art", { "aria-hidden": "true" }, el("span"), el("span"), el("span")),
    el("h2", {}, "Add your first PDF"),
    el("p.muted", {}, "Drop files anywhere on this window, or choose them from your device. Books stay on this device; sign in under Settings to sync progress, words and notes to your other devices."),
    el("button.btn.primary.lg", { onclick: pickAndImport }, icon("upload", 18), el("span", {}, "Choose PDFs")));
}
