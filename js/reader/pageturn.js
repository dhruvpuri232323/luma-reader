// Page turns drawn over the book. The page on screen is held as a picture, the
// new page is put underneath, and the old one flips, curls, fades or flashes
// away. Book view (books set as text) and Page view (PDF pages) both use it.
import { el, bus } from "../core/util.js";
import { feelFor, playTurn } from "../core/bookfeel.js";
import { PageCurl, CurlHand } from "./pagecurl.js";

/** cloneNode(true), but canvases keep their pictures (cloneNode leaves them blank). */
export function copyOf(node) {
  const c = node.cloneNode(true);
  const from = node.querySelectorAll?.("canvas") || [];
  const to = c.querySelectorAll?.("canvas") || [];
  from.forEach((src, i) => { try { to[i].getContext("2d").drawImage(src, 0, 0); } catch { /* blank paper */ } });
  return c;
}

const face = (node, side) => {
  const f = el("div.turn-face", {}, node);
  if (side === "l") f.style.clipPath = "inset(0 50% 0 0)";
  else if (side === "r") f.style.clipPath = "inset(0 0 0 50%)";
  return f;
};

/**
 * Freeze what's on screen: `oldNode` (a picture of the page or spread) is laid
 * over `rect` (relative to `host`) straight away, so nothing flickers while the
 * new page is put in place underneath. Then call run().
 */
export function beginTurn(host, rect, oldNode) {
  host.__turn?.finish();
  const layer = el("div.turn-layer", {
    "aria-hidden": "true",
    style: { left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" },
  });
  layer.inert = true;
  const cover = face(oldNode);
  layer.append(cover);
  host.append(layer);
  const anims = [];
  let done = false;
  const api = {
    get active() { return !done; },
    finish() {
      if (done) return;
      done = true;
      for (const a of anims) { try { a.cancel(); } catch {} }
      layer.remove();
      if (host.__turn === api) host.__turn = null;
    },
    /** style: flip | curl | slide | fade | flash | none; spread: two pages side by side. */
    async run({ style, ms, dir = 1, spread = false, newNode = null, paper = "" }) {
      if (done) return;
      if (!ms || style === "none" || !layer.animate) return api.finish();
      const play = (node, frames, opts) => { const a = node.animate(frames, { duration: ms, fill: "forwards", ...opts }); anims.push(a); return a; };
      let main;
      if (style === "fade") {
        main = play(cover, [{ opacity: 1 }, { opacity: 0 }], { easing: "ease-out" });
      } else if (style === "slide") {
        main = play(cover, [{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${-dir * 38}%)`, opacity: 0 }], { easing: "cubic-bezier(.3,.6,.2,1)" });
      } else if (style === "flash") {
        // e-ink: the screen goes dark for a moment and comes back with the new page
        const fl = el("div.turn-flash");
        layer.append(fl);
        setTimeout(() => cover.remove(), ms * 0.42);
        main = play(fl, [{ opacity: 0 }, { opacity: 0.94, offset: 0.3 }, { opacity: 0.94, offset: 0.5 }, { opacity: 0 }], { easing: "linear" });
      } else {
        main = spread ? spreadLeaf(layer, cover, { style, ms, dir, newNode, play }) : singleLeaf(layer, cover, { style, ms, dir, newNode, paper, play });
      }
      try { await main.finished; } catch {}
      api.finish();
    },
  };
  host.__turn = api;
  return api;
}

const LEAF_EASE = { flip: "cubic-bezier(.55,.06,.32,1)", curl: "cubic-bezier(.36,.12,.24,1)" };

function leafFrames(style, from, to, dir) {
  if (style !== "curl") return [{ transform: `rotateY(${from}deg)` }, { transform: `rotateY(${to}deg)` }];
  // a paper page bends a little as it goes over
  const at = (k) => from + (to - from) * k;
  return [
    { transform: `rotateY(${from}deg)` },
    { transform: `rotateY(${at(0.2)}deg) skewY(${-dir * 1.6}deg) scaleX(.985)`, offset: 0.25 },
    { transform: `rotateY(${at(0.8)}deg) skewY(${dir * 1.1}deg) scaleX(.99)`, offset: 0.72 },
    { transform: `rotateY(${to}deg)` },
  ];
}

function decorate(leaf, { style, play }) {
  const shade = el("div.turn-shade");
  leaf.append(shade);
  play(shade, [{ opacity: 0 }, { opacity: 0.42, offset: 0.5 }, { opacity: 0.06 }], { easing: "ease-in-out" });
  if (style === "curl") {
    const gloss = el("div.turn-gloss");
    leaf.append(gloss);
    play(gloss, [{ backgroundPosition: "130% 0", opacity: 0.0 }, { opacity: 0.9, offset: 0.35 }, { backgroundPosition: "-30% 0", opacity: 0 }], { easing: "ease-in-out" });
  }
}

/** Two pages: the right page (forward) or left page (back) turns over the spine. */
function spreadLeaf(layer, cover, { style, ms, dir, newNode, play }) {
  const oldNode = cover.firstChild;
  cover.remove();
  const turnSide = dir > 0 ? "r" : "l";
  const restSide = dir > 0 ? "l" : "r";
  layer.append(face(copyOf(oldNode), restSide)); // stays until the leaf lands on it
  const cast = el("div.turn-cast." + turnSide);
  layer.append(cast);
  play(cast, [{ opacity: 0.0 }, { opacity: 0.5, offset: 0.25 }, { opacity: 0 }], { easing: "ease-out" });
  const back = face(newNode || el("div.turn-paper"), restSide);
  back.classList.add("back");
  const leaf = el("div.turn-leaf", { style: { transformOrigin: "50% 50%" } }, face(oldNode, turnSide), back);
  decorate(leaf, { style, play });
  layer.append(leaf);
  return play(leaf, leafFrames(style, 0, dir > 0 ? -180 : 180, dir), { easing: LEAF_EASE[style] || LEAF_EASE.flip });
}

/** One page: forward, the page lifts from the right and turns away to the left;
 *  back, the previous page turns in from the left and settles on top. */
function singleLeaf(layer, cover, { style, ms, dir, newNode, paper, play }) {
  const backPaper = (node) => {
    // the back of a page: blank paper, with the print showing through faintly
    const p = el("div.turn-paper", { style: paper ? { background: paper } : {} });
    if (node) { const ghost = copyOf(node); ghost.classList.add("turn-ghost"); p.append(ghost); }
    const f = face(p);
    f.classList.add("back");
    return f;
  };
  if (dir > 0) {
    const oldNode = cover.firstChild;
    cover.remove();
    const back = backPaper(oldNode);
    const leaf = el("div.turn-leaf", { style: { transformOrigin: "left center" } }, face(oldNode), back);
    decorate(leaf, { style, play });
    layer.append(leaf);
    play(back, [{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { easing: "linear" }); // it leaves the page, so let it go softly
    return play(leaf, leafFrames(style, 0, -180, dir), { easing: LEAF_EASE[style] || LEAF_EASE.flip });
  }
  const incoming = newNode || el("div.turn-paper");
  const leaf = el("div.turn-leaf", { style: { transformOrigin: "left center" } }, face(incoming), backPaper(incoming));
  decorate(leaf, { style, play });
  layer.append(leaf);
  return play(leaf, leafFrames(style, -180, 0, dir), { easing: LEAF_EASE[style] || LEAF_EASE.flip });
}

// ───────── Page view (PDF pages) ─────────

/** PDF pages on screen right now (in page-at-a-time modes, the page or spread). */
export function shownPages(tab) {
  const c = tab.container.getBoundingClientRect();
  return [...tab.container.querySelectorAll(".pdfViewer .page")].filter((p) => {
    const r = p.getBoundingClientRect();
    return r.width > 0 && r.bottom > c.top + 4 && r.top < c.bottom - 4 && r.right > c.left && r.left < c.right;
  });
}

export function unionRect(els) {
  const rs = els.map((e) => e.getBoundingClientRect());
  const left = Math.min(...rs.map((r) => r.left)), top = Math.min(...rs.map((r) => r.top));
  const right = Math.max(...rs.map((r) => r.right)), bottom = Math.max(...rs.map((r) => r.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** A picture of PDF pages, laid out in `box` (screen coordinates). */
export function pictureOf(pages, box, tone) {
  const pic = el("div.turn-pic", { style: { width: box.width + "px", height: box.height + "px" } });
  for (const p of pages) {
    const r = p.getBoundingClientRect();
    const src = p.querySelector("canvas");
    const sheet = el("div.turn-pdfpage", { style: { left: r.left - box.left + "px", top: r.top - box.top + "px", width: r.width + "px", height: r.height + "px" } });
    if (src && src.width) {
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      try { c.getContext("2d").drawImage(src, 0, 0); } catch { /* tainted or lost: blank paper */ }
      sheet.append(c);
    }
    if (tone) sheet.append(el("div.turn-tone"));
    pic.append(sheet);
  }
  return pic;
}

/** Wait (briefly) until the pages now on screen have been drawn. */
export async function pagesDrawn(tab, max = 450) {
  const t0 = performance.now();
  while (performance.now() - t0 < max) {
    await new Promise((r) => requestAnimationFrame(r));
    const ps = shownPages(tab);
    const ready = ps.length && ps.every((p) => {
      const n = Number(p.dataset.pageNumber);
      const v = tab.viewer?.getPageView?.(n - 1);
      return v ? v.renderingState === 3 : Boolean(p.querySelector("canvas"));
    });
    if (ready) return;
  }
}

/** Turn a page in Page view, with the book's own animation and sound. */
export async function turnPdf(tab, dir, apply, { auto = false } = {}) {
  const v = tab.viewer;
  if (!v) return;
  const before = v.currentPageNumber;
  if ((dir > 0 && before >= v.pagesCount) || (dir < 0 && before <= 1)) return apply();
  const f = feelFor(tab.doc);
  playTurn(f.sound, { dir, volume: f.volume * (auto ? 0.45 : 1) });
  const pages = shownPages(tab);
  if (f.turn === "none" || !pages.length || !tab.el.animate) return apply();
  if (tab.hand?.busy || tab.turnPending) return;
  const host = tab.el.getBoundingClientRect();
  const box = unionRect(pages);
  const tone = tab.el.classList.contains("feel-tone");
  if (f.turn === "curl") {
    // the page taken by its corner and laid over (see pagecurl.js)
    tab.hand?.unpeek(true);
    const rect = { left: box.left - host.left, top: box.top - host.top, width: box.width, height: box.height };
    const curl = new PageCurl(tab.el, rect, { dir, spread: pages.length === 2, oldNode: pictureOf(pages, box, tone), copy: copyOf, stiffness: f.stiffness || 1 });
    tab.turnPending = true;
    apply();
    try {
      if (v.currentPageNumber === before) { curl.finish(); return; }
      await pagesDrawn(tab);
    } finally { tab.turnPending = false; }
    if (curl.done) return;
    const now = shownPages(tab);
    if (now.length !== pages.length) { curl.finish(); bus.emit("tab-page", tab); return; } // a cover page on its own: no leaf to turn
    curl.ready(pictureOf(now, box, tone));
    await curl.play(f.ms);
    curl.finish();
    bus.emit("tab-page", tab);
    return;
  }
  const turn = beginTurn(tab.el, { left: box.left - host.left, top: box.top - host.top, width: box.width, height: box.height }, pictureOf(pages, box, tone));
  apply();
  if (v.currentPageNumber === before) { turn.finish(); return; }
  await pagesDrawn(tab);
  if (!turn.active) return;
  const now = shownPages(tab);
  const spread = pages.length === 2 && now.length === 2;
  const paper = getComputedStyle(tab.el).getPropertyValue("--pdf-tone").trim() || "#fff";
  await turn.run({ style: f.turn, ms: f.ms, dir, spread, newNode: pictureOf(now, now.length ? unionRect(now) : box, tone), paper });
  bus.emit("tab-page", tab);
}

/** Taking Page view's pages by hand (one page or two at a time). */
export function pdfHand(tab) {
  let box = null, before = 0;
  const tone = () => tab.el.classList.contains("feel-tone");
  return new CurlHand({
    host: () => tab.el,
    captureEl: () => tab.container,
    pageRect: () => { const ps = shownPages(tab); return ps.length ? unionRect(ps) : null; },
    spread: () => shownPages(tab).length === 2,
    enabled: () => tab.paged && feelFor(tab.doc).turn === "curl" && !tab.el.classList.contains("zoomed") && !tab.turnPending,
    canTurn: (dir) => {
      const v = tab.viewer;
      const ns = shownPages(tab).map((p) => Number(p.dataset.pageNumber));
      if (!v || !ns.length) return false;
      return dir > 0 ? Math.max(...ns) < v.pagesCount : Math.min(...ns) > 1;
    },
    snapshot: () => { const ps = shownPages(tab); box = unionRect(ps); return pictureOf(ps, box, tone()); },
    begin: async (dir) => {
      const v = tab.viewer;
      before = v.currentPageNumber;
      bus.emit("user-nav", tab);
      tab.turnPending = true;
      try { if (dir > 0) v.nextPage(); else v.previousPage(); await pagesDrawn(tab); } finally { tab.turnPending = false; }
    },
    fresh: () => pictureOf(shownPages(tab), box, tone()),
    revert: async () => { tab.viewer.currentPageNumber = before; await pagesDrawn(tab); },
    sound: (dir) => { const f = feelFor(tab.doc); playTurn(f.sound, { dir, volume: f.volume }); },
    committed: () => bus.emit("tab-page", tab),
    stiffness: () => feelFor(tab.doc).stiffness || 1,
    copy: copyOf,
    hotWidth: () => 60,
    hasSelection: () => Boolean(document.getSelection()?.toString()),
    turn: (dir) => (dir > 0 ? tab.next() : tab.prev()),
  });
}
