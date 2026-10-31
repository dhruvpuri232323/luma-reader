// End-to-end test of Luma Reader in real Chromium (laptop + phone viewports):
// Page view, Book view, typography, dictionary fallbacks, highlights, listening
// (device voice and the natural-voice pipeline with a stand-in model), words,
// notes, settings, and two-device sync through an in-memory stand-in for Firestore.
//
//   npm install && npx playwright install chromium
//   npm start            (in another terminal)
//   npm test
//
// BASE_URL defaults to http://localhost:5173/

const pw = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const { chromium, devices } = pw.default || pw;
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = (f) => join(here, "fixtures", f);
const OUT = join(here, "output");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE_URL || "http://localhost:5173/";

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; };
const shot = (page, name) => page.screenshot({ path: join(OUT, name + ".png") });
const within = (p, ms = 6000) => p.then(() => true, () => false);

// ── stand-ins for the web services ──
const NOT_IN_DICTIONARY = new Set(["sesquipedalian", "lamplighter"]);
const RARE = new Set(["sesquipedalian", "perspicacious", "obsequious", "ephemeral", "perspicacity"]);
const ARTICLE = `Title: The Art of Slow Reading

URL Source: https://example.com/slow-reading

Markdown Content:
# The Art of Slow Reading

Reading slowly is not a failure of speed. It is a decision to let a sentence finish its work before the next one begins.

When we read slowly we notice the hinges of an argument, the places where a writer turns, and the words that carry more weight than their neighbours.

## A practice

Choose one page a day and read it twice: once for the sense, and once for the sound.`;
const dictionary = (w) => [{
  word: w, phonetic: `/${w}/`, phonetics: [{ text: `/${w}/` }],
  meanings: [{ partOfSpeech: "adjective", definitions: [{ definition: `Test meaning of ${w}.`, example: `A ${w} example.`, synonyms: ["bright"], antonyms: [] }], synonyms: ["radiant"], antonyms: ["dim"] }],
}];
async function routeServices(ctx) {
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ctx.route(/api\.dictionaryapi\.dev/, (r) => {
    const w = decodeURIComponent(r.request().url().split("/").pop());
    if (NOT_IN_DICTIONARY.has(w)) return r.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dictionary(w)) });
  });
  await ctx.route(/en\.wiktionary\.org/, (r) => {
    if (/sesquipedalian/.test(r.request().url())) {
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        en: [{ partOfSpeech: "Adjective", language: "English", definitions: [{ definition: "<b>Given</b> to the use of long words.", examples: ["a <i>sesquipedalian</i> lecturer"] }] }],
      }) });
    }
    r.fulfill({ status: 404, body: "{}" });
  });
  await ctx.route(/en\.wikipedia\.org/, (r) => {
    if (/Adam_Smith/.test(r.request().url())) {
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        type: "standard", title: "Adam Smith", description: "Scottish economist and philosopher (1723–1790)",
        extract: "Adam Smith was a Scottish economist and philosopher who was a pioneer in political economy.",
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Adam_Smith" } },
      }) });
    }
    r.fulfill({ status: 404, body: "{}" });
  });
  await ctx.route(/api\.datamuse\.com/, (r) => {
    const url = r.request().url();
    const sug = /\/sug/.test(url);
    if (/md=f/.test(url)) {
      const w = new URL(url).searchParams.get("sp");
      const f = RARE.has(w) ? 0.08 : 60;
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ word: w, score: 1, tags: [`f:${f}`] }]) });
    }
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sug ? [{ word: "lamplight" }, { word: "lamplighters" }] : []) });
  });
  await ctx.route(/r\.jina\.ai/, (r) => r.request().method() === "OPTIONS" ? r.fulfill({ status: 204, headers: cors }) : r.fulfill({ status: 200, headers: cors, contentType: "text/plain", body: ARTICLE }));
  await ctx.route(/www\.googleapis\.com\/(upload\/)?drive\/v3/, fakeDrive);
}

// ── a fake Google Drive shared by all devices ──
const driveFiles = new Map();
let driveSeq = 0;
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS", "access-control-expose-headers": "Location, Content-Length" };
function parseMultipart(buf, boundary) {
  const parts = [];
  const sep = Buffer.from("--" + boundary);
  let at = buf.indexOf(sep);
  while (at >= 0) {
    const next = buf.indexOf(sep, at + sep.length);
    if (next < 0) break;
    const chunk = buf.subarray(at + sep.length + 2, next - 2);
    const split = chunk.indexOf("\r\n\r\n");
    parts.push({ head: chunk.subarray(0, split).toString(), body: chunk.subarray(split + 4) });
    at = next;
  }
  return parts;
}
async function fakeDrive(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  if (!/Bearer /.test(req.headers().authorization || "")) return route.fulfill({ status: 401, headers: cors, body: "{}" });
  const url = new URL(req.url());
  const path = url.pathname.replace(/^\/(upload\/)?drive\/v3/, "");
  const json = (o, status = 200) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(o) });
  const meta = ({ data, ...m }) => m;
  if (path === "/about") return json({ user: { emailAddress: "reader@example.com" } });
  if (path === "/files" && req.method() === "GET") {
    const q = url.searchParams.get("q") || "";
    let list = [...driveFiles.values()];
    if (/value='folder'/.test(q)) list = list.filter((f) => f.appProperties?.luma === "folder");
    if (/value='sync'/.test(q)) list = list.filter((f) => f.appProperties?.luma === "sync");
    const parent = q.match(/'([^']+)' in parents/);
    if (parent) list = list.filter((f) => f.parents?.includes(parent[1]));
    return json({ files: list.map(meta) });
  }
  if (path === "/files" && req.method() === "POST") {
    const id = "f" + ++driveSeq;
    const type = url.searchParams.get("uploadType");
    if (!type) { driveFiles.set(id, { id, ...JSON.parse(req.postData()) }); return json({ id }); }
    const boundary = (req.headers()["content-type"] || "").split("boundary=")[1];
    const [m, body] = parseMultipart(req.postDataBuffer(), boundary);
    driveFiles.set(id, { id, ...JSON.parse(m.body.toString()), data: Buffer.from(body.body), modifiedTime: new Date().toISOString() });
    return json({ id, modifiedTime: new Date().toISOString() });
  }
  const m = path.match(/^\/files\/([^/]+)$/);
  if (m && driveFiles.has(m[1])) {
    const f = driveFiles.get(m[1]);
    if (req.method() === "GET" && url.searchParams.get("alt") === "media") return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/octet-stream", "content-length": String(f.data.length) }, body: f.data });
    if (req.method() === "PATCH") { f.data = req.postDataBuffer(); f.modifiedTime = new Date().toISOString(); return json({ id: f.id }); }
  }
  return json({ error: { message: "not found" } }, 404);
}

// ── a tiny fake "cloud" shared by both devices ──
const cloud = { seq: 0, rows: [] };
function cloudWrite(coll, rec) {
  cloud.rows = cloud.rows.filter((r) => !(r.coll === coll && r.rec.id === rec.id));
  cloud.rows.push({ coll, rec, seq: ++cloud.seq });
}
const cloudPull = (coll, since) => ({ seq: cloud.seq, recs: cloud.rows.filter((r) => r.coll === coll && r.seq > since).map((r) => r.rec) });

const initScript = ({ kokoroUrl }) => {
  // Firebase stand-in
  const user = { uid: "test-user", name: "Test Reader", email: "reader@example.com" };
  let authCb;
  let signedIn = localStorage.getItem("test.signedIn") === "1";
  window.__LUMA_TEST_ADAPTER__ = {
    name: "test", cloudPdfs: false,
    onAuth(cb) { authCb = cb; setTimeout(() => cb(signedIn ? user : null), 0); return () => {}; },
    async signIn() { signedIn = true; localStorage.setItem("test.signedIn", "1"); authCb(user); },
    async signOut() { signedIn = false; localStorage.removeItem("test.signedIn"); authCb(null); },
    listen(uid, coll, onRecords) {
      let since = 0, alive = true;
      const tick = async () => {
        if (!alive) return;
        const { seq, recs } = await window.cloudPull(coll, since);
        since = seq;
        await onRecords(recs, { fromCache: false });
        setTimeout(tick, 250);
      };
      tick();
      return () => { alive = false; };
    },
    write: (uid, coll, rec) => window.cloudWrite(coll, rec),
  };
  // Google sign-in stand-in for Drive
  window.__LUMA_TEST_GIS__ = { accounts: { oauth2: {
    initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: "test-token", expires_in: 3600 }), 20) }),
    revoke: (t, cb) => cb?.(),
  } } };
  // Natural-voice model stand-in
  window.__LUMA_KOKORO_URLS__ = [kokoroUrl];
  // Device voices stand-in (headless browsers have none)
  window.__spoken = [];
  const voices = [
    { name: "Microsoft David - English (United States)", lang: "en-US", voiceURI: "ms-david", localService: true, default: true },
    { name: "Google UK English Female", lang: "en-GB", voiceURI: "g-uk-f", localService: false, default: false },
  ];
  const synth = {
    speaking: false, pending: false, paused: false, q: [],
    getVoices: () => voices,
    speak(u) { this.q.push(u); this.next(); },
    next() {
      if (this.speaking || !this.q.length) return;
      const u = this.q.shift();
      this.speaking = true;
      window.__spoken.push({ text: u.text, voice: u.voice?.name, pitch: u.pitch });
      this.cur = setTimeout(() => { this.speaking = false; u.onend?.(); this.next(); }, 260);
    },
    cancel() { clearTimeout(this.cur); this.speaking = false; this.q = []; },
    pause() {}, resume() {}, addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
};

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const pages = [];
const crash = async (e) => {
  console.error("✗ CRASH:", String(e?.message || e).split("\n").slice(0, 6).join("\n"));
  for (const pg of pages) { console.error(pg.device, "errors:", pg.errors); await shot(pg, "crash-" + pg.device).catch(() => {}); }
  process.exit(1);
};
process.on("unhandledRejection", crash);
process.on("uncaughtException", crash);

async function newDevice(name, opts = {}) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block", acceptDownloads: true });
  await routeServices(ctx);
  await ctx.exposeFunction("cloudWrite", cloudWrite);
  await ctx.exposeFunction("cloudPull", cloudPull);
  await ctx.addInitScript(initScript, { kokoroUrl: new URL("tests/fixtures/fake-kokoro.js", BASE).href });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message + " @ " + String(e.stack || "").split("\n").slice(1, 3).map((x) => x.trim()).join(" ← ")));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  page.device = name;
  pages.push(page);
  return page;
}

async function pointAtWord(page, word, pageNo = 1) {
  return page.evaluate(({ word, pageNo }) => {
    const spans = [...document.querySelectorAll(`.tab-pane.active .page[data-page-number="${pageNo}"] .textLayer span`)];
    for (const s of spans) {
      const t = s.firstChild;
      if (!t || t.nodeType !== 3) continue;
      const i = t.data.indexOf(word);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(t, i); r.setEnd(t, i + word.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + Math.min(6, b.width / 2), y: b.top + b.height / 2 };
    }
    return null;
  }, { word, pageNo });
}

/** A word on the visible Book view spread. */
async function bookWord(page, word) {
  return page.evaluate((word) => {
    const clip = document.querySelector(".tab-pane.active .bk-clip").getBoundingClientRect();
    const w = document.createTreeWalker(document.querySelector(".tab-pane.active .bk-flow"), NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      let i = n.data.indexOf(word);
      while (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + word.length);
        const b = r.getClientRects()[0];
        if (b && b.left >= clip.left && b.right <= clip.right && b.top >= clip.top && b.bottom <= clip.bottom) hits.push({ x: b.left + Math.min(6, b.width / 2), y: b.top + b.height / 2 });
        i = n.data.indexOf(word, i + 1);
      }
    }
    // prefer an occurrence away from the page edges
    const mid = (clip.left + clip.right) / 2;
    const midY = clip.top + clip.height * 0.4;
    return hits.sort((a, b) => Math.abs(a.x - mid) + Math.abs(a.y - midY) * 0.5 - (Math.abs(b.x - mid) + Math.abs(b.y - midY) * 0.5))[0] || null;
  }, word);
}

async function hover(page, p) {
  await page.mouse.move(p.x - 30, p.y - 30);
  await page.mouse.move(p.x, p.y);
  await page.mouse.move(p.x + 1, p.y);
}

async function selectText(page, from, to, pageNo = 1) {
  return page.evaluate(({ from, to, pageNo }) => {
    const spans = [...document.querySelectorAll(`.tab-pane.active .page[data-page-number="${pageNo}"] .textLayer span`)];
    const find = (w) => { for (const s of spans) { const t = s.firstChild; if (t?.nodeType === 3 && t.data.includes(w)) return [t, t.data.indexOf(w)]; } };
    const [a, ai] = find(from); const [b, bi] = find(to);
    const r = document.createRange();
    r.setStart(a, ai); r.setEnd(b, bi + to.length);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    return sel.toString();
  }, { from, to, pageNo });
}

const page = await newDevice("laptop", { viewport: { width: 1440, height: 900 } });
const laptop = page;

// ═════════════ Library & layout ═════════════
await laptop.goto(BASE);
await laptop.waitForSelector("#view-library .view-head h1");
ok(await laptop.locator("#view-library .empty h2").isVisible(), "empty library invites the first import");
const centred = await laptop.evaluate(() => {
  const v = document.querySelector("#view-library").getBoundingClientRect();
  const main = document.querySelector(".views").getBoundingClientRect();
  return Math.abs((v.left - main.left) - (main.right - v.right)) < 3;
});
ok(centred, "library is centred on a wide screen");
await laptop.setInputFiles("#file-input", [FIX("lamplighter.pdf"), FIX("companion.pdf"), FIX("novel.pdf")]);
await laptop.waitForFunction(() => document.querySelectorAll(".book").length === 3);
ok(true, "imports three PDFs");
await laptop.setInputFiles("#file-input", [FIX("lamplighter.pdf")]);
await laptop.waitForSelector(".toast:has-text('already in your library')");
ok(await laptop.locator(".book").count() === 3, "duplicate PDF is detected by its fingerprint");
await shot(laptop, "01-library");

// ═════════════ Page view ═════════════
// two books share a title (their PDF metadata), so pick them by page count
const twelve = await laptop.evaluate(async () => {
  const req = indexedDB.open("luma-reader");
  const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
  const docs = await new Promise((r) => { const q = db.transaction("docs").objectStore("docs").getAll(); q.onsuccess = () => r(q.result); });
  return Object.fromEntries(docs.map((d) => [d.pages, d.id]));
});
await laptop.goto(BASE + `#/read/${twelve[12]}`);
await laptop.waitForSelector(".tab-pane.active .page[data-page-number='1'] .textLayer span", { state: "attached" });
await laptop.waitForTimeout(400);
ok(await laptop.locator(".reader-bottom .page-box").textContent() === "of 12", "reader opens in Page view with the page count");
ok(await laptop.locator(".mode-seg button.on").textContent() === "Page", "Page / Book switch is in the top bar");

await laptop.evaluate(() => document.querySelector(".tab-pane.active .page[data-page-number='2']").scrollIntoView());
await laptop.waitForSelector(".tab-pane.active .page[data-page-number='2'] .textLayer span", { state: "attached" });
let p = await pointAtWord(laptop, "luminous", 2);
await hover(laptop, p);
await laptop.waitForSelector(".defcard .def-body", { timeout: 5000 });
ok((await laptop.locator(".def-word").textContent()) === "luminous", "hovering a word shows its definition");
await laptop.locator(".def-save").click();
await laptop.waitForSelector(".def-save.on");
ok(true, "one click saves the word");
await laptop.mouse.move(5, 500);
await laptop.waitForTimeout(600);
await laptop.evaluate(() => document.querySelector(".tab-pane.active .page[data-page-number='1']").scrollIntoView());
await laptop.waitForTimeout(300);

await selectText(laptop, "Critics", "chapter.");
await laptop.waitForSelector(".selbar.in");
await laptop.locator(".selbar-color").nth(1).click();
await laptop.waitForSelector(".page[data-page-number='1'] .hl[data-color='mint']");
ok(true, "highlight drawn on the original page");
await selectText(laptop, "ephemeral", "outlast");
await laptop.waitForSelector(".selbar.in");
await laptop.locator(".selbar-btn", { hasText: "Note" }).click();
await laptop.locator("dialog textarea").fill("Write ideas down immediately.");
await laptop.locator("dialog .btn.primary").click();
await laptop.waitForSelector(".page[data-page-number='1'] .hl.has-note");
ok(true, "note saved with its highlight");
await laptop.keyboard.press("b");
await laptop.waitForSelector('.reader-actions [data-action="bookmark"].on');
ok(true, "B bookmarks the page");
await laptop.locator('[data-action="toc"]').click();
await laptop.waitForSelector(".toc-item");
await laptop.locator(".toc-item", { hasText: "The Committee" }).click();
await laptop.waitForFunction(() => document.querySelector(".reader-bottom .page-input")?.value === "7");
ok(true, "contents jumps to the chapter");
await laptop.locator(".seg button", { hasText: "Notes" }).click();
ok(/narrator had warned/.test(await laptop.locator(".side-panel .note-item").first().textContent()), "notes panel keeps spaces across line breaks");
await laptop.keyboard.press("Control+f");
await laptop.locator(".side-panel .search-input").fill("perspicacious");
await laptop.keyboard.press("Enter");
await laptop.waitForFunction(() => /matches/.test(document.querySelector(".search-results")?.textContent || ""));
ok(true, "search lists matches");
await laptop.locator(".side-panel .panel-head .icon-btn").click();

// ═════════════ Book view ═════════════
await laptop.goto(BASE + `#/read/${twelve[10]}`);
await laptop.waitForSelector(".tab-pane.active .textLayer span", { state: "attached" });
await laptop.locator(".mode-seg button", { hasText: "Book" }).click();
await laptop.waitForSelector(".tab-pane.active .bk-flow .bk-b");
await laptop.waitForTimeout(400);
ok(await laptop.locator(".tab-pane.active .bookview.spread").count() === 1, "Book view shows a two-page spread on a laptop");
ok(await laptop.locator(".tab-pane.active .bk-flow h2", { hasText: "One: Dusk" }).count() === 1, "chapter headings are detected");
const runningHeader = await laptop.locator(".tab-pane.active .bk-flow").textContent();
ok(!runningHeader.includes("The Lamplighter's Notebook"), "the PDF's own running header is removed from the text");
await shot(laptop, "02-book-spread");
const before = await laptop.evaluate(() => window.__luma.reader.tabs.get(window.__luma.reader.active).book.spread);
await laptop.keyboard.press("ArrowRight");
await laptop.waitForTimeout(600);
const after = await laptop.evaluate(() => window.__luma.reader.tabs.get(window.__luma.reader.active).book.spread);
ok(after === before + 1, "arrow key turns the page");
ok(/left in (chapter|book)/.test(await laptop.locator(".tab-pane.active .bk-foot").textContent()), "footer shows time left");

// typography
const fontBefore = await laptop.evaluate(() => getComputedStyle(document.querySelector(".tab-pane.active .bk-flow")).fontFamily);
await laptop.locator('[data-action="type"]').click();
await laptop.locator(".typo-pop .font-opt", { hasText: "EB Garamond" }).click();
await laptop.waitForFunction(() => /EB Garamond/.test(getComputedStyle(document.querySelector(".tab-pane.active .bk-flow")).fontFamily));
ok(true, `changing the typeface changes the book text (${fontBefore.split(",")[0]} → EB Garamond)`);
const sizeBefore = await laptop.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".tab-pane.active .bk-flow")).fontSize));
await laptop.locator('.typo-pop [aria-label="More text size"]').click();
await laptop.locator('.typo-pop [aria-label="More text size"]').click();
await laptop.waitForFunction((s) => parseFloat(getComputedStyle(document.querySelector(".tab-pane.active .bk-flow")).fontSize) > s, sizeBefore);
ok(true, "text size buttons resize the book text");
await shot(laptop, "03-book-typography");
await laptop.keyboard.press("Escape");
await laptop.mouse.click(5, 500);

// dictionary in Book view, with fallbacks
await laptop.evaluate(() => window.__luma.reader.tabs.get(window.__luma.reader.active).book.goToPage(1, { animate: false }));
await laptop.waitForTimeout(400);
p = await bookWord(laptop, "perspicacious");
await hover(laptop, p);
await laptop.waitForSelector(".defcard .def-body", { timeout: 5000 });
ok((await laptop.locator(".def-word").textContent()) === "perspicacious", "hover works in Book view");
await laptop.mouse.move(5, 500); await laptop.waitForTimeout(500);
p = await bookWord(laptop, "Adam");
await hover(laptop, p);
await laptop.waitForSelector(".defcard .def-src", { timeout: 5000 });
ok(/Wikipedia/.test(await laptop.locator(".def-src").textContent()) && (await laptop.locator(".def-word").textContent()) === "Adam Smith", "names are looked up on Wikipedia (Adam Smith)");
await shot(laptop, "04-wikipedia-card");
await laptop.mouse.move(5, 500); await laptop.waitForTimeout(500);
for (let k = 0; k < 6 && !(await bookWord(laptop, "sesquipedalian")); k++) { await laptop.keyboard.press("ArrowRight"); await laptop.waitForTimeout(450); }
p = await bookWord(laptop, "sesquipedalian");
ok(Boolean(p), "found a rare word in the book");
await hover(laptop, p);
await laptop.waitForSelector(".defcard .def-src", { timeout: 5000 });
ok(/Wiktionary/.test(await laptop.locator(".def-src").textContent()), "words missing from the dictionary come from Wiktionary");
ok(await laptop.locator(".defcard .def-google").count() === 1, "every card has a Search Google button");
await laptop.mouse.move(5, 500); await laptop.waitForTimeout(500);

// unknown word → add your own meaning
const sel = await laptop.evaluate(() => {
  const w = document.createTreeWalker(document.querySelector(".tab-pane.active .bk-flow"), NodeFilter.SHOW_TEXT);
  const clip = document.querySelector(".tab-pane.active .bk-clip").getBoundingClientRect();
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf("lamplighter");
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 11);
    const b = r.getClientRects()[0];
    if (!b || b.left < clip.left || b.right > clip.right) continue;
    getSelection().removeAllRanges(); getSelection().addRange(r);
    return true;
  }
  return false;
});
ok(sel, "selected a word in Book view");
await laptop.waitForSelector(".selbar.in");
await laptop.locator(".selbar-btn", { hasText: "Define" }).click();
await laptop.waitForSelector(".def-own textarea");
ok(/lamplight/.test(await laptop.locator(".def-sugg").textContent()), "unknown words get 'did you mean' suggestions");
await laptop.locator(".def-own textarea").fill("A person who lit street lamps by hand.");
await laptop.locator(".def-own .btn").click();
await laptop.waitForSelector(".def-mine");
ok(true, "an unknown word can be added with your own meaning");
await shot(laptop, "05-add-own-meaning");
await laptop.keyboard.press("Escape");

// highlight in Book view → also appears in Page view
await laptop.evaluate(() => window.__luma.reader.tabs.get(window.__luma.reader.active).book.goToPage(1, { animate: false }));
await laptop.waitForTimeout(300);
await laptop.evaluate(() => {
  const p = document.querySelector('.tab-pane.active .bk-flow p[data-page="1"]');
  const t = p.firstChild; const i = t.data.indexOf("Adam Smith had argued");
  const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + "Adam Smith had argued".length);
  getSelection().removeAllRanges(); getSelection().addRange(r);
});
await laptop.waitForSelector(".selbar.in");
ok(await laptop.locator(".selbar-color").count() === 4, "highlight colours available in Book view");
await laptop.locator(".selbar-color").nth(2).click();
await laptop.waitForFunction(() => CSS.highlights.has("luma-sky"));
ok(true, "Book view highlight drawn");
await laptop.locator(".mode-seg button", { hasText: "Page" }).click();
await laptop.waitForSelector(".tab-pane.active .page[data-page-number='1'] .hl[data-color='sky']", { timeout: 8000 }).then(() => ok(true, "the same highlight appears on the original page"), () => ok(false, "the same highlight appears on the original page"));
await laptop.locator(".mode-seg button", { hasText: "Book" }).click();
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b");
ok(await laptop.evaluate(() => CSS.highlights.has("luma-vocab")), "saved words are underlined while reading");

// ═════════════ Listening ═════════════
await laptop.locator('[data-action="headphones"]').click();
await laptop.waitForSelector(".voice-dialog");
await shot(laptop, "06-choose-voice");
await laptop.locator(".voice-option").nth(1).click();
await laptop.waitForSelector(".player");
await laptop.waitForFunction(() => window.__spoken.length >= 2, null, { timeout: 8000 });
const firstSpoken = await laptop.evaluate(() => window.__spoken[0]);
ok(/Google UK English/.test(firstSpoken.voice || ""), `best device voice is chosen automatically (${firstSpoken.voice})`);
ok(await laptop.evaluate(() => CSS.highlights.has("luma-speak")), "the sentence being read is highlighted");
await shot(laptop, "07-listening-book");
const iBefore = await laptop.evaluate(() => window.__luma.player.i);
await laptop.locator('.player [aria-label="Next sentence"]').click();
await laptop.waitForFunction((i) => window.__luma.player.i > i, iBefore);
ok(true, "skip to the next sentence");
await laptop.locator(".player .pl-play").click();
ok(await laptop.evaluate(() => window.__luma.player.state) === "paused", "pause");
await laptop.locator(".player .pl-play").click();
ok(await laptop.evaluate(() => window.__luma.player.state) === "playing", "resume");
await laptop.locator('.player [aria-label="Stop reading aloud"]').click();
ok(await laptop.locator(".player").count() === 0, "stop");

// natural voice (stand-in model) through the real worker and audio pipeline
await laptop.goto(BASE + "#/settings");
await laptop.waitForSelector(".voice-list");
await laptop.locator(".set-row", { hasText: "Natural voices" }).locator(".btn").click();
await laptop.waitForFunction(() => /Ready on this device/.test(document.querySelector("#view-settings").textContent), null, { timeout: 15000 }).then(
  () => ok(true, "natural voice downloads and loads in the background worker"), () => ok(false, "natural voice downloads and loads in the background worker"));
await shot(laptop, "08-settings-voices");
await laptop.goto(BASE + `#/read/${twelve[10]}`);
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b");
await laptop.keyboard.press("l");
await laptop.waitForSelector(".player");
await laptop.waitForFunction(() => window.__luma.player.i >= 2, null, { timeout: 15000 }).then(
  () => ok(true, "natural voice reads sentence after sentence"), () => ok(false, "natural voice reads sentence after sentence"));
ok(/natural voice/.test(await laptop.locator(".pl-line1").textContent()), "player shows the natural voice in use");
await laptop.locator('.player [aria-label="Sleep timer"]').click();
await laptop.locator(".menu-item", { hasText: "End of chapter" }).click();
ok(await laptop.locator('.player [aria-label="Sleep timer"].on').count() === 1, "sleep timer set");
await laptop.locator('.player [aria-label="Stop reading aloud"]').click();

// ═════════════ Words, notes, settings ═════════════
await laptop.goto(BASE + "#/words");
await laptop.waitForSelector(".word");
ok(await laptop.locator(".word-w", { hasText: "lamplighter" }).count() === 1, "word added with your own meaning is in Words");
await laptop.locator(".btn", { hasText: /Review \d+ due/ }).click();
await laptop.waitForSelector(".flashcard");
const clozeCount = await laptop.locator(".fc-cloze").count();
ok(clozeCount === 1, "review asks you to recall the word in its original sentence");
await shot(laptop, "09-review-in-context");
await laptop.locator(".flashcard").click();
await laptop.waitForSelector(".grade");
await laptop.locator("dialog .dialog-head .icon-btn").click();
await laptop.locator('[aria-label="Export words"]').click();
const [csv] = await Promise.all([laptop.waitForEvent("download"), laptop.locator(".menu-item", { hasText: "Spreadsheet" }).click()]);
ok(/luma-words-.*\.csv/.test(csv.suggestedFilename()), "CSV export downloads");
await laptop.goto(BASE + "#/notes");
await laptop.waitForSelector(".note-item");
ok(await laptop.locator(".note-item").count() === 3, "Notes view lists highlights from both views");
await laptop.goto(BASE + "#/settings");
await laptop.waitForSelector(".typo-preview");
const prevFont = await laptop.evaluate(() => getComputedStyle(document.querySelector(".typo-preview")).fontFamily);
ok(/EB Garamond/.test(prevFont), "Settings preview shows the chosen typeface");
await laptop.locator("#view-settings .typo .seg button", { hasText: /^Dark$/ }).click();
ok(await within(laptop.waitForFunction(() => document.documentElement.dataset.theme === "dark")), "dark theme applies");
await shot(laptop, "10-settings-dark");
await laptop.locator("#view-settings .typo .seg button", { hasText: /^Light$/ }).click();
await laptop.locator(".btn", { hasText: "Sign in with Google" }).click();
await laptop.waitForSelector(".sync-chip[data-status='synced']", { timeout: 8000 });
ok(cloud.rows.some((r) => r.coll === "words" && r.rec.id === "lamplighter"), "signing in syncs everything up");
ok(laptop.errors.length === 0, "no errors on laptop" + (laptop.errors.length ? ": " + laptop.errors.join(" | ") : ""));

// ═════════════ Phone ═════════════
const phone = await newDevice("phone", { ...devices["Pixel 7"] });
await phone.goto(BASE + "#/settings");
await phone.locator(".btn", { hasText: "Sign in with Google" }).click();
await phone.goto(BASE + "#/library");
await phone.waitForFunction(() => document.querySelectorAll(".book").length === 3, null, { timeout: 8000 });
ok(true, "phone receives the library");
await shot(phone, "11-phone-library");
await phone.goto(BASE + `#/read/${twelve[10]}`);
await phone.waitForSelector(".pane-msg input[type=file]", { state: "attached" });
await phone.setInputFiles(".pane-msg input[type=file]", FIX("novel.pdf"));
await phone.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b", { timeout: 15000 }).then(
  () => ok(true, "phone reopens the book in Book view, as last used"), () => ok(false, "phone reopens the book in Book view, as last used"));
await phone.waitForTimeout(400);
await shot(phone, "12-phone-book");
const sp0 = await phone.evaluate(() => window.__luma.reader.tabs.get(window.__luma.reader.active).book.spread);
const vb = await phone.locator(".tab-pane.active .bookview").boundingBox();
await phone.touchscreen.tap(vb.x + vb.width - 20, vb.y + vb.height / 2);
await phone.waitForTimeout(600);
ok(await phone.evaluate((s) => window.__luma.reader.tabs.get(window.__luma.reader.active).book.spread > s, sp0), "tapping the right edge turns the page");
p = await bookWord(phone, "the");
await phone.touchscreen.tap(p.x, p.y);
await phone.waitForSelector(".defcard .def-body", { timeout: 5000 }).then(() => ok(true, "single tap defines a word on the phone"), () => ok(false, "single tap defines a word on the phone"));
await shot(phone, "13-phone-definition");
await phone.locator(".def-close").click();
await phone.locator('[data-action="headphones"]').click();
await phone.locator(".voice-option").nth(1).click();
await phone.waitForSelector(".player");
await phone.waitForTimeout(700);
await shot(phone, "14-phone-listening");
await phone.locator('.player [aria-label="Stop reading aloud"]').click();
await phone.goto(BASE + "#/words");
await phone.waitForFunction(() => document.querySelectorAll(".word").length >= 2, null, { timeout: 8000 });
ok(true, "words synced to the phone");
ok(phone.errors.length === 0, "no errors on phone" + (phone.errors.length ? ": " + phone.errors.join(" | ") : ""));


// ═════════════ v3 · EPUB, articles, reading, listening, notes, words, Drive ═════════════
const docIds = async (pg) => pg.evaluate(async () => {
  const req = indexedDB.open("luma-reader");
  const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
  const docs = await new Promise((r) => { const q = db.transaction("docs").objectStore("docs").getAll(); q.onsuccess = () => r(q.result); });
  return Object.fromEntries(docs.filter((d) => !d.deleted).map((d) => [d.title, d.id]));
});
const active = (pg, expr) => pg.evaluate(new Function("return (" + expr + ")(window.__luma.reader.tabs.get(window.__luma.reader.active))"));
const setSettings = (pg, patch) => pg.evaluate(async (p) => (await import("/js/data/store.js")).store.setSettings(p), patch);

await laptop.goto(BASE + "#/library");
await laptop.waitForSelector(".book");
await laptop.setInputFiles("#file-input", [FIX("story.epub"), FIX("footnotes.pdf")]);
await laptop.waitForFunction(() => document.querySelectorAll(".book").length === 5, null, { timeout: 10000 });
ok(await laptop.locator(".book", { hasText: "The River Cottage" }).count() === 1, "EPUB added, title read from the book");
let ids = await docIds(laptop);

// EPUB reading
await laptop.goto(BASE + `#/read/${ids["The River Cottage"]}`);
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b", { timeout: 10000 });
ok(/EPUB/.test(await laptop.locator(".mode-chip").textContent()), "EPUB opens straight into Book view");
ok(await laptop.locator(".tab-pane.active .bk-flow h2", { hasText: "Chapter One" }).count() === 1, "EPUB chapters become headings");
await laptop.locator('[data-action="toc"]').click();
await laptop.locator(".side-panel .seg button", { hasText: "Contents" }).click();
await laptop.locator(".toc-item", { hasText: "Morning" }).click();
await laptop.waitForFunction(() => window.__luma.reader.tabs.get(window.__luma.reader.active).currentPage() === 2, null, { timeout: 5000 }).then(
  () => ok(true, "EPUB table of contents jumps to the chapter"), () => ok(false, "EPUB table of contents jumps to the chapter"));
await laptop.locator(".side-panel .panel-head .icon-btn").click();
await shot(laptop, "15-epub");

// character voices with the natural voice
await laptop.evaluate(async () => { const v = await import("/js/core/voice.js"); v.prefs.engine = "natural"; await v.loadNatural(); });
await active(laptop, "(t) => t.book.goToPage(1, { animate: false })");
await laptop.waitForTimeout(300);
await laptop.keyboard.press("l");
await laptop.waitForSelector(".player");
await laptop.waitForFunction(() => (window.__luma.player.trail || []).some((x) => /every letter/.test(x.text)), null, { timeout: 25000 }).catch(() => {});
const trail = await laptop.evaluate(() => window.__luma.player.trail);
const said = (re) => trail.find((x) => re.test(x.text));
const narrator = "af_heart";
ok(said(/Come in/) && ["af_bella", "bf_emma", "af_nicole"].includes(said(/Come in/).voice), `Mary speaks in a woman's voice of her own (${said(/Come in/)?.voice})`);
ok(said(/Thank you/) && ["am_michael", "bm_george", "am_fenrir", "bm_fable"].includes(said(/Thank you/).voice), `Tom speaks in a man's voice (${said(/Thank you/)?.voice})`);
ok(said(/why didn/)?.voice === said(/Thank you/)?.voice, "an unattributed reply goes to the right speaker (turn-taking)");
ok(said(/^\s*said Mary/)?.voice === narrator || trail.some((x) => /rain had not stopped/.test(x.text) && x.voice === narrator), "the narrator keeps your chosen voice");
ok(await laptop.evaluate(() => CSS.highlights.has("luma-word")), "the word being spoken is highlighted");
await shot(laptop, "16-character-voices");
await laptop.locator(".player .pl-more").click();
await laptop.locator(".menu-item", { hasText: "Who's who" }).click();
await laptop.waitForSelector(".cast-row");
ok(await laptop.locator(".cast-row", { hasText: "Mary" }).count() === 1 && await laptop.locator(".cast-row", { hasText: "Tom" }).count() === 1, "Who's who lists the characters and their voices");
await shot(laptop, "17-whos-who");
await laptop.locator("dialog .btn.primary").click();
await laptop.keyboard.press("ArrowRight");
await laptop.waitForSelector(".pl-back", { timeout: 3000 }).then(() => ok(true, "turning the page yourself pauses following and offers “Back to the voice”"), () => ok(false, "turning the page yourself pauses following and offers “Back to the voice”"));
await laptop.locator(".pl-back").click();
ok(await laptop.evaluate(() => window.__luma.player.following) && await laptop.locator(".pl-back").count() === 0, "Back to the voice returns to the sentence being read");
await laptop.locator('.player [aria-label="Stop reading aloud"]').click();

// pronunciations
await laptop.evaluate(async () => (await import("/js/data/store.js")).store.setSettings({ pronunciations: { Tom: "Thomas" } }));
ok(await laptop.evaluate(async () => (await import("/js/reader/player.js")).speechText("“Thank you,” Tom replied (Smith, 2004).")) === "“Thank you,” Thomas replied.", "your pronunciations are used and citations skipped");

// chapter as audio
await laptop.locator(".reader-actions .icon-btn[aria-label='More']").click();
const [wav] = await Promise.all([laptop.waitForEvent("download", { timeout: 30000 }), laptop.locator(".menu-item", { hasText: "Save this chapter as audio" }).click()]);
ok(/\.wav$/.test(wav.suggestedFilename()), `the chapter downloads as an audio file (${wav.suggestedFilename()})`);

// footnotes
await laptop.goto(BASE + `#/read/${ids["Notes on Lamps"]}`);
await laptop.waitForSelector(".tab-pane.active .textLayer span", { state: "attached" });
await laptop.locator(".mode-seg button", { hasText: "Book" }).click();
await laptop.waitForSelector(".tab-pane.active .bk-flow .fn", { timeout: 8000 }).then(() => ok(true, "footnote markers are found in a PDF"), () => ok(false, "footnote markers are found in a PDF"));
ok(!/Contemporary accounts/.test(await laptop.locator(".tab-pane.active .bk-flow").textContent()), "footnote text is lifted out of the running text");
await laptop.locator(".tab-pane.active .bk-flow .fn").first().click();
await laptop.waitForSelector(".fn-pop.in");
ok(/Contemporary accounts/.test(await laptop.locator(".fn-pop").textContent()), "tapping a marker pops the footnote up");
await shot(laptop, "18-footnote");
await laptop.mouse.click(5, 400);

// search stays in Book view
await laptop.keyboard.press("Control+f");
await laptop.locator(".side-panel .search-input").fill("lamplighter");
await laptop.keyboard.press("Enter");
await laptop.waitForFunction(() => /matches/.test(document.querySelector(".search-results")?.textContent || ""));
ok(await active(laptop, "(t) => t.mode") === "book" && await laptop.evaluate(() => CSS.highlights.has("luma-find")), "search works inside Book view and highlights matches");
await laptop.locator(".side-panel .panel-head .icon-btn").click();

// the novel: words here, scroll layout, auto-scroll, curl, ruler
await laptop.goto(BASE + `#/read/${twelve[10]}`);
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b");
await active(laptop, "(t) => t.book.goToPage(1, { animate: false })");
await laptop.locator('[data-action="toc"]').click();
await laptop.locator(".side-panel .seg button", { hasText: "Words" }).click();
await laptop.waitForSelector(".wh-item", { timeout: 15000 }).catch(() => {});
const hardList = await laptop.locator(".wh-word").allTextContents();
ok(hardList.some((w) => /perspicacious|sesquipedalian/.test(w)) && !hardList.some((w) => /^(the|which|lamp)/.test(w)), `“Words here” finds the rare words before you read (${hardList.map((w) => w.split(" ")[0]).join(", ")})`);
await shot(laptop, "19-words-here");
await laptop.locator(".wh-item", { hasText: "perspicacious" }).locator(".wh-actions .icon-btn").nth(1).click();
await laptop.waitForFunction(async () => Boolean((await import("/js/data/store.js")).store.get("words", "perspicacious")), null, { timeout: 5000 }).then(
  () => ok(true, "a word can be saved straight from the list"), () => ok(false, "a word can be saved straight from the list"));
await laptop.locator(".wh-head .btn", { hasText: "Save all" }).click();
await laptop.waitForTimeout(800);
await laptop.locator(".side-panel .panel-head .icon-btn").click();

await setSettings(laptop, { pageTurn: "curl" });
await laptop.waitForTimeout(600);
const spread0 = await active(laptop, "(t) => t.book.spread");
await laptop.keyboard.press("ArrowRight");
const curled = await laptop.waitForSelector(".bk-curl", { state: "attached", timeout: 1000 }).then(() => true, () => false);
await laptop.waitForTimeout(800);
ok(curled && await active(laptop, "(t) => t.book.spread") === spread0 + 1, "page-curl turn");
await setSettings(laptop, { pageTurn: "slide" });

await laptop.keyboard.press("r");
await laptop.waitForTimeout(200);
const mid = await laptop.locator(".tab-pane.active .bk-clip").boundingBox();
await laptop.mouse.move(mid.x + 80, mid.y + 120);
await laptop.mouse.move(mid.x + 90, mid.y + 140);
ok(await laptop.locator(".tab-pane.active .bk-ruler.on").count() === 1, "R turns on a reading ruler that follows the pointer");
await shot(laptop, "20-ruler");
await laptop.keyboard.press("r");

await setSettings(laptop, { bookLayout: "scroll" });
await laptop.waitForSelector(".tab-pane.active .bookview.scroll .bk-chunk", { timeout: 5000 });
ok(true, "Book view can scroll continuously instead of turning pages");
await shot(laptop, "21-scroll-layout");
await laptop.keyboard.press("a");
await laptop.waitForSelector(".autoscroll");
await laptop.waitForTimeout(2200);
ok(await active(laptop, "(t) => t.book.clip.scrollTop") > 5, "A starts auto-scroll at your reading speed");
await laptop.keyboard.press("a");
await active(laptop, "(t) => { t.book.clip.scrollTop = 0; }");
await laptop.waitForTimeout(200);
await laptop.keyboard.press("l");
await laptop.waitForSelector(".player");
await laptop.waitForTimeout(600);
await laptop.evaluate(() => window.__luma.player.skip(30));
await laptop.waitForFunction(() => window.__luma.reader.tabs.get(window.__luma.reader.active).book.clip.scrollTop > 100, null, { timeout: 6000 }).then(
  () => ok(true, "the page scrolls by itself to follow the voice"), () => ok(false, "the page scrolls by itself to follow the voice"));
await laptop.locator('.player [aria-label="Stop reading aloud"]').click();
await setSettings(laptop, { bookLayout: "pages" });

// "where was I?"
await laptop.evaluate(async (id) => {
  const req = indexedDB.open("luma-reader");
  const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
  const doc = await new Promise((r) => { const q = db.transaction("docs").objectStore("docs").get(id); q.onsuccess = () => r(q.result); });
  await new Promise((r) => { const tx = db.transaction("docs", "readwrite"); tx.objectStore("docs").put({ ...doc, openedAt: Date.now() - 2 * 864e5, lastPage: 5 }); tx.oncomplete = r; });
}, twelve[10]);
await laptop.goto(BASE + "#/library");
await laptop.reload();
await laptop.goto(BASE + `#/read/${twelve[10]}`);
await laptop.waitForSelector(".recap.in", { timeout: 8000 }).then(() => ok(true, "coming back after a while shows “where you left off”"), () => ok(false, "coming back after a while shows “where you left off”"));
await shot(laptop, "22-recap");
await laptop.locator(".recap .btn.primary").click().catch(() => {});

// web article & pasted text
await laptop.goto(BASE + "#/library");
await laptop.locator("#import-btn").click();
await laptop.locator(".menu-item", { hasText: "web article" }).click();
await laptop.locator("dialog input[type=url]").fill("https://example.com/slow-reading");
await laptop.locator("dialog .btn.primary").click();
await laptop.waitForSelector(".tab-pane.active .bk-flow h2", { timeout: 10000 });
ok(/Article/.test(await laptop.locator(".mode-chip").textContent()) && /Slow Reading/.test(await laptop.locator(".tab-pane.active .bk-flow").textContent()), "a web article is fetched and set as a book");
await shot(laptop, "23-article");
await laptop.goto(BASE + "#/library");
await laptop.locator("#import-btn").click();
await laptop.locator(".menu-item", { hasText: "Paste text" }).click();
await laptop.locator("dialog .paste-title").fill("Kitchen notes");
await laptop.locator("dialog .paste-text").fill("# Bread\n\nMix the flour and water the night before. Let it rest.\n\nIn the morning shape the loaf and bake it hot.");
await laptop.locator("dialog .btn.primary").click();
await laptop.waitForSelector(".tab-pane.active .bk-flow h2", { timeout: 8000 }).then(() => ok(true, "pasted text becomes a book"), () => ok(false, "pasted text becomes a book"));

// search everything
await laptop.goto(BASE + "#/library");
await laptop.locator("#lib-search").fill("kettle");
await laptop.waitForSelector(".everywhere .ev-book", { timeout: 8000 }).then(() => ok(true, "library search finds words inside books"), () => ok(false, "library search finds words inside books"));
await shot(laptop, "24-search-everything");
await laptop.locator(".everywhere .ev-book .item-main").first().click();
await laptop.waitForFunction(() => CSS.highlights.has("luma-find"), null, { timeout: 8000 }).then(() => ok(true, "opening a result shows the match in the book"), () => ok(false, "opening a result shows the match in the book"));

// notes: tags, star, export, quote card
await laptop.evaluate(() => {
  const p = [...document.querySelectorAll(".tab-pane.active .bk-flow p")].find((x) => x.textContent.includes("kettle"));
  const t = p.firstChild; const i = t.data.indexOf("The kettle is on");
  const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + "The kettle is on".length);
  getSelection().removeAllRanges(); getSelection().addRange(r);
});
await laptop.waitForSelector(".selbar.in");
await laptop.locator(".selbar-btn", { hasText: "Note" }).click();
await laptop.locator("dialog textarea").fill("Warmth before words.");
await laptop.locator("dialog .tag-input").fill("home, tea");
await laptop.locator("dialog .btn.primary").click();
await laptop.goto(BASE + "#/notes");
await laptop.waitForSelector("#view-notes .note-item .tag");
ok(await laptop.locator("#view-notes .note-item .tag", { hasText: "#tea" }).count() === 1, "notes carry tags");
await laptop.locator("#view-notes .note-item", { hasText: "kettle" }).locator(".star-btn").click();
await laptop.locator("#view-notes .seg button", { hasText: "Starred" }).click();
await laptop.waitForFunction(() => document.querySelectorAll("#view-notes .note-item").length === 1);
ok(true, "starred passages gather in the commonplace book");
await shot(laptop, "25-commonplace");
await laptop.locator("#view-notes .head-actions .btn", { hasText: "Export" }).click();
const [md] = await Promise.all([laptop.waitForEvent("download"), laptop.locator(".menu-item", { hasText: "Obsidian" }).click()]);
const mdText = await (await import("node:fs/promises")).readFile(await md.path(), "utf8");
ok(/^---\ntitle:/.test(mdText) && /#tea/.test(mdText), "notes export for Obsidian with front matter and tags");
await laptop.locator("#view-notes .note-item", { hasText: "kettle" }).locator('[aria-label="Actions"]').click();
await laptop.locator(".menu-item", { hasText: "quote card" }).click();
await laptop.waitForSelector(".qc-canvas");
await laptop.waitForTimeout(400);
await shot(laptop, "26-quote-card");
const [png] = await Promise.all([laptop.waitForEvent("download"), laptop.locator(".qc-actions .btn.primary").click()]);
ok(/\.png$/.test(png.suggestedFilename()), "quote card saves as an image");
await laptop.keyboard.press("Escape");

// words: practice modes, Anki
await laptop.goto(BASE + "#/words");
await laptop.waitForSelector(".goal-strip");
ok(true, "daily goal shows on the Words page");
await laptop.locator(".head-actions .btn", { hasText: "Practise" }).click();
await laptop.locator(".menu-item", { hasText: "Meaning quiz" }).click();
await laptop.waitForSelector(".practice-dialog .pr-options");
for (let k = 0; k < 15 && !(await laptop.locator(".pr-done").count()); k++) {
  await laptop.evaluate(async () => {
    const { store } = await import("/js/data/store.js");
    const def = (w) => w.customDef || w.meanings?.[0]?.defs?.[0]?.d || "";
    const words = store.list("words");
    const wordEl = document.querySelector(".pr-word");
    const defEl = document.querySelector(".pr-def");
    const opts = [...document.querySelectorAll(".pr-opt")];
    let target;
    if (wordEl) { const w = words.find((x) => x.word === wordEl.firstChild.textContent.trim()); target = opts.find((o) => def(w).startsWith(o.textContent.slice(0, 40))); }
    else { const w = words.find((x) => def(x) === defEl.textContent); target = opts.find((o) => o.textContent === w.word); }
    target?.click();
  });
  await laptop.waitForTimeout(900);
}
ok(/(\d+) of \1/.test(await laptop.locator(".pr-big").textContent().catch(() => "")), "meaning quiz: every answer marked right");
await shot(laptop, "27-quiz-done");
await laptop.locator(".pr-done .btn.primary").click();
await laptop.locator(".head-actions .btn", { hasText: "Practise" }).click();
await laptop.locator(".menu-item", { hasText: "Spell it" }).click();
await laptop.waitForSelector(".pr-input");
const spellWord = await laptop.evaluate(async () => {
  const { store } = await import("/js/data/store.js");
  const def = document.querySelector(".pr-def")?.textContent;
  return store.list("words").find((w) => (w.customDef || w.meanings?.[0]?.defs?.[0]?.d) === def)?.word;
});
await laptop.locator(".pr-input").fill(spellWord || "");
await laptop.locator(".pr-form .btn").click();
await laptop.waitForSelector(".pr-input.right", { timeout: 3000 }).then(() => ok(true, "spelling practice checks your answer"), () => ok(false, "spelling practice checks your answer"));
await laptop.locator("dialog .dialog-head .icon-btn").click();
await laptop.locator('[aria-label="Export words"]').click();
const [anki] = await Promise.all([laptop.waitForEvent("download"), laptop.locator(".menu-item", { hasText: "Anki" }).click()]);
const ankiText = await (await import("node:fs/promises")).readFile(await anki.path(), "utf8");
ok(/^#separator:tab/.test(ankiText) && ankiText.split("\n").length > 4, "words export as Anki flashcards");
ok(laptop.errors.length === 0, "no errors on laptop (v3)" + (laptop.errors.length ? ": " + laptop.errors.join(" | ") : ""));

// Google Drive: books and everything else, with no Firebase
await laptop.goto(BASE + "#/settings");
await laptop.locator(".btn", { hasText: "Connect Google Drive" }).click();
await laptop.waitForFunction(() => window.__luma.drive.status === "synced", null, { timeout: 30000 }).catch(() => {});
const files = [...driveFiles.values()];
ok(files.some((f) => f.appProperties?.luma === "sync") && files.filter((f) => f.appProperties?.lumaId).length >= 7, `books and library are saved to Google Drive (${files.filter((f) => f.appProperties?.lumaId).length} book files)`);
await shot(laptop, "28-drive-settings");
const tablet = await newDevice("tablet", { viewport: { width: 1180, height: 820 } });
await tablet.goto(BASE + "#/settings");
await tablet.locator(".btn", { hasText: "Connect Google Drive" }).click();
await tablet.waitForFunction(() => window.__luma.drive.status === "synced", null, { timeout: 30000 }).catch(() => {});
await tablet.goto(BASE + "#/library");
await tablet.waitForFunction(() => document.querySelectorAll(".book").length >= 7, null, { timeout: 10000 }).then(
  () => ok(true, "a new device gets the whole library from Drive — no Firebase"), () => ok(false, "a new device gets the whole library from Drive — no Firebase"));
const tIds = await docIds(tablet);
await tablet.goto(BASE + `#/read/${tIds["The River Cottage"]}`);
await tablet.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b", { timeout: 15000 }).then(
  () => ok(true, "books open on the new device without adding the file again"), () => ok(false, "books open on the new device without adding the file again"));
await tablet.goto(BASE + "#/words");
await tablet.waitForFunction(() => document.querySelectorAll(".word").length >= 3, null, { timeout: 8000 }).then(() => ok(true, "words came through Drive too"), () => ok(false, "words came through Drive too"));
await shot(tablet, "29-tablet-drive");
ok(tablet.errors.length === 0, "no errors on tablet" + (tablet.errors.length ? ": " + tablet.errors.join(" | ") : ""));

// phone: EPUB + scroll layout + practice on a small screen
await phone.goto(BASE + "#/library");
await phone.setInputFiles("#file-input", [FIX("story.epub")]);
await phone.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b", { timeout: 10000 }).catch(() => {});
if (!(await phone.locator(".tab-pane.active .bookview:not([hidden]) .bk-b").count())) { await phone.goto(BASE + `#/read/${ids["The River Cottage"]}`); await phone.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b", { timeout: 10000 }); }
await shot(phone, "30-phone-epub");
ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways overflow on the phone");
ok(phone.errors.length === 0, "no errors on phone (v3)" + (phone.errors.length ? ": " + phone.errors.join(" | ") : ""));

// ═════════════ Offline (service worker) ═════════════
{
  const ctx = await browser.newContext({ viewport: { width: 1918, height: 1000 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const pg = await ctx.newPage();
  pg.errors = []; pg.device = "offline"; pages.push(pg);
  await pg.goto(BASE);
  await pg.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 }).catch(() => {});
  await pg.reload();
  await pg.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
  await pg.setInputFiles("#file-input", [FIX("novel.pdf")]);
  await pg.waitForSelector(".textLayer span", { state: "attached", timeout: 15000 });
  await pg.waitForTimeout(800);
  await ctx.setOffline(true);
  await pg.reload();
  await pg.waitForSelector(".tab-pane.active .textLayer span", { state: "attached", timeout: 15000 }).then(
    () => ok(true, "app and an imported book reopen with no connection"),
    () => ok(false, "app and an imported book reopen with no connection"));
  ok(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow at 1918px");
  await ctx.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
