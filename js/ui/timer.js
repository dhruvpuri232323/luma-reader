// The reading timer: today's reading time at the bottom of the reader, and —
// when you want one — a timed session with a goal, a live clock, your pace,
// a soft chime at the goal and a summary at the end.
import { el, setKids, isNarrow, bus } from "../core/util.js";
import { store } from "../data/store.js";
import { today, summary, startTimed, pauseTimed, endSession, usualPace } from "../data/activity.js";
import { cue } from "../core/feel.js";
import { icon } from "./icons.js";
import { closeMenus, dialog, toast } from "./overlay.js";
import { navigate } from "./router.js";

export const fmtClock = (ms) => { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const ss = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`; };
export const fmtMin = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`; };
const goalMin = () => Number(store.settings().readGoal) || 20;

/** The chip at the bottom of the reader. */
export function timerChip(getTab) {
  const chip = el("button.btn.sm.timer-chip", { onclick: (e) => timerPopover(e.currentTarget, getTab()) });
  const draw = () => {
    const s = summary();
    if (s?.manual) {
      const ms = s.ms + s.listen;
      const goal = s.goal?.ms;
      chip.classList.add("running");
      chip.classList.toggle("paused", Boolean(s.paused));
      chip.style.setProperty("--p", goal ? Math.min(1, ms / goal) : 0);
      chip.title = s.paused ? "Session paused" : goal ? `Reading session: ${fmtClock(ms)} of ${fmtClock(goal)}` : "Reading session";
      setKids(chip, el("span.timer-ring", { "aria-hidden": "true" }), el("span.timer-clock", {}, fmtClock(ms)));
    } else {
      const t = today();
      const min = Math.round((t.ms + t.listen) / 60000);
      chip.classList.remove("running", "paused");
      chip.title = `Read today: ${min} min of your ${goalMin()}-minute goal. Start a timed session`;
      chip.style.setProperty("--p", Math.min(1, min / goalMin()));
      setKids(chip, el("span.timer-ring.quiet", { "aria-hidden": "true" }, icon("timer", 15)), el("span.timer-today", {}, `${min}m`));
    }
  };
  // the chip lives as long as the reader does
  bus.on("session-tick", draw); bus.on("session-end", draw); bus.on("activity-saved", draw); bus.on("settings", draw);
  draw();
  return chip;
}

export function timerPopover(anchor, tab) {
  closeMenus();
  document.querySelectorAll(".popover").forEach((p) => p.remove());
  const pop = el("div.menu.popover.timer-pop", { role: "dialog", "aria-label": "Reading time" });
  const draw = () => {
    const s = summary();
    const t = today();
    const todayMin = Math.round((t.ms + t.listen) / 60000);
    const running = s?.manual;
    const pace = s?.pace;
    setKids(pop,
      el("div.pop-title", {}, el("strong", {}, "Reading time"), el("button.icon-btn.sm", { "aria-label": "Close", onclick: () => close() }, icon("x", 16))),
      el("div.timer-today-row", {},
        el("div.goal-ring", { style: { "--p": Math.min(1, todayMin / goalMin()) }, "aria-hidden": "true" }, el("span", {}, `${todayMin}`)),
        el("div", {},
          el("strong", {}, todayMin >= goalMin() ? "Today's goal reached" : `${todayMin} of ${goalMin()} minutes today`),
          el("p.muted.small", {}, [t.pages ? `${t.pages} ${t.pages === 1 ? "page" : "pages"}` : null, t.words ? `${t.words.toLocaleString()} words` : null, t.listen >= 60000 ? `${fmtMin(t.listen)} listening` : null].filter(Boolean).join(" · ") || "Luma counts your reading time on its own while a book is open."))),
      running
        ? el("div.timer-live", {},
            el("div.timer-big", {}, fmtClock(s.ms + s.listen), s.goal?.ms ? el("span.muted", {}, ` / ${fmtClock(s.goal.ms)}`) : null),
            el("p.muted.small", {}, [
              s.goal?.page ? `Until ${s.goal.title === "the end" ? "the end of the book" : `“${s.goal.title}”`} (p. ${s.goal.page})` : null,
              `${s.pages} ${s.pages === 1 ? "page" : "pages"} so far`,
              pace ? `${pace} words a minute` : null,
            ].filter(Boolean).join(" · ")),
            el("div.row", {},
              el("button.btn.sm", { onclick: () => { pauseTimed(); draw(); } }, icon(s.paused ? "play" : "pause", 15), s.paused ? "Carry on" : "Pause"),
              el("button.btn.sm.primary", { onclick: async () => { close(); const c = await endSession("done"); showSummary(c, s); } }, icon("check", 15), "End session")))
        : el("div.timer-start", {},
            el("p.timer-label", {}, "Start a timed session"),
            el("div.timer-goals", {},
              [10, 20, 30, 45, 60].map((m) => el("button.btn.sm", { onclick: () => begin({ minutes: m }) }, `${m} min`)),
              tab?.model?.toc?.length ? el("button.btn.sm", { onclick: () => begin({ chapter: true }) }, "To the end of the chapter") : null,
              el("button.btn.sm", { onclick: () => begin({}) }, "No limit"))),
      el("div.timer-foot", {},
        el("button.link.small", { onclick: () => { close(); navigate("#/insights"); } }, icon("chart", 14), " Your reading insights"),
        el("span.spacer"),
        el("label.small.muted.goal-pick", {}, "Daily goal ",
          el("select.select.sm", { "aria-label": "Daily reading goal", onchange: (e) => store.setSettings({ readGoal: Number(e.target.value) }) },
            [10, 15, 20, 30, 45, 60, 90].map((m) => el("option", { value: m, selected: m === goalMin() }, `${m} min`))))));
  };
  const begin = async (opts) => {
    if (!tab || tab.state !== "ready") { toast("Open a book first."); return; }
    await startTimed(tab, opts);
    close();
    toast(opts.minutes ? `${opts.minutes}-minute session started — happy reading` : opts.chapter ? "Session started — until the end of this chapter" : "Session started", { duration: 2600 });
  };
  const offs = [bus.on("session-tick", () => pop.isConnected && draw()), bus.on("settings", () => pop.isConnected && draw())];
  const close = () => { pop.remove(); offs.forEach((f) => f()); document.removeEventListener("pointerdown", outside, true); };
  const outside = (e) => { if (!pop.contains(e.target) && !e.target.closest(".timer-chip")) close(); };
  draw();
  document.body.append(pop);
  if (isNarrow()) pop.classList.add("sheet");
  else {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    Object.assign(pop.style, { left: Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px", top: "auto", bottom: Math.max(8, innerHeight - r.top + 8) + "px" });
  }
  requestAnimationFrame(() => pop.classList.add("in"));
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
}

/** The card at the end of a timed session. */
export function showSummary(c, live) {
  const ms = (c?.ms ?? live?.ms ?? 0) + (c?.ls ?? live?.listen ?? 0);
  if (ms < 20000) { toast("Session ended — too short to keep."); return; }
  const pages = c?.p ?? live?.pages ?? 0;
  const words = c?.w ?? live?.words ?? 0;
  const pace = c && c.pm > 60000 ? Math.round((c.pw / c.pm) * 60000) : live?.pace;
  const usual = Math.round(usualPace());
  let slow = null;
  if (c?.pg) {
    const rates = Object.entries(c.pg).filter(([, st]) => st[1] >= 60 && st[0] >= 15000).map(([p, st]) => [Number(p), st[0] / st[1]]);
    if (rates.length >= 4) {
      const med = [...rates].map((r) => r[1]).sort((a, b) => a - b)[Math.floor(rates.length / 2)];
      const worst = rates.sort((a, b) => b[1] - a[1])[0];
      if (worst[1] >= med * 1.7) slow = { page: worst[0], k: worst[1] / med };
    }
  }
  const doc = c ? store.get("docs", c.d) : null;
  const goalNote = live?.goal?.ms ? (ms >= live.goal.ms ? "Goal reached" : `${fmtMin(live.goal.ms - ms)} short of your goal — still counts`) : null;
  dialog({
    title: "Session done",
    className: "summary-dialog",
    body: (box) => box.append(
      el("div.sum-hero", {}, el("span.sum-time", {}, fmtMin(ms)), doc ? el("span.muted", {}, doc.title) : null),
      el("div.sum-stats", {},
        stat(pages, pages === 1 ? "page" : "pages"),
        stat(words.toLocaleString(), "words"),
        stat(pace || "—", "words a minute")),
      el("ul.sum-notes", {},
        goalNote ? el("li", {}, icon(ms >= (live?.goal?.ms || 0) ? "check" : "timer", 15), goalNote) : null,
        pace && usual && Math.abs(pace - usual) / usual > 0.12 ? el("li", {}, icon("trend", 15), pace > usual ? `${Math.round((pace / usual - 1) * 100)}% faster than your usual pace (${usual})` : `${Math.round((1 - pace / usual) * 100)}% slower than your usual pace (${usual}) — a denser stretch?`) : null,
        slow ? el("li", {}, icon("flame", 15), `You slowed down most on page ${slow.page} (${slow.k.toFixed(1)}× your pace this session).`) : null)),
    actions: [
      { label: "See insights", value: "insights" },
      { label: "Done", primary: true, value: null },
    ],
  }).then((v) => { if (v === "insights") navigate("#/insights"); });
}
const stat = (v, l) => el("div.sum-stat", {}, el("strong", {}, String(v)), el("span", {}, l));

// gentle chime and a word of thanks when a timed goal is reached
bus.on("session-goal", (s) => {
  cue("done");
  toast(s.goal?.page ? "You reached the end of the chapter." : `${fmtMin(s.ms + s.listen)} — goal reached. Nicely done.`, {
    action: "End session", duration: 9000,
    onAction: async () => { const live = summary(); const c = await endSession("goal"); showSummary(c, live); },
  });
});
