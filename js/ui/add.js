// Adding things to read: files (PDF, EPUB, text, Markdown, saved web pages),
// any web article from a link, pasted text, a one-click "Save to Luma" button
// for your browser's bookmarks bar, and links shared from other apps.
import { el, $ } from "../core/util.js";
import { importBlocks } from "../data/library.js";
import { fetchArticle, extractArticle, markdownToBlocks, textToBlocks } from "../data/importers.js";
import { icon } from "./icons.js";
import { toast, menu, dialog, confirmDialog } from "./overlay.js";
import { navigate } from "./router.js";
import { cue } from "../core/feel.js";

export function addMenu(anchor) {
  menu(anchor, [
    { label: "Files — PDF, EPUB, text", icon: "upload", onClick: () => $("#file-input").click() },
    { label: "A web article, from its link", icon: "link", onClick: () => articleDialog() },
    { label: "Paste text", icon: "paste", onClick: () => pasteDialog() },
    "-",
    { label: "“Save to Luma” button for your browser", icon: "globe", onClick: () => bookmarkletDialog() },
  ], { align: "end" });
}

async function finish(res, open = true) {
  cue("save");
  toast(res.status === "linked" ? "Already in your library — updated" : `Added “${res.title || "article"}”`, open ? {} : { action: "Open", onAction: () => navigate(`#/read/${res.id}`) });
  if (open) navigate(`#/read/${res.id}`);
}

export async function addFromUrl(url, { open = true } = {}) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url); } catch { toast("That doesn't look like a web address.", { tone: "warn" }); return null; }
  const close = toast(`Fetching ${u.hostname}…`, { duration: 60000 });
  try {
    const art = await fetchArticle(u.href);
    if (!art.blocks?.filter((b) => b.type === "p").length) throw new Error("No article text was found on that page.");
    const res = await importBlocks({ ...art, fileName: `${u.hostname}.json` });
    close();
    await finish(res, open);
    return res;
  } catch (e) {
    close();
    toast((navigator.onLine ? (e.message || "That page couldn't be fetched.") : "You're offline.") + " Tip: the “Save to Luma” button works on any page you can open.", { tone: "warn", duration: 8000 });
    return null;
  }
}

export function articleDialog(prefill = "") {
  return dialog({
    title: "Add a web article",
    body: (c, done) => {
      const input = el("input.input", { type: "url", inputmode: "url", placeholder: "https://…", value: prefill, "aria-label": "Article link" });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(input.value); } });
      c.append(
        el("p.muted.small", {}, "Paste the link to an article or blog post. Luma keeps just the text and pictures — no ads, no pop-ups — and sets it as a book you can listen to, highlight and look words up in."),
        el("label.field", {}, el("span", {}, "Link"), input));
      if (!prefill) navigator.clipboard?.readText?.().then((t) => { if (/^https?:\/\/\S+$/.test(t.trim()) && !input.value) input.value = t.trim(); }).catch(() => {});
    },
    actions: [{ label: "Cancel", value: null }, { label: "Add article", primary: true, value: (c) => c.querySelector("input").value }],
  }).then((url) => (url?.trim() ? addFromUrl(url.trim()) : null));
}

export function pasteDialog() {
  return dialog({
    title: "Paste text",
    className: "paste-dialog",
    body: (c) => {
      c.append(
        el("label.field", {}, el("span", {}, "Title"), el("input.input.paste-title", { placeholder: "Give it a name" })),
        el("label.field", {}, el("span", {}, "Text"), el("textarea.input.paste-text", { rows: 10, placeholder: "Paste anything — an essay, notes, a chapter. Markdown headings (#) become chapters." })));
    },
    actions: [{ label: "Cancel", value: null }, { label: "Add", primary: true, value: (c) => ({ title: c.querySelector(".paste-title").value, text: c.querySelector(".paste-text").value }) }],
  }).then(async (v) => {
    if (!v?.text?.trim()) return null;
    return addText(v.text, v.title);
  });
}

export async function addText(text, title = "") {
  const md = /^#{1,3}\s|\n#{1,3}\s|\*\*|\n[-*] /.test(text);
  const blocks = md ? markdownToBlocks(text) : textToBlocks(text);
  const name = title.trim() || text.trim().split("\n")[0].replace(/^#+\s*/, "").slice(0, 70) || "Pasted text";
  const res = await importBlocks({ title: name, blocks, fileName: name + ".json" });
  await finish(res);
  return res;
}

/** A bookmark that sends the page you're on to Luma (works on paywalled or signed-in pages you can see). */
export function bookmarkletCode() {
  const app = location.origin + location.pathname;
  const origin = location.origin;
  return `javascript:(()=>{var w=window.open(${JSON.stringify(app + "?clip=1#/library")},"luma");var d={type:"luma-article",url:location.href,title:document.title,html:document.documentElement.outerHTML.slice(0,4e6)};var n=0;var t=setInterval(function(){try{w.postMessage(d,${JSON.stringify(origin)})}catch(e){}if(++n>60)clearInterval(t)},500);window.addEventListener("message",function(e){if(e.data==="luma-got-it")clearInterval(t)})})()`;
}

export function bookmarkletDialog() {
  return dialog({
    title: "Save articles from your browser",
    body: (c) => {
      const link = el("a.btn.primary.bookmarklet", { href: bookmarkletCode(), onclick: (e) => { e.preventDefault(); toast("Drag this button to your bookmarks bar"); }, draggable: "true" }, icon("book", 17), "Save to Luma");
      c.append(
        el("p", {}, "Drag this button to your browser's bookmarks bar. On any article, click it and the page opens in Luma, ready to read, hear and highlight — even pages you're signed in to."),
        el("div.bm-row", {}, link),
        el("p.muted.small", {}, "On a phone, use your browser's Share button and pick Luma Reader (after installing the app), or copy the link and use Add › A web article."),
        el("details.small", {}, el("summary", {}, "Can't drag? Copy the code instead"),
          el("p.muted", {}, "Make a new bookmark and paste this as its address:"),
          el("textarea.input.code", { rows: 4, readonly: true, onclick: (e) => e.target.select() }, bookmarkletCode())));
    },
    actions: [{ label: "Done", primary: true }],
  });
}

const seen = new Set();
/** Receive pages sent by the "Save to Luma" button. */
export function listenForClips() {
  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (!d || d.type !== "luma-article" || typeof d.html !== "string" || typeof d.url !== "string") return;
    try { e.source?.postMessage("luma-got-it", e.origin); } catch {}
    if (seen.has(d.url)) return;
    seen.add(d.url);
    let host = "";
    try { host = new URL(d.url).hostname; } catch { return; }
    const title = String(d.title || host).slice(0, 140);
    const ok = await confirmDialog("Add this page?", `“${title}” from ${host} will be added to your library as an article.`, { confirm: "Add to library" });
    if (!ok) return;
    try {
      const doc = new DOMParser().parseFromString(d.html, "text/html");
      const art = extractArticle(doc, d.url);
      if (!art.blocks.filter((b) => b.type === "p").length) throw new Error();
      const res = await importBlocks({ ...art, url: d.url, fileName: host + ".json" });
      await finish(res);
    } catch {
      toast("Couldn't find the article text on that page.", { tone: "warn" });
    }
  });
  const url = new URL(location.href);
  if (url.searchParams.has("clip")) {
    url.searchParams.delete("clip");
    history.replaceState(null, "", url.pathname + url.search + location.hash);
  }
}

/** Something shared to the app from another app: a link, or some text. */
export async function importShared({ title = "", text = "", url = "" }) {
  const link = url || (text.match(/https?:\/\/\S+/) || [])[0];
  if (link) return addFromUrl(link);
  if (text.trim()) return addText(text, title);
  return null;
}
