// Smart character voices. Finds the dialogue in a story and works out who is
// speaking each line — from "said Mary" / "she asked", from who is acting in
// the paragraph, and from the back-and-forth of a conversation — so each
// character can be read in a voice of their own while the narrator keeps theirs.
// Everything runs on the device; nothing is sent anywhere.
import * as voice from "../core/voice.js";

const VERBS = "said|says|asked|asks|replied|replies|answered|answers|whispered|whispers|shouted|shouts|cried|cries|called|calls|added|adds|continued|exclaimed|murmured|muttered|snapped|told|began|insisted|went on|agreed|laughed|sighed|repeated|yelled|screamed|declared|demanded|admitted|explained|offered|suggested|warned|growled|hissed|breathed|protested|retorted|observed|remarked|whimpered|groaned|pleaded|begged|announced|interrupted|mumbled|stammered|ventured|corrected|chuckled|giggled|sobbed|roared|barked|teased|wondered|responded|returned|urged|gasped|spoke|stated|joked|purred|grumbled|cautioned|conceded|confessed|whined|wailed";
const TITLES = "Mr|Mrs|Ms|Miss|Mx|Dr|Sir|Dame|Lady|Lord|Captain|Capt|Professor|Prof|Aunt|Uncle|Father|Mother|Brother|Sister|King|Queen|Prince|Princess|Madame|Madam|Monsieur|Mademoiselle|Señor|Señora|Grandma|Grandpa|Granny|Colonel|General|Sergeant|Inspector|Detective|Officer|Doctor|Nurse|Master|Mistress|Count|Countess|Duke|Duchess|Baron|Baroness|Reverend|Father";
const NAME = `(?:(?:${TITLES})\\.?\\s+)?[A-Z][a-z’'-]+(?:\\s+[A-Z][a-z’'-]+)?`;
const WHO = `(${NAME}|[Hh]e|[Ss]he|I|[Tt]hey|[Tt]he\\s+(?:\\w+\\s+)?\\w+|[Hh]is\\s+\\w+|[Hh]er\\s+\\w+)`;
const AFTER_VERB_WHO = new RegExp(`^[\\s,—–-]*(?:${VERBS})\\s+${WHO}`, "u");
const AFTER_WHO_VERB = new RegExp(`^[\\s,—–-]*${WHO}\\s+(?:\\w+ly\\s+)?(?:${VERBS})\\b`, "u");
const BEFORE_WHO_VERB = new RegExp(`${WHO}\\s+(?:\\w+ly\\s+)?(?:${VERBS})(?:\\s+[\\w’']+){0,4}\\s*[,:—–-]?\\s*$`, "u");
const NOT_NAMES = new Set(("The A An And But Or So Then When While If As At In On Of To For From With Without By After Before Now Yes No Oh Ah Well Still Yet There Here This That These Those It Its It’s It's We You Your They Their Them He She His Her Him I My Me Our Us Not Never Always Perhaps Maybe Why What Where Who Whom How Which Once Just Only Even Every Each All Some Any Nothing Something Everything Someone Everyone Nobody Somebody Good Bad Dear Mister Chapter Part Book One Two Three Four Five Six Seven Eight Nine Ten Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December God Sir Madam Lady Lord Mother Father Mum Mom Dad Okay OK Hello Hi Hey Please Thank Thanks Sorry Look Listen Come Go Stop Wait Let Do Don’t Don't Did Does Is Are Was Were Will Would Could Should Can Can’t Must Might Shall Have Had Has Be Been Being Mr Mrs Ms Miss Dr").split(" "));

const FEMALE_WORDS = /\b(she|her|hers|herself|woman|girl|lady|mother|mum|mom|aunt|sister|daughter|wife|queen|princess|madam|madame|mrs|miss|ms|grandma|granny|grandmother|duchess|countess|baroness|nurse|mistress|niece|bride|widow|witch|actress|waitress|hostess|nun|maid|gal)\b/i;
const MALE_WORDS = /\b(he|him|his|himself|man|boy|gentleman|father|dad|uncle|brother|son|husband|king|prince|sir|mr|monsieur|grandpa|grandfather|duke|count|baron|lord|master|nephew|groom|widower|wizard|actor|waiter|host|monk|butler|lad|fellow|guy)\b/i;
const FEMALE_NAMES = new Set("mary anna anne ann emma elizabeth eliza lizzy beth jane jean joan sarah sara margaret meg maggie alice lucy lucie grace rose rosa clara claire catherine kate katie kathy karen laura lauren julia julie sophie sophia olivia emily amelia charlotte charlie ella eleanor ellie hannah helen helena isabel isabella jenny jennifer jessica linda lisa louise maria marie martha mia molly nancy natalie nina rachel rebecca ruth sally susan susie violet amy anya ada agnes amanda ava bella beatrice betty carol caroline diana dora dorothy edith esther eva eve evelyn fanny flora frances harriet hazel ivy jo josephine judith kitty lily lydia mabel matilda maya miriam nora olive pam penny polly priya ramona rosie stella tess tessa vera wendy zoe marianne elinor catherine hermione ginny luna petunia minerva arya sansa cersei daenerys katniss primrose scarlett melanie aisha fatima leila layla sana anjali deepa meera pooja neha ananya kavya".split(" "));
const MALE_NAMES = new Set("john james jim jimmy william will bill billy henry harry george charles thomas tom tommy edward ed ted robert rob bob richard dick michael mike david dave daniel dan joseph joe peter paul mark matthew luke andrew andy anthony tony arthur albert alfred frank fred frederick jack jacob sam samuel simon stephen steve tim timothy walter oliver max leo alex alexander adam ben benjamin carl chris christopher colin dennis derek eric felix frank gabriel greg hugh ian ivan jake jason jeff jonathan kevin larry leonard louis martin nathan neil nick nicholas patrick philip ralph ray raymond roger ron ronald roy ryan scott sean ted victor vincent wesley holmes watson darcy bingley wickham heathcliff pip ishmael ahab gatsby nick tom huck atticus jem scout frodo sam gandalf aragorn bilbo harry ron draco severus albus hagrid ned jon tyrion jaime arjun rahul rohan amit raj vikram ravi karan ali omar hassan".split(" "));

const OPEN_D = "“", CLOSE_D = "”";

/** Quote spans in a paragraph: [{ start, end }] including the quote marks. */
export function findQuotes(text, carryOpen = false) {
  const spans = [];
  let open = carryOpen ? 0 : -1;
  const hasDouble = /["“”]/.test(text);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (hasDouble) {
      if (c === OPEN_D) { if (open < 0) open = i; }
      else if (c === CLOSE_D) { if (open >= 0) { spans.push({ start: open, end: i + 1 }); open = -1; } }
      else if (c === '"') {
        if (open < 0) open = i;
        else { spans.push({ start: open, end: i + 1 }); open = -1; }
      }
    } else {
      const prev = text[i - 1] || " ", next = text[i + 1] || " ";
      if (c === "‘" && open < 0 && /[\s(—–-]/.test(prev)) open = i;
      else if (c === "’" && open >= 0 && /[.,!?—–…-]/.test(prev) && !/\p{L}/u.test(next)) { spans.push({ start: open, end: i + 1 }); open = -1; }
    }
  }
  const unclosed = open >= 0;
  if (unclosed) spans.push({ start: open, end: text.length, open: true });
  return { spans: spans.filter((s) => /\p{L}/u.test(text.slice(s.start, s.end))), unclosed };
}

const genderOf = (phrase) => {
  const w = phrase.toLowerCase().replace(/[’']s$/, "");
  const first = w.split(/\s+/).find((x) => !new RegExp(`^(${TITLES.toLowerCase()})\\.?$`).test(x)) || w;
  if (FEMALE_WORDS.test(w.split(/\s+/)[0]) || FEMALE_NAMES.has(first)) return "f";
  if (MALE_WORDS.test(w.split(/\s+/)[0]) || MALE_NAMES.has(first)) return "m";
  if (/\b(woman|girl|lady|mother|wife|queen|sister|daughter|aunt)\b/i.test(w)) return "f";
  if (/\b(man|boy|gentleman|father|husband|king|brother|son|uncle)\b/i.test(w)) return "m";
  return "";
};

const keyOf = (name) => name.replace(/^(?:the|his|her)\s+/i, "").replace(/[’']s$/, "").toLowerCase().trim();

/**
 * A reading context that remembers characters across paragraphs.
 * analyze(text, { cont }) → [{ start, end, speaker }] for each quote,
 * where speaker is { id, name, gender } or null (narrator).
 */
export class DialogueContext {
  constructor() {
    this.chars = new Map(); // key → { id, name, gender, seen }
    this.history = []; // recent distinct speakers (ids)
    this.lastF = null;
    this.lastM = null;
    this.carry = null; // { open: bool, speaker } when a paragraph runs on (page break) or speech spans paragraphs
    this.firstPerson = 0;
  }

  #char(name, hint = "") {
    const key = keyOf(name);
    if (!key || key.length < 2) return null;
    let c = this.chars.get(key);
    if (!c) {
      // "Mr Darcy" and "Darcy" are the same person
      const last = key.split(/\s+/).pop();
      for (const [k, v] of this.chars) if (k.split(/\s+/).pop() === last && last.length > 2) { c = v; break; }
    }
    if (!c) {
      c = { id: key, name: name.replace(/^(?:the|his|her)\s+/i, (m) => m.toLowerCase()), gender: genderOf(name) || hint, seen: 0 };
      this.chars.set(key, c);
    }
    if (!c.gender && hint) c.gender = hint;
    c.seen++;
    if (c.gender === "f") this.lastF = c;
    if (c.gender === "m") this.lastM = c;
    return c;
  }

  #resolve(who) {
    if (!who) return undefined;
    const w = who.trim();
    if (w === "I") { this.firstPerson++; return null; } // first-person narrator speaks in the narrator's voice
    if (/^he$/i.test(w)) return this.lastM || this.#char("a man", "m");
    if (/^she$/i.test(w)) return this.lastF || this.#char("a woman", "f");
    if (/^they$/i.test(w)) return undefined;
    if (/^(the|his|her)\s/i.test(w)) {
      if (!/\b\w+$/.test(w) || !/(man|woman|boy|girl|lady|gentleman|stranger|voice|old|young|king|queen|captain|doctor|driver|officer|guard|soldier|child|mother|father|wife|husband|brother|sister|friend|servant|maid|clerk|waiter|priest|nurse|witch|wizard|giant|creature|other|first|second|teacher|boss|chief|landlord|landlady)$/i.test(w)) return undefined;
      return this.#char(w);
    }
    if (NOT_NAMES.has(w.split(/\s+/)[0])) return undefined;
    return this.#char(w);
  }

  /** Learn a character's gender from pronouns that follow their name in narration. */
  #learn(narr) {
    const re = new RegExp(`(${NAME})[^.!?“”"]{0,80}?\\b(he|she|his|her|him)\\b`, "gu");
    for (const m of narr.matchAll(re)) {
      const first = m[1].split(/\s+/)[0];
      if (NOT_NAMES.has(first)) continue;
      const c = this.chars.get(keyOf(m[1]));
      if (c && !c.gender) c.gender = /^(she|her)$/i.test(m[2]) ? "f" : "m";
    }
  }

  /** The character acting in a paragraph's narration, if there's exactly one. */
  #subject(narr) {
    const names = [];
    for (const m of narr.matchAll(new RegExp(NAME, "gu"))) {
      const first = m[0].split(/\s+/)[0];
      if (NOT_NAMES.has(first) || m[0].length < 3) continue;
      const k = keyOf(m[0]);
      if (!names.includes(k)) names.push(k);
    }
    if (names.length === 1) return this.#char(names[0].replace(/\b\w/g, (c) => c.toUpperCase()));
    // a pronoun-led paragraph ("She put the cup down.") → last character of that gender
    const lead = narr.trim().match(/^(He|She)\b/);
    if (lead) return lead[1] === "She" ? this.lastF : this.lastM;
    return undefined;
  }

  #pushHistory(c) {
    if (!c) return;
    if (this.history[this.history.length - 1] !== c.id) this.history.push(c.id);
    if (this.history.length > 6) this.history.shift();
  }

  analyze(text, { cont = false } = {}) {
    const carry = this.carry;
    const carryOpen = cont ? carry?.open : false;
    const { spans, unclosed } = findQuotes(text, carryOpen);
    if (!spans.length) {
      this.#learn(text);
      if (!cont && /\S/.test(text)) this.carry = null;
      return [];
    }
    // narration = text outside quotes
    let narr = "", last = 0;
    for (const s of spans) { narr += text.slice(last, s.start) + " … "; last = s.end; }
    narr += text.slice(last);

    // explicit attributions per quote
    const found = spans.map((s, i) => {
      const after = text.slice(s.end, s.end + 90);
      const before = text.slice(Math.max(i ? spans[i - 1].end : 0, s.start - 90), s.start);
      const m = after.match(AFTER_VERB_WHO) || after.match(AFTER_WHO_VERB) || before.match(BEFORE_WHO_VERB);
      return m ? this.#resolve(m[1]) : undefined;
    });
    this.#learn(narr);
    let para = found.find((x) => x !== undefined);
    if (para === undefined && cont && carry) para = carry.speaker;
    if (para === undefined && carry?.open && /^\s*[“"‘]/.test(text)) para = carry.speaker; // speech running over paragraphs
    if (para === undefined) para = this.#subject(narr);
    if (para === undefined && this.history.length >= 2) {
      // back-and-forth: the one who spoke before the last speaker
      const id = this.history[this.history.length - 2];
      para = [...this.chars.values()].find((c) => c.id === id);
    }
    const out = spans.map((s, i) => {
      const who = found[i] !== undefined ? found[i] : para;
      return { start: s.start, end: s.end, speaker: who || null };
    });
    for (const o of out) this.#pushHistory(o.speaker);
    this.carry = { open: unclosed, speaker: para };
    return out;
  }
}

// ───────── casting voices ─────────
const POOLS = {
  f: ["af_bella", "bf_emma", "af_nicole", "af_heart"],
  m: ["am_michael", "bm_george", "am_fenrir", "bm_fable"],
};
const SYS_F = /samantha|victoria|karen|moira|tessa|fiona|serena|zira|aria|jenny|libby|sonia|natasha|clara|emma|ava|allison|susan|hazel|heera|neerja|female|veena|kate|catherine|joanna|salli|kimberly|ivy|amy|olivia|michelle|ana|elsa|ellie|maisie|nicky|zoe|siri.*female/i;
const SYS_M = /daniel|alex\b|tom\b|oliver|arthur|guy|ryan|thomas|mark|david|george|rishi|prabhat|male|christopher|eric|brian|andrew|roger|steffan|aaron|fred|gordon|lee|rocko|evan|nathan|matthew|joey|justin|ravi|william/i;

const castKey = (docId) => `luma.cast.${docId}`;

export class Cast {
  constructor(docId) {
    this.docId = docId;
    try { this.map = JSON.parse(localStorage.getItem(castKey(docId)) || "{}"); } catch { this.map = {}; }
  }

  save() { try { localStorage.setItem(castKey(this.docId), JSON.stringify(this.map)); } catch {} }

  /** Voice for a speaker: { engine, id, pitch, rate } — null speaker = narrator. */
  voiceFor(speaker, natural) {
    if (!speaker) return null;
    const g = speaker.gender || (hash(speaker.id) % 2 ? "f" : "m");
    if (natural) {
      const narrator = voice.prefs.natural;
      const slot = this.map[speaker.id]?.n;
      if (slot) return { engine: "natural", id: slot };
      const used = Object.values(this.map).map((v) => v.n).filter(Boolean);
      const pool = POOLS[g].filter((v) => v !== narrator);
      const pick = pool.find((v) => !used.includes(v)) || pool[hash(speaker.id) % pool.length];
      this.map[speaker.id] = { ...this.map[speaker.id], n: pick, g };
      this.save();
      return { engine: "natural", id: pick };
    }
    // device voices: a different voice of the right gender if the device has one, else a pitch change
    const list = voice.systemVoices();
    const narrator = voice.currentSystemVoice();
    const sameLang = list.filter((v) => v.id !== narrator?.id && v.score > -50);
    const want = sameLang.filter((v) => (g === "f" ? SYS_F : SYS_M).test(v.name) && !(g === "f" ? SYS_M : SYS_F).test(v.name));
    const pitchBase = g === "f" ? 1.18 : 0.82;
    const pitch = pitchBase + ((hash(speaker.id) % 5) - 2) * 0.04;
    if (want.length) {
      const v = want[hash(speaker.id) % want.length];
      return { engine: "system", id: v.id, pitch: 1 + ((hash(speaker.id) % 3) - 1) * 0.05 };
    }
    return { engine: "system", id: narrator?.id, pitch };
  }

  /** Speakers this book has cast so far (for the cast list). */
  entries() { return Object.entries(this.map); }

  reset() { this.map = {}; this.save(); }
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

/** Split a sentence [start, end) of a block into narration and speech parts. */
export function splitParts(text, start, end, quotes) {
  const parts = [];
  let at = start;
  for (const q of quotes) {
    if (q.end <= at || q.start >= end) continue;
    const a = Math.max(q.start, at), b = Math.min(q.end, end);
    if (a > at) parts.push({ start: at, end: a, speaker: null });
    parts.push({ start: a, end: b, speaker: q.speaker });
    at = b;
  }
  if (at < end) parts.push({ start: at, end, speaker: null });
  // fold bits with no words ("," / " — ") into the part before so the voice doesn't hiccup
  const out = [];
  for (const p of parts) {
    const t = text.slice(p.start, p.end);
    const prev = out[out.length - 1];
    if (!/[\p{L}\p{N}]/u.test(t)) { if (prev) prev.end = p.end; else out.push(p); continue; }
    if (prev && !/[\p{L}\p{N}]/u.test(text.slice(prev.start, prev.end))) { p.start = prev.start; out.pop(); }
    if (prev && prev.speaker === p.speaker && out.includes(prev)) { prev.end = p.end; continue; }
    out.push(p);
  }
  return out;
}
