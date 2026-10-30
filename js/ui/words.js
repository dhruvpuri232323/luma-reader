// Vocabulary: saved words, editing, flashcards, spaced-repetition review, CSV.
import { el, $, bus, debounce, relTime, downloadBlob, escapeHtml, setKids } from "../core/util.js";
import { store } from "../data/store.js";
import { schedule, isDue, wordId, lookup, saveWord } from "../data/dictionary.js";
import { icon } from "./icons.js";
import { toast, dialog, confirmDialog, menu, promptDialog } from "./overlay.js";
import { playWord } from "./definition.js";
import { cue } from "../core/feel.js";
import { navigate } from "./router.js";

const ui = { query: "", filter: "all", open: null };
let root;

export function mountWords(container) {
  root = container;
  const rerender = debounce(render, 100);
  bus.on("change", ({ coll }) => coll === "words" && root.closest(".view")?.classList.contains("active") && rerender());
  bus.on("edit-word", (id) => editWord(id));
  render();
}

export function wordsShown() { render(); }

const firstDef = (w) => w.customDef || w.meanings?.[0]?.defs?.[0]?.d || "No definition yet — add your own.";

function render() {
  if (!root) return;
  const all = store.list("words");
  const due = all.filter((w) => w.status !== "mastered" && isDue(w));
  const q = ui.query.trim().toLowerCase();
  let list = all;
  if (q) list = list.filter((w) => w.word.includes(q) || firstDef(w).toLowerCase().includes(q) || (w.mnemonic || "").toLowerCase().includes(q));
  if (ui.filter === "learning") list = list.filter((w) => w.status !== "mastered");
  if (ui.filter === "mastered") list = list.filter((w) => w.status === "mastered");
  if (ui.filter === "due") list = list.filter((w) => w.status !== "mastered" && isDue(w));
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const focused = document.activeElement?.id === "words-search";
  const counts = { all: all.length, learning: all.filter((w) => w.status !== "mastered").length, mastered: all.filter((w) => w.status === "mastered").length, due: due.length };
  const chip = (k, l) => el("button.chip" + (ui.filter === k ? ".on" : ""), { onclick: () => { ui.filter = k; render(); }, "aria-pressed": String(ui.filter === k) }, l, el("span.chip-count", {}, counts[k]));

  setKids(root, 
    el("header.view-head", {},
      el("div.view-title", {}, el("h1", {}, "Words"),
        el("p.muted", {}, all.length ? `${counts.learning} learning · ${counts.mastered} mastered` : "Words you save while reading collect here")),
      el("div.head-actions", {},
        all.length ? el("button.btn", { onclick: exportCsv }, icon("download", 18), el("span", {}, "CSV")) : null,
        el("button.btn", { onclick: addWordManually }, icon("plus", 18), el("span", {}, "Add word")),
        all.length ? el("button.btn", { onclick: () => flashcards(list.length ? list : all, "browse") }, icon("cards", 18), el("span", {}, "Flashcards")) : null,
        el("button.btn.primary", { onclick: () => flashcards(due, "review"), disabled: !due.length },
          icon("calendar", 18), el("span", {}, due.length ? `Review ${due.length} due` : "Nothing due")))),
    all.length ? el("div.lib-tools", {},
      el("label.search-wrap", {}, icon("search", 18), el("input.input.search", {
        id: "words-search", type: "search", placeholder: "Search words, definitions, memory tricks", value: ui.query, "aria-label": "Search words",
        oninput: debounce((e) => { ui.query = e.target.value; render(); }, 120) })),
      el("div.chips", {}, chip("all", "All"), chip("due", "Due today"), chip("learning", "Learning"), chip("mastered", "Mastered"))) : null,
    all.length
      ? list.length ? el("ul.word-list", {}, list.map(wordRow)) : el("p.empty-line", {}, "No words match.")
      : el("section.empty", {},
          el("div.empty-word", { "aria-hidden": "true" }, el("span.ew-w", {}, "luminous"), el("span.ew-p", {}, "/ˈluːmɪnəs/"), el("span.ew-d", {}, "full of or shedding light")),
          el("h2", {}, "Hover any word while reading"),
          el("p.muted", {}, "On a laptop, rest the pointer on a word. On a phone, tap it. Save the definition with one click and it lands here, with the page you found it on."),
          el("button.btn.primary", { onclick: () => navigate("#/library") }, icon("library", 18), el("span", {}, "Go to library"))));
  if (focused) { const s = $("#words-search", root); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

function wordRow(w) {
  const open = ui.open === w.id;
  const src = w.source;
  const doc = src?.docId && store.get("docs", src.docId);
  return el("li.word" + (open ? ".open" : "") + (w.status === "mastered" ? ".mastered" : ""), { dataset: { id: w.id } },
    el("button.word-main", { "aria-expanded": String(open), onclick: () => { ui.open = open ? null : w.id; render(); } },
      el("span.word-w", {}, w.word),
      w.phonetic ? el("span.word-p", {}, w.phonetic) : null,
      el("span.word-d", {}, firstDef(w))),
    el("div.word-side", {},
      el("button.status-toggle" + (w.status === "mastered" ? ".on" : ""), {
        title: w.status === "mastered" ? "Mastered — click to keep learning" : "Learning — click when you know it",
        onclick: () => setStatus(w, w.status === "mastered" ? "learning" : "mastered"),
      }, w.status === "mastered" ? "Mastered" : "Learning"),
      el("button.icon-btn", { "aria-label": `Pronounce ${w.word}`, onclick: () => playWord(w.word, w.audio) }, icon("speak", 18)),
      el("button.icon-btn", { "aria-label": `More for ${w.word}`, onclick: (e) => menu(e.currentTarget, [
        { label: "Edit, add my definition or memory trick", icon: "edit", onClick: () => editWord(w.id) },
        doc ? { label: `Open p. ${src.page} in “${doc.title}”`, icon: "book", onClick: () => navigate(`#/read/${src.docId}/${src.page}`) } : null,
        "-",
        { label: "Delete word", icon: "trash", danger: true, onClick: async () => {
          if (await confirmDialog(`Delete “${w.word}”?`, "It will be removed from your words on every synced device.", { confirm: "Delete", danger: true })) {
            await store.remove("words", w.id); cue("remove");
          }
        } },
      ]) }, icon("more", 18))),
    open ? wordDetail(w, doc) : null);
}

function wordDetail(w, doc) {
  const src = w.source;
  return el("div.word-detail", {},
    w.customDef ? el("div.def-mine", {}, el("strong", {}, "Your definition"), el("p", {}, w.customDef)) : null,
    w.mnemonic ? el("div.def-mine.trick", {}, el("strong", {}, "Memory trick"), el("p", {}, w.mnemonic)) : null,
    (w.meanings || []).slice(0, 4).map((m) => el("section.def-sense", {},
      el("p.def-pos", {}, m.pos),
      el("ol", {}, m.defs.slice(0, 4).map((d) => el("li", {}, d.d, d.ex ? el("q.def-ex", {}, d.ex) : null))),
      m.synonyms?.length ? el("p.def-rel", {}, el("span", {}, "Similar"), " ", m.synonyms.slice(0, 8).join(", ")) : null,
      m.antonyms?.length ? el("p.def-rel", {}, el("span", {}, "Opposite"), " ", m.antonyms.slice(0, 6).join(", ")) : null)),
    src?.context ? el("blockquote.quote", {}, src.context) : null,
    el("p.small.muted", {},
      doc ? el("button.link", { onclick: () => navigate(`#/read/${src.docId}/${src.page}`) }, `From “${doc.title}”, page ${src.page}`)
        : src?.title ? `From “${src.title}”, page ${src.page}` : "Added by hand",
      ` · saved ${relTime(w.createdAt)}`,
      w.srs?.reps ? ` · next review ${w.srs.due <= Date.now() ? "today" : new Date(w.srs.due).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ""),
    el("div.row", {}, el("button.btn.sm", { onclick: () => editWord(w.id) }, icon("edit", 16), el("span", {}, "Edit"))));
}

async function setStatus(w, status) {
  await store.patch("words", w.id, { status });
  if (status === "mastered") cue("done");
}

export async function editWord(id) {
  const w = store.get("words", id);
  if (!w) return;
  const res = await dialog({
    title: `Edit “${w.word}”`,
    body: (c) => c.append(
      el("label.field", {}, el("span", {}, "Word"), el("input.input", { name: "word", value: w.word })),
      el("label.field", {}, el("span", {}, "Your definition"), el("textarea.input", { name: "customDef", rows: 3, placeholder: "In your own words" }, w.customDef || "")),
      el("label.field", {}, el("span", {}, "Memory trick"), el("textarea.input", { name: "mnemonic", rows: 2, placeholder: "A picture, rhyme or link that helps you remember" }, w.mnemonic || "")),
      el("label.field", {}, el("span", {}, "Status"), el("select.select", { name: "status" },
        el("option", { value: "learning", selected: w.status !== "mastered" }, "Learning"),
        el("option", { value: "mastered", selected: w.status === "mastered" }, "Mastered")))),
    actions: [
      { label: "Cancel", value: null },
      { label: "Save", primary: true, value: (c) => Object.fromEntries([...c.querySelectorAll("[name]")].map((i) => [i.name, i.value.trim()])) },
    ],
  });
  if (!res) return;
  const newWord = res.word.toLowerCase();
  if (newWord && newWord !== w.word) {
    const nid = wordId(newWord);
    if (nid !== w.id) {
      await store.put("words", { ...w, ...res, word: newWord, id: nid });
      await store.remove("words", w.id);
      toast("Word saved");
      return;
    }
  }
  await store.patch("words", w.id, { ...res, word: newWord || w.word });
  cue("save");
  toast("Word saved");
}

async function addWordManually() {
  const word = await promptDialog("Add a word", { label: "Word", placeholder: "e.g. perspicacious", confirm: "Look up & save" });
  if (!word?.trim()) return;
  const res = await lookup(word);
  const saved = await saveWord({ word, entry: res.entry, source: null });
  cue("save");
  if (res.status !== "ok") toast("No dictionary entry — add your own definition.", { action: "Edit", onAction: () => editWord(saved.id) });
  else toast(`Saved “${saved.word}”`);
  ui.open = saved.id;
  render();
}

// ───────────── flashcards & review ─────────────

function flashcards(words, mode) {
  if (!words.length) return;
  let deck = words.slice();
  if (mode === "browse") deck.sort(() => Math.random() - 0.5);
  let i = 0;
  let flipped = false;
  let reviewed = 0;

  dialog({
    title: mode === "review" ? "Review" : "Flashcards",
    className: "cards-dialog",
    body: (c, done) => {
      const progress = el("p.muted.small.cards-progress");
      const cardEl = el("button.flashcard", { "aria-live": "polite" });
      const controls = el("div.cards-controls");
      c.append(progress, cardEl, controls);

      const draw = () => {
        if (i >= deck.length) {
          cue("done");
          setKids(cardEl, el("div.fc-face", {}, el("p.fc-word", {}, mode === "review" ? "All caught up" : "End of deck"),
            el("p.muted", {}, mode === "review" ? `${reviewed} ${reviewed === 1 ? "word" : "words"} reviewed. Come back tomorrow for the next batch.` : "Shuffle to go again.")));
          setKids(controls, 
            mode === "browse" ? el("button.btn", { onclick: () => { deck.sort(() => Math.random() - 0.5); i = 0; flipped = false; draw(); } }, icon("shuffle", 18), el("span", {}, "Shuffle again")) : null,
            el("button.btn.primary", { onclick: () => done(true) }, "Done"));
          progress.textContent = "";
          return;
        }
        const w = store.get("words", deck[i].id) || deck[i];
        progress.textContent = `${i + 1} of ${deck.length}`;
        cardEl.classList.toggle("flipped", flipped);
        setKids(cardEl, 
          el("div.fc-face.front", {}, el("p.fc-word", {}, w.word), w.phonetic ? el("p.fc-phon", {}, w.phonetic) : null, el("p.muted.small", {}, "Tap or press Space to flip")),
          el("div.fc-face.back", {},
            el("p.fc-word.small", {}, w.word),
            el("p.fc-def", {}, firstDef(w)),
            w.meanings?.[0]?.defs?.[0]?.ex ? el("q.def-ex", {}, w.meanings[0].defs[0].ex) : null,
            w.mnemonic ? el("p.fc-trick", {}, el("strong", {}, "Memory trick: "), w.mnemonic) : null,
            w.source?.context ? el("blockquote.quote.small", {}, w.source.context) : null));
        if (!flipped) {
          setKids(controls, 
            mode === "browse" ? el("button.icon-btn", { "aria-label": "Previous", onclick: () => { if (i > 0) { i--; flipped = false; draw(); } }, disabled: i === 0 }, icon("left")) : null,
            el("button.btn.primary", { onclick: flip }, "Show answer"),
            mode === "browse" ? el("button.icon-btn", { "aria-label": "Next", onclick: () => { i++; flipped = false; draw(); } }, icon("right")) : null);
        } else if (mode === "review") {
          const grade = async (g) => {
            const srs = schedule(w.srs, g);
            await store.patch("words", w.id, { srs, ...(srs.interval >= 21 ? { status: "mastered" } : {}) });
            if (g === 0) deck.push(w);
            reviewed++;
            i++; flipped = false; cue("flip"); draw();
          };
          const label = (g) => { const s = schedule(w.srs, g); return s.interval ? `${s.interval}d` : "10m"; };
          setKids(controls, 
            el("button.btn.grade.again", { onclick: () => grade(0) }, "Again", el("small", {}, label(0))),
            el("button.btn.grade", { onclick: () => grade(1) }, "Hard", el("small", {}, label(1))),
            el("button.btn.grade.good", { onclick: () => grade(2) }, "Good", el("small", {}, label(2))),
            el("button.btn.grade", { onclick: () => grade(3) }, "Easy", el("small", {}, label(3))));
        } else {
          setKids(controls, 
            el("button.btn", { onclick: async () => { await store.patch("words", w.id, { status: "learning" }); i++; flipped = false; draw(); } }, "Still learning"),
            el("button.btn.primary", { onclick: async () => { await store.patch("words", w.id, { status: "mastered" }); cue("done"); i++; flipped = false; draw(); } }, icon("check", 18), el("span", {}, "I know it")));
        }
      };
      const flip = () => { if (i < deck.length) { flipped = !flipped; cue("flip"); draw(); } };
      cardEl.onclick = flip;
      c.closest("dialog").addEventListener("keydown", (e) => {
        if (e.key === " " && e.target === cardEl) return;
        if (e.key === " ") { e.preventDefault(); flip(); }
        if (mode === "review" && flipped && "1234".includes(e.key)) controls.querySelectorAll(".grade")[Number(e.key) - 1]?.click();
        if (mode === "browse" && e.key === "ArrowRight") { i = Math.min(deck.length, i + 1); flipped = false; draw(); }
        if (mode === "browse" && e.key === "ArrowLeft") { i = Math.max(0, i - 1); flipped = false; draw(); }
      });
      draw();
      setTimeout(() => cardEl.focus(), 50);
    },
  }).then(() => render());
}

function exportCsv() {
  const rows = [["word", "phonetic", "status", "part_of_speech", "definition", "my_definition", "memory_trick", "synonyms", "book", "page", "context", "saved_at"]];
  for (const w of store.list("words").sort((a, b) => a.word.localeCompare(b.word))) {
    const m = w.meanings?.[0];
    rows.push([w.word, w.phonetic || "", w.status, m?.pos || "", m?.defs?.[0]?.d || "", w.customDef || "", w.mnemonic || "",
      (m?.synonyms || []).slice(0, 6).join("; "), w.source?.title || "", w.source?.page || "", w.source?.context || "",
      w.createdAt ? new Date(w.createdAt).toISOString().slice(0, 10) : ""]);
  }
  const csv = rows.map((r) => r.map((v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\r\n");
  downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), `luma-words-${new Date().toISOString().slice(0, 10)}.csv`);
  toast(`Exported ${rows.length - 1} words`);
}

export { escapeHtml };
