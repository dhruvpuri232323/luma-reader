// Notes: every highlight, note and bookmark across the library, searchable and exportable.
import { el, $, bus, debounce, relTime, downloadBlob, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { COLORS } from "../reader/annotate.js";
import { editAnnotation } from "../reader/reader.js";
import { icon } from "./icons.js";
import { toast, menu } from "./overlay.js";
import { cue } from "../core/feel.js";
import { navigate } from "./router.js";
import { exportNotesMenu } from "./export.js";
import { quoteCardDialog } from "./quotecard.js";

const ui = { tab: "highlights", query: "", doc: "all", color: "all", tag: "" };
let root;

export function mountNotes(container) {
  root = container;
  const rerender = debounce(render, 120);
  bus.on("change", ({ coll }) => (coll === "annotations" || coll === "bookmarks" || coll === "docs") && root.closest(".view")?.classList.contains("active") && rerender());
}

export function notesShown() { render(); }

function render() {
  if (!root) return;
  const docs = new Map(store.list("docs").map((d) => [d.id, d]));
  const anns = store.list("annotations").filter((a) => docs.has(a.docId));
  const bms = store.list("bookmarks").filter((b) => docs.has(b.docId));
  const q = ui.query.trim().toLowerCase();
  const focused = document.activeElement?.id === "notes-search";

  let items = ui.tab === "bookmarks" ? bms : ui.tab === "starred" ? anns.filter((a) => a.starred) : anns;
  if (ui.doc !== "all") items = items.filter((a) => a.docId === ui.doc);
  if (ui.tab !== "bookmarks" && ui.color !== "all") items = items.filter((a) => a.color === ui.color);
  if (ui.tab !== "bookmarks" && ui.tag) items = items.filter((a) => (a.tags || []).includes(ui.tag));
  if (q) items = items.filter((a) => [a.text, a.note, a.label, docs.get(a.docId)?.title, ...(a.tags || [])].some((s) => (s || "").toLowerCase().includes(q)));
  const tagCounts = new Map();
  for (const a of anns) for (const t of a.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const starred = anns.filter((a) => a.starred).length;

  const groups = new Map();
  for (const a of items) {
    if (!groups.has(a.docId)) groups.set(a.docId, []);
    groups.get(a.docId).push(a);
  }
  const ordered = [...groups.entries()].sort((a, b) => (docs.get(b[0]).openedAt || 0) - (docs.get(a[0]).openedAt || 0));

  setKids(root, 
    el("header.view-head", {},
      el("div.view-title", {}, el("h1", {}, "Notes"),
        el("p.muted", {}, `${anns.length} ${anns.length === 1 ? "highlight" : "highlights"} · ${bms.length} ${bms.length === 1 ? "bookmark" : "bookmarks"}`)),
      el("div.head-actions", {}, anns.length || bms.length
        ? el("button.btn", { onclick: (e) => exportNotesMenu(e.currentTarget, ui.tab === "starred" ? { annotations: items, title: "Commonplace book" } : { docIds: ui.doc === "all" ? null : [ui.doc], title: ui.doc === "all" ? "Luma Reader notes" : docs.get(ui.doc)?.title }) }, icon("download", 18), el("span", {}, "Export…")) : null)),
    el("div.lib-tools", {},
      el("div.seg", { role: "tablist" }, [["highlights", "Highlights & notes"], ["starred", `Starred${starred ? ` · ${starred}` : ""}`], ["bookmarks", "Bookmarks"]].map(([k, l]) =>
        el("button" + (ui.tab === k ? ".on" : ""), { role: "tab", "aria-selected": String(ui.tab === k), onclick: () => { ui.tab = k; render(); } }, l))),
      el("label.search-wrap", {}, icon("search", 18), el("input.input.search", {
        id: "notes-search", type: "search", placeholder: "Search highlights and notes", value: ui.query, "aria-label": "Search notes",
        oninput: debounce((e) => { ui.query = e.target.value; render(); }, 120) })),
      el("select.select", { "aria-label": "Filter by book", onchange: (e) => { ui.doc = e.target.value; render(); } },
        el("option", { value: "all" }, "All books"),
        [...docs.values()].sort((a, b) => a.title.localeCompare(b.title)).map((d) => el("option", { value: d.id, selected: ui.doc === d.id }, d.title))),
      ui.tab !== "bookmarks" && tagCounts.size ? el("select.select", { "aria-label": "Filter by tag", onchange: (e) => { ui.tag = e.target.value; render(); } },
        el("option", { value: "" }, "All tags"),
        [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => el("option", { value: t, selected: ui.tag === t }, `#${t} (${n})`))) : null,
      ui.tab !== "bookmarks" ? el("div.swatches", { role: "group", "aria-label": "Filter by colour" },
        el("button.chip" + (ui.color === "all" ? ".on" : ""), { onclick: () => { ui.color = "all"; render(); } }, "Any colour"),
        Object.entries(COLORS).map(([k, c]) => el("button.swatch" + (ui.color === k ? ".on" : ""), {
          style: { "--c": c.hex }, "aria-label": c.name, title: c.name, onclick: () => { ui.color = ui.color === k ? "all" : k; render(); } }))) : null),
    ordered.length
      ? el("div.note-groups", {}, ordered.map(([docId, list]) => group(docs.get(docId), list)))
      : el("section.empty.small", {},
          el("h2", {}, ui.tab === "starred" ? (starred ? "Nothing matches" : "Your commonplace book is empty") : ui.tab === "highlights" ? (anns.length ? "Nothing matches" : "No highlights yet") : (bms.length ? "Nothing matches" : "No bookmarks yet")),
          el("p.muted", {}, ui.tab === "starred"
            ? "Star the passages you want to keep forever — tap a highlight and choose Star. They gather here, from every book, like a commonplace book."
            : ui.tab === "highlights"
            ? "Select a passage while reading, then pick a colour or add a note."
            : "Press B while reading, or use the bookmark button, to keep a page.")));
  if (focused) { const s = $("#notes-search", root); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

function group(doc, list) {
  list.sort((a, b) => a.page - b.page || (a.rects?.[0]?.y || 0) - (b.rects?.[0]?.y || 0));
  return el("section.note-group", {},
    el("h2.note-book", {}, el("button.link", { onclick: () => navigate(`#/read/${doc.id}`) }, doc.title), el("span.muted.small", {}, ` ${list.length}`)),
    el("ul.item-list.wide", {}, list.map((a) => ui.tab !== "bookmarks"
      ? el("li.item.note-item", { dataset: { color: a.color } },
          el("button.item-main", { onclick: () => navigate(`#/read/${doc.id}/${a.page}`) },
            el("span.item-page", {}, `p. ${a.page}`),
            el("span.item-quote", {}, a.text),
            a.note ? el("span.item-note", {}, a.note) : null,
            a.tags?.length ? el("span.item-tags", {}, a.tags.map((t) => el("span.tag", {}, "#" + t))) : null,
            el("span.item-meta", {}, relTime(a.updatedAt))),
          el("button.icon-btn.star-btn" + (a.starred ? ".on" : ""), { "aria-label": a.starred ? "Unstar" : "Star", title: a.starred ? "Starred" : "Star — keep in your commonplace book", onclick: () => store.patch("annotations", a.id, { starred: !a.starred }) }, icon(a.starred ? "starOn" : "star", 18)),
          el("button.icon-btn", { "aria-label": "Actions", onclick: (e) => menu(e.currentTarget, [
            { label: a.note ? "Edit note & tags" : "Add a note or tags", icon: "note", onClick: () => editAnnotation(a) },
            { label: "Make a quote card", icon: "image", onClick: () => quoteCardDialog({ text: a.text, title: doc.title, author: doc.author, page: a.page }) },
            { label: "Copy text", icon: "copy", onClick: () => navigator.clipboard?.writeText(a.text).then(() => toast("Copied")) },
            "-",
            { label: "Delete highlight", icon: "trash", danger: true, onClick: async () => { await store.remove("annotations", a.id); cue("remove"); } },
          ]) }, icon("more", 18)))
      : el("li.item", {},
          el("button.item-main", { onclick: () => navigate(`#/read/${doc.id}/${a.page}`) },
            el("span.item-page", {}, `p. ${a.page}`), el("span.item-text", {}, a.label || "Bookmarked page"), el("span.item-meta", {}, relTime(a.createdAt))),
          el("button.icon-btn", { "aria-label": `Remove bookmark on page ${a.page}`, onclick: async () => { await store.remove("bookmarks", a.id); cue("remove"); } }, icon("x", 16))))));
}
