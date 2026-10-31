// Settings: account & sync, appearance, dictionary, install, data.
import { el, bus, debounce, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { idb } from "../data/db.js";
import { sync } from "../sync/sync.js";
import { firebaseConfigured } from "../sync/firebase.js";
import { exportBackup, restoreBackup, wipeDevice } from "../data/backup.js";
import { ACCENTS, cue } from "../core/feel.js";
import { icon } from "./icons.js";
import { toast, confirmDialog } from "./overlay.js";
import { installState, promptInstall } from "../core/pwa.js";
import { typographyControls } from "./typography.js";
import * as voice from "../core/voice.js";
import { drive } from "../sync/drive.js";
import { pronunciationsDialog } from "../reader/player.js";
import { reminderDialog } from "../core/reminders.js";
import { bookmarkletDialog } from "./add.js";

let root;

export function mountSettings(container) {
  root = container;
  const rerender = debounce(() => root.closest(".view")?.classList.contains("active") && render(), 100);
  ["account", "sync-status", "sync-pending", "install", "voice-state", "voice-prefs", "drive"].forEach((e) => bus.on(e, rerender));
  bus.on("change", ({ coll, source }) => coll === "settings" && source === "remote" && rerender());
  voice.voicesReady().then(rerender);
}
export function settingsShown() { render(); }

function section(title, desc, ...rows) {
  return el("section.set-section", {}, el("h2", {}, title), desc ? el("p.muted.set-desc", {}, desc) : null, el("div.set-rows", {}, rows));
}
function row(label, hint, control) {
  return el("div.set-row", {}, el("div.set-text", {}, el("span.set-label", {}, label), hint ? el("span.set-hint", {}, hint) : null), control);
}
function toggle(key, label, hint) {
  const s = store.settings();
  const input = el("input", { type: "checkbox", role: "switch", checked: Boolean(s[key]), onchange: (e) => store.setSettings({ [key]: e.target.checked }) });
  return el("label.set-row", {}, el("div.set-text", {}, el("span.set-label", {}, label), hint ? el("span.set-hint", {}, hint) : null), el("span.switch", {}, input, el("span.knob")));
}
function seg(key, options) {
  const s = store.settings();
  return el("div.seg", {}, options.map(([v, l]) => el("button" + (s[key] === v ? ".on" : ""), {
    onclick: (e) => { store.setSettings({ [key]: v }); e.currentTarget.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.currentTarget)); },
  }, l)));
}

function render() {
  const s = store.settings();
  setKids(root, 
    el("header.view-head", {}, el("div.view-title", {}, el("h1", {}, "Settings"), el("p.muted", {}, "Changes apply instantly and sync to your other devices"))),
    accountSection(),
    driveSection(),
    section("Reading", "How books look in Book view. Changes show in the preview straight away.",
      el("div.set-typo", {}, typographyControls({ preview: true })),
      row("Open new PDFs in", "You can switch any PDF between Page and Book view from the reader's top bar. EPUBs and articles always open as a book.", seg("defaultMode", [["pdf", "Page view"], ["book", "Book view"]])),
      toggle("recap", "“Where was I?” reminder", "When you come back to a book after a while, show the chapter, your last lines and latest note"),
      row("Save articles from your browser", "A “Save to Luma” button for your bookmarks bar", el("button.btn.sm", { onclick: () => bookmarkletDialog() }, icon("globe", 16), el("span", {}, "Get the button")))),
    voiceSection(),
    section("Learning words", null,
      toggle("markHard", "Underline unusual words while reading", "Book view marks words you may not know (set the level in the reader's Words panel)"),
      row("Daily review", s.reviewReminder ? `Reminder at ${new Date(2000, 0, 1, s.reminderHour ?? 19).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · goal ${s.dailyGoal || 10} words` : `Goal ${s.dailyGoal || 10} words a day · reminders off`,
        el("button.btn.sm", { onclick: () => reminderDialog() }, icon("bell", 16), el("span", {}, "Set up")))),
    section("Comfort", null,
      toggle("reduceMotion", "Reduce motion", "Turns off transitions and card animations"),
      toggle("sounds", "Sound cues", "Soft tones when you save a word, bookmark or finish a book")),
    section("Dictionary", "Look words up without selecting or copying them.",
      toggle("hoverLookup", "Define on hover", "Laptops and desktops: rest the pointer on a word"),
      (() => {
        const out = el("span.pop-val", {}, `${s.hoverDelay} ms`);
        return row("Hover delay", "How long the pointer rests before the definition opens", el("div.range-wrap", {},
          el("input", { type: "range", min: 150, max: 1500, step: 50, value: s.hoverDelay, "aria-label": "Hover delay",
            oninput: (e) => { out.textContent = `${e.target.value} ms`; }, onchange: (e) => store.setSettings({ hoverDelay: Number(e.target.value) }) }), out));
      })(),
      toggle("tapLookup", "Define on tap", "Phones and tablets: tap a word once"),
      row("Offline definitions", "Every word you look up is kept on this device", el("button.btn.sm", { onclick: async () => {
        await idb.clear("defs"); toast("Definition cache cleared");
      } }, "Clear cache"))),
    installSection(),
    dataSection(),
    section("Keyboard shortcuts", null,
      el("dl.keys", {}, [["← →", "Previous / next page"], ["Space", "Next page in Book view · flip a flashcard"], ["V", "Switch Page / Book view"], ["L", "Listen / stop"], ["A", "Auto-scroll at your reading speed"], ["R", "Reading ruler (Book view)"], ["Ctrl F", "Search in book"], ["B", "Bookmark page"], ["F", "Focus mode"], ["+ −", "Zoom (Page view)"], ["Shift R", "Rotate pages"], ["Esc", "Close pop-ups"]]
        .map(([k, d]) => [el("dt", {}, el("kbd", {}, k)), el("dd", {}, d)]))),
    el("p.muted.small.about", {}, "Luma Reader · free, no ads, no account needed · PDFs read on your device with PDF.js · natural voices by Kokoro, on your device · definitions from the Free Dictionary API, Wiktionary, WordNet (Datamuse) and Wikipedia · articles via Jina Reader"));
}

function accountSection() {
  if (!firebaseConfigured() && !sync.available) {
    return section("Sync", null,
      el("div.callout", {},
        icon("cloudOff", 22),
        el("div", {},
          el("strong", {}, "Running in local mode"),
          el("p", {}, "Everything is saved on this device. To sync books, progress, words and notes between your phone and laptop, add your Firebase project to js/firebase-config.js in the GitHub repository — docs/SETUP.md walks through it in about ten minutes."))));
  }
  const u = sync.user;
  const label = {
    synced: "Up to date", syncing: "Syncing…", offline: "Offline — changes will sync when you reconnect",
    "signed-out": "Signed out", error: sync.error || "Sync problem", local: "Local only", setup: "Setting up…",
  }[sync.status] || sync.status;
  const rows = [];
  if (u) {
    rows.push(el("div.account", {},
      u.photo ? el("img.avatar", { src: u.photo, alt: "", referrerpolicy: "no-referrer" }) : el("span.avatar", {}, icon("user", 20)),
      el("div", {}, el("strong", {}, u.name || "Signed in"), el("p.muted.small", {}, u.email || "")),
      el("span.spacer"),
      el("button.btn.sm", { onclick: async () => {
        if (await confirmDialog("Sign out?", "Your books and notes stay on this device. Changes made while signed out sync the next time you sign in.", { confirm: "Sign out" })) sync.signOut();
      } }, icon("logout", 16), el("span", {}, "Sign out"))));
    rows.push(row("Status", sync.pending ? `${sync.pending} change${sync.pending === 1 ? "" : "s"} waiting to upload` : null,
      el("div.row", {}, el("span.sync-dot." + sync.status), el("span", {}, label),
        el("button.icon-btn", { "aria-label": "Sync now", title: "Sync now", onclick: () => sync.flushNow() }, icon("sync", 18)))));
    rows.push(row("Original PDF files", sync.cloudPdfs
      ? "Uploaded to your Firebase Storage so books open on every device"
      : "Not uploaded — turn on ENABLE_CLOUD_PDFS in js/firebase-config.js (needs the Blaze plan). Until then, add each PDF once per device; it links up automatically.",
      sync.cloudPdfs ? (() => {
        const s = store.settings();
        const input = el("input", { type: "checkbox", role: "switch", checked: s.autoUploadPdfs, onchange: (e) => store.setSettings({ autoUploadPdfs: e.target.checked }) });
        return el("span.switch", { title: "Upload new PDFs automatically" }, input, el("span.knob"));
      })() : el("span.muted.small", {}, "Off")));
  } else {
    rows.push(el("div.callout", {},
      icon("cloud", 22),
      el("div", {},
        el("strong", {}, "Sign in to sync"),
        el("p", {}, "Use the same Google account on your phone and laptop. Reading progress, words, highlights, notes, bookmarks and settings stay in step."),
        sync.status === "error" ? el("p.warn", {}, sync.error) : null,
        el("button.btn.primary", { onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { await sync.signIn(); }
          catch (err) {
            toast(friendlyAuthError(err), { tone: "warn", duration: 7000 });
            e.currentTarget.disabled = false;
          }
        } }, el("span.g-logo", { "aria-hidden": "true" }), el("span", {}, "Sign in with Google")))));
  }
  return section("Account & sync", null, ...rows);
}

function voiceSection() {
  const ns = voice.naturalState();
  const engine = voice.prefs.engine || "natural";
  const rateOut = el("span.pop-val", {}, `${store.settings().speechRate}×`);
  const naturalStatus = ns.status === "ready" ? "Ready on this device"
    : ns.status === "loading" ? `Downloading… ${Math.round(ns.progress * 100)}%`
    : ns.status === "error" ? ns.error
    : ns.downloaded ? "Downloaded — loads when you press Listen" : "Downloads once (about 90 MB) the first time you use it";
  const pick = (eng, id) => {
    if (eng === "natural") { voice.prefs.natural = id; voice.prefs.engine = "natural"; }
    else { voice.prefs.system = id; voice.prefs.engine = "system"; }
    voice.preview({ engine: eng, id }).catch((e) => toast(e.message || "Couldn't play the sample", { tone: "warn" }));
  };
  const sys = voice.systemVoices();
  const curSys = voice.currentSystemVoice()?.id;
  const list = (items, eng, cur) => el("div.voice-list", {}, items.map((v) =>
    el("button.voice-item" + (engine === eng && cur === v.id ? ".on" : ""), { onclick: () => pick(eng, v.id), title: "Choose and play a sample" },
      icon("play", 14), el("span.vi-name", {}, v.name), el("span.vi-desc", {}, v.desc || v.lang || ""))));
  return section("Listening", "Press the headphones in the reader (or L) and Luma reads the book to you like an audiobook — the current sentence lights up and the pages turn on their own.",
    row("Natural voices", naturalStatus,
      ns.status === "ready" || ns.status === "loading" ? el("span.muted.small", {}, ns.status === "ready" ? "On" : "")
        : el("button.btn.sm.primary", { onclick: () => { voice.prefs.engine = "natural"; voice.loadNatural().catch((e) => toast(e.message, { tone: "warn" })); } }, icon("download", 16), el("span", {}, ns.status === "error" ? "Try again" : "Download now"))),
    list(voice.NATURAL_VOICES, "natural", voice.prefs.natural),
    row("Device voices", sys.length ? "Built into this device — instant, but more robotic. Natural-sounding ones are listed first." : "This browser has no built-in voices.", el("span")),
    sys.length ? list(sys.slice(0, 8).map((v) => ({ id: v.id, name: v.name + (v.natural ? " · natural" : ""), desc: v.lang })), "system", curSys) : null,
    row("Speed", null, el("div.range-wrap", {},
      el("input", { type: "range", min: 0.7, max: 2, step: 0.05, value: store.settings().speechRate, "aria-label": "Reading speed",
        oninput: (e) => { rateOut.textContent = `${Number(e.target.value).toFixed(2).replace(/0$/, "")}×`; },
        onchange: (e) => store.setSettings({ speechRate: Number(e.target.value) }) }), rateOut)),
    toggle("characterVoices", "Character voices", "In stories, each character speaks in their own voice; the narrator keeps yours"),
    toggle("wordHighlight", "Highlight each word", "Follow along word by word as well as sentence by sentence"),
    toggle("skipCitations", "Skip citations", "Don't read out references like (Smith, 2004) or [12]"),
    toggle("skipCaptions", "Skip captions", "Don't read figure and table captions"),
    row("Pronunciations", `${Object.keys(store.settings().pronunciations || {}).length || "No"} custom pronunciations`, el("button.btn.sm", { onclick: () => pronunciationsDialog().then(() => render()) }, icon("sound", 16), el("span", {}, "Edit"))));
}

function driveSection() {
  if (!drive.configured) {
    return section("Google Drive", null, el("div.callout", {}, icon("drive", 22), el("div", {},
      el("strong", {}, "Keep your books in your own Google Drive — free"),
      el("p", {}, "Add a Google client ID to js/firebase-config.js (docs/SETUP.md, “Google Drive”) and books you add on one device open on all the others. It can also sync your notes, words and progress without Firebase."))));
  }
  const st = drive.status;
  if (!drive.enabled) {
    return section("Google Drive", "Your book files — and, if you like, your notes, words and progress — kept in a “Luma Reader” folder in your own Google Drive. Free, private, and Luma can only see the files it puts there.",
      el("div.callout", {}, icon("drive", 22), el("div", {},
        el("strong", {}, "Sync books through Google Drive"),
        el("p", {}, "Add a PDF or EPUB on your laptop and it's waiting on your phone."),
        el("button.btn.primary", { onclick: (e) => { e.currentTarget.disabled = true; drive.connect().catch((err) => toast(err.message, { tone: "warn" })).finally(() => render()); } }, icon("drive", 18), el("span", {}, "Connect Google Drive")))));
  }
  const label = { syncing: "Syncing…", synced: `Up to date${drive.lastSync ? " · " + new Date(drive.lastSync).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}`, "needs-auth": "Tap Sync to reconnect to Google", error: drive.error || "Problem syncing", offline: "Offline" }[st] || st;
  const opt = (key, on, labelText, hint) => el("label.set-row", {}, el("div.set-text", {}, el("span.set-label", {}, labelText), el("span.set-hint", {}, hint)),
    el("span.switch", {}, el("input", { type: "checkbox", role: "switch", checked: on, onchange: (e) => drive.setOption(key, e.target.checked) }), el("span.knob")));
  return section("Google Drive", null,
    row(drive.email ? `Connected as ${drive.email}` : "Connected", null,
      el("div.row", {}, el("span.sync-dot." + (st === "synced" ? "synced" : st === "syncing" ? "syncing" : st === "offline" ? "offline" : "error")), el("span.small", {}, label),
        el("button.icon-btn", { "aria-label": "Sync now", title: "Sync now", onclick: () => drive.syncNow() }, icon("sync", 18)))),
    opt("files", drive.syncFiles, "Book files", "PDFs, EPUBs and articles are kept in Drive and appear on your other devices"),
    opt("data", drive.syncData, "Notes, words & progress", firebaseConfigured() ? "Also keep a copy in Drive (Firebase already syncs these)" : "Sync everything else through Drive too — no Firebase needed"),
    row("Disconnect", "Files already in your Drive stay there", el("button.btn.sm", { onclick: async () => { if (await confirmDialog("Disconnect Google Drive?", "Luma stops syncing through Drive on this device. Your files stay in your Drive.", { confirm: "Disconnect" })) { drive.disconnect(); render(); } } }, "Disconnect")));
}

function friendlyAuthError(err) {
  const code = err?.code || "";
  if (code.includes("unauthorized-domain")) return `This address (${location.hostname}) isn't allowed yet. Add it in Firebase → Authentication → Settings → Authorized domains.`;
  if (code.includes("operation-not-allowed")) return "Google sign-in is turned off. Enable it in Firebase → Authentication → Sign-in method.";
  if (code.includes("network")) return "No connection — try again when you're online.";
  return err?.message || "Sign-in didn't complete.";
}

function installSection() {
  const st = installState();
  let control;
  if (st === "installed") control = el("span.muted.small", {}, "Installed");
  else if (st === "available") control = el("button.btn.sm.primary", { onclick: promptInstall }, icon("download", 16), el("span", {}, "Install app"));
  else if (st === "ios") control = el("span.muted.small", {}, "In Safari: Share → Add to Home Screen");
  else control = el("span.muted.small", {}, "Use your browser menu → Install app / Add to Home screen");
  return section("Install", "Run Luma Reader like a regular app, offline included. On desktop Chrome or Edge, the installed app can also open PDFs straight from your file manager; on Android, share a PDF to it.",
    row("App", null, control));
}

function dataSection() {
  const usage = el("span.muted.small", {}, "…");
  navigator.storage?.estimate?.().then(({ usage: u = 0, quota: q = 0 }) => {
    usage.textContent = `${(u / 1048576).toFixed(1)} MB used${q ? ` of ${(q / 1073741824).toFixed(1)} GB available` : ""}`;
  }).catch(() => (usage.textContent = ""));
  const restoreInput = el("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { const n = await restoreBackup(f); cue("done"); toast(`Restored ${n} item${n === 1 ? "" : "s"}`); }
    catch (err) { toast(err.message || "That backup couldn't be read.", { tone: "warn" }); }
  } });
  return section("Your data", "You own everything. Backups are plain JSON you can keep anywhere.",
    row("Storage on this device", null, usage),
    row("Back up everything", "Books, progress, words, notes, bookmarks and settings", el("div.row", {},
      el("button.btn.sm", { onclick: async () => toast(`Saved ${await exportBackup({ includeFiles: false })}`) }, "Without PDFs"),
      el("button.btn.sm.primary", { onclick: async () => { const c = toast("Preparing backup…", { duration: 60000 }); const n = await exportBackup({ includeFiles: true }); c(); toast(`Saved ${n}`); } }, icon("download", 16), el("span", {}, "With PDFs")))),
    row("Restore a backup", "Merges with what's here; newer changes win", el("div", {}, el("button.btn.sm", { onclick: () => restoreInput.click() }, icon("upload", 16), el("span", {}, "Choose file")), restoreInput)),
    row("Erase this device", "Removes every book and note stored in this browser. Synced copies in your account stay.",
      el("button.btn.sm.danger", { onclick: async () => {
        if (!(await confirmDialog("Erase this device?", "All books, notes and words stored in this browser will be deleted. If you're signed in, they come back from the cloud next time you sign in (PDF files only if cloud PDFs are on).", { confirm: "Erase", danger: true }))) return;
        await sync.signOut().catch(() => {});
        await wipeDevice();
        location.reload();
      } }, "Erase")));
}
