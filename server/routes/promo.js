/*
 * routes/promo.js — the /reel landing page's API (mounted at /api/promo).
 *
 *   POST /lead/start                   public   → number typed + terms ticked (lead: otp_sent)
 *   POST /lead                         session  → verified | payment_failed
 *   POST /quote                        session  → { tier, price }
 *   POST /order                        session  → free: build now; paid: Cardcom page URL
 *   POST /cardcom/webhook              public   → re-checked with GetLpResult, then build
 *   GET  /order/:id                    session  → status for the thank-you screen (owner only)
 *   GET  /admin/settings · PUT         admin    → promo end date (settings/reel_promo)
 *   GET  /admin/leads                  admin    → who started and how far they got
 *   POST /admin/orders/:id/mark-paid   admin    → fallback when Cardcom is down / not live
 *
 * The order is the entitlement: promo reels never touch the walkthroughs quota.
 */

const express = require("express");
const { validateListing, buildFailed } = require("../listing-create");
const { priceFor, endOfDayIsrael } = require("../promo");

const { parseOrderBody } = require("../promo-body");

const MAX_LISTING_BYTES = 32 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar day: "2026-02-30" would otherwise roll over to March 2.
const realDate = (d) => typeof d === "string" && DATE_RE.test(d) && !isNaN(new Date(`${d}T12:00:00Z`))
  && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;
// Express 4 doesn't catch rejected promises: hand them to the error handler.
const h = (fn) => (req, res, next) => fn(req, res).catch(next);

module.exports = function createPromoRouter({ requireAuth, authSecret, requireAdmin, requireStepUp, store, cardcom,
  createListing, isAdmin = () => false, reelReady = true, isPaidClient, settings, normalizePhone, getListing, photoBase, baseUrl, now = () => new Date() }) {
  const router = express.Router();
  const auth = requireAuth(authSecret, ["session", "promo"]); // auth.js PROMO_SCOPES
  const adminWrite = [requireAdmin, requireStepUp];

  async function quote(phone, user) {
    if (isAdmin(user)) return { price: 0, reason: "admin" }; // decided by the session only, never the body
    const [paidClient, reelsBefore, s] = await Promise.all([isPaidClient(phone), store.startedCount(phone), settings.get()]);
    return priceFor({ paidClient, reelsBefore, now: now(), promoUntil: s && s.until ? new Date(s.until) : null });
  }

  // Started order → listing with source "reel_promo" → the reel workflow (kickPipeline).
  // Agents without a profile name get their typed name on the page.
  async function build(order) {
    const agent = { ...order.agent, phone: order.phone }; // typed agent block; no business doc for strangers
    let r; // a throw after start() committed must not strand a paid order
    try { r = await createListing(order.phone, order.listing, agent, { source: "reel_promo" }); } catch (e) { r = { error: e.message }; }
    const status = r.error ? "failed" : "building";
    if (r.error) {
      console.error(`promo build failed for order ${order.id}:`, r.error);
      await store.setOrder(order.id, { status, error: String(r.error).slice(0, 200) });
    } else await store.setOrder(order.id, { status, listing_id: r.listing_id });
    await store.touchLead(order.phone, "paid", { order_id: order.id, price: order.price, order_status: status,
      listing_id: r.listing_id || null });
    return status;
  }

  router.post("/lead/start", h(async (req, res) => {
    const body = req.body || {};
    const phone = normalizePhone(String(body.phone || ""));
    if (!phone) return res.status(400).json({ error: "invalid_phone" });
    if (body.terms_accepted !== true) return res.status(400).json({ error: "terms_required" });
    await store.touchLead(phone, "otp_sent", { terms_accepted_at: now().toISOString() }); // consent is recorded only after the OTP (a typed number proves nothing)
    res.json({ ok: true });
  }));

  router.post("/lead", auth, h(async (req, res) => {
    const stage = String((req.body && req.body.stage) || "");
    if (stage !== "verified" && stage !== "payment_failed") return res.status(400).json({ error: "invalid_stage" });
    // Verified-only: the owner of the number ticked it. Unticked = withdrawn.
    await store.touchLead(req.user.userId, stage, stage === "verified"
      ? { marketing_consent_at: req.body.marketing_consent === true ? now().toISOString() : null } : undefined);
    res.json({ ok: true });
  }));

  router.post("/quote", auth, h(async (req, res) => { res.json(await quote(req.user.userId, req.user)); }));

  router.post("/order", auth, h(async (req, res) => {
    if (!reelReady) return res.status(503).json({ error: "reel_unavailable" }); // no reel workflow → don't take money
    const phone = req.user.userId;
    const body = req.body || {};
    if (body.terms_accepted !== true) return res.status(400).json({ error: "terms_required" });
    const parsed = parseOrderBody(body, photoBase);
    if (parsed.error) return res.status(parsed.code).json({ error: parsed.error });
    const { listing, agent } = parsed;
    const agentName = agent.name;
    const invalid = validateListing(listing);
    if (invalid) return res.status(invalid.code).json({ error: invalid.error });
    if (Buffer.byteLength(JSON.stringify(listing)) > MAX_LISTING_BYTES) return res.status(413).json({ error: "too_large" });

    const admin = isAdmin(req.user);
    const { tier, price, reason } = await quote(phone, req.user);
    const termsAt = now().toISOString();
    const id = await store.createOrder({ phone, price, tier: tier || "admin", reason, listing, agent, agent_name: agentName, terms_accepted_at: termsAt });
    // Free orders get their lead from build(); a closed free order must not look like an abandoned cart.
    if (price > 0) await store.touchLead(phone, "checkout", { agent_name: agentName, order_id: id, price, terms_accepted_at: termsAt, order_status: null });

    if (price === 0) {
      const s = await store.start(id, admin ? { admin: true, by: phone } : null);
      if (!s.ok) { // close it, so "mark paid" can't hand out a second free reel later
        await store.setOrder(id, { status: "failed", error: s.reason });
        return res.status(409).json({ error: s.reason, order_id: id });
      }
      return res.json({ order_id: id, status: await build(s.order) });
    }
    if (!cardcom.configured) return res.json({ order_id: id, status: "pending", pay_url: null });
    const back = `${baseUrl}/reel?order=${id}`;
    let page;
    try {
      page = await cardcom.createPaymentPage({
        orderId: id, amount: price, description: "Forly — סרטון רילס לנכס", payerName: agentName, payerPhone: phone,
        successUrl: back, failedUrl: `${back}&failed=1`, webhookUrl: `${baseUrl}/api/promo/cardcom/webhook`,
      });
    } catch (e) {
      console.error(`promo order ${id}: Cardcom create failed:`, e.message);
      return res.status(502).json({ error: "payment_unavailable" });
    }
    await store.setOrder(id, { cardcom_lp_id: page.lowProfileId });
    res.json({ order_id: id, status: "pending", pay_url: page.url });
  }));

  // Cardcom retries until it gets a 200, so every outcome we decided is a 200;
  // only an unexpected error (→ 500) asks for a retry.
  router.post("/cardcom/webhook", express.urlencoded({ extended: false }), h(async (req, res) => {
    const lpId = String((req.body && req.body.LowProfileId) || req.query.LowProfileId || req.query.lowprofilecode || "");
    if (!lpId) return res.status(400).json({ error: "missing LowProfileId" });
    let r;
    try { r = await cardcom.getResult(lpId); } catch (e) { // junk/declined id: a retry won't change it
      console.error("promo webhook: getResult failed:", e.message);
      return res.json({ ok: true, ignored: true });
    }
    const order = r.orderId ? await store.getOrder(String(r.orderId)) : null;
    if (!order || order.cardcom_lp_id !== lpId || !r.approved) return res.json({ ok: true, ignored: true });
    if (r.amount !== order.price) {
      console.error(`promo order ${order.id}: paid ${r.amount}, expected ${order.price}`);
      if (order.status === "pending") {
        await store.setOrder(order.id, { status: "amount_mismatch", payment: { transactionId: r.transactionId, amount: r.amount } });
        await store.touchLead(order.phone, "payment_failed", { order_status: "amount_mismatch" });
      }
      return res.json({ ok: true, ignored: true });
    }
    const s = await store.start(order.id, { transactionId: r.transactionId, amount: r.amount });
    if (s.ok) await build(s.order);
    res.json({ ok: true });
  }));

  router.get("/order/:id", auth, h(async (req, res) => {
    const o = await store.getOrder(req.params.id);
    if (!o || o.phone !== req.user.userId) return res.status(404).json({ error: "not_found" });
    res.json({ status: o.status, price: o.price, listing_id: o.listing_id || null });
  }));

  router.get("/admin/settings", requireAdmin, h(async (req, res) => {
    const s = (await settings.get()) || {};
    res.json({ until_date: s.until_date || null, until: s.until || null });
  }));

  router.put("/admin/settings", adminWrite, h(async (req, res) => {
    const d = (req.body || {}).until_date;
    if (d !== null && !realDate(d)) return res.status(400).json({ error: "invalid_date" });
    const s = await settings.set({ until_date: d, until: d ? endOfDayIsrael(d).toISOString() : null });
    res.json({ until_date: s.until_date || null, until: s.until || null });
  }));

  // A reel n8n never delivered is a stuck listing, not an order error: look at the listing
  // for recent "building" leads (last 3 days only, to keep the reads small).
  router.get("/admin/leads", requireAdmin, h(async (req, res) => {
    const leads = await store.listLeads();
    await Promise.all(leads.map(async (l) => {
      if (l.order_status !== "building" || !l.listing_id || Date.now() - Date.parse(l.last_seen_at) > 3 * 864e5) return;
      const listing = await getListing(l.listing_id).catch(() => null);
      if (listing && listing.page_id) l.order_status = "done";
      else if (listing && buildFailed(listing)) l.order_status = "failed";
    }));
    res.json({ leads });
  }));

  router.post("/admin/orders/:id/mark-paid", adminWrite, h(async (req, res) => {
    const s = await store.start(req.params.id, { manual: true, by: req.user ? req.user.userId : "admin" });
    if (s.ok) return res.json({ ok: true, status: await build(s.order) });
    if (s.reason === "already_started") { // re-build a paid order whose listing never got created
      const o = await store.getOrder(req.params.id);
      if (o && !o.listing_id && o.payment && (o.status === "paid" || o.status === "failed")) return res.json({ ok: true, status: await build(o) });
    }
    res.status(409).json({ error: s.reason });
  }));

  return router;
};
