/*
 * property-draft.js — pure helpers behind the WhatsApp property chat.
 *
 * No I/O. Everything the turn handler (whatsapp-intake.js) needs to decide
 * "is this message ours", "what do we ask next" and "what did the agent
 * answer" lives here so it can be unit-tested without Express or Firestore.
 */
const { SCHEMA } = require("./listing-extract");
const { MIN_PHOTOS } = require("./listing-create");
const { asMillis } = require("./utils");

const REQUIRED = ["city", "price", "rooms"];
const OPTIONAL = ["deal", "size_sqm", "floor", "parking", "neighborhood", "description"];
const ASK_ORDER = [...REQUIRED, ...OPTIONAL];
const PAUSE_MS = 2 * 60 * 60 * 1000;

const KEYWORDS = ["נכס חדש", "דף נכס", "דף חדש"];
const LISTING_HINTS = ["חדרים", "חד׳", "חד'", "מ״ר", "מ\"ר", "קומה", "למכירה", "להשכרה", "₪", "מחיר", "שכירות"];
const COMMANDS = { "ביטול": "cancel", "דלג": "skip", "ממשיכים": "continue", "כן": "yes", "לא": "no", "המשך": "resume", "חדש": "new" };

// First http(s) link in a chat message; trailing punctuation is not part of it.
const URL_RE = /https?:\/\/[^\s<>"']+/i;
function findUrl(text) {
  const m = URL_RE.exec(String(text || ""));
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?)\]]+$/, "");
  try { return new URL(url).href; } catch (e) { return null; }
}

const clean = (t) => String(t || "").trim().replace(/[!.?]+$/, "").trim();
function command(text) { return COMMANDS[clean(text)] || null; }
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
  const m = /(\d+(?:[.,]\d+)*)\s*(מיליון|מ'|m|אלף|k)?/i.exec(String(t || ""));
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = (m[2] || "").toLowerCase();
  if (/^(מיליון|מ'|m)$/.test(mult)) n *= 1e6;
  else if (/^(אלף|k)$/.test(mult)) n *= 1e3;
  return n > 0 ? Math.round(n) : null;
}
function parseDeal(t) {
  const s = String(t || "");
  if (/להשכרה|השכרה|שכירות/.test(s)) return "rent";
  if (/למכירה|מכירה/.test(s)) return "sale";
  return null;
}
function parseFloor(t) { return /קרקע/.test(String(t || "")) ? 0 : int(t); }
function parseParking(t) { return /^(אין|ללא|לא)$/.test(clean(t)) ? 0 : int(t); }

const PARSERS = {
  city: text(60), price: parsePrice, rooms: num, deal: parseDeal, size_sqm: num,
  floor: parseFloor, parking: parseParking, neighborhood: text(60), description: text(2000),
};
function parseAnswer(field, t) { return PARSERS[field] ? PARSERS[field](t) : null; }
function isRequired(field) { return REQUIRED.includes(field); }

module.exports = {
  REQUIRED, OPTIONAL, ASK_ORDER, PAUSE_MS, MIN_PHOTOS, SCHEMA,
  findUrl, command, openerKind, parseAnswer, isRequired, asMillis,
};
