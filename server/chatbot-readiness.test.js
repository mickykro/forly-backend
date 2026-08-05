/*
 * Unit tests for chatbot-readiness.js — would the bot have anything to say?
 * Pure functions only: no Express, no Firestore, no network.
 * Run: node server/chatbot-readiness.test.js
 */
const assert = require("assert");
const { countSpecs, countAreaFacts, scorePage, summarize } = require("./chatbot-readiness");

const desc = (n) => ({ description: "x".repeat(n) });

// ── countSpecs ──
assert.equal(countSpecs(undefined), 0);
assert.equal(countSpecs({}), 0);
assert.equal(countSpecs({ rooms: 4, size_sqm: 92 }), 2);
// 0 means "not captured" — createPropertyPage writes `Number(x) || 0` for
// anything missing, so counting it would overstate every page.
assert.equal(countSpecs({ rooms: 0, floor: 0, price: 0 }), 0);
assert.equal(countSpecs({ address: "  " }), 0, "whitespace is not an address");
// booleans are facts either way: "is there a lift?" is answerable by false
assert.equal(countSpecs({ elevator: false, storage: false }), 2);
assert.equal(countSpecs({ elevator: null }), 0);

// ── countAreaFacts ──
assert.equal(countAreaFacts(undefined), 0);
assert.equal(countAreaFacts({ blurb: "שכונה שקטה" }), 1);
assert.equal(countAreaFacts({ blurb: "", stops: [1, 2], stats: [1] }), 3);

// ── a page with nothing: hands off on the first question ──
let r = scorePage({}, null);
assert.equal(r.verdict, "thin");
assert.ok(r.gaps.includes("no_listing"));
assert.ok(r.gaps.includes("few_specs"));
assert.ok(r.gaps.includes("no_carousel"));
assert.ok(r.gaps.includes("no_area"));

// ── a typical old page: specs only, no description, no area/carousel ──
r = scorePage({ property: { rooms: 4, size_sqm: 92, floor: 3, price: 2350000, city: "חיפה" } }, null);
assert.equal(r.signals.spec_fields, 5);
assert.equal(r.verdict, "ok", "enough specs to answer the common questions");
assert.ok(r.gaps.includes("no_listing"));

// ── specs present but a listing with no description ──
r = scorePage({ property: { rooms: 4, size_sqm: 92, floor: 3, city: "חיפה" } }, { description: "" });
assert.ok(r.gaps.includes("no_description"));
assert.ok(!r.gaps.includes("no_listing"));

// ── short description is called out separately from none at all ──
r = scorePage({ property: { rooms: 4 } }, desc(30));
assert.ok(r.gaps.includes("short_description"));
assert.equal(r.signals.description_chars, 30);

// ── genuinely thin: barely any description AND barely any specs ──
r = scorePage({ property: { rooms: 3 } }, desc(20));
assert.equal(r.verdict, "thin");

// ── the full modern page ──
const rich = {
  property: {
    rooms: 4, size_sqm: 92, floor: 3, price: 2350000, parking: 1,
    address: "הרצל 10", city: "חיפה", neighborhood: "הדר", listing_type: "sale",
    elevator: true, storage: false,
  },
  carousel: { slides: [{}, {}, {}] },
  area: { blurb: "שכונה מבוקשת", stops: [{}, {}], stats: [{}] },
  gallery: { images: [{ caption: "סלון" }, { caption: "" }, { caption: "מטבח" }] },
};
r = scorePage(rich, desc(400));
assert.equal(r.verdict, "rich");
assert.deepEqual(r.gaps, []);
assert.equal(r.signals.carousel_slides, 3);
assert.equal(r.signals.area_facts, 4);
assert.equal(r.signals.gallery_captions, 2, "blank captions are not facts");

// ── rich content but a thin description drops it out of "rich" ──
r = scorePage(rich, desc(100));
assert.equal(r.verdict, "ok");

// ── good description but almost no structure ──
r = scorePage({ property: { rooms: 4 } }, desc(500));
assert.equal(r.verdict, "ok", "a long description alone still beats silence");

// ── summarize ──
const s = summarize([
  { verdict: "thin", gaps: ["no_listing", "few_specs"], chatbot_enabled: false },
  { verdict: "thin", gaps: ["few_specs"], chatbot_enabled: true },
  { verdict: "rich", gaps: [], chatbot_enabled: true },
]);
assert.equal(s.total, 3);
assert.equal(s.thin, 2);
assert.equal(s.rich, 1);
assert.equal(s.ok, 0);
assert.equal(s.enabled, 2);
assert.equal(s.gaps.few_specs, 2);
assert.equal(s.gaps.no_listing, 1);

console.log("chatbot-readiness: all tests passed");
