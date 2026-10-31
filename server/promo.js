/*
 * promo.js — /reel pricing, orders and leads.
 *
 * promo_orders/{id}       one per checkout; holds the listing until it is paid
 * promo_counters/{phone}  { started } — reels started for this phone, paid or free
 * promo_leads/{phone}     how far this number got (abandoned-cart follow-up)
 *
 * start() moves an order out of "pending" and bumps the counter in ONE
 * transaction, so a webhook retry can't build twice and two tabs can't both
 * take the free reel. Without Firestore (local/tests) the same logic runs on Maps.
 */

const crypto = require("crypto");

const PRICES = { client_first: 0, client: 49, promo: 59, regular: 219 };
const STAGES = new Set(["otp_sent", "verified", "checkout", "payment_failed", "paid"]);
const LATE = new Set(["checkout", "payment_failed", "paid"]);

function priceFor({ paidClient, reelsBefore, now, promoUntil }) {
  let tier;
  if (paidClient) tier = reelsBefore === 0 ? "client_first" : "client";
  else tier = reelsBefore === 0 && promoUntil && now < promoUntil ? "promo" : "regular";
  return { tier, price: PRICES[tier] };
}

// Drops undefined values: Firestore rejects them, the memory store would hide it.
function clean(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined));
}

// "2026-11-06" → the last millisecond of that day in Israel (DST-aware).
// Offset is taken at noon UTC, so a day that contains the DST switch uses the offset that holds for most of it.
function endOfDayIsrael(date) {
  const noon = new Date(`${date}T12:00:00Z`);
  const local = new Date(noon.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  const utc = new Date(noon.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(new Date(`${date}T23:59:59.999Z`).getTime() - (local - utc));
}

// Pure: what start() decides, given the current docs.
function decideStart(order, started, payment) {
  if (!order) return { ok: false, reason: "not_found" };
  if (order.status !== "pending") return { ok: false, reason: "already_started" };
  if (!payment && started > 0) return { ok: false, reason: "already_used" };
  return { ok: true };
}

// Pure: the lead after this touch. An early stage never hides a late one, and an
// old "&failed=1" link never turns a paid lead back into payment_failed.
function nextLead(prev, phone, stage, extra, at) {
  const keep = prev && ((!LATE.has(stage) && LATE.has(prev.stage)) || (stage === "payment_failed" && prev.stage === "paid"));
  return { ...(prev || { phone, first_seen_at: at }), ...clean(extra), stage: keep ? prev.stage : stage, last_seen_at: at };
}

function createPromoStore({ db }) {
  const mem = { orders: new Map(), counters: new Map(), leads: new Map() };
  const orderRef = (id) => db.collection("promo_orders").doc(id);
  const counterRef = (phone) => db.collection("promo_counters").doc(phone);
  const leadRef = (phone) => db.collection("promo_leads").doc(phone);

  async function createOrder(order) {
    const id = crypto.randomUUID();
    const doc = { ...clean(order), id, status: "pending", created_at: new Date() };
    if (db) await orderRef(id).set(doc);
    else mem.orders.set(id, doc);
    return id;
  }

  async function getOrder(id) {
    if (!db) return mem.orders.get(id) || null;
    const d = await orderRef(id).get();
    return d.exists ? d.data() : null;
  }

  async function setOrder(id, patch) {
    const p = clean(patch);
    if (db) await orderRef(id).set(p, { merge: true });
    else Object.assign(mem.orders.get(id) || {}, p);
  }

  async function startedCount(phone) {
    if (!db) return mem.counters.get(phone) || 0;
    const d = await counterRef(phone).get();
    return d.exists ? Number(d.data().started) || 0 : 0;
  }

  async function start(id, payment) {
    const patch = { status: "paid", paid_at: new Date(), payment: payment || null };
    if (!db) {
      const order = mem.orders.get(id);
      const r = decideStart(order, order ? mem.counters.get(order.phone) || 0 : 0, payment);
      if (!r.ok) return r;
      Object.assign(order, patch);
      mem.counters.set(order.phone, (mem.counters.get(order.phone) || 0) + 1);
      return { ok: true, order };
    }
    return db.runTransaction(async (tx) => {
      const os = await tx.get(orderRef(id));
      const order = os.exists ? os.data() : null;
      const cs = order ? await tx.get(counterRef(order.phone)) : null;
      const started = cs && cs.exists ? Number(cs.data().started) || 0 : 0;
      const r = decideStart(order, started, payment);
      if (!r.ok) return r;
      tx.set(orderRef(id), patch, { merge: true });
      tx.set(counterRef(order.phone), { started: started + 1, updated_at: new Date() }, { merge: true });
      return { ok: true, order: { ...order, ...patch } };
    });
  }

  async function touchLead(phone, stage, extra) {
    if (!STAGES.has(stage)) throw new Error(`bad lead stage: ${stage}`);
    const at = new Date().toISOString();
    if (!db) { mem.leads.set(phone, nextLead(mem.leads.get(phone), phone, stage, extra, at)); return; }
    await db.runTransaction(async (tx) => {
      const s = await tx.get(leadRef(phone));
      tx.set(leadRef(phone), nextLead(s.exists ? s.data() : null, phone, stage, extra, at));
    });
  }

  async function listLeads(limit = 300) {
    if (!db) return [...mem.leads.values()].map((l) => ({ ...l })).sort( // copies, like Firestore's d.data()
      (a, b) => (a.last_seen_at < b.last_seen_at ? 1 : -1)).slice(0, limit);
    const q = await db.collection("promo_leads").orderBy("last_seen_at", "desc").limit(limit).get();
    return q.docs.map((d) => d.data());
  }

  return { createOrder, getOrder, setOrder, startedCount, start, touchLead, listLeads };
}

module.exports = { PRICES, priceFor, endOfDayIsrael, decideStart, nextLead, createPromoStore };
