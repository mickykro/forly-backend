/* listing-extract.js — coercion and "what is still missing" maths. The LLM
   call is stubbed; what matters is that nothing malformed or invented reaches
   the form and that `missing` is always computed here, never trusted. */
const assert = require("assert");
const { parseListing, REQUIRED, MAX_INPUT, _test } = require("./listing-extract");
const { coerce, missingOf, parseReply, condense, SYSTEM } = _test;

// ── condense: markdown URLs must not crowd the facts out of the input budget ──
const gallery = ("![](https://x.co/" + "a".repeat(300) + ".jpg)\n").repeat(10) + "מחיר:2,200,000 ₪\nקומה:2";
assert.ok(gallery.length > 3000);
assert.ok(condense(gallery).length < 60);              // only the two fact lines survive
assert.match(condense(gallery), /מחיר:2,200,000/);
assert.match(condense(gallery), /קומה:2/);
assert.equal(condense("[מור נדלן](https://mor.co.il/agent/12)"), "מור נדלן");
assert.equal(condense("a\n\n\n\n---\n\nb"), "a\n\nb");

// ── coerce: every key present, junk becomes null ──
const all = coerce({
  address: " דיזנגוף 40 ", city: "תל אביב", neighborhood: null, deal: "sale",
  price: "2,900,000", rooms: 3.5, size_sqm: "95", sqm_built: null, sqm_balcony: 12,
  sqm_garden: null, floor: "4", parking: 1.0, elevator: true, shabbat_elevator: "yes", storage: null,
  made_up: "dropped",
});
assert.equal(all.address, "דיזנגוף 40");
assert.equal(all.price, 2900000);
assert.equal(all.rooms, 3.5);
assert.equal(all.size_sqm, 95);
assert.equal(all.floor, 4);
assert.equal(all.parking, 1);
assert.equal(all.elevator, true);
assert.equal(all.shabbat_elevator, null);   // strings are not booleans
assert.equal(all.deal, "sale");
assert.equal("made_up" in all, false);
assert.equal(coerce({ deal: "lease" }).deal, null);
assert.equal(coerce({ price: "abc" }).price, null);
assert.equal(coerce(null).city, null);
// area breakdown must add up to the total or create.html blocks the form
const mis = coerce({ size_sqm: 110, sqm_built: 110, sqm_balcony: 15 });
assert.deepEqual([mis.size_sqm, mis.sqm_built, mis.sqm_balcony], [110, null, null]);
const ok = coerce({ size_sqm: 125, sqm_built: 110, sqm_balcony: 15 });
assert.deepEqual([ok.size_sqm, ok.sqm_built, ok.sqm_balcony], [125, 110, 15]);
assert.equal(coerce({ sqm_built: 90, sqm_garden: 40 }).size_sqm, 130);
assert.equal(coerce({ address: "x".repeat(400) }).address.length, 180);

// ── missingOf: only the agreed required set, only nulls ──
assert.deepEqual(missingOf(coerce({})), REQUIRED);
assert.deepEqual(
  missingOf(coerce({ address: "a", city: "b", price: 1, rooms: 2, size_sqm: 3, floor: 0, deal: "rent", parking: 0, neighborhood: "n" })),
  []);
assert.ok(REQUIRED.includes("deal") && REQUIRED.includes("neighborhood") && !REQUIRED.includes("elevator"));
assert.ok(!REQUIRED.includes("address"));   // scraped listings usually omit the street address

// ── parseReply: tolerant of fences and prose around the object ──
assert.equal(parseReply('```json\n{"city":"חיפה"}\n```').city, "חיפה");
assert.equal(parseReply('Sure! {"rooms": 4}').rooms, 4);
assert.throws(() => parseReply("no json here"), (e) => e.code === "extract_unavailable");
assert.throws(() => parseReply("{not json"), (e) => e.code === "extract_unavailable");

// ── prompt keeps the model honest ──
assert.match(SYSTEM, /null/);
assert.match(SYSTEM, /Never guess/);
assert.match(SYSTEM, /מיליון/);
assert.match(SYSTEM, /"rent"/);
// scraped "label:value" listing pages (e.g. "סוג עסקה:מכירה", no ל prefix) must still resolve to a deal
assert.match(SYSTEM, /מכירה/);
assert.match(SYSTEM, /מ״ר בנוי/);
assert.match(SYSTEM, /most scraped listings omit it/);

// ── parseListing: caps input, wires the stub, maps provider errors ──
(async () => {
  let seen;
  const askFn = async (model, system, messages, keys, opts) => {
    seen = { model, system, messages, opts };
    return { text: '{"address":"הרצל 1","city":"נתניה","price":"1.5M"}', in: 1, out: 1 };
  };
  const out = await parseListing("x".repeat(MAX_INPUT + 1000), { askFn, model: "test-model", keys: {} });
  assert.equal(seen.model, "test-model");
  // the chat bot's {answered, reply} schema must not be applied to an extraction
  assert.equal(seen.opts.schema, null);
  assert.ok(seen.opts.maxOut > 400);
  assert.equal(seen.messages[0].content.length, MAX_INPUT);
  assert.equal(out.fields.address, "הרצל 1");
  assert.equal(out.fields.price, null);          // "1.5M" is not a number; the prompt asks for numbers
  assert.deepEqual(out.missing, ["price", "rooms", "size_sqm", "floor", "deal", "parking", "neighborhood"]);

  await assert.rejects(
    parseListing("t", { askFn: async () => { throw new Error("ANTHROPIC_API_KEY is not set"); } }),
    (e) => e.code === "extract_unavailable");
  console.log("listing-extract.test.js ok");
})();
