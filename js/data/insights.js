// Insights: turns your reading sessions, books, words and notes into totals,
// charts and a few plain-language observations — including where (and why)
// a book slows you down.
import { store } from "./store.js";
import { allSessions, reviewDays, tocOf, dayKey, usualPace } from "./activity.js";
import { bookPages } from "./fulltext.js";
import { isCommon } from "./common-words.js";
import { progressOf } from "./library.js";
import { isDue } from "./dictionary.js";

// Typical silent reading for adults, in words a minute (Brysbaert, 2019, a review of 190 studies).
export const TYPICAL = { nonfiction: 238, fiction: 260, low: 175, high: 320 };
export const PERIODS = { "7d": "7 days", "30d": "30 days", year: "This year", all: "All time" };

const DAY = 864e5;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfWeek = (t) => { const d = new Date(startOfDay(t)); return d.getTime() - ((d.getDay() + 6) % 7) * DAY; };
const pace = (w, ms) => (ms >= 180000 && w > 0 ? Math.round((w / ms) * 60000) : null);
const sum = (list) => list.reduce((a, s) => ({ ms: a.ms + s.ms, ls: a.ls + (s.ls || 0), p: a.p + (s.p || 0), w: a.w + (s.w || 0), pw: a.pw + (s.pw || 0), pm: a.pm + (s.pm || 0), n: a.n + 1 }), { ms: 0, ls: 0, p: 0, w: 0, pw: 0, pm: 0, n: 0 });
const median = (xs) => { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const WINDOWS = [["Late night", 0, 5], ["Early morning", 5, 8], ["Morning", 8, 11], ["Midday", 11, 14], ["Afternoon", 14, 17], ["Evening", 17, 21], ["Night", 21, 24]];
const hourLabel = (h) => (h === 0 ? "12 am" : h < 12 ? `${h} am` : h === 12 ? "12 pm" : `${h - 12} pm`);

export function rangeFor(period, sessions) {
  const now = Date.now();
  const t0 = startOfDay(now);
  if (period === "7d") return { period, from: t0 - 6 * DAY, to: now, prevFrom: t0 - 13 * DAY, prevTo: t0 - 6 * DAY, bucket: "day", label: "the last 7 days", prevLabel: "the 7 days before" };
  if (period === "30d") return { period, from: t0 - 29 * DAY, to: now, prevFrom: t0 - 59 * DAY, prevTo: t0 - 29 * DAY, bucket: "day", label: "the last 30 days", prevLabel: "the 30 days before" };
  if (period === "year") {
    const y0 = new Date(new Date().getFullYear(), 0, 1).getTime();
    const span = now - y0;
    return { period, from: y0, to: now, prevFrom: new Date(new Date().getFullYear() - 1, 0, 1).getTime(), prevTo: new Date(new Date().getFullYear() - 1, 0, 1).getTime() + span, bucket: "week", label: "this year", prevLabel: "the same time last year" };
  }
  const first = sessions.length ? startOfDay(sessions[0].s) : t0 - 29 * DAY;
  const from = Math.min(first, t0 - 29 * DAY);
  return { period: "all", from, to: now, prevFrom: 0, prevTo: 0, bucket: now - from > 400 * DAY ? "month" : now - from > 45 * DAY ? "week" : "day", label: "all time" };
}

function buckets(range, sessions) {
  const out = [];
  const key = range.bucket === "day" ? startOfDay : range.bucket === "week" ? startOfWeek : (t) => new Date(new Date(t).getFullYear(), new Date(t).getMonth(), 1).getTime();
  let t = key(range.from);
  while (t <= range.to) {
    const d = new Date(t);
    const next = range.bucket === "day" ? t + DAY : range.bucket === "week" ? t + 7 * DAY : new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    out.push({
      t, ms: 0, ls: 0, p: 0,
      label: range.bucket === "day" ? d.toLocaleDateString(undefined, { weekday: range.period === "7d" ? "short" : undefined, day: "numeric", month: range.period === "7d" ? undefined : "short" })
        : range.bucket === "week" ? `Week of ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : d.toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
      short: range.bucket === "day" ? (range.period === "7d" ? d.toLocaleDateString(undefined, { weekday: "short" }) : String(d.getDate())) : range.bucket === "week" ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : d.toLocaleDateString(undefined, { month: "short" }),
      today: range.bucket === "day" && t === startOfDay(Date.now()),
    });
    t = next;
  }
  const idx = new Map(out.map((b, i) => [b.t, i]));
  for (const s of sessions) {
    const i = idx.get(key(s.s));
    if (i == null) continue;
    out[i].ms += s.ms; out[i].ls += s.ls || 0; out[i].p += s.p || 0;
  }
  return out;
}

function streaks(all) {
  const days = new Map();
  for (const s of all) days.set(dayKey(s.s), (days.get(dayKey(s.s)) || 0) + s.ms + (s.ls || 0));
  const read = (k) => (days.get(k) || 0) >= 5 * 60000;
  let cur = 0;
  let t = startOfDay(Date.now());
  if (!read(dayKey(t))) t -= DAY; // today isn't over: the streak is still alive
  while (read(dayKey(t))) { cur++; t -= DAY; }
  const keys = [...days.keys()].filter(read).sort();
  let best = 0, run = 0, prev = null;
  for (const k of keys) {
    const tt = new Date(k + "T12:00:00").getTime();
    run = prev != null && Math.round((tt - prev) / DAY) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = tt;
  }
  return { current: cur, best, readToday: read(dayKey(Date.now())), days };
}

/** Pages where you read much slower than your own pace in that book. */
function slowSpots(sessions) {
  const byDoc = new Map();
  for (const s of sessions) {
    if (!s.pg) continue;
    const late = new Date(s.s).getHours() >= 23 || new Date(s.s).getHours() < 5;
    let m = byDoc.get(s.d);
    if (!m) byDoc.set(s.d, (m = new Map()));
    for (const [p, st] of Object.entries(s.pg)) {
      const cur = m.get(Number(p)) || { ms: 0, words: 0, backs: 0, looks: 0, minute: 0, late: 0 };
      cur.ms += st[0]; cur.words = Math.max(cur.words, st[1] || 0); cur.backs += st[2] || 0; cur.looks += st[3] || 0;
      cur.minute = Math.max(cur.minute, st[4] || 0);
      if (late) cur.late += st[0];
      m.set(Number(p), cur);
    }
  }
  const spots = [];
  for (const [docId, pages] of byDoc) {
    const rates = [...pages.values()].filter((x) => x.words >= 60 && x.ms >= 4000).map((x) => x.ms / x.words);
    if (rates.length < 6) continue;
    const base = median(rates);
    const slow = [...pages.entries()].filter(([, x]) => x.words >= 40 && x.ms >= 30000 && x.ms / x.words >= base * 1.7).sort((a, b) => a[0] - b[0]);
    let group = null;
    const flush = () => {
      if (!group) return;
      const k = group.ms / (group.words * base);
      if (k >= 1.6) spots.push({ docId, base, ...group, k, extra: group.ms - group.words * base });
      group = null;
    };
    for (const [p, x] of slow) {
      if (group && p - group.to > 1) flush();
      if (!group) group = { from: p, to: p, ms: 0, words: 0, backs: 0, looks: 0, minute: 0, late: 0, pages: [] };
      group.to = p; group.ms += x.ms; group.words += x.words; group.backs += x.backs; group.looks += x.looks;
      group.minute = Math.max(group.minute, x.minute); group.late += x.late; group.pages.push(p);
    }
    flush();
  }
  return spots.sort((a, b) => b.extra - a.extra).slice(0, 6);
}

const WORD = /[\p{L}][\p{L}'’-]*/gu;
function textStats(texts) {
  let words = 0, rare = 0, letters = 0, digits = 0, sentences = 0;
  const rareWords = new Map();
  for (const t of texts) {
    if (!t) continue;
    const ws = t.match(WORD) || [];
    words += ws.length;
    sentences += Math.max(1, (t.match(/[.!?…]+(\s|$)/g) || []).length);
    letters += (t.match(/\p{L}/gu) || []).length;
    digits += (t.match(/\d/g) || []).length;
    for (const w of ws) {
      if (w.length < 7 || /^\p{Lu}/u.test(w)) continue; // short words and names don't count
      const lw = w.toLowerCase().replace(/[’']s$/, "");
      if (!isCommon(lw)) { rare++; rareWords.set(lw, (rareWords.get(lw) || 0) + 1); }
    }
  }
  return { words, rarePer1k: words ? (rare / words) * 1000 : 0, sentenceLen: sentences ? words / sentences : 0, digitShare: letters ? digits / (letters + digits) : 0, rareWords };
}

async function explain(spot) {
  const reasons = [];
  const pages = await bookPages(spot.docId).catch(() => null);
  if (pages?.length) {
    const here = textStats(spot.pages.map((p) => pages[p - 1]));
    const step = Math.max(1, Math.floor(pages.length / 60));
    const book = textStats(pages.filter((_, i) => i % step === 0));
    if (here.rarePer1k >= 8 && here.rarePer1k >= book.rarePer1k * 1.5) {
      const ex = [...here.rareWords.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 3).map(([w]) => `“${w}”`);
      reasons.push({ kind: "words", text: `unusual words${ex.length ? ` like ${ex.join(", ")}` : ""}` });
    }
    if (here.sentenceLen >= 22 && here.sentenceLen >= book.sentenceLen * 1.3) reasons.push({ kind: "sentences", text: `long sentences (about ${Math.round(here.sentenceLen)} words each)` });
    if (here.digitShare >= 0.02 && here.digitShare >= book.digitShare * 2) reasons.push({ kind: "numbers", text: "numbers and tables" });
  }
  if (spot.backs >= 2) reasons.push({ kind: "reread", text: `you went back to re-read it ${spot.backs} times` });
  if (spot.looks >= 2) reasons.push({ kind: "lookups", text: `you looked up ${spot.looks} words` });
  if (spot.late >= spot.ms * 0.5) reasons.push({ kind: "late", text: "you read it late at night" });
  if (spot.minute >= 45) reasons.push({ kind: "tired", text: `you were ${spot.minute}+ minutes into a session` });
  return reasons;
}

function chapterAt(docId, page) {
  const toc = tocOf(docId);
  if (!toc?.length) return null;
  let hit = null;
  for (const [p, t] of toc) if (p <= page) hit = t;
  return hit;
}

/** Everything the Insights tab shows, for a period. */
export async function computeInsights(period = "7d") {
  const all = allSessions();
  const range = rangeFor(period, all);
  const inRange = all.filter((s) => s.s >= range.from && s.s <= range.to);
  const prevRange = range.prevTo ? all.filter((s) => s.s >= range.prevFrom && s.s < range.prevTo) : [];
  const tot = sum(inRange);
  const prev = sum(prevRange);
  const settings = store.settings();
  const goalMs = (Number(settings.readGoal) || 20) * 60000;
  const docs = store.list("docs");
  const docOf = (id) => store.get("docs", id);

  // pace
  const paceAll = pace(tot.pw, tot.pm);
  const usual = usualPace();
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const w0 = startOfWeek(Date.now()) - i * 7 * DAY;
    const ws = sum(all.filter((s) => s.s >= w0 && s.s < w0 + 7 * DAY));
    weeks.push({ t: w0, label: new Date(w0).toLocaleDateString(undefined, { day: "numeric", month: "short" }), wpm: pace(ws.pw, ws.pm) });
  }

  // when you read
  const hours = Array(24).fill(0);
  for (const s of inRange) for (const [h, ms] of Object.entries(s.h || {})) hours[h] += ms;
  const win = WINDOWS.map(([name, a, b]) => {
    const ss = inRange.filter((s) => { const h = new Date(s.s).getHours(); return h >= a && h < b; });
    const x = sum(ss);
    return { name, from: a, to: b, ms: x.ms, wpm: x.pm >= 15 * 60000 ? pace(x.pw, x.pm) : null };
  });
  const paced = win.filter((w) => w.wpm);
  const fastest = paced.length >= 2 ? [...paced].sort((a, b) => b.wpm - a.wpm)[0] : null;
  const slowest = paced.length >= 2 ? [...paced].sort((a, b) => a.wpm - b.wpm)[0] : null;
  const peakHour = hours.some((x) => x) ? hours.indexOf(Math.max(...hours)) : null;

  // stamina: pace by how long you'd been reading
  const FAT = [[0, 15], [15, 30], [30, 45], [45, 60], [60, 999]];
  const fat = FAT.map(([a, b]) => {
    let w = 0, ms = 0;
    for (const s of all) for (const st of Object.values(s.pg || {})) {
      if ((st[4] || 0) < a || (st[4] || 0) >= b || st[1] < 40 || st[0] < 4000) continue;
      const r = (st[1] / st[0]) * 60000;
      if (r < 70 || r > 1000) continue;
      w += st[1]; ms += st[0];
    }
    return { label: b > 100 ? `${a}+ min` : `${a}–${b} min`, wpm: ms >= 8 * 60000 ? Math.round((w / ms) * 60000) : null, ms };
  });

  const st = streaks(all);
  const days = buckets(range, inRange);
  const goalDays = range.bucket === "day" ? days.filter((d) => d.ms + d.ls >= goalMs).length : null;

  // calendar: the last 26 weeks
  const heat = [];
  const hs = startOfWeek(Date.now()) - 25 * 7 * DAY;
  for (let t = hs; t <= Date.now(); t += DAY) heat.push({ t, key: dayKey(t), ms: st.days.get(dayKey(t)) || 0 });

  // books
  const byDoc = new Map();
  for (const s of inRange) { const a = byDoc.get(s.d) || []; a.push(s); byDoc.set(s.d, a); }
  const recentDaily = sum(all.filter((s) => s.s >= startOfDay(Date.now()) - 13 * DAY)).ms / 14;
  const books = [...byDoc.entries()].map(([id, ss]) => {
    const doc = docOf(id);
    if (!doc || doc.deleted) return null;
    const x = sum(ss);
    const allFor = sum(all.filter((s) => s.d === id));
    const bookPace = pace(allFor.pw, allFor.pm) || usual;
    const perPage = allFor.p ? allFor.w / allFor.p : 280;
    const left = doc.completedAt ? 0 : Math.max(0, (doc.pages || 0) - (doc.lastPage || 1));
    const leftMs = left && perPage ? ((left * perPage) / bookPace) * 60000 : 0;
    const daily = Math.max(recentDaily, 10 * 60000);
    return { doc, ms: x.ms, ls: x.ls, p: x.p, w: x.w, wpm: pace(x.pw, x.pm), progress: progressOf(doc), leftMs, finishDays: leftMs ? Math.ceil(leftMs / daily) : 0, last: Math.max(...ss.map((s) => s.e)) };
  }).filter(Boolean).sort((a, b) => b.ms + b.ls - (a.ms + a.ls));
  const lastRead = new Map();
  for (const s of all) lastRead.set(s.d, Math.max(lastRead.get(s.d) || 0, s.e));
  const stalled = docs.filter((d) => !d.completedAt && progressOf(d) > 0.03 && progressOf(d) < 0.97)
    .map((d) => ({ doc: d, progress: progressOf(d), last: Math.max(lastRead.get(d.id) || 0, d.openedAt || 0) }))
    .filter((x) => x.last && Date.now() - x.last >= 7 * DAY && Date.now() - x.last <= 120 * DAY)
    .sort((a, b) => b.progress - a.progress).slice(0, 4)
    .map((x) => ({ ...x, days: Math.floor((Date.now() - x.last) / DAY) }));

  // where you get stuck (a longer window if this one is too short to tell)
  let spots = slowSpots(inRange);
  let spotsWindow = range.label;
  if (!spots.length && range.period !== "all") { spots = slowSpots(all.filter((s) => s.s >= Date.now() - 90 * DAY)); spotsWindow = "the last 90 days"; }
  for (const sp of spots) {
    sp.doc = docOf(sp.docId);
    sp.chapter = chapterAt(sp.docId, sp.from);
    sp.reasons = await explain(sp);
  }
  spots = spots.filter((sp) => sp.doc && !sp.doc.deleted);

  // words, notes, listening, library
  const words = store.list("words");
  const rev = reviewDays();
  let reviews = 0, right = 0;
  for (const [d, [n, ok]] of Object.entries(rev)) { const t = new Date(d + "T12:00:00").getTime(); if (t >= range.from && t <= range.to) { reviews += n; right += ok; } }
  const inR = (t) => t >= range.from && t <= range.to;
  const anns = store.list("annotations").filter((a) => inR(a.createdAt || 0));
  const byColor = {};
  for (const a of anns) byColor[a.color || "sun"] = (byColor[a.color || "sun"] || 0) + 1;
  const annBook = new Map();
  for (const a of anns) annBook.set(a.docId, (annBook.get(a.docId) || 0) + 1);
  const topAnn = [...annBook.entries()].sort((a, b) => b[1] - a[1])[0];
  const listenBooks = [...byDoc.entries()].map(([id, ss]) => ({ doc: docOf(id), ls: sum(ss).ls })).filter((x) => x.doc && x.ls >= 60000).sort((a, b) => b.ls - a.ls);

  const data = {
    range, settings, goalMs,
    totals: { ...tot, books: byDoc.size, finished: docs.filter((d) => d.completedAt && inR(d.completedAt)), days: days.filter((d) => d.ms + d.ls >= 60000).length, sessions: inRange.length, timed: inRange.filter((s) => s.m).length },
    prev,
    pace: { wpm: paceAll, usual: Math.round(usual), weeks, measuredMs: tot.pm },
    days, heat, hours, windows: win, fastest, slowest, peakHour, fat, streak: st, goalDays,
    books, stalled, spots, spotsWindow,
    words: {
      saved: words.filter((w) => inR(w.createdAt || 0)).length, total: words.length,
      mastered: words.filter((w) => w.status === "mastered").length,
      masteredNow: words.filter((w) => w.status === "mastered" && inR(w.updatedAt || 0)).length,
      reviews, right, accuracy: reviews ? right / reviews : null, due: words.filter((w) => w.status !== "mastered" && isDue(w)).length,
      hardest: words.filter((w) => (w.srs?.reps || 0) >= 2 && (w.srs?.ease || 2.5) < 2.3).sort((a, b) => (a.srs.ease || 2.5) - (b.srs.ease || 2.5)).slice(0, 8),
    },
    notes: { count: anns.length, withText: anns.filter((a) => a.note).length, byColor, top: topAnn ? { doc: docOf(topAnn[0]), n: topAnn[1] } : null, bookmarks: store.list("bookmarks").filter((b) => inR(b.createdAt || 0)).length },
    listen: { ms: tot.ls, books: listenBooks },
    library: { added: docs.filter((d) => inR(d.addedAt || 0)).length, total: docs.length, byKind: docs.reduce((m, d) => ({ ...m, [d.kind || "pdf"]: (m[d.kind || "pdf"] || 0) + 1 }), {}) },
    empty: !all.length,
  };
  data.highlights = highlights(data);
  return data;
}

const pct = (a, b) => Math.round(((a - b) / b) * 100);
export const fmtDur = (ms) => { const m = Math.round(ms / 60000); if (m < 60) return `${m} min`; const h = Math.floor(m / 60), r = m % 60; return r ? `${h} h ${r} min` : `${h} h`; };

/** A few observations worth knowing, most useful first. */
function highlights(d) {
  const out = [];
  const t = d.totals;
  if (d.empty) {
    out.push({ icon: "book", text: "Open a book and read — Luma measures your reading time, pages and pace on its own, and this page fills in as you go.", action: { label: "Go to the library", go: "#/library" } });
    return out;
  }
  if (d.prev.ms >= 10 * 60000 && t.ms + t.ls > 0) {
    const p = pct(t.ms + t.ls, d.prev.ms + d.prev.ls);
    if (Math.abs(p) >= 10) out.push({ icon: "trend", tone: p > 0 ? "up" : "down", text: p > 0 ? `You read ${p}% more than in ${d.range.prevLabel}.` : `You read ${-p}% less than in ${d.range.prevLabel} — ${fmtDur(t.ms + t.ls)} so far.` });
  }
  if (d.streak.current >= 2) out.push({ icon: "flame", text: d.streak.readToday ? `${d.streak.current}-day reading streak. Keep it going tomorrow.` : `${d.streak.current}-day streak — read today to make it ${d.streak.current + 1}.`, action: d.streak.readToday ? null : { label: "Read now", go: "#/read" } });
  const sp = d.spots[0];
  if (sp) out.push({ icon: "flame", text: `${sp.chapter ? `“${sp.chapter}”` : (sp.to > sp.from ? `Pages ${sp.from}–${sp.to}` : `Page ${sp.from}`)} of ${sp.doc.title} slowed you to ${sp.k >= 1.9 ? "about half" : `${Math.round(100 / sp.k)}%`} of your pace${sp.reasons[0] ? ` — ${sp.reasons[0].text}` : ""}.`, action: { label: "Open there", go: `#/read/${sp.docId}/${sp.from}` } });
  if (d.fastest && d.slowest && d.fastest.wpm - d.slowest.wpm >= 20) out.push({ icon: "timer", text: `You read fastest in the ${d.fastest.name.toLowerCase()} (${d.fastest.wpm} words a minute) and slowest in the ${d.slowest.name.toLowerCase()} (${d.slowest.wpm}).` });
  const f0 = d.fat[0].wpm, late = d.fat.slice(3).find((x) => x.wpm);
  if (f0 && late && late.wpm < f0 * 0.87) out.push({ icon: "timer", text: `Your pace drops by ${Math.round((1 - late.wpm / f0) * 100)}% after about ${parseInt(late.label, 10)} minutes. A short break around then could help.` });
  if (d.pace.wpm && d.pace.measuredMs >= 10 * 60000) { // too early to say until there's ten minutes of it
    const w = d.pace.wpm;
    const rel = w >= 300 ? "faster than most adult readers" : w >= 250 ? "a little faster than the typical adult reader" : w >= 215 ? "right around the typical adult pace" : w >= 175 ? "a careful, steady pace" : "a slow, deliberate pace";
    out.push({ icon: "chart", text: `Your reading pace is ${w} words a minute — ${rel} (about ${TYPICAL.nonfiction} for non-fiction, ${TYPICAL.fiction} for fiction).` });
  }
  const b = d.books.find((x) => x.leftMs > 0);
  if (b) {
    const when = new Date(Date.now() + b.finishDays * DAY).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
    out.push({ icon: "book", text: `At your pace, ${b.doc.title} has about ${fmtDur(b.leftMs)} left — around ${b.finishDays <= 1 ? "a day" : `${b.finishDays} days`} at your usual daily reading (${when}).`, action: { label: "Continue", go: `#/read/${b.doc.id}` } });
  }
  const s = d.stalled[0];
  if (s) out.push({ icon: "book", text: `You haven't opened ${s.doc.title} for ${s.days} days — you were ${Math.round(s.progress * 100)}% through.`, action: { label: "Pick it up", go: `#/read/${s.doc.id}` } });
  if (d.words.reviews >= 5) out.push({ icon: "words", text: `You reviewed ${d.words.reviews} words with ${Math.round(d.words.accuracy * 100)}% right.${d.words.due ? ` ${d.words.due} are due now.` : ""}`, action: d.words.due ? { label: "Review", go: "#/words" } : null });
  else if (d.words.due >= 5) out.push({ icon: "words", text: `${d.words.due} words are waiting for a review.`, action: { label: "Review", go: "#/words" } });
  return out.slice(0, 6);
}
export { hourLabel };
