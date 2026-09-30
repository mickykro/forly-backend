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
const R = require("./whatsapp-replies");

// Letter code and every Hebrew way to name the field after "/".
const FIELDS = {
  city: ["c", "עיר"], price: ["p", "מחיר"], rooms: ["r", "חדרים", "מספר חדרים"],
  deal: ["d", "עסקה", "סוג עסקה"], size_sqm: ["s", "שטח", "מ״ר", "מ\"ר", "גודל"], floor: ["f", "קומה"],
  parking: ["k", "חניה", "חניות"], neighborhood: ["n", "שכונה"], description: ["t", "תיאור"],
  template: ["x", "עיצוב", "תבנית"], currency: ["u", "מטבע"],
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
  price: ["מחיר", "מיליון", "מליון", "אלף", "₪", "ש״ח", "ש\"ח", "שקל", "מטבע", "€", "יורו", "אירו", "$", "דולר"],
  rooms: ["חדרים", "חד׳", "חד'"], size_sqm: ["מ״ר", "מ\"ר", "מטר"], floor: ["קומה"],
  parking: ["חניה", "חניות"], deal: ["למכירה", "להשכרה", "שכירות"], neighborhood: ["שכונת", "שכונה"],
  address: ["כתובת", "רחוב"], city: ["עיר"],
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
  // "נחל דליות 35 באר שבע" to "which city?": a street came along, split it out.
  if (asked === "city" && /\d/.test(text)) return true;
  const f = hintedFields(text);
  if (!asked) return f.length >= 1; // no question open (photos / choose / review): any field talk is a correction
  return f.length >= 2 || (f.length === 1 && f[0] !== asked);
}

const MERGEABLE = ["city", "address", "neighborhood", "deal", "price", "currency", "rooms", "size_sqm", "floor", "parking"];

/*
 * Fold extracted fields into the draft. Empty (or skipped) fields are filled
 * now; a different existing value is only proposed. → { filled, proposed }
 */
function merge(draft, extracted) {
  const filled = {}, proposed = {};
  for (const f of MERGEABLE) {
    const v = f === "city" && extracted[f] ? D.knownCity(extracted[f]) : extracted[f];
    if (v === null || v === undefined) continue;
    const cur = draft.fields[f] ?? null; // drafts saved before a field existed lack the key
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
  if (field === "price") D.noteCurrency(draft, value);
  draft.skipped = draft.skipped.filter((x) => x !== field);
  return true;
}

// ── answers that correct or fill other fields (from whatsapp-intake.js; promptFor is its next-question) ──
// The price warning goes in front of the next question when price and deal disagree.
function withPriceCheck(draft, replies) {
  return D.priceLooksOff(draft.fields) ? [R.priceOff(draft.fields), ...replies] : replies;
}

// "/מחיר 2.1 מיליון", "/p 2.1m", or "/" alone for the list.
function slashTurn(draft, slash, deps, now, promptFor) {
  if (slash.list) return { handled: true, status: "field_list", replies: [R.fieldList(draft.fields)] };
  if (slash.unknown) return { handled: true, status: "field_unknown", replies: [R.unknownField(slash.unknown)] };
  if (!setField(draft, slash.field, slash.value)) {
    return { handled: true, status: `invalid:${slash.field}`, replies: [R.invalid(slash.field)] };
  }
  const p = promptFor(draft, deps);
  const replies = withPriceCheck(draft, [R.updated({ [slash.field]: draft.fields[slash.field] }, draft.fields.currency), ...p.replies]);
  return { handled: true, status: `corrected:${slash.field}`, draft: D.touch(draft, now), replies: [R.oneBubble(replies)] };
}

// A reply that talks about other fields ("רגע, המחיר 2.1 מיליון", "חיפה, 3 חדרים, 1.9 מיליון"):
// extract it like listing text, fill empty fields, and ask before replacing any.
// null → nothing usable came out; the caller handles the text the ordinary way.
async function smartAnswer(draft, text, deps, now, asked, promptFor) {
  // A bare place name means nothing to the extractor; "שכונה: הבורסה, …" does. Numeric
  // questions get no label: "חניות: רגע, המחיר…" makes it invent a parking count.
  // A city answer with a street number is an address line: unlabelled, so it splits.
  const label = (asked === "city" && !/\d/.test(text)) || asked === "neighborhood";
  const prompt = label ? `${R.LABELS[asked]}: ${text}` : text;
  let parsed;
  try { parsed = await deps.parseListing(prompt); } catch (err) { return null; }
  const { filled, proposed } = merge(draft, parsed.fields || {});
  if (D.openerKind(text) === "text" && draft.fields.description === null) draft.fields.description = D.parseAnswer("description", text);
  if (!Object.keys(filled).length && !Object.keys(proposed).length) return null;
  const replies = Object.keys(filled).length ? [R.updated(filled, draft.fields.currency)] : [];
  if (Object.keys(proposed).length) {
    draft.pending_changes = proposed;
    replies.push(R.confirmChanges(proposed, draft.fields));
    return { handled: true, status: "confirm_changes", draft: D.touch(draft, now), replies: [R.oneBubble(replies)] };
  }
  const p = promptFor(draft, deps);
  return { handled: true, status: p.status, draft: D.touch(draft, now), replies: [R.oneBubble(withPriceCheck(draft, [...replies, ...p.replies]))] };
}

module.exports = { FIELDS, parseSlash, hintedFields, needsExtraction, merge, apply, setField, smartAnswer, slashTurn, withPriceCheck };
