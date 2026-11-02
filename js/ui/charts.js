// Small, quiet charts for Insights, drawn as SVG at the size they're shown:
// columns, a calendar, a pace scale and a trend line. One colour (the accent),
// hairline grids, values in text colours, and a tooltip on hover or focus.
import { el } from "../core/util.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) n.append(c);
  return n;
};
const text = (x, y, s, attrs = {}) => { const t = svgEl("text", { x, y, ...attrs }); t.textContent = s; return t; };

function niceMax(v) {
  if (v <= 0) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of p >= 10 ? [1, 1.5, 2, 3, 4, 5, 6, 8, 10] : [1, 2, 4, 6, 8, 10]) if (m * p >= v) return m * p; // so the middle line is a whole number
  return 10 * p;
}

/** Draws `draw(width)` now and again whenever the box changes width. */
function responsive(cls, draw, label) {
  const box = el(`div.chart.${cls}`, { role: "img", "aria-label": label });
  const tip = el("div.chart-tip", { hidden: true, role: "status" });
  let last = 0;
  const redraw = () => {
    const w = Math.round(box.clientWidth);
    if (!w || w === last) return;
    last = w;
    const svg = draw(w, tip, box);
    box.replaceChildren(svg, tip);
  };
  new ResizeObserver(redraw).observe(box);
  requestAnimationFrame(redraw);
  return box;
}

function showTip(tip, box, x, y, value, label) {
  tip.replaceChildren(el("strong", {}, value), el("span", {}, label));
  tip.hidden = false;
  const bw = box.clientWidth;
  const tw = tip.offsetWidth;
  tip.style.left = Math.max(0, Math.min(bw - tw, x - tw / 2)) + "px";
  tip.style.top = Math.max(0, y - tip.offsetHeight - 10) + "px";
}

/**
 * Columns: items [{ v, label, short, strong }], each a value on one scale.
 * fmt(v) formats a value for the tooltip and axis; goal draws a reference line.
 */
export function columns(items, { fmt = String, tick = fmt, goal = null, goalLabel = "goal", height = 190, label = "Chart", every = 0 } = {}) {
  return responsive("columns", (W, tip, box) => {
    const H = height, L = 38, R = goal ? 40 : 8, T = 12, B = 26;
    const max = niceMax(Math.max(goal || 0, ...items.map((i) => i.v)) * 1.05);
    const n = items.length;
    const slot = (W - L - R) / Math.max(1, n);
    const bw = Math.max(3, Math.min(24, slot * 0.62));
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart-svg" });
    for (const v of [0, max / 2, max]) {
      svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v ? "grid" : "base" }));
      svg.append(text(L - 8, y(v) + 4, tick(v), { class: "tick", "text-anchor": "end" }));
    }
    if (goal) {
      svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(goal), y2: y(goal), class: "goal" }));
      svg.append(text(W - R + 6, y(goal) + 4, goalLabel, { class: "tick goal-label", "text-anchor": "start" }));
    }
    const step = every || Math.max(1, Math.ceil(34 / slot));
    items.forEach((it, i) => {
      const cx = L + slot * i + slot / 2;
      const top = y(it.v), base = y(0);
      const h = base - top;
      if (it.v > 0 && h > 0) {
        const r = Math.min(4, h, bw / 2);
        const x0 = cx - bw / 2, x1 = cx + bw / 2;
        svg.append(svgEl("path", { class: "bar" + (it.strong ? " strong" : ""), d: `M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x1 - r} Q${x1},${top} ${x1},${top + r} V${base} Z` }));
      }
      if (i % step === 0 || it.strong) svg.append(text(cx, H - 8, it.short ?? it.label, { class: "tick" + (it.strong ? " strong" : ""), "text-anchor": "middle" }));
      const hit = svgEl("rect", { x: L + slot * i, y: T, width: slot, height: H - T - B, class: "hit", tabindex: "0", "aria-label": `${it.label}: ${fmt(it.v)}` });
      const on = () => { hit.classList.add("on"); showTip(tip, box, cx, Math.min(top, base - 4), fmt(it.v), it.label); };
      const off = () => { hit.classList.remove("on"); tip.hidden = true; };
      hit.addEventListener("pointerenter", on); hit.addEventListener("focus", on);
      hit.addEventListener("pointerleave", off); hit.addEventListener("blur", off);
      svg.append(hit);
    });
    return svg;
  }, label);
}

/** A calendar of the last months: one square a day, darker = more reading. */
export function calendar(days, { goalMs = 20 * 60000, fmt = String } = {}) {
  const level = (ms) => (ms <= 0 ? 0 : ms < goalMs * 0.25 ? 1 : ms < goalMs * 0.6 ? 2 : ms < goalMs ? 3 : 4);
  const first = new Date(days[0].t);
  const weeks = Math.ceil(days.length / 7);
  const grid = el("div.cal-grid", { style: { "--weeks": weeks }, role: "grid", "aria-label": "Reading calendar" });
  const tip = el("div.chart-tip", { hidden: true });
  const months = el("div.cal-months", { style: { "--weeks": weeks } });
  let lastMonth = -1;
  days.forEach((d, i) => {
    const date = new Date(d.t);
    const w = Math.floor(i / 7);
    if (date.getDate() <= 7 && date.getMonth() !== lastMonth && date.getDay() === 1) {
      lastMonth = date.getMonth();
      months.append(el("span", { style: { gridColumn: `${w + 1} / span 4` } }, date.toLocaleDateString(undefined, { month: "short" })));
    }
    const label = date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    const cell = el("span.cal-cell", {
      dataset: { level: level(d.ms), today: String(d.key === days[days.length - 1].key) }, tabindex: "0", role: "gridcell",
      "aria-label": `${label}: ${fmt(d.ms)}`, style: { gridColumn: w + 1, gridRow: ((date.getDay() + 6) % 7) + 1 },
    });
    const on = () => {
      const r = cell.getBoundingClientRect(), b = wrap.getBoundingClientRect();
      showTip(tip, wrap, r.left - b.left + r.width / 2, r.top - b.top, d.ms ? fmt(d.ms) : "No reading", label);
    };
    cell.addEventListener("pointerenter", on); cell.addEventListener("focus", on);
    cell.addEventListener("pointerleave", () => { tip.hidden = true; }); cell.addEventListener("blur", () => { tip.hidden = true; });
    grid.append(cell);
  });
  void first;
  const wrap = el("div.chart.calendar", {},
    months,
    el("div.cal-body", {}, el("div.cal-days", { "aria-hidden": "true" }, el("span", {}, "Mon"), el("span"), el("span", {}, "Wed"), el("span"), el("span", {}, "Fri"), el("span"), el("span")), grid),
    el("div.cal-legend", { "aria-hidden": "true" }, el("span", {}, "Less"), [0, 1, 2, 3, 4].map((l) => el("span.cal-cell", { dataset: { level: l } })), el("span", {}, "More")),
    tip);
  return wrap;
}

/** Where your pace sits among adult readers. */
export function paceScale(wpm, { typical, low, high } = {}) {
  return responsive("pace-scale", (W) => {
    const H = 112, L = 10, R = 10;
    const min = 100, max = Math.max(450, Math.ceil(((wpm || 0) + 30) / 50) * 50);
    const x = (v) => L + ((W - L - R) * (Math.min(max, Math.max(min, v)) - min)) / (max - min);
    const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart-svg" });
    const yb = 52;
    svg.append(svgEl("rect", { x: x(low), y: yb - 7, width: x(high) - x(low), height: 14, rx: 7, class: "band" }));
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: yb, y2: yb, class: "base" }));
    for (const v of [100, 200, 300, 400].filter((v) => v <= max)) svg.append(text(x(v), H - 4, String(v), { class: "tick", "text-anchor": "middle" }));
    svg.append(svgEl("line", { x1: x(typical), x2: x(typical), y1: yb - 12, y2: yb + 12, class: "ref" }));
    svg.append(text(x(typical), yb + 26, `typical ${typical}`, { class: "tick", "text-anchor": "middle" }));
    if (wpm) {
      svg.append(svgEl("circle", { cx: x(wpm), cy: yb, r: 8, class: "you-ring" }));
      svg.append(svgEl("circle", { cx: x(wpm), cy: yb, r: 6, class: "you" }));
      svg.append(text(Math.min(W - R - 30, Math.max(L + 30, x(wpm))), yb - 18, `You · ${wpm}`, { class: "you-label", "text-anchor": "middle" }));
    }
    return svg;
  }, wpm ? `Your pace ${wpm} words a minute; typical adults read about ${typical}` : "Pace scale");
}

/** A line over time: points [{ label, v }] (v may be null for a gap). */
export function trend(points, { fmt = String, height = 120, label = "Trend" } = {}) {
  return responsive("trend", (W, tip, box) => {
    const H = height, L = 34, R = 62, T = 14, B = 22;
    const vals = points.map((p) => p.v).filter((v) => v != null);
    const lo = Math.max(0, Math.floor((Math.min(...vals) - 20) / 50) * 50);
    const hi = niceMax(Math.max(...vals) + 20);
    const x = (i) => L + ((W - L - R) * i) / Math.max(1, points.length - 1);
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / Math.max(1, hi - lo));
    const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart-svg" });
    for (const v of [lo, (lo + hi) / 2, hi]) {
      svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === lo ? "base" : "grid" }));
      svg.append(text(L - 6, y(v) + 4, String(Math.round(v)), { class: "tick", "text-anchor": "end" }));
    }
    let d = "", area = "", started = false, lastI = -1;
    points.forEach((p, i) => {
      if (p.v == null) { started = false; return; }
      d += `${started ? "L" : "M"}${x(i)},${y(p.v)} `;
      started = true;
      lastI = i;
    });
    const first = points.findIndex((p) => p.v != null);
    if (first >= 0) {
      area = `M${x(first)},${y(lo)} ` + points.map((p, i) => (p.v == null ? "" : `L${x(i)},${y(p.v)} `)).join("") + `L${x(lastI)},${y(lo)} Z`;
      svg.append(svgEl("path", { d: area, class: "area" }));
      svg.append(svgEl("path", { d, class: "line" }));
      for (const [i, p] of points.entries()) if (p.v != null && (i === lastI || points.filter((q) => q.v != null).length <= 2)) {
        svg.append(svgEl("circle", { cx: x(i), cy: y(p.v), r: 6, class: "you-ring" }), svgEl("circle", { cx: x(i), cy: y(p.v), r: 4, class: "you" }));
      }
      svg.append(text(x(lastI) + 8, y(points[lastI].v) + 4, fmt(points[lastI].v), { class: "end-label" }));
    }
    [0, points.length - 1].forEach((i) => svg.append(text(x(i), H - 6, points[i].label, { class: "tick", "text-anchor": i ? "end" : "start" })));
    const cross = svgEl("line", { y1: T, y2: H - B, class: "cross", visibility: "hidden" });
    svg.append(cross);
    const hit = svgEl("rect", { x: L, y: 0, width: W - L - R, height: H, class: "hit", tabindex: "0", "aria-label": label });
    const at = (cx) => {
      const i = Math.max(0, Math.min(points.length - 1, Math.round(((cx - L) / (W - L - R)) * (points.length - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      const p = points[i];
      showTip(tip, box, x(i), p.v != null ? y(p.v) : T + 20, p.v != null ? fmt(p.v) : "Not enough reading", p.label);
    };
    hit.addEventListener("pointermove", (e) => at(e.clientX - svg.getBoundingClientRect().left));
    hit.addEventListener("focus", () => at(x(lastI >= 0 ? lastI : points.length - 1)));
    const off = () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; };
    hit.addEventListener("pointerleave", off); hit.addEventListener("blur", off);
    svg.append(hit);
    return svg;
  }, label);
}

/** Horizontal bars with the value at the tip: rows [{ label, v, note }]. */
export function hbars(rows, { fmt = String, max = null } = {}) {
  const m = max || Math.max(1, ...rows.map((r) => r.v || 0));
  return el("div.chart.hbars", {}, rows.map((r) => el("div.hbar-row", {},
    el("span.hbar-label", {}, r.label),
    el("span.hbar-track", {}, r.v ? el("span.hbar-fill", { style: { width: `${Math.max(2, (r.v / m) * 100)}%` } }) : el("span.hbar-none", {}, r.note || "")),
    el("span.hbar-val", {}, r.v ? fmt(r.v) : "—"))));
}

/** The same numbers as a small table (for screen readers and anyone who prefers them). */
export function numbers(headers, rows) {
  return el("details.chart-numbers", {},
    el("summary", {}, "Show the numbers"),
    el("table", {}, el("thead", {}, el("tr", {}, headers.map((h) => el("th", {}, h)))),
      el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c) => el("td", {}, String(c))))))));
}
