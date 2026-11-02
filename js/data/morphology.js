// How a word is made: its base word, prefixes, suffixes and endings — or the
// Latin and Greek parts it was built from — each with what it means. Works on
// the device; the dictionary and Wiktionary fill in the rest when online.

// ───────── endings that only change the form (inflections) ─────────
export const ENDINGS = {
  est: { show: "-est", meaning: "the most", note: "superlative", example: "fast → fastest" },
  er: { show: "-er", meaning: "more (with describing words) — or a person or thing that does it (with action words)", note: "comparative or doer", example: "fast → faster, teach → teacher" },
  ally: { show: "-ally", meaning: "in a … way", note: "turns a describing word into how something is done" },
  s: { show: "-s", meaning: "more than one, or he/she/it does it", note: "plural or present" },
  es: { show: "-es", meaning: "more than one, or he/she/it does it", note: "plural or present" },
  ed: { show: "-ed", meaning: "did it in the past, or had it done to it", note: "past" },
  ing: { show: "-ing", meaning: "doing it, or the act of doing it", note: "-ing form" },
  ly: { show: "-ly", meaning: "in a … way", note: "turns a describing word into how something is done" },
};

// ───────── irregular forms ─────────
const IRREG = {};
const irr = (base, note, ...forms) => { for (const f of forms) IRREG[f] = { base, note }; };
irr("be", "a form of", "am", "is", "are", "was", "were", "been", "being");
irr("have", "a form of", "has", "had", "having");
irr("do", "a form of", "does", "did", "done");
irr("go", "past of", "went"); irr("go", "past participle of", "gone");
irr("good", "comparative of", "better"); irr("good", "superlative of", "best");
irr("bad", "comparative of", "worse"); irr("bad", "superlative of", "worst");
irr("much", "comparative of", "more"); irr("much", "superlative of", "most");
irr("little", "comparative of", "less", "lesser"); irr("little", "superlative of", "least");
irr("far", "comparative of", "farther", "further"); irr("far", "superlative of", "farthest", "furthest");
irr("old", "comparative of", "elder"); irr("old", "superlative of", "eldest");
const PAST = `say said said|make made made|take took taken|come came come|see saw seen|know knew known|get got gotten|give gave given|find found found|think thought thought|tell told told|become became become|leave left left|feel felt felt|bring brought brought|begin began begun|keep kept kept|hold held held|write wrote written|stand stood stood|hear heard heard|mean meant meant|meet met met|run ran run|pay paid paid|sit sat sat|speak spoke spoken|lie lay lain|lead led led|grow grew grown|lose lost lost|fall fell fallen|send sent sent|build built built|understand understood understood|draw drew drawn|break broke broken|spend spent spent|rise rose risen|drive drove driven|buy bought bought|wear wore worn|choose chose chosen|seek sought sought|throw threw thrown|catch caught caught|deal dealt dealt|win won won|forget forgot forgotten|sell sold sold|fight fought fought|teach taught taught|eat ate eaten|sing sang sung|sleep slept slept|fly flew flown|hide hid hidden|swim swam swum|strike struck struck|hang hung hung|shake shook shaken|ride rode ridden|bite bit bitten|feed fed fed|flee fled fled|freeze froze frozen|steal stole stolen|weep wept wept|swear swore sworn|tear tore torn|bear bore borne|wake woke woken|lay laid laid|sink sank sunk|spring sprang sprung|stick stuck stuck|sting stung stung|strive strove striven|dig dug dug|shine shone shone|shoot shot shot|slide slid slid|spin spun spun|bend bent bent|lend lent lent|creep crept crept|kneel knelt knelt|leap leapt leapt|ring rang rung|drink drank drunk|behold beheld beheld|forbid forbade forbidden|forgive forgave forgiven|overcome overcame overcome|undertake undertook undertaken|withdraw withdrew withdrawn|arise arose arisen|awake awoke awoken|bleed bled bled|blow blew blown|breed bred bred|cling clung clung|dive dove dived|dream dreamt dreamt|dwell dwelt dwelt|fling flung flung|forsake forsook forsaken|grind ground ground|light lit lit|mistake mistook mistaken|seek sought sought|shrink shrank shrunk|slay slew slain|sling slung slung|slink slunk slunk|smite smote smitten|sow sowed sown|stink stank stunk|stride strode stridden|string strung strung|swell swelled swollen|swing swung swung|tread trod trodden|weave wove woven|wring wrung wrung|bind bound bound|feed fed fed|hit hit hit|quit quit quit|read read read`;
for (const row of PAST.split("|")) {
  const [b, p, pp] = row.split(" ");
  if (p !== b) irr(b, "past of", p);
  if (pp !== b && pp !== p) irr(b, "past participle of", pp);
}
const PLURALS = `child children|man men|woman women|mouse mice|goose geese|foot feet|tooth teeth|person people|ox oxen|louse lice|criterion criteria|phenomenon phenomena|datum data|analysis analyses|crisis crises|thesis theses|hypothesis hypotheses|cactus cacti|fungus fungi|nucleus nuclei|radius radii|stimulus stimuli|alumnus alumni|index indices|matrix matrices|appendix appendices|wife wives|knife knives|life lives|leaf leaves|half halves|wolf wolves|self selves|shelf shelves|thief thieves|loaf loaves|calf calves|medium media|bacterium bacteria|curriculum curricula|axis axes|basis bases|diagnosis diagnoses|ellipsis ellipses|oasis oases|parenthesis parentheses|synopsis synopses|die dice|penny pence`;
for (const row of PLURALS.split("|")) { const [b, p] = row.split(" "); irr(b, "plural of", p); }

// ───────── prefixes and suffixes that make new words ─────────
const P = (forms, meaning, from) => forms.split(" ").map((f) => ({ form: f, meaning, from }));
export const PREFIXES = [
  ...P("anti", "against", "Greek"), ...P("auto", "self", "Greek"), ...P("bene", "well, good", "Latin"), ...P("circum", "around", "Latin"),
  ...P("contra counter", "against", "Latin"), ...P("extra", "beyond, outside", "Latin"), ...P("hyper", "over, too much", "Greek"), ...P("hypo", "under", "Greek"),
  ...P("inter", "between", "Latin"), ...P("intra", "within", "Latin"), ...P("intro", "inward", "Latin"), ...P("micro", "small", "Greek"), ...P("macro", "large", "Greek"),
  ...P("mono", "one, single", "Greek"), ...P("multi", "many", "Latin"), ...P("over", "too much, above", "English"), ...P("under", "below, too little", "English"),
  ...P("post", "after", "Latin"), ...P("pre", "before", "Latin"), ...P("pro", "forward, for", "Latin"), ...P("proto", "first", "Greek"), ...P("pseudo", "false", "Greek"),
  ...P("retro", "backward", "Latin"), ...P("semi", "half", "Latin"), ...P("hemi", "half", "Greek"), ...P("super", "above, beyond", "Latin"), ...P("sur", "over, above", "French"),
  ...P("tele", "far", "Greek"), ...P("trans", "across", "Latin"), ...P("ultra", "beyond", "Latin"), ...P("uni", "one", "Latin"), ...P("tri", "three", "Latin/Greek"),
  ...P("bi", "two", "Latin"), ...P("poly", "many", "Greek"), ...P("pan", "all", "Greek"), ...P("omni", "all", "Latin"), ...P("neo", "new", "Greek"),
  ...P("mis", "wrongly, badly", "English"), ...P("mal", "badly", "French"), ...P("dis", "not, apart, the opposite of", "Latin"), ...P("non", "not", "Latin"),
  ...P("un", "not, or the reverse of", "English"), ...P("in im il ir", "not (or: in, into)", "Latin"), ...P("re", "again, back", "Latin"), ...P("de", "down, away, the reverse of", "Latin"),
  ...P("ex e", "out of, former", "Latin"), ...P("en em", "put into, make", "French"), ...P("fore", "before, in front", "English"), ...P("out", "beyond, more than", "English"),
  ...P("sub sup sus suc", "under", "Latin"), ...P("com con col cor co", "together, with", "Latin"), ...P("ad ac af ag al ap ar as at", "to, toward", "Latin"),
  ...P("ab abs", "away from", "Latin"), ...P("ob op", "against, toward", "Latin"), ...P("per", "through, thoroughly", "Latin"), ...P("peri", "around", "Greek"),
  ...P("para", "beside", "Greek"), ...P("syn sym", "together", "Greek"), ...P("dia", "through, across", "Greek"), ...P("epi", "upon", "Greek"), ...P("eu", "good, well", "Greek"),
  ...P("dys", "bad, difficult", "Greek"), ...P("a an", "not, without", "Greek"), ...P("be", "make, thoroughly", "English"), ...P("se", "apart", "Latin"), ...P("ante", "before", "Latin"),
  ...P("equi", "equal", "Latin"), ...P("mid", "middle", "English"), ...P("up", "up", "English"), ...P("with", "back, against", "English"),
].sort((a, b) => b.form.length - a.form.length);

export const SUFFIXES = [
  ...P("ability ibility", "being able to be", "Latin"), ...P("ation ition", "the act or result of", "Latin"), ...P("tion sion ion", "the act or result of", "Latin"),
  ...P("ness", "the state of being", "English"), ...P("ment", "the act or result of", "Latin"), ...P("able ible", "can be done; worth", "Latin"),
  ...P("ful", "full of", "English"), ...P("less", "without", "English"), ...P("ship", "the state, rank or skill of", "English"), ...P("hood", "the state or time of", "English"),
  ...P("dom", "the state or realm of", "English"), ...P("ism", "a belief, practice or condition", "Greek"), ...P("ist", "a person who does or believes", "Greek"),
  ...P("ity ty", "the quality of", "Latin"), ...P("ize ise", "make, become", "Greek"), ...P("ify fy", "make", "Latin"), ...P("ous ious eous", "full of, having", "Latin"),
  ...P("ive ative", "tending to, doing", "Latin"), ...P("ical ic", "relating to", "Greek"), ...P("al ial", "relating to", "Latin"), ...P("ance ence ancy ency", "the state or act of", "Latin"),
  ...P("ant ent", "doing; a person or thing that does", "Latin"), ...P("ary ory", "relating to; a place for", "Latin"), ...P("ate", "make; having", "Latin"),
  ...P("ator", "a person or thing that does", "Latin"), ...P("er or", "a person or thing that does", "English/Latin"), ...P("ee", "a person to whom it's done", "French"), ...P("ess", "a female", "French"),
  ...P("ish", "somewhat; like", "English"), ...P("like", "like", "English"), ...P("ly", "in a … way; like", "English"), ...P("ward wards", "in the direction of", "English"),
  ...P("wise", "in the way of", "English"), ...P("some", "tending to", "English"), ...P("let ette", "small", "French"), ...P("ling", "small or young", "English"),
  ...P("logy ology", "the study of", "Greek"), ...P("cracy", "rule by", "Greek"), ...P("graphy", "writing about, drawing", "Greek"), ...P("phobia", "fear of", "Greek"),
  ...P("ure", "the act or result of", "Latin"), ...P("age", "the act, result or collection of", "French"), ...P("al", "the act of", "Latin"), ...P("en", "made of; make", "English"),
  ...P("th", "the state of", "English"), ...P("y", "full of, having", "English"), ...P("ery", "a place for; the practice of", "French"), ...P("esque", "in the style of", "French"),
  ...P("ian an", "of, belonging to; a person who", "Latin"), ...P("ile", "able to, relating to", "Latin"), ...P("ine", "like, relating to", "Latin"),
].sort((a, b) => b.form.length - a.form.length);

// ───────── Latin and Greek building blocks ─────────
const R = {};
const root = (forms, meaning, from) => { for (const f of forms.split(" ")) R[f] = { form: f, meaning, from }; };
root("aqu aqua", "water", "Latin"); root("aud audi audit", "hear", "Latin"); root("bio", "life", "Greek"); root("cap capt cept ceive cip", "take, seize", "Latin");
root("ced cede ceed cess", "go, yield", "Latin"); root("chron chrono", "time", "Greek"); root("cid cis", "cut, kill", "Latin"); root("clam claim", "shout", "Latin");
root("cred", "believe", "Latin"); root("cur curr curs", "run", "Latin"); root("dic dict", "say", "Latin"); root("duc duct", "lead", "Latin");
root("fac fact fect fic", "make, do", "Latin"); root("fer", "carry", "Latin"); root("flect flex", "bend", "Latin"); root("form", "shape", "Latin");
root("fract frag", "break", "Latin"); root("gen", "birth, kind", "Latin/Greek"); root("geo", "earth", "Greek"); root("grad gress", "step, go", "Latin");
root("graph gram", "write, draw", "Greek"); root("ject", "throw", "Latin"); root("jud judic", "judge", "Latin"); root("junct", "join", "Latin");
root("lect leg lig", "choose, read", "Latin"); root("log", "word, reason, study", "Greek"); root("loc", "place", "Latin"); root("loqu locut", "speak", "Latin");
root("luc lum", "light", "Latin"); root("man manu", "hand", "Latin"); root("mit miss", "send", "Latin"); root("mob mot mov", "move", "Latin");
root("mort", "death", "Latin"); root("nat", "born", "Latin"); root("nov", "new", "Latin"); root("ped pod", "foot", "Latin/Greek");
root("pel puls", "drive, push", "Latin"); root("pend pens", "hang, weigh", "Latin"); root("phil", "love", "Greek"); root("phon", "sound", "Greek");
root("photo phot", "light", "Greek"); root("plic plex", "fold", "Latin"); root("port", "carry", "Latin"); root("pos pon", "put, place", "Latin");
root("psych", "mind", "Greek"); root("rupt", "break", "Latin"); root("scrib script", "write", "Latin"); root("sect", "cut", "Latin");
root("sens sent", "feel", "Latin"); root("sequ secu", "follow", "Latin"); root("spec spect spic", "look", "Latin"); root("spir", "breathe", "Latin");
root("sta stat sist", "stand", "Latin"); root("struct stru", "build", "Latin"); root("tact tang", "touch", "Latin"); root("ten tain tin", "hold", "Latin");
root("tend tens tent", "stretch", "Latin"); root("terr", "earth, land", "Latin"); root("therm", "heat", "Greek"); root("tract", "pull, drag", "Latin");
root("vac", "empty", "Latin"); root("ven vent", "come", "Latin"); root("ver", "true", "Latin"); root("vers vert", "turn", "Latin");
root("vid vis", "see", "Latin"); root("viv vit", "live", "Latin"); root("voc vok", "call, voice", "Latin"); root("vol", "wish, will", "Latin");
root("anthrop", "human", "Greek"); root("astr aster", "star", "Greek"); root("biblio", "book", "Greek"); root("cardi", "heart", "Greek");
root("cosm", "world, order", "Greek"); root("crat cracy", "rule", "Greek"); root("cycl", "circle, wheel", "Greek"); root("dem", "people", "Greek");
root("derm", "skin", "Greek"); root("dyn dynam", "power", "Greek"); root("gam", "marriage", "Greek"); root("hydr hydro", "water", "Greek");
root("metr meter", "measure", "Greek"); root("morph", "shape", "Greek"); root("neur", "nerve", "Greek"); root("nym onym", "name", "Greek");
root("path", "feeling, suffering", "Greek"); root("phob", "fear", "Greek"); root("polit poli", "city, citizen", "Greek"); root("scop", "look at", "Greek");
root("soph", "wise", "Greek"); root("techn", "art, skill", "Greek"); root("theo the", "god", "Greek"); root("zo", "animal", "Greek");
root("amic ami", "friend", "Latin"); root("ann enn", "year", "Latin"); root("bell", "war", "Latin"); root("brev", "short", "Latin");
root("capit", "head", "Latin"); root("carn", "flesh", "Latin"); root("corp corpor", "body", "Latin"); root("dent", "tooth", "Latin");
root("dom domin", "house, master", "Latin"); root("equ", "equal", "Latin"); root("fid", "faith, trust", "Latin"); root("fin", "end, limit", "Latin");
root("flu flux", "flow", "Latin"); root("fort", "strong", "Latin"); root("frat", "brother", "Latin"); root("grat", "pleasing, thanks", "Latin");
root("hab hib", "have, hold", "Latin"); root("lab labor", "work", "Latin"); root("liber", "free", "Latin"); root("lingu", "tongue, language", "Latin");
root("liter", "letter", "Latin"); root("magn", "great", "Latin"); root("mar", "sea", "Latin"); root("matr mater", "mother", "Latin");
root("medi", "middle", "Latin"); root("memor", "remember", "Latin"); root("ment", "mind", "Latin"); root("migr", "move, travel", "Latin");
root("min", "small", "Latin"); root("mon", "warn, remind", "Latin"); root("mut", "change", "Latin"); root("nav", "ship", "Latin");
root("neg", "deny, no", "Latin"); root("noc nox", "harm", "Latin"); root("nomin", "name", "Latin"); root("oper", "work", "Latin");
root("pac", "peace", "Latin"); root("patr pater", "father", "Latin"); root("plen plet", "full", "Latin"); root("popul", "people", "Latin");
root("prim", "first", "Latin"); root("quer quir quis", "ask, seek", "Latin"); root("radic", "root", "Latin"); root("rect", "straight, right", "Latin");
root("reg", "rule, king", "Latin"); root("sacr sanct", "holy", "Latin"); root("sci", "know", "Latin"); root("sed sid", "sit", "Latin");
root("sign", "mark", "Latin"); root("simil simul", "like, same", "Latin"); root("sol", "alone; sun", "Latin"); root("solv solu", "loosen", "Latin");
root("son", "sound", "Latin"); root("tempor", "time", "Latin"); root("tort", "twist", "Latin"); root("urb", "city", "Latin");
root("val vail", "strong, worth", "Latin"); root("vor", "eat", "Latin"); root("vulg", "common people", "Latin"); root("cogn", "know", "Latin");
root("doc doct", "teach", "Latin"); root("fus", "pour", "Latin"); root("mand", "order", "Latin");
root("pon pos", "put", "Latin"); root("prehend prehens", "grasp", "Latin"); root("sum sump", "take", "Latin"); root("tain", "hold", "Latin");
export const ROOTS = R;
const ROOT_FORMS = Object.keys(R).sort((a, b) => b.length - a.length);

// ───────── the lexicon: words we know are words ─────────
let lexicon = new Set();
export function addWords(words) { for (const w of words) if (w) lexicon.add(String(w).toLowerCase()); }
export const isKnown = (w) => lexicon.has(w);

// words ending in -ly that aren't "in a … way" (apply ≠ apple + -ly, belly ≠ bell + -ly)
const NOT_LY = new Set("apply supply multiply reply comply imply ally rally belly bully silly tally jelly folly holly sully early only family assembly butterfly anomaly homily lily ugly holy july italy rely fly sly ply monopoly melancholy jolly gully dolly wily hilly chilly smelly frilly woolly curly surly burly hurly jelly molly dally".split(" "));

const NOT_ER = new Set("shoulder brother weather whether together however another chapter computer corner butter".split(" ").filter((w) => w !== "computer"));
// short describing words whose -er form is "more …" (bigger, older, nicer)
const ADJ = new Set("big small old young tall short long fast slow hot cold warm cool high low near deep wide thin thick rich poor hard soft strong weak dark light bright clean kind nice safe late early happy easy busy heavy funny pretty quick quiet loud sweet sharp smart wise wild calm brave rough smooth tight loose cheap fresh great fine plain clear close simple gentle red black white green sad mad glad fat full new true large dry wet hard odd rare ripe pale fair cruel sure".split(" "));

/** Spellings a stem might have had before an ending was added. */
function stems(stem, suffix) {
  const out = [stem];
  if (/(.)\1$/.test(stem) && !/(ss|ll|ff|zz)$/.test(stem)) out.push(stem.slice(0, -1)); // bigger → big, stopped → stop
  if (stem.endsWith("i")) out.push(stem.slice(0, -1) + "y"); // happiest → happy, carried → carry
  if ((/^[aeiouy]/.test(suffix) || suffix === "") && !/([b-df-hj-np-tv-z])\1$/.test(stem)) out.push(stem + "e"); // nicer → nice, making → make (but not poss → posse)
  if (suffix === "ly" && stem.endsWith("l")) out.push(stem + "e"); // gently → gentle
  if (stem.endsWith("ic") && suffix === "ally") out.push(stem); // basically → basic
  return [...new Set(out)];
}

/** The parts of an inflected or derived English word (or null). */
function englishParts(w, depth = 0) {
  if (depth > 3 || w.length < 3) return null;
  const ir = IRREG[w];
  if (ir) return { parts: [{ text: ir.base, type: "base", link: ir.base }], change: ir.note, base: ir.base };
  // endings first (fastest, cats, walked, running, quickly)
  const known = isKnown(w); // a word in its own right: don't read "corner" as corn + -er
  for (const [end, info] of [["est", ENDINGS.est], ["er", ENDINGS.er], ["ing", ENDINGS.ing], ["ed", ENDINGS.ed], ["ies", ENDINGS.es], ["es", ENDINGS.es], ["s", ENDINGS.s], ["ically", ENDINGS.ally], ["ily", ENDINGS.ly], ["ly", ENDINGS.ly]]) {
    if (!w.endsWith(end) || w.length - end.length < 2) continue;
    if (end === "s" && /(ss|us|is)$/.test(w)) continue;
    if (known && depth === 0 && (end === "s" || end === "es")) continue;
    if (known && depth === 0 && end === "er" && NOT_ER.has(w)) continue;
    if (known && depth === 0 && end === "ly" && (NOT_LY.has(w) || w.length < 7 && /lly$/.test(w))) continue;
    const stem = w.slice(0, -end.length);
    const cands = end === "ies" || end === "ily" ? [stem + "y"]
      : end === "ically" ? [stem + "ic"]
      : end === "ly" ? [...stems(stem, end), w.slice(0, -1) + "e"] // gently → gentle, simply → simple
      : stems(stem, end);
    for (const cand of cands) {
      if (cand.length < 2 || (known && end === "ly" && cand.length < 4)) continue; // "early" isn't ear + -ly
      // a word in its own right ending in -er: only "teacher", "bigger" — not "corner", "mother", "number"
      if (known && depth === 0 && end === "er" && !(ADJ.has(cand) || cand.length >= 5)) continue;
      if (isKnown(cand)) {
        // -er: "more" after a describing word (bigger), "someone who does it" after an action (teacher)
        const er = end === "er" ? (ADJ.has(cand) ? { meaning: "more", note: "comparative" } : { meaning: "a person or thing that does it", note: "doer" }) : {};
        return { parts: [{ text: cand, type: "base", link: cand }, { text: info.show, type: "ending", meaning: info.meaning, note: info.note, ...er }], base: cand, ending: info, end };
      }
    }
  }
  // suffixes that make a new word (kindness, hopeful, teacher, believable)
  for (const sf of SUFFIXES) {
    if (!w.endsWith(sf.form) || w.length - sf.form.length < 3) continue;
    if (known && depth === 0 && sf.form.length <= 2) continue; // "butter", "bully", "garden" stay whole
    const stem = w.slice(0, -sf.form.length);
    for (const cand of stems(stem, sf.form)) {
      if (isKnown(cand) || (cand.length >= 4 && englishParts(cand, depth + 1)?.base)) {
        const inner = isKnown(cand) ? { parts: [{ text: cand, type: "base", link: cand }], base: cand } : englishParts(cand, depth + 1);
        return { parts: [...inner.parts, { text: `-${sf.form}`, type: "suffix", meaning: sf.meaning, from: sf.from }], base: inner.base };
      }
    }
  }
  // prefixes (unhappy, rewrite, misread)
  for (const pf of PREFIXES) {
    if (!w.startsWith(pf.form) || w.length - pf.form.length < 3 || pf.form.length < 2) continue;
    const rest = w.slice(pf.form.length).replace(/^-/, "");
    if (isKnown(rest) || (rest.length >= 4 && englishParts(rest, depth + 1)?.base)) {
      const root = R[rest] && pf.from && /Latin|Greek/.test(pf.from) ? R[rest] : null;
      const inner = root ? { parts: [{ text: rest, type: "root", meaning: root.meaning, from: root.from, link: rest }], base: null }
        : isKnown(rest) ? { parts: [{ text: rest, type: "base", link: rest }], base: rest } : englishParts(rest, depth + 1);
      return { parts: [{ text: `${pf.form}-`, type: "prefix", meaning: pf.meaning, from: pf.from }, ...inner.parts], base: inner.base };
    }
  }
  return null;
}

/** Latin or Greek building blocks: prefix + root + suffix (spect-ator, trans-port-ation). */
function classicalParts(w) {
  if (w.length < 5) return null;
  let best = null;
  for (const r of ROOT_FORMS) {
    if (r.length < 3) continue;
    let i = w.indexOf(r);
    while (i >= 0) {
      const left = w.slice(0, i), right = w.slice(i + r.length);
      const pre = left ? prefixChain(left) : [];
      const suf = right ? suffixChain(right) : [];
      const tiny = !pre?.length && suf?.length === 1 && suf[0].text.length <= 3 && lexicon.has(w);
      if (pre && suf && (pre.length || suf.length) && !tiny) {
        const score = r.length * 2 + pre.reduce((n, p) => n + p.text.length, 0) + suf.reduce((n, p) => n + p.text.length, 0) - (pre.length + suf.length);
        if (!best || score > best.score) best = { score, parts: [...pre, { text: r, type: "root", meaning: R[r].meaning, from: R[r].from }, ...suf] };
      }
      i = w.indexOf(r, i + 1);
    }
  }
  return best && best.parts.length >= 2 ? { parts: best.parts, classical: true } : null;
}
function prefixChain(s) {
  if (!s) return [];
  for (const pf of PREFIXES) if (s.startsWith(pf.form)) {
    const rest = prefixChain(s.slice(pf.form.length));
    if (rest) return [{ text: `${pf.form}-`, type: "prefix", meaning: pf.meaning, from: pf.from }, ...rest];
  }
  return null;
}
function suffixChain(s) {
  if (!s) return [];
  // a joining vowel (chron-o-logy, aud-i-ence) belongs to nobody
  const tries = [[s, null], ...(/^[aeiou]/.test(s) ? [[s.slice(1), s[0]]] : [])];
  for (const [t] of tries) {
    if (!t) continue;
    for (const sf of SUFFIXES) if (t.startsWith(sf.form)) {
      const rest = suffixChain(t.slice(sf.form.length));
      if (rest) return [{ text: `-${sf.form}`, type: "suffix", meaning: sf.meaning, from: sf.from }, ...rest];
    }
    for (const [end, info] of Object.entries(ENDINGS)) if (t === end) return [{ text: info.show, type: "ending", meaning: info.meaning, note: info.note }];
  }
  return null;
}

/**
 * How a word is made: { parts: [{ text, type: base|prefix|suffix|ending|root, meaning, from, link }],
 * base, change, classical } — or null when it's a simple word we can't split.
 */
export function anatomy(raw) {
  const w = String(raw || "").toLowerCase().replace(/[’']s$/, "").replace(/[^a-z-]/g, "");
  if (w.length < 3) return null;
  const eng = englishParts(w);
  const a = eng && !(eng.parts.length === 1 && !eng.change) ? { word: w, ...eng } : classicalParts(w) ? { word: w, ...classicalParts(w) } : null;
  return a && inOrNot(a);
}

const IN_PLACE = new Set("inside input income inborn inland indeed inlet inmost inner inward inwards insight instead inset inroad inbox indoor indoors inflow intake inmate inbound inbreed inbred infield inlay inlaid inhale imbed impart implant import impose imprint imprison inflame inflate inform infuse ingrain inhabit inherit inject inquire inscribe insert install instill insure invade invest involve".split(" "));
// in- / im- means "not" before a describing word (impossible, incredible) but "in, into" before a Latin root (import, inject)
function inOrNot(a) {
  const i = a.parts.findIndex((p) => p.type === "prefix" && /^(in|im|il|ir)-$/.test(p.text));
  if (i < 0) return a;
  const next = a.parts[i + 1];
  const describing = a.parts.some((p, j) => j > i && /^-(able|ible|ent|ant|ate|al|ous|ive|ar|id|ite|ic|ful|ary)$/.test(p.text));
  const place = IN_PLACE.has(a.word);
  a.parts[i] = { ...a.parts[i], meaning: !place && (next?.type === "base" || describing) ? "not" : "in, into" };
  return a;
}

/** "fastest" = "the most fast": a plain sentence for what the parts add up to. */
export function sumUp(a) {
  if (!a) return "";
  if (a.change) return `${a.change} “${a.base}”`;
  const base = a.parts.find((p) => p.type === "base");
  const end = a.parts.find((p) => p.type === "ending");
  if (base && end && a.parts.length === 2) {
    if (end.text === "-est") return `the most ${base.text}`;
    if (end.text === "-er") return end.note === "doer" ? `someone or something that ${does(base.text)}` : `more ${base.text}`;
    if (end.text === "-ly" && /^(day|week|month|year|hour|night|quarter|fortnight|minute|second)$/.test(base.text)) return `every ${base.text}`;
    if (end.text === "-ly" && end.note === "like") return `with the qualities of ${base.text}`;
    if (end.text === "-ly") return `in a ${base.text} way`;
  }
  return a.parts.map((p) => (p.type === "base" ? p.text : p.meaning ? `“${p.meaning.split(/[;,(]/)[0].trim()}”` : p.text)).join(" + ");
}

const does = (v) => /(s|sh|ch|x|z|o)$/.test(v) ? v + "es" : /[^aeiou]y$/.test(v) ? v.slice(0, -1) + "ies" : v + "s";

// words from the same family: other words built on a root
export function sameRoot(rootForm, words) {
  return words.filter((x) => x.includes(rootForm)).slice(0, 12);
}
