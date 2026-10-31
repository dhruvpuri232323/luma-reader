// Luma Reader service worker
//  • App code (HTML/JS/CSS): network first, cached copy when offline — updates arrive on next load.
//  • PDF.js engine, fonts, Firebase SDK, voice engine: cache first (versioned, rarely change).
//  • Share target: receives files, links and text shared from other apps.
//  • Daily review: a background check that can remind you when words are due.

const BUILD = "__BUILD__"; // replaced with the commit SHA by the GitHub Pages workflow
const APP = `luma-app-${BUILD}`;
const STATIC = "luma-static-v1";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./css/reader.css",
  "./js/core/feel.js",
  "./js/core/pwa.js",
  "./js/core/reminders.js",
  "./js/core/tts-worker.js",
  "./js/core/util.js",
  "./js/core/voice.js",
  "./js/data/backup.js",
  "./js/data/common-words.js",
  "./js/data/db.js",
  "./js/data/dictionary.js",
  "./js/data/exporters.js",
  "./js/data/fulltext.js",
  "./js/data/importers.js",
  "./js/data/library.js",
  "./js/data/store.js",
  "./js/firebase-config.js",
  "./js/main.js",
  "./js/reader/annotate.js",
  "./js/reader/autoscroll.js",
  "./js/reader/bookmodel.js",
  "./js/reader/bookview.js",
  "./js/reader/compare.js",
  "./js/reader/dialogue.js",
  "./js/reader/hardwords.js",
  "./js/reader/lookup.js",
  "./js/reader/pdf.js",
  "./js/reader/player.js",
  "./js/reader/reader.js",
  "./js/reader/recap.js",
  "./js/reader/tab.js",
  "./js/reader/textindex.js",
  "./js/reader/textmodel.js",
  "./js/sync/drive.js",
  "./js/sync/firebase.js",
  "./js/sync/sync.js",
  "./js/ui/add.js",
  "./js/ui/definition.js",
  "./js/ui/export.js",
  "./js/ui/icons.js",
  "./js/ui/library.js",
  "./js/ui/notes.js",
  "./js/ui/overlay.js",
  "./js/ui/practice.js",
  "./js/ui/quotecard.js",
  "./js/ui/router.js",
  "./js/ui/settings.js",
  "./js/ui/typography.js",
  "./js/ui/words.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
];
const ENGINE = [
  "./vendor/pdfjs/pdf.min.mjs",
  "./vendor/pdfjs/pdf.worker.min.mjs",
  "./vendor/pdfjs/web/pdf_viewer.mjs",
  "./vendor/pdfjs/web/pdf_viewer.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const app = await caches.open(APP);
    await app.addAll(SHELL);
    const st = await caches.open(STATIC);
    await Promise.all(ENGINE.map(async (u) => { if (!(await st.match(u))) await st.add(u); }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("luma-app-") && key !== APP) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== "GET") return;

  const sameOrigin = url.origin === self.location.origin;
  const isStatic =
    (sameOrigin && url.pathname.includes("/vendor/")) ||
    url.hostname === "fonts.gstatic.com" ||
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "cdnjs.cloudflare.com" || // OpenDyslexic font
    (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) ||
    url.hostname === "cdn.jsdelivr.net"; // natural-voice engine (the model itself is cached by the engine)

  if (isStatic) {
    event.respondWith(cacheFirst(req));
  } else if (sameOrigin) {
    event.respondWith(networkFirst(req));
  }
  // Everything else (Firestore, Auth, Google Drive, dictionaries) goes straight to the network.
});

async function cacheFirst(req) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(APP);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") return (await cache.match("./index.html")) || Response.error();
    return Response.error();
  }
}

async function receiveShare(req) {
  try {
    const data = await req.formData();
    const cache = await caches.open("luma-share");
    let i = 0;
    for (const file of [...data.getAll("file"), ...data.getAll("pdf")]) {
      if (!(file instanceof File)) continue;
      await cache.put(`./shared/${Date.now()}-${i++}`, new Response(file, {
        headers: { "content-type": file.type || "application/octet-stream", "x-filename": encodeURIComponent(file.name || "shared") },
      }));
    }
    const link = { title: data.get("title") || "", text: data.get("text") || "", url: data.get("url") || "" };
    if (!i && (link.text || link.url)) {
      await cache.put(`./shared/${Date.now()}-link`, new Response(JSON.stringify(link), { headers: { "content-type": "application/json", "x-kind": "link" } }));
    }
  } catch (e) { /* fall through to the app */ }
  return Response.redirect("./?shared=1#/library", 303);
}

// ───────── daily review reminder ─────────
function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("luma-reader");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function idbAll(db, store) {
  return new Promise((resolve) => {
    try {
      const q = db.transaction(store, "readonly").objectStore(store).getAll();
      q.onsuccess = () => resolve(q.result || []);
      q.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

async function reviewCheck() {
  const db = await idbOpen();
  const [settings] = (await idbAll(db, "settings")).filter((s) => s.id === "settings");
  if (!settings?.reviewReminder) return;
  const hour = settings.reminderHour ?? 19;
  if (new Date().getHours() < hour) return;
  const day = new Date().toDateString();
  const kv = await idbAll(db, "kv");
  if (kv.find((k) => k.id === "lastReminder")?.day === day) return;
  const due = (await idbAll(db, "words")).filter((w) => !w.deleted && w.status !== "mastered" && (!w.srs || (w.srs.due || 0) <= Date.now())).length;
  if (!due) return;
  await new Promise((resolve) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put({ id: "lastReminder", day });
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
  await self.registration.showNotification("Time for your words", {
    body: `${due} ${due === 1 ? "word is" : "words are"} ready for review — about ${Math.max(2, Math.round(due / 2))} minutes.`,
    icon: "./icons/icon-192.png", badge: "./icons/icon-192.png", tag: "luma-review", data: { url: "./#/words" },
  });
  try { self.navigator.setAppBadge?.(due); } catch {}
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "luma-review") event.waitUntil(reviewCheck().catch(() => {}));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "./", self.location.href).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (w) { await w.focus(); w.navigate?.(url); } else await self.clients.openWindow(url);
  })());
});
