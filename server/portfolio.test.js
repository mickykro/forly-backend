#!/usr/bin/env node
/**
 * portfolio.test.js — standalone tests for portfolio helpers.
 * Run: node server/portfolio.test.js
 */
const assert = require("assert");
const {
  portfolioSlug,
  propertySlug,
  parsePublicPath,
  visiblePortfolioPages,
  normalizePortfolio,
  reservationTarget,
  assertSlugAvailable,
  nextPortfolioStatus,
} = require("./portfolio");

// ── slug generation ──
// ponytail: character-by-character transliteration, no vowel inference
assert.strictEqual(portfolioSlug("קרויטורו נכסים"), "krvytvrv-nksym");
assert.strictEqual(portfolioSlug("ABC Properties"), "abc-properties");
assert.strictEqual(portfolioSlug(""), "my-portfolio");
assert.strictEqual(portfolioSlug("api"), "agent-api"); // reserved

// ── property slug ──
// ponytail: street3 (first 3 non-digit chars) + number + code
assert.strictEqual(propertySlug("ויצמן 23", "a7k"), "vyt23-a7k");
assert.strictEqual(propertySlug("רחוב ללא מספר", "a7k"), "rch-a7k");
assert.strictEqual(propertySlug("", "a7k"), "property-a7k");
assert.strictEqual(propertySlug("שד בן גוריון 45", "xyz"), "shd45-xyz");

// ── path parsing ──
assert.deepStrictEqual(parsePublicPath("/kroitoro-nehasim/vyt23-a7k"), {
  kind: "property", portfolioSlug: "kroitoro-nehasim", propertySlug: "vyt23-a7k"
});
assert.deepStrictEqual(parsePublicPath("/kroitoro-nehasim"), {
  kind: "portfolio", portfolioSlug: "kroitoro-nehasim"
});
assert.strictEqual(parsePublicPath("/api/portfolio"), null);
assert.strictEqual(parsePublicPath("/p/some-page"), null);
assert.strictEqual(parsePublicPath(""), null);

// ── visibility filter ──
assert.deepStrictEqual(
  visiblePortfolioPages([
    { status: "active", portfolio_visible: true, portfolio_rank: 2 },
    { status: "archived", portfolio_visible: true, portfolio_rank: 1 },
    { status: "active", portfolio_visible: false, portfolio_rank: 0 },
  ]).map((p) => p.portfolio_rank),
  [2]
);
assert.deepStrictEqual(
  visiblePortfolioPages([
    { status: "expiring", portfolio_visible: true, portfolio_rank: null },
    { status: "active", portfolio_rank: 1 },
  ]).map((p) => p.portfolio_rank),
  [1, null]
);

// ── normalization ──
const norm = normalizePortfolio(
  { hero: { headline: "Test" }, about: { body: "About text" } },
  { slug: "existing", status: "open" }
);
assert.strictEqual(norm.slug, "existing");
assert.strictEqual(norm.hero.headline, "Test");
assert.strictEqual(norm.about.body, "About text");
assert.strictEqual(norm.status, "open");

// ── reservation helpers ──
assert.strictEqual(reservationTarget({ current_slug: "new-name" }), "new-name");
assert.strictEqual(reservationTarget(null), null);

assert.throws(
  () => assertSlugAvailable({ "taken-name": { business_phone: "972500000000" } }, "taken-name", "972599999999"),
  /slug_taken/
);
assert.doesNotThrow(
  () => assertSlugAvailable({ "taken-name": { business_phone: "972500000000" } }, "taken-name", "972500000000")
);
assert.doesNotThrow(
  () => assertSlugAvailable({}, "new-slug", "972500000000")
);

// ── status transitions ──
assert.strictEqual(nextPortfolioStatus("draft", 1), "draft");
assert.strictEqual(nextPortfolioStatus("draft", 2), "open");
assert.strictEqual(nextPortfolioStatus("draft", 5), "open");
assert.strictEqual(nextPortfolioStatus("open", 0), "open");
assert.strictEqual(nextPortfolioStatus("closed", 3), "closed");

console.log("✓ portfolio.test.js: all assertions passed");
