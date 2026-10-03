/*
 * listing-extract.js — turns pasted listing text into the wizard's fields.
 *
 * One LLM call through chat-provider.ask(). The model only extracts; the
 * server decides what is still missing (REQUIRED). Absent means null, never
 * a guess, and every value is coerced to the type the form input expects so
 * nothing the model invents can reach the page.
 */
const { ask } = require("./chat-provider");
const { detectCurrency, normalizeCurrency } = require("./currency");

const MODEL = process.env.PROPERTY_PARSE_MODEL || "claude-haiku-4-5-20251001";
const MAX_INPUT = 8000;

// Scraped markdown is mostly URLs — a listing gallery's signed image links run
// 200+ chars each and would eat the whole budget before the "label:value" facts
// further down the page ever reach the model. Photos are collected separately
// in listing-sources.js, so none of this is lost.
function condense(text) {
  return String(text || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")       // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")    // links → their label
    .replace(/<[^>\s]+>/g, "")                  // bare autolinks / stray tags
    .replace(/^[ \t]*[-*|>#]+[ \t]*$/gm, "")    // rules and empty table rows
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Coercers: unusable → null.
const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[,\s₪]/g, "");
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
};
const int = (v) => { const n = num(v); return n === null ? null : Math.round(n); };
const str = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 180) : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
const deal = (v) => (v === "sale" || v === "rent" ? v : null);

const SCHEMA = {
  address: str, city: str, neighborhood: str, deal,
  price: num, currency: normalizeCurrency, rooms: num, size_sqm: num, sqm_built: num, sqm_balcony: num, sqm_garden: num, sqm_plot: num,
  floor: int, parking: int, elevator: bool, shabbat_elevator: bool, storage: bool,
};
// Scraped listing pages rarely disclose the exact street address (privacy) —
// city, price and rooms are what actually block a page from being built.
const REQUIRED = ["city", "price", "rooms", "size_sqm", "floor", "deal", "parking", "neighborhood"];

const SYSTEM = `You extract real-estate listing facts from text written in Hebrew or English.
The text may be free-form prose, or a scraped listing page with short "label:value" lines
(e.g. "מחיר:2,200,000 ₪", "סוג עסקה:מכירה", "שטח:70 מ״ר", "מ״ר בנוי:70", "קומה:2", "חדרים:4").
Return ONLY a JSON object with exactly these keys: ${Object.keys(SCHEMA).join(", ")}.
Rules:
- Use only what the text states explicitly. If a value is not stated, use null. Never guess.
- Numbers as JSON numbers, never strings. price is the number exactly as stated, in whatever currency it was stated in — never converted: "2.9M" or "2.9 מיליון" → 2900000, "890 אלף" → 890000, "12,000 לחודש" → 12000, "285,000 אירו" → 285000.
- currency is the price's currency: "ILS" (₪, ש״ח, שקל), "EUR" (€, יורו, אירו) or "USD" ($, דולר) — only when the text names it, else null.
- deal: "rent" if the text is about renting (להשכרה, שכירות, לחודש), "sale" if about buying or selling (למכירה, מכירה, סוג עסקה: מכירה), else null.
- size_sqm is the total/main area, from labels like "שטח", "מ״ר", or a bare "70 מ״ר" — "מ״ר בנוי" (built area) goes in sqm_built instead when both are given.
- sqm_plot is the land/plot the property stands on ("מגרש", "שטח מגרש", "plot", "lot", "דונם" = 1000). A plot is never size_sqm: "100 מ״ר בנוי על מגרש של 400 מ״ר" → size_sqm 100, sqm_built 100, sqm_plot 400.
- rooms may be fractional (3.5). rooms (חדרים) is the Israeli room count, which includes the living room: "N חדרי שינה" (bedrooms) is NOT rooms — when only bedrooms are given, leave rooms null. floor is the apartment's floor, not the building height. parking is the number of spots (חניה = 1, "ללא" = 0).
- elevator, shabbat_elevator, storage: true only if mentioned, otherwise null.
- address is street and number only, when actually given; most scraped listings omit it — leave it null rather than using the city or neighborhood.
No prose, no markdown fences.`;

function unavailable(msg) { const e = new Error(msg); e.code = "extract_unavailable"; return e; }

function coerce(raw) {
  const fields = {};
  for (const [k, fn] of Object.entries(SCHEMA)) fields[k] = raw && k in raw ? fn(raw[k]) : null;
  // create.html rejects a breakdown that doesn't add up to the total, so never hand it one.
  const parts = ["sqm_built", "sqm_balcony", "sqm_garden"];
  if (parts.some((k) => fields[k] !== null)) {
    const sum = parts.reduce((t, k) => t + (fields[k] || 0), 0);
    if (fields.size_sqm === null) fields.size_sqm = sum;
    else if (sum !== fields.size_sqm) for (const k of parts) fields[k] = null;
  }
  return fields;
}

function missingOf(fields) { return REQUIRED.filter((k) => fields[k] === null); }

function parseReply(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw unavailable("no json in reply");
  let raw;
  try { raw = JSON.parse(m[0]); } catch (e) { throw unavailable("bad json in reply"); }
  return coerce(raw);
}

async function parseListing(text, { askFn = ask, model = MODEL, keys = process.env } = {}) {
  const input = condense(text).slice(0, MAX_INPUT);
  let reply;
  // schema: null — chat-provider defaults to the chat bot's response schema,
  // which would force the reply into {answered, reply, ...} and yield an object
  // with none of our keys (i.e. every field null).
  try { reply = await askFn(model, SYSTEM, [{ role: "user", content: input }], keys, { schema: null, maxOut: 700 }); }
  catch (err) { throw unavailable(err.message); }
  const fields = parseReply(reply && reply.text);
  // The currency named in the text wins over the model's: "285,000 אירו" shown as ₪285,000
  // is a live page at about a quarter of its real price, so this doesn't rest on the prompt.
  fields.currency = detectCurrency(input) || fields.currency;
  return { fields, missing: missingOf(fields) };
}

module.exports = { parseListing, REQUIRED, MAX_INPUT, SCHEMA, _test: { coerce, missingOf, parseReply, condense, SYSTEM } };
