/*
 * chat-recommend.js — "other listings of this agent that fit the budget".
 *
 * Deterministic on purpose: the shortlist is computed here and handed to the
 * visitor as links and to the agent as text. The model is never asked to pick
 * or describe listings, so it cannot invent one. Pure; unit-tested in
 * chat-recommend.test.js.
 */
const { visiblePortfolioPages } = require("./portfolio");

const BAND_PCT = 15;          // ±15% of the budget
const MAX_MATCHES = 3;

const money = (n) => "₪" + Number(n).toLocaleString("en-US");

function matchByBudget(pages, opts) {
  const o = opts || {};
  const budget = Math.floor(Number(o.budget));
  if (!Array.isArray(pages) || !(budget > 0)) return [];
  const pct = Number.isFinite(o.bandPct) ? o.bandPct : BAND_PCT;
  const limit = Number.isFinite(o.limit) ? o.limit : MAX_MATCHES;
  const type = o.listingType || "sale";
  const base = String(o.baseUrl || "").replace(/\/+$/, "");
  // Integer comparison: budget * 0.85 is not exact in floating point and drops
  // a price sitting right on the edge for some budgets. Use ceil to include prices
  // at the boundary (e.g., 849999 is within ±15% of 999999).
  const bandWidth = Math.ceil(budget * pct / 100);
  const inBand = (price) => Math.abs(price - budget) <= bandWidth;

  return visiblePortfolioPages(pages)
    .filter((p) => p && p.page_id && p.page_id !== o.excludePageId && p.property)
    .filter((p) => (p.property.listing_type || "sale") === type)
    // 0 means "unknown" everywhere in the page schema, never a free listing.
    .filter((p) => Number(p.property.price) > 0)
    .filter((p) => inBand(Number(p.property.price)))
    .sort((a, b) => Math.abs(a.property.price - budget) - Math.abs(b.property.price - budget))
    .slice(0, limit)
    .map((p) => ({
      page_id: p.page_id,
      title: p.property.title || "",
      city: p.property.city || "",
      neighborhood: p.property.neighborhood || "",
      rooms: Number(p.property.rooms) || 0,
      price: Number(p.property.price),
      url: `${base}/p/${p.page_id}`,
    }));
}

function recommendationLines(matches) {
  if (!Array.isArray(matches) || !matches.length) return [];
  return ["🏠 נכסים נוספים שהוצעו:"].concat(matches.map((m) =>
    `• ${[m.title, m.city].filter(Boolean).join(", ")} — ${money(m.price)} — ${m.url}`));
}

module.exports = { BAND_PCT, MAX_MATCHES, matchByBudget, recommendationLines };
