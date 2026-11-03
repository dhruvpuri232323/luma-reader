// The book's structure, and a side view to move around it.
//
// Every book gets a usable map, whatever it's made of — tried in this order:
//   1. the contents built into the book (a PDF's outline, an EPUB's table of
//      contents), checked: entries that point nowhere are dropped, a lone
//      wrapper entry is opened up, and an outline that sends everything to
//      the same page is treated as missing
//   2. chapter headings found in the text itself (big type at the top of a
//      page, "Chapter 3", …), cleaned of repeated running headers and noise
//   3. sections of pages, each named by its first words — for scanned books
//      and anything without chapters
// The result is kept with the open book, so it's worked out once.
import { el, setKids, bus, clamp } from "../core/util.js";
import { icon } from "../ui/icons.js";

const norm = (s) => String(s || "").replace(/[\u0000-\u001F­]/g, " ").replace(/\s+/g, " ").trim();
const key = (s) => norm(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * { source: "contents" | "headings" | "pages", items (a tree), flat (in reading
 * order, each with depth, parent, index) } — or null while it can't be known yet.
 * `scan` allows reading every page to find headings (the navigator asks for it;
 * the progress bar doesn't).
 */
export function bookStructure(tab, { scan = true, onProgress } = {}) {
  if (tab.structure) return tab.structure;
  if (!tab.model) return Promise.resolve(null);
  if (!scan) {
    // just the book's own contents (cheap); the full search waits for the navigator
    return builtInContents(tab).then((list) => (list && !tab.structure ? (tab.structure = Promise.resolve(finish("contents", list))) : tab.structure || null), () => null);
  }
  const p = (async () => {
    const fromBook = await builtInContents(tab).catch(() => null);
    if (fromBook) return finish("contents", fromBook);
    const found = await headingsInText(tab, onProgress).catch(() => null);
    if (found) return finish("headings", found);
    return finish("pages", await pageSections(tab).catch(() => []));
  })().then((r) => { bus.emit("structure", tab); return r; }, () => { if (tab.structure === p) tab.structure = null; return null; });
  tab.structure = p;
  return p;
}

/** Turn a flat list with depths into a tree, and number everything. */
function finish(source, list) {
  const items = [];
  const stack = [{ depth: -1, children: items }];
  const flat = [];
  for (const raw of list) {
    const depth = clamp(raw.depth | 0, 0, 5);
    const node = { title: norm(raw.title) || "Untitled section", page: raw.page, bid: raw.bid || null, dest: raw.dest ?? null, depth, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    node.depth = stack.length - 1; // never deeper than one below its parent
    node.parent = stack[stack.length - 1].node || null;
    stack[stack.length - 1].children.push(node);
    stack.push({ depth, children: node.children, node });
    node.index = flat.length;
    flat.push(node);
  }
  return { source, items, flat };
}

// ── 1. the book's own contents ──
async function builtInContents(tab) {
  const total = tab.pages || tab.model.numPages || 1;
  let list = [];
  if (!tab.pdf) {
    list = (tab.model.toc || []).map((t) => ({ title: t.title, page: clamp(Number(t.page) || 1, 1, total), depth: t.depth || 0, bid: t.bid }));
  } else {
    const outline = await tab.pdf.getOutline().catch(() => null);
    if (!outline?.length) return null;
    const pageOf = async (dest) => {
      try {
        const d = typeof dest === "string" ? await tab.pdf.getDestination(dest) : dest;
        if (!Array.isArray(d) || d[0] == null) return null;
        const ref = d[0];
        const i = typeof ref === "object" ? await tab.pdf.getPageIndex(ref) : Number(ref);
        return Number.isFinite(i) ? clamp(i + 1, 1, total) : null;
      } catch { return null; }
    };
    let n = 0;
    const walk = async (items, depth) => {
      for (const it of items) {
        if (n++ > 4000) return; // a runaway outline
        const page = it.dest != null ? await pageOf(it.dest) : null;
        const entry = { title: it.title, page, depth, dest: it.dest ?? null };
        list.push(entry);
        if (it.items?.length && depth < 6) await walk(it.items, depth + 1);
        // an entry that points nowhere starts where its first sub-entry does
        if (entry.page == null) entry.page = list.slice(list.indexOf(entry) + 1).find((e) => e.depth > depth && e.page != null)?.page ?? null;
      }
    };
    await walk(outline, 0);
    list = list.filter((e) => e.page != null);
  }
  list = list.filter((e) => norm(e.title));
  // a single wrapper entry (often the book's own title) around everything: open it up
  while (list.length > 1) {
    const top = Math.min(...list.map((x) => x.depth));
    const tops = list.filter((e) => e.depth === top);
    const first = list.find((e) => e.depth > top);
    if (tops.length !== 1 || !first || !(tops[0].page <= 1 || tops[0].page === first.page)) break;
    list = list.filter((e) => e !== tops[0]);
  }
  // useless contents: nothing, or everything pointing at one page of a long book
  const pages = new Set(list.map((e) => e.page));
  if (!list.length) return null;
  if (pages.size < 2 && total > 3 && !list.some((e) => e.bid)) return null;
  return list;
}

// ── 2. headings found in the text ──
async function headingsInText(tab, onProgress) {
  const m = tab.model;
  await m.ready?.();
  if (m.looksScanned) return null;
  const total = m.numPages;
  const found = [];
  const BATCH = 8;
  for (let p = 1; p <= total; p += BATCH) {
    const nums = Array.from({ length: Math.min(BATCH, total - p + 1) }, (_, i) => p + i);
    const pages = await Promise.all(nums.map((q) => m.page(q).catch(() => [])));
    pages.forEach((blocks, i) => {
      for (const b of blocks) if (b.type === "h" && norm(b.text)) found.push({ title: b.text, page: nums[i], level: b.level || 2, bid: b.id });
    });
    onProgress?.(Math.min(total, p + BATCH - 1), total);
    bus.emit("structure-progress", { tab, done: Math.min(total, p + BATCH - 1), total });
    await new Promise((r) => setTimeout(r, 0)); // stay responsive
  }
  // drop running headers the model missed, page numbers, captions and run-on lines
  const counts = new Map();
  for (const h of found) counts.set(key(h.title), (counts.get(key(h.title)) || 0) + 1);
  let list = found.filter((h) => {
    const t = norm(h.title), k = key(h.title);
    if (!k || t.length > 140 || /^[\divxlc.\s-]+$/i.test(t) && !/^(chapter|part)/i.test(t)) return false;
    return !(counts.get(k) > 3 && counts.get(k) > total * 0.15);
  });
  // the same heading twice in a row (split across lines or pages): keep the first
  list = list.filter((h, i) => i === 0 || key(h.title) !== key(list[i - 1].title) || h.page - list[i - 1].page > 1);
  if (!list.length) return null;
  // too many to be chapters? keep the big ones
  const big = list.filter((h) => h.level === 2);
  if (list.length > Math.max(40, total * 1.2) && big.length >= 2) list = big;
  const top = Math.min(...list.map((h) => h.level));
  const out = list.map((h) => ({ title: h.title, page: h.page, bid: h.bid, depth: h.level > top ? 1 : 0 }));
  if (out.length < 2 && total > 6) return null;
  return out;
}

// ── 3. sections of pages ──
async function pageSections(tab) {
  const total = Math.max(1, tab.pages || tab.model.numPages || 1);
  const size = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find((s) => total / s <= 30) || 1000;
  const out = [];
  const scanned = Boolean(tab.model.looksScanned);
  for (let a = 1; a <= total; a += size) {
    const b = Math.min(total, a + size - 1);
    let title = a === b ? `Page ${a}` : `Pages ${a}–${b}`;
    if (!scanned) {
      const text = await tab.model.pageText?.(a).catch(() => "");
      const first = norm(text).split(/(?<=[.!?])\s/)[0]?.split(" ").slice(0, 7).join(" ");
      if (first && first.length > 3) title += ` · “${first.replace(/[,;:]$/, "")}…”`;
    }
    out.push({ title, page: a, depth: 0 });
  }
  return out;
}

const ord = (bid) => { const [p, i] = String(bid).split(":").map(Number); return p * 100000 + (i || 0); };
/** Where you are now, as a sortable number (to the paragraph in Book view). */
function position(tab) {
  const page = tab.currentPage?.() || 1;
  if (tab.mode === "book" && tab.book) {
    const vis = tab.book.visibleBlocks();
    if (vis.length) return { here: ord(vis[vis.length - 1].dataset.bid), seen: new Set(vis.map((v) => v.dataset.bid)), page, book: true };
  }
  return { here: page * 100000 + 99999, seen: new Set(), page, book: false };
}
const startOf = (e, book) => (book && e.bid ? ord(e.bid) : e.page * 100000);

/** Where you are: the furthest entry you've reached (in Book view, to the paragraph). */
export function currentEntry(tab, s) {
  if (!s?.flat.length) return null;
  const pos = position(tab);
  let cur = null, best = -1;
  for (const e of s.flat) {
    const at = startOf(e, pos.book);
    if (at <= pos.here && at >= best) { cur = e; best = at; }
  }
  return cur || s.flat[0];
}

/** Go to an entry: the exact heading in Book view, the exact spot in Page view. */
export async function goToEntry(tab, e) {
  if (!e) return;
  if (tab.mode === "book" && tab.book) {
    let bid = e.bid;
    if (!bid && e.title) bid = await headingOnPage(tab, e).catch(() => null);
    if (bid && await tab.book.goToBlock(bid)) return;
    return tab.book.goToPage(e.page, { animate: false });
  }
  if (e.dest != null && tab.linkService) {
    try { await tab.linkService.goToDestination(e.dest); return; } catch { /* fall through */ }
  }
  tab.goTo(e.page);
}

/** A PDF's contents entry, matched to the heading Book view found on that page. */
async function headingOnPage(tab, e) {
  const want = key(e.title);
  if (!want) return null;
  for (const p of [e.page, e.page + 1]) {
    if (p > tab.model.numPages) break;
    const blocks = await tab.model.page(p);
    const h = blocks.find((b) => b.type === "h" && (key(b.text) === want || key(b.text).includes(want) || want.includes(key(b.text))));
    if (h) return h.id;
  }
  return null;
}

/** The next or previous entry from where you are (back first goes to the start of this one). */
export function neighbour(tab, s, dir) {
  const cur = currentEntry(tab, s);
  if (!cur) return null;
  const i = s.flat.indexOf(cur);
  if (dir > 0) return s.flat[i + 1] || null;
  const pos = position(tab);
  const atStart = pos.book && cur.bid ? pos.seen.has(cur.bid) : cur.page >= pos.page;
  return atStart ? s.flat[i - 1] || null : cur;
}

// ───────── the side view ─────────
const SOURCE_NOTE = {
  contents: "From the book's own contents",
  headings: "Chapters found in the text",
  pages: "This book has no chapters, so here it is in sections",
};

/** Render the navigator into a panel body. Returns a cleanup function. */
export function renderNavigator(body, tab, { onPicked } = {}) {
  const status = el("div.nav-status", { role: "status" }, el("div.rs-skel", {}, el("span"), el("span.short"), el("span")));
  const list = el("div.nav-list", { role: "tree", "aria-label": "Chapters" });
  const head = el("div.nav-head");
  setKids(body, head, status, list);
  const open = new Set(); // entries opened by hand
  const shut = new Set(); // entries closed by hand
  let s = null, filter = "", backTo = null;
  const rows = new Map();

  const jump = async (e, how = "pick") => {
    const from = tab.currentPage?.();
    await goToEntry(tab, e);
    backTo = how === "pick" && from && Math.abs((tab.currentPage?.() || from) - from) > 1 ? from : null;
    mark();
    onPicked?.(e);
  };

  const drawHead = () => {
    if (!s) { setKids(head); return; }
    const prev = neighbour(tab, s, -1), next = neighbour(tab, s, 1);
    setKids(head,
      el("div.nav-steps", {},
        el("button.btn.sm.ghost", { type: "button", disabled: !prev, title: prev?.title || "", onclick: () => prev && jump(prev, "step") }, icon("left", 15), "Previous"),
        el("span.nav-where", {}, (() => { const c = currentEntry(tab, s); return c ? `${s.flat.indexOf(c) + 1} of ${s.flat.length}` : ""; })()),
        el("button.btn.sm.ghost", { type: "button", disabled: !next, title: next?.title || "", onclick: () => next && jump(next, "step") }, "Next", icon("right", 15))),
      s.flat.length > 10 ? el("input.input.nav-filter", { type: "search", placeholder: "Find a chapter…", value: filter, "aria-label": "Find a chapter",
        oninput: (ev) => { filter = ev.target.value; draw(); } }) : null,
      backTo ? el("button.link.small.nav-back", { type: "button", onclick: () => { const p = backTo; backTo = null; tab.goTo(p); drawHead(); } }, icon("back", 14), `Back to page ${backTo}`) : null,
      el("p.nav-source.muted.small", {}, SOURCE_NOTE[s.source]));
  };

  const isOpen = (e, cur) => {
    if (shut.has(e)) return false;
    if (open.has(e)) return true;
    for (let p = cur; p; p = p.parent) if (p === e) return true; // the branch you're in
    return s.flat.length <= 40 && e.depth === 0; // short books: chapters open
  };

  const draw = () => {
    rows.clear();
    if (!s) return;
    const cur = currentEntry(tab, s);
    const q = key(filter);
    const matches = q ? new Set(s.flat.filter((e) => key(e.title).includes(q))) : null;
    if (matches) for (const e of [...matches]) for (let p = e.parent; p; p = p.parent) matches.add(p);
    const row = (e) => {
      if (matches && !matches.has(e)) return null;
      const kids = e.children.length;
      const expanded = matches ? true : isOpen(e, cur);
      const read = cur && e.index < cur.index;
      const r = el("div.nav-row" + (e === cur ? ".current" : "") + (read ? ".read" : ""), { role: "treeitem", "aria-level": e.depth + 1, "aria-expanded": kids ? String(expanded) : null, "aria-current": e === cur ? "location" : null, style: { "--d": e.depth } },
        kids ? el("button.nav-twist" + (expanded ? ".open" : ""), { type: "button", tabindex: "-1", "aria-label": expanded ? "Close" : "Open",
          onclick: () => { if (expanded) { shut.add(e); open.delete(e); } else { open.add(e); shut.delete(e); } draw(); } }, icon("right", 14)) : el("span.nav-twist.none"),
        el("button.nav-go.toc-item", { type: "button", onclick: () => jump(e) },
          el("span.nav-title", {}, e.title),
          el("span.nav-page", {}, String(e.page))));
      rows.set(e, r);
      return el("div.nav-node", {}, r, kids && expanded ? el("div.nav-kids", { role: "group" }, e.children.map(row)) : null);
    };
    setKids(list, ...s.items.map(row));
    if (matches && !matches.size) list.append(el("p.muted.small.pad", {}, "No chapter matches that."));
  };

  const mark = () => {
    if (!s) return;
    const cur = currentEntry(tab, s);
    if (!rows.has(cur) && !filter) { draw(); }
    for (const [e, r] of rows) {
      r.classList.toggle("current", e === cur);
      r.classList.toggle("read", Boolean(cur && e.index < cur.index));
      r.toggleAttribute("aria-current", e === cur);
    }
    drawHead();
    rows.get(cur)?.scrollIntoView({ block: "nearest" });
  };

  // arrow keys move through the list, → and ← open and close a part; Enter goes there
  list.addEventListener("keydown", (ev) => {
    const btns = [...list.querySelectorAll(".nav-go")];
    const i = btns.indexOf(document.activeElement);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault(); ev.stopPropagation();
      btns[clamp(i + (ev.key === "ArrowDown" ? 1 : -1), 0, btns.length - 1)]?.focus();
    } else if ((ev.key === "ArrowRight" || ev.key === "ArrowLeft") && i >= 0) {
      ev.preventDefault(); ev.stopPropagation();
      const r = btns[i].closest(".nav-row");
      const twist = r.querySelector("button.nav-twist");
      const expanded = r.getAttribute("aria-expanded") === "true";
      if (twist && expanded !== (ev.key === "ArrowRight")) {
        const e = [...rows].find(([, x]) => x === r)?.[0];
        twist.click();
        rows.get(e)?.querySelector(".nav-go")?.focus();
      }
    }
  });

  const progress = (done, total) => { if (!s) setKids(status, el("p.muted.small.pad", {}, `Finding the chapters… ${done} of ${total} pages`)); };
  Promise.resolve(bookStructure(tab, { onProgress: progress })).then((r) => {
    s = r;
    if (!s || !s.flat.length) { setKids(status, el("p.muted.pad", {}, "This book's pages couldn't be read to find its chapters. Use the page number below to move around.")); return; }
    setKids(status);
    drawHead();
    draw();
    requestAnimationFrame(() => rows.get(currentEntry(tab, s))?.scrollIntoView({ block: "center" }));
  });
  const offs = [
    bus.on("structure-progress", (e) => { if (e.tab === tab) progress(e.done, e.total); }),
    bus.on("tab-page", (t) => { if (t === tab) mark(); }),
    bus.on("tab-mode", (t) => { if (t === tab) mark(); }),
  ];
  return () => offs.forEach((f) => f());
}

