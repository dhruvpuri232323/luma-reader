// Luma Reader — app entry point.
import { el, $, $$, bus, setKids } from "./core/util.js";
import { store } from "./data/store.js";
import { requestPersistence } from "./data/db.js";
import { sync } from "./sync/sync.js";
import { applyAppearance, cue } from "./core/feel.js";
import { registerServiceWorker, incomingFiles } from "./core/pwa.js";
import { icon } from "./ui/icons.js";
import { toast } from "./ui/overlay.js";
import { onRoute, route, navigate } from "./ui/router.js";
import { mountLibrary, runImport } from "./ui/library.js";
import { listenForClips, importShared } from "./ui/add.js";
import { startReminders } from "./core/reminders.js";
import { drive } from "./sync/drive.js";
import { mountWords, wordsShown } from "./ui/words.js";
import { mountNotes, notesShown } from "./ui/notes.js";
import { mountSettings, settingsShown } from "./ui/settings.js";
import { mountInsights, insightsShown } from "./ui/insights.js";
import { wireSwitch } from "./ui/lightswitch.js";
import { mountReader, openDoc, restoreSession, hasTabs, lastActive, afterShow, restoreCompare } from "./reader/reader.js";

const NAV = [
  ["library", "Library", "library"],
  ["read", "Reading", "book"],
  ["words", "Words", "words"],
  ["notes", "Notes", "notes"],
  ["insights", "Insights", "chart"],
  ["settings", "Settings", "settings"],
];

async function boot() {
  await store.init();
  applyAppearance();
  buildShell();

  mountLibrary($("#view-library"));
  mountWords($("#view-words"));
  mountNotes($("#view-notes"));
  mountInsights($("#view-insights"));
  mountSettings($("#view-settings"));
  mountReader($("#view-reader"));

  const restored = restoreSession();
  onRoute(show);
  if (!location.hash) navigate(restored ? `#/read/${restored}` : "#/library", { replace: true });
  else route();
  restoreCompare();

  wireDropZone();
  incomingFiles((files) => runImport(files, { openAfter: true }), (shared) => importShared(shared));
  listenForClips();
  registerServiceWorker();
  requestPersistence();
  sync.init();
  drive.init();
  startReminders();

  bus.on("doc-finished", (id) => { cue("done"); toast(`Finished “${store.get("docs", id)?.title}”`); });
  bus.on("toast", (msg) => toast(msg, { duration: 4200 }));
  // a newer version was opened in another window: this one has to reload
  window.addEventListener("luma-db-replaced", () => {
    if (document.querySelector(".app-replaced")) return;
    document.body.append(el("div.app-replaced", { role: "alertdialog", "aria-label": "Luma Reader was updated" },
      el("div.boot", {}, el("span.brand-mark"),
        el("p.boot-note", {}, "Luma Reader was updated in another window. Reload to keep reading here — everything is saved."),
        el("div.boot-actions", {}, el("button.primary", { onclick: () => location.reload() }, "Reload")))));
  });
  bus.on("app-update", () => toast("A new version is ready.", { action: "Reload", onAction: () => location.reload(), duration: 15000 }));
  document.documentElement.classList.add("ready");
}

function buildShell() {
  const navBtn = ([key, label, ic]) =>
    el("a.nav-item", { href: key === "read" ? "#/read" : `#/${key}`, dataset: { nav: key } }, icon(ic, 22), el("span", {}, label));
  setKids($("#app"), 
    el("nav.rail", { "aria-label": "Main" },
      wireSwitch(el("button.brand", { type: "button" }, el("span.brand-mark", { "aria-hidden": "true" }), el("span.brand-name", {}, "Luma"))),
      el("div.nav", {}, NAV.map(navBtn)),
      el("button.sync-chip", { onclick: () => navigate("#/settings"), "aria-live": "polite" })),
    el("main.views", {},
      el("section.view#view-library", { "aria-label": "Library" }),
      el("section.view.reader#view-reader", { "aria-label": "Reader" }),
      el("section.view#view-words", { "aria-label": "Words" }),
      el("section.view#view-notes", { "aria-label": "Notes" }),
      el("section.view#view-insights", { "aria-label": "Insights" }),
      el("section.view#view-settings", { "aria-label": "Settings" })),
    el("nav.bottom-nav", { "aria-label": "Main" }, NAV.map(navBtn)),
    el("div.dropzone", { "aria-hidden": "true" }, el("div", {}, icon("upload", 40), el("p", {}, "Drop PDFs, EPUBs or text files to add them"))));
  renderSyncChip();
  ["sync-status", "account", "sync-pending"].forEach((e) => bus.on(e, renderSyncChip));
}

function renderSyncChip() {
  const chip = $(".sync-chip");
  if (!chip) return;
  const st = sync.status;
  const u = sync.user;
  const text = {
    local: "On this device", "signed-out": "Not signed in", syncing: "Syncing", synced: "Synced",
    offline: "Offline", error: "Sync problem", setup: "Starting",
  }[st] || st;
  chip.dataset.status = st;
  chip.title = u ? `Signed in as ${u.email || u.name}` : text;
  setKids(chip, icon(st === "offline" || st === "local" || st === "signed-out" ? "cloudOff" : st === "syncing" ? "sync" : "cloud", 18), el("span", {}, text));
}

let currentView = null;
async function show({ view, args, query }) {
  if (view === "read") {
    const id = args[0] || lastActive();
    if (!id) { navigate("#/library", { replace: true }); return; }
    setView("reader");
    await openDoc(id, args[1] ? Number(args[1]) : undefined);
    afterShow();
    return;
  }
  if (!["library", "words", "notes", "insights", "settings"].includes(view)) { navigate("#/library", { replace: true }); return; }
  setView(view);
  ({ words: wordsShown, notes: notesShown, insights: insightsShown, settings: settingsShown })[view]?.(query);
}

function setView(name) {
  if (currentView === name) return;
  currentView = name;
  $$(".view").forEach((v) => {
    const on = v.id === `view-${name}`;
    v.classList.toggle("active", on);
    v.inert = !on;
  });
  document.documentElement.dataset.view = name;
  const navKey = name === "reader" ? "read" : name;
  $$(".nav-item").forEach((a) => a.classList.toggle("on", a.dataset.nav === navKey));
  $$(".nav-item[data-nav='read']").forEach((a) => a.toggleAttribute("hidden", !hasTabs() && name !== "reader"));
  if (name !== "reader") window.scrollTo(0, 0);
}
bus.on("tab-state", () => $$(".nav-item[data-nav='read']").forEach((a) => a.toggleAttribute("hidden", !hasTabs())));

function wireDropZone() {
  let depth = 0;
  const zone = $(".dropzone");
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; zone.classList.add("on"); });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove("on"); });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove("on");
    runImport(e.dataTransfer.files, { openAfter: e.dataTransfer.files.length === 1 });
  });
}

boot().catch((e) => {
  console.error(e);
  document.body.append(el("pre.fatal", {}, "Luma Reader couldn't start: " + (e?.message || e)));
});
