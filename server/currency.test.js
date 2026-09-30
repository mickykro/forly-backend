/* currency.js — the agent's display currency, and its "מטבע …" chat command. */
const assert = require("assert");
const C = require("./currency");
const { handleTurn } = require("./whatsapp-intake");
const og = require("./og");
const { renderPortfolioDocument } = require("./portfolio-render");

const PHONE = "972501234567";
const T0 = new Date("2026-09-12T10:00:00Z");

(async () => {
  // ── parsing ──
  assert.deepEqual(C.commandOf("מטבע"), { arg: "", code: null });
  assert.equal(C.commandOf("מטבע דולר").code, "USD");
  assert.equal(C.commandOf("שנה מטבע ליורו").code, "EUR");
  assert.equal(C.commandOf("/מטבע usd").code, "USD");
  assert.equal(C.commandOf("currency EUR").code, "EUR");
  assert.equal(C.commandOf("המטבע שקל").code, "ILS");
  assert.deepEqual(C.commandOf("מטבע ין"), { arg: "ין", code: null });
  assert.equal(C.commandOf("דולר"), null, "a bare currency word is not a command (could be a price answer)");
  assert.equal(C.commandOf("2,000,000 דולר"), null);
  assert.equal(C.codeOf(null), "ILS");
  assert.equal(C.codeOf({ currency: "XYZ" }), "ILS", "junk in the doc falls back to the default");
  assert.equal(C.codeOf({ currency: "USD" }), "USD");
  assert.equal(C.localize("₪2,900,000", "EUR"), "€2,900,000");
  assert.equal(C.localize("₪2,900,000", "ILS"), "₪2,900,000");

  // ── chat command ──
  const deps = (currency) => {
    const set = [];
    return { set, d: { business: { phone: PHONE, ...(currency ? { currency } : {}) }, setCurrency: async (c) => { set.push(c); } } };
  };
  let { d, set } = deps();
  let t = await handleTurn({ phone: PHONE, now: T0, text: "מטבע דולר", draft: null }, d);
  assert.deepEqual([t.handled, t.status, set], [true, "currency_set", ["USD"]]);
  assert.match(t.replies[0].text, /דולר \(\$\)/);
  assert.equal(t.draft, undefined, "no draft is opened or touched");

  ({ d, set } = deps("EUR"));
  t = await handleTurn({ phone: PHONE, now: T0, text: "מטבע", draft: null }, d);
  assert.deepEqual([t.status, set], ["currency_ask", []]);
  assert.match(t.replies[0].text, /כרגע: יורו/);

  t = await handleTurn({ phone: PHONE, now: T0, text: "מטבע ין", draft: null }, d);
  assert.deepEqual([t.status, set], ["currency_unknown", []]);

  // An open draft's question comes right after, and prices echo in the agent's currency.
  const draft = {
    phone: PHONE, status: "active", source: "keyword", mode: null, skipped: [], photos: [], last_buttons: null,
    fields: { city: "תל אביב", price: 2900000, rooms: 4, deal: "sale", address: null, neighborhood: null, size_sqm: null,
      sqm_built: null, sqm_balcony: null, sqm_garden: null, floor: null, parking: null, elevator: null,
      shabbat_elevator: null, storage: null, description: null, template: null },
    created_at: T0, updated_at: T0,
  };
  ({ d, set } = deps());
  t = await handleTurn({ phone: PHONE, now: T0, text: "מטבע יורו", draft: structuredClone(draft) }, d);
  assert.deepEqual([t.status, set], ["currency_set", ["EUR"]]);
  assert.ok(t.replies[0].text.split("\n\n").length >= 2, "the pending question follows the confirmation");
  assert.doesNotMatch(t.replies[0].text, /₪/, "₪ in any reply is shown as the new currency");

  // ── page renderers ──
  const page = { property: { price: 2900000, rooms: 4 }, agent: { name: "A" } };
  assert.match(og.buildOgTags(page, "https://x/p/1", { currency: "USD" }), /\$2,900,000/);
  assert.match(og.buildOgTags(page, "https://x/p/1", {}), /₪2,900,000/);
  const html = renderPortfolioDocument("<html><head><!--PORTFOLIO_HEAD--></head><body><!--PORTFOLIO_BODY--></body></html>", {
    canonical_url: "https://x/a", agent: { name: "A" }, portfolio: {}, currency: "EUR",
    properties: [{ url: "/a/b", title: "T", city: "C", price: 5000, listing_type: "rent" }],
  });
  assert.match(html, /€5,000\/חודש/);

  console.log("currency.test.js: all passed");
})().catch((e) => { console.error(e); process.exit(1); });
