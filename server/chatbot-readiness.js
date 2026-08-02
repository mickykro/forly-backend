/*
 * chatbot-readiness.js — how much would the bot actually know about a page?
 *
 * The chat bot answers strictly from the facts on the page (plus the listing's
 * free-text description) and hands off the moment it is asked something it has
 * no data for. On a thin page that happens on the first question, which reads
 * as a broken bot rather than a warm lead.
 *
 * Landing pages built before the area/carousel/tags work carry far less than
 * today's do, so before switching the bot on for a back catalogue it is worth
 * seeing what it would have to work with. This scores a page from data alone —
 * no network, no model call — so the report is free to run and safe to re-run.
 *
 * Pure functions, unit-tested in chatbot-readiness.test.js.
 */

// Property fields the bot can answer a direct question from. Numbers only
// count when > 0: createPropertyPage coerces missing values with `Number(x) || 0`,
// so a stored 0 means "not captured" far more often than it means "ground floor".
const NUMERIC_SPECS = [
  "rooms", "size_sqm", "floor", "price", "parking",
  "size_built", "size_balcony", "size_garden",
];
const TEXT_SPECS = ["address", "neighborhood", "city", "listing_type"];
// Booleans are facts in both directions — "is there an elevator?" is answerable
// by `false` just as well as by `true` — so presence is what counts.
const BOOL_SPECS = ["storage", "elevator", "shabbat_elevator"];

// A description is the single richest source of answerable detail, so the
// thresholds are set on it first and the structured fields second.
const DESC_RICH = 200;
const DESC_MIN = 80;

function countSpecs(property) {
  const p = property || {};
  let n = 0;
  for (const k of NUMERIC_SPECS) if (Number(p[k]) > 0) n++;
  for (const k of TEXT_SPECS) if (String(p[k] || "").trim()) n++;
  for (const k of BOOL_SPECS) if (typeof p[k] === "boolean") n++;
  return n;
}

function countAreaFacts(area) {
  const a = area || {};
  return (String(a.blurb || "").trim() ? 1 : 0) +
    (Array.isArray(a.stops) ? a.stops.length : 0) +
    (Array.isArray(a.stats) ? a.stats.length : 0);
}

/*
 * Score one page. `listing` may be null when the listing was deleted or the
 * page predates the link — that is itself a finding, not an error.
 *
 * Returns { verdict, signals, gaps } where verdict is:
 *   rich — the bot has plenty to answer from
 *   ok   — it can hold a conversation but will hand off sooner
 *   thin — it would hand off on nearly the first question
 */
function scorePage(page, listing) {
  const p = page || {};
  const descChars = String((listing && listing.description) || "").trim().length;
  const specs = countSpecs(p.property);
  const slides = (p.carousel && Array.isArray(p.carousel.slides)) ? p.carousel.slides.length : 0;
  const areaFacts = countAreaFacts(p.area);
  const captions = (p.gallery && Array.isArray(p.gallery.images))
    ? p.gallery.images.filter((i) => String((i && i.caption) || "").trim()).length
    : 0;

  const gaps = [];
  if (!listing) gaps.push("no_listing");
  else if (!descChars) gaps.push("no_description");
  else if (descChars < DESC_MIN) gaps.push("short_description");
  if (specs < 4) gaps.push("few_specs");
  if (!slides) gaps.push("no_carousel");
  if (!areaFacts) gaps.push("no_area");

  const signals = {
    description_chars: descChars,
    spec_fields: specs,
    carousel_slides: slides,
    area_facts: areaFacts,
    gallery_captions: captions,
  };

  let verdict;
  if (descChars < DESC_MIN && specs < 4) verdict = "thin";
  else if (descChars >= DESC_RICH && specs >= 6 && (slides >= 3 || areaFacts >= 2)) verdict = "rich";
  else verdict = "ok";

  return { verdict, signals, gaps };
}

/** Roll a list of per-page reports into counts for the summary line. */
function summarize(reports) {
  const out = { total: reports.length, rich: 0, ok: 0, thin: 0, enabled: 0, gaps: {} };
  for (const r of reports) {
    out[r.verdict] = (out[r.verdict] || 0) + 1;
    if (r.chatbot_enabled) out.enabled++;
    for (const g of r.gaps) out.gaps[g] = (out.gaps[g] || 0) + 1;
  }
  return out;
}

module.exports = {
  DESC_RICH, DESC_MIN,
  countSpecs, countAreaFacts, scorePage, summarize,
};
