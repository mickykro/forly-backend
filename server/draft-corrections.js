/*
 * draft-corrections.js — changing answers after the fact, and answers that
 * carry more than the one field that was asked.
 *
 *   /מחיר 2.1 מיליון   /p 2.1m   → set one field (Hebrew label or letter code)
 *   /                           → list current values and codes
 *   "רגע, המחיר 2.1 מיליון"     → talks about another field: extract, then
 *                                  fill empty fields / confirm replacements
 * Pure: no I/O. The turn handler (whatsapp-intake.js) does the extraction call.
 */
const D = require("./property-draft");

// Letter code and every Hebrew way to name the field after "/".
const FIELDS = {
  city: ["c", "עיר"], price: ["p", "מחיר"], rooms: ["r", "חדרים", "מספר חדרים"],
  deal: ["d", "עסקה", "סוג עסקה"], size_sqm: ["s", "שטח", "מ״ר", "מ\"ר", "גודל"], floor: ["f", "קומה"],
  parking: ["k", "חניה", "חניות"], neighborhood: ["n", "שכונה"], description: ["t", "תיאור"],
  template: ["x", "עיצוב", "תבנית"],
};
const NAME_TO_FIELD = {};
for (const [f, names] of Object.entries(FIELDS)) for (const n of names) NAME_TO_FIELD[n] = f;

/*
 * "/<name> <value>" → { field, value } · "/" alone → { list: true }
 * unknown name → { unknown: name } · not a slash command → null
 */
function parseSlash(text) {
  const s = String(text || "").trim();
  if (!s.startsWith("/")) return null;
  const rest = s.slice(1).trim();
  if (!rest) return { list: true };
  // Longest name first so "סוג עסקה" is matched whole, not as "סוג".
  const lower = rest.toLowerCase();
  const names = Object.keys(NAME_TO_FIELD).sort((a, b) => b.length - a.length);
  const name = names.find((n) => lower === n || lower.startsWith(n + " "));
  if (!name) return { unknown: rest.split(/\s+/)[0] };
  return { field: NAME_TO_FIELD[name], value: rest.slice(name.length).trim() };
}

// Words that say which field a free-text reply is about.
const HINTS = {
  price: ["מחיר", "מיליון", "מליון", "אלף", "₪", "ש״ח", "ש\"ח", "שקל"],
  rooms: ["חדרים", "חד׳", "חד'"], size_sqm: ["מ״ר", "מ\"ר", "מטר"], floor: ["קומה"],
  parking: ["חניה", "חניות"], deal: ["למכירה", "להשכרה", "שכירות"], neighborhood: ["שכונת", "שכונה"],
};
function hintedFields(text) {
  const s = String(text || "");
  return Object.keys(HINTS).filter((f) => HINTS[f].some((h) => s.includes(h)));
}

/*
 * Should this reply to `asked` go through the extractor instead of the field's
 * own parser? Yes when it names two fields, or names a field other than the
 * one asked. Descriptions are free text and legitimately mention anything.
 */
function needsExtraction(asked, text) {
  if (asked === "description" || asked === "template") return false;
  const f = hintedFields(text);
  if (!asked) return f.length >= 1; // no question open (photos / choose / review): any field talk is a correction
  return f.length >= 2 || (f.length === 1 && f[0] !== asked);
}

const MERGEABLE = ["city", "neighborhood", "deal", "price", "rooms", "size_sqm", "floor", "parking"];

/*
 * Fold extracted fields into the draft. Empty (or skipped) fields are filled
 * now; a different existing value is only proposed. → { filled, proposed }
 */
function merge(draft, extracted) {
  const filled = {}, proposed = {};
  for (const f of MERGEABLE) {
    const v = extracted[f];
    if (v === null || v === undefined) continue;
    const cur = draft.fields[f];
    if (cur === null) {
      draft.fields[f] = v;
      draft.skipped = draft.skipped.filter((x) => x !== f);
      filled[f] = v;
    } else if (cur !== v) proposed[f] = v;
  }
  return { filled, proposed };
}

// Apply confirmed replacements.
function apply(draft, changes) {
  for (const [f, v] of Object.entries(changes || {})) {
    draft.fields[f] = v;
    draft.skipped = draft.skipped.filter((x) => x !== f);
  }
}

// One field from a slash command. → true when set, false when the value didn't parse.
function setField(draft, field, value) {
  const v = D.parseAnswer(field, value);
  if (v === null) return false;
  draft.fields[field] = v;
  draft.skipped = draft.skipped.filter((x) => x !== field);
  return true;
}

module.exports = { FIELDS, parseSlash, hintedFields, needsExtraction, merge, apply, setField };
