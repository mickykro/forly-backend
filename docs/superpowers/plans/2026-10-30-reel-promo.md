# Reel Promo (/reel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public `/reel` landing page where anyone verifies their phone by WhatsApp OTP, uploads a property, pays with Cardcom (or gets it free) and receives the narrated reel + property page on WhatsApp.

**Architecture:** `/reel` is a paid front door to the existing `createListing()` → n8n WW1 pipeline, which already renders the reel, builds the page and WhatsApps the agent. New code: a Cardcom adapter (`server/payments/cardcom.js`), a pricing + order store (`server/promo.js`) and routes (`server/routes/promo.js`). The Cardcom webhook body is never trusted: every payment is re-checked with `GetLpResult`.

**Tech Stack:** Node/Express (server/), Firestore via `server/db.js` (in-memory fallback when `db.db` is null), plain `node x.test.js` assert tests, vanilla HTML/JS page in `public-agent/`.

## Global Constraints

- Prices in ILS, computed on the server only, per phone:
  - `businesses/{phone}.paid === true` (existing client): 1st reel ₪0, each after ₪49.
  - Everyone else: 1st reel ₪59 while `now < REEL_PROMO_UNTIL`, otherwise ₪219; each after ₪219.
- "Reels before" = orders for that phone that were started (paid or free) — counted in `promo_counters/{phone}.started`, incremented inside the same transaction that starts the order.
- A free reel can never be claimed twice (transaction re-checks `started === 0`).
- Flow order: OTP → details + photos → pay → generate. Uploads are saved on the order before payment.
- Page URL is `/reel` (no `.html`); file is `public-agent/reel.html`.
- Promo reels do NOT consume the `walkthroughs` quota; the order is the entitlement.
- Admin fallback: `POST /api/promo/admin/orders/:id/mark-paid` starts a pending order without Cardcom (for when the Cardcom account isn't live, or a webhook was lost).
- Secrets only from env: `CARDCOM_TERMINAL`, `CARDCOM_API_NAME`. Promo end: `REEL_PROMO_UNTIL` (ISO date, e.g. `2026-11-06`).
- Files under 500 lines. No new npm dependencies.

## Decisions folded in from brainstorming (part 3, defaults)

- **Failed / abandoned payment:** order stays `pending`; nothing charged, nothing built. The user can submit again from `/reel`.
- **Failed generation:** existing `/api/properties/retry` flow covers it (the listing is owned by the phone). Refunds are manual from the Cardcom dashboard.
- **Paid amount ≠ order price:** order → `amount_mismatch`, nothing built, logged for an operator.
- **Known limit:** two promo-priced orders paid in parallel tabs both get built at ₪59 (the user paid both). Accepted.

---

### Task 0: Verify assumptions (no code)

- [ ] **Step 1:** Open https://secure.cardcom.solutions/Api/v11/Docs in a browser. Confirm for `LowProfile/Create`: fields `TerminalNumber, ApiName, Operation, ReturnValue, Amount, ISOCoinId, Language, ProductName, SuccessRedirectUrl, FailedRedirectUrl, WebHookUrl, Document{DocumentTypeToCreate, Name, Mobile, Products[{Description, UnitCost, Quantity}]}` and response `ResponseCode, Description, LowProfileId, Url`. For `LowProfile/GetLpResult`: request `TerminalNumber, ApiName, LowProfileId`, response `ResponseCode, ReturnValue, TranzactionInfo{ResponseCode, Amount, TranzactionId}`, and what the webhook POST body contains (expected: `LowProfileId`). If any name differs, use the real name in Task 1 and note it in the commit message.
- [ ] **Step 2:** In n8n, open the WW1 workflow and confirm it does not call `/api/quota/consume` for `trigger_source: "dashboard"` (the dashboard create path consumes on the server, so it should not). If it does, Task 3's `build()` must call `quota` with a top-up first — stop and raise it.

---

### Task 1: Cardcom adapter

**Files:**
- Create: `server/payments/cardcom.js`
- Test: `server/payments/cardcom.test.js`
- Modify: `server/package.json` (`test` script: append ` && node payments/cardcom.test.js`)

**Interfaces:**
- Produces: `createCardcom({ terminal, apiName, fetchFn? }) → { configured: boolean, createPaymentPage(opts) → Promise<{ lowProfileId, url }>, getResult(lowProfileId) → Promise<{ orderId, amount, approved, transactionId }> }`
  - `opts = { orderId, amount, description, payerName, payerPhone, successUrl, failedUrl, webhookUrl }`

- [ ] **Step 1: Write the failing test** — `server/payments/cardcom.test.js`

```js
/* payments/cardcom.js — request shape and result parsing, with a fake fetch. */
const assert = require("assert");
const { createCardcom } = require("./cardcom");

function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => reply(url) };
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  assert.strictEqual(createCardcom({}).configured, false);

  // create: sends terminal, amount, order id, webhook; returns page url
  const f1 = fakeFetch(() => ({ ResponseCode: 0, LowProfileId: "lp-1", Url: "https://pay/lp-1" }));
  const c1 = createCardcom({ terminal: "1000", apiName: "test", fetchFn: f1 });
  const page = await c1.createPaymentPage({ orderId: "o1", amount: 59, description: "Reel", payerName: "Dana",
    payerPhone: "0501234567", successUrl: "https://x/reel?order=o1", failedUrl: "https://x/reel?order=o1&failed=1",
    webhookUrl: "https://x/api/promo/cardcom/webhook" });
  assert.deepStrictEqual(page, { lowProfileId: "lp-1", url: "https://pay/lp-1" });
  const b = f1.calls[0].body;
  assert.ok(f1.calls[0].url.endsWith("/LowProfile/Create"));
  assert.strictEqual(b.TerminalNumber, 1000);
  assert.strictEqual(b.ReturnValue, "o1");
  assert.strictEqual(b.Amount, 59);
  assert.strictEqual(b.WebHookUrl, "https://x/api/promo/cardcom/webhook");
  assert.strictEqual(b.Document.Products[0].UnitCost, 59);

  // getResult: approved transaction
  const f2 = fakeFetch(() => ({ ResponseCode: 0, ReturnValue: "o1", TranzactionInfo: { ResponseCode: 0, Amount: 59, TranzactionId: 777 } }));
  const r = await createCardcom({ terminal: "1000", apiName: "test", fetchFn: f2 }).getResult("lp-1");
  assert.deepStrictEqual(r, { orderId: "o1", amount: 59, approved: true, transactionId: 777 });

  // getResult: no transaction (page opened, never paid) → not approved
  const f3 = fakeFetch(() => ({ ResponseCode: 0, ReturnValue: "o1" }));
  assert.strictEqual((await createCardcom({ terminal: "1", apiName: "t", fetchFn: f3 }).getResult("lp-1")).approved, false);

  // API error → throws
  const f4 = fakeFetch(() => ({ ResponseCode: 5, Description: "bad terminal" }));
  await assert.rejects(createCardcom({ terminal: "1", apiName: "t", fetchFn: f4 }).getResult("lp-1"), /bad terminal/);

  console.log("cardcom.test.js OK");
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it, expect FAIL** — `cd server && node payments/cardcom.test.js` → `Cannot find module './cardcom'`.

- [ ] **Step 3: Implement** — `server/payments/cardcom.js`

```js
/*
 * payments/cardcom.js — Cardcom LowProfile (hosted payment page), API v11.
 * createPaymentPage() opens a page for one order; getResult() is the server-side
 * check the webhook relies on — the webhook body itself is never trusted.
 */

const BASE = (process.env.CARDCOM_API_BASE || "https://secure.cardcom.solutions/api/v11").replace(/\/+$/, "");

function createCardcom({ terminal, apiName, fetchFn = fetch }) {
  const configured = !!(terminal && apiName);

  async function call(path, body) {
    const r = await fetchFn(`${BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ TerminalNumber: Number(terminal), ApiName: apiName, ...body }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || Number(data.ResponseCode) !== 0) {
      throw new Error(`cardcom ${path} failed: ${data.ResponseCode} ${data.Description || r.status}`);
    }
    return data;
  }

  async function createPaymentPage({ orderId, amount, description, payerName, payerPhone, successUrl, failedUrl, webhookUrl }) {
    const d = await call("LowProfile/Create", {
      Operation: "ChargeOnly", ReturnValue: orderId, Amount: amount, ISOCoinId: 1, Language: "he",
      ProductName: description, SuccessRedirectUrl: successUrl, FailedRedirectUrl: failedUrl, WebHookUrl: webhookUrl,
      Document: {
        DocumentTypeToCreate: "Receipt", Name: payerName || payerPhone, Mobile: payerPhone,
        Products: [{ Description: description, UnitCost: amount, Quantity: 1 }],
      },
    });
    return { lowProfileId: d.LowProfileId, url: d.Url };
  }

  async function getResult(lowProfileId) {
    const d = await call("LowProfile/GetLpResult", { LowProfileId: lowProfileId });
    const t = d.TranzactionInfo;
    return {
      orderId: d.ReturnValue,
      amount: t ? Number(t.Amount) : 0,
      approved: !!t && Number(t.ResponseCode) === 0,
      transactionId: t ? t.TranzactionId : null,
    };
  }

  return { configured, createPaymentPage, getResult };
}

module.exports = { createCardcom };
```

- [ ] **Step 4: Run, expect PASS** — `node payments/cardcom.test.js` → `cardcom.test.js OK`.
- [ ] **Step 5:** Append ` && node payments/cardcom.test.js` to the `test` script in `server/package.json`.
- [ ] **Step 6: Commit**

```bash
git add server/payments server/package.json
git commit -m "feat(promo): Cardcom LowProfile adapter"
```

---

### Task 2: Pricing + order store

**Files:**
- Create: `server/promo.js`
- Test: `server/promo.test.js`
- Modify: `server/package.json` (`test` script: append ` && node promo.test.js`)

**Interfaces:**
- Produces:
  - `priceFor({ paidClient: boolean, reelsBefore: number, now: Date, promoUntil: Date|null }) → { tier: "client_first"|"client"|"promo"|"regular", price: number }`
  - `createPromoStore({ db }) → { createOrder(order) → Promise<string id>, getOrder(id) → Promise<order|null>, setOrder(id, patch) → Promise<void>, startedCount(phone) → Promise<number>, start(id, payment|null) → Promise<{ ok: true, order } | { ok: false, reason: "not_found"|"already_started"|"already_used" }> }`
  - Order shape: `{ id, phone, price, tier, status: "pending"|"paid"|"building"|"failed"|"amount_mismatch", listing, agent_name, use_agent_override, cardcom_lp_id, payment, listing_id, created_at, paid_at }`
  - `start(id, null)` = free start: fails with `already_used` if the phone has `started > 0`.

- [ ] **Step 1: Write the failing test** — `server/promo.test.js`

```js
/* promo.js — the price ladder and the one-free-reel-per-phone guarantee (in-memory store). */
const assert = require("assert");
const { priceFor, createPromoStore } = require("./promo");

const now = new Date("2026-11-01T10:00:00Z");
const until = new Date("2026-11-06T00:00:00Z");

assert.deepStrictEqual(priceFor({ paidClient: true, reelsBefore: 0, now, promoUntil: until }), { tier: "client_first", price: 0 });
assert.deepStrictEqual(priceFor({ paidClient: true, reelsBefore: 2, now, promoUntil: until }), { tier: "client", price: 49 });
assert.deepStrictEqual(priceFor({ paidClient: false, reelsBefore: 0, now, promoUntil: until }), { tier: "promo", price: 59 });
assert.deepStrictEqual(priceFor({ paidClient: false, reelsBefore: 1, now, promoUntil: until }), { tier: "regular", price: 219 });
assert.deepStrictEqual(priceFor({ paidClient: false, reelsBefore: 0, now: until, promoUntil: until }), { tier: "regular", price: 219 });
assert.deepStrictEqual(priceFor({ paidClient: false, reelsBefore: 0, now, promoUntil: null }), { tier: "regular", price: 219 });

(async () => {
  const s = createPromoStore({ db: null });
  const a = await s.createOrder({ phone: "0501", price: 0, tier: "client_first" });
  const b = await s.createOrder({ phone: "0501", price: 0, tier: "client_first" });
  assert.strictEqual(await s.startedCount("0501"), 0);

  const r1 = await s.start(a, null);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.order.status, "paid");
  assert.strictEqual(await s.startedCount("0501"), 1);

  // second free order from another tab → refused
  assert.deepStrictEqual(await s.start(b, null), { ok: false, reason: "already_used" });
  // same order twice (webhook retry) → refused, counter unchanged
  assert.deepStrictEqual(await s.start(a, { transactionId: 1 }), { ok: false, reason: "already_started" });
  assert.strictEqual(await s.startedCount("0501"), 1);

  // paid start is allowed after earlier reels
  const c = await s.createOrder({ phone: "0501", price: 49, tier: "client" });
  assert.strictEqual((await s.start(c, { transactionId: 9 })).ok, true);
  assert.strictEqual(await s.startedCount("0501"), 2);
  assert.deepStrictEqual((await s.getOrder(c)).payment, { transactionId: 9 });

  assert.deepStrictEqual(await s.start("nope", null), { ok: false, reason: "not_found" });
  console.log("promo.test.js OK");
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run, expect FAIL** — `node promo.test.js` → `Cannot find module './promo'`.

- [ ] **Step 3: Implement** — `server/promo.js`

```js
/*
 * promo.js — /reel pricing and orders.
 *
 * promo_orders/{id}       one per checkout; holds the listing until it is paid
 * promo_counters/{phone}  { started } — reels started for this phone, paid or free
 *
 * start() moves an order out of "pending" and bumps the counter in ONE
 * transaction, so a webhook retry can't build twice and two tabs can't both
 * take the free reel. Without Firestore (local/tests) the same logic runs on Maps.
 */

const crypto = require("crypto");

const PRICES = { client_first: 0, client: 49, promo: 59, regular: 219 };

function priceFor({ paidClient, reelsBefore, now, promoUntil }) {
  let tier;
  if (paidClient) tier = reelsBefore === 0 ? "client_first" : "client";
  else tier = reelsBefore === 0 && promoUntil && now < promoUntil ? "promo" : "regular";
  return { tier, price: PRICES[tier] };
}

// Pure: what start() decides, given the current docs.
function decideStart(order, started, payment) {
  if (!order) return { ok: false, reason: "not_found" };
  if (order.status !== "pending") return { ok: false, reason: "already_started" };
  if (!payment && started > 0) return { ok: false, reason: "already_used" };
  return { ok: true };
}

function createPromoStore({ db }) {
  const mem = { orders: new Map(), counters: new Map() };
  const orderRef = (id) => db.collection("promo_orders").doc(id);
  const counterRef = (phone) => db.collection("promo_counters").doc(phone);

  async function createOrder(order) {
    const id = crypto.randomUUID();
    const doc = { ...order, id, status: "pending", created_at: new Date() };
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
    if (db) await orderRef(id).set(patch, { merge: true });
    else Object.assign(mem.orders.get(id) || {}, patch);
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

  return { createOrder, getOrder, setOrder, startedCount, start };
}

module.exports = { PRICES, priceFor, decideStart, createPromoStore };
```

- [ ] **Step 4: Run, expect PASS** — `node promo.test.js` → `promo.test.js OK`.
- [ ] **Step 5:** Append ` && node promo.test.js` to the `test` script.
- [ ] **Step 6: Commit**

```bash
git add server/promo.js server/promo.test.js server/package.json
git commit -m "feat(promo): reel price ladder and order store"
```

---

### Task 3: Promo routes

**Files:**
- Create: `server/routes/promo.js`
- Test: `server/routes/promo.test.js`
- Modify: `server/package.json` (`test` script: append ` && node routes/promo.test.js`)

**Interfaces:**
- Consumes: `createCardcom` (Task 1), `priceFor`, store API (Task 2), `validateListing` from `server/listing-create.js`.
- Produces: `createPromoRouter({ requireAuth, authSecret, requireAdmin, store, cardcom, createListing, business, baseUrl, promoUntil, now? }) → express.Router`, mounted at `/api/promo`:
  - `POST /quote` (session) → `{ tier, price }`
  - `POST /order` (session, body = create-form listing fields + `agent_name`) → `{ order_id, status: "building" }` | `{ order_id, status: "pending", pay_url: string|null }` | 400/409
  - `POST /cardcom/webhook` (public; JSON or form body with `LowProfileId`) → 200 `{ ok }`
  - `GET /order/:id` (session, owner only) → `{ status, price, listing_id }`
  - `POST /admin/orders/:id/mark-paid` (admin) → `{ ok, status }`
  - `business = { get(phone) → Promise<doc|null>, set(phone, data) → Promise }`
  - `createListing(phone, body, agentOverride, extraDeps) → Promise<{ listing_id } | { error, code }>`

- [ ] **Step 1: Write the failing test** — `server/routes/promo.test.js`

```js
/* routes/promo.js over HTTP with fakes: pricing per phone, free vs paid, webhook
   verification + idempotency, amount mismatch, owner-only status, admin fallback. */
const assert = require("assert");
const express = require("express");
const createPromoRouter = require("./promo");
const { createPromoStore } = require("../promo");

const photos = ["https://f/1.jpg", "https://f/2.jpg", "https://f/3.jpg"];
const listing = { city: "תל אביב", price: 2500000, rooms: 4, photos_urls: photos, agent_name: "דנה" };

async function withApp(opts, fn) {
  const businesses = new Map(Object.entries(opts.businesses || {}));
  const built = [];
  const lp = { paid: new Map() }; // lowProfileId -> {orderId, amount, approved}
  const cardcom = {
    configured: opts.cardcomConfigured !== false,
    async createPaymentPage({ orderId, amount }) { const id = `lp-${orderId}`; lp[id] = { orderId, amount }; return { lowProfileId: id, url: `https://pay/${id}` }; },
    async getResult(id) { return lp.paid.get(id) || { orderId: lp[id] && lp[id].orderId, amount: 0, approved: false }; },
  };
  const app = express();
  app.use(express.json());
  const requireAuth = () => (req, res, next) => {
    const p = req.get("x-phone"); if (!p) return res.status(401).json({ error: "unauthorized" });
    req.user = { userId: p }; next();
  };
  const requireAdmin = (req, res, next) => (req.get("x-admin") ? next() : res.status(403).json({ error: "forbidden" }));
  app.use("/api/promo", createPromoRouter({
    requireAuth, authSecret: "s", requireAdmin, store: createPromoStore({ db: null }), cardcom,
    createListing: async (phone, body, agent) => { built.push({ phone, body, agent }); return { listing_id: `L${built.length}` }; },
    business: { get: async (p) => businesses.get(p) || null, set: async (p, d) => businesses.set(p, { ...(businesses.get(p) || {}), ...d }) },
    baseUrl: "https://forly.test", promoUntil: new Date("2026-11-06"), now: () => new Date("2026-11-01"),
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/promo`;
  const req = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  try { await fn({ req, built, lp, businesses }); } finally { server.close(); }
}

(async () => {
  const log = console.log; console.error = () => {};

  // New phone: ₪59, pays via Cardcom, webhook builds once, retry doesn't rebuild
  await withApp({}, async ({ req, built, lp, businesses }) => {
    const h = { "x-phone": "0501111111" };
    assert.deepStrictEqual((await req("POST", "/quote", {}, h)).data, { tier: "promo", price: 59 });
    const o = await req("POST", "/order", listing, h);
    assert.strictEqual(o.status, 200);
    assert.strictEqual(o.data.status, "pending");
    assert.ok(o.data.pay_url.startsWith("https://pay/"));
    assert.strictEqual(businesses.get("0501111111").source, "reel_promo");
    assert.strictEqual(built.length, 0);

    // webhook before payment → nothing built
    const lpId = `lp-${o.data.order_id}`;
    assert.strictEqual((await req("POST", "/cardcom/webhook", { LowProfileId: lpId })).status, 200);
    assert.strictEqual(built.length, 0);

    lp.paid.set(lpId, { orderId: o.data.order_id, amount: 59, approved: true, transactionId: 5 });
    await req("POST", "/cardcom/webhook", { LowProfileId: lpId });
    await req("POST", "/cardcom/webhook", { LowProfileId: lpId });
    assert.strictEqual(built.length, 1);
    assert.deepStrictEqual(built[0].agent, { name: "דנה", phone: "0501111111" });
    const st = await req("GET", `/order/${o.data.order_id}`, null, h);
    assert.deepStrictEqual(st.data, { status: "building", price: 59, listing_id: "L1" });
    // someone else can't read it
    assert.strictEqual((await req("GET", `/order/${o.data.order_id}`, null, { "x-phone": "0509999999" })).status, 404);
    // second reel for the same phone is full price
    assert.deepStrictEqual((await req("POST", "/quote", {}, h)).data, { tier: "regular", price: 219 });
  });

  // Paid amount differs from order price → not built
  await withApp({}, async ({ req, built, lp }) => {
    const o = await req("POST", "/order", listing, { "x-phone": "0502222222" });
    const lpId = `lp-${o.data.order_id}`;
    lp.paid.set(lpId, { orderId: o.data.order_id, amount: 1, approved: true, transactionId: 6 });
    await req("POST", "/cardcom/webhook", { LowProfileId: lpId });
    assert.strictEqual(built.length, 0);
    assert.strictEqual((await req("GET", `/order/${o.data.order_id}`, null, { "x-phone": "0502222222" })).data.status, "amount_mismatch");
  });

  // Existing paying client: first reel free and built at once (own profile, no override); next is ₪49
  await withApp({ businesses: { "0503333333": { paid: true, name: "Agent" } } }, async ({ req, built }) => {
    const h = { "x-phone": "0503333333" };
    const o = await req("POST", "/order", listing, h);
    assert.strictEqual(o.data.status, "building");
    assert.strictEqual(built.length, 1);
    assert.strictEqual(built[0].agent, null);
    assert.deepStrictEqual((await req("POST", "/quote", {}, h)).data, { tier: "client", price: 49 });
  });

  // Validation + auth
  await withApp({}, async ({ req }) => {
    assert.strictEqual((await req("POST", "/order", { ...listing, photos_urls: [] }, { "x-phone": "0504" })).status, 400);
    assert.strictEqual((await req("POST", "/order", { ...listing, agent_name: "" }, { "x-phone": "0504" })).status, 400);
    assert.strictEqual((await req("POST", "/order", listing)).status, 401);
    assert.strictEqual((await req("POST", "/cardcom/webhook", {})).status, 400);
  });

  // Cardcom not configured → pending without pay_url; admin mark-paid builds it
  await withApp({ cardcomConfigured: false }, async ({ req, built }) => {
    const o = await req("POST", "/order", listing, { "x-phone": "0505555555" });
    assert.deepStrictEqual([o.data.status, o.data.pay_url], ["pending", null]);
    assert.strictEqual((await req("POST", `/admin/orders/${o.data.order_id}/mark-paid`, {})).status, 403);
    const m = await req("POST", `/admin/orders/${o.data.order_id}/mark-paid`, {}, { "x-admin": "1" });
    assert.deepStrictEqual(m.data, { ok: true, status: "building" });
    assert.strictEqual(built.length, 1);
  });

  log("routes/promo.test.js OK");
})().catch((e) => { console.log(e); process.exit(1); });
```

- [ ] **Step 2: Run, expect FAIL** — `node routes/promo.test.js` → `Cannot find module './promo'`.

- [ ] **Step 3: Implement** — `server/routes/promo.js`

```js
/*
 * routes/promo.js — the /reel landing page's API (mounted at /api/promo).
 *
 *   POST /quote                        session  → { tier, price }
 *   POST /order                        session  → free: build now; paid: Cardcom page URL
 *   POST /cardcom/webhook              public   → re-checked with GetLpResult, then build
 *   GET  /order/:id                    session  → status for the thank-you screen (owner only)
 *   POST /admin/orders/:id/mark-paid   admin    → fallback when Cardcom is down / not live
 *
 * The order is the entitlement: promo reels never touch the walkthroughs quota.
 */

const express = require("express");
const { validateListing } = require("../listing-create");
const { priceFor } = require("../promo");

const MAX_LISTING_BYTES = 32 * 1024;

module.exports = function createPromoRouter({ requireAuth, authSecret, requireAdmin, store, cardcom, createListing,
  business, baseUrl, promoUntil, now = () => new Date() }) {
  const router = express.Router();
  const auth = requireAuth(authSecret);

  async function quote(phone) {
    const [biz, reelsBefore] = await Promise.all([business.get(phone), store.startedCount(phone)]);
    return { biz, ...priceFor({ paidClient: !!(biz && biz.paid === true), reelsBefore, now: now(), promoUntil }) };
  }

  // Started order → listing → n8n WW1 (reel + page + WhatsApp). Agents without a
  // profile get their typed name on the page.
  async function build(order) {
    const agent = order.use_agent_override ? { name: order.agent_name, phone: order.phone } : null;
    const r = await createListing(order.phone, order.listing, agent, { source: "reel_promo" });
    if (r.error) {
      console.error(`promo build failed for order ${order.id}:`, r.error);
      await store.setOrder(order.id, { status: "failed", error: String(r.error).slice(0, 200) });
      return "failed";
    }
    await store.setOrder(order.id, { status: "building", listing_id: r.listing_id });
    return "building";
  }

  router.post("/quote", auth, async (req, res) => {
    const { tier, price } = await quote(req.user.userId);
    res.json({ tier, price });
  });

  router.post("/order", auth, async (req, res) => {
    const phone = req.user.userId;
    const body = req.body || {};
    const agentName = String(body.agent_name || "").trim().slice(0, 60);
    const invalid = validateListing(body);
    if (invalid) return res.status(invalid.code).json({ error: invalid.error });
    if (!agentName) return res.status(400).json({ error: "agent_name is required" });
    const { agent_name, ...listing } = body;
    if (Buffer.byteLength(JSON.stringify(listing)) > MAX_LISTING_BYTES) return res.status(413).json({ error: "too_large" });

    const { biz, tier, price } = await quote(phone);
    if (!biz) await business.set(phone, { source: "reel_promo", paid: false, name: agentName, created_at: now() });
    const id = await store.createOrder({ phone, price, tier, listing, agent_name: agentName,
      use_agent_override: !(biz && biz.name) });

    if (price === 0) {
      const s = await store.start(id, null);
      if (!s.ok) return res.status(409).json({ error: s.reason });
      return res.json({ order_id: id, status: await build(s.order) });
    }
    if (!cardcom.configured) return res.json({ order_id: id, status: "pending", pay_url: null });
    const back = `${baseUrl}/reel?order=${id}`;
    const page = await cardcom.createPaymentPage({
      orderId: id, amount: price, description: "Forly — סרטון רילס לנכס", payerName: agentName, payerPhone: phone,
      successUrl: back, failedUrl: `${back}&failed=1`, webhookUrl: `${baseUrl}/api/promo/cardcom/webhook`,
    });
    await store.setOrder(id, { cardcom_lp_id: page.lowProfileId });
    res.json({ order_id: id, status: "pending", pay_url: page.url });
  });

  // Cardcom retries until it gets a 200, so every outcome we decided is a 200;
  // only an unexpected error (thrown → 500) asks for a retry.
  router.post("/cardcom/webhook", express.urlencoded({ extended: false }), async (req, res) => {
    const lpId = String((req.body && req.body.LowProfileId) || req.query.LowProfileId || req.query.lowprofilecode || "");
    if (!lpId) return res.status(400).json({ error: "missing LowProfileId" });
    const r = await cardcom.getResult(lpId);
    const order = r.orderId ? await store.getOrder(String(r.orderId)) : null;
    if (!order || order.cardcom_lp_id !== lpId || !r.approved) return res.json({ ok: true, ignored: true });
    if (r.amount !== order.price) {
      console.error(`promo order ${order.id}: paid ${r.amount}, expected ${order.price}`);
      if (order.status === "pending") await store.setOrder(order.id, { status: "amount_mismatch", payment: { transactionId: r.transactionId, amount: r.amount } });
      return res.json({ ok: true, ignored: true });
    }
    const s = await store.start(order.id, { transactionId: r.transactionId, amount: r.amount });
    if (s.ok) await build(s.order);
    res.json({ ok: true });
  });

  router.get("/order/:id", auth, async (req, res) => {
    const o = await store.getOrder(req.params.id);
    if (!o || o.phone !== req.user.userId) return res.status(404).json({ error: "not_found" });
    res.json({ status: o.status, price: o.price, listing_id: o.listing_id || null });
  });

  router.post("/admin/orders/:id/mark-paid", requireAdmin, async (req, res) => {
    const s = await store.start(req.params.id, { manual: true, by: req.user ? req.user.userId : "admin" });
    if (!s.ok) return res.status(409).json({ error: s.reason });
    res.json({ ok: true, status: await build(s.order) });
  });

  return router;
};
```

- [ ] **Step 4: Run, expect PASS** — `node routes/promo.test.js` → `routes/promo.test.js OK`.
- [ ] **Step 5:** Append ` && node routes/promo.test.js` to the `test` script.
- [ ] **Step 6: Commit**

```bash
git add server/routes/promo.js server/routes/promo.test.js server/package.json
git commit -m "feat(promo): /api/promo routes — quote, order, Cardcom webhook, admin mark-paid"
```

---

### Task 4: Wire into the server + `/reel` URL

**Files:**
- Modify: `server/index.js` (after the `/api/quota` mount, ~line 224; and next to the `/instructions` route, ~line 193)

**Interfaces:**
- Consumes: `createCardcom` (Task 1), `createPromoStore` (Task 2), `createPromoRouter` (Task 3), existing `requireAuth`, `requireAdmin` (index.js:130), `rateLimit`, `db`, `BASE_URL`, `N8N_*` consts, `createListing` from `./listing-create`.

- [ ] **Step 1: Add the `/reel` page route** after the `/instructions` route:

```js
// Reel promo landing page (public; the page itself does OTP login).
app.get(/^\/reel\/?$/, (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "..", "public-agent", "reel.html"));
});
```

- [ ] **Step 2: Mount the API** after the `/api/quota` mount:

```js
// ── reel promo (/reel): OTP → listing → Cardcom → n8n WW1. See routes/promo.js ──
// CARDCOM_TERMINAL / CARDCOM_API_NAME: Cardcom API user. Unset ⇒ orders wait for
// an admin mark-paid. REEL_PROMO_UNTIL: last moment of the ₪59 first-reel price.
const { createCardcom } = require("./payments/cardcom");
const { createPromoStore } = require("./promo");
const REEL_PROMO_UNTIL = process.env.REEL_PROMO_UNTIL ? new Date(process.env.REEL_PROMO_UNTIL) : null;
app.use("/api/promo/cardcom/webhook", rateLimit({ windowMs: 60_000, max: 60 }));
app.use("/api/promo/order", rateLimit({ windowMs: 60_000, max: 10 }));
app.use("/api/promo", require("./routes/promo")({
  requireAuth, authSecret: AUTH_SECRET, requireAdmin,
  store: createPromoStore({ db: db.db }),
  cardcom: createCardcom({ terminal: process.env.CARDCOM_TERMINAL, apiName: process.env.CARDCOM_API_NAME }),
  createListing: (phone, body, agent, extra) => require("./listing-create").createListing(phone, body, agent, {
    n8nWw1Webhook: N8N_DEV_WEBHOOK_URL || N8N_WW1_WEBHOOK_URL,
    n8nPipelineWebhook: N8N_DEV_PIPELINE_WEBHOOK_URL || N8N_PIPELINE_WEBHOOK_URL,
    isDevRun: !!N8N_DEV_WEBHOOK_URL, isDevPipelineRun: !!N8N_DEV_PIPELINE_WEBHOOK_URL, baseUrl: BASE_URL, ...extra,
  }),
  business: { get: (p) => db.getBusiness(p), set: (p, d) => db.setBusiness(p, d) },
  baseUrl: BASE_URL, promoUntil: REEL_PROMO_UNTIL,
}));
```

- [ ] **Step 3: Smoke test locally** — `cd server && npm run local`, then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/reel
curl -s -X POST http://127.0.0.1:8787/api/promo/quote
```

Expected: `/reel` → an error status until Task 5 adds the file, then `200`; `/quote` → `401`.

- [ ] **Step 4: Run the full suite** — `npm test` → all pass.
- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "feat(promo): mount /api/promo and serve /reel"
```

---

### Task 5: The `/reel` landing page

**Files:**
- Create: `public-agent/reel.html`

**Interfaces:**
- Consumes: `POST /api/auth/otp {phone}`, `POST /api/auth/otp/verify {phone, code}` (sets the `forly_session` cookie), `GET /api/auth/me`, `POST /api/upload-urls {files:[{name, contentType}]}` → `{files:[{upload_url, method, content_type, public_url}]}`, `PUT upload_url`, and the Task 3 promo routes.

- [ ] **Step 1: Create the page** — `public-agent/reel.html`

```html
<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Forly — סרטון רילס לנכס</title>
<link rel="icon" href="/favicon.png">
<style>
  :root { --bg:#0f1115; --card:#181b22; --fg:#f2f2f2; --muted:#9aa0aa; --accent:#ff5a36; --err:#ff6b6b; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif; }
  main { max-width:480px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:28px; margin:8px 0; } p.lead { color:var(--muted); margin:0 0 20px; }
  section { background:var(--card); border-radius:14px; padding:18px; margin-bottom:16px; }
  label { display:block; font-size:14px; color:var(--muted); margin:12px 0 4px; }
  input { width:100%; padding:12px; border-radius:10px; border:1px solid #2a2f3a; background:#0f1115; color:var(--fg); font-size:16px; }
  button { width:100%; margin-top:16px; padding:14px; border:0; border-radius:10px; background:var(--accent); color:#fff; font-size:17px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .err { color:var(--err); font-size:14px; min-height:1em; margin-top:8px; }
  .price { font-size:32px; font-weight:700; } [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <h1>סרטון רילס לנכס שלך</h1>
  <p class="lead">מעלים תמונות, ותוך דקות מקבלים בוואטסאפ סרטון רילס מוכן עם קריינות ומוזיקה + דף נכס.</p>

  <section id="s-phone">
    <label for="phone">מספר הוואטסאפ שלך</label>
    <input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="050-0000000">
    <button id="send">שלחו לי קוד</button>
    <div id="code-wrap" hidden>
      <label for="code">הקוד שקיבלת בוואטסאפ</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
      <button id="verify">אימות</button>
    </div>
    <div class="err" id="e-phone" role="alert"></div>
  </section>

  <section id="s-form" hidden>
    <label for="agent_name">שם (יופיע בדף הנכס)</label><input id="agent_name" autocomplete="name">
    <label for="city">עיר</label><input id="city">
    <label for="address">כתובת (לא חובה)</label><input id="address">
    <label for="price">מחיר (₪)</label><input id="price" type="number" inputmode="numeric">
    <label for="rooms">חדרים</label><input id="rooms" type="number" inputmode="decimal" step="0.5">
    <label for="size_sqm">מ״ר</label><input id="size_sqm" type="number" inputmode="numeric">
    <label for="photos">תמונות (לפחות 3)</label><input id="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple>
    <div class="price" id="quote" aria-live="polite"></div>
    <button id="submit">המשך</button>
    <div class="err" id="e-form" role="alert"></div>
  </section>

  <section id="s-done" hidden>
    <h2 id="done-title">הסרטון בהכנה</h2>
    <p id="done-text">נשלח לך את הסרטון ואת דף הנכס בוואטסאפ, בדרך כלל תוך 15–20 דקות.</p>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const show = (id) => ["s-phone", "s-form", "s-done"].forEach((s) => { $(s).hidden = s !== id; });
async function api(path, body, method = "POST") {
  const r = await fetch(path, { method, credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `error ${r.status}`), { status: r.status });
  return data;
}
const ERR = { invalid_code: "הקוד שגוי", code_expired: "הקוד פג, שלחו שוב", already_used: "כבר קיבלת סרטון חינם במספר הזה" };
const msg = (e) => ERR[e.message] || "משהו השתבש, נסו שוב";

async function loadQuote() {
  const q = await api("/api/promo/quote", {});
  $("quote").textContent = q.price === 0 ? "הסרטון הראשון עלינו 🎁" : `₪${q.price}`;
  $("submit").textContent = q.price === 0 ? "צרו לי סרטון" : `לתשלום ₪${q.price}`;
}

async function pollOrder(id, failed) {
  show("s-done");
  if (failed) { $("done-title").textContent = "התשלום לא הושלם"; $("done-text").textContent = "לא חויבת. אפשר לנסות שוב."; return; }
  for (let i = 0; i < 20; i++) {
    const o = await api(`/api/promo/order/${encodeURIComponent(id)}`, null, "GET").catch(() => null);
    if (o && o.status === "building") return;
    if (o && o.status === "failed") { $("done-title").textContent = "משהו השתבש ביצירה"; $("done-text").textContent = "ניצור איתך קשר בוואטסאפ."; return; }
    if (o && o.status === "pending") $("done-text").textContent = "ממתינים לאישור התשלום…";
    await new Promise((r) => setTimeout(r, 3000));
  }
}

$("send").onclick = async () => {
  $("e-phone").textContent = "";
  try { await api("/api/auth/otp", { phone: $("phone").value }); $("code-wrap").hidden = false; $("code").focus(); }
  catch (e) { $("e-phone").textContent = msg(e); }
};
$("verify").onclick = async () => {
  $("e-phone").textContent = "";
  try { await api("/api/auth/otp/verify", { phone: $("phone").value, code: $("code").value }); show("s-form"); await loadQuote(); }
  catch (e) { $("e-phone").textContent = msg(e); }
};

async function uploadPhotos(files) {
  const { files: slots } = await api("/api/upload-urls", { files: files.map((f) => ({ name: f.name, contentType: f.type })) });
  await Promise.all(slots.map((s, i) => fetch(s.upload_url, { method: s.method, credentials: "same-origin",
    headers: { "Content-Type": s.content_type }, body: files[i] }).then((r) => { if (!r.ok) throw new Error("upload"); })));
  return slots.map((s) => s.public_url);
}

$("submit").onclick = async () => {
  const btn = $("submit"); $("e-form").textContent = "";
  const files = [...$("photos").files];
  if (files.length < 3) { $("e-form").textContent = "צריך לפחות 3 תמונות"; return; }
  btn.disabled = true;
  try {
    const photos_urls = await uploadPhotos(files);
    const o = await api("/api/promo/order", {
      agent_name: $("agent_name").value, city: $("city").value, address: $("address").value,
      price: Number($("price").value), rooms: Number($("rooms").value), size_sqm: Number($("size_sqm").value), photos_urls,
    });
    if (o.pay_url) { location.href = o.pay_url; return; }
    if (o.status === "pending") { show("s-done"); $("done-title").textContent = "ההזמנה התקבלה"; $("done-text").textContent = "נחזור אליך בוואטסאפ לתשלום."; return; }
    pollOrder(o.order_id);
  } catch (e) { $("e-form").textContent = msg(e); btn.disabled = false; }
};

// Back from Cardcom (?order=…), or already logged in.
(async () => {
  const qs = new URLSearchParams(location.search);
  if (qs.get("order")) return pollOrder(qs.get("order"), qs.get("failed") === "1");
  const me = await api("/api/auth/me", null, "GET").catch(() => null);
  if (me && me.userId) { show("s-form"); loadQuote().catch(() => {}); }
})();
</script>
</body>
</html>
```

- [ ] **Step 2: Verify in the browser** — `npm run local`, open http://127.0.0.1:8787/reel. With no `GREENAPI_TOKEN` the OTP is printed in the server log (`[dev] OTP for …`). Walk through phone → code → form (3 photos) → submit. Expected: with Cardcom unset, the "ההזמנה התקבלה" screen; then `POST /api/promo/admin/orders/<id>/mark-paid` as an admin builds the listing. Check the 375px mobile width has no horizontal scroll.
- [ ] **Step 3: Commit**

```bash
git add public-agent/reel.html
git commit -m "feat(promo): /reel landing page — OTP, upload, pay, status"
```

---

### Task 6: Cardcom sandbox end-to-end

- [ ] **Step 1:** Set `CARDCOM_TERMINAL=1000`, `CARDCOM_API_NAME=<test API name from the Cardcom docs>`, `REEL_PROMO_UNTIL=2026-11-06T23:59:59+02:00`, and a public `BASE_URL` (e.g. a tunnel) so Cardcom can reach the webhook.
- [ ] **Step 2:** Run the `/reel` flow with a new phone; pay with Cardcom's test card. Expected: redirect back to `/reel?order=…`, the status turns `building`, the n8n WW1 run starts, and a WhatsApp with the page link arrives.
- [ ] **Step 3:** Re-POST the same webhook body with curl. Expected: `{ ok: true }` and no second listing.
- [ ] **Step 4:** Push the branch and open a PR to `staging`.

---

## Operator setup (you)

1. **Cardcom account:** open a merchant account (clearing agreement + terminal). It can take several business days, so start now.
2. In the Cardcom dashboard create an **API user** and note the terminal number + API name. Enable **documents (receipts)** if you want the automatic קבלה.
3. On the server set: `CARDCOM_TERMINAL`, `CARDCOM_API_NAME`, `REEL_PROMO_UNTIL=2026-11-06T23:59:59+02:00`.
4. Make sure each existing paying client has **paid = true** in the admin client panel — that is what gives them the free first reel.
5. Until Cardcom is live, paid orders wait as `pending`; start them with the admin mark-paid endpoint after collecting payment by hand.
