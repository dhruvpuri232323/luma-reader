// End-to-end test of Luma Reader in real Chromium (laptop + phone viewports),
// including two-device sync through an in-memory stand-in for Firestore.
//
//   npm install            (installs Playwright)
//   npx playwright install chromium
//   npm start              (in another terminal)
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
let lastStep = "";
const ok = (cond, msg) => { for (const pg of (globalThis.__pages || [])) pg.lastStep = msg; console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; };
const shot = (page, name) => page.screenshot({ path: join(OUT, name + ".png") });

const dictionary = (w) => [{
  word: w, phonetic: `/${w}/`, phonetics: [{ text: `/${w}/` }],
  meanings: [{ partOfSpeech: "adjective", definitions: [{ definition: `Test meaning of ${w}.`, example: `A ${w} example.`, synonyms: ["bright"], antonyms: [] }], synonyms: ["radiant"], antonyms: ["dim"] }],
}];

// ── a tiny fake "cloud" shared by both devices ──
const cloud = { seq: 0, rows: [] };
function cloudWrite(coll, rec) {
  cloud.rows = cloud.rows.filter((r) => !(r.coll === coll && r.rec.id === rec.id));
  cloud.rows.push({ coll, rec, seq: ++cloud.seq });
}
const cloudPull = (coll, since) => ({ seq: cloud.seq, recs: cloud.rows.filter((r) => r.coll === coll && r.seq > since).map((r) => r.rec) });

const adapterScript = () => {
  const user = { uid: "test-user", name: "Test Reader", email: "reader@example.com" };
  let authCb;
  let signedIn = localStorage.getItem("test.signedIn") === "1";
  window.__LUMA_TEST_ADAPTER__ = {
    name: "test",
    cloudPdfs: false,
    onAuth(cb) { authCb = cb; setTimeout(() => cb(signedIn ? user : null), 0); return () => {}; },
    async signIn() { signedIn = true; localStorage.setItem("test.signedIn", "1"); authCb(user); },
    async signOut() { signedIn = false; localStorage.removeItem("test.signedIn"); authCb(null); },
    listen(uid, coll, onRecords) {
      let since = 0;
      let alive = true;
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
};

async function newDevice(browser, name, opts = {}) {
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block", acceptDownloads: true });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ctx.route(/api\.dictionaryapi\.dev/, (r) => {
    const w = decodeURIComponent(r.request().url().split("/").pop());
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dictionary(w)) });
  });
  await ctx.exposeFunction("cloudWrite", cloudWrite);
  await ctx.exposeFunction("cloudPull", cloudPull);
  await ctx.addInitScript(adapterScript);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) page.errors.push(m.text() + (process.env.TRACE ? " @" + JSON.stringify(m.location()) + " after: " + page.lastStep : "")); });
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
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, left: b.left, right: b.right };
    }
    return null;
  }, { word, pageNo });
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

const browser = await chromium.launch();
const pages = []; globalThis.__pages = pages;
const crash = async (e) => { console.error("✗ CRASH:", e.message.split("\n").slice(0,6).join("\n")); for (const pg of pages) { console.error(pg.device, "errors:", pg.errors); await shot(pg, "crash-" + pg.device).catch(() => {}); } process.exit(1); };
process.on("unhandledRejection", crash);
process.on("uncaughtException", crash);

// ═════════════ Laptop ═════════════
const laptop = await newDevice(browser, "laptop", { viewport: { width: 1360, height: 860 } });
await laptop.goto(BASE);
await laptop.waitForSelector(".view-head h1");
ok(await laptop.locator("#view-library .empty h2").isVisible(), "empty library invites the first import");
await shot(laptop, "01-laptop-empty");

await laptop.setInputFiles("#file-input", [FIX("lamplighter.pdf"), FIX("companion.pdf")]);
await laptop.waitForFunction(() => document.querySelectorAll(".book").length === 2);
ok(true, "imports two PDFs");
await laptop.setInputFiles("#file-input", [FIX("lamplighter.pdf")]);
await laptop.waitForSelector(".toast:has-text('already in your library')");
ok(await laptop.locator(".book").count() === 2, "duplicate PDF is detected by its SHA-256 hash");

const lampCard = laptop.locator(".book", { hasText: "Lamplighter" });
await lampCard.locator(".book-open").click();
await laptop.waitForSelector(".tab-pane.active .page[data-page-number='1'] .textLayer span", { state: "attached" });
await laptop.waitForTimeout(500);
ok(await laptop.locator(".reader-bottom .page-box").textContent() === "of 12", "reader opens with page count");

// hover dictionary
let p;
await laptop.evaluate(() => document.querySelector(".page[data-page-number='2']").scrollIntoView());
await laptop.waitForSelector(".page[data-page-number='2'] .textLayer span", { state: "attached" });
p = await pointAtWord(laptop, "luminous", 2);
ok(Boolean(p), "found the word 'luminous' in the text layer");
await laptop.mouse.move(p.x, p.y);
await laptop.mouse.move(p.x + 1, p.y);
await laptop.waitForSelector(".defcard .def-body", { timeout: 4000 });
ok((await laptop.locator(".def-word").textContent()) === "luminous", "hover shows the definition card");
await shot(laptop, "02-laptop-hover-definition");
await laptop.locator(".def-save").click();
await laptop.waitForSelector(".def-save.on");
ok(true, "one click saves the word");
await laptop.mouse.move(5, 400);
await laptop.waitForTimeout(700);
await laptop.evaluate(() => document.querySelector(".page[data-page-number='1']").scrollIntoView());
await laptop.waitForTimeout(300);

// highlight + note
const selected = await selectText(laptop, "Critics", "chapter.");
ok(selected.startsWith("Critics"), "text selection in the PDF");
await laptop.waitForSelector(".selbar.in");
await shot(laptop, "03-laptop-selection-toolbar");
await laptop.locator(".selbar-color").nth(1).click();
await laptop.waitForSelector(".page[data-page-number='1'] .hl[data-color='mint']");
ok(true, "green highlight drawn on the original page layout");
await selectText(laptop, "ephemeral", "outlast");
await laptop.waitForSelector(".selbar.in");
await laptop.locator(".selbar-btn", { hasText: "Note" }).click();
await laptop.locator("dialog textarea").fill("Write ideas down immediately.");
await laptop.locator("dialog .btn.primary").click();
await laptop.waitForSelector(".page[data-page-number='1'] .hl.has-note");
ok(true, "note saved with its highlight");

// bookmark + panel
await laptop.keyboard.press("b");
await laptop.waitForSelector('.reader-actions [data-action="bookmark"].on');
ok(true, "B bookmarks the current page");
await laptop.locator('[data-action="toc"]').click();
await laptop.waitForSelector(".toc-item");
ok(await laptop.locator(".toc-item").count() === 4, "PDF outline shows as clickable contents");
await laptop.locator(".toc-item", { hasText: "The Committee" }).click();
await laptop.waitForFunction(() => document.querySelector(".reader-bottom .page-input")?.value === "7");
ok(true, "contents entry jumps to page 7");
await laptop.locator(".seg button", { hasText: "Notes" }).click();
ok(await laptop.locator(".side-panel .note-item").count() === 2, "notes panel lists both highlights");
ok(/narrator had warned/.test(await laptop.locator(".side-panel .note-item").first().textContent()), "highlight text keeps spaces across line breaks");
await shot(laptop, "04-laptop-notes-panel");

// search
await laptop.keyboard.press("Control+f");
await laptop.locator(".side-panel .search-input").fill("perspicacious");
await laptop.keyboard.press("Enter");
await laptop.waitForFunction(() => /matches/.test(document.querySelector(".search-results")?.textContent || ""));
const matchText = await laptop.locator(".search-results p").first().textContent();
ok(/^\d+ matches/.test(matchText), `search finds results (${matchText})`);
await laptop.locator(".search-results .item-main").nth(2).click();
await laptop.waitForSelector(".textLayer .highlight", { state: "attached", timeout: 5000 }).catch(() => {});
ok(await laptop.locator(".textLayer .highlight").count() > 0, "search matches are highlighted on the page");
await shot(laptop, "05-laptop-search");
await laptop.locator(".side-panel .panel-head .icon-btn").click();

// zoom, page jump, keyboard
const before = await laptop.locator(".zoom-val").textContent();
await laptop.locator('[aria-label="Zoom in (+)"]').click();
await laptop.waitForTimeout(300);
ok((await laptop.locator(".zoom-val").textContent()) !== before, "zoom changes scale");
await laptop.locator(".reader-bottom .page-input").fill("10");
await laptop.locator(".reader-bottom .page-input").press("Enter");
await laptop.waitForTimeout(500);
ok((await laptop.locator(".reader-bottom .page-input").inputValue()) === "10", "page number jump");

// reflow
await laptop.locator('[data-action="reflow"]').click();
await laptop.waitForSelector(".reflow-page[data-page='10'] p");
ok(await laptop.locator(".reflow:not([hidden])").isVisible(), "reflow mode shows extracted text");
p = await laptop.evaluate(() => {
  const para = document.querySelector(".reflow-page[data-page='10'] p");
  para.scrollIntoView({ block: "center" });
  const t = para.firstChild; const i = t.data.search(/\b\w{7,}\b/);
  const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 4);
  const b = r.getBoundingClientRect(); return { x: b.left + 4, y: b.top + b.height / 2 };
});
await laptop.mouse.move(p.x, p.y); await laptop.mouse.move(p.x + 1, p.y);
await laptop.waitForSelector(".defcard .def-body", { timeout: 4000 }).catch(() => {});
ok(await laptop.locator(".defcard").count() === 1, "dictionary hover works in reflow mode too");
await shot(laptop, "06-laptop-reflow");
await laptop.mouse.move(5, 400);
await laptop.locator('[data-action="reflow"]').click();

// compare & tabs
await laptop.locator('[data-action="compare"]').click();
await laptop.locator(".pick-list button", { hasText: "Companion" }).click();
await laptop.waitForSelector(".compare-page");
ok(true, "comparison pane renders a second PDF");
await laptop.locator('.compare [aria-label="Next page"]').click();
await laptop.waitForFunction(() => document.querySelector(".compare .page-input")?.value === "2");
ok(true, "comparison pane has its own page controls");
await shot(laptop, "07-laptop-compare");
await laptop.locator('[aria-label="Close comparison"]').click();
await laptop.goto(BASE + "#/library");
await laptop.locator(".book", { hasText: "Companion" }).locator(".book-open").click();
await laptop.waitForSelector(".tab", { hasText: "Companion" });
ok(await laptop.locator(".tab").count() === 2, "two books open as tabs");
const pageBefore = await laptop.evaluate(() => [...window.__luma.reader.tabs.values()].find((t) => /Lamp/.test(t.doc.title)).page);
await laptop.locator(".tab-label", { hasText: "Lamplighter" }).click();
await laptop.waitForTimeout(600);
const pageAfter = await laptop.locator(".reader-bottom .page-input").inputValue();
console.log("  page before/after switch:", pageBefore, pageAfter);
await laptop.waitForFunction((p) => document.querySelector(".reader-bottom .page-input")?.value === String(p), pageBefore);
ok(true, "switching tabs keeps your place");
await laptop.reload();
await laptop.waitForSelector(".tab");
ok(await laptop.locator(".tab").count() === 2, "open tabs are restored after reopening");

// library progress
await laptop.goto(BASE + "#/library");
await laptop.waitForSelector(".continue");
ok(await laptop.waitForFunction(() => /Lamplighter/.test(document.querySelector(".continue-title")?.textContent), null, { timeout: 4000 }).then(() => true, () => false),
  "continue-reading card shows the book read most recently");
const laptopPage = (await laptop.locator(".continue .muted").nth(1).textContent()).match(/Page (\d+)/)[1];
await shot(laptop, "08-laptop-library-progress");

// words
await laptop.goto(BASE + "#/words");
await laptop.waitForSelector(".word");
ok((await laptop.locator(".word-w").first().textContent()) === "luminous", "saved word appears in Words");
await laptop.locator(".word-main").first().click();
ok(/Lamplighter/.test(await laptop.locator(".word-detail").textContent()), "word remembers its book and page");
ok(await laptop.locator(".word-detail .quote").count() === 1, "word keeps the sentence it came from");
await laptop.locator('.word-side [aria-label^="More for"]').first().click();
await laptop.locator(".menu-item", { hasText: "Edit" }).click();
await laptop.locator('dialog [name="mnemonic"]').fill("LUMINous: a lamp is ON");
await laptop.locator("dialog .btn.primary").click();
await laptop.waitForSelector(".def-mine.trick");
ok(true, "memory trick saved");
await shot(laptop, "09-laptop-words");
await laptop.locator(".btn", { hasText: /Review 1 due/ }).click();
await laptop.locator(".flashcard").click();
await laptop.waitForSelector(".grade");
await shot(laptop, "10-laptop-review");
await laptop.locator(".grade.good").click();
await laptop.waitForSelector(".fc-word:has-text('All caught up')");
ok(true, "spaced-repetition review schedules the word");
await laptop.locator("dialog .btn.primary").click();
const [csv] = await Promise.all([laptop.waitForEvent("download"), laptop.locator(".btn", { hasText: "CSV" }).click()]);
ok(/luma-words-.*\.csv/.test(csv.suggestedFilename()), "CSV export downloads");

// notes view + markdown
await laptop.goto(BASE + "#/notes");
await laptop.waitForSelector(".note-item");
ok(await laptop.locator(".note-item").count() === 2, "Notes view lists highlights across books");
const [md] = await Promise.all([laptop.waitForEvent("download"), laptop.locator(".btn", { hasText: "Export Markdown" }).click()]);
ok(/\.md$/.test(md.suggestedFilename()), "Markdown export downloads");

// settings + backup + sign in
await laptop.goto(BASE + "#/settings");
await laptop.locator("#view-settings .seg button", { hasText: /^Dark$/ }).first().click();
ok(await laptop.waitForFunction(() => document.documentElement.dataset.theme === "dark").then(() => true, () => false), "dark theme applies");
await shot(laptop, "11-laptop-settings-dark");
await laptop.locator("#view-settings .seg button", { hasText: /^Light$/ }).first().click();
const [bk] = await Promise.all([laptop.waitForEvent("download"), laptop.locator(".btn", { hasText: "Without PDFs" }).click()]);
ok(/luma-backup/.test(bk.suggestedFilename()), "portable backup downloads");
await laptop.locator(".btn", { hasText: "Sign in with Google" }).click();
await laptop.waitForSelector(".sync-chip[data-status='synced']", { timeout: 8000 });
ok(true, "signing in syncs everything up");
ok(cloud.rows.some((r) => r.coll === "words" && r.rec.id === "luminous"), "word reached the cloud");
ok(laptop.errors.length === 0, "no errors on laptop" + (laptop.errors.length ? ": " + laptop.errors.join(" | ") : ""));

// ═════════════ Phone ═════════════
const phone = await newDevice(browser, "phone", { ...devices["Pixel 7"] });
await phone.goto(BASE + "#/settings");
await phone.locator(".btn", { hasText: "Sign in with Google" }).click();
await phone.goto(BASE + "#/library");
await phone.waitForFunction(() => document.querySelectorAll(".book").length === 2, null, { timeout: 8000 });
ok(true, "phone receives the library from the laptop");
ok(await phone.locator(".book.remote").count() === 2, "books show as 'on another device' until the PDF is added");
await shot(phone, "12-phone-library-synced");
await phone.waitForSelector(".continue");
ok(/Lamplighter/.test(await phone.locator(".continue-title").textContent()), "reading progress synced to phone");

await phone.locator(".book", { hasText: "Lamplighter" }).locator(".book-open").click();
await phone.waitForSelector(".pane-msg");
await shot(phone, "13-phone-missing-file");
await phone.setInputFiles(".pane-msg input[type=file]", FIX("lamplighter.pdf"));
await phone.waitForSelector(".tab-pane.active .page .textLayer span", { state: "attached", timeout: 10000 });
await phone.waitForTimeout(600);
ok((await phone.locator(".reader-bottom .page-input").inputValue()) === laptopPage, `phone opens the book at the laptop's page (${laptopPage})`);

await phone.locator(".reader-bottom .page-input").fill("1");
await phone.locator(".reader-bottom .page-input").press("Enter");
await phone.waitForTimeout(600);
ok(await phone.locator(".page[data-page-number='1'] .hl").count() >= 2, "highlights synced to phone");
p = await pointAtWord(phone, "laconic");
await phone.touchscreen.tap(p.x, p.y);
await phone.waitForSelector(".defcard .def-body", { timeout: 4000 }).catch(() => {});
ok((await phone.locator(".def-word").textContent().catch(() => "")) === "laconic", "single tap defines a word on the phone");
await shot(phone, "14-phone-tap-definition");
await phone.locator(".def-save").click();
await phone.locator(".def-close").click();

await phone.locator('.reader-actions [aria-label="More"]').click();
await shot(phone, "15-phone-more-menu");
await phone.keyboard.press("Escape");
await phone.goto(BASE + "#/words");
await phone.waitForSelector(".word");
ok(await phone.locator(".word").count() === 2, "phone has both words");
await shot(phone, "16-phone-words");

// back on the laptop: the phone's word arrives
await laptop.goto(BASE + "#/words");
await laptop.waitForFunction(() => document.querySelectorAll(".word").length === 2, null, { timeout: 8000 });
ok(true, "word saved on the phone appears on the laptop");

// delete propagates
await laptop.goto(BASE + "#/library");
await laptop.locator(".book", { hasText: "Companion" }).locator(".card-more").click();
await laptop.locator(".menu-item", { hasText: "Delete" }).click();
await laptop.locator("dialog .btn.danger").click();
await phone.goto(BASE + "#/library");
await phone.waitForFunction(() => document.querySelectorAll(".book").length === 1, null, { timeout: 8000 });
ok(true, "deleting a book on the laptop removes it from the phone");
ok(phone.errors.length === 0, "no errors on phone" + (phone.errors.length ? ": " + phone.errors.join(" | ") : ""));

// ═════════════ Offline (service worker) ═════════════
{
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const pg = await ctx.newPage();
  pg.errors = []; pg.device = "offline"; pages.push(pg);
  await pg.goto(BASE);
  await pg.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 }).catch(() => {});
  await pg.reload();
  await pg.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
  await pg.setInputFiles("#file-input", [FIX("lamplighter.pdf")]);
  await pg.waitForSelector(".textLayer span", { state: "attached", timeout: 15000 });
  await pg.waitForTimeout(800);
  await ctx.setOffline(true);
  await pg.reload();
  await pg.waitForSelector(".tab-pane.active .textLayer span", { state: "attached", timeout: 15000 }).then(
    () => ok(true, "app and an imported book reopen with no connection"),
    () => ok(false, "app and an imported book reopen with no connection"));
  await shot(pg, "17-offline-reopen");
  ok(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
  await ctx.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
