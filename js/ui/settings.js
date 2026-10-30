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

let root;

export function mountSettings(container) {
  root = container;
  const rerender = debounce(() => root.closest(".view")?.classList.contains("active") && render(), 100);
  ["account", "sync-status", "sync-pending", "install"].forEach((e) => bus.on(e, rerender));
  bus.on("change", ({ coll, source }) => coll === "settings" && source === "remote" && rerender());
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
    section("Appearance", null,
      row("Theme", null, seg("theme", [["light", "Light"], ["sepia", "Sepia"], ["dark", "Dark"], ["auto", "Match device"]])),
      row("Accent", null, el("div.swatches", {}, Object.entries(ACCENTS).map(([k, a]) => el("button.swatch.lg" + (s.accent === k ? ".on" : ""), {
        style: { "--c": a.hex }, "aria-label": a.name, title: a.name,
        onclick: (e) => { store.setSettings({ accent: k }); e.currentTarget.parentElement.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("on", b === e.currentTarget)); },
      })))),
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
      (() => {
        const out = el("span.pop-val", {}, `${s.speechRate}×`);
        return row("Read-aloud speed", null, el("div.range-wrap", {},
          el("input", { type: "range", min: 0.6, max: 1.6, step: 0.1, value: s.speechRate, "aria-label": "Speech rate",
            oninput: (e) => { out.textContent = `${e.target.value}×`; }, onchange: (e) => store.setSettings({ speechRate: Number(e.target.value) }) }), out));
      })(),
      row("Offline definitions", "Every word you look up is kept on this device", el("button.btn.sm", { onclick: async () => {
        await idb.clear("defs"); toast("Definition cache cleared");
      } }, "Clear cache"))),
    installSection(),
    dataSection(),
    section("Keyboard shortcuts", null,
      el("dl.keys", {}, [["← →", "Previous / next page"], ["Ctrl F", "Search in book"], ["B", "Bookmark page"], ["F", "Focus mode"], ["+ −", "Zoom"], ["Shift R", "Rotate pages"], ["Esc", "Close pop-ups"], ["Space", "Flip flashcard"]]
        .map(([k, d]) => [el("dt", {}, el("kbd", {}, k)), el("dd", {}, d)]))),
    el("p.muted.small.about", {}, "Luma Reader · PDFs are read on your device with PDF.js · Definitions from the Free Dictionary API (dictionaryapi.dev)"));
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
