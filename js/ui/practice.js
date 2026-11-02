// Practice: more ways to really learn your words than flipping cards —
// a meaning quiz, spelling from sound, saying the word aloud, and using it in a
// sentence of your own. Every answer feeds the same spaced-repetition schedule.
import { el, setKids, bus } from "../core/util.js";
import { store } from "../data/store.js";
import { schedule, isDue } from "../data/dictionary.js";
import { baseForms } from "../data/common-words.js";
import { dialog, toast } from "./overlay.js";
import { icon } from "./icons.js";
import { playWord } from "./definition.js";
import { cue } from "../core/feel.js";

export const firstDef = (w) => w.customDef || w.meanings?.[0]?.defs?.[0]?.d || "";
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const MODES = {
  quiz: { label: "Meaning quiz", icon: "quiz", note: "Pick the right meaning" },
  spell: { label: "Spell it", icon: "pencil", note: "Hear it, then type it" },
  say: { label: "Say it", icon: "mic", note: "Practise saying it aloud", available: () => Boolean(Recognition) },
  use: { label: "Use it", icon: "note", note: "Write your own sentence" },
};

const todayKey = () => new Date().toISOString().slice(0, 10);
export function practiceLog() {
  let log;
  try { log = JSON.parse(localStorage.getItem("luma.practice") || "{}"); } catch { log = {}; }
  if (log.day !== todayKey()) {
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    log = { day: todayKey(), count: 0, streak: log.day === yesterday && log.count > 0 ? log.streak || 0 : log.day === todayKey() ? log.streak : 0, prevDay: log.day };
  }
  return log;
}
export function bump() {
  const log = practiceLog();
  if (!log.count) log.streak = (log.streak || 0) + 1;
  log.count++;
  localStorage.setItem("luma.practice", JSON.stringify(log));
}

/** Choose words for a session: due first, then the ones you've reviewed least. */
export function pickWords(n = store.settings().dailyGoal || 10, need = () => true) {
  const learning = store.list("words").filter((w) => w.status !== "mastered" && need(w));
  const due = learning.filter(isDue).sort(() => Math.random() - 0.5);
  const rest = learning.filter((w) => !isDue(w)).sort((a, b) => (a.srs?.reps || 0) - (b.srs?.reps || 0));
  return [...due, ...rest].slice(0, n);
}

async function grade(w, g) {
  const srs = schedule(w.srs, g);
  await store.patch("words", w.id, { srs, ...(srs.interval >= 21 ? { status: "mastered" } : {}) });
  bump();
  bus.emit("word-review", { id: w.id, correct: g > 0 });
}

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z' -]/g, "").trim();

export function practice(mode, words = null) {
  const need = mode === "quiz" || mode === "use" ? (w) => Boolean(firstDef(w)) : () => true;
  let deck = (words || pickWords(undefined, need)).filter(need);
  if (!deck.length) { toast(mode === "quiz" ? "Save a few words with definitions first." : "No words to practise yet."); return; }
  if (mode === "quiz" && store.list("words").filter((w) => firstDef(w)).length < 4) { toast("The quiz needs at least four saved words with meanings."); return; }
  let i = 0, right = 0, tries = 0;
  const missed = new Set();
  return dialog({
    title: MODES[mode].label,
    className: "practice-dialog",
    body: (c, done) => {
      const progress = el("div.pr-progress");
      const stage = el("div.pr-stage");
      c.append(progress, stage);
      const next = () => { i++; tries = 0; draw(); };
      const draw = () => {
        progress.style.setProperty("--p", deck.length ? i / deck.length : 1);
        if (i >= deck.length) {
          cue("done");
          const log = practiceLog();
          setKids(stage, el("div.pr-done", {},
            el("p.pr-big", {}, `${right} of ${deck.length}`),
            el("p.muted", {}, right === deck.length ? "Perfect round." : "Words you missed will come back sooner."),
            el("p.small.muted", {}, `${log.count} practised today${log.streak > 1 ? ` · ${log.streak}-day streak` : ""}`),
            el("div.row.center", {},
              missed.size ? el("button.btn", { onclick: () => { deck = deck.filter((w) => missed.has(w.id)); missed.clear(); i = 0; right = 0; draw(); } }, "Practise the missed ones") : null,
              el("button.btn.primary", { onclick: () => done(true) }, "Done"))));
          return;
        }
        const w = store.get("words", deck[i].id) || deck[i];
        ({ quiz, spell, say, use })[mode](stage, w, { next, ok: async (g = 2) => { if (!tries) right++; await grade(w, tries ? Math.min(g, 1) : g); }, miss: () => { tries++; missed.add(w.id); } });
      };
      draw();
    },
  });
}

// ───────── modes ─────────
function quiz(stage, w, { next, ok, miss }) {
  const reverse = Math.random() < 0.35;
  const pool = store.list("words").filter((x) => x.id !== w.id && firstDef(x) && firstDef(x) !== firstDef(w)).sort(() => Math.random() - 0.5).slice(0, 3);
  const options = [w, ...pool].sort(() => Math.random() - 0.5);
  const feedback = el("p.pr-feedback", { "aria-live": "polite" });
  let answered = false;
  const choose = async (opt, btn) => {
    if (answered) return;
    if (opt.id === w.id) {
      answered = true;
      btn.classList.add("right");
      cue("save");
      await ok();
      feedback.textContent = "Right!";
      setTimeout(next, 750);
    } else {
      btn.classList.add("wrong");
      btn.disabled = true;
      miss();
      feedback.textContent = reverse ? `That's “${opt.word}”.` : `That's the meaning of “${opt.word}”.`;
    }
  };
  setKids(stage,
    el("p.pr-prompt.muted.small", {}, reverse ? "Which word means…" : "What does this word mean?"),
    reverse ? el("p.pr-def", {}, firstDef(w)) : el("p.pr-word", {}, w.word, el("button.icon-btn", { "aria-label": "Hear it", onclick: () => playWord(w.word, w.audio) }, icon("speak", 18))),
    el("div.pr-options", {}, options.map((o) => {
      const b = el("button.pr-opt", { onclick: () => choose(o, b) }, reverse ? o.word : firstDef(o).slice(0, 160));
      return b;
    })),
    feedback);
}

function spell(stage, w, { next, ok, miss }) {
  const input = el("input.input.pr-input", { autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Type the word" });
  const feedback = el("p.pr-feedback", { "aria-live": "polite" });
  const hear = () => playWord(w.word, w.audio);
  const check = async (e) => {
    e?.preventDefault();
    const v = norm(input.value);
    if (!v) return;
    if (v === norm(w.word)) {
      cue("save");
      input.classList.add("right");
      feedback.textContent = "Spot on.";
      await ok();
      setTimeout(next, 700);
    } else {
      miss();
      input.classList.add("wrong");
      feedback.replaceChildren("Not quite — it's ", el("strong", {}, w.word), ". Type it once more.");
      input.value = "";
      setTimeout(() => input.classList.remove("wrong"), 600);
    }
  };
  setKids(stage,
    el("p.pr-prompt.muted.small", {}, "Listen, then type the word"),
    el("button.btn.lg.pr-hear", { onclick: hear }, icon("speak", 20), "Hear it"),
    firstDef(w) ? el("p.pr-def.small", {}, firstDef(w)) : null,
    el("form.pr-form", { onsubmit: check }, input, el("button.btn.primary", { type: "submit" }, "Check")),
    feedback,
    el("button.link.small", { onclick: () => { miss(); feedback.replaceChildren("The word is ", el("strong", {}, w.word)); } }, "Show me"));
  setTimeout(() => { hear(); input.focus(); }, 250);
}

function say(stage, w, { next, ok, miss }) {
  const feedback = el("p.pr-feedback", { "aria-live": "polite" });
  const mic = el("button.pr-mic", { "aria-label": "Say the word" }, icon("mic", 30));
  let rec = null;
  const listen = () => {
    if (rec) { rec.stop(); return; }
    rec = new Recognition();
    rec.lang = navigator.language?.startsWith("en") ? navigator.language : "en-US";
    rec.maxAlternatives = 5;
    rec.interimResults = false;
    mic.classList.add("on");
    feedback.textContent = "Listening…";
    rec.onresult = async (e) => {
      const heard = [...e.results[0]].map((a) => norm(a.transcript));
      const target = norm(w.word);
      const hit = heard.some((h) => h === target || h.split(" ").includes(target) || baseForms(h).includes(target));
      if (hit) {
        cue("save");
        feedback.textContent = "Clear as a bell.";
        await ok();
        setTimeout(next, 800);
      } else {
        miss();
        feedback.replaceChildren(`Heard “${heard[0] || "…"}”. `, el("button.link", { onclick: () => playWord(w.word, w.audio) }, "Hear it"), " and try again.");
      }
    };
    rec.onerror = (e) => { feedback.textContent = e.error === "not-allowed" ? "Microphone access is blocked for this site." : "Didn't catch that — try again."; };
    rec.onend = () => { mic.classList.remove("on"); rec = null; };
    try { rec.start(); } catch { feedback.textContent = "The microphone isn't available."; }
  };
  mic.onclick = listen;
  setKids(stage,
    el("p.pr-prompt.muted.small", {}, "Say this word out loud"),
    el("p.pr-word", {}, w.word),
    w.phonetic ? el("p.pr-phon", {}, w.phonetic) : null,
    el("div.row.center", {}, el("button.btn", { onclick: () => playWord(w.word, w.audio) }, icon("speak", 18), "Hear it first"), mic),
    feedback,
    el("button.link.small", { onclick: async () => { await ok(1); next(); } }, "Skip"));
}

function use(stage, w, { next, ok, miss }) {
  const ta = el("textarea.input.pr-sentence", { rows: 3, placeholder: `A sentence of your own with “${w.word}”` });
  const feedback = el("p.pr-feedback", { "aria-live": "polite" });
  const ex = w.meanings?.flatMap((m) => m.defs || []).find((d) => d.ex)?.ex || w.source?.context;
  const check = async () => {
    const text = ta.value.trim();
    const words = norm(text).split(/\s+/);
    const forms = new Set([norm(w.word)]);
    const used = words.some((x) => forms.has(x) || baseForms(x).some((b) => b === norm(w.word)));
    if (text.split(/\s+/).length < 4) { feedback.textContent = "Make it a full sentence."; return; }
    if (!used) { miss(); feedback.textContent = `Use “${w.word}” (or a form of it) in the sentence.`; return; }
    const cur = store.get("words", w.id);
    await store.patch("words", w.id, { sentences: [{ text, at: Date.now() }, ...(cur?.sentences || [])].slice(0, 10) });
    cue("save");
    await ok(3);
    feedback.textContent = "Saved to the word — writing it is the best way to keep it.";
    setTimeout(next, 900);
  };
  setKids(stage,
    el("p.pr-prompt.muted.small", {}, "Use it in a sentence"),
    el("p.pr-word", {}, w.word),
    el("p.pr-def.small", {}, firstDef(w)),
    ta,
    el("div.row", {},
      ex ? el("button.link.small", { onclick: (e) => e.currentTarget.replaceWith(el("q.def-ex", {}, ex)) }, "See an example") : null,
      el("span.spacer"),
      el("button.btn.primary", { onclick: check }, "Save sentence")),
    feedback);
  setTimeout(() => ta.focus(), 120);
}
