// Google Drive sync — free, in your own Google Drive.
//  • Book files (PDF, EPUB, articles) are kept in a "Luma Reader" folder, so a
//    book added on your laptop opens on your phone without adding it again.
//  • Optionally your library, progress, notes, words and settings travel in a
//    small file next to them ("luma-sync.json") — a complete sync with no
//    Firebase needed. Records merge one by one; the newest edit wins.
// Uses the drive.file permission: Luma can only see files it created.
import { store } from "../data/store.js";
import { SYNCED } from "../data/db.js";
import { bus, debounce } from "../core/util.js";
import { GOOGLE_CLIENT_ID } from "../firebase-config.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const LS = { on: "luma.drive.on", files: "luma.drive.files", data: "luma.drive.data", token: "luma.drive.token", email: "luma.drive.email" };
const MIME = { pdf: "application/pdf", epub: "application/epub+zip", text: "application/json" };

const st = {
  status: "off", // off | unconfigured | needs-auth | syncing | synced | error | offline
  error: "",
  token: null,
  expires: 0,
  folder: null,
  syncFile: null,
  client: null,
  busy: false,
  progress: new Map(), // docId → 0..1 (upload or download)
  lastSync: Number(localStorage.getItem("luma.drive.last")) || 0,
};

const setStatus = (s, error = "") => { st.status = s; st.error = error; bus.emit("drive"); };

function loadGis() {
  if (window.__LUMA_TEST_GIS__) return Promise.resolve(window.__LUMA_TEST_GIS__);
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => (window.google?.accounts?.oauth2 ? resolve(window.google) : reject(new Error("Google sign-in didn't load")));
    s.onerror = () => reject(new Error(navigator.onLine ? "Google sign-in couldn't load" : "You're offline"));
    document.head.append(s);
  });
}

function restoreToken() {
  try {
    const t = JSON.parse(sessionStorage.getItem(LS.token) || "null");
    if (t && t.expires > Date.now() + 60000) { st.token = t.token; st.expires = t.expires; }
  } catch {}
}

const tokenValid = () => st.token && st.expires > Date.now() + 60000;

/** Ask Google for access (opens Google's window the first time; quick after that). */
function authorize({ silent = false } = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const g = await loadGis();
      st.client = g.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPE,
        prompt: silent ? "" : undefined,
        callback: (res) => {
          if (res.error) { reject(new Error(res.error_description || res.error)); return; }
          st.token = res.access_token;
          st.expires = Date.now() + (Number(res.expires_in) || 3600) * 1000;
          try { sessionStorage.setItem(LS.token, JSON.stringify({ token: st.token, expires: st.expires })); } catch {}
          resolve(st.token);
        },
        error_callback: (err) => reject(new Error(err?.message || err?.type || "Google sign-in was closed")),
      });
      st.client.requestAccessToken(silent ? { prompt: "" } : {});
    } catch (e) { reject(e); }
  });
}

async function api(path, { method = "GET", body, headers = {}, raw = false, base = API } = {}) {
  if (!tokenValid()) throw Object.assign(new Error("Google Drive needs you to reconnect."), { auth: true });
  const res = await fetch(path.startsWith("http") ? path : base + path, { method, body, headers: { Authorization: `Bearer ${st.token}`, ...headers } });
  if (res.status === 401) { st.token = null; sessionStorage.removeItem(LS.token); throw Object.assign(new Error("Google Drive needs you to reconnect."), { auth: true }); }
  if (!res.ok) {
    let msg = `Google Drive error ${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    throw new Error(msg);
  }
  return raw ? res : res.status === 204 ? null : res.json();
}

const q = (s) => encodeURIComponent(s);

async function ensureFolder() {
  if (st.folder) return st.folder;
  const found = await api(`/files?q=${q("appProperties has { key='luma' and value='folder' } and trashed=false")}&fields=files(id,name)&spaces=drive`);
  if (found.files?.length) return (st.folder = found.files[0].id);
  const made = await api("/files?fields=id", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Luma Reader", mimeType: "application/vnd.google-apps.folder", appProperties: { luma: "folder" } }) });
  return (st.folder = made.id);
}

function multipart(meta, blob) {
  const boundary = "luma" + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`, blob, `\r\n--${boundary}--`,
  ]);
  return { body, type: `multipart/related; boundary=${boundary}` };
}

/** Upload a file; resumable for big files so a flaky phone connection can finish. */
async function upload(meta, blob, onProgress) {
  if (blob.size < 4 * 1024 * 1024) {
    const { body, type } = multipart(meta, blob);
    const r = await api("/files?uploadType=multipart&fields=id,modifiedTime", { base: UPLOAD, method: "POST", headers: { "Content-Type": type }, body });
    onProgress?.(1);
    return r;
  }
  const init = await api("/files?uploadType=resumable&fields=id", { base: UPLOAD, method: "POST", raw: true, headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": blob.type || "application/octet-stream", "X-Upload-Content-Length": String(blob.size) }, body: JSON.stringify(meta) });
  const session = init.headers.get("Location");
  if (!session) {
    const { body, type } = multipart(meta, blob);
    return api("/files?uploadType=multipart&fields=id", { base: UPLOAD, method: "POST", headers: { "Content-Type": type }, body });
  }
  const CHUNK = 8 * 256 * 1024 * 4; // 8 MB (a multiple of 256 KB)
  let at = 0;
  while (at < blob.size) {
    const end = Math.min(blob.size, at + CHUNK);
    const res = await fetch(session, { method: "PUT", headers: { "Content-Range": `bytes ${at}-${end - 1}/${blob.size}` }, body: blob.slice(at, end) });
    if (res.status === 308) {
      const range = res.headers.get("Range");
      at = range ? Number(range.split("-")[1]) + 1 : end;
    } else if (res.ok) {
      onProgress?.(1);
      return res.json();
    } else throw new Error(`Upload stopped (${res.status})`);
    onProgress?.(at / blob.size);
  }
  throw new Error("Upload didn't finish");
}

// ───────── books ─────────
async function pushBooks() {
  if (localStorage.getItem(LS.files) === "0") return;
  const folder = await ensureFolder();
  const ids = await store.fileIds();
  for (const doc of store.list("docs")) {
    if (doc.driveId || !ids.has(doc.id)) continue;
    const blob = await store.getFile(doc.id);
    if (!blob) continue;
    const ext = doc.kind === "epub" ? "epub" : doc.kind === "text" ? "json" : "pdf";
    const name = `${doc.title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120)}.${ext}`;
    st.progress.set(doc.id, 0);
    bus.emit("upload");
    try {
      const typed = blob.type ? blob : new Blob([blob], { type: MIME[doc.kind || "pdf"] });
      const r = await upload({ name, parents: [folder], appProperties: { lumaId: doc.id, kind: doc.kind || "pdf" } }, typed, (p) => { st.progress.set(doc.id, p); bus.emit("upload"); });
      await store.patch("docs", doc.id, { driveId: r.id });
    } finally {
      st.progress.delete(doc.id);
      bus.emit("upload");
    }
  }
}

/** Find book files in Drive that this device's library doesn't link yet (e.g. records arriving via Firebase). */
async function linkBooks() {
  const missing = store.list("docs").filter((d) => !d.driveId);
  if (!missing.length) return;
  const folder = await ensureFolder();
  const res = await api(`/files?q=${q(`'${folder}' in parents and trashed=false`)}&fields=files(id,appProperties)&pageSize=1000&spaces=drive`);
  const byLuma = new Map((res.files || []).map((f) => [f.appProperties?.lumaId, f.id]));
  for (const d of missing) if (byLuma.has(d.id)) await store.patch("docs", d.id, { driveId: byLuma.get(d.id) });
}

/** Bring a book's file down from Drive to this device. */
export async function downloadBook(docId) {
  const doc = store.get("docs", docId);
  if (!doc?.driveId) throw new Error("This book isn't in your Google Drive yet.");
  if (!tokenValid()) await authorize();
  st.progress.set(docId, 0);
  bus.emit("upload");
  try {
    const res = await api(`/files/${doc.driveId}?alt=media`, { raw: true });
    const total = Number(res.headers.get("Content-Length")) || doc.size || 0;
    const reader = res.body?.getReader?.();
    let blob;
    if (reader && total) {
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        st.progress.set(docId, got / total);
        bus.emit("upload");
      }
      blob = new Blob(parts, { type: MIME[doc.kind || "pdf"] });
    } else blob = await res.blob();
    await store.putFile(docId, blob);
  } finally {
    st.progress.delete(docId);
    bus.emit("upload");
  }
}

/** Small books come down automatically; big ones wait until you open them. */
async function pullBooks() {
  if (localStorage.getItem(LS.files) === "0") return;
  const ids = await store.fileIds();
  for (const d of store.list("docs")) {
    if (d.driveId && !ids.has(d.id) && (d.size || 0) < 25 * 1024 * 1024) {
      try { await downloadBook(d.id); } catch (e) { if (e.auth) throw e; }
    }
  }
}

// ───────── library data ─────────
async function findSyncFile() {
  if (st.syncFile) return st.syncFile;
  const res = await api(`/files?q=${q("appProperties has { key='luma' and value='sync' } and trashed=false")}&fields=files(id,modifiedTime)&spaces=drive`);
  return (st.syncFile = res.files?.[0]?.id || null);
}

async function syncData() {
  if (localStorage.getItem(LS.data) === "0") return;
  const id = await findSyncFile();
  let remote = null;
  if (id) {
    try { remote = await (await api(`/files/${id}?alt=media`, { raw: true })).json(); } catch (e) { if (e.auth) throw e; }
  }
  let changed = 0;
  if (remote?.app === "luma-reader") {
    for (const coll of SYNCED) for (const rec of remote[coll] || []) if (await store.applyRemote(coll, rec)) changed++;
  }
  // push our merged view if anything here is newer than what Drive has
  const remoteNewest = remote ? Math.max(0, ...SYNCED.flatMap((c) => (remote[c] || []).map((r) => r.updatedAt || 0))) : -1;
  const localNewest = Math.max(0, ...SYNCED.flatMap((c) => store.raw(c).map((r) => r.updatedAt || 0)));
  const remoteCount = remote ? SYNCED.reduce((n, c) => n + (remote[c] || []).length, 0) : -1;
  const localCount = SYNCED.reduce((n, c) => n + store.raw(c).length, 0);
  if (localNewest > remoteNewest || localCount !== remoteCount) {
    const snapshot = { app: "luma-reader", v: 1, at: Date.now() };
    for (const c of SYNCED) snapshot[c] = store.raw(c);
    const blob = new Blob([JSON.stringify(snapshot)], { type: "application/json" });
    if (id) await api(`/files/${id}?uploadType=media&fields=id`, { base: UPLOAD, method: "PATCH", headers: { "Content-Type": "application/json" }, body: blob });
    else {
      const folder = await ensureFolder();
      const r = await upload({ name: "luma-sync.json", parents: [folder], appProperties: { luma: "sync" } }, blob);
      st.syncFile = r.id;
    }
  }
  return changed;
}

// ───────── running ─────────
async function run({ interactive = false } = {}) {
  if (!drive.enabled || st.busy) return;
  if (!navigator.onLine) { setStatus("offline"); return; }
  if (!tokenValid()) {
    if (!interactive) { setStatus("needs-auth"); return; }
    try { await authorize(); } catch (e) { setStatus("needs-auth", e.message); return; }
  }
  st.busy = true;
  setStatus("syncing");
  try {
    if (!localStorage.getItem(LS.email)) {
      api("/about?fields=user(emailAddress)").then((a) => { localStorage.setItem(LS.email, a.user?.emailAddress || ""); bus.emit("drive"); }).catch(() => {});
    }
    await syncData();
    await linkBooks();
    await pushBooks();
    await syncData(); // record the new Drive links
    await pullBooks();
    st.lastSync = Date.now();
    localStorage.setItem("luma.drive.last", String(st.lastSync));
    setStatus("synced");
  } catch (e) {
    console.warn("Drive sync:", e);
    setStatus(e.auth ? "needs-auth" : "error", e.message);
  } finally {
    st.busy = false;
  }
}

const soon = debounce(() => run(), 15000);

export const drive = {
  get configured() { return Boolean(GOOGLE_CLIENT_ID) || Boolean(window.__LUMA_TEST_GIS__); },
  get enabled() { return this.configured && localStorage.getItem(LS.on) === "1"; },
  get status() { return st.status; },
  get error() { return st.error; },
  get email() { return localStorage.getItem(LS.email) || ""; },
  get lastSync() { return st.lastSync; },
  get syncFiles() { return localStorage.getItem(LS.files) !== "0"; },
  get syncData() { return localStorage.getItem(LS.data) !== "0"; },
  progress: (docId) => st.progress.get(docId),

  init() {
    if (!this.configured) { st.status = "unconfigured"; return; }
    if (!this.enabled) { st.status = "off"; return; }
    restoreToken();
    bus.on("change", ({ source }) => { if (source === "local") soon(); });
    bus.on("doc-imported", () => soon());
    window.addEventListener("online", () => run());
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - st.lastSync > 60000) run(); });
    run();
  },

  async connect() {
    localStorage.setItem(LS.on, "1");
    if (localStorage.getItem(LS.data) == null) localStorage.setItem(LS.data, "1");
    try { await authorize(); } catch (e) { setStatus("needs-auth", e.message); throw e; }
    if (!this.listening) {
      this.listening = true;
      bus.on("change", ({ source }) => { if (source === "local") soon(); });
      bus.on("doc-imported", () => soon());
    }
    await run();
  },

  syncNow() { return run({ interactive: true }); },

  setOption(key, on) {
    localStorage.setItem(key === "files" ? LS.files : LS.data, on ? "1" : "0");
    bus.emit("drive");
    if (on) run();
  },

  disconnect() {
    try { if (st.token) window.google?.accounts?.oauth2?.revoke?.(st.token, () => {}); } catch {}
    localStorage.removeItem(LS.on);
    localStorage.removeItem(LS.email);
    sessionStorage.removeItem(LS.token);
    st.token = null;
    st.folder = null;
    st.syncFile = null;
    setStatus("off");
  },

  downloadBook,
};
window.__luma = Object.assign(window.__luma || {}, { drive });
