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
const OPTIONAL = ["deal", "size_sqm", "floor", "parking", "neighborhood", "description", "template"];
const ASK_ORDER = [...REQUIRED, ...OPTIONAL];
// create.html won't build a page from fewer than 4, stricter than the API's 3.
const MIN_PHOTOS = 4;
const PAUSE_MS = 2 * 60 * 60 * 1000;

const KEYWORDS = ["נכס חדש", "דף נכס", "דף חדש", "דף נכס חדש", "ליצור נכס", "צור נכס", "ליצור דף נכס"];
const LISTING_HINTS = ["חדרים", "חד׳", "חד'", "מ״ר", "מ\"ר", "קומה", "למכירה", "להשכרה", "₪", "מחיר", "שכירות"];
const COMMANDS = { "ביטול": "cancel", "דלג": "skip", "ממשיכים": "continue", "כן": "yes", "לא": "no", "המשך": "resume", "חדש": "new" };
// Natural phrasings for the buttons above; button taps always send the exact
// COMMANDS word, these cover what a person types instead of tapping.
const COMMAND_ALIASES = { "להמשיך": "resume", "להמשיך אותה": "resume", "תמשיך": "resume", "נמשיך": "resume" };

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

const clean = (t) => String(t || "").trim().replace(/[!.?]+$/, "").trim();
function command(text) { const c = clean(text); return COMMANDS[c] || COMMAND_ALIASES[c] || null; }
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
const num = (t) => { const n = firstNumber(t); return Number.isFinite(n) ? n : null; };
const int = (t) => { const n = num(t); return n === null ? null : Math.round(n); };
const text = (max) => (t) => { const s = String(t || "").trim(); return s ? s.slice(0, max) : null; };

function parsePrice(t) {
  // "מליון" (no yod) is how most people actually type it.
  const m = /(\d+(?:[.,]\d+)*)\s*(מיליון|מליון|מיל'|מ'|m|אלף|אלפים|k)?/i.exec(String(t || ""));
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = (m[2] || "").toLowerCase();
  if (/^(מיליון|מליון|מיל'|מ'|m)$/.test(mult)) n *= 1e6;
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
function parseFloor(t) { return /קרקע/.test(String(t || "")) ? 0 : int(t); }
function parseParking(t) { return /^(אין|ללא|לא)$/.test(clean(t)) ? 0 : int(t); }

const PARSERS = {
  city: text(60), price: parsePrice, rooms: num, deal: parseDeal, size_sqm: num,
  floor: parseFloor, parking: parseParking, neighborhood: text(60), description: text(2000), template: parseTemplate,
};
function parseAnswer(field, t) { return PARSERS[field] ? PARSERS[field](t) : null; }
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
    pending_opener: null, offer_sent: false, listing_id: null, created_at: now, updated_at: now,
  };
}

function touch(draft, now = new Date()) { draft.updated_at = now; return draft; }

function nextStep(draft) {
  for (const f of ASK_ORDER) {
    if (draft.fields[f] === null && !draft.skipped.includes(f)) return { kind: "ask", field: f };
  }
  if (draft.photos.length < MIN_PHOTOS) return { kind: "photos" };
  return { kind: "confirm" };
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
  findUrl, command, openerKind, parseAnswer, isRequired, asMillis,
  newDraft, touch, nextStep, isPaused, isExpiredPrompt, summary,
};
