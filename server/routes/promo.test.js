/* routes/promo.js over HTTP with fakes: terms, leads, pricing per phone, free vs paid,
   webhook verification + idempotency, amount mismatch, owner-only status, admin settings + mark-paid. */
const assert = require("assert");
const express = require("express");
const createPromoRouter = require("./promo");
const { createPromoStore } = require("../promo");
const { normalizeAuthPhone } = require("../utils");

const photos = ["https://f/1.jpg", "https://f/2.jpg", "https://f/3.jpg"];
const listing = { city: "תל אביב", price: 2500000, rooms: 4, photos_urls: photos, agent_name: "דנה", terms_accepted: true,
  own_video_url: "https://evil/v.mp4", listing_draft_id: "someone-elses" }; // must be dropped by the whitelist

async function withApp(opts, fn) {
  const businesses = new Map(Object.entries(opts.businesses || {}));
  const built = [];
  const lp = { paid: new Map() }; // lowProfileId -> {orderId, amount, approved}
  let promo = opts.promo === undefined ? { until_date: "2026-11-06", until: "2026-11-06T21:59:59.999Z" } : opts.promo;
  const store = createPromoStore({ db: null });
  if (opts.staleCount) store.startedCount = async () => 0; // the quote's read happened before the other tab started
  const cardcom = {
    configured: opts.cardcomConfigured !== false,
    async createPaymentPage({ orderId, amount }) {
      if (opts.cardcomDown) throw new Error("down");
      const id = `lp-${orderId}`; lp[id] = { orderId, amount }; return { lowProfileId: id, url: `https://pay/${id}` };
    },
    async getResult(id) { if (opts.resultThrows) throw new Error("bad lp"); return lp.paid.get(id) || { orderId: lp[id] && lp[id].orderId, amount: 0, approved: false }; },
  };
  const app = express();
  app.use(express.json());
  const requireAuth = () => (req, res, next) => {
    const p = req.get("x-phone"); if (!p) return res.status(401).json({ error: "unauthorized" });
    req.user = { userId: p }; next();
  };
  const requireAdmin = (req, res, next) => (req.get("x-admin") ? next() : res.status(403).json({ error: "forbidden" }));
  const requireStepUp = (req, res, next) => (req.get("x-stepup") ? next() : res.status(401).json({ error: "stepup_required" }));
  app.use("/api/promo", createPromoRouter({
    requireAuth, authSecret: "s", requireAdmin, requireStepUp, store, cardcom,
    reelReady: opts.reelReady,
    createListing: async (phone, body, agent, extra) => { if (opts.failFirstBuild && !built.length) { built.push(null); throw new Error("boom"); } built.push({ phone, body, agent, extra }); return { listing_id: `L${built.length}` }; },
    business: { get: async (p) => businesses.get(p) || null, set: async (p, d) => businesses.set(p, { ...(businesses.get(p) || {}), ...d }) },
    isPaidClient: async (p) => (opts.paidClients || []).includes(p),
    settings: { get: async () => promo, set: async (patch) => (promo = { ...(promo || {}), ...patch }) },
    normalizePhone: normalizeAuthPhone,
    getListing: async (id) => (opts.listings || {})[id] || null, photoBase: "https://f/",
    baseUrl: "https://forly.test", now: () => new Date("2026-11-01T10:00:00Z"),
  }));
  app.use((err, req, res, next) => res.status(500).json({ error: "internal" })); // eslint-disable-line no-unused-vars
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/promo`;
  const req = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  try { await fn({ req, built, lp, businesses, store }); } finally { server.close(); }
}

(async () => {
  const log = console.log; console.error = () => {};
  const admin = { "x-admin": "1", "x-stepup": "1" };

  // Lead capture: terms required; stages move forward; early stage can't hide checkout
  await withApp({}, async ({ req, store }) => {
    assert.strictEqual((await req("POST", "/lead/start", { phone: "050-111-1111" })).data.error, "terms_required");
    assert.strictEqual((await req("POST", "/lead/start", { phone: "12", terms_accepted: true })).data.error, "invalid_phone");
    assert.strictEqual((await req("POST", "/lead/start", { phone: "050-111-1111", terms_accepted: true })).status, 200);
    const [lead] = await store.listLeads();
    assert.deepStrictEqual([lead.phone, lead.stage, !!lead.terms_accepted_at, !!lead.marketing_consent_at], ["972501111111", "otp_sent", true, false]);
    await req("POST", "/lead/start", { phone: "0507777777", terms_accepted: true, marketing_consent: true });
    assert.ok(!(await store.listLeads()).find((l) => l.phone === "972507777777").marketing_consent_at, "a typed number can't opt in");
    const h7 = { "x-phone": "972507777777" };
    await req("POST", "/lead", { stage: "verified", marketing_consent: true }, h7);
    assert.ok((await store.listLeads()).find((l) => l.phone === "972507777777").marketing_consent_at, "opt-in recorded once verified");
    await req("POST", "/lead/start", { phone: "0507777777", terms_accepted: true, marketing_consent: false });
    assert.ok((await store.listLeads()).find((l) => l.phone === "972507777777").marketing_consent_at, "lead/start never erases it");
    await req("POST", "/lead", { stage: "verified" }, h7);
    assert.strictEqual((await store.listLeads()).find((l) => l.phone === "972507777777").marketing_consent_at, null, "unticked at verify = withdrawn");
    const h = { "x-phone": "972501111111" };
    assert.strictEqual((await req("POST", "/lead", { stage: "paid" }, h)).status, 400, "client can't claim paid");
    await req("POST", "/lead", { stage: "verified" }, h);
    assert.strictEqual((await store.listLeads()).find((l) => l.phone === "972501111111").stage, "verified");
    // admin sees it; non-admin doesn't
    assert.strictEqual((await req("GET", "/admin/leads")).status, 403);
    assert.strictEqual((await req("GET", "/admin/leads", null, admin)).data.leads.length, 2);
  });

  // New phone: ₪59, pays via Cardcom, webhook builds once, retry doesn't rebuild
  const listings = {};
  await withApp({ listings }, async ({ req, built, lp, businesses, store }) => {
    const h = { "x-phone": "972501111111" };
    assert.strictEqual((await req("POST", "/order", { ...listing, photos_urls: ["https://evil/1.jpg", ...photos] }, h)).status, 400, "foreign photo URLs refused");
    assert.strictEqual((await req("POST", "/order", { ...listing, photos_urls: ["https://f/../x.jpg", ...photos] }, h)).status, 400, "traversal/query photo URLs refused");
    assert.deepStrictEqual((await req("POST", "/quote", {}, h)).data, { tier: "promo", price: 59 });
    assert.strictEqual((await req("POST", "/order", { ...listing, terms_accepted: false }, h)).data.error, "terms_required");
    const o = await req("POST", "/order", listing, h);
    assert.strictEqual(o.status, 200);
    assert.strictEqual(o.data.status, "pending");
    assert.ok(o.data.pay_url.startsWith("https://pay/"));
    assert.strictEqual(businesses.size, 0, "a promo buyer never gets a business doc");
    assert.strictEqual(built.length, 0);
    const [lead] = await store.listLeads();
    assert.deepStrictEqual([lead.stage, lead.order_id, lead.price, lead.agent_name], ["checkout", o.data.order_id, 59, "דנה"]);

    const lpId = `lp-${o.data.order_id}`;
    assert.strictEqual((await req("POST", "/cardcom/webhook", { LowProfileId: lpId })).status, 200); // not paid yet
    assert.strictEqual(built.length, 0);
    lp.paid.set(lpId, { orderId: o.data.order_id, amount: 59, approved: true, transactionId: 5 });
    await req("POST", "/cardcom/webhook", { LowProfileId: lpId });
    await req("POST", "/cardcom/webhook", { LowProfileId: lpId });
    assert.strictEqual(built.length, 1);
    assert.deepStrictEqual(built[0].agent, { name: "דנה", phone: "972501111111" });
    assert.deepStrictEqual(built[0].extra, { source: "reel_promo" });
    for (const k of ["terms_accepted", "agent_name", "own_video_url", "listing_draft_id"]) assert.ok(!(k in built[0].body), `${k} not forwarded`);
    // a reel n8n never delivered shows up as a problem in the admin; a delivered one as done
    listings.L1 = { listing_id: "L1", status: "active", page_id: null, source: "reel_promo", created_at: new Date(Date.now() - 60 * 60e3) };
    assert.strictEqual((await req("GET", "/admin/leads", null, admin)).data.leads[0].order_status, "failed");
    listings.L1.page_id = "pg1";
    assert.strictEqual((await req("GET", "/admin/leads", null, admin)).data.leads[0].order_status, "done");
    assert.deepStrictEqual([(await store.listLeads())[0].stage, (await store.listLeads())[0].order_status], ["paid", "building"]);
    const st = await req("GET", `/order/${o.data.order_id}`, null, h);
    assert.deepStrictEqual(st.data, { status: "building", price: 59, listing_id: "L1" });
    assert.strictEqual((await req("GET", `/order/${o.data.order_id}`, null, { "x-phone": "972509999999" })).status, 404);
    assert.deepStrictEqual((await req("POST", "/quote", {}, h)).data, { tier: "regular", price: 219 });
  });

  // Paid amount differs from order price → not built
  await withApp({}, async ({ req, built, lp }) => {
    const h = { "x-phone": "972502222222" };
    const o = await req("POST", "/order", listing, h);
    const lpId = `lp-${o.data.order_id}`;
    lp.paid.set(lpId, { orderId: o.data.order_id, amount: 1, approved: true, transactionId: 6 });
    await req("POST", "/cardcom/webhook", { LowProfileId: lpId });
    assert.strictEqual(built.length, 0);
    assert.strictEqual((await req("GET", `/order/${o.data.order_id}`, null, h)).data.status, "amount_mismatch");
  });

  // Free reel already used (two tabs: the 2nd was quoted ₪0 from a stale count): its order is
  // closed, so "mark paid" can't hand out a second free reel later
  await withApp({ businesses: { "972506666666": { full_name: "Agent" } }, paidClients: ["972506666666"], staleCount: true }, async ({ req, built }) => {
    const h = { "x-phone": "972506666666" };
    assert.strictEqual((await req("POST", "/order", listing, h)).data.status, "building");
    const second = await req("POST", "/order", listing, h);
    assert.deepStrictEqual([second.status, second.data.error], [409, "already_used"]);
    assert.strictEqual(built.length, 1);
    const id = second.data.order_id;
    assert.strictEqual((await req("GET", `/order/${id}`, null, h)).data.status, "failed");
    assert.strictEqual((await req("POST", `/admin/orders/${id}/mark-paid`, {}, admin)).status, 409);
    assert.strictEqual(built.length, 1);
  });

  // Existing paying client: first reel free and built at once (own profile, no override); next is ₪49
  await withApp({ businesses: { "972503333333": { full_name: "Agent" } }, paidClients: ["972503333333"] }, async ({ req, built }) => {
    const h = { "x-phone": "972503333333" };
    const o = await req("POST", "/order", listing, h);
    assert.strictEqual(o.data.status, "building");
    assert.strictEqual(built.length, 1);
    assert.strictEqual(built[0].agent, null);
    assert.deepStrictEqual((await req("POST", "/quote", {}, h)).data, { tier: "client", price: 49 });
  });

  // Promo off (no date) → ₪219; admin sets a date → ₪59; bad date refused; step-up required
  await withApp({ promo: null }, async ({ req }) => {
    const h = { "x-phone": "972504444444" };
    assert.deepStrictEqual((await req("POST", "/quote", {}, h)).data, { tier: "regular", price: 219 });
    assert.strictEqual((await req("PUT", "/admin/settings", { until_date: "2026-11-07" }, { "x-admin": "1" })).status, 401);
    assert.strictEqual((await req("PUT", "/admin/settings", { until_date: "2026-13-45" }, admin)).status, 400);
    assert.strictEqual((await req("PUT", "/admin/settings", { until_date: "2026-02-30" }, admin)).status, 400);
    const s = await req("PUT", "/admin/settings", { until_date: "2026-11-07" }, admin);
    assert.deepStrictEqual(s.data, { until_date: "2026-11-07", until: "2026-11-07T21:59:59.999Z" });
    assert.deepStrictEqual((await req("GET", "/admin/settings", null, { "x-admin": "1" })).data, s.data);
    assert.deepStrictEqual((await req("POST", "/quote", {}, h)).data, { tier: "promo", price: 59 });
    await req("PUT", "/admin/settings", { until_date: null }, admin);
    assert.deepStrictEqual((await req("POST", "/quote", {}, h)).data, { tier: "regular", price: 219 });
  });

  // Validation + auth + Cardcom down
  await withApp({ cardcomDown: true }, async ({ req }) => {
    const h = { "x-phone": "972504" };
    assert.strictEqual((await req("POST", "/order", { ...listing, photos_urls: [] }, h)).status, 400);
    assert.strictEqual((await req("POST", "/order", { ...listing, agent_name: "" }, h)).status, 400);
    assert.strictEqual((await req("POST", "/order", listing)).status, 401);
    assert.strictEqual((await req("POST", "/cardcom/webhook", {})).status, 400);
    const o = await req("POST", "/order", listing, h);
    assert.deepStrictEqual([o.status, o.data.error], [502, "payment_unavailable"]);
  });

  // Cardcom not configured → pending without pay_url; admin mark-paid (with step-up) builds it
  await withApp({ cardcomConfigured: false }, async ({ req, built }) => {
    const o = await req("POST", "/order", listing, { "x-phone": "972505555555" });
    assert.deepStrictEqual([o.data.status, o.data.pay_url], ["pending", null]);
    assert.strictEqual((await req("POST", `/admin/orders/${o.data.order_id}/mark-paid`, {})).status, 403);
    assert.strictEqual((await req("POST", `/admin/orders/${o.data.order_id}/mark-paid`, {}, { "x-admin": "1" })).status, 401);
    const m = await req("POST", `/admin/orders/${o.data.order_id}/mark-paid`, {}, admin);
    assert.deepStrictEqual(m.data, { ok: true, status: "building" });
    assert.strictEqual(built.length, 1);
    assert.strictEqual((await req("POST", `/admin/orders/${o.data.order_id}/mark-paid`, {}, admin)).status, 409);
  });

  // createListing throws after payment → order "failed", not stranded; admin re-builds it once
  await withApp({ failFirstBuild: true }, async ({ req, built, lp, store }) => {
    const h = { "x-phone": "972508888888" };
    const o = await req("POST", "/order", listing, h);
    const lpId = `lp-${o.data.order_id}`;
    lp.paid.set(lpId, { orderId: o.data.order_id, amount: 59, approved: true, transactionId: 7 });
    assert.strictEqual((await req("POST", "/cardcom/webhook", { LowProfileId: lpId })).status, 200);
    assert.strictEqual((await req("GET", `/order/${o.data.order_id}`, null, h)).data.status, "failed");
    assert.strictEqual((await store.listLeads())[0].order_status, "failed");
    const m = await req("POST", `/admin/orders/${o.data.order_id}/mark-paid`, {}, admin);
    assert.deepStrictEqual(m.data, { ok: true, status: "building" });
    assert.strictEqual(built.length, 2);
    assert.strictEqual((await req("POST", `/admin/orders/${o.data.order_id}/mark-paid`, {}, admin)).status, 409, "built now: no third build");
  });

  // getResult throws (junk LowProfileId) → 200 so Cardcom stops retrying; nothing built
  await withApp({ resultThrows: true }, async ({ req, built }) => {
    const r = await req("POST", "/cardcom/webhook", { LowProfileId: "junk" });
    assert.deepStrictEqual([r.status, r.data], [200, { ok: true, ignored: true }]);
    assert.strictEqual(built.length, 0);
  });

  // No reel webhook configured → no order is created
  await withApp({ reelReady: false }, async ({ req, store }) => {
    const r = await req("POST", "/order", listing, { "x-phone": "972501212121" });
    assert.deepStrictEqual([r.status, r.data.error], [503, "reel_unavailable"]);
    assert.strictEqual((await store.listLeads()).length, 0);
  });

  log("routes/promo.test.js OK");
})().catch((e) => { console.log(e); process.exit(1); });
