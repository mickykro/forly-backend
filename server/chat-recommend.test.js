/*
 * Unit tests for chat-recommend.js — which of the agent's other pages fit the
 * visitor's budget. Deterministic; the model never touches this.
 * Run: node server/chat-recommend.test.js
 */
const assert = require("assert");
const { matchByBudget, recommendationLines, BAND_PCT, MAX_MATCHES } = require("./chat-recommend");

const pg = (id, price, extra) => ({
  page_id: id, status: "active",
  property: { title: `נכס ${id}`, city: "חיפה", neighborhood: "הדר", rooms: 4, price, listing_type: "sale" },
  ...(extra || {}),
});
const opts = { budget: 2000000, listingType: "sale", excludePageId: "self", baseUrl: "https://x.test" };

// ── band edges: ±15% inclusive ──
let m = matchByBudget([pg("lo", 1700000), pg("hi", 2300000), pg("under", 1699999), pg("over", 2300001)], opts);
assert.deepEqual(m.map((x) => x.page_id).sort(), ["hi", "lo"]);
assert.equal(BAND_PCT, 15);

// ── edges are exact for awkward budgets (float arithmetic would drop 849999) ──
m = matchByBudget([pg("edge", 849999)], { ...opts, budget: 999999 });
assert.deepEqual(m.map((x) => x.page_id), ["edge"]);

// ── sorted by distance from budget, capped at 3 ──
m = matchByBudget([pg("a", 2200000), pg("b", 2000000), pg("c", 1900000), pg("d", 2100000)], opts);
assert.deepEqual(m.map((x) => x.page_id), ["b", "c", "d"]);
assert.equal(MAX_MATCHES, 3);

// ── the current page is never recommended to itself ──
m = matchByBudget([pg("self", 2000000), pg("other", 2000000)], opts);
assert.deepEqual(m.map((x) => x.page_id), ["other"]);

// ── deal type must match; rent budgets are monthly and never mix with sale ──
m = matchByBudget([
  pg("r1", 6000, { property: { title: "r1", price: 6000, listing_type: "rent" } }),
  pg("s1", 6000),
], { ...opts, budget: 6000, listingType: "rent" });
assert.deepEqual(m.map((x) => x.page_id), ["r1"]);

// ── unpublished, hidden, and unknown-price pages are skipped ──
m = matchByBudget([
  pg("expired", 2000000, { status: "expired" }),
  pg("hidden", 2000000, { portfolio_visible: false }),
  pg("noprice", 0),
  pg("expiring", 2000000, { status: "expiring" }),
], opts);
assert.deepEqual(m.map((x) => x.page_id), ["expiring"]);

// ── shape and URL ──
m = matchByBudget([pg("p1", 2050000)], opts);
assert.deepEqual(m[0], {
  page_id: "p1", title: "נכס p1", city: "חיפה", neighborhood: "הדר", rooms: 4,
  price: 2050000, url: "https://x.test/p/p1",
});

// ── defensive inputs ──
assert.deepEqual(matchByBudget(null, opts), []);
assert.deepEqual(matchByBudget([pg("p1", 2000000)], { ...opts, budget: 0 }), []);
assert.deepEqual(matchByBudget([{ page_id: "junk" }], opts), []);

// ── WhatsApp lines ──
assert.deepEqual(recommendationLines([]), []);
assert.deepEqual(recommendationLines(m), [
  "🏠 נכסים נוספים שהוצעו:",
  "• נכס p1, חיפה — ₪2,050,000 — https://x.test/p/p1",
]);

console.log("chat-recommend.test.js ✓");
