// Find the word under the pointer in the PDF text layer (or Book view text) and
// show its definition: hover on laptops, single tap on phones and tablets.
import { store } from "../data/store.js";
import { showDefinition, hideDefinition, scheduleHide, cancelHide, definitionEl, isDefinitionOpen } from "../ui/definition.js";
import { LOWER_OK } from "../data/abbrev.js";

const WORD = /[\p{L}\p{M}'’\-]/u;

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

/** Returns { word, rect, node } or null */
export function wordAtPoint(x, y, scope) {
  const hit = caretAt(x, y);
  if (!hit || hit.node?.nodeType !== Node.TEXT_NODE) return null;
  const host = hit.node.parentElement;
  if (!host || !host.closest(".textLayer, .book-text") || (scope && !scope.contains(host))) return null;
  const text = hit.node.data;
  // caret offset may sit just after the word when pointing at its last letter
  let s = Math.min(hit.offset, text.length);
  let e = s;
  if (!WORD.test(text[s] || "") && WORD.test(text[s - 1] || "")) s = e = s - 1;
  while (s > 0 && WORD.test(text[s - 1])) s--;
  while (e < text.length && WORD.test(text[e])) e++;
  let word = text.slice(s, e).replace(/^['’\-]+|['’\-]+$/g, "");
  // abbreviations written with dots: "e.g.", "U.S.", "etc.", "Ph.D."
  for (const m of text.matchAll(/(?<![\p{L}.])(?:\p{L}{1,2}\.){2,}(?:\p{L}\b)?|(?<![\p{L}.])\p{L}{1,6}\.(?=\s|$|[,;:)])/gu)) {
    if (m.index <= s && m.index + m[0].length >= e && (m[0].split(".").length > 2 || LOWER_OK.has(m[0].slice(0, -1).toLowerCase()))) {
      s = m.index; e = m.index + m[0].length; word = m[0];
      break;
    }
  }
  if (!word || word.length < 2 || !/\p{L}/u.test(word)) return null;
  const lead = text.slice(s, e).indexOf(word);
  const range = document.createRange();
  range.setStart(hit.node, s + lead);
  range.setEnd(hit.node, s + lead + word.length);
  const rects = [...range.getClientRects()];
  const rect = rects.find((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 3 && y <= r.bottom + 3);
  if (!rect) return null;
  return { word, rect, node: hit.node, offset: s + lead, phrase: properNounAround(text, s + lead, word) };
}

/** "Adam Smith", "New Delhi": a run of capitalised words around the hovered one. */
function properNounAround(text, start, word) {
  if (!/^\p{Lu}\p{Ll}/u.test(word)) return null;
  const words = [];
  const re = /[\p{L}'’.-]+/gu;
  let m;
  while ((m = re.exec(text))) words.push({ w: m[0].replace(/[.’']+$/, ""), s: m.index, e: m.index + m[0].length });
  const i = words.findIndex((x) => x.s <= start && x.e > start);
  if (i < 0) return null;
  let a = i, b = i;
  while (a > 0 && i - a < 3 && /^\p{Lu}/u.test(words[a - 1].w) && /^\s$/.test(text.slice(words[a - 1].e, words[a].s)) && !/[.!?:;]$/.test(text.slice(words[a - 1].s, words[a - 1].e))) a--;
  while (b < words.length - 1 && b - a < 3 && /^\p{Lu}/u.test(words[b + 1].w) && /^\s$/.test(text.slice(words[b].e, words[b + 1].s))) b++;
  if (a === b) return null;
  return words.slice(a, b + 1).map((x) => x.w).join(" ");
}

/** About one sentence of text around the word, for the "where you met it" note. */
export function contextAround(node, word) {
  const host = node.parentElement;
  const layer = host.closest(".textLayer, .book-text");
  let text = "";
  if (!layer || host.closest(".book-text")) {
    text = host.closest(".bk-b")?.textContent || host.textContent;
  } else {
    const spans = [...layer.querySelectorAll("span:not(.markedContent)")].filter((s) => !s.querySelector("span"));
    const i = spans.indexOf(host);
    const slice = spans.slice(Math.max(0, i - 4), i + 5);
    text = slice.map((s) => s.textContent).join(" ");
  }
  text = text.replace(/\s+/g, " ").trim();
  const idx = text.toLowerCase().indexOf(word.toLowerCase());
  if (idx < 0) return text.slice(0, 220);
  const before = text.slice(0, idx);
  const startCut = Math.max(before.search(/[^.!?]*$/), idx - 140, 0);
  const after = text.slice(idx);
  const endRel = after.search(/[.!?](\s|$)/);
  const end = Math.min(endRel >= 0 ? idx + endRel + 1 : text.length, idx + word.length + 140);
  const body = text.slice(startCut, end).trim();
  return (startCut > 0 ? "…" : "") + body + (end < text.length && !/[.!?]$/.test(body) ? "…" : "");
}

/**
 * Wire lookups to a container. `getSource(node)` returns { docId, title, page }.
 */
export function attachLookup(container, getSource) {
  let timer = null;
  let pending = null;
  let marker = null;
  let down = null;

  const clearMarker = () => { marker?.remove(); marker = null; };
  const showMarker = (rect) => {
    clearMarker();
    marker = document.createElement("div");
    marker.className = "word-marker";
    Object.assign(marker.style, { left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
    document.body.append(marker);
  };

  const open = (hit, sticky) => {
    if (!hit.node.isConnected) return; // the page changed while the pointer rested
    const src = getSource(hit.node) || {};
    showMarker(hit.rect);
    showDefinition(hit.word, hit.rect, { ...src, context: contextAround(hit.node, hit.word) }, { sticky, phrase: hit.phrase });
  };

  const selectionActive = () => {
    const s = document.getSelection();
    return s && !s.isCollapsed && s.toString().trim().length > 0;
  };

  container.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || e.buttons) return;
    const s = store.settings();
    if (!s.hoverLookup || selectionActive()) return;
    const card = definitionEl();
    if (card && card.contains(e.target)) return;
    const hit = wordAtPoint(e.clientX, e.clientY, container);
    const key = hit ? hit.word + "|" + Math.round(hit.rect.left) + "|" + Math.round(hit.rect.top) : null;
    if (key === pending) return;
    pending = key;
    clearTimeout(timer);
    if (!hit) {
      if (isDefinitionOpen()) scheduleHide(320);
      clearMarker();
      return;
    }
    cancelHide();
    timer = setTimeout(() => open(hit, false), Math.max(80, s.hoverDelay));
  });

  container.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(timer);
    pending = null;
    if (isDefinitionOpen() && !definitionEl()?.classList.contains("sticky")) scheduleHide(320);
  });

  container.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType };
    if (e.pointerType === "mouse") { clearTimeout(timer); pending = null; }
  });

  container.addEventListener("pointerup", (e) => {
    if (!down || e.pointerType === "mouse") return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 400;
    down = null;
    if (moved > 10 || !quick || !store.settings().tapLookup) return;
    setTimeout(() => {
      if (selectionActive()) return;
      const hit = wordAtPoint(e.clientX, e.clientY, container);
      if (hit) open(hit, true);
      else if (isDefinitionOpen()) hideDefinition();
    }, 30);
  });

  container.addEventListener("scroll", () => { clearMarker(); if (isDefinitionOpen()) hideDefinition(); }, { capture: true, passive: true });
  document.addEventListener("pointerdown", (e) => {
    const card = definitionEl();
    if (card && !card.contains(e.target) && !container.contains(e.target)) hideDefinition();
  }, true);

  return { clearMarker };
}

// Keep the marker in sync with the card.
import { bus } from "../core/util.js";
bus.on("definition-closed", () => document.querySelectorAll(".word-marker").forEach((m) => m.remove()));
