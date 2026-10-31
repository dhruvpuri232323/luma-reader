// Getting your notes and words out: Markdown, Obsidian (one note per book,
// with front matter and tags), a web page, rich text for Google Docs / Notion /
// Word (copied to the clipboard), and Anki flashcards for your words.
import { store } from "./store.js";
import { downloadBlob, escapeHtml } from "../core/util.js";
import { COLORS } from "../reader/annotate.js";

const safe = (s) => (s || "notes").replace(/[\\/:*?"<>|#^[\]]+/g, "-").slice(0, 80).trim();
const today = () => new Date().toISOString().slice(0, 10);

/** Notes grouped by book: [{ doc, anns, bms }] */
export function collect({ docIds, annotations } = {}) {
  const docs = new Map(store.list("docs").map((d) => [d.id, d]));
  const anns = (annotations || store.list("annotations")).filter((a) => docs.has(a.docId) && (!docIds || docIds.includes(a.docId)));
  const bms = annotations ? [] : store.list("bookmarks").filter((b) => docs.has(b.docId) && (!docIds || docIds.includes(b.docId)));
  const ids = [...new Set([...anns, ...bms].map((a) => a.docId))];
  return ids.map((id) => ({
    doc: docs.get(id),
    anns: anns.filter((a) => a.docId === id).sort((a, b) => a.page - b.page || (a.createdAt || 0) - (b.createdAt || 0)),
    bms: bms.filter((b) => b.docId === id).sort((a, b) => a.page - b.page),
  }));
}

export function toMarkdown(groups, { obsidian = false } = {}) {
  const out = [];
  for (const { doc, anns, bms } of groups) {
    if (obsidian) {
      const tags = [...new Set(anns.flatMap((a) => a.tags || []))];
      out.push(...["---", `title: "${doc.title.replace(/"/g, "'")}"`, doc.author ? `author: "${doc.author.replace(/"/g, "'")}"` : null, doc.source ? `source: ${doc.source}` : null,
        `pages: ${doc.pages || ""}`, `exported: ${today()}`, `tags: [books${tags.map((t) => ", " + t.replace(/\s+/g, "-")).join("")}]`, "---", ""].filter((x) => x !== null));
      out.push(`# ${doc.title}`, "");
    } else out.push(...[`## ${doc.title}`, doc.author ? `_${doc.author}_` : null, ""].filter((x) => x !== null));
    for (const a of anns) {
      out.push(`> ${a.text.replace(/\s*\n\s*/g, " ")}`);
      out.push(`> — p. ${a.page}${a.starred ? " ★" : ""}${obsidian ? "" : ` · ${COLORS[a.color]?.name.toLowerCase() || ""}`}`);
      out.push("");
      if (a.note) out.push(a.note, "");
      if (a.tags?.length) out.push(a.tags.map((t) => "#" + t.replace(/\s+/g, "-")).join(" "), "");
    }
    if (bms.length) out.push(`**Bookmarks:** ${bms.map((b) => `p. ${b.page}${b.label ? ` (${b.label})` : ""}`).join(", ")}`, "");
  }
  return out.join("\n");
}

export function toHtml(groups, title = "Notes") {
  const body = groups.map(({ doc, anns, bms }) => `
<section><h2>${escapeHtml(doc.title)}</h2>${doc.author ? `<p class="by">${escapeHtml(doc.author)}</p>` : ""}
${anns.map((a) => `<blockquote style="border-left:4px solid ${COLORS[a.color]?.hex || "#ccc"};margin:16px 0;padding:4px 0 4px 14px">
<p>${escapeHtml(a.text)}</p><p style="color:#777;font-size:13px">p. ${a.page}${a.starred ? " ★" : ""}${a.tags?.length ? " · " + a.tags.map((t) => "#" + escapeHtml(t)).join(" ") : ""}</p>
</blockquote>${a.note ? `<p>${escapeHtml(a.note).replace(/\n/g, "<br>")}</p>` : ""}`).join("\n")}
${bms.length ? `<p><strong>Bookmarks:</strong> ${bms.map((b) => `p. ${b.page}`).join(", ")}</p>` : ""}</section>`).join("\n");
  return `<h1>${escapeHtml(title)}</h1>${body}`;
}

export function downloadMarkdown(groups, name) {
  const head = groups.length === 1 ? "" : `# Luma Reader notes\n\n_Exported ${new Date().toLocaleString()}_\n\n`;
  downloadBlob(new Blob([head + toMarkdown(groups)], { type: "text/markdown" }), `${safe(name)}.md`);
}

/** Obsidian: one Markdown note per book (a .zip when there are several). */
export async function downloadObsidian(groups) {
  if (groups.length === 1) {
    downloadBlob(new Blob([toMarkdown(groups, { obsidian: true })], { type: "text/markdown" }), `${safe(groups[0].doc.title)}.md`);
    return;
  }
  const files = groups.map((g) => ({ name: `Books/${safe(g.doc.title)}.md`, data: new TextEncoder().encode(toMarkdown([g], { obsidian: true })) }));
  downloadBlob(zipStore(files), `luma-obsidian-${today()}.zip`);
}

export function downloadHtml(groups, title) {
  const page = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:17px/1.6 Georgia,serif;max-width:720px;margin:40px auto;padding:0 20px;color:#222}h1,h2{font-family:system-ui,sans-serif}h2{margin-top:48px}.by{color:#666;font-style:italic}</style>
${toHtml(groups, title)}`;
  downloadBlob(new Blob([page], { type: "text/html" }), `${safe(title)}.html`);
}

/** Rich copy: paste straight into Google Docs, Notion, Word or an email. */
export async function copyRich(groups, title) {
  const html = toHtml(groups, title);
  const text = toMarkdown(groups);
  if (navigator.clipboard?.write && window.ClipboardItem) {
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
  } else {
    await navigator.clipboard.writeText(text);
  }
}

// ───────── words → Anki ─────────
export function wordsToAnki(words) {
  const clean = (s) => String(s || "").replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
  const lines = ["#separator:tab", "#html:true", "#tags column:3"];
  for (const w of words) {
    const defs = w.customDef ? [w.customDef] : (w.meanings || []).flatMap((m) => (m.defs || []).slice(0, 2).map((d) => `<i>${m.pos || ""}</i> ${d.d}`)).slice(0, 3);
    const ctx = w.sources?.[0]?.context || w.source?.context || "";
    const back = [w.phonetic ? `<div>${w.phonetic}</div>` : "", defs.map((d) => `<div>${d}</div>`).join(""),
      ctx ? `<div style="color:#777;margin-top:8px">“${clean(ctx)}”${w.source?.title ? ` — ${clean(w.source.title)}` : ""}</div>` : ""].join("");
    lines.push([clean(w.word), clean(back), ["luma", ...(w.source?.title ? [w.source.title.replace(/\s+/g, "_").slice(0, 40)] : [])].join(" ")].join("\t"));
  }
  return lines.join("\n");
}

export function downloadAnki(words) {
  downloadBlob(new Blob([wordsToAnki(words)], { type: "text/plain" }), `luma-words-anki-${today()}.txt`);
}

// ───────── tiny zip writer (stored, no compression) ─────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (d) => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true); local.setUint32(18, f.data.length, true); local.setUint32(22, f.data.length, true); local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, f.data.length, true); cen.setUint32(24, f.data.length, true); cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cenSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}
