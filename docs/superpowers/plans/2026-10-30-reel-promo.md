# Reel Promo (/reel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public `/reel` page. Anyone enters a phone number, accepts the terms, verifies by WhatsApp OTP, uploads a property, pays with Cardcom (or gets it free), and receives a narrated reel and a property page on WhatsApp. Every number that started and didn't finish is kept for follow-up.

**Architecture:** `/reel` is a paid front door to the existing `createListing()`. For promo listings, `createListing()` sends to the **"WW1 Walkthrough V4 dev"** n8n workflow (id `az3WzE3YLVzKRoJF`, webhook path `ww1-v4-dev`) instead of the regular WW1. That workflow renders the reel, WhatsApps it, and builds the page. New code:
- a Cardcom adapter (`server/payments/cardcom.js`)
- pricing, orders and leads (`server/promo.js`)
- routes (`server/routes/promo.js`)
- the page (`public-agent/reel.html`)
- an admin tab (`public-agent/admin-promo.js`)

The Cardcom webhook body is never trusted: every payment is re-checked with `GetLpResult`.

**Tech Stack:** Node/Express 4 (server/), Firestore via `server/db.js` (in-memory fallback when `db.db` is null), plain `node x.test.js` assert tests, vanilla HTML/JS in `public-agent/`.

---

## How it works (plain language)

**What the visitor sees on /reel:**
1. **Phone + terms.** They type their WhatsApp number and tick "I agree to the terms of use and privacy policy" (both links open the existing `/legal/terms.html` and `/legal/privacy.html`). The "send me a code" button stays disabled until the box is ticked. *From this moment the number is saved as a lead (stage `otp_sent`).*
2. **Code.** A 6-digit code arrives on WhatsApp and they type it. *Lead stage → `verified`.*
3. **Property form.** Name, city, address, price, rooms, sqm and at least 3 photos. The price is shown before they press the button:
   - an existing paying client's first reel shows "on us 🎁";
   - anyone else's first reel shows ₪59 during the promo, ₪219 after it;
   - any later reel costs ₪49 for clients and ₪219 for everyone else.
4. **Pay.** If the price is ₪0 the reel starts at once. Otherwise they go to Cardcom's secure payment page. *Lead stage → `checkout`.*
5. **Back on /reel** after paying they see "your reel is being made". On WhatsApp, about 15–20 minutes later, they get the reel and then the property page link. *Lead stage → `paid`.* If the payment failed they see "you were not charged" and the lead becomes `payment_failed`.

**What you see in the admin panel**, in a new **"ריל"** tab:
- a **date picker** for the last day of the ₪59 promo. Saving it takes effect immediately; clearing it ends the promo.
- a **leads table** listing every number that started: phone, name, stage, price, last activity, and a WhatsApp button to open a chat. Filtering by "didn't finish" gives you the abandoned carts.
- a **"mark paid"** button on orders that are waiting (`checkout`), for when someone paid you another way or Cardcom isn't live yet. It starts the reel.

**Why it can't be abused:**
- One free reel per phone. A database transaction guarantees it even with two tabs open.
- Prices are computed on the server, never taken from the page.
- A payment counts only after the server asks Cardcom itself whether the order was really paid, and for the right amount.

---

## Global Constraints

- Prices are in ILS, computed on the server only, per phone:
  - Paying client: 1st reel ₪0, each after ₪49.
  - Everyone else: 1st reel ₪59 while `now < promo end`, otherwise ₪219; each after ₪219.
- **"Paying client"**: their quota ledger (admin panel → agent → quotas) has a `plan` that is not empty and not `"trial"`. (`businesses.paid` is never set to true anywhere in the code, so it can't be used.)
- **Promo end** is stored in Firestore `settings/reel_promo` as `{ until_date: "YYYY-MM-DD", until: ISO }` (the end of that day, Israel time). It's set from the admin "ריל" tab. There is no env var for it. No doc or no date means the promo is off.
- "Reels before" means orders for that phone that were started (paid or free). They're counted in `promo_counters/{phone}.started`, which is incremented inside the same transaction that starts the order. The free reel re-checks `started === 0` inside that transaction.
- **Leads** go in `promo_leads/{phone}` with `{ phone, stage, first_seen_at, last_seen_at, terms_accepted_at, agent_name, order_id, price }` (ISO strings).
  - Stages: `otp_sent` → `verified` → `checkout` / `payment_failed` / `paid`.
  - An early stage (`otp_sent`, `verified`) never overwrites a late one (`checkout`, `payment_failed`, `paid`).
  - Late stages overwrite each other, because the latest order wins.
- **Terms:**
  - `/api/promo/lead/start` and `/api/promo/order` both refuse requests without `terms_accepted: true`.
  - The acceptance time is stored on the lead and on the order.
- Flow order: phone + terms → OTP → details and photos → pay → generate.
- The page URL is `/reel`; the file is `public-agent/reel.html`.
- Promo reels do NOT consume the `walkthroughs` quota. The V4 dev workflow never calls `/api/quota/consume`; that was checked in n8n on 2026-10-31.
- Promo listings carry `source: "reel_promo"`. `kickPipeline` sends them to `N8N_REEL_WEBHOOK_URL`, so a retry of a promo listing also goes to the reel workflow.
- Admin writes (save promo date, mark paid) use `[requireAdmin, requireStepUp]`, like `routes/admin-campaigns.js`.
- Secrets come only from env: `CARDCOM_TERMINAL`, `CARDCOM_API_NAME`, `N8N_REEL_WEBHOOK_URL`.
- Express 4 doesn't catch async errors, so every async handler is wrapped in `h()` (shown in Task 3).
- Files stay under 500 lines. No new npm dependencies.

## Decisions

- **Failed or abandoned payment:** the order stays `pending` and the lead `checkout` or `payment_failed`. Nothing is charged and nothing is built. The visitor can submit again, and you can follow up from the leads table.
- **Failed generation:** retry via the existing admin retry, which goes to the reel workflow again because the listing has `source: "reel_promo"`. Refunds are manual, from the Cardcom dashboard.
- **Paid amount ≠ order price:** the order moves to `amount_mismatch` and nothing is built. It's logged for an operator.
- **Unverified numbers** (`otp_sent`) are shown separately in the admin tab. Anyone can type someone else's number, so don't send marketing to unverified numbers. Use them only as a count.
- **No editor in the promo.** Buyers get the reel and the page as generated. The editor being built separately is for existing clients only and isn't part of this plan.
- **Known limit:** two promo-priced orders paid in parallel tabs both get built at ₪59 (the visitor paid for both). Accepted.

---

### Task 0: Verify the things code can't check (no code)

- [ ] **Step 1 (Cardcom field names).** Open https://secure.cardcom.solutions/Api/v11/Docs in a browser. Confirm these for `LowProfile/Create`:
  - request fields: `TerminalNumber, ApiName, Operation, ReturnValue, Amount, ISOCoinId, Language, ProductName, SuccessRedirectUrl, FailedRedirectUrl, WebHookUrl, Document{DocumentTypeToCreate, Name, Mobile, Products[{Description, UnitCost, Quantity}]}`
  - response: `ResponseCode, Description, LowProfileId, Url`

  For `LowProfile/GetLpResult`, confirm:
  - request: `TerminalNumber, ApiName, LowProfileId`
  - response: `ResponseCode, ReturnValue, TranzactionInfo{ResponseCode, Amount, TranzactionId}`

  Also confirm what the webhook POST body contains (expected: `LowProfileId`). If any name differs, use the real name in Task 1 and note it in the commit message.
- [ ] **Step 2 (reel workflow).** Facts read from n8n on 2026-10-31, workflow "WW1 Walkthrough V4 dev":
  - It is **inactive**.
  - Its HTTP nodes call **`https://staging.srv1173890.hstgr.cloud/api/walkthrough/*`** (hard-coded staging).
  - Its "Report Cost" node WhatsApps **the agent** a dev cost line ("fal: H3 $…").
  - Its timeout message says "WW1 V4 dev".
  - It reads `body.phone`, `body.listing_id` and `body.image_urls` (`createListing`'s WW1 payload already has them) and posts the page to the `property-page-builder` webhook.

  Before Task 7, the operator must do Operator guide §C (rename the messages, point Report Cost at the admin, publish), then confirm two things and write the answers here:
  - (a) A listing created on **production** can be planned by the **staging** walkthrough API and built by `property-page-builder`. This holds if both use the same Firestore project; check that `GOOGLE_CLOUD_PROJECT` / the service account in `deploy.env` and `staging.env` match. If they don't match, change the four staging URLs in the workflow to the production host.
  - (b) `property-page-builder` WhatsApps the page link to `business_phone`. If it doesn't, the visitor gets only the video.

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

### Task 2: Pricing, promo end date, orders and leads

**Files:**
- Create: `server/promo.js`
- Test: `server/promo.test.js`
- Modify: `server/package.json` (`test` script: append ` && node promo.test.js`)

**Interfaces:**
- Produces:
  - `priceFor({ paidClient, reelsBefore, now: Date, promoUntil: Date|null }) → { tier: "client_first"|"client"|"promo"|"regular", price }`
  - `endOfDayIsrael("YYYY-MM-DD") → Date` (last ms of that day, Asia/Jerusalem, DST-aware; Invalid Date for a bad string)
  - `createPromoStore({ db })` returns:
    - `createOrder(order) → id`
    - `getOrder(id)`
    - `setOrder(id, patch)`
    - `startedCount(phone)`
    - `start(id, payment|null) → { ok, order } | { ok:false, reason:"not_found"|"already_started"|"already_used" }`
    - `touchLead(phone, stage, extra?)`
    - `listLeads(limit?) → lead[]` (newest activity first)
  - Order shape: `{ id, phone, price, tier, status: "pending"|"paid"|"building"|"failed"|"amount_mismatch", listing, agent_name, use_agent_override, terms_accepted_at, cardcom_lp_id, payment, listing_id, created_at, paid_at }`

- [ ] **Step 1: Write the failing test.** `server/promo.test.js`:

```js
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
  await assert.rejects(s.touchLead("972502", "bogus"), /bad lead stage/);

  console.log("promo.test.js OK");
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it and expect FAIL.** `cd server && node promo.test.js` → `Cannot find module './promo'`.

- [ ] **Step 3: Implement.** `server/promo.js`:

```js
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

// "2026-11-06" → the last millisecond of that day in Israel (DST-aware).
function endOfDayIsrael(date) {
  const guess = new Date(`${date}T23:59:59.999Z`);
  const local = new Date(guess.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - (local - utc));
}

// Pure: what start() decides, given the current docs.
function decideStart(order, started, payment) {
  if (!order) return { ok: false, reason: "not_found" };
  if (order.status !== "pending") return { ok: false, reason: "already_started" };
  if (!payment && started > 0) return { ok: false, reason: "already_used" };
  return { ok: true };
}

// Pure: the lead after this touch. An early stage never hides a late one.
function nextLead(prev, phone, stage, extra, at) {
  const clean = Object.fromEntries(Object.entries(extra || {}).filter(([, v]) => v !== undefined));
  const keep = prev && !LATE.has(stage) && LATE.has(prev.stage);
  return { ...(prev || { phone, first_seen_at: at }), ...clean, stage: keep ? prev.stage : stage, last_seen_at: at };
}

function createPromoStore({ db }) {
  const mem = { orders: new Map(), counters: new Map(), leads: new Map() };
  const orderRef = (id) => db.collection("promo_orders").doc(id);
  const counterRef = (phone) => db.collection("promo_counters").doc(phone);
  const leadRef = (phone) => db.collection("promo_leads").doc(phone);

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
    if (!db) return [...mem.leads.values()].sort((a, b) => (a.last_seen_at < b.last_seen_at ? 1 : -1)).slice(0, limit);
    const q = await db.collection("promo_leads").orderBy("last_seen_at", "desc").limit(limit).get();
    return q.docs.map((d) => d.data());
  }

  return { createOrder, getOrder, setOrder, startedCount, start, touchLead, listLeads };
}

module.exports = { PRICES, priceFor, endOfDayIsrael, decideStart, nextLead, createPromoStore };
```

- [ ] **Step 4: Run it and expect PASS.** `node promo.test.js` → `promo.test.js OK`.
- [ ] **Step 5:** Append ` && node promo.test.js` to the `test` script.
- [ ] **Step 6: Commit.**

```bash
git add server/promo.js server/promo.test.js server/package.json
git commit -m "feat(promo): reel prices, promo end date, orders and leads"
```

---

### Task 3: Promo routes

**Files:**
- Create: `server/routes/promo.js`
- Test: `server/routes/promo.test.js`
- Modify: `server/package.json` (`test` script: append ` && node routes/promo.test.js`)

**Interfaces:**
- Consumes: the Cardcom API (Task 1), `priceFor`, `endOfDayIsrael` and the store (Task 2), and `validateListing` from `server/listing-create.js`.
- Produces: `createPromoRouter({ requireAuth, authSecret, requireAdmin, requireStepUp, store, cardcom, createListing, business, isPaidClient, settings, normalizePhone, baseUrl, now? }) → express.Router`, mounted at `/api/promo`. Routes:

  | Route | Auth | Body | Response |
  |---|---|---|---|
  | `POST /lead/start` | public | `{ phone, terms_accepted: true }` | `{ ok }` / 400 `invalid_phone` / 400 `terms_required` |
  | `POST /lead` | session | `{ stage: "verified" \| "payment_failed" }` | `{ ok }` |
  | `POST /quote` | session | — | `{ tier, price }` |
  | `POST /order` | session | create-form fields + `agent_name` + `terms_accepted: true` | `{ order_id, status: "building" \| "failed" }` or `{ order_id, status: "pending", pay_url \| null }`; errors 400 / 409 / 413 / 502 `payment_unavailable` |
  | `POST /cardcom/webhook` | public | JSON or form, `LowProfileId` | 200 `{ ok }` |
  | `GET /order/:id` | session, owner only | — | `{ status, price, listing_id }` |
  | `GET /admin/settings` | admin | — | `{ until_date, until }` |
  | `PUT /admin/settings` | admin + step-up | `{ until_date: "YYYY-MM-DD" \| null }` | `{ until_date, until }` |
  | `GET /admin/leads` | admin | — | `{ leads }` |
  | `POST /admin/orders/:id/mark-paid` | admin + step-up | — | `{ ok, status }` |

  Dependencies:
  - `business = { get(phone), set(phone, data) }`
  - `isPaidClient(phone) → Promise<boolean>`
  - `settings = { get() → doc|null, set(patch) → doc }`
  - `normalizePhone(raw) → "972…" | null`
  - `createListing(phone, body, agentOverride, extraDeps) → { listing_id } | { error, code }`

- [ ] **Step 1: Write the failing test.** `server/routes/promo.test.js`:

```js
/* routes/promo.js over HTTP with fakes: terms, leads, pricing per phone, free vs paid,
   webhook verification + idempotency, amount mismatch, owner-only status, admin settings + mark-paid. */
const assert = require("assert");
const express = require("express");
const createPromoRouter = require("./promo");
const { createPromoStore } = require("../promo");
const { normalizeAuthPhone } = require("../utils");

const photos = ["https://f/1.jpg", "https://f/2.jpg", "https://f/3.jpg"];
const listing = { city: "תל אביב", price: 2500000, rooms: 4, photos_urls: photos, agent_name: "דנה", terms_accepted: true };

async function withApp(opts, fn) {
  const businesses = new Map(Object.entries(opts.businesses || {}));
  const built = [];
  const lp = { paid: new Map() }; // lowProfileId -> {orderId, amount, approved}
  let promo = opts.promo === undefined ? { until_date: "2026-11-06", until: "2026-11-06T21:59:59.999Z" } : opts.promo;
  const store = createPromoStore({ db: null });
  const cardcom = {
    configured: opts.cardcomConfigured !== false,
    async createPaymentPage({ orderId, amount }) {
      if (opts.cardcomDown) throw new Error("down");
      const id = `lp-${orderId}`; lp[id] = { orderId, amount }; return { lowProfileId: id, url: `https://pay/${id}` };
    },
    async getResult(id) { return lp.paid.get(id) || { orderId: lp[id] && lp[id].orderId, amount: 0, approved: false }; },
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
    createListing: async (phone, body, agent, extra) => { built.push({ phone, body, agent, extra }); return { listing_id: `L${built.length}` }; },
    business: { get: async (p) => businesses.get(p) || null, set: async (p, d) => businesses.set(p, { ...(businesses.get(p) || {}), ...d }) },
    isPaidClient: async (p) => (opts.paidClients || []).includes(p),
    settings: { get: async () => promo, set: async (patch) => (promo = { ...(promo || {}), ...patch }) },
    normalizePhone: normalizeAuthPhone,
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
    let [lead] = await store.listLeads();
    assert.deepStrictEqual([lead.phone, lead.stage, !!lead.terms_accepted_at], ["972501111111", "otp_sent", true]);
    const h = { "x-phone": "972501111111" };
    assert.strictEqual((await req("POST", "/lead", { stage: "paid" }, h)).status, 400, "client can't claim paid");
    await req("POST", "/lead", { stage: "verified" }, h);
    assert.strictEqual((await store.listLeads())[0].stage, "verified");
    // admin sees it; non-admin doesn't
    assert.strictEqual((await req("GET", "/admin/leads")).status, 403);
    assert.strictEqual((await req("GET", "/admin/leads", null, admin)).data.leads.length, 1);
  });

  // New phone: ₪59, pays via Cardcom, webhook builds once, retry doesn't rebuild
  await withApp({}, async ({ req, built, lp, businesses, store }) => {
    const h = { "x-phone": "972501111111" };
    assert.deepStrictEqual((await req("POST", "/quote", {}, h)).data, { tier: "promo", price: 59 });
    assert.strictEqual((await req("POST", "/order", { ...listing, terms_accepted: false }, h)).data.error, "terms_required");
    const o = await req("POST", "/order", listing, h);
    assert.strictEqual(o.status, 200);
    assert.strictEqual(o.data.status, "pending");
    assert.ok(o.data.pay_url.startsWith("https://pay/"));
    assert.strictEqual(businesses.get("972501111111").source, "reel_promo");
    assert.strictEqual(built.length, 0);
    let [lead] = await store.listLeads();
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
    assert.ok(!("terms_accepted" in built[0].body) && !("agent_name" in built[0].body));
    assert.strictEqual((await store.listLeads())[0].stage, "paid");
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

  // Existing paying client: first reel free and built at once (own profile, no override); next is ₪49
  await withApp({ businesses: { "972503333333": { name: "Agent" } }, paidClients: ["972503333333"] }, async ({ req, built }) => {
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

  log("routes/promo.test.js OK");
})().catch((e) => { console.log(e); process.exit(1); });
```

- [ ] **Step 2: Run it and expect FAIL.** `node routes/promo.test.js` → `Cannot find module './promo'`.

- [ ] **Step 3: Implement.** `server/routes/promo.js`:

```js
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
const { validateListing } = require("../listing-create");
const { priceFor, endOfDayIsrael } = require("../promo");

const MAX_LISTING_BYTES = 32 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Express 4 doesn't catch rejected promises: hand them to the error handler.
const h = (fn) => (req, res, next) => fn(req, res).catch(next);

module.exports = function createPromoRouter({ requireAuth, authSecret, requireAdmin, requireStepUp, store, cardcom,
  createListing, business, isPaidClient, settings, normalizePhone, baseUrl, now = () => new Date() }) {
  const router = express.Router();
  const auth = requireAuth(authSecret);
  const adminWrite = [requireAdmin, requireStepUp];

  async function quote(phone) {
    const [paidClient, reelsBefore, s] = await Promise.all([isPaidClient(phone), store.startedCount(phone), settings.get()]);
    return priceFor({ paidClient, reelsBefore, now: now(), promoUntil: s && s.until ? new Date(s.until) : null });
  }

  // Started order → listing with source "reel_promo" → the reel workflow (kickPipeline).
  // Agents without a profile name get their typed name on the page.
  async function build(order) {
    await store.touchLead(order.phone, "paid", { order_id: order.id, price: order.price });
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

  router.post("/lead/start", h(async (req, res) => {
    const body = req.body || {};
    const phone = normalizePhone(String(body.phone || ""));
    if (!phone) return res.status(400).json({ error: "invalid_phone" });
    if (body.terms_accepted !== true) return res.status(400).json({ error: "terms_required" });
    await store.touchLead(phone, "otp_sent", { terms_accepted_at: now().toISOString() });
    res.json({ ok: true });
  }));

  router.post("/lead", auth, h(async (req, res) => {
    const stage = String((req.body && req.body.stage) || "");
    if (stage !== "verified" && stage !== "payment_failed") return res.status(400).json({ error: "invalid_stage" });
    await store.touchLead(req.user.userId, stage);
    res.json({ ok: true });
  }));

  router.post("/quote", auth, h(async (req, res) => { res.json(await quote(req.user.userId)); }));

  router.post("/order", auth, h(async (req, res) => {
    const phone = req.user.userId;
    const { agent_name, terms_accepted, ...listing } = req.body || {};
    const agentName = String(agent_name || "").trim().slice(0, 60);
    if (terms_accepted !== true) return res.status(400).json({ error: "terms_required" });
    if (!agentName) return res.status(400).json({ error: "agent_name is required" });
    const invalid = validateListing(listing);
    if (invalid) return res.status(invalid.code).json({ error: invalid.error });
    if (Buffer.byteLength(JSON.stringify(listing)) > MAX_LISTING_BYTES) return res.status(413).json({ error: "too_large" });

    const [biz, { tier, price }] = await Promise.all([business.get(phone), quote(phone)]);
    if (!biz) await business.set(phone, { source: "reel_promo", name: agentName, created_at: now() });
    const termsAt = now().toISOString();
    const id = await store.createOrder({ phone, price, tier, listing, agent_name: agentName, terms_accepted_at: termsAt,
      use_agent_override: !(biz && biz.name) });
    await store.touchLead(phone, "checkout", { agent_name: agentName, order_id: id, price, terms_accepted_at: termsAt });

    if (price === 0) {
      const s = await store.start(id, null);
      if (!s.ok) return res.status(409).json({ error: s.reason });
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
    const ok = d === null || (typeof d === "string" && DATE_RE.test(d) && !isNaN(endOfDayIsrael(d)));
    if (!ok) return res.status(400).json({ error: "invalid_date" });
    const s = await settings.set({ until_date: d, until: d ? endOfDayIsrael(d).toISOString() : null });
    res.json({ until_date: s.until_date || null, until: s.until || null });
  }));

  router.get("/admin/leads", requireAdmin, h(async (req, res) => { res.json({ leads: await store.listLeads() }); }));

  router.post("/admin/orders/:id/mark-paid", adminWrite, h(async (req, res) => {
    const s = await store.start(req.params.id, { manual: true, by: req.user ? req.user.userId : "admin" });
    if (!s.ok) return res.status(409).json({ error: s.reason });
    res.json({ ok: true, status: await build(s.order) });
  }));

  return router;
};
```

- [ ] **Step 4: Run it and expect PASS.** `node routes/promo.test.js` → `routes/promo.test.js OK`.
- [ ] **Step 5:** Append ` && node routes/promo.test.js` to the `test` script.
- [ ] **Step 6: Commit.**

```bash
git add server/routes/promo.js server/routes/promo.test.js server/package.json
git commit -m "feat(promo): /api/promo — leads, terms, quote, order, Cardcom webhook, admin date + mark-paid"
```

---

### Task 4: Send promo listings to the reel workflow

**Files:**
- Modify: `server/listing-create.js`:
  - the `createListing` deps destructure (around line 44)
  - the `kickPipeline(...)` call (line 100)
  - `kickPipeline` (around lines 106–109)
- Test: `server/listing-create.test.js` (after the "retry replays the stored listing" block, around line 34)

**Interfaces:**
- Produces: a new dep `n8nReelWebhook` for `createListing`/`kickPipeline`/`retryListing`. A listing with `source === "reel_promo"` is POSTed to `n8nReelWebhook` with the unchanged WW1 payload. It never falls back to `n8nWw1Webhook`, because the regular WW1 makes a different video from the one the buyer paid for.

- [ ] **Step 1: Write the failing test.** Insert into `server/listing-create.test.js` after the `assert.deepEqual([hooks[0][1].listing_id, …` line:

```js
  // ── a promo listing goes to the reel workflow (create and retry), never to WW1 ──
  const reelHooks = [];
  const reelDeps = { ...deps, n8nReelWebhook: "https://n8n/reel",
    fetchFn: async (url, opts) => { reelHooks.push([url, JSON.parse(opts.body)]); return { status: 200 }; } };
  await db.saveListing({ listing_id: "R2", business_phone: "P1", source: "reel_promo", status: "failed", page_id: null,
    created_at: old, city: "חיפה", price: 1, rooms: 3, photos_urls: ["a", "b", "c"], own_video_url: null, language: "he" });
  await retryListing(await db.getListing("R2"), reelDeps);
  assert.deepEqual([reelHooks[0][0], reelHooks[0][1].listing_id, reelHooks[0][1].phone], ["https://n8n/reel", "R2", "P1"]);
  await retryListing({ ...(await db.getListing("R2")), status: "failed" }, { ...reelDeps, n8nReelWebhook: "" });
  assert.equal(reelHooks.length, 1, "no reel webhook configured → nothing sent (not WW1)");
```

- [ ] **Step 2: Run it and expect FAIL.** `node listing-create.test.js` → AssertionError (`https://n8n/ww1` !== `https://n8n/reel`).

- [ ] **Step 3: Implement.** In `server/listing-create.js`:
  - Add `n8nReelWebhook` to the doc-comment deps line and to the `createListing` destructure.
  - Pass it on: `kickPipeline(listing, { n8nWw1Webhook, n8nReelWebhook, n8nPipelineWebhook, isDevRun, isDevPipelineRun, baseUrl, fetchFn });`
  - In `kickPipeline`, replace the destructure and the `webhook` line with:

```js
  const { n8nWw1Webhook, n8nReelWebhook, n8nPipelineWebhook, isDevRun, isDevPipelineRun, baseUrl, fetchFn = fetch } = deps;
  const listingId = listing.listing_id, phone = listing.business_phone;
  // /reel buyers paid for the reel workflow; never fall back to the regular WW1.
  const webhook = listing.own_video_url ? n8nPipelineWebhook
    : listing.source === "reel_promo" ? n8nReelWebhook : n8nWw1Webhook;
```

  Then, after the existing `if (webhook) { … }` block, add:

```js
  else console.error(`pipeline webhook not configured for listing ${listingId} (source ${listing.source || "?"})`);
```

- [ ] **Step 4: Run it and expect PASS.** `node listing-create.test.js` → passes, and `npm test` → all pass.
- [ ] **Step 5: Commit.**

```bash
git add server/listing-create.js server/listing-create.test.js
git commit -m "feat(promo): reel_promo listings go to the reel n8n workflow"
```

---

### Task 5: Wire into the server and add the `/reel` URL

**Files:**
- Modify: `server/index.js`:
  - consts near line 67
  - the three `createListing`/retry deps objects (around lines 240, 271 and 413)
  - after the `/instructions` route (around line 193)
  - after the `/api/quota` mount (around line 224)

**Interfaces:**
- Consumes: `createCardcom` (Task 1), `createPromoStore` (Task 2) and `createPromoRouter` (Task 3).
- Also uses what index.js already has: `requireAuth`, `requireAdmin` (line 130), `requireStepUp` (line 131), `rateLimit`, `db`, `quota`, `BASE_URL`, the `N8N_*` consts and `normalizeAuthPhone` (from `./utils`; check how index.js already imports it and reuse that import).

- [ ] **Step 1: Add the env const** next to `N8N_WW1_WEBHOOK_URL` (line 67):

```js
const N8N_REEL_WEBHOOK_URL = process.env.N8N_REEL_WEBHOOK_URL || ""; // "WW1 Walkthrough V4 dev" — /reel promo listings
```

- [ ] **Step 2: Add `n8nReelWebhook: N8N_REEL_WEBHOOK_URL,`** to each of the three deps objects that already contain `n8nWw1Webhook: N8N_DEV_WEBHOOK_URL || N8N_WW1_WEBHOOK_URL` (`grep -n "n8nWw1Webhook:" server/index.js`). Then a retry from the admin panel or the dashboard re-sends a promo listing to the reel workflow. Also add one startup log line next to the existing `WW1 webhook:` log:

```js
  console.log(`  reel webhook: ${N8N_REEL_WEBHOOK_URL || "(not set — /reel orders will not build)"}`);
```

- [ ] **Step 3: Add the `/reel` page route** after the `/instructions` route:

```js
// Reel promo landing page (public; the page itself does OTP login).
app.get(/^\/reel\/?$/, (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "..", "public-agent", "reel.html"));
});
```

- [ ] **Step 4: Mount the API** after the `/api/quota` mount:

```js
// ── reel promo (/reel): terms → OTP → listing → Cardcom → reel workflow. See routes/promo.js ──
// CARDCOM_TERMINAL / CARDCOM_API_NAME: Cardcom API user; unset ⇒ orders wait for an
// admin "mark paid". The promo end date is settings/reel_promo (admin "ריל" tab).
const { createCardcom } = require("./payments/cardcom");
const { createPromoStore } = require("./promo");
app.use("/api/promo/lead/start", rateLimit({ windowMs: 60_000, max: 10 }));
app.use("/api/promo/order", rateLimit({ windowMs: 60_000, max: 10 }));
app.use("/api/promo/cardcom/webhook", rateLimit({ windowMs: 60_000, max: 60 }));
app.use("/api/promo", require("./routes/promo")({
  requireAuth, authSecret: AUTH_SECRET, requireAdmin, requireStepUp,
  store: createPromoStore({ db: db.db }),
  cardcom: createCardcom({ terminal: process.env.CARDCOM_TERMINAL, apiName: process.env.CARDCOM_API_NAME }),
  createListing: (phone, body, agent, extra) => require("./listing-create").createListing(phone, body, agent, {
    n8nWw1Webhook: N8N_DEV_WEBHOOK_URL || N8N_WW1_WEBHOOK_URL, n8nReelWebhook: N8N_REEL_WEBHOOK_URL,
    n8nPipelineWebhook: N8N_DEV_PIPELINE_WEBHOOK_URL || N8N_PIPELINE_WEBHOOK_URL,
    isDevRun: !!N8N_DEV_WEBHOOK_URL, isDevPipelineRun: !!N8N_DEV_PIPELINE_WEBHOOK_URL, baseUrl: BASE_URL, ...extra,
  }),
  business: { get: (p) => db.getBusiness(p), set: (p, d) => db.setBusiness(p, d) },
  // A paying client = a quota plan the admin set that isn't the trial seed.
  isPaidClient: async (p) => {
    const q = await quota.getQuota(p).catch(() => null);
    const plan = String((q && q.plan) || "").trim().toLowerCase();
    return !!plan && plan !== "trial";
  },
  settings: { get: () => db.getSetting("reel_promo"), set: (patch) => db.setSetting("reel_promo", patch) },
  normalizePhone: normalizeAuthPhone,
  baseUrl: BASE_URL,
}));
```

- [ ] **Step 5: Smoke test locally.** Run `cd server && npm run local`, then:

```bash
curl -s -X POST http://127.0.0.1:8787/api/promo/quote -o /dev/null -w "%{http_code}\n"
curl -s -X POST http://127.0.0.1:8787/api/promo/lead/start -H 'Content-Type: application/json' -d '{"phone":"0501234567","terms_accepted":true}'
```

Expected: `401`, then `{"ok":true}`. (`/reel` returns 404 until Task 6 adds the file.)

- [ ] **Step 6: Run the full suite.** `npm test` → all pass.
- [ ] **Step 7: Commit.**

```bash
git add server/index.js
git commit -m "feat(promo): mount /api/promo, serve /reel, pass the reel webhook to every pipeline kick"
```

---

### Task 6: The `/reel` landing page

**Files:**
- Create: `public-agent/reel.html`

**Interfaces:**
- Consumes:
  - `POST /api/auth/otp {phone}`
  - `POST /api/auth/otp/verify {phone, code}` (sets the `forly_session` cookie)
  - `GET /api/auth/me` → `{ userId }`
  - `POST /api/upload-urls {files:[{name, contentType}]}` → `{files:[{upload_url, method, content_type, public_url}]}`, then a PUT to each `upload_url`
  - the Task 3 promo routes

- [ ] **Step 1: Create the page.** `public-agent/reel.html`:

```html
<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Forly — סרטון רילס לנכס</title>
<link rel="icon" href="/favicon.png">
<style>
  :root { --bg:#0f1115; --card:#181b22; --fg:#f2f2f2; --muted:#9aa0aa; --accent:#ff5a36; --err:#ff6b6b; --line:#2a2f3a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif; }
  main { max-width:480px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:28px; margin:8px 0; } p.lead { color:var(--muted); margin:0 0 20px; }
  section { background:var(--card); border-radius:14px; padding:18px; margin-bottom:16px; }
  label { display:block; font-size:14px; color:var(--muted); margin:12px 0 4px; }
  input { width:100%; padding:12px; border-radius:10px; border:1px solid var(--line); background:var(--bg); color:var(--fg); font-size:16px; }
  label.terms { display:flex; gap:10px; align-items:flex-start; color:var(--fg); line-height:1.4; }
  label.terms input { width:22px; height:22px; flex:none; margin:0; }
  a { color:var(--accent); }
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
    <label class="terms" for="terms">
      <input id="terms" type="checkbox">
      <span>קראתי ואני מסכים/ה ל<a href="/legal/terms.html" target="_blank" rel="noopener">תנאי השימוש</a>
        ול<a href="/legal/privacy.html" target="_blank" rel="noopener">מדיניות הפרטיות</a></span>
    </label>
    <button id="send" disabled>שלחו לי קוד</button>
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
const ERR = {
  invalid_code: "הקוד שגוי", code_expired: "הקוד פג, שלחו שוב", invalid_phone: "מספר הטלפון לא תקין",
  terms_required: "צריך לאשר את תנאי השימוש", already_used: "כבר קיבלת סרטון חינם במספר הזה",
  payment_unavailable: "מערכת התשלום לא זמינה כרגע, נסו שוב בעוד כמה דקות",
};
const msg = (e) => ERR[e.message] || "משהו השתבש, נסו שוב";
const lead = (stage) => api("/api/promo/lead", { stage }).catch(() => {}); // best effort: never blocks the visitor

async function loadQuote() {
  const q = await api("/api/promo/quote", {});
  $("quote").textContent = q.price === 0 ? "הסרטון הראשון עלינו 🎁" : `₪${q.price}`;
  $("submit").textContent = q.price === 0 ? "צרו לי סרטון" : `לתשלום ₪${q.price}`;
}

async function pollOrder(id, failed) {
  show("s-done");
  if (failed) {
    lead("payment_failed");
    $("done-title").textContent = "התשלום לא הושלם";
    $("done-text").innerHTML = 'לא חויבת. <a href="/reel">לנסות שוב</a>';
    return;
  }
  for (let i = 0; i < 20; i++) {
    const o = await api(`/api/promo/order/${encodeURIComponent(id)}`, null, "GET").catch(() => null);
    if (o && o.status === "building") return;
    if (o && o.status === "failed") { $("done-title").textContent = "משהו השתבש ביצירה"; $("done-text").textContent = "ניצור איתך קשר בוואטסאפ."; return; }
    if (o && o.status === "pending") $("done-text").textContent = "ממתינים לאישור התשלום…";
    await new Promise((r) => setTimeout(r, 3000));
  }
}

$("terms").onchange = () => { $("send").disabled = !$("terms").checked; };
$("send").onclick = async () => {
  $("e-phone").textContent = "";
  if (!$("terms").checked) { $("e-phone").textContent = ERR.terms_required; return; }
  try {
    await api("/api/promo/lead/start", { phone: $("phone").value, terms_accepted: true });
    await api("/api/auth/otp", { phone: $("phone").value });
    $("code-wrap").hidden = false; $("code").focus();
  } catch (e) { $("e-phone").textContent = msg(e); }
};
$("verify").onclick = async () => {
  $("e-phone").textContent = "";
  try {
    await api("/api/auth/otp/verify", { phone: $("phone").value, code: $("code").value });
    lead("verified");
    show("s-form"); await loadQuote();
  } catch (e) { $("e-phone").textContent = msg(e); }
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
      price: Number($("price").value), rooms: Number($("rooms").value), size_sqm: Number($("size_sqm").value),
      photos_urls, terms_accepted: true,
    });
    if (o.pay_url) { location.href = o.pay_url; return; }
    if (o.status === "pending") { show("s-done"); $("done-title").textContent = "ההזמנה התקבלה"; $("done-text").textContent = "נחזור אליך בוואטסאפ לתשלום."; return; }
    pollOrder(o.order_id);
  } catch (e) { $("e-form").textContent = msg(e); btn.disabled = false; }
};

// Back from Cardcom (?order=…), or already logged in (terms were accepted then).
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

  A visitor who is already logged in skips the terms box, but `POST /order` still sends `terms_accepted: true`. The order button itself means "I agree", so add the line `<p class="lead" style="font-size:13px">בלחיצה על המשך אני מאשר/ת את <a href="/legal/terms.html" target="_blank" rel="noopener">תנאי השימוש</a></p>` right above `<button id="submit">`.

- [ ] **Step 2: Verify in the browser.** Run `npm run local` and open http://127.0.0.1:8787/reel. With no `GREENAPI_TOKEN`, the OTP is printed in the server log (`[dev] OTP for …`). Check:
  - The send button stays disabled until the box is ticked, and both links open.
  - Walk phone → code → form (3 photos) → submit. With Cardcom unset you should see "ההזמנה התקבלה".
  - At 375px mobile width there's no horizontal scroll.
- [ ] **Step 3: Commit.**

```bash
git add public-agent/reel.html
git commit -m "feat(promo): /reel landing page — terms, OTP, upload, pay, status"
```

---

### Task 7: Admin "ריל" tab — promo end date, leads, mark paid

**Files:**
- Create: `public-agent/admin-promo.js`
- Modify: `public-agent/admin.html`:
  - a tab button in `.tabs` (line ~252)
  - a pane after `#paneCampaigns`
  - a script tag after `admin-campaigns.js` (line ~722)

**Interfaces:**
- Consumes: `GET/PUT /api/promo/admin/settings`, `GET /api/promo/admin/leads`, `POST /api/promo/admin/orders/:id/mark-paid` (Task 3), and the `FLY.req`, `FLY.esc` and `FLY.toast` helpers (`public-agent/api.js`, used the same way as `admin-campaigns.js`).

- [ ] **Step 1: Add the markup** to `public-agent/admin.html`. In `.tabs`, after `<button id="tabCampaigns">קמפיינים</button>`:

```html
    <button id="tabPromo">ריל</button>
```

After the closing `</div>` of `#paneCampaigns`:

```html
  <!-- ── REEL PROMO (admin-promo.js) ── -->
  <div id="panePromo" class="hidden">
    <div class="posting-warn hidden" id="promoStepUp">נדרש אימות מחדש — התחברו שוב</div>
    <section class="message-card" style="margin-bottom:16px">
      <h2>מבצע ₪59</h2>
      <p>היום האחרון של המבצע (עד 23:59 שעון ישראל). ריק = אין מבצע, המחיר ₪219.</p>
      <div class="toolbar">
        <input type="date" id="promoUntil" aria-label="סוף המבצע">
        <button class="btn btn-primary" id="promoSave">שמירה</button>
        <button class="btn" id="promoClear">סיום מבצע</button>
        <span class="who" id="promoState"></span>
      </div>
    </section>
    <div class="toolbar" style="margin-bottom:12px">
      <select id="promoStage" aria-label="שלב">
        <option value="open">לא סיימו (אומתו ולא שילמו)</option>
        <option value="">הכול</option>
        <option value="otp_sent">לא אימתו קוד</option>
        <option value="verified">אומתו, לא הזמינו</option>
        <option value="checkout">בתשלום — לא הושלם</option>
        <option value="payment_failed">תשלום נכשל</option>
        <option value="paid">שילמו / קיבלו</option>
      </select>
      <span class="who num" id="promoCount"></span>
    </div>
    <div class="table-wrap">
      <table class="admin" style="min-width:640px">
        <thead><tr><th>טלפון</th><th>שם</th><th>שלב</th><th>מחיר</th><th>פעילות אחרונה</th><th></th></tr></thead>
        <tbody id="promoLeads"></tbody>
      </table>
    </div>
  </div>
```

After `<script src="/admin-campaigns.js"></script>`:

```html
<script src="/admin-promo.js"></script>
```

- [ ] **Step 2: Create** `public-agent/admin-promo.js`:

```js
/*
 * admin-promo.js — the admin's "ריל" tab (routes/promo.js): the ₪59 promo's
 * last day, every number that started /reel and how far it got, and "mark
 * paid" for a waiting order. Writes need a fresh step-up, like campaigns.
 */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = FLY.esc;
  var API = "/api/promo/admin";
  var rows = [];
  var STAGE = { otp_sent: "לא אימת קוד", verified: "אומת, לא הזמין", checkout: "בתשלום — לא הושלם", payment_failed: "תשלום נכשל", paid: "שילם / קיבל" };
  var OPEN = { verified: 1, checkout: 1, payment_failed: 1 };
  var fmt = function (v) { var d = new Date(v); return isNaN(d) ? "—" : d.toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }); };

  function req(method, path, body) {
    return FLY.req(API + path, { method: method, body: body, noRedirect: true }).then(function (d) { $("#promoStepUp").classList.add("hidden"); return d; });
  }
  function fail(e) {
    if (e && e.status === 401 && e.code === "stepup_required") { $("#promoStepUp").classList.remove("hidden"); FLY.toast("נדרש אימות מחדש — התחברו שוב"); return; }
    FLY.toast(e && e.code === "already_started" ? "ההזמנה כבר טופלה" : "הפעולה נכשלה");
  }

  function showSettings(s) {
    $("#promoUntil").value = s.until_date || "";
    $("#promoState").textContent = s.until_date ? "המבצע פעיל עד " + new Date(s.until_date).toLocaleDateString("he-IL") : "אין מבצע כרגע";
  }

  function render() {
    var f = $("#promoStage").value;
    var list = rows.filter(function (r) { return f === "open" ? OPEN[r.stage] : !f || r.stage === f; });
    $("#promoCount").textContent = list.length + " מספרים";
    $("#promoLeads").innerHTML = list.map(function (r) {
      // Unverified numbers may belong to someone else: no WhatsApp button for them.
      var wa = r.stage === "otp_sent" ? "" : '<a class="btn" target="_blank" rel="noopener" href="https://wa.me/' + esc(r.phone) + '">וואטסאפ</a> ';
      var pay = (r.stage === "checkout" || r.stage === "payment_failed") && r.order_id ? '<button class="btn" data-paid="' + esc(r.order_id) + '">סמן כשולם</button>' : "";
      return "<tr><td class=\"num\">" + esc(r.phone) + "</td><td>" + esc(r.agent_name || "—") + "</td><td>" + esc(STAGE[r.stage] || r.stage) +
        "</td><td class=\"num\">" + (r.price == null ? "—" : "₪" + esc(String(r.price))) + "</td><td>" + fmt(r.last_seen_at) + "</td><td>" + wa + pay + "</td></tr>";
    }).join("") || '<tr><td colspan="6">אין עדיין</td></tr>';
  }

  function load() {
    return Promise.all([req("GET", "/settings"), req("GET", "/leads")]).then(function (a) {
      showSettings(a[0]); rows = a[1].leads || []; render();
    }, fail);
  }

  function save(date) {
    return req("PUT", "/settings", { until_date: date }).then(function (s) { showSettings(s); FLY.toast("נשמר"); }, fail);
  }

  $("#promoSave").addEventListener("click", function () {
    var d = $("#promoUntil").value;
    if (!d) { FLY.toast("בחרו תאריך"); return; }
    save(d);
  });
  $("#promoClear").addEventListener("click", function () { if (confirm("לסיים את המבצע עכשיו?")) save(null); });
  $("#promoStage").addEventListener("change", render);
  $("#promoLeads").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-paid]"); if (!b || b.disabled) return;
    if (!confirm("לסמן כשולם ולהתחיל ליצור את הסרטון?")) return;
    b.disabled = true;
    req("POST", "/orders/" + encodeURIComponent(b.getAttribute("data-paid")) + "/mark-paid", {})
      .then(function () { FLY.toast("הסרטון בהכנה"); return load(); }, fail)
      .then(function () { b.disabled = false; });
  });

  // ── tab wiring (like admin-campaigns.js) ──
  var tab = $("#tabPromo"), pane = $("#panePromo");
  if (!tab || !pane) return;
  tab.addEventListener("click", function () {
    document.querySelectorAll(".tabs button").forEach(function (b) { b.classList.toggle("on", b === tab); });
    document.querySelectorAll("#viewAdmin [id^='pane']").forEach(function (p) { p.classList.toggle("hidden", p !== pane); });
    load();
  });
  document.querySelectorAll(".tabs button").forEach(function (b) {
    if (b !== tab) b.addEventListener("click", function () { tab.classList.remove("on"); pane.classList.add("hidden"); });
  });
})();
```

- [ ] **Step 3: Verify in the browser.** Run `npm run local` and log in as admin at http://127.0.0.1:8787/admin.html. Check each of these:
  - The "ריל" tab opens and the other tabs still switch.
  - Pick a date, save, and reload: the date is still there and `/reel` quotes ₪59.
  - "סיום מבצע" makes it ₪219.
  - The lead from Task 6 shows up under "לא סיימו".
  - "סמן כשולם" turns it into `paid`, and the server log shows the reel webhook POST, or "not configured" if the env var is unset.
- [ ] **Step 4: Commit.**

```bash
git add public-agent/admin-promo.js public-agent/admin.html
git commit -m "feat(promo): admin ריל tab — promo end date, leads, mark paid"
```

---

### Task 8: End-to-end on staging with the Cardcom test terminal

Prerequisites: Operator guide §B and §C done on **staging** (`staging.env` has `CARDCOM_TERMINAL=1000`, the test `CARDCOM_API_NAME` and `N8N_REEL_WEBHOOK_URL`), and Task 0 Step 2 answered.

- [ ] **Step 1:** Deploy the branch to staging. In the admin "ריל" tab, set the promo end to a week from today.
- [ ] **Step 2:** Run the `/reel` flow with a phone that is not a paying client, and pay with the Cardcom test card from their docs. Expected:
  - a redirect back to `/reel?order=…` and "הסרטון בהכנה";
  - the lead shows `paid` in the admin;
  - the n8n "WW1 Walkthrough V4 dev" execution starts;
  - within about 20 minutes the reel arrives on WhatsApp, then the page link;
  - the cost line goes to the **admin** phone, not the buyer.
- [ ] **Step 3:** Re-POST the same webhook (`curl -X POST $BASE/api/promo/cardcom/webhook -d LowProfileId=<id>`). Expected: `{"ok":true}` and no second n8n execution.
- [ ] **Step 4:** Run the flow again with a phone whose quota plan is not "trial". Expected: "הסרטון הראשון עלינו 🎁", no Cardcom page, and the reel arrives.
- [ ] **Step 5:** Abandon one checkout on purpose (close the Cardcom tab). Expected: it appears under "לא סיימו" with a WhatsApp button and "סמן כשולם".
- [ ] **Step 6:** Push the branch and open a PR to `staging`.

---

## Operator guide (what you do, step by step)

Do **A** first because it takes days. B to D take about 30 minutes on launch day.

### A. Cardcom account (start today)
1. Go to https://www.cardcom.solutions and choose "הצטרפות" (or phone their sales line from the site). Tell them: **"I need a clearing terminal with the LowProfile API (API v11) for a hosted payment page, plus the documents module for automatic receipts."**
2. Have these ready. They usually ask for:
   - ID
   - your עוסק פטור/מורשה certificate or company registration
   - a bank-account confirmation (אישור ניהול חשבון or a cancelled cheque)
   - your website address

   The credit-card companies check that the website shows **terms of use, a privacy policy, a cancellation/refund policy, and the business name, address and phone**. See §G.
3. Approval usually takes several business days. **Until then, build and test with the public test terminal 1000** (Task 8). The site also works without Cardcom: orders wait in the "ריל" tab, and you press "סמן כשולם" after the customer pays you another way (Bit, transfer).
4. When the account is live, log in to the Cardcom dashboard and find the API settings ("הגדרות" → "ממשקים / API"; the names may differ). Create an **API user** and write down two values: the **terminal number** (מספר מסוף) and the **API name** (ApiName). If you can't find them, ask Cardcom support: "what is the ApiName for terminal ___ for LowProfile API v11?"
5. In the documents module, choose the document type: **קבלה** if you're an עוסק פטור, **חשבונית מס קבלה** if you're an עוסק מורשה. Tell the developer which one; Task 1 currently sends `DocumentTypeToCreate: "Receipt"`, and Task 0 Step 1 confirms the exact value for your type.

### B. Server settings (on launch day; staging first, then production)
1. `ssh root@31.97.216.242`
2. Open the env file of the environment you're setting up: `staging.env` for staging, `deploy.env` for production (see `docs/dev-staging-setup.md`). Add these three lines:
   ```
   CARDCOM_TERMINAL=<terminal number from A4, or 1000 for testing>
   CARDCOM_API_NAME=<ApiName from A4, or the test ApiName from the Cardcom docs>
   N8N_REEL_WEBHOOK_URL=https://n8n.srv1173890.hstgr.cloud/webhook/ww1-v4-dev
   ```
3. Restart the Forly container the way you normally deploy. In the container log, check that the startup lines show `reel webhook: https://n8n…/ww1-v4-dev` and not `(not set …)`.

### C. n8n: make "WW1 Walkthrough V4 dev" customer-safe (by hand, in the n8n editor)
Open https://n8n.srv1173890.hstgr.cloud/workflow/az3WzE3YLVzKRoJF.
1. **"Report Cost" node:** it currently WhatsApps the cost breakdown (`fal: H3 $…`) **to the buyer**. In its `to` field, replace `{{ $("Start (webhook)").first().json.body.phone }}@c.us` with your own number, e.g. `9725XXXXXXXX@c.us`.
2. **"Send Timeout Message" node:** change the text to something a customer can read, e.g. `הסרטון שלך לוקח קצת יותר זמן מהרגיל — נשלח אותו בהקדם 🙏`. It's also worth sending yourself a copy: duplicate the node with your number.
3. **Errors:** if a clip fails, the "Check Status" node stops the run and the buyer gets nothing. Open the workflow's **Settings → Error workflow** and pick a workflow that WhatsApps you. If you don't have one, check **Executions** for failed runs twice a day during the promo.
4. **Staging vs production:** four nodes call `https://staging.srv1173890.hstgr.cloud/api/walkthrough/...`. If Task 0 Step 2(a) found that staging and production use different Firestore projects, change those four URLs to the production host.
5. Optionally rename the workflow to "WW1 Reel (promo)".
6. Click **Publish / Activate**. The production URL is `https://n8n.srv1173890.hstgr.cloud/webhook/ww1-v4-dev`, which is what §B puts in `N8N_REEL_WEBHOOK_URL`.

### D. Mark your paying clients
The first reel is free only for clients whose quota **plan** is set.
1. Admin panel → "סוכנים ופיצ׳רים" → open each paying client → quotas section.
2. Set "תוכנית" to anything except empty or `trial` (e.g. `pro`) and save.
3. Leave trial users empty or `trial`. They pay ₪59 like everyone else.

### E. Start the promo
1. Admin panel → **"ריל"** → pick the last day of the promo (e.g. a week from launch) → **שמירה**. The status line shows "המבצע פעיל עד …".
2. Test it yourself once (§F), then share `https://<your BASE_URL>/reel`, the same domain your dashboard runs on.
3. To stop early, press **"סיום מבצע"**. New visitors then see ₪219.

### F. Your launch-day test (10 minutes)
1. In a private browser window, go to `/reel` with a phone that is not a paying client. Tick the terms, enter the code, fill the form with 3 photos, and pay.
2. You should get the reel on WhatsApp, then the page link. The cost line should reach only your admin number.
3. In the "ריל" tab, the number shows "שילם / קיבל".

### G. Terms page (before launch, because Cardcom checks it)
Add a short section to `/legal/terms.html` about the paid reel:
- what's delivered (a narrated reel and a property page on WhatsApp);
- the price;
- delivery time (usually under an hour);
- the refund rule, e.g. a full refund if the reel isn't delivered within 24 hours;
- the business name, address and phone.

Have a lawyer or accountant check the refund wording against Israeli consumer-protection rules. Changing this page needs no code; it's a static file.

### H. Every day during the promo
1. Open the "ריל" tab with the filter on **"לא סיימו"**: people who verified their number but didn't pay.
2. Press **וואטסאפ** to message them, for example to offer help or remind them the ₪59 price ends on that date.
3. "לא אימת קוד" numbers have no button on purpose: anyone can type someone else's number.
4. If someone paid you outside Cardcom, press **"סמן כשולם"** on their row and the reel starts.
