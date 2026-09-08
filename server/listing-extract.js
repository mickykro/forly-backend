/*
 * listing-extract.js — turns pasted listing text into the wizard's fields.
 *
 * One LLM call through chat-provider.ask(). The model only extracts; the
 * server decides what is still missing (REQUIRED). Absent means null, never
 * a guess, and every value is coerced to the type the form input expects so
 * nothing the model invents can reach the page.
 */
const { ask } = require("./chat-provider");

const MODEL = process.env.PROPERTY_PARSE_MODEL || "claude-haiku-4-5-20251001";
const MAX_INPUT = 4000;

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
  price: num, rooms: num, size_sqm: num, sqm_built: num, sqm_balcony: num, sqm_garden: num,
  floor: int, parking: int, elevator: bool, shabbat_elevator: bool, storage: bool,
};
const REQUIRED = ["address", "city", "price", "rooms", "size_sqm", "floor", "deal", "parking", "neighborhood"];

const SYSTEM = `You extract real-estate listing facts from text written in Hebrew or English.
Return ONLY a JSON object with exactly these keys: ${Object.keys(SCHEMA).join(", ")}.
Rules:
- Use only what the text states explicitly. If a value is not stated, use null. Never guess.
- Numbers as JSON numbers, never strings. price in ILS: "2.9M" or "2.9 מיליון" → 2900000, "890 אלף" → 890000, "12,000 לחודש" → 12000.
- deal: "rent" if the text is about renting (להשכרה, שכירות, לחודש), "sale" if about buying (למכירה), else null.
- rooms may be fractional (3.5). floor is the apartment's floor, not the building height. parking is the number of spots (חניה = 1).
- elevator, shabbat_elevator, storage: true only if mentioned, otherwise null.
- address is street and number only; city and neighborhood go in their own keys.
No prose, no markdown fences.`;

function unavailable(msg) { const e = new Error(msg); e.code = "extract_unavailable"; return e; }

function coerce(raw) {
  const fields = {};
  for (const [k, fn] of Object.entries(SCHEMA)) fields[k] = raw && k in raw ? fn(raw[k]) : null;
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
  const input = String(text || "").slice(0, MAX_INPUT);
  let reply;
  try { reply = await askFn(model, SYSTEM, [{ role: "user", content: input }], keys); }
  catch (err) { throw unavailable(err.message); }
  const fields = parseReply(reply && reply.text);
  return { fields, missing: missingOf(fields) };
}

module.exports = { parseListing, REQUIRED, MAX_INPUT, SCHEMA, _test: { coerce, missingOf, parseReply, SYSTEM } };
