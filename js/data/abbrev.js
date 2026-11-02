// Full forms of abbreviations. In order of trust:
//  1. the book itself — "Gross Domestic Product (GDP)" or "GDP (Gross Domestic Product)";
//  2. a built-in list of common ones (works offline);
//  3. Wiktionary ("Initialism of gross domestic product");
//  4. Wikipedia (GDP → "Gross domestic product"; disambiguation pages for the rest).
// Roman numerals are read too (XIV = 14).
import { bookPages } from "./fulltext.js";
import { wikiSummary } from "./wiki.js";

// key = the letters, upper-cased, without dots. Several meanings are separated by ";".
const LIST = `
AD=Anno Domini (in the year of our Lord)|BC=Before Christ|BCE=Before the Common Era|CE=Common Era|AM=ante meridiem (before noon)|PM=post meridiem (after noon); Prime Minister|
GMT=Greenwich Mean Time|UTC=Coordinated Universal Time|IST=Indian Standard Time|EST=Eastern Standard Time|PST=Pacific Standard Time|
EG=exempli gratia (for example)|IE=id est (that is)|ETC=et cetera (and so on)|ETAL=et alii (and others)|CF=confer (compare)|VIZ=videlicet (namely)|IBID=ibidem (in the same place)|
OPCIT=opere citato (in the work already cited)|NB=nota bene (note well)|PS=postscript|QV=quod vide (which see)|CA=circa (about); Chartered Accountant; California|C=circa (about)|
VS=versus (against)|APPROX=approximately|DEPT=department|GOVT=government|ASST=assistant|EST.=established|NO=number|NOS=numbers|VOL=volume|VOLS=volumes|ED=edition; editor|
EDS=editors|TRANS=translated by; translation|REV=revised; Reverend|CH=chapter|CHAP=chapter|P=page|PP=pages|FIG=figure|ESP=especially|ST=Saint; Street|MT=Mount|
MR=Mister|MRS=Missus (a married woman)|MS=a woman (married or not); manuscript|DR=Doctor; Drive|PROF=Professor|SR=Senior|JR=Junior|SIR=Sir|HON=Honourable|
RSVP=répondez s'il vous plaît (please reply)|ASAP=as soon as possible|FAQ=frequently asked questions|FYI=for your information|DIY=do it yourself|AKA=also known as|
TBD=to be decided|TBA=to be announced|ETA=estimated time of arrival|ID=identity; identification|PIN=personal identification number|ATM=automated teller machine|
SIM=subscriber identity module|OTP=one-time password|EMI=equated monthly instalment|NGO=non-governmental organisation|PR=public relations|HR=human resources|
IT=information technology|RD=research and development|QA=quality assurance|SOP=standard operating procedure|MOU=memorandum of understanding|NDA=non-disclosure agreement|
CV=curriculum vitae (a résumé)|PTO=please turn over; paid time off|WFH=work from home|OOO=out of office|EOD=end of day|COB=close of business|POC=proof of concept; point of contact|
MVP=minimum viable product; most valuable player|RFP=request for proposal|RFQ=request for quotation|SLA=service-level agreement|SOW=statement of work|
TAM=total addressable market|SAM=serviceable available market|SOM=serviceable obtainable market|USP=unique selling proposition|
CAGR=compound annual growth rate|YOY=year on year|QOQ=quarter on quarter|MOM=month on month|YTD=year to date|FY=financial year|Q1=first quarter|
GDP=gross domestic product|GNP=gross national product|GVA=gross value added|CPI=consumer price index|WPI=wholesale price index|PPP=purchasing power parity; public–private partnership|
EBIT=earnings before interest and taxes|EBITDA=earnings before interest, taxes, depreciation and amortisation|PAT=profit after tax|PBT=profit before tax|EPS=earnings per share|
PE=price-to-earnings (ratio); private equity; physical education|NPV=net present value|IRR=internal rate of return|ROI=return on investment|ROE=return on equity|
ROCE=return on capital employed|ROA=return on assets|WACC=weighted average cost of capital|DCF=discounted cash flow|FCF=free cash flow|CAPEX=capital expenditure|
OPEX=operating expenditure|COGS=cost of goods sold|SGA=selling, general and administrative expenses|PL=profit and loss|AUM=assets under management|NAV=net asset value|
SIP=systematic investment plan|ETF=exchange-traded fund|IPO=initial public offering|FPO=follow-on public offer|QIP=qualified institutional placement|MA=mergers and acquisitions; Master of Arts|
LBO=leveraged buyout|VC=venture capital|LP=limited partner|GP=general partner|B2B=business to business|B2C=business to consumer|D2C=direct to consumer|
SAAS=software as a service|PAAS=platform as a service|IAAS=infrastructure as a service|CRM=customer relationship management|ERP=enterprise resource planning|
KPI=key performance indicator|OKR=objectives and key results|SWOT=strengths, weaknesses, opportunities, threats|PESTLE=political, economic, social, technological, legal, environmental|
MECE=mutually exclusive, collectively exhaustive|FMCG=fast-moving consumer goods|CPG=consumer packaged goods|BFSI=banking, financial services and insurance|
TMT=technology, media and telecommunications|GCC=global capability centre; Gulf Cooperation Council|ESG=environmental, social and governance|DEI=diversity, equity and inclusion|
CSR=corporate social responsibility|GDPR=General Data Protection Regulation|IFRS=International Financial Reporting Standards|GAAP=generally accepted accounting principles|
SOX=Sarbanes–Oxley Act|AML=anti-money laundering|KYC=know your customer|CEO=chief executive officer|CFO=chief financial officer|COO=chief operating officer|
CTO=chief technology officer|CIO=chief information officer|CMO=chief marketing officer|CHRO=chief human resources officer|CXO=chief experience officer; any chief officer|
MD=managing director; Doctor of Medicine|VP=vice president|SVP=senior vice president|AVP=assistant vice president|GM=general manager|PMO=project management office|
EY=Ernst & Young|PWC=PricewaterhouseCoopers|KPMG=Klynveld Peat Marwick Goerdeler|BCG=Boston Consulting Group|IBM=International Business Machines|
HSBC=Hongkong and Shanghai Banking Corporation|SBI=State Bank of India|HDFC=Housing Development Finance Corporation|ICICI=Industrial Credit and Investment Corporation of India|
LIC=Life Insurance Corporation of India|TCS=Tata Consultancy Services|L&T=Larsen & Toubro|ONGC=Oil and Natural Gas Corporation|BHEL=Bharat Heavy Electricals Limited|
RBI=Reserve Bank of India|SEBI=Securities and Exchange Board of India|IRDAI=Insurance Regulatory and Development Authority of India|NSE=National Stock Exchange|BSE=Bombay Stock Exchange|
GST=Goods and Services Tax|TDS=tax deducted at source|ITR=income tax return|PAN=Permanent Account Number|UPI=Unified Payments Interface|NEFT=National Electronic Funds Transfer|
RTGS=Real Time Gross Settlement|IMPS=Immediate Payment Service|IFSC=Indian Financial System Code|NRI=non-resident Indian|PSU=public sector undertaking|
UPSC=Union Public Service Commission|IAS=Indian Administrative Service|IPS=Indian Police Service|IFS=Indian Foreign Service|CBI=Central Bureau of Investigation|
FIR=first information report|MLA=Member of the Legislative Assembly|MP=Member of Parliament; Madhya Pradesh|NITI=National Institution for Transforming India|
ISRO=Indian Space Research Organisation|DRDO=Defence Research and Development Organisation|IIT=Indian Institute of Technology|IIM=Indian Institute of Management|
NIT=National Institute of Technology|AIIMS=All India Institute of Medical Sciences|TISS=Tata Institute of Social Sciences|CAT=Common Admission Test|
GMAT=Graduate Management Admission Test|GRE=Graduate Record Examinations|IELTS=International English Language Testing System|TOEFL=Test of English as a Foreign Language|
NEET=National Eligibility cum Entrance Test|JEE=Joint Entrance Examination|CBSE=Central Board of Secondary Education|ICSE=Indian Certificate of Secondary Education|
BJP=Bharatiya Janata Party|INC=Indian National Congress|AAP=Aam Aadmi Party|UN=United Nations|UNO=United Nations Organization|WHO=World Health Organization|
UNESCO=United Nations Educational, Scientific and Cultural Organization|UNICEF=United Nations Children's Fund|IMF=International Monetary Fund|WTO=World Trade Organization|
OPEC=Organization of the Petroleum Exporting Countries|NATO=North Atlantic Treaty Organization|EU=European Union|UK=United Kingdom|US=United States|USA=United States of America|
UAE=United Arab Emirates|USSR=Union of Soviet Socialist Republics|ASEAN=Association of Southeast Asian Nations|SAARC=South Asian Association for Regional Cooperation|
BRICS=Brazil, Russia, India, China, South Africa|G20=Group of Twenty|OECD=Organisation for Economic Co-operation and Development|NASA=National Aeronautics and Space Administration|
FBI=Federal Bureau of Investigation|CIA=Central Intelligence Agency|BBC=British Broadcasting Corporation|CNN=Cable News Network|IPL=Indian Premier League|
FIFA=Fédération Internationale de Football Association|ICC=International Cricket Council; International Criminal Court|IOC=International Olympic Committee|
AI=artificial intelligence|ML=machine learning|LLM=large language model|API=application programming interface|CPU=central processing unit|GPU=graphics processing unit|
RAM=random-access memory|ROM=read-only memory|SSD=solid-state drive|HDD=hard disk drive|USB=Universal Serial Bus|URL=uniform resource locator (a web address)|
HTML=HyperText Markup Language|CSS=Cascading Style Sheets|HTTP=Hypertext Transfer Protocol|HTTPS=Hypertext Transfer Protocol Secure|PDF=Portable Document Format|
JPEG=Joint Photographic Experts Group|PNG=Portable Network Graphics|GIF=Graphics Interchange Format|WIFI=wireless fidelity|GPS=Global Positioning System|
SMS=Short Message Service|OS=operating system|UI=user interface|UX=user experience|SQL=Structured Query Language|IOT=Internet of Things|VR=virtual reality|AR=augmented reality|
LED=light-emitting diode|LCD=liquid-crystal display|TV=television|PC=personal computer|IP=intellectual property; Internet Protocol|ISP=internet service provider|
DNA=deoxyribonucleic acid|RNA=ribonucleic acid|MRI=magnetic resonance imaging|CT=computed tomography|ICU=intensive care unit|ER=emergency room|OPD=outpatient department|
HIV=human immunodeficiency virus|AIDS=acquired immunodeficiency syndrome|COVID=coronavirus disease|BMI=body mass index|BP=blood pressure|IQ=intelligence quotient|
EQ=emotional quotient|ADHD=attention deficit hyperactivity disorder|OCD=obsessive–compulsive disorder|PTSD=post-traumatic stress disorder|CPR=cardiopulmonary resuscitation|
PHD=Doctor of Philosophy|BA=Bachelor of Arts|MSC=Master of Science|BSC=Bachelor of Science|MBA=Master of Business Administration|BBA=Bachelor of Business Administration|
BCOM=Bachelor of Commerce|MCOM=Master of Commerce|BTECH=Bachelor of Technology|MTECH=Master of Technology|MBBS=Bachelor of Medicine, Bachelor of Surgery|
LLB=Bachelor of Laws|LLM.=Master of Laws|CFA=Chartered Financial Analyst|CPA=Certified Public Accountant|ACCA=Association of Chartered Certified Accountants|
CS=Company Secretary; computer science|KM=kilometre|KG=kilogram|CM=centimetre|MM=millimetre|MPH=miles per hour|KPH=kilometres per hour|KMPH=kilometres per hour|
KWH=kilowatt-hour|MW=megawatt|GB=gigabyte|MB=megabyte|KB=kilobyte|TB=terabyte; tuberculosis|SQFT=square feet|FT=foot / feet|IN.=inch|LB=pound (weight)|OZ=ounce|
RS=rupees|INR=Indian rupee|USD=United States dollar|GBP=British pound sterling|EUR=euro|AED=UAE dirham|BN=billion|MN=million|CR=crore (ten million)|LAKH=one hundred thousand|
K=thousand|AGM=annual general meeting|EGM=extraordinary general meeting|LLP=limited liability partnership|LTD=limited (company)|PVT=private|INC.=incorporated|CO=company|
CORP=corporation|PLC=public limited company|ESOP=employee stock ownership plan|CTC=cost to company|PF=provident fund|EPF=Employees' Provident Fund|HRA=house rent allowance|
LOL=laughing out loud|OMG=oh my god|BTW=by the way|IMO=in my opinion|TBH=to be honest|IDK=I don't know|DM=direct message|POV=point of view|GOAT=greatest of all time|
SUV=sport utility vehicle|EV=electric vehicle|CNG=compressed natural gas|LPG=liquefied petroleum gas|AC=air conditioning; alternating current|DC=direct current; District of Columbia|
RIP=rest in peace|SOS=a call for help|OK=all right|VIP=very important person|CCTV=closed-circuit television|NCR=National Capital Region|
`;

const TABLE = new Map();
for (const row of LIST.split("|")) {
  const i = row.indexOf("=");
  if (i < 1) continue;
  const key = row.slice(0, i).trim().replace(/[.&]/g, "").toUpperCase();
  const fulls = row.slice(i + 1).split(";").map((x) => x.trim()).filter(Boolean);
  if (key && fulls.length) TABLE.set(key, [...(TABLE.get(key) || []), ...fulls]);
}

// lower-case abbreviations that are only abbreviations with their dots, or always
// lower-case abbreviations, recognised when written with their dot ("etc.", "viz.", "approx.") —
// not ones that are also everyday words at the end of a sentence ("no.", "am.", "rev.")
export const LOWER_OK = new Set(["eg", "ie", "etc", "etal", "cf", "viz", "ibid", "opcit", "nb", "qv", "ca", "c", "p", "pp", "vs", "approx", "dept", "govt", "asst", "vol", "vols", "eds", "chap", "fig", "esp", "mr", "mrs", "dr", "prof", "sr", "jr", "km", "kg", "cm", "mm", "mph", "kph", "kmph", "kwh", "rs", "bn", "mn", "ltd", "pvt", "corp", "aka", "asap", "fyi", "rsvp", "am", "pm"]);

export const abbrKey = (raw) => String(raw || "").trim().replace(/[’']s$|(?<=[A-Z]{2})s$/, "").replace(/[.&\s]/g, "").toUpperCase();

/** Roman numerals (II … MMXXVI). */
export function romanValue(raw) {
  const t = String(raw || "").trim();
  if (!/^[IVXLCDM]{2,9}$/.test(t)) return null;
  const V = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let n = 0;
  for (let i = 0; i < t.length; i++) { const v = V[t[i]], nx = V[t[i + 1]] || 0; n += v < nx ? -v : v; }
  // only the canonical spelling counts (so "MIX" or "DIM" in capitals aren't numbers by accident)
  const back = (x) => [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]].reduce((s, [v, r]) => { while (x >= v) { s += r; x -= v; } return s; }, "");
  // I–CCCXCIX, or long ones like MCMXC — not three-letter words in capitals (MIX, DIM)
  return back(n) === t && (/^[IVXLC]+$/.test(t) || (/^[MD]/.test(t) && t.length >= 4)) ? n : null;
}

/** Does this look like an abbreviation? GDP, CEOs, U.S., e.g., Ph.D., XIV */
export function isAbbreviation(raw) {
  const t = String(raw || "").trim();
  if (!t || t.length > 14 || /\s/.test(t.replace(/^(et al|op cit)\.?$/i, "x"))) return false;
  if (/^(?:[A-Za-z]\.){2,}[A-Za-z]?\.?$/.test(t)) return true;                          // e.g.  U.S.  i.e.  a.m.
  if (/^(?=(?:[^A-Z]*[A-Z]){2})[A-Z][A-Za-z0-9&.\-/]{1,11}$/.test(t) && !/^[A-Z][a-z]+$/.test(t)) {
    const caps = (t.match(/[A-Z]/g) || []).length;
    return caps >= 2 && caps >= t.replace(/[^A-Za-z]/g, "").length * 0.5;              // GDP  CEOs  PhD  B2B  R&D
  }
  const k = abbrKey(t).toLowerCase();
  return /\.$/.test(t) && LOWER_OK.has(k) || /^(et al|op cit)\.?$/i.test(t);         // etc.  viz.  cf.  et al.
}

/** The full form, as the book itself defines it (Schwartz–Hearst style). → { full, page } */
export async function fullFormInBook(raw, docId) {
  if (!docId) return null;
  const pages = await bookPages(docId).catch(() => null);
  if (!pages?.length) return null;
  const abbr = String(raw).replace(/[’']s$|(?<=[A-Z]{2})s$/, "").replace(/\.$/, "");
  const letters = abbr.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (letters.length < 2) return null;
  const esc = abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = new RegExp(`([^()]{4,160})\\(\\s*${esc}s?\\s*[),;]`, "g");     // Gross Domestic Product (GDP)
  const after = new RegExp(`\\b${esc}s?\\s*\\(([^()]{4,120})\\)`, "g");           // GDP (gross domestic product)
  for (let i = 0; i < pages.length; i++) {
    const text = String(pages[i] || "").replace(/\s+/g, " ");
    if (!text.includes(abbr)) continue;
    for (const m of text.matchAll(before)) {
      const full = matchInitials(m[1].split(/\s+/).filter(Boolean), letters, true);
      if (full) return { full, page: i + 1 };
    }
    for (const m of text.matchAll(after)) {
      const full = matchInitials(m[1].split(/\s+/).filter(Boolean), letters, false);
      if (full) return { full, page: i + 1 };
    }
  }
  return null;
}

const MINOR = new Set(["of", "and", "the", "for", "in", "on", "to", "&", "a", "an", "de", "du", "des", "la", "le", "von", "van", "at", "by", "with", "or"]);

/** The shortest run of words (ending at the last one, or starting at the first) whose initials spell `letters`. */
function matchInitials(words, letters, fromEnd) {
  const clean = words.map((w) => w.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&]+$/gu, "")).filter(Boolean);
  const n = clean.length;
  for (let k = 1; k <= Math.min(n, letters.length + 4); k++) {
    const run = fromEnd ? clean.slice(n - k) : clean.slice(0, k);
    if (spells(run, letters)) {
      if (fromEnd && MINOR.has(run[0].toLowerCase())) continue;
      return run.join(" ");
    }
  }
  return null;
}
function spells(run, letters) {
  // every important word gives the next letter; a word may give more letters from inside it (Wi-Fi, PhD)
  const go = (wi, li) => {
    if (li === letters.length) return run.slice(wi).every((w) => MINOR.has(w.toLowerCase()));
    if (wi === run.length) return false;
    const w = run[wi].toLowerCase();
    if (MINOR.has(w) && go(wi + 1, li)) return true;
    // split hyphenated words: Co-operation gives C and O
    const parts = w.split("-").filter(Boolean);
    if (parts.length > 1) {
      let l = li, ok = true;
      for (const p of parts) { if (p[0] === letters[l]) l++; else { ok = false; break; } }
      if (ok && go(wi + 1, l)) return true;
    }
    if (w[0] !== letters[li]) return false;
    let l = li + 1;
    if (go(wi + 1, l)) return true;
    for (let c = 1; c < w.length && l < letters.length; c++) if (w[c] === letters[l]) { l++; if (go(wi + 1, l)) return true; }
    return false;
  };
  return go(0, 0);
}

/** Wiktionary's "Initialism of …" lines. */
async function fullFormsWiktionary(abbr) {
  const tries = [...new Set([abbr, abbr.replace(/\./g, ""), abbr.toUpperCase()])];
  for (const t of tries) {
    const res = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(t.replace(/ /g, "_"))}?redirect=true`).catch(() => null);
    if (!res?.ok) continue;
    const data = await res.json().catch(() => null);
    const en = data?.en || [];
    const out = [];
    for (const sec of en) for (const d of sec.definitions || []) {
      const text = new DOMParser().parseFromString(`<body>${d.definition || ""}</body>`, "text/html").body.textContent.replace(/\s+/g, " ").trim();
      const m = /(?:initialism|acronym|abbreviation|contraction|short form|clipping) of\s+(.+?)\.?\s*$/i.exec(text);
      if (m) {
        const label = /^\(([^)]{2,40})\)/.exec(text)?.[1];
        out.push({ full: m[1].replace(/^["“]|["”]$/g, "").replace(/\s*\(.*?\)\s*$/, ""), note: label || "" });
      }
    }
    if (out.length) return out;
  }
  return [];
}

/** Wikipedia: GDP redirects to "Gross domestic product". */
async function fullFormWikipedia(abbr) {
  const s = await wikiSummary(abbr).catch(() => null);
  if (!s || s.type === "disambiguation") return null;
  const letters = abbr.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (s.title.replace(/[^A-Za-z]/g, "").toLowerCase() === letters) return null;
  return spells(s.title.split(/\s+/), letters) ? { full: s.title, summary: s } : null;
}

/**
 * Every full form we can find: [{ full, from: "book" | "list" | "wiktionary" | "wikipedia" | "roman", page?, note? }]
 */
export async function fullForms(raw, { docId = null, online = navigator.onLine } = {}) {
  const t = String(raw || "").trim();
  const key = abbrKey(t);
  const out = [];
  const same = (a, b) => a.toLowerCase().replace(/s$/, "") === b.toLowerCase().replace(/s$/, "");
  const add = (x) => { if (x?.full && !out.some((o) => same(o.full, x.full))) out.push(x); };
  const book = await fullFormInBook(t, docId).catch(() => null);
  if (book) add({ ...book, from: "book" });
  // the list: case matters for short ones ("US" the country, not "us")
  const lowerOk = t === t.toLowerCase() ? LOWER_OK.has(key.toLowerCase()) : true;
  if (lowerOk) for (const f of TABLE.get(key) || []) add({ full: f, from: "list" });
  const r = romanValue(t);
  if (r != null && !out.length) add({ full: `${r} (the Roman numeral)`, from: "roman" });
  if (online && !out.some((o) => o.from === "book")) {
    const [wk, wp] = await Promise.all([fullFormsWiktionary(t).catch(() => []), fullFormWikipedia(t).catch(() => null)]);
    for (const x of wk) add({ ...x, from: "wiktionary" });
    if (wp) add({ full: wp.full, from: "wikipedia", summary: wp.summary });
  }
  if (r != null && !out.some((o) => o.from === "roman")) add({ full: `${r} (the Roman numeral)`, from: "roman" });
  return out.slice(0, 6);
}
