// Installable app: service worker, install prompt, "Open with" and Android share target.
import { bus } from "./util.js";

let deferred = null;
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

export function installState() {
  if (standalone()) return "installed";
  if (deferred) return "available";
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return "ios";
  return "manual";
}

export async function promptInstall() {
  if (!deferred) return;
  deferred.prompt();
  await deferred.userChoice.catch(() => {});
  deferred = null;
  bus.emit("install");
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e;
  bus.emit("install");
});
window.addEventListener("appinstalled", () => { deferred = null; bus.emit("install"); });

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      nw?.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) bus.emit("app-update");
      });
    });
  }).catch((e) => console.warn("Service worker:", e));
}

/** Files handed to us by the OS ("Open with") or by the share sheet. */
export async function incomingFiles(onFiles) {
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const files = await Promise.all(params.files.map((h) => h.getFile()));
      onFiles(files);
    });
  }
  const url = new URL(location.href);
  if (url.searchParams.has("shared")) {
    try {
      const cache = await caches.open("luma-share");
      const keys = await cache.keys();
      const files = [];
      for (const req of keys) {
        const res = await cache.match(req);
        const blob = await res.blob();
        const name = decodeURIComponent(res.headers.get("x-filename") || "shared.pdf");
        files.push(new File([blob], name, { type: "application/pdf" }));
        await cache.delete(req);
      }
      if (files.length) onFiles(files);
    } catch (e) { console.warn("Share target:", e); }
    url.searchParams.delete("shared");
    history.replaceState(null, "", url.pathname + url.search + location.hash);
  }
}
