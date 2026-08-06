/*
 * tags.js — canonical property-tag vocabulary for the buyer portal.
 * Mirrors the frontend keyword derivation (forli-creator-website portal.ts /
 * FilterBar.astro) so stored and derived tags stay in one language.
 *
 * Tags are agent-curated in the creator; where absent (old pages), toCard
 * derives them from the property text so the portal filter chips still work.
 */

// tag value → display label, in portal display order. `value` is what's stored
// and matched; the label is what the creator chip shows.
const TAG_LABELS = [
  ["גן", "דירת גן"],
  ["פנטהאוז", "פנטהאוז"],
  ["מרפסת", "מרפסת"],
  ["חניה", "חניה"],
  ["ים", "נוף/קרבה לים"],
  ["דופלקס", "דופלקס"],
  ["בלעדיות", "בלעדיות"],
  ["משופצת", "משופצת"],
];
const TAGS = TAG_LABELS.map(([v]) => v);
const TAG_SET = new Set(TAGS);

// Keyword → tag, matched against title + neighborhood + description.
const KEYWORD_TAGS = [
  [/פנטהאוז|פנטהאוס|פנטהא/, "פנטהאוז"],
  [/דירת גן|גינה|גינת|גינ׳|צמוד(?:ת)? קרקע/, "גן"],
  [/מרפסת|מרפסות|מרפ׳|טרסה|balcony/i, "מרפסת"],
  [/נוף לים|ליד הים|קו ראשון|מול הים|נוף ים|קרבה לים|נוף פתוח לים/, "ים"],
  [/דופלקס|דו[ -]?מפלסי|duplex/i, "דופלקס"],
  [/בלעדיות|בלעדי(?:ת)?/, "בלעדיות"],
  [/משופצ|שופצ|לאחר שיפוץ|renovated/i, "משופצת"],
  [/חניה|חנייה|חניון|חנ׳|parking/i, "חניה"],
];

// prop = the page property; extraText carries the listing description (not
// stored on the page). Both are scanned so tags reflect the full listing.
function deriveTags(prop, extraText = "") {
  const p = prop || {};
  const text = `${p.title || ""} ${p.neighborhood || ""} ${p.description || ""} ${extraText || ""}`;
  const out = [];
  for (const [re, tag] of KEYWORD_TAGS) {
    if (re.test(text) && !out.includes(tag)) out.push(tag);
  }
  if (Number(p.parking) > 0 && !out.includes("חניה")) out.push("חניה");
  // Canonical order for stable chips regardless of match order.
  return TAGS.filter((t) => out.includes(t));
}

// Keep only known tags, de-duped, in canonical order. Used at every trust
// boundary (creator input, backfill, card payload).
function sanitizeTags(input) {
  if (!Array.isArray(input)) return [];
  const present = new Set(input.map((t) => String(t).trim()).filter((t) => TAG_SET.has(t)));
  return TAGS.filter((t) => present.has(t));
}

module.exports = { TAGS, TAG_LABELS, deriveTags, sanitizeTags };

// ponytail self-check: node server/tags.js
if (require.main === module) {
  const assert = require("assert");
  assert.deepStrictEqual(deriveTags({ title: "פנטהאוז מפואר", neighborhood: "" }), ["פנטהאוז"]);
  assert.deepStrictEqual(deriveTags({ title: "דירת גן", parking: 2 }, "משופצת עם מרפסת שמש"), ["גן", "מרפסת", "חניה", "משופצת"]);
  assert.deepStrictEqual(deriveTags({ title: "4 חד׳ בבבלי" }, "דירה עם מרפסת ונוף לים"), ["מרפסת", "ים"]);
  assert.deepStrictEqual(sanitizeTags(["חניה", "לא-קיים", "גן", "גן"]), ["גן", "חניה"]);
  assert.deepStrictEqual(sanitizeTags("nope"), []);
  console.log("tags.js ok");
}
