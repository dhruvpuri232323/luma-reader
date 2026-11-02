// End-to-end test of Luma Reader in real Chromium (laptop + phone viewports):
// (scanned.pdf is three pages of novel.pdf saved as pictures only, hindi-scan.pdf a page of Hindi —
//  tests reading scanned books; fake-translator.js stands in for the browser's built-in translator)
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
/** Wait until an async check in the page is true (Playwright's waitForFunction doesn't await promises). */
async function until(pg, fn, arg = null, { timeout = 8000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await pg.evaluate(fn, arg).catch(() => false)) return true;
    await pg.waitForTimeout(200);
  }
  throw new Error("timed out");
}

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
const NOUNS = new Set(["human", "bucket"]);
const dictionary = (w) => [{
  word: w, phonetic: `/${w}/`, phonetics: [{ text: `/${w}/` }],
  meanings: [{ partOfSpeech: NOUNS.has(w) ? "noun" : "adjective", definitions: [{ definition: `Test meaning of ${w}.`, example: `A ${w} example.`, synonyms: ["bright"], antonyms: [] }], synonyms: ["radiant"], antonyms: ["dim"] }],
}];
// Wiktionary's pages (Parsoid HTML), trimmed to what the word stories read
const wkPage = (ety) => `<html><body><section data-mw-section-id="1"><h2 id="English">English</h2><section data-mw-section-id="2"><h3 id="Etymology">Etymology</h3><p>${ety}</p></section><section><h3 id="Adjective">Adjective</h3><p>…</p></section></section></body></html>`;
const WIKTIONARY_HTML = {
  fastest: wkPage(`From <i class="Latn mention" lang="en"><a href="./fast">fast</a></i> +&lrm; <i class="Latn mention" lang="en"><a href="./-est">-est</a></i>.`),
  fast: wkPage(`From Middle English <i class="Latn mention">fast</i>, from Old English <i class="Latn mention">fæst</i> (“firm, secure”), from Proto-Germanic <i class="Latn mention">*fastuz</i>.`),
  elegant: wkPage(`From Middle French <i class="Latn mention" lang="frm">élégant</i>, from Latin <i class="Latn mention" lang="la">ēlegāns</i> (“choice, fine, tasteful”), from <i class="Latn mention" lang="la">ēligō</i> (“pick out, choose”).`),
};
async function routeServices(ctx) {
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ctx.route(/api\.dictionaryapi\.dev/, (r) => {
    const w = decodeURIComponent(r.request().url().split("/").pop());
    if (NOT_IN_DICTIONARY.has(w) || /\s/.test(w)) return r.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dictionary(w)) });
  });
  await ctx.route(/api\.mymemory\.translated\.net/, (r) => {
    const q = new URL(r.request().url()).searchParams.get("q") || "";
    r.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ responseStatus: 200, responseData: { translatedText: "[ऑनलाइन] " + q } }) });
  });
  await ctx.route(/en\.wiktionary\.org/, (r) => {
    if (decodeURIComponent(r.request().url()).includes("definition/पानी")) {
      return r.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ hi: [{ partOfSpeech: "Noun", language: "Hindi", definitions: [{ definition: "<a>water</a>" }, { definition: "rain" }] }] }) });
    }
    const html = /\/page\/html\/([^/?#]+)/.exec(r.request().url());
    if (html) {
      const body = WIKTIONARY_HTML[decodeURIComponent(html[1])];
      return r.fulfill(body ? { status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "text/html", body } : { status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "" });
    }
    if (/definition\/kick_the_bucket/.test(r.request().url())) {
      return r.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ en: [{ partOfSpeech: "Verb", language: "English", definitions: [{ definition: "(<i>idiomatic</i>, <i>euphemistic</i>) To die.", examples: ["The old man finally <b>kicked the bucket</b>."] }] }] }) });
    }
    if (/sesquipedalian/.test(r.request().url())) {
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        en: [{ partOfSpeech: "Adjective", language: "English", definitions: [{ definition: "<b>Given</b> to the use of long words.", examples: ["a <i>sesquipedalian</i> lecturer"] }] }],
      }) });
    }
    r.fulfill({ status: 404, body: "{}" });
  });
  await ctx.route(/upload\.wikimedia\.org/, (r) => r.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") }));
  await ctx.route(/en\.wikipedia\.org/, (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.startsWith("/api/rest_v1/page/media-list/")) {
      return r.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ items: [1, 2, 3].map((i) => ({ type: "image", title: `File:Lamp${i}.jpg`, showInGallery: true, caption: { text: `A gas lamp, picture ${i}` }, srcset: [{ src: `//upload.wikimedia.org/lamp${i}-320.png`, scale: "1x" }, { src: `//upload.wikimedia.org/lamp${i}-640.png`, scale: "2x" }] })) }) });
    }
    if (url.pathname === "/w/api.php") {
      const json = (o) => r.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify(o) });
      const gsr = url.searchParams.get("gsrsearch") || "";
      if (url.searchParams.get("action") === "parse") {
        return json(/lamplighter/i.test(url.searchParams.get("page")) ? { parse: { title: "Lamplighter", text: `<div class="mw-parser-output"><table class="infobox"><tbody><tr><th colspan="2" class="infobox-above">Lamplighter</th></tr><tr><th class="infobox-label">Occupation type</th><td class="infobox-data">Street work<sup class="reference">[1]</sup></td></tr><tr><th class="infobox-label">Activity sectors</th><td class="infobox-data">Public lighting<br>Local government</td></tr><tr><th class="infobox-label">Related jobs</th><td class="infobox-data">Watchman</td></tr></tbody></table><p>A lamplighter…</p></div>` } } : { error: { code: "missingtitle" } });
      }
      if (/^morelike:/.test(gsr)) return json({ query: { pages: [{ pageid: 7, index: 1, title: "Gas lighting", description: "Light from burning gas" }, { pageid: 8, index: 2, title: "Street light", description: "Raised source of light on the edge of a road" }] } });
      if (/fastest human/i.test(gsr)) {
        return json({ query: { pages: [
          { pageid: 11, index: 1, title: "Footspeed", description: "Maximum speed a human can move on foot", extract: "Footspeed, or sprint speed, is the maximum speed at which a human can move on foot." },
          { pageid: 12, index: 2, title: "Usain Bolt", description: "Jamaican sprinter (born 1986)", extract: "Usain Bolt is a Jamaican retired sprinter." }] } });
      }
      if (url.searchParams.get("titles") === "Footspeed") {
        return json({ query: { pages: [{ pageid: 11, title: "Footspeed", description: "Maximum speed a human can move on foot", fullurl: "https://en.wikipedia.org/wiki/Footspeed",
          extract: "Footspeed, or sprint speed, is the maximum speed at which a human can move on foot.\n== Fastest humans ==\nThe fastest human footspeed on record is 44.72 km/h (27.78 mph), seen during a 100-metre sprint by Usain Bolt. His average speed was lower.\n== Animals ==\nThe cheetah is the fastest land animal." }] } });
      }
      if (url.searchParams.get("generator") === "search") {
        return json({ query: { pages: [
          { pageid: 2, index: 2, title: "The Lamplighter (novel)", description: "1854 novel by Maria Cummins", extract: "The Lamplighter is a novel by Maria Susanna Cummins." },
          { pageid: 1, index: 1, title: "Lamplighter", description: "Person employed to light street lamps", extract: "A lamplighter was a person employed to light street lights. They also put them out at dawn.", thumbnail: { source: "https://upload.wikimedia.org/lamp.png" } },
          { pageid: 3, index: 3, title: "Lamplighter (disambiguation)", extract: "Lamplighter may refer to:" },
        ] } });
      }
      if (url.searchParams.get("titles")) {
        return json({ query: { pages: [{ pageid: 1, title: "Lamplighter", description: "Person employed to light street lamps", fullurl: "https://en.wikipedia.org/wiki/Lamplighter",
          thumbnail: { source: "https://upload.wikimedia.org/lamp.png" },
          extract: "A lamplighter was a person employed to light street lights.\nThey worked at dusk and dawn.\n\n== History ==\nLamplighters were common in the 18th century.\n\n=== In London ===\nA few gas lamps in London are still lit by hand.\n\n== See also ==\nStreetlight\n\n== References ==\nSmith, J. (2001)." }] } });
      }
      return json({ query: { pages: [] } });
    }
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
  window.__LUMA_TTS_WORKERS__ = 3;
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
      window.__spoken.push({ text: u.text, voice: u.voice?.name, pitch: u.pitch, at: performance.now() });
      u.onstart?.();
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

async function newDevice(name, { translator = false, ...opts } = {}) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block", acceptDownloads: true });
  await routeServices(ctx);
  // computers with Chrome/Edge have a built-in translator; phones don't
  if (translator) await ctx.addInitScript({ path: FIX("fake-translator.js") });
  else await ctx.addInitScript(() => { delete window.Translator; delete window.LanguageDetector; }); // like a phone: no built-in translator
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

/** Laptop settings show one page at a time: pick it from the sidebar. */
async function settingsPage(pg, name) {
  await pg.waitForSelector("#view-settings .set-section");
  if (await pg.locator(".set-nav").count()) await pg.locator(".set-nav-item", { hasText: name }).click();
}

const page = await newDevice("laptop", { viewport: { width: 1440, height: 900 }, translator: true });
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
ok(await laptop.locator(".defcard .def-google").count() === 1, "every card has a Look it up button");
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

// look it up in the app: Wikipedia, your books, the web — no browser
await laptop.evaluate(() => {
  const w = document.createTreeWalker(document.querySelector(".tab-pane.active .bk-flow"), NodeFilter.SHOW_TEXT);
  const clip = document.querySelector(".tab-pane.active .bk-clip").getBoundingClientRect();
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf("lamplighter");
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 11);
    const b = r.getClientRects()[0];
    if (!b || b.left < clip.left || b.right > clip.right) continue;
    getSelection().removeAllRanges(); getSelection().addRange(r);
    return;
  }
});
await laptop.waitForSelector(".selbar.in");
await laptop.locator(".selbar-btn", { hasText: "Look up" }).click();
await laptop.waitForSelector('.research.in [aria-label="From Wikipedia"] .rs-hit', { timeout: 5000 });
ok((await laptop.locator(".research .rs-input").inputValue()) === "lamplighter", "Look up opens the in-app search with the selected words");
ok((await laptop.locator('.research [aria-label="From Wikipedia"] .rs-hit .rs-title').first().textContent()) === "Lamplighter", "Wikipedia results show inside the app, best match first");
ok(!(await laptop.locator(".research").textContent()).includes("(disambiguation)"), "“may refer to” lists are left out");
ok(await laptop.locator(".research .rs-web .btn", { hasText: "Search Google" }).count() === 1, "Google is still one tap away");
await laptop.waitForSelector('.research [aria-label="In your books"]', { timeout: 5000 }).then(() => ok(true, "results include matches in your own books"), () => ok(false, "results include matches in your own books"));
await laptop.waitForTimeout(350);
await shot(laptop, "05b-look-it-up");
await laptop.locator('.research [aria-label="From Wikipedia"] .rs-hit').first().click();
await laptop.waitForSelector(".research .rs-art-title");
ok((await laptop.locator(".research .rs-art-title").textContent()) === "Lamplighter", "a Wikipedia article opens inside the app");
const sects = await laptop.locator(".research .rs-sect > summary").allTextContents();
ok(sects.length === 1 && sects[0] === "History", "article sections fold; references and “see also” are left out");
await laptop.locator(".research .rs-sect > summary").first().click();
ok(await laptop.locator(".research .rs-sect h4", { hasText: "In London" }).isVisible(), "sub-sections show when a section is opened");
ok(await laptop.locator(".research .rs-art-actions .btn.on", { hasText: "Saved" }).count() === 1, "a word you've saved shows as saved in the article");
await laptop.waitForTimeout(350);
await shot(laptop, "05c-article-in-app");
await laptop.keyboard.press("Escape");
await laptop.waitForSelector('.research [aria-label="From Wikipedia"] .rs-hit');
ok(true, "Esc goes back from the article to the results");
await laptop.keyboard.press("Escape");
await laptop.waitForFunction(() => !document.querySelector(".research"));
await laptop.mouse.click(5, 500);
await laptop.keyboard.press("k");
await laptop.waitForSelector(".research.in .rs-input");
await laptop.waitForFunction(() => document.activeElement?.classList.contains("rs-input"), null, { timeout: 2000 }).catch(() => {});
ok(await laptop.evaluate(() => document.activeElement?.classList.contains("rs-input")) && (await laptop.locator(".research .chip", { hasText: "lamplighter" }).count()) === 1,
  "K opens an empty look-up, ready to type, with recent look-ups");
await laptop.locator(".research .rs-input").fill("lamplighter history");
await laptop.keyboard.press("Enter");
await laptop.waitForFunction(() => document.querySelector(".research .rs-input")?.value === "lamplighter history" && document.querySelector('.research [aria-label="From Wikipedia"] .rs-hit'));
ok(true, "typing a new question searches again");
await laptop.locator('.research [aria-label="Close"]').click();
await laptop.waitForFunction(() => !document.querySelector(".research"));

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
await settingsPage(laptop, "Listening");
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
await laptop.waitForFunction(() => (window.__luma.player.timeline || []).length >= 6, null, { timeout: 15000 }).catch(() => {});
const gaps = await laptop.evaluate(() => {
  const t = window.__luma.player.timeline, s = window.__luma.player.sentences;
  const out = [];
  for (let n = 1; n < t.length; n++) {
    const prev = s[t[n - 1].i];
    if (t[n].i === t[n - 1].i || !(prev.paraEnd || prev.heading)) out.push(t[n].start - t[n - 1].end);
  }
  return out;
});
ok(gaps.length >= 3 && Math.max(...gaps) < 0.12, `sentences flow straight into each other — no waiting between them (largest gap ${Math.round(Math.max(...gaps) * 1000)} ms)`);
ok(await laptop.evaluate(async () => (await import("/js/core/voice.js")).naturalState().workers) >= 2, "the voice is made on several cores at once");
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
await settingsPage(laptop, "Reading");
await laptop.waitForSelector(".typo-preview");
const prevFont = await laptop.evaluate(() => getComputedStyle(document.querySelector(".typo-preview")).fontFamily);
ok(/EB Garamond/.test(prevFont), "Settings preview shows the chosen typeface");
await laptop.locator("#view-settings .typo .seg button", { hasText: /^Dark$/ }).click();
ok(await within(laptop.waitForFunction(() => document.documentElement.dataset.theme === "dark")), "dark theme applies");
await shot(laptop, "10-settings-dark");
await laptop.locator("#view-settings .typo .seg button", { hasText: /^Light$/ }).click();
await settingsPage(laptop, "Account");
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

// a book built like a real published EPUB
await laptop.goto(BASE + "#/library");
await laptop.setInputFiles("#file-input", [FIX("realbook.epub")]);
await laptop.waitForFunction(() => document.querySelectorAll(".book").length === 6, null, { timeout: 10000 });
ids = await docIds(laptop);
await laptop.goto(BASE + `#/read/${ids["The Glass Partnership"]}`);
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b", { timeout: 10000 });
await laptop.waitForTimeout(400);
const real = await laptop.evaluate(() => {
  const f = document.querySelector(".tab-pane.active .bk-flow");
  return { h: [...f.querySelectorAll("h2")].map((x) => x.textContent), breaks: f.querySelectorAll(".bk-break").length, fn: [...f.querySelectorAll(".fn")].map((x) => x.dataset.text), quote: f.querySelectorAll(".bk-quote").length, text: f.textContent };
});
ok(real.h.includes("1: A Purposeful Life") && real.h.includes("Chapter 2: The Demo"), "chapter number and title on separate lines become one heading");
ok(real.breaks >= 3, "scene breaks (—, * * *, rules) become quiet breaks");
ok(real.fn.some((t) => /Interview with the author/.test(t)) && real.fn.some((t) => /never named/.test(t)), "EPUB endnotes and footnotes pop up from their markers");
ok(!/same\.1|city\.\*/.test(real.text), "note numbers don't clutter the text");
ok(real.quote >= 1, "block quotes keep their style");
await laptop.keyboard.press("l");
await laptop.waitForSelector(".player");
await laptop.waitForFunction(() => /trial began|memo|Lena kept/.test(window.__luma.player.sentences[window.__luma.player.cur?.i]?.text || ""), null, { timeout: 30000 }).then(
  () => ok(true, "reading aloud carries on past scene breaks (it used to stop at “—”)"), () => ok(false, "reading aloud carries on past scene breaks (it used to stop at “—”)"));
ok(await laptop.evaluate(async () => (await import("/js/reader/player.js")).speechText("AFTER ALL THE DELAYS, the partnership")) === "After all the delays, the partnership", "capitals used for emphasis are read as words, not spelled out");
await laptop.locator('.player [aria-label="Stop reading aloud"]').click();
await laptop.goto(BASE + `#/read/${ids["The River Cottage"]}`);
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b", { timeout: 10000 });

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
ok(await within(laptop.waitForFunction(() => CSS.highlights.has("luma-word"), null, { timeout: 6000 })), "the word being spoken is highlighted");
await shot(laptop, "16-character-voices");
const notesBefore = await laptop.evaluate(async () => (await import("/js/data/store.js")).store.list("annotations").length);
await laptop.locator(".player .pl-save").click();
await laptop.waitForFunction((n) => import("/js/data/store.js").then((m) => m.store.list("annotations").length > n), notesBefore, { timeout: 4000 }).then(
  () => ok(true, "one tap in the player saves the sentence being read to your notes"), () => ok(false, "one tap in the player saves the sentence being read to your notes"));
await laptop.keyboard.press(" ");
ok(await laptop.evaluate(() => window.__luma.player.state) === "paused", "Space pauses while listening");
await laptop.keyboard.press(" ");
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
await laptop.locator(".menu-item", { hasText: "Save as an audiobook" }).click();
await laptop.waitForSelector(".audiobook-dialog .voice-option");
await shot(laptop, "17b-audiobook-choices");
const [wav] = await Promise.all([laptop.waitForEvent("download", { timeout: 30000 }), (async () => {
  await laptop.locator(".audiobook-dialog .voice-option").first().click();
  await laptop.waitForSelector(".task-card", { timeout: 3000 }).then(() => ok(true, "audiobook progress shows in a corner card while you keep reading"), () => ok(false, "audiobook progress shows in a corner card while you keep reading"));
  ok(await laptop.locator("dialog[open]").count() === 0, "saving audio doesn't block the page");
})()]);
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
await until(laptop, async () => Boolean((await import("/js/data/store.js")).store.get("words", "perspicacious")), null, { timeout: 5000 }).then(
  () => ok(true, "a word can be saved straight from the list"), () => ok(false, "a word can be saved straight from the list"));
await laptop.locator(".wh-head .btn", { hasText: "Save all" }).click();
await laptop.waitForTimeout(800);
await laptop.locator(".side-panel .panel-head .icon-btn").click();

await setSettings(laptop, { pageTurn: "curl" });
await laptop.waitForTimeout(600);
const spread0 = await active(laptop, "(t) => t.book.spread");
await laptop.keyboard.press("ArrowRight");
const curled = await laptop.waitForSelector(".tab-pane.active .turn-layer .turn-leaf", { state: "attached", timeout: 1000 }).then(() => true, () => false);
await laptop.waitForTimeout(900);
ok(curled && await active(laptop, "(t) => t.book.spread") === spread0 + 1, "page-curl turn");
await setSettings(laptop, { pageTurn: "slide" });

// book feel: every book its own kind — paper, light, page turn and sound
const feelDoc = await active(laptop, "(t) => t.docId");
const sounds = () => laptop.evaluate(async () => (await import("/js/core/bookfeel.js")).soundStats.played);
const heard0 = await sounds();
await laptop.locator(".feel-btn").click();
await laptop.waitForSelector(".feel-pop.in");
ok(await laptop.locator(".feel-ed").count() === 7, "seven kinds of book to choose from (Modern, Paperback, Hardcover, Pocket book, Antique, Magazine, E-reader)");
await laptop.locator(".feel-ed", { hasText: "Hardcover" }).click();
await laptop.waitForFunction(() => document.querySelector(".tab-pane.active").dataset.edition === "hardcover");
await laptop.waitForTimeout(200);
const look = await laptop.evaluate(() => {
  const p = document.querySelector(".tab-pane.active");
  return { paper: getComputedStyle(p.querySelector(".bk-sheet")).backgroundColor, light: p.dataset.light, edged: Boolean(p.querySelector(".bookview.edged")), lamp: getComputedStyle(p.querySelector(".feel-light")).display };
});
ok(look.light === "lamp" && look.lamp !== "none" && look.paper === "rgb(247, 239, 220)" && look.edged, "Hardcover: ivory paper under a reading lamp, page edges and a cloth cover");
ok((await laptop.evaluate(async (id) => (await import("/js/data/store.js")).store.get("docs", id).feel, feelDoc))?.edition === "hardcover", "the feel is saved with the book, so it follows it to other devices");
ok(await sounds() > heard0, "choosing a kind of book plays its page sound");
await laptop.waitForTimeout(400);
await shot(laptop, "20a-book-feel");
await laptop.keyboard.press("Escape");
const heard1 = await sounds();
await laptop.keyboard.press("ArrowRight");
const flipped = await laptop.waitForSelector(".tab-pane.active .turn-layer .turn-leaf", { state: "attached", timeout: 1000 }).then(() => true, () => false);
await laptop.waitForTimeout(250);
await shot(laptop, "20b-hardcover-turn");
await laptop.waitForTimeout(1000);
ok(flipped && await sounds() > heard1, "a hardcover page flips over the spine, with a heavier page sound");
ok(!(await laptop.locator(".tab-pane.active .turn-layer").count()), "the turn cleans up after itself");
await laptop.locator(".feel-btn").click();
await laptop.waitForSelector(".feel-pop.in");
if (!(await laptop.locator(".feel-custom[open]").count())) await laptop.locator(".feel-custom > summary").click();
await laptop.locator(".feel-custom .seg button", { hasText: "E-ink" }).click();
await laptop.locator('.feel-custom select[aria-label="Page-turn sound"]').selectOption("off");
await laptop.locator(".feel-custom .seg button", { hasText: "Candlelight" }).click();
await until(laptop, async (id) => { const f = (await import("/js/data/store.js")).store.get("docs", id).feel; return f.turn === "flash" && f.sound === "off" && f.light === "candle" && f.edition === "hardcover"; }, feelDoc, { timeout: 4000 })
  .then(() => ok(true, "turn, sound and light can each be changed for this one book"), () => ok(false, "turn, sound and light can each be changed for this one book"));
await laptop.keyboard.press("Escape");
const heard2 = await sounds();
await laptop.keyboard.press("ArrowRight");
const flashed = await laptop.waitForSelector(".tab-pane.active .turn-flash", { state: "attached", timeout: 1000 }).then(() => true, () => false);
await laptop.waitForTimeout(700);
ok(flashed && await sounds() === heard2 && await laptop.evaluate(() => document.querySelector(".tab-pane.active").dataset.light) === "candle", "an e-ink flash, candlelight, and silence when the sound is off");
await laptop.goto(BASE + `#/read/${ids["The River Cottage"]}`);
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b");
ok(await laptop.evaluate(() => document.querySelector(".tab-pane.active").dataset.edition) === "paperback", "other books keep their own feel (an EPUB starts as a paperback)");
await laptop.goto(BASE + `#/read/${feelDoc}`);
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b");
await laptop.evaluate(async (id) => (await import("/js/core/bookfeel.js")).setFeel(id, {}, { replace: true }), feelDoc);
await laptop.waitForFunction(() => document.querySelector(".tab-pane.active").dataset.edition === "modern");
ok(true, "“Back to the default” returns the book to how it was");

// Page view a page (or two) at a time: the PDF's own pages turn like a book
await laptop.goto(BASE + `#/read/${twelve[12]}`);
await laptop.waitForSelector(".tab-pane.active .page[data-page-number='1']", { state: "attached" });
await active(laptop, "(t) => t.setMode('pdf')");
await laptop.waitForTimeout(500);
await laptop.locator(".feel-btn").click();
await laptop.waitForSelector(".feel-pop.in");
await laptop.locator(".feel-pop .seg button", { hasText: "Two pages" }).click();
await laptop.locator(".feel-ed", { hasText: "Antique" }).click();
await laptop.keyboard.press("Escape");
await laptop.waitForFunction(() => { const t = window.__luma.reader.tabs.get(window.__luma.reader.active); return t.paged && t.viewer.spreadMode > 0 && t.el.dataset.edition === "antique"; }, null, { timeout: 4000 })
  .then(() => ok(true, "Page view can show the original pages two at a time, like an open book"), () => ok(false, "Page view can show the original pages two at a time, like an open book"));
await active(laptop, "(t) => t.goTo(1)");
await laptop.waitForTimeout(700);
const pv0 = await active(laptop, "(t) => t.viewer.currentPageNumber");
const heard3 = await sounds();
await laptop.keyboard.press("ArrowRight");
const pvTurn = await laptop.waitForSelector(".tab-pane.active .turn-layer", { state: "attached", timeout: 1500 }).then(() => true, () => false);
await laptop.waitForTimeout(450);
await shot(laptop, "20c-pdf-spread-turn");
await laptop.waitForTimeout(1200);
ok(pvTurn && await active(laptop, "(t) => t.viewer.currentPageNumber") > pv0 && await sounds() > heard3, "the PDF's pages turn with the book's own animation and sound");
ok(await laptop.evaluate(() => getComputedStyle(document.querySelector(".tab-pane.active .pdfViewer .page"), "::after").display) === "block", "PDF pages are printed on the book's paper");
const pv1 = await active(laptop, "(t) => t.viewer.currentPageNumber");
await laptop.mouse.move(760, 460);
await laptop.mouse.wheel(0, 240);
await laptop.waitForTimeout(1500);
ok(await active(laptop, "(t) => t.viewer.currentPageNumber") > pv1, "the wheel or trackpad turns pages in this layout");
await laptop.evaluate(async (id) => (await import("/js/core/bookfeel.js")).setFeel(id, { edition: "antique", pdfPages: "single" }, { replace: true }), twelve[12]);
await laptop.waitForFunction(() => { const t = window.__luma.reader.tabs.get(window.__luma.reader.active); return t.paged && t.viewer.spreadMode === 0; }, null, { timeout: 4000 })
  .then(() => ok(true, "…or one page at a time"), () => ok(false, "…or one page at a time"));
await laptop.evaluate(async (id) => (await import("/js/core/bookfeel.js")).setFeel(id, {}, { replace: true }), twelve[12]);
await laptop.waitForFunction(() => { const t = window.__luma.reader.tabs.get(window.__luma.reader.active); return !t.paged && t.viewer.scrollMode === 0; }, null, { timeout: 4000 })
  .then(() => ok(true, "…or back to one long scroll"), () => ok(false, "…or back to one long scroll"));
await laptop.goto(BASE + `#/read/${feelDoc}`);
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b");
await laptop.waitForTimeout(400);

// reading time: counted on its own, a timed session with a summary, and Insights
await laptop.evaluate(() => { window.__LUMA_ACTIVITY_SPEED__ = 40; });
await laptop.mouse.move(700, 400);
await laptop.waitForTimeout(2500);
await laptop.keyboard.press("ArrowRight");
await laptop.waitForTimeout(2500);
await laptop.keyboard.press("ArrowRight");
await laptop.waitForTimeout(1500);
const live = await laptop.evaluate(async () => (await import("/js/data/activity.js")).summary());
ok(live && live.ms > 60000, "reading time is counted on its own while you read");
await laptop.locator(".timer-chip").click();
await laptop.waitForSelector(".timer-pop.in");
ok(/minutes today|goal reached/i.test(await laptop.locator(".timer-today-row").textContent()), "the timer shows today's reading against your daily goal");
await laptop.locator(".timer-goals .btn", { hasText: "10 min" }).click();
await laptop.waitForSelector(".timer-chip.running");
await laptop.mouse.move(720, 420);
await laptop.waitForTimeout(2200);
ok(/\d+:\d\d/.test(await laptop.locator(".timer-chip .timer-clock").textContent()), "a timed session shows a live clock in the reader");
await laptop.locator(".timer-chip").click();
await laptop.waitForSelector(".timer-pop.in .timer-live");
await shot(laptop, "20d-timer");
await laptop.locator(".timer-live .btn", { hasText: "End session" }).click();
await laptop.waitForSelector(".summary-dialog");
ok(/Session done/.test(await laptop.locator(".summary-dialog").textContent()) && await laptop.locator(".summary-dialog .sum-stat").count() === 3, "ending a session shows a summary: time, pages, words and pace");
await shot(laptop, "20e-session-summary");
await laptop.locator(".summary-dialog .btn", { hasText: "Done" }).click();
const saved = await laptop.evaluate(async () => (await import("/js/data/activity.js")).activityRecords().reduce((n, r) => n + r.sessions.length, 0));
ok(saved >= 2, "reading sessions are saved with your account, so they sync like your notes");
await laptop.evaluate(() => { window.__LUMA_ACTIVITY_SPEED__ = 1; });
await laptop.goto(BASE + "#/insights");
await laptop.waitForSelector(".ins-body", { timeout: 8000 });
ok(!/^0 min$/.test(await laptop.locator(".ins-tile.hero .tile-value").textContent()), "Insights adds up your reading time");
ok(await laptop.locator(".ins-daily .chart-svg .bar").count() >= 1 && await laptop.locator(".ins-cal .cal-grid .cal-cell:not([data-level='0'])").count() >= 1, "minutes a day and the reading calendar show it");
ok(await laptop.locator(".ins-note").count() >= 1, "Insights opens with a few things worth knowing");
await laptop.locator(".ins-daily .chart-svg .hit").last().hover();
ok(await laptop.locator(".ins-daily .chart-tip:not([hidden])").count() === 1, "hovering a bar shows its value");
await shot(laptop, "20f-insights");
await laptop.locator("#view-insights .seg button", { hasText: "All time" }).click();
await laptop.waitForFunction(() => document.querySelector("#view-insights .seg button.on")?.textContent === "All time" && document.querySelector(".ins-body"));
ok(true, "…for the last 7 days, 30 days, this year or all time");

// the logo is a light switch
const mode0 = await laptop.evaluate(() => document.documentElement.dataset.mode);
await laptop.locator(".rail .brand").click();
await laptop.waitForFunction((m) => document.documentElement.dataset.mode !== m, mode0, { timeout: 3000 }).then(() => ok(true, "tapping the logo switches the light (Light, Sepia, Dark, Night light, Auto)"), () => ok(false, "tapping the logo switches the light (Light, Sepia, Dark, Night light, Auto)"));
await laptop.locator(".rail .brand").click({ button: "right" });
await laptop.waitForSelector(".light-pop.in");
ok(await laptop.locator(".light-mode").count() === 5, "right-click (or long-press) shows every mode");
await laptop.locator(".light-mode", { hasText: "Night light" }).click();
await laptop.waitForFunction(() => { const r = document.documentElement.dataset; return r.mode === "night" && r.theme === "dark" && r.warm === "1"; }, null, { timeout: 3000 })
  .then(() => ok(true, "Night light: the dark theme with a warm amber glow"), () => ok(false, "Night light: the dark theme with a warm amber glow"));
await laptop.waitForTimeout(800);
await shot(laptop, "20g-night-light");
await laptop.keyboard.press("Escape");
await setSettings(laptop, { theme: "light", warm: "off" });
await laptop.goto(BASE + `#/read/${feelDoc}`);
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b");
await laptop.waitForTimeout(400);

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

// ═════════════ Word stories: how a word is made and where it comes from ═════════════
await laptop.goto(BASE + "#/library");
await laptop.waitForSelector("#view-library .view-head h1");
const anat = await laptop.evaluate(async () => {
  const { lexiconReady } = await import("/js/data/etymology.js");
  const { anatomy, sumUp } = await import("/js/data/morphology.js");
  await lexiconReady();
  const show = (w) => { const a = anatomy(w); return a ? a.parts.map((p) => p.text).join(" ") + " = " + sumUp(a) : null; };
  return Object.fromEntries(["fastest", "unbelievable", "transportation", "went", "children", "corner", "gently"].map((w) => [w, show(w)]));
});
ok(/^fast -est = the most fast$/.test(anat.fastest || ""), `“fastest” is fast + -est, “the most fast” (${anat.fastest})`);
ok(/^un- believe -able/.test(anat.unbelievable || ""), `“unbelievable” is un- + believe + -able (${anat.unbelievable})`);
ok(/^trans- port -ation|^transport -ation/.test(anat.transportation || ""), `transportation = transport + -ation (${anat.transportation})`);
const transport = await laptop.evaluate(async () => (await import("/js/data/morphology.js")).anatomy("transport")?.parts.map((p) => p.text + " (" + (p.meaning || "") + ")").join(" + "));
ok(/^trans- \(across.*port \(carry/.test(transport || ""), `Latin roots: transport = trans- (across) + port (carry) (${transport})`);
ok(/^go\b/.test(anat.went || "") && /^child\b/.test(anat.children || ""), "irregular forms lead back to their base: went → go, children → child");
ok(anat.corner === null, "a word in its own right isn't cut up (corner ≠ corn + -er)");
ok(/^gentle -ly/.test(anat.gently || ""), `gently → gentle + -ly (${anat.gently})`);
const wordCard = async (w, source = null) => {
  await laptop.evaluate(async ({ w, source }) => {
    const m = await import("/js/ui/definition.js");
    m.hideDefinition();
    m.showDefinition(w, { left: 500, top: 160, right: 560, bottom: 180, width: 60, height: 20 }, source, { sticky: true });
  }, { w, source });
  // the card that was open fades out first
  await laptop.waitForFunction(() => document.querySelectorAll(".defcard").length === 1, null, { timeout: 3000 }).catch(() => {});
};
await wordCard("fastest");
await laptop.waitForSelector(".defcard .ws-parts", { timeout: 8000 });
ok(/fast\s*the base word/.test(await laptop.locator(".defcard .ws-parts").innerText()) && /-est\s*the most/.test(await laptop.locator(".defcard .ws-parts").innerText()), "the card shows the parts and what each one means");
await laptop.waitForSelector(".defcard .ws-basebox", { timeout: 8000 }).catch(() => {});
ok(/Test meaning of fast/.test(await laptop.locator(".defcard .ws-basebox").innerText().catch(() => "")), "…and what the base word “fast” means, right there");
await laptop.waitForSelector(".defcard .ws-origin .ws-route", { timeout: 8000 }).catch(() => {});
const route = await laptop.locator(".defcard .ws-origin .ws-lang").allInnerTexts();
ok(route.join(" → ") === "Proto-Germanic → Old English → Middle English → English", `where it comes from, oldest first (${route.join(" → ")})`);
ok(/1901/.test(await laptop.locator(".defcard .ws-origin").innerText()), "Skeat's dictionary is quoted in the card");
await shot(laptop, "32-word-anatomy");
await laptop.locator(".defcard .ws-base-word").click();
await laptop.waitForFunction(() => document.querySelector(".defcard .def-word")?.textContent === "fast", null, { timeout: 6000 }).then(
  () => ok(true, "tapping the base word looks it up in the same card"), () => ok(false, "tapping the base word looks it up in the same card"));
await laptop.locator(".defcard .def-sense .tap-w").first().click();
await laptop.waitForTimeout(800);
const deeper = await laptop.locator(".defcard .def-word").textContent();
ok(deeper !== "fast", `any word in a meaning can be tapped too (→ “${deeper}”)`);
await laptop.locator(".defcard .def-back").click();
await laptop.waitForFunction(() => document.querySelector(".defcard .def-word")?.textContent === "fast", null, { timeout: 6000 }).catch(() => {});
await laptop.locator(".defcard .def-back").click();
await laptop.waitForFunction(() => document.querySelector(".defcard .def-word")?.textContent === "fastest", null, { timeout: 6000 }).then(
  () => ok(true, "Back walks the trail of looked-up words"), () => ok(false, "Back walks the trail of looked-up words"));
await laptop.waitForSelector(".defcard .ws-more", { timeout: 8000 });
await laptop.locator(".defcard .ws-more").click();
await laptop.waitForSelector(".research.in .ws-head", { timeout: 8000 });
await laptop.waitForSelector(".research .ws-src.skeat", { timeout: 8000 }).catch(() => {});
ok(await laptop.locator(".research .ws-src.skeat").count() >= 1 && /under “fast”/.test(await laptop.locator(".research .ws-src.skeat").first().innerText()), "the full story quotes Skeat's entries for the base word");
ok(/Today's dictionaries — “fast”/.test(await laptop.locator(".research").innerText()), "…and today's account of “fast”");
await laptop.evaluate(async () => (await import("/js/ui/research.js")).openResearch("elegant", { story: "elegant" }));
await laptop.waitForFunction(() => /Middle French/.test(document.querySelector(".research .ws-route")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
const eleg = await laptop.locator(".research .rs-body, .research").first().innerText();
ok(/e-\s*out of/.test(eleg) && /leg\s*choose/.test(eleg), "“elegant”: e- (out of) + leg (choose) + -ant");
ok(/Latin\s*→\s*Middle French\s*→\s*English/.test(eleg.replace(/\n/g, " ")), "“elegant” came from Latin through Middle French");
ok(/elegant, choice, neat/.test(eleg), "Skeat (1901): elegant, choice, neat — read from the scanned book");
await laptop.waitForSelector(".research .chip", { timeout: 8000 }).catch(() => {});
const fam = await laptop.locator(".research .ws-sec .chip").allInnerTexts();
ok(fam.includes("legend") && !fam.includes("phlegm"), `other words from the same root (${fam.join(", ")})`);
await shot(laptop, "33-word-story");
await laptop.locator('.research [aria-label="Close"]').click();
await laptop.goto(BASE + "#/words");
await laptop.waitForSelector(".word");
await laptop.locator(".word .word-main").first().click();
await laptop.waitForSelector(".word.open .word-story .ws-block, .word.open .word-story:empty", { timeout: 8000 }).catch(() => {});
ok(await laptop.locator(".word.open .word-story").count() === 1, "saved words show their story too");
ok(laptop.errors.length === 0, "no errors in word stories" + (laptop.errors.length ? ": " + laptop.errors.join(" | ") : ""));

// ═════════════ Several words at once, full forms, more from Wikipedia ═════════════
await laptop.keyboard.press("Escape");
await wordCard("fastest human");
await laptop.waitForSelector(".defcard .ph-together", { timeout: 8000 }).catch(() => {});
ok(/the human that is faster than any other/.test(await laptop.locator(".defcard .ph-together").textContent().catch(() => "")), "“fastest human” is put into plain words: the human that is faster than any other");
const wbwText = await laptop.locator(".defcard .ph-wordlist").innerText().catch(() => "");
ok(/fastest\s*the most fast\s*fast/.test(wbwText) && /human/.test(wbwText), "…and explained word by word, “fastest” through “fast”");
await laptop.waitForSelector(".defcard .ph-answer", { timeout: 8000 }).catch(() => {});
ok(/fastest human footspeed on record/.test(await laptop.locator(".defcard .ph-answer").textContent().catch(() => "")) && await laptop.locator(".defcard .ph-answer mark").count() >= 2,
  "Wikipedia's sentence that uses the phrase is quoted, with the words marked");
await shot(laptop, "34-phrase-card");
await laptop.locator(".defcard .def-save").click();
await until(laptop, async () => (await import("/js/data/store.js")).store.list("words").some((w) => w.word === "fastest human" && /faster than any other|footspeed/.test(w.meanings?.[0]?.defs?.[0]?.d || "")), null, { timeout: 5000 }).then(
  () => ok(true, "a phrase can be saved to your words, with its meaning"), () => ok(false, "a phrase can be saved to your words, with its meaning"));
await wordCard("kicked the bucket");
await laptop.waitForSelector(".defcard .ph-exact .ph-sense", { timeout: 8000 }).catch(() => {});
const idiom = await laptop.locator(".defcard .ph-exact").innerText().catch(() => "");
ok(/kick the bucket/i.test(idiom) && /To die/.test(idiom), "idioms are found even in another tense (kicked the bucket → kick the bucket: to die)"
  + (/To die/.test(idiom) ? "" : ` [card: ${(await laptop.locator(".defcard").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300)}]`));
// full forms: as the book defines it, the built-in list, Roman numerals
await laptop.evaluate(async () => (await import("/js/data/db.js")).idb.put("texts", { id: "abbr-book", pages: ["Growth slowed. Gross Domestic Product (GDP) rose 7% while the Reserve Bank of India (RBI) held rates."] }));
await wordCard("GDP", { docId: "abbr-book", page: 1 });
await laptop.waitForSelector(".defcard .ph-full-list", { timeout: 8000 }).catch(() => {});
const gdp = await laptop.locator(".defcard .ph-full").innerText().catch(() => "");
ok(/Gross Domestic Product/.test(gdp) && /as this book defines it, p\. 1/.test(gdp), "full forms come from the book itself first (GDP = Gross Domestic Product, p. 1)");
ok(await laptop.locator(".defcard .ws-parts").count() === 0, "an abbreviation isn't cut into word parts");
await shot(laptop, "35-full-form");
await wordCard("e.g.");
await laptop.waitForSelector(".defcard .ph-full-list", { timeout: 8000 }).catch(() => {});
ok(/exempli gratia \(for example\)/.test(await laptop.locator(".defcard .ph-full").innerText().catch(() => "")), "common abbreviations work offline: e.g. = exempli gratia (for example)");
await wordCard("XIV");
await laptop.waitForSelector(".defcard .ph-full-list", { timeout: 8000 }).catch(() => {});
ok(/14 \(the Roman numeral\)/.test(await laptop.locator(".defcard .ph-full").innerText().catch(() => "")), "Roman numerals are read: XIV = 14");
await laptop.evaluate(async () => (await import("/js/ui/definition.js")).hideDefinition());
// selecting several words in a book
const riverId = (await docIds(laptop))["The River Cottage"];
await laptop.goto(BASE + `#/read/${riverId}`);
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b", { timeout: 15000 });
await laptop.waitForTimeout(600);
const picked = await laptop.evaluate(() => {
  const w = document.createTreeWalker(document.querySelector(".tab-pane.active .bk-flow"), NodeFilter.SHOW_TEXT);
  const clip = document.querySelector(".tab-pane.active .bk-clip").getBoundingClientRect();
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf("old cottage");
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 11);
    const b = r.getClientRects()[0];
    if (!b || b.left < clip.left || b.right > clip.right) continue;
    getSelection().removeAllRanges(); getSelection().addRange(r);
    return true;
  }
  return false;
});
if (picked) {
  await laptop.waitForSelector(".selbar.in", { timeout: 4000 }).catch(() => {});
  await laptop.locator(".selbar-btn", { hasText: "Define" }).click({ timeout: 4000 }).catch(() => {});
  await laptop.waitForSelector(".defcard .ph-wordlist", { timeout: 8000 }).catch(() => {});
}
ok(picked && (await laptop.locator(".defcard .def-phrase").textContent().catch(() => "")) === "old cottage" && /cottage/.test(await laptop.locator(".defcard .ph-wordlist").innerText().catch(() => "")),
  "select two words and Define: their meaning together and one by one");
await shot(laptop, "36-define-selection");
await laptop.keyboard.press("Escape");
// Look it up: the phrase, and an article's key facts, pictures and related articles
await laptop.evaluate(async () => (await import("/js/ui/research.js")).openResearch("fastest human"));
await laptop.waitForSelector(".research .rs-phrase .ph-answer", { timeout: 8000 }).then(() => ok(true, "Look it up explains a phrase too, with Wikipedia's answer"), () => ok(false, "Look it up explains a phrase too, with Wikipedia's answer"));
await laptop.evaluate(async () => (await import("/js/ui/research.js")).openResearch("lamplighter", { article: "Lamplighter" }));
await laptop.waitForSelector(".research .rs-facts", { timeout: 8000 }).catch(() => {});
const factsTxt = await laptop.locator(".research .rs-facts").innerText().catch(() => "");
ok(/Occupation type\s*Street work/.test(factsTxt) && /Public lighting; Local government/.test(factsTxt) && !/\[1\]/.test(factsTxt), "articles show their key facts (from the infobox, without footnote marks)");
await laptop.waitForSelector(".research .rs-pic", { timeout: 8000 }).catch(() => {});
ok(await laptop.locator(".research .rs-pic").count() === 3, "…the article's pictures");
await laptop.waitForSelector(".research .rs-related", { timeout: 8000 }).catch(() => {});
ok(/Gas lighting/.test(await laptop.locator(".research .rs-related").innerText().catch(() => "")), "…and related articles");
await laptop.locator(".research .rs-pic").first().click();
await laptop.waitForSelector("dialog.lightbox[open]", { timeout: 3000 }).then(() => ok(true, "a picture opens large, with its caption"), () => ok(false, "a picture opens large, with its caption"));
await shot(laptop, "37-picture");
await laptop.keyboard.press("Escape");
await laptop.waitForTimeout(300);
ok(await laptop.locator("dialog.lightbox[open]").count() === 0 && await laptop.locator(".research").count() === 1, "Esc closes the picture, not the article");
await laptop.locator(".research .rs-body").evaluate((b) => b.scrollTo(0, 260));
await shot(laptop, "38-article-facts");
await laptop.locator('.research [aria-label="Close"]').click();
ok(laptop.errors.length === 0, "no errors with phrases and full forms" + (laptop.errors.length ? ": " + laptop.errors.join(" | ") : ""));

// ═════════════ Scanned books: read every page on the device, then show the book ═════════════
await laptop.goto(BASE + "#/library");
await laptop.waitForSelector("#view-library .view-head h1");
await laptop.setInputFiles("#file-input", [FIX("scanned.pdf")]);
await until(laptop, async () => (await import("/js/data/store.js")).store.list("docs").some((d) => d.title === "scanned"), null, { timeout: 10000 }).catch(() => {});
const scannedDoc = await laptop.evaluate(async () => (await import("/js/data/store.js")).store.list("docs").find((d) => d.title === "scanned")?.id);
if (!(await laptop.locator(".ocr-card").count())) await laptop.goto(BASE + `#/read/${scannedDoc}`);
await laptop.waitForSelector(".ocr-card", { timeout: 20000 }).then(() => ok(true, "a scanned PDF shows one progress screen while every page is read"), () => ok(false, "a scanned PDF shows one progress screen while every page is read"));
await shot(laptop, "39-scan-progress");
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b", { timeout: 120000 }).catch(() => {});
await laptop.waitForTimeout(600);
const scannedText = (await laptop.locator(".tab-pane.active .bk-flow").innerText().catch(() => "")).replace(/\s+/g, " ");
ok(/Critics called the ending ambiguous, yet its perspicacious narrator had warned us/.test(scannedText) && await laptop.locator(".ocr-card").count() === 0,
  "…then the whole book opens in Book view as text, paragraphs joined");
ok(!/The Lamplighter's Notebook/.test(scannedText), "the scan's running header is left out of the text");
await shot(laptop, "40-scan-book");
const scanWord = await laptop.evaluate(() => {
  const w = document.createTreeWalker(document.querySelector(".tab-pane.active .bk-flow"), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf("perspicacious");
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i + 3); r.setEnd(n, i + 4);
    const b = r.getBoundingClientRect();
    if (b.width) return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }
  return null;
});
if (scanWord) { await hover(laptop, scanWord); await laptop.waitForSelector(".defcard", { timeout: 5000 }).catch(() => {}); }
ok(scanWord && (await laptop.locator(".defcard .def-word").textContent().catch(() => "")) === "perspicacious", "words in a scanned book can be looked up");
await laptop.keyboard.press("Escape");
await laptop.evaluate(() => window.__luma.reader.tabs.get(window.__luma.reader.active).setMode("pdf"));
await laptop.waitForSelector(".tab-pane.active .page .textLayer.ocrLayer .ocr-l", { state: "attached", timeout: 8000 }).catch(() => {});
ok(await laptop.locator(".tab-pane.active .page[data-page-number='1'] .ocrLayer .ocr-l").count() > 50, "Page view gets an invisible text layer over the scan (hover, select, highlight)");
const scanId = await laptop.evaluate(() => window.__luma.reader.active);
ok(await laptop.evaluate(async (id) => (await (await import("/js/data/store.js")).store.kvGet("ocr:" + id))?.pages?.length === 3, scanId), "what was read is kept, so the book is read only once");
await until(laptop, async () => (await (await import("/js/data/fulltext.js")).searchBooks("pragmatic rather than idealistic")).some((r) => r.doc.title === "scanned"), null, { timeout: 15000 }).then(
  () => ok(true, "a scanned book can be searched inside"), () => ok(false, "a scanned book can be searched inside"));
ok(laptop.errors.length === 0, "no errors with scanned books" + (laptop.errors.length ? ": " + laptop.errors.join(" | ") : ""));

// ═════════════ Translation: English ⇄ Hindi, a passage or a whole book ═════════════
const river = await laptop.evaluate(async () => (await import("/js/data/store.js")).store.list("docs").find((d) => d.title === "The River Cottage")?.id);
await laptop.goto(BASE + `#/read/${river}`);
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b", { timeout: 15000 });
await laptop.waitForTimeout(500);
const selectIn = (pg, phrase) => pg.evaluate((phrase) => {
  const w = document.createTreeWalker(document.querySelector(".tab-pane.active .bk-flow"), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf(phrase);
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + phrase.length);
    getSelection().removeAllRanges(); getSelection().addRange(r);
    return true;
  }
  return false;
}, phrase);
await selectIn(laptop, "the old cottage by the river");
await laptop.waitForSelector(".selbar.in", { timeout: 4000 }).catch(() => {});
await laptop.waitForTimeout(700); // the toolbar follows the new selection
await laptop.locator(".selbar-btn", { hasText: "Translate" }).click();
await laptop.waitForSelector(".defcard .tr-text", { timeout: 8000 }).catch(() => {});
const trCard = await laptop.locator(".defcard").innerText().catch(() => "");
ok(/कुटिया/.test(trCard) && /नदी/.test(trCard) && /Translated on this device/.test(trCard), "select a passage and Translate: English → Hindi, on the device");
ok(await laptop.locator('.defcard .tr-out[lang="hi"]').count() === 1, "the translation is marked as Hindi (Devanagari type, a Hindi voice)");
await shot(laptop, "41-translate-card");
await laptop.locator(".defcard .tr-actions .btn", { hasText: "Correct" }).click();
await laptop.locator(".defcard .tr-edit textarea").fill("नदी किनारे की पुरानी कुटिया");
await laptop.locator(".defcard .tr-edit .btn.primary").click();
await laptop.keyboard.press("Escape");
await laptop.waitForTimeout(300);
await selectIn(laptop, "the old cottage by the river");
await laptop.waitForSelector(".selbar.in", { timeout: 4000 }).catch(() => {});
await laptop.waitForTimeout(700); // the toolbar follows the new selection
await laptop.locator(".selbar-btn", { hasText: "Translate" }).click();
await laptop.waitForSelector(".defcard .tr-text", { timeout: 8000 }).catch(() => {});
ok((await laptop.locator(".defcard .tr-text").innerText().catch(() => "")) === "नदी किनारे की पुरानी कुटिया" && /Your correction/.test(await laptop.locator(".defcard .tr-note").innerText().catch(() => "")),
  "your correction is remembered and used next time");
await laptop.keyboard.press("Escape");
await laptop.waitForTimeout(300);
await wordCard("पानी");
await laptop.waitForSelector(".defcard .tr-dict", { timeout: 8000 }).catch(() => {});
const hiWord = await laptop.locator(".defcard").innerText().catch(() => "");
ok(/water/.test(await laptop.locator(".defcard .tr-text").innerText().catch(() => "")) && /noun — water; rain/i.test(hiWord), "a Hindi word gives its English, with the Hindi → English dictionary");
await laptop.keyboard.press("Escape");
await laptop.waitForTimeout(300);
// the whole book, then both side by side
await laptop.locator('.reader-actions [data-action="translate"]').click();
await laptop.waitForSelector(".tr-pop .btn.primary", { timeout: 8000 }).catch(() => {});
ok(/English\s*→\s*हिन्दी/.test(await laptop.locator(".tr-pop .tr-pair").innerText().catch(() => "")), "an English book is translated into Hindi");
await laptop.locator(".tr-pop .btn.primary").click();
await laptop.waitForSelector(".tr-screen", { timeout: 8000 }).then(() => ok(true, "the whole book is translated first, behind one progress screen"), () => ok(false, "the whole book is translated first, behind one progress screen"));
await laptop.waitForSelector(".tab-pane.active .bk-flow .bk-tr", { timeout: 60000 }).catch(() => {});
await laptop.waitForTimeout(500);
ok(await laptop.locator('.tab-pane.active .bk-flow .bk-tr[lang="hi"]').count() >= 4, "…then each paragraph shows with its Hindi translation under it");
await shot(laptop, "42-translated-both");
ok(await until(laptop, async () => (await import("/js/data/store.js")).store.list("settings").some((r) => r.kind === "translation"), null, { timeout: 5000 }).then(() => true, () => false),
  "the translation is saved with your account, to read on your phone");
await laptop.locator('.reader-actions [data-action="translate"]').click();
await laptop.waitForSelector(".tr-pop .tr-modes", { timeout: 8000 });
await laptop.locator(".tr-pop .tr-modes button").nth(2).click();
await laptop.waitForTimeout(800);
await laptop.keyboard.press("Escape");
ok(await laptop.evaluate(() => document.querySelector(".tab-pane.active .bk-flow").lang) === "hi" && /[\u0900-\u097F]/.test(await laptop.locator(".tab-pane.active .bk-flow p.bk-b").first().innerText()),
  "or read the Hindi on its own");
ok(await laptop.evaluate(() => Boolean(window.__luma.reader.tabs.get(window.__luma.reader.active).readModel)), "Listen then reads the Hindi (in a Hindi voice)");
await shot(laptop, "43-translated-only");
await laptop.evaluate(async () => (await import("/js/ui/translatepanel.js")).setBookTranslation(window.__luma.reader.tabs.get(window.__luma.reader.active), "original"));
// a Hindi book: read from its scanned page, then translated into English
await laptop.goto(BASE + "#/library");
await laptop.waitForSelector("#view-library .view-head h1");
await laptop.setInputFiles("#file-input", [FIX("hindi-scan.pdf")]);
await until(laptop, async () => (await import("/js/data/store.js")).store.list("docs").some((d) => d.title === "hindi-scan"), null, { timeout: 10000 }).catch(() => {});
const hindiDoc = await laptop.evaluate(async () => (await import("/js/data/store.js")).store.list("docs").find((d) => d.title === "hindi-scan")?.id);
if (!(await laptop.locator(".tr-screen, .ocr-card").count())) await laptop.goto(BASE + `#/read/${hindiDoc}`);
await laptop.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b", { timeout: 120000 }).catch(() => {});
await laptop.waitForTimeout(500);
const hindiText = (await laptop.locator(".tab-pane.active .bk-flow").innerText().catch(() => "")).replace(/\s+/g, " ");
ok(/नदी के किनारे एक पुरानी कुटिया थी/.test(hindiText), "a scanned Hindi page is read in Hindi (the right reading model is picked by itself)");
await laptop.locator('.reader-actions [data-action="translate"]').click();
await laptop.waitForSelector(".tr-pop .btn.primary", { timeout: 8000 }).catch(() => {});
ok(/हिन्दी\s*→\s*English/.test(await laptop.locator(".tr-pop .tr-pair").innerText().catch(() => "")), "a Hindi book is translated into English");
await laptop.locator(".tr-pop .btn.primary").click();
await laptop.waitForSelector('.tab-pane.active .bk-flow .bk-tr[lang="en"]', { timeout: 60000 }).catch(() => {});
ok((await laptop.locator('.tab-pane.active .bk-flow .bk-tr[lang="en"]').allInnerTexts()).join(" ").includes("river"), "…with the English under each Hindi paragraph");
await shot(laptop, "44-hindi-book-english");
ok(laptop.errors.length === 0, "no errors with translation" + (laptop.errors.length ? ": " + laptop.errors.join(" | ") : ""));

// Google Drive: books and everything else, with no Firebase
await laptop.goto(BASE + "#/settings");
await settingsPage(laptop, "Google Drive");
ok(await laptop.locator(".set-nav-item").count() >= 8 && await laptop.evaluate(() => document.querySelector(".set-pane").getBoundingClientRect().width > innerWidth * 0.6), "laptop settings: a sidebar of pages, the page fills the window");
await laptop.locator(".btn", { hasText: "Connect Google Drive" }).click();
await laptop.waitForFunction(() => window.__luma.drive.status === "synced", null, { timeout: 30000 }).catch(() => {});
const files = [...driveFiles.values()];
ok(files.some((f) => f.appProperties?.luma === "sync") && files.filter((f) => f.appProperties?.lumaId).length >= 8, `books and library are saved to Google Drive (${files.filter((f) => f.appProperties?.lumaId).length} book files)`);
await shot(laptop, "28-drive-settings");
const tablet = await newDevice("tablet", { viewport: { width: 1180, height: 820 } });
await tablet.goto(BASE + "#/settings");
await settingsPage(tablet, "Google Drive");
await tablet.locator(".btn", { hasText: "Connect Google Drive" }).click();
await tablet.waitForFunction(() => window.__luma.drive.status === "synced", null, { timeout: 30000 }).catch(() => {});
await tablet.goto(BASE + "#/library");
await tablet.waitForFunction(() => document.querySelectorAll(".book").length >= 8, null, { timeout: 10000 }).then(
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
await until(phone, async () => (await import("/js/data/store.js")).store.list("settings").some((r) => r.kind === "translation"), null, { timeout: 15000 }).catch(() => {});
await phone.evaluate(async () => { const id = (await import("/js/data/store.js")).store.list("docs").find((d) => d.title === "The River Cottage")?.id; location.hash = `#/read/${id}`; });
await phone.waitForSelector(".tab-pane.active .bookview:not([hidden]) .bk-b", { timeout: 15000 }).catch(() => {});
await phone.evaluate(async () => (await import("/js/ui/translatepanel.js")).setBookTranslation(window.__luma.reader.tabs.get(window.__luma.reader.active), "both"));
await phone.waitForSelector('.tab-pane.active .bk-flow .bk-tr[lang="hi"]', { timeout: 10000 }).then(
  () => ok(true, "the book translated on the laptop reads in Hindi on the phone"), () => ok(false, "the book translated on the laptop reads in Hindi on the phone"));
await shot(phone, "30b-phone-translated");
await phone.evaluate(async () => (await import("/js/ui/translatepanel.js")).setBookTranslation(window.__luma.reader.tabs.get(window.__luma.reader.active), "original"));
await phone.evaluate(async () => (await import("/js/ui/definition.js")).showTranslation("Thank you for the tea", { left: 40, top: 300, right: 200, bottom: 320, width: 160, height: 20 }));
await phone.waitForSelector(".defcard .tr-text", { timeout: 8000 }).catch(() => {});
ok(/Translated online/.test(await phone.locator(".defcard .tr-note").innerText().catch(() => "")), "on the phone, a passage is translated online (no built-in translator)");
await shot(phone, "30c-phone-translate-card");
await phone.evaluate(async () => (await import("/js/ui/definition.js")).hideDefinition());
await phone.goto(BASE + "#/library");
await phone.locator(".book", { hasText: "The River Cottage" }).locator(".card-more").click();
await phone.locator(".menu-item", { hasText: "Listen from where you stopped" }).click();
await phone.waitForSelector(".player", { timeout: 10000 }).then(() => ok(true, "“Listen” on the library card opens the book and starts reading aloud"), () => ok(false, "“Listen” on the library card opens the book and starts reading aloud"));
await phone.locator('.player [aria-label="Stop reading aloud"]').click().catch(() => {});
await phone.evaluate(async () => (await import("/js/ui/research.js")).openResearch("lamplighter", { article: "Lamplighter" }));
await phone.waitForSelector(".research.in .rs-art-title", { timeout: 5000 });
const sheet = await phone.locator(".research").boundingBox();
const vw = await phone.evaluate(() => innerWidth);
ok(Math.abs(sheet.width - vw) < 2 && sheet.y > 20, "on phones, look-up opens as a sheet from the bottom");
await phone.waitForTimeout(350);
await shot(phone, "31b-phone-look-it-up");
await phone.locator('.research [aria-label="Close"]').click();
await phone.goto(BASE + "#/insights");
await phone.waitForSelector(".ins-body", { timeout: 8000 });
await phone.waitForTimeout(500);
ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Insights fits a phone screen");
await shot(phone, "31c-phone-insights");
await phone.goto(BASE + "#/library");
await phone.waitForSelector(".light-btn");
const pm0 = await phone.evaluate(() => document.documentElement.dataset.mode);
await phone.locator(".light-btn").click();
await phone.waitForFunction((m) => document.documentElement.dataset.mode !== m, pm0, { timeout: 3000 }).then(() => ok(true, "phones get the light switch on the Library page"), () => ok(false, "phones get the light switch on the Library page"));
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
