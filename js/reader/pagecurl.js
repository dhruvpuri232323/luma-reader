// A page you can take by the corner and turn.
//
// The page folds along a straight line — halfway between where its corner was
// and where it is now, at right angles to that — exactly as a sheet of paper
// does when you lift a corner and lay it over. What you see:
//   • the front: the page as it was, clipped to the part still lying flat
//   • the flap: the back of the page reflected over the fold — the next
//     left-hand page in a two-page spread, or blank paper with the print
//     showing through faintly when one page is shown
//   • the light: a crease and a highlight along the curve of the flap, the soft
//     shadow the flap casts, and the shadow under the lifted page
// Everything moves with transforms only (rotated clipping boxes), so the page
// follows the mouse, finger or trackpad at full frame rate, even on phones.
import { el } from "../core/util.js";

// ── 2D affine matrices, in CSS order [a, b, c, d, e, f]: x' = ax + cy + e, y' = bx + dy + f ──
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const inv = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
};
const tr = (x, y) => [1, 0, 0, 1, x, y];
const sc = (x, y = 1) => [x, 0, 0, y, 0, 0];
/** Reflection across the line through M with unit normal n. */
const reflect = (M, [nx, ny]) => {
  const k = 2 * (M[0] * nx + M[1] * ny);
  return [1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * ny, 1 - 2 * ny * ny, k * nx, k * ny];
};
/** A square box of side S whose left edge lies on the line through M, reaching into the side k points to. */
const halfBox = (M, k, S) => [k[0], k[1], -k[1], k[0], M[0] + (S / 2) * k[1], M[1] - (S / 2) * k[0]];
const css = (m) => `matrix(${m.map((v) => Math.round(v * 1e4) / 1e4).join(",")})`;
const set = (node, m) => { node.style.transform = css(m); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;

// A page turned by hand lifts gently, sweeps over and settles: a soft ease-in
// until 38% of the time (by then 42% of the way), then a long ease-out.
const TA = 0.38, TY = 0.42, K1 = TY / (TA * TA), K2 = (1 - TY) / Math.pow(1 - TA, 2.2);
export const EASE = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  turn: (t) => (t <= TA ? K1 * t * t : 1 - K2 * Math.pow(1 - t, 2.2)),
};

const reducedMotion = () => document.documentElement.dataset.motion === "reduce";

/**
 * One page turn (or just a corner lifting, `peek`).
 *   host     the positioned element the turn is drawn in
 *   rect     the page (or two-page spread) relative to host: { left, top, width, height }
 *   dir      1 forward, -1 back
 *   spread   two pages side by side: the right page turns forward, the left page back
 *   corner   "bottom" | "top" — the corner held
 *   oldNode  what's on screen now, laid out at rect's size; shown straight away
 *            so nothing flickers while the new page is put in place underneath
 *   stiffness  1 is ordinary paper; more is stiffer (a flatter arc)
 */
export class PageCurl {
  constructor(host, rect, { dir = 1, spread = false, corner = "bottom", oldNode = null, copy = (n) => n.cloneNode(true), stiffness = 1, peek = false, fadeSingle = true } = {}) {
    if (!peek) host.__turn?.finish?.();
    this.host = host;
    this.rect = rect;
    this.dir = dir;
    this.spread = spread;
    this.copy = copy;
    this.peek = peek;
    this.stiff = stiffness;
    this.fadeSingle = fadeSingle && !spread;
    const W = (this.W = rect.width), H = (this.H = rect.height);
    if (spread) { const half = W / 2; this.leaf = dir > 0 ? { x: half, w: half } : { x: 0, w: half }; this.sx = half; }
    else { this.leaf = { x: 0, w: W }; this.sx = 0; }
    this.reverse = !spread && dir < 0; // one page, going back: the previous page comes back over this one
    const outer = spread ? (dir > 0 ? W : 0) : W;
    this.bottom = corner !== "top";
    this.C = [outer, this.bottom ? H : 0];
    this.E = [2 * this.sx - outer, this.C[1]];
    this.from = this.reverse ? this.E : this.C;
    this.to = this.reverse ? this.C : this.E;
    this.P = [...this.from];
    this.target = [...this.from];
    this.S = Math.ceil(2 * (2 * this.leaf.w + H) + 200);
    this.spineM = reflect([this.sx, 0], [1, 0]);
    this.rB = [2 * this.sx - this.leaf.x - this.leaf.w, 0]; // where the back of the leaf lies once turned over
    this.done = false;
    this.isReady = false;
    this.layer = el("div.curl-layer", {
      "aria-hidden": "true",
      style: { left: rect.left + "px", top: rect.top + "px", width: W + "px", height: H + "px" },
    });
    this.layer.inert = true;
    if (oldNode) {
      this.oldNode = oldNode;
      this.cover = this.#node(oldNode);
      this.layer.append(this.cover);
    }
    host.append(this.layer);
    if (!peek) host.__turn = this;
    if (peek) { this.#build(null); this.isReady = true; this.#render(this.P); }
    this.#loop();
  }

  get active() { return !this.done; }

  /** 0 → 1: how far the page has turned over (forward or back). */
  get turned() {
    const span = Math.abs(this.E[0] - this.C[0]) || 1;
    return clamp(Math.abs(this.P[0] - this.C[0]) / span, 0, 1);
  }

  /** 0 → 1: how far from where this turn started towards where it ends. */
  get progress() {
    const span = Math.abs(this.to[0] - this.from[0]) || 1;
    return clamp(Math.abs(this.P[0] - this.from[0]) / span, 0, 1);
  }

  #node(node, { cls = "", style = {} } = {}) {
    return el("div.curl-node" + cls, { style: { width: this.W + "px", height: this.H + "px", ...style } }, node);
  }

  /** The new page is in place underneath: lay out the turn. */
  ready(newNode) {
    if (this.done || this.isReady) return;
    this.#build(newNode);
    this.isReady = true;
    this.#render(this.P);
  }

  #build(newNode) {
    const { S, leaf, H } = this;
    const L = this.layer;
    const box = (cls) => el("div.curl-box" + cls, { style: { width: S + "px", height: S + "px" } });
    const strip = (cls) => el("div.curl-strip" + cls, { style: { height: S + "px" } });
    const ghost = (node) => node && this.#node(node, { cls: ".curl-ghost", style: { transform: css(this.spineM) } });
    let under = null, front = null, back = null;
    if (this.peek) { /* the live page is the front; paper underneath and behind */ }
    else if (this.reverse) { under = this.oldNode; front = newNode; back = ghost(this.copy(newNode)); }
    else { front = this.oldNode; back = this.spread ? (newNode ? this.#node(newNode) : null) : ghost(this.copy(this.oldNode)); }
    L.textContent = "";
    if (under) L.append(this.#node(under));
    // the page underneath, where the corner has lifted away from it, with the lifted page's shadow
    this.revRect = el("div.curl-rect", { style: { left: leaf.x + "px", width: leaf.w + "px", height: H + "px" } });
    this.revBox = box(".rev" + (this.peek ? ".paper" : ""));
    this.revShade = strip(".rev-shade");
    this.revBox.append(this.revShade);
    this.revRect.append(this.revBox);
    L.append(this.revRect);
    if (front) {
      this.frontBox = box(".front");
      this.frontIn = el("div.curl-in", {}, this.#node(front));
      this.frontShade = strip(".front-shade");
      this.frontBox.append(this.frontIn, this.frontShade);
      L.append(this.frontBox);
    }
    // the flap: the back of the page, folded over
    this.flapBox = box(".flap");
    this.flapShadow = el("div.curl-shadow", { style: { width: leaf.w + "px", height: H + "px" } });
    this.back = el("div.curl-back", { style: { width: leaf.w + "px", height: H + "px" } });
    this.backIn = el("div.curl-in", { style: { transform: css(tr(-this.rB[0], -this.rB[1])) } }, back);
    this.flapShade = strip(".flap-shade");
    this.back.append(this.backIn, this.flapShade);
    this.flapBox.append(this.flapShadow, this.back);
    L.append(this.flapBox);
  }

  #render(P) {
    if (!this.isReady) return;
    const { C, S, leaf, W, H } = this;
    const dx = C[0] - P[0], dy = C[1] - P[1];
    const dist = Math.hypot(dx, dy);
    const flat = dist < 0.75;
    this.layer.classList.toggle("flat", flat);
    if (flat) {
      // lying flat: the front is the whole page
      if (this.frontBox) { const m = tr(-(S - W) / 2, -(S - H) / 2); set(this.frontBox, m); set(this.frontIn, inv(m)); }
      return;
    }
    const n = [dx / dist, dy / dist]; // across the fold, towards the corner's old place
    const M = [(C[0] + P[0]) / 2, (C[1] + P[1]) / 2];
    const Hs = halfBox(M, [-n[0], -n[1]], S); // the spine side of the fold
    const Hc = halfBox(M, n, S); // the corner side
    const d = dist / 2; // how deep the fold is
    const t = this.turned;
    const lift = Math.min(1, d / 26);
    const I = Math.min(1, Math.sin(Math.PI * clamp(t, 0, 1)) * 1.3 + 0.2) * lift; // strength of the light and shade
    if (this.frontBox) {
      set(this.frontBox, Hs);
      set(this.frontIn, inv(Hs));
      set(this.frontShade, sc(clamp(d * 0.42, 3, 90) / 100));
      this.frontShade.style.opacity = I.toFixed(3);
    }
    set(this.revBox, mul(tr(-leaf.x, 0), Hc));
    set(this.revShade, sc(clamp(d * 0.8, 6, 160) / 100));
    this.revShade.style.opacity = (this.peek ? 0.8 * lift : I).toFixed(3);
    set(this.flapBox, Hs);
    const T = mul(reflect(M, n), this.spineM);
    const B = mul(inv(Hs), mul(T, tr(this.rB[0], this.rB[1])));
    set(this.back, B);
    set(this.flapShadow, B);
    this.flapShadow.style.opacity = (this.peek ? 0.7 * lift : I).toFixed(3);
    set(this.flapShade, mul(inv(B), sc(Math.max(d, 1) / 100)));
    // one page: the turned page leaves the book, so it lets go softly
    if (this.fadeSingle && !this.peek) this.flapBox.style.opacity = clamp((1 - t) / 0.3, 0, 1).toFixed(3);
  }

  /** Keep the corner on the page side of its edges, and the page joined to its spine. */
  #clampP([x, y]) {
    const { C, sx, leaf, H } = this;
    const outward = C[0] > sx ? 1 : -1;
    if ((x - C[0]) * outward > 0) x = C[0];
    y = this.bottom ? Math.min(y, C[1]) : Math.max(y, C[1]);
    const Sn = [sx, C[1]], Sf = [sx, H - C[1]];
    let vx = x - Sn[0], vy = y - Sn[1], len = Math.hypot(vx, vy);
    if (len > leaf.w) { x = Sn[0] + (vx * leaf.w) / len; y = Sn[1] + (vy * leaf.w) / len; }
    const D = Math.hypot(leaf.w, H);
    vx = x - Sf[0]; vy = y - Sf[1]; len = Math.hypot(vx, vy);
    if (len > D) { x = Sf[0] + (vx * D) / len; y = Sf[1] + (vy * D) / len; }
    return [x, y];
  }

  #loop() {
    let last = performance.now();
    const tick = (now) => {
      if (this.done) return;
      const dt = Math.min(64, now - last);
      last = now;
      const tw = this.tween;
      if (tw) {
        const k = clamp((now - tw.t0) / tw.ms, 0, 1);
        const e = tw.ease(k);
        let x = lerp(tw.a[0], tw.b[0], e);
        let y = lerp(tw.a[1], tw.b[1], e);
        if (tw.arc) y += (this.bottom ? -1 : 1) * tw.arc * Math.sin(Math.PI * e);
        this.P = this.#clampP([x, y]);
        this.target = [...this.P];
        this.#render(this.P);
        if (k >= 1) { this.tween = null; tw.resolve(); }
      } else {
        const ex = this.target[0] - this.P[0], ey = this.target[1] - this.P[1];
        if (Math.abs(ex) > 0.05 || Math.abs(ey) > 0.05) {
          // follow the hand with a touch of weight, like paper does
          const k = 1 - Math.pow(1 - (this.peek ? 0.2 : 0.42), dt / 16.7);
          this.P = [this.P[0] + ex * k, this.P[1] + ey * k];
          this.#render(this.P);
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Move the corner towards a point (layer coordinates). */
  moveTo(P) {
    if (this.done) return;
    this.tween = null;
    this.target = this.#clampP(P);
  }

  /** Start following the hand from where the corner is now. */
  grab(at = this.P) {
    this.tween = null;
    this.P = [...at];
    this.target = [...at];
    this.grabbed = [...at];
    this.samples = [];
  }

  /**
   * The hand has moved (dx, dy) since grab(). Forward, the corner moves with it;
   * going back one page at a time, the edge of the incoming page follows it.
   */
  dragBy(dx, dy, { soft = false } = {}) {
    if (this.done) return;
    const g = this.grabbed || this.from;
    let P;
    if (this.reverse) P = [g[0] + 2 * dx, this.C[1] + dy * 0.5];
    else P = [g[0] + dx, g[1] + dy * (soft ? 0.55 : 1)];
    const now = performance.now();
    (this.samples ||= []).push([now, dx]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 90) this.samples.shift();
    this.moveTo(P);
  }

  /** Pointer speed along x, px/ms, from the last few moves. */
  get velocity() {
    const s = this.samples || [];
    if (s.length < 2 || performance.now() - s[s.length - 1][0] > 70) return 0; // held still before letting go: no flick
    const [t0, x0] = s[0], [t1, x1] = s[s.length - 1];
    return t1 > t0 ? (x1 - x0) / (t1 - t0) : 0;
  }

  #tweenTo(b, ms, { ease = EASE.out, arc = 0 } = {}) {
    if (this.done) return Promise.resolve();
    if (reducedMotion()) ms = Math.min(ms, 120);
    return new Promise((resolve) => {
      this.tween = { a: [...this.P], b, ms: Math.max(1, ms), t0: performance.now(), ease, arc, resolve };
    });
  }

  /** Let go: finish the turn if it went far enough (or was flicked), otherwise lay the page back. */
  async release({ vx = this.velocity, onDecide } = {}) {
    if (this.done) return false;
    const towards = Math.sign(this.to[0] - this.from[0]) || 1;
    const v = vx * towards * (this.reverse ? 0.5 : 1);
    const u = this.progress;
    const commit = v > 0.35 ? true : v < -0.35 ? false : u > 0.36;
    onDecide?.(commit);
    const dest = commit ? this.to : this.from;
    const remain = Math.hypot(dest[0] - this.P[0], dest[1] - this.P[1]) / (Math.abs(this.E[0] - this.C[0]) || 1);
    const speed = Math.min(1.6, Math.abs(v)) / 1.6; // a flick lands faster
    await this.#tweenTo(dest, clamp(remain * (commit ? 620 : 520) * (1 - speed * 0.45), 140, 620), { ease: EASE.out });
    return commit;
  }

  /** The whole turn, on its own (a click, a key, the voice moving on). */
  async play(ms = 760) {
    if (this.done) return;
    this.P = [...this.from];
    const arc = (this.H * 0.16) / Math.max(0.6, this.stiff);
    await this.#tweenTo(this.to, ms, { ease: EASE.turn, arc });
  }

  /** Lay the page back where it was (for a peek). */
  async settle(ms = 260) {
    await this.#tweenTo(this.from, ms, { ease: EASE.out });
  }

  finish() {
    if (this.done) return;
    this.done = true;
    cancelAnimationFrame(this.raf);
    this.tween?.resolve();
    this.tween = null;
    this.layer.remove();
    if (this.host.__turn === this) this.host.__turn = null;
  }
}

/**
 * Taking pages by hand: hover near a corner and it lifts a little; drag it (mouse,
 * finger or pen) and it follows; let go and it either turns or lies back down.
 * A two-finger swipe on a trackpad turns it too. The view supplies an adapter:
 *   host()           element the turn is drawn in
 *   pageRect()       the page (or spread) in screen coordinates (DOMRect-like)
 *   spread()         two pages side by side?
 *   enabled()        is the page curl the turn for this book, right now?
 *   canTurn(dir)     is there a page that way?
 *   snapshot()       a copy of what's on screen now (laid out at the page's size)
 *   begin(dir)       put the next page in place (async); fresh() then gives a copy of it
 *   fresh()          a copy of the page now in place
 *   revert()         put the old page back (async) — the turn was let go
 *   committed(dir, how)   the turn happened ("drag" | "swipe" | "click")
 *   stiffness()      1 = ordinary paper
 *   copy(node)       copies a node (canvases keep their pictures)
 *   hotWidth()       how wide the grab strip along the outer edge is, in px
 *   captureEl()      (optional) the element listening for the pointer, which keeps it while dragging
 */
export class CurlHand {
  constructor(adapter) {
    this.a = adapter;
    this.peek = null;
    this.drag = null;
    this.swipe = null;
    this.quietUntil = 0;
  }

  get busy() { return Boolean(this.drag || this.swipe || this.settling); }

  #local(r) {
    const h = this.a.host().getBoundingClientRect();
    return { left: r.left - h.left, top: r.top - h.top, width: r.width, height: r.height };
  }

  /** Where the pointer is over the page: a corner or outer edge you can take hold of. */
  zoneAt(x, y, { touch = false } = {}) {
    if (!this.a.enabled()) return null;
    const r = this.a.pageRect();
    if (!r || r.width < 40) return null;
    const spread = this.a.spread();
    const hot = this.a.hotWidth?.() ?? 56;
    const corner = Math.min(120, r.height * 0.22);
    if (y < r.top - 16 || y > r.bottom + 16) return null;
    const pick = (dir, ex) => {
      const inEdge = Math.abs(x - ex) <= hot + (touch ? 24 : 0) && (dir > 0 ? x <= r.right + 18 : x >= r.left - 18);
      if (!inEdge) return null;
      if (!this.a.canTurn(dir)) return null;
      const bottom = y > r.top + r.height / 2;
      const nearCorner = bottom ? y > r.bottom - corner : y < r.top + corner;
      return { dir, corner: bottom ? "bottom" : "top", nearCorner, spread };
    };
    const fwd = pick(1, r.right);
    if (fwd) return fwd;
    return pick(-1, r.left);
  }

  // ── hovering: the corner lifts a little under the pointer ──
  hover(x, y) {
    if (this.busy) return;
    const z = this.zoneAt(x, y);
    const host = this.a.host();
    host.classList.toggle("curl-grab", Boolean(z));
    if (!z || !z.nearCorner || reducedMotion()) { this.unpeek(); return; }
    if (this.peek && (this.peek.dir !== z.dir || this.peek.bottom !== (z.corner === "bottom"))) this.unpeek(true);
    const rect = this.#local(this.a.pageRect());
    if (!this.peek) this.peek = new PageCurl(host, rect, { peek: true, dir: z.dir, spread: z.spread, corner: z.corner });
    const p = this.peek;
    // the closer to the corner, the more it lifts
    const hr = host.getBoundingClientRect();
    const lx = x - hr.left - rect.left, ly = y - hr.top - rect.top;
    const dc = Math.hypot(lx - p.C[0], ly - p.C[1]);
    const amt = clamp(48 - dc * 0.32, 16, 48);
    const inward = [p.C[0] > p.sx ? -1 : 1, p.bottom ? -0.62 : 0.62];
    const k = amt / Math.hypot(...inward);
    p.moveTo([p.C[0] + inward[0] * k, p.C[1] + inward[1] * k]);
  }

  unpeek(now = false) {
    const p = this.peek;
    if (!p) return;
    this.peek = null;
    if (now) { p.finish(); return; }
    p.settle(220).then(() => p.finish());
  }

  leave() { this.a.host().classList.remove("curl-grab"); this.unpeek(); }

  // ── taking hold ──
  #start(dir, cornerName, { at = null, how = "drag", soft = false } = {}) {
    const host = this.a.host();
    const rect = this.#local(this.a.pageRect());
    const curl = new PageCurl(host, rect, {
      dir, spread: this.a.spread(), corner: cornerName, oldNode: this.a.snapshot(), copy: this.a.copy, stiffness: this.a.stiffness?.() || 1,
    });
    curl.grab(at || curl.from);
    const ready = Promise.resolve(this.a.begin(dir)).then(() => { if (!curl.done) curl.ready(this.a.fresh()); }).catch(() => { curl.finish(); });
    return { curl, dir, ready, how, soft };
  }

  /** Pointer pressed. Returns true when the page has been taken hold of (mouse on a corner or edge). */
  down(e) {
    if (e.button !== 0 || this.busy) return false;
    const touch = e.pointerType !== "mouse";
    const z = this.zoneAt(e.clientX, e.clientY, { touch });
    this.pending = { x: e.clientX, y: e.clientY, t: performance.now(), touch, zone: z, id: e.pointerId };
    if (!touch && z) {
      e.preventDefault(); // a corner, not the start of a text selection
      try { (this.a.captureEl?.() || this.a.host()).setPointerCapture(e.pointerId); } catch {}
      return true;
    }
    return false;
  }

  /** Pointer moved while pressed. Returns true when the page is following it. */
  move(e) {
    const p = this.pending;
    if (!p) return false;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!this.drag) {
      if (p.blocked) return false;
      let dir, cornerName, soft = false;
      if (!p.touch && p.zone) {
        if (Math.hypot(dx, dy) < 3) return true;
        ({ dir, corner: cornerName } = p.zone);
        soft = !p.zone.nearCorner;
      } else if (p.touch) {
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2 || this.a.hasSelection?.()) return false;
        if (!this.a.enabled()) return false;
        dir = dx < 0 ? 1 : -1;
        const r = this.a.pageRect();
        cornerName = p.y > r.top + r.height * 0.55 ? "bottom" : "top";
        soft = true;
        if (!this.a.canTurn(dir)) { p.blocked = true; return false; }
      } else return false;
      const at = this.peek && this.peek.dir === dir ? [...this.peek.P] : null;
      this.unpeek(true);
      this.drag = this.#start(dir, cornerName, { at, soft });
      // touch: measure from here, so the page doesn't jump by the dead zone
      if (p.touch) { p.x = e.clientX; p.y = e.clientY; }
      try { (this.a.captureEl?.() || this.a.host()).setPointerCapture(e.pointerId); } catch {}
    }
    this.drag.curl.dragBy(e.clientX - p.x, e.clientY - p.y, { soft: this.drag.soft });
    return true;
  }

  /** Let the page go: it turns or lies back down; then the view is told. */
  async #settle(d, { vx, how = "drag" }) {
    this.settling = (this.settling || 0) + 1;
    try {
      await d.ready;
      if (d.curl.done) return;
      const commit = await d.curl.release({ vx: vx ?? d.curl.velocity, onDecide: (c) => { if (c) this.a.sound?.(d.dir); } });
      if (d.curl.done) return;
      if (commit) this.a.committed(d.dir, how);
      else await this.a.revert();
    } finally {
      d.curl.finish();
      this.settling--;
    }
  }

  /** Pointer released. Returns true when it was ours (a drag, or a click on a corner). */
  up(e) {
    const p = this.pending;
    this.pending = null;
    const d = this.drag;
    if (d) {
      this.drag = null;
      this.#settle(d, {});
      return true;
    }
    if (p && !p.touch && p.zone && e && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4) {
      // a click on the corner: turn it from there
      this.unpeek(true);
      this.a.turn?.(p.zone.dir, p.zone.corner);
      return true;
    }
    return false;
  }

  cancel() {
    this.pending = null;
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.settling = (this.settling || 0) + 1;
    d.ready.then(async () => { if (!d.curl.done) { await d.curl.settle(200); await this.a.revert(); } })
      .finally(() => { d.curl.finish(); this.settling--; });
  }

  /**
   * A two-finger swipe on a trackpad: the page follows the fingers, and
   * turns (or lies back) when they let go. Returns true when the wheel event was used.
   */
  wheel(e) {
    const now = performance.now();
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.1;
    if (!horizontal || e.deltaMode !== 0 || !this.a.enabled()) return false;
    if (now < this.quietUntil) { this.quietUntil = now + 160; return true; } // the tail of the last swipe
    let s = this.swipe;
    if (!s) {
      this.acc = (this.acc || 0) + e.deltaX;
      if (Math.abs(this.acc) < 6) return true;
      const dir = this.acc > 0 ? 1 : -1;
      this.acc = 0;
      if (!this.a.canTurn(dir)) { this.quietUntil = now + 160; return true; }
      this.unpeek(true);
      s = this.swipe = { ...this.#start(dir, "bottom", { how: "swipe", soft: true }), sum: 0 };
    }
    s.sum += e.deltaX;
    const k = 1.5;
    s.curl.dragBy(-s.sum * k, 0, { soft: true });
    clearTimeout(s.timer);
    if (s.curl.progress >= 0.985) { this.#endSwipe(); return true; }
    s.timer = setTimeout(() => this.#endSwipe(), 110);
    return true;
  }

  async #endSwipe() {
    const s = this.swipe;
    if (!s) return;
    this.swipe = null;
    clearTimeout(s.timer);
    this.quietUntil = performance.now() + 180;
    await this.#settle(s, { vx: s.curl.velocity * 0.8, how: "swipe" });
  }
}
