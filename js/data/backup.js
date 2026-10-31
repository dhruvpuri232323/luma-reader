// Portable backup: one JSON file with every record, optionally the PDFs too.
import { store, now } from "./store.js";
import { idb, SYNCED } from "./db.js";
import { blobToBase64, base64ToBlob, downloadBlob, bus } from "../core/util.js";

export async function exportBackup({ includeFiles = true } = {}) {
  const data = { app: "luma-reader", version: 1, exportedAt: new Date().toISOString() };
  for (const c of SYNCED) data[c] = store.raw(c).filter((r) => !r.deleted);
  if (includeFiles) {
    data.files = {};
    for (const d of data.docs) {
      const blob = await store.getFile(d.id);
      if (blob) data.files[d.id] = await blobToBase64(blob);
    }
  }
  const name = `luma-backup-${new Date().toISOString().slice(0, 10)}.json`;
  downloadBlob(new Blob([JSON.stringify(data)], { type: "application/json" }), name);
  return name;
}

/** Merge a backup into this device. Newer records win; nothing is deleted. */
export async function restoreBackup(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== "luma-reader") throw new Error("This file isn't a Luma Reader backup.");
  let count = 0;
  for (const c of SYNCED) {
    for (const rec of data[c] || []) {
      const cur = store.raw(c).find((r) => r.id === rec.id);
      if (!cur || (cur.updatedAt || 0) < (rec.updatedAt || 0)) {
        // Re-stamp so the restored record also propagates to the cloud.
        await store.put(c, { ...rec, updatedAt: now() });
        count++;
      }
    }
  }
  for (const [id, b64] of Object.entries(data.files || {})) {
    if (!(await store.hasFile(id))) {
      await store.putFile(id, base64ToBlob(b64));
      count++;
    }
  }
  bus.emit("restored");
  return count;
}

export async function wipeDevice() {
  for (const s of [...SYNCED, "files", "covers", "defs", "outbox", "kv", "texts", "freq"]) await idb.clear(s);
  localStorage.clear();
}
