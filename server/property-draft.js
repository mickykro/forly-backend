/*
 * property-draft.js — pure helpers behind the WhatsApp property chat.
 *
 * No I/O. Everything the turn handler (whatsapp-intake.js) needs to decide
 * "is this message ours", "what do we ask next" and "what did the agent
 * answer" lives here so it can be unit-tested without Express or Firestore.
 */
const { SCHEMA } = require("./listing-extract");
const { asMillis } = require("./utils");

const REQUIRED = ["city", "price", "rooms"];
const OPTIONAL = ["deal", "size_sqm", "floor", "parking", "neighborhood", "description"];
const ASK_ORDER = [...REQUIRED, ...OPTIONAL];
// create.html won't build a page from fewer than 4, stricter than the API's 3.
const MIN_PHOTOS = 4;
const PAUSE_MS = 2 * 60 * 60 * 1000;

const KEYWORDS = ["נכס חדש", "דף נכס", "דף חדש", "דף נכס חדש", "ליצור נכס", "צור נכס", "ליצור דף נכס"];
const LISTING_HINTS = ["חדרים", "חד׳", "חד'", "מ״ר", "מ\"ר", "קומה", "למכירה", "להשכרה", "₪", "מחיר", "שכירות"];
const COMMANDS = { "ביטול": "cancel", "דלג": "skip", "ממשיכים": "continue", "כן": "yes", "לא": "no", "המשך": "resume", "חדש": "new",
  "תצוגה מקדימה": "preview", "ליצור": "create", "עזרה": "help" };
// Natural phrasings for the buttons above; button taps always send the exact
// COMMANDS word, these cover what a person types instead of tapping.
const COMMAND_ALIASES = { "להמשיך": "resume", "להמשיך אותה": "resume", "תמשיך": "resume", "נמשיך": "resume",
  "תצוגה": "preview", "לצפות": "preview", "צור": "create", "צרו": "create", "ליצור עכשיו": "create", "תיצור": "create",
  // An agent who wants the guide types the question, not a keyword. These are
  // whole-message matches, so "איך משתמשים" asks for help while "איך משתמשים
  // בממ״ד הזה" stays a description someone is writing for their listing.
  "הוראות": "help", "מדריך": "help", "עזרו לי": "help", "איך משתמשים": "help",
  "איך זה עובד": "help", "איך עובדים": "help", "מה אפשר לעשות": "help" };

// Page designs, in the order create.html's picker lists them (1-6). The first
// alias is the Hebrew name shown there; create.html preselects the chosen one.
const TEMPLATES = {
  original: ["קלאסי", "classic", "original"], nocturne: ["נוקטורן", "nocturne"], reel: ["ריל", "reel"],
  atelier: ["אטלייה", "atelier"], loupe: ["לופה", "לופ", "loupe"], orbite: ["אורביט", "orbite"],
};
const TEMPLATE_KEYS = Object.keys(TEMPLATES);

// First http(s) link in a chat message; trailing punctuation is not part of it.
const URL_RE = /https?:\/\/[^\s<>"']+/i;
function findUrl(text) {
  const m = URL_RE.exec(String(text || ""));
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?)\]]+$/, "");
  try { return new URL(url).href; } catch (e) { return null; }
}

// Emoji and trailing punctuation don't change the meaning: "✅ ליצור!" is "ליצור".
const clean = (t) => String(t || "").replace(/[\p{Extended_Pictographic}️‍]/gu, "").trim().replace(/[!.?]+$/, "").trim();
function command(text) { const c = clean(text); return COMMANDS[c] || COMMAND_ALIASES[c] || null; }

// Speech-to-text turns "תצוגה מקדימה" into "תצאו גם מקדימה" and "דלג" into
// "דליק", and an exact match then leaves the agent repeating themselves. Typed
// text is never run through this — only a transcription, where the wobble is
// the machine's fault rather than the speaker's.
//
// A near match is NOT proof of intent: "חדרה" is two edits from "חדש" and
// "לוד" from "ליצור". The caller must therefore only consult this after the
// message has already failed to be anything else, where the alternative is an
// error message rather than a correct answer.
// The word a matched command is spelled with, for re-running the turn.
const CANONICAL = Object.fromEntries(Object.entries(COMMANDS).map(([word, cmd]) => [cmd, word]));
const PHRASES = () => ({ ...COMMANDS, ...COMMAND_ALIASES });
function editDistance(a, b) {
  let prev = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}
function spokenCommand(text) {
  const c = clean(text).toLowerCase();
  if (!c || command(c)) return null;              // already understood; leave it alone
  const phrases = PHRASES();
  // A distinctive word survives most mis-hearings: "מקדימה" is still there in
  // "תצאו גם מקדימה". One-word commands are too short to match this way.
  for (const [phrase, cmd] of Object.entries(phrases)) {
    const longest = phrase.split(" ").sort((a, b) => b.length - a.length)[0];
    if (longest.length >= 6 && c.includes(longest)) return cmd;
  }
  // Otherwise allow a two-character slip, but never on a digit (a spoken "1"
  // must not become "לא") and never on a word too short to slip safely.
  if (/\d/.test(c) || c.length < 3 || c.length > 12) return null;
  let best = null;
  for (const [phrase, cmd] of Object.entries(phrases)) {
    if (phrase.length < 3) continue;
    const d = editDistance(c, phrase.toLowerCase());
    if (d <= 2 && (!best || d < best.d)) best = { cmd, d };
  }
  return best ? best.cmd : null;
}
function isKeyword(text) { return KEYWORDS.includes(clean(text)); }
function looksLikeListing(text) {
  const t = String(text || "");
  return t.length >= 40 && LISTING_HINTS.filter((h) => t.includes(h)).length >= 2;
}
function openerKind(text) {
  if (findUrl(text)) return "link";
  if (isKeyword(text)) return "keyword";
  if (looksLikeListing(text)) return "text";
  return null;
}

// ── answer parsers (no LLM) ──
const firstNumber = (t) => { const m = /(\d+(?:[.,]\d+)*)/.exec(String(t || "")); return m ? Number(m[1].replace(/,/g, "")) : null; };

// Spoken numbers (voice notes arrive as words): "מאה ועשר" 110, "100 ו-10" 110,
// "שלוש וחצי" 3.5, "אחת עשרה" 11. Summed over the first run of number words only,
// so "קומה שתיים מתוך שש" is 2, not 8.
const WORD_NUM = {
  אפס: 0, חצי: 0.5, אחת: 1, אחד: 1, שתיים: 2, שתים: 2, שניים: 2, שתי: 2, שני: 2, שלוש: 3, שלושה: 3,
  ארבע: 4, ארבעה: 4, חמש: 5, חמישה: 5, שש: 6, שישה: 6, שבע: 7, שבעה: 7, שמונה: 8, תשע: 9, תשעה: 9,
  עשר: 10, עשרה: 10, עשרים: 20, שלושים: 30, ארבעים: 40, חמישים: 50, שישים: 60, שבעים: 70, שמונים: 80,
  תשעים: 90, מאה: 100, מאתיים: 200, אלף: 1000, אלפיים: 2000,
};
function spokenNumber(t) {
  const words = String(t || "").replace(/[.,!?״"]/g, " ").split(/[\s-]+/).filter(Boolean);
  let sum = null, sawWord = false, joined = false;
  for (const raw of words) {
    const w = raw !== "ו" && raw.startsWith("ו") ? raw.slice(1) : raw;
    if (raw === "ו") { if (sum !== null) joined = true; continue; }
    if (w === "מאות" && sum !== null) { sum = sum * 100; continue; }   // "שלוש מאות"
    const v = /^\d+(\.\d+)?$/.test(w) ? Number(w) : WORD_NUM[w];
    if (v === undefined) { if (sum !== null) break; continue; }
    if (!/^\d/.test(w)) sawWord = true;
    if (raw !== w && sum !== null) joined = true;
    sum = (sum || 0) + v;
  }
  // Plain digits without words or "ו" keep the old first-number reading ("2 מתוך 6" is 2).
  return sum !== null && (sawWord || joined) ? sum : null;
}
const num = (t) => { const s = spokenNumber(t); if (s !== null) return s; const n = firstNumber(t); return Number.isFinite(n) ? n : null; };
const int = (t) => { const n = num(t); return n === null ? null : Math.round(n); };
const text = (max) => (t) => { const s = String(t || "").trim(); return s ? s.slice(0, max) : null; };

function parsePrice(t) {
  // Currency marks carry no number: "2,350,000 ש״ח", "₪2.35M".
  const s = String(t || "").replace(/₪|ש["״']ח|שקלים|שקל|nis/gi, " ");
  // "2 מיליון ו-350 (אלף)" → 2,350,000. "מליון" (no yod) is how most people type it.
  const both = /(\d+(?:\.\d+)?)\s*(?:מיליון|מליון|מיל['׳]?|מ['׳])\s*ו-?\s*(\d+)/.exec(s);
  if (both) return Math.round(Number(both[1]) * 1e6 + Number(both[2]) * 1e3);
  const m = /(\d+(?:[.,]\d+)*)\s*(מיליון|מליון|מיל['׳]?|מ['׳]|m|אלף|אלפים|k)?/i.exec(s);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = (m[2] || "").toLowerCase();
  if (/^(מיליון|מליון|מיל['׳]?|מ['׳]|m)$/.test(mult)) n *= 1e6;
  else if (/^(אלף|אלפים|k)$/.test(mult)) n *= 1e3;
  // "2.9" or "3" alone is a shorthand we cannot read (millions? thousands?);
  // storing it as ₪3 is worse than asking again with the format hint.
  return n >= 1000 ? Math.round(n) : null;
}
function parseDeal(t) {
  const s = String(t || "");
  if (/להשכרה|השכרה|שכירות/.test(s)) return "rent";
  if (/למכירה|מכירה/.test(s)) return "sale";
  return null;
}
function parseTemplate(t) {
  const s = clean(t).toLowerCase();
  const n = /^([1-6])(?:\D|$)/.exec(s);
  if (n) return TEMPLATE_KEYS[Number(n[1]) - 1];
  return TEMPLATE_KEYS.find((k) => TEMPLATES[k].includes(s)) || null;
}
// A sale under ₪20,000 or a rent over ₪100,000 is almost always the wrong deal type or a typo.
function priceLooksOff(f) {
  if (!f.price || !f.deal) return false;
  return (f.deal === "sale" && f.price < 20000) || (f.deal === "rent" && f.price > 100000);
}
const ORDINAL_FLOOR = { ראשונה: 1, ראשון: 1, שנייה: 2, שניה: 2, שלישית: 3, רביעית: 4, חמישית: 5, שישית: 6, שביעית: 7, שמינית: 8, תשיעית: 9, עשירית: 10 };
function parseFloor(t) {
  const s = String(t || "");
  if (/קרקע/.test(s)) return 0;
  const ord = Object.keys(ORDINAL_FLOOR).find((w) => new RegExp(`(^|\\s)${w}($|[\\s.,!?])`).test(s));
  return ord ? ORDINAL_FLOOR[ord] : int(t);
}
function parseParking(t) { return /^(אין|ללא|לא)$/.test(clean(t)) ? 0 : int(t); }

// Spoken answers keep the preposition: "בכפר סבא", "בתל אביב". Drop a leading ב unless
// the city's own name starts with it.
const B_CITIES = ["באר שבע", "באר יעקב", "בני ברק", "בת ים", "בית שמש", "בית שאן", "ביתר עילית", "בית דגן", "בנימינה", "בית ג'ן", "בועיינה", "בסמת טבעון", "באקה אל-גרבייה"];
function parseCity(t) {
  const s = text(60)(t);
  if (!s || !s.startsWith("ב") || B_CITIES.some((c) => s.startsWith(c))) return s;
  return s.slice(1).trim() || s;
}

const PARSERS = {
  city: parseCity, price: parsePrice, rooms: num, deal: parseDeal, size_sqm: num,
  floor: parseFloor, parking: parseParking, neighborhood: text(60), description: text(2000), template: parseTemplate,
};
// An impossible value is a mishearing or typo ("ועשר מטר" → 10 m²): ask again instead.
const RANGES = { rooms: [1, 20], size_sqm: [15, 2000], floor: [-3, 100], parking: [0, 20] };
function parseAnswer(field, t) {
  const v = PARSERS[field] ? PARSERS[field](t) : null;
  const r = RANGES[field];
  return v !== null && r && (v < r[0] || v > r[1]) ? null : v;
}
function isRequired(field) { return REQUIRED.includes(field); }

// ── draft state ──
function emptyFields() {
  const f = {};
  for (const k of Object.keys(SCHEMA)) f[k] = null;
  f.description = null;
  f.template = null;
  return f;
}

function newDraft(phone, source, now = new Date()) {
  return {
    phone, status: "active", source, fields: emptyFields(), skipped: [], photos: [],
    pending_opener: null, offer_sent: false, listing_id: null, mode: null, created_at: now, updated_at: now,
  };
}

// ₪2,900,000 a month is not a rental and ₪8,500 is not a sale price, so asking
// "למכירה או להשכרה?" after such a price is noise. Thresholds match
// priceLooksOff, which already calls the opposite pairing a typo. A bare "2.9"
// (someone who meant 2.9 million) is below any real rent, so it infers nothing.
function inferDeal(f) {
  if (f.deal !== null || !f.price) return null;
  if (f.price > 100000) return "sale";
  if (f.price >= 1000 && f.price < 20000) return "rent";
  return null;
}

// Every path that saves a draft calls touch, so the inference lands whether the
// price arrived as an answer, an extraction, or a /מחיר correction.
function touch(draft, now = new Date()) {
  const deal = inferDeal(draft.fields);
  if (deal) draft.fields.deal = deal;
  draft.updated_at = now;
  return draft;
}

function nextStep(draft) {
  for (const f of ASK_ORDER) {
    if (draft.fields[f] === null && !draft.skipped.includes(f)) return { kind: "ask", field: f };
  }
  if (draft.photos.length < MIN_PHOTOS) return { kind: "photos" };
  // Preview → the review link, where the design is picked on the page.
  // Create → the design is asked here and the page is built from chat.
  if (!draft.mode) return { kind: "choose" };
  if (draft.mode !== "create") return { kind: "confirm" };
  if (draft.fields.template === null && !draft.skipped.includes("template")) return { kind: "ask", field: "template" };
  return { kind: "create" };
}

// Draft → the body create.html posts to /properties/create.
function listingBody(draft) {
  const f = draft.fields;
  return {
    listing_type: f.deal === "rent" ? "rent" : "sale",
    address: f.address, city: f.city, neighborhood: f.neighborhood,
    price: f.price, rooms: f.rooms, size_sqm: f.size_sqm,
    size_built: f.sqm_built, size_balcony: f.sqm_balcony, size_garden: f.sqm_garden,
    floor: f.floor, parking: f.parking,
    storage: f.storage, elevator: f.elevator, shabbat_elevator: f.shabbat_elevator,
    description: f.description, photos_urls: draft.photos,
    // The agent's own video replaces the generated walkthrough (createListing → page pipeline).
    own_video_url: draft.video_url || null,
    theme: f.template ? { template: f.template } : null, language: "he",
  };
}

const silentFor = (draft, now) => now.getTime() - asMillis(draft.updated_at);
function isPaused(draft, now = new Date()) { return draft.status === "active" && silentFor(draft, now) > PAUSE_MS; }
function isExpiredPrompt(draft, now = new Date()) {
  return (draft.status === "offered" || draft.status === "resume_prompt") && silentFor(draft, now) > PAUSE_MS;
}

function summary(draft) {
  const f = draft.fields;
  return {
    city: f.city, neighborhood: f.neighborhood, price: f.price, rooms: f.rooms, deal: f.deal,
    size_sqm: f.size_sqm, floor: f.floor, parking: f.parking, photos: draft.photos.length,
  };
}

module.exports = {
  REQUIRED, OPTIONAL, ASK_ORDER, PAUSE_MS, MIN_PHOTOS, SCHEMA, TEMPLATES, TEMPLATE_KEYS,
  findUrl, command, spokenCommand, CANONICAL, openerKind, parseAnswer, isRequired, asMillis,
  newDraft, touch, nextStep, isPaused, isExpiredPrompt, summary, listingBody, priceLooksOff, clean,
};
