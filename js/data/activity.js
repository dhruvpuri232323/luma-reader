// Reading activity: how long you read, how far and how fast — measured quietly
// while a book is open, the window is in front and you're reading (turning,
// scrolling, or the voice is reading to you). Time away doesn't count: the
// wait before a pause is counted adapts to how long a page usually takes you.
//
// Each finished session is kept in a record per device and month, stored with
// your settings (so it syncs with no extra setup, and two devices never
// overwrite each other). Insights reads them all back.
import { store } from "./store.js";
import { bus } from "../core/util.js";

const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

export const deviceId = (() => {
  let id = null;
  try { id = localStorage.getItem("luma.deviceId"); } catch {}
  if (!id) { id = Math.random().toString(36).slice(2, 10); try { localStorage.setItem("luma.deviceId", id); } catch {} }
  return id;
})();
const recId = (m) => `activity:${deviceId}:${m}`;
const CHECKPOINT = "luma.session";

/** Every activity record (all devices, all months). */
export function activityRecords() {
  return store.list("settings").filter((r) => r.kind === "activity" && Array.isArray(r.sessions));
}
/** Every finished session, oldest first, plus the one in progress. */
export function allSessions({ live = true } = {}) {
  const list = activityRecords().flatMap((r) => r.sessions);
  if (live && S.session && S.session.ms + S.session.listen >= 5000) list.push(compact(S.session, true));
  return list.sort((a, b) => a.s - b.s);
}
export function reviewDays() {
  const out = {};
  for (const r of activityRecords()) for (const [d, [n, ok]] of Object.entries(r.rev || {})) { out[d] ||= [0, 0]; out[d][0] += n; out[d][1] += ok; }
  return out;
}
export function tocOf(docId) {
  for (const r of activityRecords()) if (r.toc?.[docId]) return r.toc[docId];
  return null;
}

// ───────── the live session ─────────
const S = {
  getTab: () => null,
  isListening: () => false,
  session: null,
  lastInput: 0,
  lastTick: 0,
  sinceInput: 0, // reading time counted since the last sign of you
  page: 0,
  pageSince: 0,
  words: new Map(), // `${docId}:${page}` → words on that page
  hiddenAt: 0,
  timer: null,
  saveTimer: null,
  paused: false,
};
export const activity = {
  get session() { return S.session; },
  get paused() { return S.paused; },
};

const tracking = () => store.settings().trackReading !== false;

/** How fast you usually read, in words a minute (for the pause detector and forecasts). */
export function usualPace() {
  let w = 0, ms = 0;
  for (const s of allSessions({ live: false }).slice(-40)) { w += s.pw || 0; ms += s.pm || 0; }
  const p = ms > 120000 ? (w / ms) * 60000 : 0;
  return p >= 60 && p <= 1200 ? p : 230;
}

function wordsOn(tab, page) {
  const key = `${tab.docId}:${page}`;
  if (S.words.has(key)) return S.words.get(key);
  S.words.set(key, null);
  tab.text(page).then((t) => S.words.set(key, (String(t || "").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length)).catch(() => S.words.set(key, 0));
  return null;
}

/** The longest stretch with no sign of you that still counts as reading this page. */
function idleLimit(tab) {
  const w = wordsOn(tab, S.page) ?? 300;
  const expected = (w / usualPace()) * 60000;
  return Math.min(300000, Math.max(60000, expected * 2.5));
}

function newSession(tab, { manual = false, goal = null } = {}) {
  const t = Date.now();
  S.session = {
    id: `${deviceId}-${t.toString(36)}`, docId: tab.docId, start: t, end: t, ms: 0, listen: 0,
    pg: {}, hours: {}, pw: 0, pm: 0, manual, goal, goalHit: false, startPage: tab.currentPage(),
  };
  S.page = tab.currentPage();
  S.pageSince = 0;
  S.sinceInput = 0;
  rememberToc(tab);
  bus.emit("session", S.session);
}

function pageStat(p) {
  const s = S.session;
  s.pg[p] ||= [0, 0, 0, 0, Math.round(s.ms / 60000)]; // ms, words, times you came back to it, words looked up, minutes into the session
  return s.pg[p];
}

/** Moving on from a page: score it if you read it through. */
function leavePage(tab, to) {
  const s = S.session;
  if (!s || !S.page) return;
  const st = pageStat(S.page);
  const w = wordsOn(tab, S.page);
  if (w != null) st[1] = w;
  if (to > S.page && to - S.page <= 3 && w >= 40 && S.pageSince >= 4000) {
    const wpm = (w / S.pageSince) * 60000;
    if (wpm >= 70 && wpm <= 1000) { s.pw += w; s.pm += S.pageSince; } // a page read through, at a believable pace
  }
  if (to > 0 && to < S.page && S.page - to <= 3) pageStat(to)[2]++; // went back to re-read
  S.page = to;
  S.pageSince = 0;
}

function tick() {
  const t = Date.now();
  const dt = Math.min(2500, Math.max(0, t - (S.lastTick || t))) * (window.__LUMA_ACTIVITY_SPEED__ || 1); // (tests run the clock faster)
  S.lastTick = t;
  if (!tracking()) { if (S.session) endSession("off"); return; }
  const tab = S.getTab();
  const listening = S.isListening();
  const inFront = document.visibilityState === "visible" && document.documentElement.dataset.view === "reader";
  if (!tab || tab.state !== "ready" || (!inFront && !listening)) {
    if (S.session && !S.hiddenAt) S.hiddenAt = t;
    if (S.session && t - S.hiddenAt > 120000) endSession("away");
    return;
  }
  S.hiddenAt = 0;
  if (S.session && S.session.docId !== tab.docId) endSession("switch");
  if (S.paused) return;
  const sinceInput = t - S.lastInput;
  const limit = idleLimit(tab);
  if (!listening && sinceInput > limit) {
    if (S.session && S.sinceInput > 0) {
      // you stepped away: keep about one page's worth of the quiet time, not all of it
      const w = wordsOn(tab, S.page) ?? 300;
      const keep = Math.min(S.sinceInput, (w / usualPace()) * 60000 * 1.3);
      const back = S.sinceInput - keep;
      S.session.ms = Math.max(0, S.session.ms - back);
      S.pageSince = Math.max(0, S.pageSince - back);
      const st = pageStat(S.page); st[0] = Math.max(0, st[0] - back);
      const h = new Date(t).getHours(); S.session.hours[h] = Math.max(0, (S.session.hours[h] || 0) - back);
      S.sinceInput = 0;
    }
    if (S.session && sinceInput > 10 * 60000) endSession("idle");
    return;
  }
  if (!S.session) newSession(tab);
  const s = S.session;
  const page = tab.currentPage();
  if (page !== S.page) leavePage(tab, page);
  s.end = t;
  if (listening) s.listen += dt;
  else {
    s.ms += dt;
    S.sinceInput += dt;
    S.pageSince += dt;
    pageStat(page)[0] += dt;
    const h = new Date(t).getHours();
    s.hours[h] = (s.hours[h] || 0) + dt;
  }
  if (s.goal && !s.goalHit) {
    const reached = s.goal.ms ? s.ms + s.listen >= s.goal.ms : s.goal.page ? page >= s.goal.page : false;
    if (reached) { s.goalHit = true; bus.emit("session-goal", summary()); }
  }
  bus.emit("session-tick", summary());
  if (t % 15000 < 1000) checkpoint();
}

function checkpoint() {
  try { if (S.session) localStorage.setItem(CHECKPOINT, JSON.stringify(S.session)); else localStorage.removeItem(CHECKPOINT); } catch {}
}

function rememberToc(tab) {
  const toc = tab.model?.toc;
  if (!toc?.length || tocOf(tab.docId)) return;
  S.toc = { docId: tab.docId, list: toc.filter((x) => !x.depth).slice(0, 80).map((x) => [x.page, String(x.title).slice(0, 80)]) };
}

/** A session as it's kept: compact, with only the pages that were really read. */
function compact(s, live = false) {
  const pg = {};
  let pages = 0, words = 0;
  for (const [p, st0] of Object.entries(s.pg)) {
    if (Number(p) < 1) continue;
    const st = st0.map((x) => Math.round(x));
    if (!st[1]) st[1] = S.words.get(`${s.docId}:${p}`) || 0;
    if (st[0] >= 3000 || st[2] || st[3]) pg[p] = st;
    // read, not flicked past: at least the time it takes at 900 words a minute (and 5 s)
    if (st[0] >= Math.max(5000, (st[1] / 900) * 60000)) { pages++; words += st[1]; }
  }
  return {
    id: s.id, d: s.docId, s: s.start, e: s.end, ms: Math.round(s.ms), ls: Math.round(s.listen), p: pages, w: words,
    pw: Math.round(s.pw), pm: Math.round(s.pm), h: Object.fromEntries(Object.entries(s.hours).filter(([, v]) => v > 1000).map(([k, v]) => [k, Math.round(v)])),
    pg, m: s.manual ? 1 : 0, g: s.goal?.ms || (s.goal?.page ? -s.goal.page : 0), live: live || undefined,
  };
}

async function saveSession(c) {
  const id = recId(monthKey(c.s));
  const cur = store.get("settings", id);
  const rec = cur ? { ...cur } : { id, kind: "activity", device: deviceId, month: monthKey(c.s), sessions: [], rev: {}, toc: {} };
  rec.sessions = [...rec.sessions.filter((x) => x.id !== c.id), c].slice(-600);
  if (S.toc && !rec.toc?.[S.toc.docId]) rec.toc = { ...(rec.toc || {}), [S.toc.docId]: S.toc.list };
  await store.put("settings", rec);
}

/** Finish the session in progress (if it's worth keeping) and save it. */
export async function endSession(why = "") {
  const s = S.session;
  if (!s) return null;
  const tab = S.getTab();
  if (tab && tab.docId === s.docId) leavePage(tab, -1);
  S.session = null;
  S.paused = false;
  checkpoint();
  const c = compact(s);
  bus.emit("session-end", { ...summaryOf(s), why });
  if (c.ms + c.ls < 20000) return null; // a glance, not a session
  await saveSession(c).catch((e) => console.warn("Reading time:", e));
  bus.emit("activity-saved", c);
  return c;
}

function summaryOf(s) {
  const c = compact(s, true);
  return {
    docId: s.docId, ms: s.ms, listen: s.listen, pages: c.p, words: c.w,
    pace: s.pm > 60000 ? Math.round((s.pw / s.pm) * 60000) : null,
    manual: s.manual, goal: s.goal, goalHit: s.goalHit, start: s.start, paused: S.paused,
  };
}
export function summary() { return S.session ? summaryOf(S.session) : null; }

/** Today so far (finished sessions + the one in progress). */
export function today() {
  const k = dayKey();
  let ms = 0, listen = 0, pages = 0, words = 0;
  for (const s of allSessions()) if (dayKey(s.s) === k) { ms += s.ms; listen += s.ls; pages += s.p; words += s.w; }
  return { ms, listen, pages, words };
}

// ───────── timed sessions ─────────
/** Start a timed reading session: { minutes } or { chapter: true } or {} for no limit. */
export async function startTimed(tab, { minutes = 0, chapter = false } = {}) {
  if (S.session) await endSession("restart");
  let goal = null;
  if (minutes) goal = { ms: minutes * 60000 };
  else if (chapter) {
    const toc = tab.model?.toc?.filter((x) => !x.depth) || [];
    const next = toc.find((x) => x.page > tab.currentPage());
    goal = next ? { page: next.page, title: next.title } : { page: tab.pages, title: "the end" };
  }
  S.lastInput = Date.now();
  newSession(tab, { manual: true, goal });
  S.paused = false;
  bus.emit("session-tick", summary());
}
export function pauseTimed(on = !S.paused) { S.paused = on; bus.emit("session-tick", summary()); }

// ───────── signals from the rest of the app ─────────
export function poke() { S.lastInput = Date.now(); if (S.sinceInput) S.sinceInput = 0; }

/** Wire the tracker to the reader. */
export function attachActivity({ getTab, isListening, root }) {
  S.getTab = getTab;
  S.isListening = isListening;
  S.lastInput = Date.now();
  const opts = { passive: true, capture: true };
  let last = 0;
  const onInput = () => { const t = Date.now(); if (t - last > 400) { last = t; poke(); } };
  for (const ev of ["keydown", "pointerdown", "wheel", "touchstart", "scroll"]) root.addEventListener(ev, onInput, opts);
  root.addEventListener("pointermove", onInput, opts);
  bus.on("tab-page", () => poke());
  bus.on("lookup", ({ docId, page }) => { if (S.session?.docId === docId && page) pageStat(page)[3]++; });
  bus.on("word-review", ({ correct }) => countReview(correct));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") checkpoint(); });
  window.addEventListener("pagehide", () => checkpoint());
  clearInterval(S.timer);
  S.timer = setInterval(tick, 1000);
  recover();
}

/** A session left open when the app was closed: keep it. */
function recover() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(CHECKPOINT) || "null"); } catch {}
  try { localStorage.removeItem(CHECKPOINT); } catch {}
  if (!s?.id || !s.pg) return;
  const c = compact(s);
  if (c.ms + c.ls >= 20000) saveSession(c).catch(() => {});
}

let revDirty = null;
function countReview(correct) {
  const k = dayKey();
  revDirty ||= {};
  revDirty[k] ||= [0, 0];
  revDirty[k][0]++;
  if (correct) revDirty[k][1]++;
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(flushReviews, 20000);
}
async function flushReviews() {
  if (!revDirty) return;
  const add = revDirty;
  revDirty = null;
  const id = recId(monthKey());
  const cur = store.get("settings", id);
  const rec = cur ? { ...cur } : { id, kind: "activity", device: deviceId, month: monthKey(), sessions: [], rev: {}, toc: {} };
  rec.rev = { ...(rec.rev || {}) };
  for (const [d, [n, ok]] of Object.entries(add)) { const [a, b] = rec.rev[d] || [0, 0]; rec.rev[d] = [a + n, b + ok]; }
  await store.put("settings", rec).catch(() => {});
}
window.addEventListener("pagehide", () => { flushReviews(); });
