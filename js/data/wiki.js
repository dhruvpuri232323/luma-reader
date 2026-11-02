// Wikipedia, read inside the app: search, summaries, whole articles, the key
// facts from an article's infobox, its pictures, related articles, and the one
// sentence that best answers a phrase ("fastest human" → Footspeed: "The fastest
// human footspeed on record is …"). Everything opened once is kept for offline use.
import { store } from "./store.js";
import { anatomy } from "./morphology.js";

const WP = "https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*&";
const API = "https://en.wikipedia.org/w/api.php?format=json&formatversion=2&origin=*&";
const REST = "https://en.wikipedia.org/api/rest_v1/";
const mem = new Map(); // request → promise, for this session

function getJson(url) {
  if (!mem.has(url)) {
    mem.set(url, fetch(url, { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(Object.assign(new Error("Wikipedia " + r.status), { status: r.status }))))
      .catch((e) => { mem.delete(url); throw e; }));
  }
  return mem.get(url);
}
const wpGet = (params) => getJson(WP + new URLSearchParams(params));
const apiGet = (params) => getJson(API + new URLSearchParams(params));
const titleKey = (t) => String(t).trim().replace(/ /g, "_");

/** Network first, the copy kept on this device when offline. */
async function cached(key, fetcher) {
  try {
    const v = await fetcher();
    if (v != null) store.kvSet(key, v).catch(() => {});
    return v;
  } catch (e) {
    const saved = await store.kvGet(key).catch(() => null);
    if (saved != null) return saved;
    if (e?.status === 404) return null;
    throw e;
  }
}

/** Wikipedia articles matching a query: [{ title, description, extract, thumb }] */
export function wikiSearch(q, { limit = 8 } = {}) {
  return cached("wps:" + q.toLowerCase(), async () => {
    const d = await wpGet({
      generator: "search", gsrsearch: q, gsrlimit: limit, gsrprop: "", redirects: 1,
      prop: "pageimages|description|extracts", piprop: "thumbnail", pithumbsize: 160, pilimit: limit,
      exintro: 1, explaintext: 1, exsentences: 2, exlimit: limit,
    });
    return (d.query?.pages || [])
      .filter((p) => !p.missing)
      .sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
      .map((p) => ({ title: p.title, description: p.description || "", extract: (p.extract || "").replace(/\s+/g, " ").trim(), thumb: p.thumbnail?.source || "" }))
      .filter((p) => !/may (also )?refer to:?$/i.test(p.extract)); // skip "X may refer to:" lists
  });
}

/** The page summary for an exact title (follows redirects): { title, description, extract, thumb, url, type } */
export function wikiSummary(title) {
  if (!title) return Promise.resolve(null);
  return cached("wpsum:" + title.toLowerCase(), async () => {
    const d = await getJson(REST + "page/summary/" + encodeURIComponent(titleKey(title)) + "?redirect=true");
    if (!d?.title) return null;
    return {
      title: d.title, description: d.description || "", extract: (d.extract || "").trim(), thumb: d.thumbnail?.source || "",
      image: d.originalimage?.source || "", type: d.type || "standard",
      url: d.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(titleKey(d.title))}`,
    };
  });
}

const SKIP = /^(see also|references|notes|footnotes|citations|sources|external links|further reading|bibliography|works cited|notes and references|explanatory notes|general and cited sources)$/i;

export function sectionsOf(text) {
  const all = [{ title: "", level: 2, paras: [] }];
  for (const line of text.split("\n")) {
    const m = line.match(/^(={2,6})\s*(.*?)\s*\1\s*$/);
    if (m) { all.push({ title: m[2], level: m[1].length, paras: [] }); continue; }
    const t = line.trim();
    if (t) all[all.length - 1].paras.push(t);
  }
  const kept = [];
  let skipBelow = 0;
  for (const s of all) {
    if (skipBelow && s.level > skipBelow) continue;
    skipBelow = 0;
    if (s.title && SKIP.test(s.title)) { skipBelow = s.level; continue; }
    kept.push(s);
  }
  // keep a heading only if it has text, or sub-sections that do
  return kept.filter((s, i) => s.paras.length || (kept[i + 1] && kept[i + 1].level > s.level && kept.slice(i + 1).some((x) => x.paras.length)));
}

/** A whole Wikipedia article as plain text sections. */
export function wikiArticle(title, { keep = true } = {}) {
  const load = async () => {
    const d = await wpGet({
      prop: "extracts|pageimages|description|info", inprop: "url", redirects: 1, titles: title,
      explaintext: 1, exsectionformat: "wiki", piprop: "thumbnail", pithumbsize: 640,
    });
    const p = d.query?.pages?.[0];
    if (!p || p.missing || !p.extract) return null;
    return {
      title: p.title, description: p.description || "",
      url: p.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(titleKey(p.title))}`,
      thumb: p.thumbnail?.source || "", sections: sectionsOf(p.extract),
    };
  };
  // articles you open are kept for offline reading; ones only searched for an answer are not
  return keep ? cached("wpa:" + title.toLowerCase(), load) : load();
}

// ───────── key facts (the infobox) ─────────
const clean = (s) => s.replace(/\[\s*\d+\s*\]|\[[a-z]\]|\[note \d+\]|\[citation needed\]/gi, "").replace(/\s+/g, " ").replace(/\s([,.;:)])/g, "$1").replace(/\(\s/g, "(").trim();

/** The facts box at the top right of an article: [{ label, value }] plus its picture. */
export function wikiFacts(title) {
  return cached("wpf:" + title.toLowerCase(), async () => {
    const d = await apiGet({ action: "parse", page: title, prop: "text", section: 0, redirects: 1, disableeditsection: 1, disabletoc: 1 });
    const html = d?.parse?.text;
    if (!html) return { facts: [], image: "" };
    const doc = new DOMParser().parseFromString(html, "text/html");
    const box = doc.querySelector("table.infobox, table.vcard, table.biota");
    if (!box) return { facts: [], image: "" };
    box.querySelectorAll("sup, style, .noprint, .mw-ref, .reference, .sortkey, .nowrap .geo-nondefault, .plainlinks.hlist.navbar, link").forEach((n) => n.remove());
    box.querySelectorAll("br").forEach((b) => b.replaceWith("; "));
    box.querySelectorAll("li").forEach((li) => li.append("; "));
    const img = box.querySelector(".infobox-image img, td img");
    const src = img?.getAttribute("src") || "";
    const facts = [];
    let section = "";
    for (const tr of box.querySelectorAll("tr")) {
      const th = tr.querySelector("th"), td = tr.querySelector("td");
      if (th && !td) { section = clean(th.textContent); continue; } // a sub-heading inside the box
      if (!th || !td) continue;
      const label = clean(th.textContent).replace(/[:;]+$/, "");
      const value = clean(td.textContent).replace(/(;\s*)+/g, "; ").replace(/^;\s*|;\s*$/g, "");
      if (!label || !value || label.length > 40 || /^(website|signature|url)$/i.test(label)) continue;
      facts.push({ label, value: value.length > 220 ? value.slice(0, 217) + "…" : value, section });
      if (facts.length >= 30) break;
    }
    return { facts, image: src.startsWith("//") ? "https:" + src : src };
  });
}

// ───────── pictures ─────────
/** The article's pictures, with captions: [{ src, full, caption }] */
export function wikiMedia(title) {
  return cached("wpm:" + title.toLowerCase(), async () => {
    const d = await getJson(REST + "page/media-list/" + encodeURIComponent(titleKey(title)));
    const items = (d?.items || []).filter((x) => x.type === "image" && x.srcset?.length && (x.showInGallery || /\.(jpe?g|png|webp|gif|tiff?)$/i.test(x.title || "")));
    const abs = (u) => (u?.startsWith("//") ? "https:" + u : u);
    const seen = new Set();
    return items.map((x) => ({ src: abs(x.srcset[0].src), full: abs(x.srcset[x.srcset.length - 1].src), caption: (x.caption?.text || "").trim() }))
      .filter((x) => x.src && !seen.has(x.src) && seen.add(x.src)).slice(0, 14);
  });
}

// ───────── related articles ─────────
export function wikiRelated(title) {
  return cached("wpr:" + title.toLowerCase(), async () => {
    const d = await wpGet({
      generator: "search", gsrsearch: `morelike:${title}`, gsrlimit: 8, gsrnamespace: 0, gsrprop: "",
      prop: "pageimages|description", piprop: "thumbnail", pithumbsize: 120, pilimit: 8,
    });
    return (d.query?.pages || []).filter((p) => !p.missing && p.title !== title)
      .sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
      .map((p) => ({ title: p.title, description: p.description || "", thumb: p.thumbnail?.source || "" }));
  });
}

// ───────── the sentence that answers a phrase ─────────
const STOP = new Set("the a an of to in on at for and or but is are was were be with by from as that this it its into than then so such".split(" "));
export const contentWords = (text) => (String(text).toLowerCase().match(/[\p{L}][\p{L}'’-]*/gu) || []).filter((w) => !STOP.has(w) && w.length > 1);

function stemsOf(w) {
  const a = anatomy(w);
  return [...new Set([w, a?.base, w.replace(/(es|s)$/, "")].filter((x) => x && x.length >= 3))];
}

/** Split text into sentences (keeping "e.g." and "U.S." together). */
export function sentences(text) {
  return String(text).replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"(])/).filter((s) => s.length > 20 && s.length < 600);
}

/** Score how well a sentence answers the phrase. */
export function scoreSentence(s, phrase) {
  const lower = s.toLowerCase();
  const words = contentWords(phrase);
  let found = 0;
  for (const w of words) if (stemsOf(w).some((st) => new RegExp(`\\b${st.replace(/[^\p{L}'-]/gu, "")}`, "u").test(lower))) found++;
  const exact = lower.includes(phrase.toLowerCase());
  return { score: found * 10 + (exact ? 25 : 0) - s.length / 120, all: found === words.length, exact };
}

/**
 * What Wikipedia says about a phrase: the exact article if there is one
 * ("black hole"), otherwise the sentence in the best-matching articles that
 * uses it ("fastest human" → Footspeed). { topic, answer: { sentence, title }, results }
 */
export async function wikiAnswer(phrase) {
  const p = String(phrase).replace(/\s+/g, " ").trim();
  if (!p) return null;
  const key = "wpans:" + p.toLowerCase();
  if (!navigator.onLine) {
    const saved = await store.kvGet(key).catch(() => null);
    if (saved) return saved;
    throw new Error("offline");
  }
  return cached(key, () => findAnswer(p)); // the answer itself is small: kept for offline
}

async function findAnswer(p) {
  const [topic, results] = await Promise.all([
    wikiSummary(p).catch(() => null),
    wikiSearch(p, { limit: 5 }), // if Wikipedia can't be reached, keep the answer saved before
  ]);
  const exactTopic = topic && topic.type !== "disambiguation" && topic.extract ? topic : null;
  // look for the phrase inside the top articles
  let answer = null;
  for (const r of results.slice(0, 2)) {
    const art = await wikiArticle(r.title, { keep: false }).catch(() => null);
    if (!art) continue;
    let best = null;
    for (const sec of art.sections) for (const para of sec.paras) for (const s of sentences(para)) {
      const sc = scoreSentence(s, p);
      if (sc.all && (!best || sc.score > best.score)) best = { ...sc, sentence: s, title: art.title, section: sec.title };
    }
    if (best && (!answer || best.score > answer.score)) answer = best;
    if (answer?.exact) break;
  }
  return { topic: exactTopic, answer, results };
}
