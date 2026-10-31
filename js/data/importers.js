// Turn EPUB books, web articles, HTML, Markdown and plain text into the same
// clean block list Book view uses for PDFs:
//   { type: "h" | "p" | "img" | "quote" | "li", level?, text?, src?, anchor? }
// Everything runs in the browser; EPUB files are unzipped with the browser's
// built-in decompression (no libraries).

// ───────── ZIP (for EPUB) ─────────
async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  // find End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This file isn't a valid EPUB (zip) file.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const cache = new Map();
  async function bytes(name) {
    const e = entries.get(name) || entries.get(decodeURIComponent(name));
    if (!e) return null;
    if (cache.has(name)) return cache.get(name);
    const lnl = dv.getUint16(e.local + 26, true);
    const lel = dv.getUint16(e.local + 28, true);
    const start = e.local + 30 + lnl + lel;
    const raw = buf.subarray(start, start + e.csize);
    const out = e.method === 0 ? raw : e.method === 8 ? await inflateRaw(raw) : null;
    cache.set(name, out);
    return out;
  }
  return {
    names: () => [...entries.keys()],
    bytes,
    text: async (name) => { const b = await bytes(name); return b ? new TextDecoder().decode(b) : null; },
  };
}

// ───────── HTML → blocks ─────────
const BLOCK_TAGS = new Set(["P", "DIV", "LI", "BLOCKQUOTE", "PRE", "DD", "DT", "FIGCAPTION", "TD", "TH", "SECTION", "ARTICLE", "ASIDE"]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "FOOTER", "HEADER", "FORM", "BUTTON", "SVG", "IFRAME", "TEMPLATE", "SELECT", "INPUT", "TEXTAREA", "MATH"]);
const clean = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Walk an element and emit blocks. `resolveImg(src)` returns a usable URL (or
 * null to drop the image). `ids` collects element ids → block index (EPUB links).
 */
export function htmlToBlocks(root, { resolveImg = (s) => s, ids = null, keepAsides = false } = {}) {
  const blocks = [];
  let buf = "";
  let bufKind = "p";
  const pendingIds = [];
  const flush = () => {
    const t = clean(buf);
    if (t) {
      const b = { type: bufKind === "li" ? "p" : bufKind, text: bufKind === "li" ? "• " + t : t };
      blocks.push(b);
    }
    if (ids) pendingIds.splice(0).forEach((id) => ids.set(id, Math.max(0, blocks.length - (t ? 1 : 0))));
    buf = "";
    bufKind = "p";
  };
  const walk = (node) => {
    if (node.nodeType === 3) { buf += node.data; return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag) && !(keepAsides && tag === "ASIDE")) return;
    if (node.getAttribute?.("aria-hidden") === "true" || node.hidden) return;
    if (node.id && ids) pendingIds.push(node.id);
    if (/^H[1-6]$/.test(tag)) {
      flush();
      const t = clean(node.textContent);
      if (t) blocks.push({ type: "h", level: Number(tag[1]) <= 2 ? 2 : 3, text: t });
      if (ids) pendingIds.splice(0).forEach((id) => ids.set(id, blocks.length - 1));
      return;
    }
    if (tag === "IMG" || tag === "IMAGE") {
      const src = node.getAttribute("src") || node.getAttribute("xlink:href") || node.getAttribute("href");
      const url = src && resolveImg(src);
      if (url) {
        flush();
        blocks.push({ type: "img", src: url, alt: node.getAttribute("alt") || "" });
      }
      return;
    }
    if (tag === "BR") { buf += " "; return; }
    if (tag === "HR") { flush(); blocks.push({ type: "hr", text: "" }); return; }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) flush();
    if (tag === "LI") bufKind = "li";
    if (tag === "BLOCKQUOTE") bufKind = "quote";
    for (const c of node.childNodes) walk(c);
    if (isBlock) flush();
  };
  walk(root);
  flush();
  return blocks.filter((b) => b.type !== "hr" || blocks.length);
}

// ───────── EPUB ─────────
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
function resolvePath(base, rel) {
  if (!rel) return rel;
  if (/^[a-z]+:/i.test(rel)) return rel;
  const parts = (dirOf(base) + rel.split("#")[0]).split("/");
  const out = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}
const parseXml = (text, type = "application/xml") => new DOMParser().parseFromString(text, type);
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" };

/** Quick metadata for importing: title, author, cover image blob, word count estimate. */
export async function epubInfo(blob) {
  const zip = await readZip(blob);
  const { opf, opfPath } = await readOpf(zip);
  const meta = (tag) => clean(opf.getElementsByTagNameNS("*", tag)[0]?.textContent || "");
  let cover = null;
  const items = [...opf.getElementsByTagNameNS("*", "item")];
  const coverMeta = [...opf.getElementsByTagNameNS("*", "meta")].find((m) => m.getAttribute("name") === "cover")?.getAttribute("content");
  const coverItem = items.find((i) => (i.getAttribute("properties") || "").includes("cover-image")) || items.find((i) => i.getAttribute("id") === coverMeta);
  if (coverItem) {
    const path = resolvePath(opfPath, coverItem.getAttribute("href"));
    const b = await zip.bytes(path);
    if (b) cover = new Blob([b], { type: coverItem.getAttribute("media-type") || "image/jpeg" });
  }
  return { title: meta("title"), author: meta("creator"), cover };
}

async function readOpf(zip) {
  const container = await zip.text("META-INF/container.xml");
  if (!container) throw new Error("This EPUB is missing its table of contents (container.xml).");
  const opfPath = parseXml(container).getElementsByTagNameNS("*", "rootfile")[0]?.getAttribute("full-path");
  const opfText = await zip.text(opfPath);
  if (!opfText) throw new Error("This EPUB's package file couldn't be read.");
  return { opf: parseXml(opfText), opfPath };
}

/** Full parse into blocks + table of contents. Image URLs are object URLs for this session. */
export async function parseEpub(blob) {
  const zip = await readZip(blob);
  const { opf, opfPath } = await readOpf(zip);
  const manifest = new Map();
  for (const it of opf.getElementsByTagNameNS("*", "item")) {
    manifest.set(it.getAttribute("id"), { href: resolvePath(opfPath, it.getAttribute("href")), type: it.getAttribute("media-type") || "", props: it.getAttribute("properties") || "" });
  }
  const spine = [...opf.getElementsByTagNameNS("*", "itemref")].map((r) => manifest.get(r.getAttribute("idref"))).filter(Boolean);
  const blocks = [];
  const anchors = new Map(); // "path#id" | "path" → block index
  const imgCache = new Map();
  const imageUrl = async (path) => {
    if (imgCache.has(path)) return imgCache.get(path);
    const b = await zip.bytes(path);
    const url = b ? URL.createObjectURL(new Blob([b], { type: MIME[path.split(".").pop().toLowerCase()] || "image/*" })) : null;
    imgCache.set(path, url);
    return url;
  };
  for (const item of spine) {
    if (!/html|xml/.test(item.type)) continue;
    const text = await zip.text(item.href);
    if (!text) continue;
    let doc = parseXml(text, "application/xhtml+xml");
    if (doc.getElementsByTagName("parsererror").length) doc = parseXml(text, "text/html");
    const body = doc.body || doc.getElementsByTagName("body")[0];
    if (!body) continue;
    // collect image paths first (async), then walk synchronously
    const imgs = [...body.querySelectorAll("img, image")];
    const urls = new Map();
    for (const im of imgs) {
      const src = im.getAttribute("src") || im.getAttribute("xlink:href") || im.getAttributeNS?.("http://www.w3.org/1999/xlink", "href");
      if (src) urls.set(src, await imageUrl(resolvePath(item.href, src)));
    }
    const ids = new Map();
    const start = blocks.length;
    anchors.set(item.href, start);
    const part = htmlToBlocks(body, { resolveImg: (src) => urls.get(src) || null, ids });
    ids.forEach((idx, id) => anchors.set(`${item.href}#${id}`, start + idx));
    blocks.push(...part);
  }
  // Table of contents: EPUB 3 nav, else EPUB 2 NCX
  const toc = [];
  const navItem = [...manifest.values()].find((m) => m.props.includes("nav"));
  const ncxItem = [...manifest.values()].find((m) => m.type === "application/x-dtbncx+xml");
  const target = (base, href) => {
    const full = resolvePath(base, href) + (href.includes("#") ? "#" + href.split("#")[1] : "");
    return anchors.get(full) ?? anchors.get(full.split("#")[0]);
  };
  if (navItem) {
    const nav = parseXml(await zip.text(navItem.href), "application/xhtml+xml");
    const tocNav = [...nav.getElementsByTagName("nav")].find((n) => (n.getAttribute("epub:type") || n.getAttributeNS?.("http://www.idpf.org/2007/ops", "type") || "").includes("toc")) || nav.getElementsByTagName("nav")[0];
    const walk = (ol, depth) => {
      for (const li of ol?.children || []) {
        const a = li.querySelector("a");
        if (a) { const idx = target(navItem.href, a.getAttribute("href") || ""); if (idx != null) toc.push({ title: clean(a.textContent), block: idx, depth }); }
        const sub = li.querySelector("ol");
        if (sub) walk(sub, depth + 1);
      }
    };
    walk(tocNav?.querySelector("ol"), 0);
  } else if (ncxItem) {
    const ncx = parseXml(await zip.text(ncxItem.href));
    const walk = (parent, depth) => {
      for (const np of parent.children) {
        if (np.localName !== "navPoint") continue;
        const title = clean(np.getElementsByTagNameNS("*", "text")[0]?.textContent || "");
        const src = np.getElementsByTagNameNS("*", "content")[0]?.getAttribute("src") || "";
        const idx = target(ncxItem.href, src);
        if (idx != null) toc.push({ title, block: idx, depth });
        walk(np, depth + 1);
      }
    };
    const map = ncx.getElementsByTagNameNS("*", "navMap")[0];
    if (map) walk(map, 0);
  }
  return { blocks, toc };
}

// ───────── Articles & plain text ─────────

/** Pick the main readable part of a web page (a light "reader mode"). */
export function extractArticle(doc, url = "") {
  for (const sel of ["script", "style", "noscript", "nav", "footer", "header", "aside", "form", "iframe", "[role=navigation]", "[role=banner]", "[role=contentinfo]", ".comments, #comments, .share, .social, .related, .newsletter, .advert, .ad, .ads, .cookie"]) {
    doc.querySelectorAll(sel).forEach((n) => n.remove());
  }
  let best = doc.querySelector("article, [itemprop=articleBody], main, [role=main]");
  if (!best || clean(best.textContent).length < 400) {
    // densest container of paragraphs
    let top = 0;
    for (const el of doc.querySelectorAll("div, section, td")) {
      const ps = el.querySelectorAll(":scope > p");
      const score = [...ps].reduce((n, p) => n + clean(p.textContent).length, 0);
      if (score > top) { top = score; best = el; }
    }
  }
  best ||= doc.body;
  const title = clean(doc.querySelector("meta[property='og:title']")?.content || doc.querySelector("h1")?.textContent || doc.title || "Article");
  const byline = clean(doc.querySelector("meta[name=author]")?.content || doc.querySelector("[rel=author], .byline, .author")?.textContent || "");
  const site = clean(doc.querySelector("meta[property='og:site_name']")?.content || (url ? new URL(url).hostname.replace(/^www\./, "") : ""));
  const resolveImg = (src) => { try { return new URL(src, url || location.href).href; } catch { return null; } };
  let blocks = htmlToBlocks(best, { resolveImg });
  if (blocks[0]?.type === "h" && clean(blocks[0].text) === title) blocks = blocks.slice(1);
  return { title, author: byline || site, blocks: [{ type: "h", level: 2, text: title }, ...blocks] };
}

/** Markdown (also what the free reader service returns) → blocks. */
export function markdownToBlocks(md) {
  const blocks = [];
  let para = [];
  const inline = (s) => s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1");
  const flush = () => { const t = clean(inline(para.join(" "))); if (t) blocks.push({ type: "p", text: t }); para = []; };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,6})\s+(.+)/);
    const img = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)[^)]*\)\s*$/);
    if (h) { flush(); blocks.push({ type: "h", level: h[1].length <= 2 ? 2 : 3, text: clean(inline(h[2])) }); }
    else if (img) { flush(); blocks.push({ type: "img", src: img[2], alt: img[1] }); }
    else if (/^\s*([-*+]|\d+\.)\s+/.test(line)) { flush(); blocks.push({ type: "p", text: "• " + clean(inline(line.replace(/^\s*([-*+]|\d+\.)\s+/, ""))) }); }
    else if (/^\s*>\s?/.test(line)) { flush(); blocks.push({ type: "quote", text: clean(inline(line.replace(/^\s*>\s?/, ""))) }); }
    else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) flush();
    else if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return blocks.filter((b) => b.type === "img" || b.text);
}

export function textToBlocks(text) {
  const looksMd = /^#{1,6}\s/m.test(text) || /\[[^\]]+\]\([^)]+\)/.test(text);
  if (looksMd) return markdownToBlocks(text);
  return text.split(/\n\s*\n/).map((p) => clean(p)).filter(Boolean).map((t) => {
    const short = t.length < 70 && !/[.!?,;:]$/.test(t) && t.split(" ").length < 10;
    return short ? { type: "h", level: 3, text: t } : { type: "p", text: t };
  });
}

/**
 * Fetch a web article as clean text. Uses the free Jina Reader service
 * (r.jina.ai), which most sites allow; falls back to fetching the page directly.
 */
export async function fetchArticle(url) {
  const u = new URL(url);
  try {
    const res = await fetch(`https://r.jina.ai/${u.href}`, { headers: { Accept: "text/plain", "X-Return-Format": "markdown" } });
    if (res.ok) {
      const text = await res.text();
      const title = clean(text.match(/^Title:\s*(.+)$/m)?.[1] || u.hostname);
      const body = text.includes("Markdown Content:") ? text.split("Markdown Content:").slice(1).join("Markdown Content:") : text;
      let blocks = markdownToBlocks(body);
      if (blocks[0]?.type === "h" && clean(blocks[0].text) === title) blocks = blocks.slice(1);
      if (blocks.filter((b) => b.type === "p").length >= 2) {
        return { title, author: u.hostname.replace(/^www\./, ""), url: u.href, blocks: [{ type: "h", level: 2, text: title }, ...blocks] };
      }
    }
  } catch { /* try direct */ }
  const res = await fetch(u.href);
  if (!res.ok) throw new Error(`The page answered with error ${res.status}.`);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  return { ...extractArticle(doc, u.href), url: u.href };
}
