// A stand-in for the browser's built-in translator (Chrome/Edge "Translator" API), for tests:
// English ⇄ Hindi, word by word from a small glossary — enough to see that text was translated.
(() => {
  const EN_HI = {
    the: "", a: "एक", an: "एक", and: "और", is: "है", was: "था", were: "थे", of: "का", to: "को", in: "में", on: "पर", it: "यह", he: "वह", she: "वह",
    his: "उसका", her: "उसकी", they: "वे", by: "के पास", with: "के साथ", from: "से", for: "के लिए", not: "नहीं", but: "लेकिन", that: "कि",
    old: "पुराना", cottage: "कुटिया", river: "नदी", kettle: "केतली", water: "पानी", coat: "कोट", said: "कहा", thank: "धन्यवाद", you: "आप",
    replied: "उत्तर दिया", came: "आया", come: "आओ", house: "घर", book: "किताब", lamp: "दीपक", lamplighter: "दीपक जलाने वाला", street: "गली",
    quiet: "शांत", dusk: "सांझ", evening: "शाम", light: "रोशनी", warm: "गर्म", door: "दरवाज़ा", window: "खिड़की", tea: "चाय", morning: "सुबह",
    night: "रात", day: "दिन", rain: "बारिश", fire: "आग", sat: "बैठा", walked: "चला", tom: "टॉम", mary: "मैरी", fastest: "सबसे तेज़", human: "मनुष्य",
  };
  const HI_EN = Object.fromEntries(Object.entries(EN_HI).filter(([, h]) => h).map(([e, h]) => [h, e]));
  Object.assign(HI_EN, { "पानी": "water", "राम": "Ram", "घर": "home", "जा": "go", "रहा": "", "है": "is", "किताब": "book", "बहुत": "very", "अच्छी": "good", "यह": "this" });
  const enHi = (t) => t.replace(/[A-Za-z']+/g, (w) => (w.toLowerCase() in EN_HI ? EN_HI[w.toLowerCase()] : w)).replace(/\s{2,}/g, " ").replace(/\.(\s|$)/g, "।$1").trim();
  const hiEn = (t) => t.replace(/[ऀ-ॿ]+/g, (w) => (w in HI_EN ? HI_EN[w] : w)).replace(/।/g, ".").replace(/\s{2,}/g, " ").trim();
  window.__translated = 0;
  window.Translator = {
    async availability({ sourceLanguage: s, targetLanguage: t }) { return (s === "en" && t === "hi") || (s === "hi" && t === "en") ? "available" : "unavailable"; },
    async create({ sourceLanguage: s, targetLanguage: t }) {
      return { async translate(text) { window.__translated++; await new Promise((r) => setTimeout(r, 2)); return s === "en" ? enHi(text) : hiEn(text); }, destroy() {} };
    },
  };
})();
