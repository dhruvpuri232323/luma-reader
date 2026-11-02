// The Insights tab: how much, when, how fast and where you get stuck — plus
// your words, notes and listening — for the last week, month, year or ever.
import { el, setKids, bus, debounce } from "../core/util.js";
import { store } from "../data/store.js";
import { computeInsights, PERIODS, TYPICAL, fmtDur, hourLabel } from "../data/insights.js";
import { columns, calendar, paceScale, trend, hbars, numbers } from "./charts.js";
import { icon } from "./icons.js";
import { navigate } from "./router.js";
import { COLORS } from "../reader/annotate.js";

let root = null;
let period = (() => { try { return localStorage.getItem("luma.insightsPeriod") || "7d"; } catch { return "7d"; } })();
let seq = 0;

export function mountInsights(el0) {
  root = el0;
  const again = debounce(() => root.classList.contains("active") && render(), 1500);
  bus.on("activity-saved", again);
  bus.on("change", ({ coll }) => (coll === "words" || coll === "annotations" || coll === "docs") && again());
}

export function insightsShown(query = {}) {
  if (query.period && PERIODS[query.period]) period = query.period;
  render();
}

const mins = (ms) => Math.round(ms / 60000);
const fmtMins = (m) => (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`.replace(/ 0 min$/, ""));
const shortMins = (m) => (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`.replace(/ 0m$/, ""));
const card = (cls, title, sub, ...kids) => el(`section.ins-card.${cls}`, {}, el("header.ins-head", {}, el("h2", {}, title), sub ? el("p.muted.small", {}, sub) : null), ...kids);
const tile = (label, value, note, opts = {}) => el("div.ins-tile" + (opts.hero ? ".hero" : ""), {}, el("span.tile-label", {}, label), el("strong.tile-value", {}, value), note ? el("span.tile-note" + (opts.tone ? `.${opts.tone}` : ""), {}, note) : null);
const go = (hash, extra) => () => { if (extra) extra(); navigate(hash); };

async function render() {
  if (!root) return;
  const my = ++seq;
  const head = el("header.view-head", {},
    el("div.view-title", {}, el("h1", {}, "Insights"), el("p.muted", {}, "How you read — measured on your own devices while a book is open")),
    el("div.head-actions", {},
      el("div.seg", { role: "group", "aria-label": "Period" }, Object.entries(PERIODS).map(([k, l]) =>
        el("button" + (period === k ? ".on" : ""), { "aria-pressed": String(period === k), onclick: () => { period = k; try { localStorage.setItem("luma.insightsPeriod", k); } catch {} render(); } }, l)))));
  if (!root.firstChild) setKids(root, head, el("div.ins-loading.muted", {}, "Adding it all up…"));
  else root.querySelector(".view-head")?.replaceWith(head);
  root.querySelector(".ins-body")?.classList.add("refreshing");
  let d;
  try { d = await computeInsights(period); } catch (e) { console.error(e); setKids(root, head, el("p.muted", {}, "Couldn't add up your reading just now.")); return; }
  if (my !== seq) return;
  setKids(root, head, el("div.ins-body", {}, ...sections(d)));
}

function sections(d) {
  const t = d.totals;
  const readMs = t.ms + t.ls;
  const out = [];

  // 1 · worth knowing
  if (d.highlights.length) out.push(el("section.ins-highlights", { "aria-label": "Worth knowing" }, d.highlights.map((h) =>
    el("article.ins-note" + (h.tone ? `.${h.tone}` : ""), {}, icon(h.icon || "sparkle", 18), el("p", {}, h.text),
      h.action ? el("button.btn.sm", { onclick: go(h.action.go) }, h.action.label) : null))));

  // 2 · the totals
  const delta = d.prev.ms + d.prev.ls >= 10 * 60000 ? Math.round(((readMs - (d.prev.ms + d.prev.ls)) / (d.prev.ms + d.prev.ls)) * 100) : null;
  out.push(el("section.ins-tiles", { "aria-label": "Totals" },
    tile("Reading time", shortMins(mins(readMs)), delta != null ? `${delta >= 0 ? "+" : "−"}${Math.abs(delta)}% vs ${d.range.prevLabel}` : t.ls >= 60000 ? `incl. ${fmtMins(mins(t.ls))} listening` : `${t.sessions} ${t.sessions === 1 ? "session" : "sessions"}`, { hero: true, tone: delta == null ? "" : delta >= 0 ? "up" : "down" }),
    tile("Pages read", t.p.toLocaleString(), t.books ? `in ${t.books} ${t.books === 1 ? "book" : "books"}` : null),
    tile("Words read", t.w >= 10000 ? `${(t.w / 1000).toFixed(t.w >= 100000 ? 0 : 1)}K` : t.w.toLocaleString(), t.w >= 45000 ? `about ${(t.w / 90000).toFixed(1)} novels’ worth` : null),
    tile("Books finished", String(t.finished.length), t.finished[0] ? t.finished.map((x) => x.title).slice(0, 2).join(", ") : null),
    tile("Streak", `${d.streak.current} ${d.streak.current === 1 ? "day" : "days"}`, `best ${d.streak.best}${d.goalDays ? ` · goal met on ${d.goalDays} ${d.goalDays === 1 ? "day" : "days"}` : ""}`),
    tile("Pace", d.pace.wpm ? `${d.pace.wpm}` : "—", d.pace.wpm ? "words a minute" : "read a few pages to measure")));

  // 3 · daily reading + pace
  const dayItems = d.days.map((b) => ({ v: mins(b.ms + b.ls), label: b.label, short: b.short, strong: b.today }));
  out.push(el("div.ins-row", {},
    card("ins-daily", d.range.bucket === "day" ? "Minutes a day" : d.range.bucket === "week" ? "Minutes a week" : "Minutes a month",
      d.range.bucket === "day" ? `Your goal is ${Math.round(d.goalMs / 60000)} minutes a day` : null,
      columns(dayItems, { fmt: (v) => fmtMins(v), tick: (v) => String(Math.round(v)), goal: d.range.bucket === "day" ? d.goalMs / 60000 : null, label: "Minutes read" }),
      numbers(["", "Minutes", "Pages"], d.days.map((b) => [b.label, mins(b.ms + b.ls), b.p]))),
    card("ins-pace", "Reading pace", d.pace.wpm ? `Measured over ${fmtMins(mins(d.pace.measuredMs))} of pages you read through` : "Pages you read through — not skimmed — are timed to measure this",
      paceScale(d.pace.wpm, { typical: TYPICAL.nonfiction, low: TYPICAL.low, high: TYPICAL.high }),
      el("p.ins-explain", {}, d.pace.wpm ? paceWords(d.pace.wpm) : "Your pace appears after a few minutes of reading.",
        " Most adults read silently at about ", el("strong", {}, `${TYPICAL.nonfiction}`), " words a minute for non-fiction and ", el("strong", {}, `${TYPICAL.fiction}`), " for fiction (shaded: the usual range)."),
      d.pace.weeks.filter((w) => w.wpm).length >= 2
        ? el("div", {}, el("p.ins-mini-title", {}, "Week by week"), trend(d.pace.weeks.map((w) => ({ label: w.label, v: w.wpm })), { fmt: (v) => `${v} wpm`, label: "Pace week by week" }))
        : null)));

  // 4 · calendar + time of day
  const hours = d.hours.map((ms, h) => ({ v: mins(ms), label: `${hourLabel(h)}–${hourLabel((h + 1) % 24)}`, short: [0, 6, 12, 18].includes(h) ? hourLabel(h) : "" }));
  const peak = d.peakHour != null ? hourLabel(d.peakHour) : null;
  out.push(el("div.ins-row", {},
    card("ins-cal", "Days you read", `Last six months · ${d.streak.best > 1 ? `longest streak ${d.streak.best} days` : "a square for each day"}`,
      calendar(d.heat, { goalMs: d.goalMs, fmt: (ms) => fmtMins(mins(ms)) })),
    card("ins-hours", "When you read", peak ? `Most often around ${peak}` : null,
      columns(hours, { fmt: (v) => fmtMins(v), tick: (v) => String(Math.round(v)), height: 150, every: 1, label: "Minutes by hour of day" }),
      d.windows.some((w) => w.wpm)
        ? el("div", {}, el("p.ins-mini-title", {}, "Your pace through the day"), hbars(d.windows.filter((w) => w.ms >= 60000).map((w) => ({ label: w.name, v: w.wpm, note: "not enough reading yet" })), { fmt: (v) => `${v} wpm` }))
        : null)));

  // 5 · where you get stuck
  out.push(card("ins-stuck", "Where you get stuck", d.spots.length ? `Pages where you read much slower than your own pace in that book (${d.spotsWindow})` : null,
    d.spots.length
      ? el("ol.stuck-list", {}, d.spots.map((sp) => el("li.stuck", {},
          el("div.stuck-main", {},
            el("p.stuck-title", {}, el("strong", {}, sp.doc.title), " · ", sp.chapter ? `“${sp.chapter}”, ` : "", sp.to > sp.from ? `pages ${sp.from}–${sp.to}` : `page ${sp.from}`),
            el("p.stuck-why", {}, el("span.stuck-k", {}, `${sp.k.toFixed(1)}× slower`), " ",
              sp.reasons.length ? `— ${sp.reasons.map((r) => r.text).join("; ")}.` : "— nothing unusual in the text; perhaps a passage worth a second look."),
            el("p.muted.small", {}, `${fmtDur(sp.ms)} on ${sp.pages.length} ${sp.pages.length === 1 ? "page" : "pages"} · about ${fmtDur(sp.extra)} more than your usual pace`)),
          el("div.stuck-actions", {},
            el("button.btn.sm", { onclick: go(`#/read/${sp.docId}/${sp.from}`) }, icon("book", 15), "Open there"),
            sp.reasons.some((r) => r.kind === "words") ? el("button.btn.sm", { onclick: go(`#/read/${sp.docId}/${sp.from}`, () => { try { sessionStorage.setItem("luma.panel", JSON.stringify({ docId: sp.docId, panel: "words" })); } catch {} }) }, icon("words", 15), "Preview the words") : null,
            sp.reasons.some((r) => r.kind === "sentences" || r.kind === "reread" || r.kind === "tired" || r.kind === "late") ? el("button.btn.sm", { onclick: go(`#/read/${sp.docId}/${sp.from}`, () => { try { sessionStorage.setItem("luma.autolisten", sp.docId); } catch {} }) }, icon("headphones", 15), "Listen to it") : null))))
      : el("p.ins-empty", {}, d.empty ? "As you read, Luma notices the pages that take you much longer than usual — and tells you why: unusual words, long sentences, numbers, re-reading or tiredness." : "Nothing has slowed you down much — your pace has been steady.")));

  // 6 · books
  out.push(el("div.ins-row", {},
    card("ins-books", "Books", d.books.length ? `What you read in ${d.range.label}` : null,
      d.books.length
        ? el("ul.ins-books-list", {}, d.books.slice(0, 8).map((b) => el("li", {},
            el("button.ins-book", { onclick: go(`#/read/${b.doc.id}`) },
              el("span.ins-book-title", {}, b.doc.title),
              el("span.ins-book-bar", {}, el("span", { style: { width: `${Math.round(b.progress * 100)}%` } })),
              el("span.ins-book-meta", {}, [
                fmtDur(b.ms + b.ls), b.p ? `${b.p} pages` : null, b.wpm ? `${b.wpm} wpm` : null,
                b.doc.completedAt ? "finished" : b.leftMs ? `${fmtDur(b.leftMs)} left` : `${Math.round(b.progress * 100)}%`,
              ].filter(Boolean).join(" · "))))))
        : el("p.ins-empty", {}, "Books you read will show here, with your time, pace and how long is left.")),
    card("ins-stalled", "Waiting for you", d.stalled.length ? "Books you started and haven't opened for a while" : null,
      d.stalled.length
        ? el("ul.ins-books-list", {}, d.stalled.map((s) => el("li", {},
            el("button.ins-book", { onclick: go(`#/read/${s.doc.id}`) },
              el("span.ins-book-title", {}, s.doc.title),
              el("span.ins-book-bar", {}, el("span", { style: { width: `${Math.round(s.progress * 100)}%` } })),
              el("span.ins-book-meta", {}, `${Math.round(s.progress * 100)}% read · last opened ${s.days} days ago`)))))
        : el("p.ins-empty", {}, "No half-read books gathering dust."))));

  // 7 · stamina, words, notes, listening, library
  const fatOk = d.fat.filter((f) => f.wpm).length >= 2;
  const colorName = (k) => COLORS[k]?.name || k;
  out.push(el("div.ins-row.three", {},
    card("ins-stamina", "Stamina", "Your pace by how long you'd been reading",
      fatOk ? hbars(d.fat.map((f) => ({ label: f.label, v: f.wpm, note: "not enough reading yet" })), { fmt: (v) => `${v} wpm` }) : el("p.ins-empty", {}, "After a few longer sessions you'll see whether your pace holds up — and when a break would help.")),
    card("ins-words", "Words", null,
      el("div.ins-mini-tiles", {},
        tile("Saved", String(d.words.saved), `${d.words.total} in all`),
        tile("Mastered", String(d.words.mastered), d.words.masteredNow ? `${d.words.masteredNow} new` : null),
        tile("Reviews", String(d.words.reviews), d.words.accuracy != null ? `${Math.round(d.words.accuracy * 100)}% right` : null)),
      d.words.hardest.length ? el("div", {}, el("p.ins-mini-title", {}, "Hardest to remember"), el("div.chips", {}, d.words.hardest.map((w) => el("button.chip", { onclick: go(`#/words?w=${encodeURIComponent(w.word)}`) }, w.word)))) : null,
      d.words.due ? el("button.btn.sm", { onclick: go("#/words") }, icon("words", 15), `Review ${d.words.due} due ${d.words.due === 1 ? "word" : "words"}`) : null),
    card("ins-notes", "Notes & listening", null,
      el("div.ins-mini-tiles", {},
        tile("Highlights", String(d.notes.count), d.notes.withText ? `${d.notes.withText} with notes` : null),
        tile("Bookmarks", String(d.notes.bookmarks), null),
        tile("Listening", shortMins(mins(d.listen.ms)), d.listen.books[0] ? d.listen.books[0].doc.title : null)),
      Object.keys(d.notes.byColor).length ? el("div.ins-colors", {}, Object.entries(d.notes.byColor).map(([k, n]) => el("span.ins-color", { style: { "--c": COLORS[k]?.hex || "#ccc" }, title: colorName(k) }, `${n}`))) : null,
      d.notes.top ? el("p.muted.small", {}, `Most highlighted: ${d.notes.top.doc?.title || "a book"} (${d.notes.top.n})`) : null,
      el("p.muted.small", {}, `${d.library.added} ${d.library.added === 1 ? "book" : "books"} added · ${d.library.total} in your library`))));

  out.push(el("p.ins-privacy.muted.small", {}, icon("cloud", 14),
    " Reading time is counted only while a book is open, the window is in front and you're reading. It's kept with your account (and synced like your notes). ",
    el("button.link.small", { onclick: go("#/settings?page=reading") }, "Turn it off or change your daily goal")));
  return out;
}

function paceWords(w) {
  if (w >= 300) return `At ${w} words a minute you read faster than most adults.`;
  if (w >= 250) return `At ${w} words a minute you're a little faster than the typical adult reader.`;
  if (w >= 215) return `At ${w} words a minute you're right around the typical adult pace.`;
  if (w >= 175) return `${w} words a minute is a careful, steady pace — common for dense or technical reading.`;
  return `${w} words a minute is a slow, deliberate pace — fine for study, poetry or hard material.`;
}
