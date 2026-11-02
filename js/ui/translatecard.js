// "Translate": a passage (or one word) from English into your language, or from
// it into English — with the original beside it, a voice for each language, your
// own corrections, and the dictionary's meanings for a single foreign word.
import { el, setKids } from "../core/util.js";
import { tappable } from "./wordstory.js";
import { icon } from "./icons.js";
import { toast } from "./overlay.js";
import { speakOnce } from "../core/voice.js";
import { translate, directionFor, deviceStatus, deviceTranslator, nativeName, langName, saveCorrection, foreignWord, QuotaError } from "../data/translate.js";

const ENGINE = {
  device: "Translated on this device",
  online: "Translated online (free daily allowance)",
  memory: "From your translations",
  you: "Your correction",
  same: "",
};

/**
 * The body of the Translate card. `onWord(word)` looks a word up; `alive()` is
 * false once the card has moved on. The element gets .result() → { text, from, to } once done.
 */
export function translateBody(text, { onWord, alive = () => true, compact = true } = {}) {
  const src = String(text || "").replace(/[ \t]+/g, " ").trim();
  const { from, to } = directionFor(src);
  const root = el("div.tr");
  let result = null;
  root.result = () => result;
  const single = !/\s/.test(src) && src.length < 40;

  const pairPill = el("p.tr-pair", {}, el("span", {}, nativeName(from)), el("span.tr-arrow", { "aria-hidden": "true" }, "→"), el("span", {}, nativeName(to)));
  const srcBox = el("blockquote.tr-src" + (src.length > 280 && compact ? ".long" : ""), { lang: from }, src);
  const outBox = el("div.tr-out", { lang: to, "aria-live": "polite" }, el("div.rs-skel", {}, el("span"), el("span.short")));
  const note = el("p.tr-note");
  const dl = el("div.tr-dl");
  const actions = el("div.row.wrap.tr-actions");
  const dict = el("div");
  root.append(pairPill, srcBox, outBox, note, dl, actions, dict);

  const show = (r) => {
    result = r;
    setKids(outBox, el("p.tr-text", {}, r.to === "en" && onWord ? tappable(r.text, onWord) : r.text)); // English: tap a word for its meaning
    note.textContent = ENGINE[r.engine] || "";
    setKids(actions,
      el("button.btn.sm.ghost", { type: "button", title: `Hear it in ${langName(r.to)}`, onclick: () => speakOnce(r.text, { lang: r.to }) }, icon("speak", 15), langName(r.to)),
      el("button.btn.sm.ghost", { type: "button", title: `Hear the original in ${langName(r.from)}`, onclick: () => speakOnce(src, { lang: r.from }) }, icon("speak", 15), langName(r.from)),
      el("button.btn.sm.ghost", { type: "button", onclick: async () => { await navigator.clipboard?.writeText(r.text).catch(() => {}); toast("Copied"); } }, icon("copy", 15), "Copy"),
      el("button.btn.sm.ghost", { type: "button", title: "Correct this translation — Luma will use your version from now on", onclick: () => edit(r) }, icon("edit", 15), "Correct"));
  };
  const edit = (r) => {
    const ta = el("textarea.input", { rows: Math.min(8, Math.max(2, Math.ceil(r.text.length / 50))), lang: r.to }, r.text);
    setKids(outBox, el("form.tr-edit", {
      onsubmit: async (e) => {
        e.preventDefault();
        const v = ta.value.trim();
        if (!v) return;
        await saveCorrection(src, r.from, r.to, v);
        show({ ...r, text: v, engine: "you" });
        toast("Saved — your version will be used from now on");
      },
    }, ta, el("div.row", {}, el("button.btn.sm.primary", { type: "submit" }, "Save my version"), el("button.btn.sm.ghost", { type: "button", onclick: () => show(r) }, "Cancel"))));
    ta.focus();
  };
  const fail = (e) => {
    const msg = e instanceof QuotaError ? e.message
      : !navigator.onLine ? "You're offline. On a computer with Chrome or Edge, Luma translates on the device — no connection needed once the language is downloaded."
      : "The translation didn't come through. Try again in a moment.";
    setKids(outBox, el("p.muted.small", {}, msg));
  };
  const run = (opts = {}) => translate(src, { from, to, ...opts }).then((r) => { if (alive()) show(r); }).catch((e) => { if (alive()) fail(e); });

  // the built-in translator needs its language downloaded once (only straight after a tap)
  deviceStatus(from, to).then((st) => {
    if (!alive()) return;
    if (st === "downloadable" || st === "downloading") {
      const bar = el("span.ocr-bar-fill");
      const btn = el("button.btn.sm", {
        type: "button",
        onclick: () => {
          btn.disabled = true;
          setKids(dl, el("p.small", {}, `Downloading ${langName(from === "en" ? to : from)} for this device…`), el("div.ocr-bar", {}, bar));
          deviceTranslator(from, to, { onProgress: (x) => { bar.style.width = Math.round(x * 100) + "%"; } })
            .then(() => { if (!alive()) return; setKids(dl); run({ allowOnline: false }); })
            .catch(() => { if (alive()) setKids(dl, el("p.muted.small", {}, "The download didn't finish. You can try again later.")); });
        },
      }, icon("download", 15), `Translate on this device (one-time download)`);
      setKids(dl, el("p.small.muted", {}, "For private, offline translation:"), btn);
    }
    run();
  });

  // one word in another language: what the dictionary says it means
  if (single && from !== "en") {
    foreignWord(src, from).then((entry) => {
      if (!alive() || !entry) return;
      dict.replaceWith(el("div.ws-block.tr-dict", {},
        el("p.ws-label", {}, `${langName(from)} → English dictionary`),
        entry.meanings.slice(0, 3).map((m) => el("p.tr-dict-line", {}, m.pos ? el("em", {}, m.pos + " — ") : null, m.defs.join("; "))),
        el("a.small", { href: entry.url, target: "_blank", rel: "noopener" }, "More on Wiktionary")));
    }).catch(() => {});
  }
  return root;
}
