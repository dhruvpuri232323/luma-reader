// Luma Reader service worker
//  • App code (HTML/JS/CSS): network first, cached copy when offline — updates arrive on next load.
//  • PDF.js engine, fonts, Firebase SDK: cache first (versioned, rarely change).
//  • Android share target: receives shared PDFs and hands them to the app.

const BUILD = "__BUILD__"; // replaced with the commit SHA by the GitHub Pages workflow
const APP = `luma-app-${BUILD}`;
const STATIC = "luma-static-v1";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./css/reader.css",
  "./js/main.js",
  "./js/firebase-config.js",
  "./js/core/util.js",
  "./js/core/feel.js",
  "./js/core/pwa.js",
  "./js/data/db.js",
  "./js/data/store.js",
  "./js/data/library.js",
  "./js/data/dictionary.js",
  "./js/data/backup.js",
  "./js/sync/sync.js",
  "./js/sync/firebase.js",
  "./js/ui/icons.js",
  "./js/ui/overlay.js",
  "./js/ui/router.js",
  "./js/ui/library.js",
  "./js/ui/words.js",
  "./js/ui/notes.js",
  "./js/ui/settings.js",
  "./js/ui/definition.js",
  "./js/reader/pdf.js",
  "./js/reader/tab.js",
  "./js/reader/reader.js",
  "./js/reader/annotate.js",
  "./js/reader/lookup.js",
  "./js/reader/compare.js",
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
    (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"));

  if (isStatic) {
    event.respondWith(cacheFirst(req));
  } else if (sameOrigin) {
    event.respondWith(networkFirst(req));
  }
  // Everything else (Firestore, Auth, dictionary API) goes straight to the network.
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
    for (const file of data.getAll("pdf")) {
      if (!(file instanceof File)) continue;
      await cache.put(`./shared/${Date.now()}-${i++}`, new Response(file, {
        headers: { "content-type": "application/pdf", "x-filename": encodeURIComponent(file.name || "shared.pdf") },
      }));
    }
  } catch (e) { /* fall through to the app */ }
  return Response.redirect("./?shared=1#/library", 303);
}
