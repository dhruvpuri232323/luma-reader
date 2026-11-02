// Auto-scroll: the page moves on by itself at your reading speed, like a
// teleprompter — a smooth glide in Page view and continuous Book view, or page
// turns timed to how fast you read in paged Book view. Touching the page holds
// it for a moment; speed is adjustable while it runs.
import { el, bus, clamp, setKids } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { wordCount } from "./bookmodel.js";

const KEY = "luma.autoWpm";

export class AutoScroll {
  constructor(root) {
    this.root = root;
    this.tab = null;
    this.on = false;
    this.paused = false;
    this.holdUntil = 0;
    this.wpm = clamp(Number(localStorage.getItem(KEY)) || Number(localStorage.getItem("luma.wpm")) || 230, 60, 900);
    this.acc = 0;
    this.pxPerWord = new Map();
    this.bar = null;
    const hold = () => { if (this.on) this.holdUntil = performance.now() + 2500; };
    root.addEventListener("wheel", hold, { passive: true });
    root.addEventListener("touchstart", hold, { passive: true });
    root.addEventListener("keydown", hold);
    bus.on("user-nav", hold);
  }

  start(tab) {
    if (!tab || tab.state !== "ready") return;
    this.stop();
    this.tab = tab;
    this.on = true;
    this.paused = false;
    this.last = performance.now();
    this.turnAt = 0;
    this.#renderBar();
    this.raf = requestAnimationFrame((t) => this.#tick(t));
  }

  stop() {
    this.on = false;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.turnTimer);
    this.bar?.remove();
    this.bar = null;
    this.root.classList.remove("autoscrolling");
  }

  toggle(tab) { this.on ? this.stop() : this.start(tab); }

  setWpm(w) {
    this.wpm = clamp(Math.round(w / 10) * 10, 60, 900);
    localStorage.setItem(KEY, String(this.wpm));
    this.turnAt = 0;
    this.#renderBar();
  }

  #tick(now) {
    if (!this.on) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const tab = this.tab;
    if (!tab || tab.state !== "ready" || !tab.el.classList.contains("active")) { this.stop(); return; }
    if (!this.paused && now > this.holdUntil) {
      if ((tab.mode === "book" && tab.book && !tab.book.scroll) || tab.paged) this.#paged(now);
      else this.#glide(dt);
    }
    this.raf = requestAnimationFrame((t) => this.#tick(t));
  }

  /** Continuous scrolling: pixels per second from words per pixel on screen. */
  #glide(dt) {
    const tab = this.tab;
    const box = tab.mode === "book" ? tab.book.clip : tab.container;
    const ppw = this.#pixelsPerWord();
    if (!ppw) return;
    this.acc += (this.wpm / 60) * ppw * dt;
    if (this.acc >= 1) {
      const step = Math.floor(this.acc);
      this.acc -= step;
      const before = box.scrollTop;
      box.scrollTop += step;
      if (box.scrollTop === before && box.scrollTop + box.clientHeight >= box.scrollHeight - 2) { this.stop(); bus.emit("toast", "Auto-scroll reached the end"); }
    }
  }

  #pixelsPerWord() {
    const tab = this.tab;
    if (tab.mode === "book") {
      const flow = tab.book.flow;
      const key = `b${flow.childElementCount}:${flow.scrollHeight}`;
      if (!this.pxPerWord.has(key)) {
        const words = wordCount(flow.textContent || "");
        const h = flow.scrollHeight - window.innerHeight * 0.4; // minus the padding at the end
        this.pxPerWord.set(key, words ? Math.max(1, h / words) : 0);
      }
      return this.pxPerWord.get(key);
    }
    const page = tab.currentPage();
    const key = `p${page}:${tab.viewer?.currentScale}`;
    if (!this.pxPerWord.has(key)) {
      this.pxPerWord.set(key, 0);
      tab.text(page).then((t) => {
        const div = tab.viewer?.getPageView(page - 1)?.div;
        const words = wordCount(t || "");
        this.pxPerWord.set(key, div && words > 20 ? div.offsetHeight / words : div ? div.offsetHeight / 180 : 0);
      });
    }
    return this.pxPerWord.get(key);
  }

  /** Words on the PDF page(s) on screen, for Page view's page-at-a-time layouts. */
  #pdfWords() {
    const tab = this.tab;
    const p = tab.currentPage();
    const n = tab.viewer?.spreadMode ? 2 : 1;
    this.pageWords ||= new Map();
    let total = 0;
    for (let i = 0; i < n; i++) {
      const pg = p + i;
      if (pg > tab.pages) break;
      if (!this.pageWords.has(pg)) { this.pageWords.set(pg, 260); tab.text(pg).then((t) => this.pageWords.set(pg, Math.max(40, wordCount(t || "")))); }
      total += this.pageWords.get(pg);
    }
    return total;
  }

  /** Turn the page (Book view, or Page view a page at a time) when you'd have read what's on screen. */
  #paged(now) {
    const tab = this.tab;
    const book = tab.mode === "book" ? tab.book : null;
    if (!this.turnAt) {
      const words = book ? book.visibleWords() : this.#pdfWords();
      this.turnAt = now + Math.max(4000, (words / this.wpm) * 60000);
      this.turnStart = now;
    }
    if (this.bar) this.bar.style.setProperty("--p", clamp((now - this.turnStart) / (this.turnAt - this.turnStart), 0, 1));
    if (now >= this.turnAt) {
      this.turnAt = 0;
      const atEnd = book ? book.atEnd : tab.viewer.currentPageNumber >= tab.viewer.pagesCount;
      if (atEnd) { this.stop(); return; }
      tab.next({ auto: true });
    }
  }

  #renderBar() {
    if (!this.on) return;
    if (!this.bar) {
      this.bar = el("div.autoscroll", { role: "region", "aria-label": "Auto-scroll" });
      this.root.append(this.bar);
      this.root.classList.add("autoscrolling");
    }
    setKids(this.bar,
      el("span.as-label", {}, icon("down", 16), "Auto-scroll"),
      el("button.icon-btn.sm", { "aria-label": "Slower", title: "Slower", onclick: () => this.setWpm(this.wpm - 20) }, "−"),
      el("span.as-wpm", { title: "Words per minute" }, `${this.wpm} wpm`),
      el("button.icon-btn.sm", { "aria-label": "Faster", title: "Faster", onclick: () => this.setWpm(this.wpm + 20) }, "+"),
      el("button.icon-btn.sm", { "aria-label": this.paused ? "Resume" : "Pause", title: this.paused ? "Resume" : "Pause", onclick: () => { this.paused = !this.paused; this.turnAt = 0; this.#renderBar(); } }, icon(this.paused ? "play" : "pause", 16)),
      el("button.icon-btn.sm", { "aria-label": "Stop auto-scroll", title: "Stop", onclick: () => this.stop() }, icon("x", 16)));
  }
}
