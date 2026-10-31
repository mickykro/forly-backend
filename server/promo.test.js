/* promo.js — price ladder, Israel end-of-day, one free reel per phone, lead stages (in-memory store). */
const assert = require("assert");
const { priceFor, endOfDayIsrael, createPromoStore } = require("./promo");

const now = new Date("2026-11-01T10:00:00Z");
const until = new Date("2026-11-06T00:00:00Z");

assert.deepStrictEqual(priceFor({ paidClient: true, reelsBefore: 0, now, promoUntil: until }), { tier: "client_first", price: 0 });
assert.deepStrictEqual(priceFor({ paidClient: true, reelsBefore: 2, now, promoUntil: until }), { tier: "client", price: 49 });
assert.deepStrictEqual(priceFor({ paidClient: false, reelsBefore: 0, now, promoUntil: until }), { tier: "promo", price: 59 });
assert.deepStrictEqual(priceFor({ paidClient: false, reelsBefore: 1, now, promoUntil: until }), { tier: "regular", price: 219 });
assert.deepStrictEqual(priceFor({ paidClient: false, reelsBefore: 0, now: until, promoUntil: until }), { tier: "regular", price: 219 });
assert.deepStrictEqual(priceFor({ paidClient: false, reelsBefore: 0, now, promoUntil: null }), { tier: "regular", price: 219 });

// winter (+02:00) and summer (+03:00)
assert.strictEqual(endOfDayIsrael("2026-11-06").toISOString(), "2026-11-06T21:59:59.999Z");
assert.strictEqual(endOfDayIsrael("2026-07-01").toISOString(), "2026-07-01T20:59:59.999Z");
assert.ok(isNaN(endOfDayIsrael("2026-13-45")));

(async () => {
  const s = createPromoStore({ db: null });
  const a = await s.createOrder({ phone: "972501", price: 0, tier: "client_first" });
  const b = await s.createOrder({ phone: "972501", price: 0, tier: "client_first" });
  assert.strictEqual(await s.startedCount("972501"), 0);

  const r1 = await s.start(a, null);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.order.status, "paid");
  assert.strictEqual(await s.startedCount("972501"), 1);
  assert.deepStrictEqual(await s.start(b, null), { ok: false, reason: "already_used" });            // 2nd free, other tab
  assert.deepStrictEqual(await s.start(a, { transactionId: 1 }), { ok: false, reason: "already_started" }); // webhook retry
  assert.strictEqual(await s.startedCount("972501"), 1);

  const c = await s.createOrder({ phone: "972501", price: 49, tier: "client" });
  assert.strictEqual((await s.start(c, { transactionId: 9 })).ok, true);
  assert.strictEqual(await s.startedCount("972501"), 2);
  assert.deepStrictEqual((await s.getOrder(c)).payment, { transactionId: 9 });
  assert.deepStrictEqual(await s.start("nope", null), { ok: false, reason: "not_found" });

  // leads: early stages never overwrite late ones; late ones overwrite each other
  await s.touchLead("972502", "otp_sent", { terms_accepted_at: "t0" });
  await s.touchLead("972502", "verified");
  let [lead] = await s.listLeads();
  assert.deepStrictEqual([lead.phone, lead.stage, lead.terms_accepted_at], ["972502", "verified", "t0"]);
  await s.touchLead("972502", "checkout", { order_id: "o1", price: 59, agent_name: undefined });
  await s.touchLead("972502", "verified");
  [lead] = await s.listLeads();
  assert.strictEqual(lead.stage, "checkout");
  assert.ok(!("agent_name" in lead), "undefined values are dropped (Firestore rejects them)");
  await s.touchLead("972502", "payment_failed");
  await s.touchLead("972502", "paid");
  assert.strictEqual((await s.listLeads())[0].stage, "paid");
  await s.touchLead("972502", "payment_failed");
  assert.strictEqual((await s.listLeads())[0].stage, "paid", "a stale failed-payment link can't undo paid");
  await assert.rejects(s.touchLead("972502", "bogus"), /bad lead stage/);

  console.log("promo.test.js OK");
})().catch((e) => { console.error(e); process.exit(1); });
