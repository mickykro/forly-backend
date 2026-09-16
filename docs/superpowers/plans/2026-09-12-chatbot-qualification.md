# Chatbot Qualification and Budget Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The landing-page chat lead form captures budget, timeline and financing, and on submit the visitor and the agent both get up to 3 of the agent's other listings that fit the budget.

**Architecture:** Two new pure modules (`chat-qualify.js` for validation, offer decision and WhatsApp lines; `chat-recommend.js` for the budget matcher) plugged into the existing `/api/chat` and `/api/chat/handoff` routes. The LLM prompt is untouched: asking happens in the form, recommending happens in deterministic code. The widget gains three fields, a proactive offer, and link cards.

**Tech Stack:** Node.js (CommonJS), Express, Firestore via `server/db.js` with an in-memory fallback, plain `node` + `assert` tests, vanilla JS widget.

Spec: `docs/superpowers/specs/2026-09-12-chatbot-qualification-design.md`

## Global Constraints

- Files stay under 500 lines. New server files under 200 lines.
- Tests are plain scripts using `require("assert")`, run with `node server/<file>.test.js`, and registered in the `test` script of `server/package.json`.
- Run `cd server && npm test` before every commit.
- Never change the model prompt in `server/chat-prompt.js`.
- Timeline enum: `now`, `1_3m`, `3_6m`, `6m_plus`, `looking`. Financing enum: `mortgage`, `pre_approved`, `cash`, `selling_first`, `unsure`.
- Budget: positive integer, max `1000000000`. Match band: ±15%. Max 3 matches.
- New config limit: `offer_form_after_msgs: 3`.
- Commit messages end with the attribution trailer given in the session (no model id in code or docs).

---

### Task 1: `chat-qualify.js` — validation, offer decision, WhatsApp lines

**Files:**
- Create: `server/chat-qualify.js`
- Test: `server/chat-qualify.test.js`
- Modify: `server/package.json` (add test to `test` script)

**Interfaces:**
- Produces:
  - `parseQualification(body) -> { ok: true, value: { budget, timeline, financing } } | { ok: false, error: "invalid_budget" }`
  - `shouldOfferForm(convo, limits, answered) -> boolean`
  - `qualificationLines(q, listingType) -> string[]` (Hebrew, one line per present field)
  - `TIMELINE_LABELS`, `FINANCING_LABELS` (objects keyed by enum value)

- [ ] **Step 1: Write the failing test**

```js
/*
 * Unit tests for chat-qualify.js — form validation, the proactive offer
 * decision, and the Hebrew lines the agent sees.
 * Run: node server/chat-qualify.test.js
 */
const assert = require("assert");
const {
  parseQualification, shouldOfferForm, qualificationLines,
  TIMELINE_LABELS, FINANCING_LABELS, MAX_BUDGET,
} = require("./chat-qualify");

// ── parseQualification: budget ──
assert.deepEqual(parseQualification({ budget: 2300000 }).value,
  { budget: 2300000, timeline: null, financing: null });
assert.equal(parseQualification({ budget: "2,300,000" }).value.budget, 2300000, "digits-only coercion");
assert.equal(parseQualification({ budget: " 6000 " }).value.budget, 6000);
assert.equal(parseQualification({ budget: 2300000.7 }).value.budget, 2300000, "floors");
assert.equal(parseQualification({}).ok, false);
assert.equal(parseQualification({}).error, "invalid_budget");
assert.equal(parseQualification({ budget: 0 }).ok, false);
assert.equal(parseQualification({ budget: -5 }).ok, false);
assert.equal(parseQualification({ budget: "abc" }).ok, false);
assert.equal(parseQualification({ budget: MAX_BUDGET + 1 }).ok, false);
assert.equal(parseQualification({ budget: MAX_BUDGET }).ok, true);

// ── parseQualification: enums normalised, unknowns become null, never reject ──
let q = parseQualification({ budget: 1, timeline: "1_3m", financing: "cash" }).value;
assert.equal(q.timeline, "1_3m");
assert.equal(q.financing, "cash");
q = parseQualification({ budget: 1, timeline: "soon", financing: 42 }).value;
assert.equal(q.timeline, null);
assert.equal(q.financing, null);
for (const k of Object.keys(TIMELINE_LABELS)) assert.equal(parseQualification({ budget: 1, timeline: k }).value.timeline, k);
for (const k of Object.keys(FINANCING_LABELS)) assert.equal(parseQualification({ budget: 1, financing: k }).value.financing, k);

// ── shouldOfferForm ──
const lim = { offer_form_after_msgs: 3 };
const base = () => ({ message_count: 3, lead: { captured: false }, handoff: { triggered: false }, form_offered: false });
assert.equal(shouldOfferForm(base(), lim, true), true, "3rd answered turn ⇒ offer");
assert.equal(shouldOfferForm({ ...base(), message_count: 2 }, lim, true), false, "too early");
assert.equal(shouldOfferForm({ ...base(), message_count: 4 }, lim, true), false, "only exactly at N — never nags");
assert.equal(shouldOfferForm(base(), lim, false), false, "unanswered turn is the handoff path, not the offer");
assert.equal(shouldOfferForm({ ...base(), form_offered: true }, lim, true), false, "once per conversation");
assert.equal(shouldOfferForm({ ...base(), handoff: { triggered: true } }, lim, true), false, "handoff already showed a form");
assert.equal(shouldOfferForm({ ...base(), lead: { captured: true } }, lim, true), false, "lead already in");
assert.equal(shouldOfferForm({ message_count: 3 }, lim, true), true, "missing fields default safely");
assert.equal(shouldOfferForm(base(), {}, true), false, "no limit ⇒ never offer");

// ── qualificationLines ──
let lines = qualificationLines({ budget: 2300000, timeline: "now", financing: "mortgage" }, "sale");
assert.deepEqual(lines, ["💰 תקציב: ₪2,300,000", "🗓 לוח זמנים: מיידי", "🏦 מימון: צריך/ה משכנתא"]);
lines = qualificationLines({ budget: 6000, timeline: null, financing: null }, "rent");
assert.deepEqual(lines, ["💰 תקציב: ₪6,000 לחודש"]);
assert.deepEqual(qualificationLines(null, "sale"), []);
assert.deepEqual(qualificationLines({ budget: 0 }, "sale"), []);

console.log("chat-qualify.test.js ✓");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node server/chat-qualify.test.js`
Expected: FAIL with `Cannot find module './chat-qualify'`

- [ ] **Step 3: Write minimal implementation**

```js
/*
 * chat-qualify.js — the three qualification fields on the chat lead form:
 * budget (required), timeline and financing (optional selects).
 *
 * Pure functions, no I/O. The model prompt never sees these — asking happens
 * in the form, so the bot cannot be talked out of it and cannot mis-parse a
 * number. Unit-tested in chat-qualify.test.js.
 */

const MAX_BUDGET = 1000000000;

const TIMELINE_LABELS = {
  now: "מיידי",
  "1_3m": "1-3 חודשים",
  "3_6m": "3-6 חודשים",
  "6m_plus": "מעל חצי שנה",
  looking: "רק מתעניין/ת",
};

const FINANCING_LABELS = {
  mortgage: "צריך/ה משכנתא",
  pre_approved: "יש אישור עקרוני",
  cash: "הון עצמי מלא",
  selling_first: "מוכר/ת נכס קודם",
  unsure: "עדיין לא ברור",
};

const money = (n) => "₪" + Number(n).toLocaleString("en-US");

// Budget arrives as a number or as typed text ("2,300,000"). Keep digits only,
// then require a positive integer within the cap. Anything else is a 400 —
// budget is the one required field, and matching is meaningless without it.
function parseBudget(raw) {
  const digits = String(raw == null ? "" : raw).replace(/[^\d.]/g, "");
  const n = Math.floor(Number(digits));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_BUDGET) return null;
  return n;
}

// Unknown enum values become null rather than rejecting: a stale widget or a
// hand-crafted request must not lose a lead over an optional field.
const pickEnum = (raw, labels) =>
  (typeof raw === "string" && Object.prototype.hasOwnProperty.call(labels, raw)) ? raw : null;

function parseQualification(body) {
  const b = body || {};
  const budget = parseBudget(b.budget);
  if (budget === null) return { ok: false, error: "invalid_budget" };
  return {
    ok: true,
    value: {
      budget,
      timeline: pickEnum(b.timeline, TIMELINE_LABELS),
      financing: pickEnum(b.financing, FINANCING_LABELS),
    },
  };
}

/*
 * The proactive offer: exactly once, on the Nth answered turn, and only when
 * no form has been shown by any path. Exactly N (not ≥ N) so a visitor who
 * ignores it is never nagged on every later turn.
 */
function shouldOfferForm(convo, limits, answered) {
  const n = Number(limits && limits.offer_form_after_msgs);
  if (!answered || !Number.isFinite(n) || n <= 0) return false;
  const c = convo || {};
  if (c.form_offered) return false;
  if (c.lead && c.lead.captured) return false;
  if (c.handoff && c.handoff.triggered) return false;
  return Number(c.message_count) === n;
}

// Hebrew lines for the agent's WhatsApp. Rent budgets are monthly.
function qualificationLines(q, listingType) {
  if (!q || !(Number(q.budget) > 0)) return [];
  const out = [`💰 תקציב: ${money(q.budget)}${listingType === "rent" ? " לחודש" : ""}`];
  if (q.timeline && TIMELINE_LABELS[q.timeline]) out.push(`🗓 לוח זמנים: ${TIMELINE_LABELS[q.timeline]}`);
  if (q.financing && FINANCING_LABELS[q.financing]) out.push(`🏦 מימון: ${FINANCING_LABELS[q.financing]}`);
  return out;
}

module.exports = {
  MAX_BUDGET, TIMELINE_LABELS, FINANCING_LABELS,
  parseQualification, shouldOfferForm, qualificationLines,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node server/chat-qualify.test.js`
Expected: `chat-qualify.test.js ✓`

- [ ] **Step 5: Register the test**

In `server/package.json`, inside the `"test"` script string, append ` && node chat-qualify.test.js` at the end (before the closing quote).

Run: `cd server && npm test`
Expected: every existing test prints its ✓ line and the new one too, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add server/chat-qualify.js server/chat-qualify.test.js server/package.json
git commit -m "feat(chat): qualification field validation, offer decision and agent lines"
```

---

### Task 2: `chat-recommend.js` — budget matcher

**Files:**
- Create: `server/chat-recommend.js`
- Test: `server/chat-recommend.test.js`
- Modify: `server/package.json` (add test to `test` script)

**Interfaces:**
- Consumes: `visiblePortfolioPages(pages)` from `server/portfolio.js` (filters `status` active/expiring and `portfolio_visible !== false`).
- Produces:
  - `matchByBudget(pages, { budget, listingType, excludePageId, baseUrl, bandPct = 15, limit = 3 }) -> Match[]`
  - `Match = { page_id, title, city, neighborhood, rooms, price, url }`
  - `recommendationLines(matches) -> string[]` (Hebrew, empty when no matches)
  - `BAND_PCT`, `MAX_MATCHES`

The band is compared in integer space (`|price - budget| * 100 <= budget * bandPct`). Prices and budgets are integers, so this is exact; `budget * 0.85` is not (verified: for budget 999999 the float edge excludes a price that is inside the band).

- [ ] **Step 1: Write the failing test**

```js
/*
 * Unit tests for chat-recommend.js — which of the agent's other pages fit the
 * visitor's budget. Deterministic; the model never touches this.
 * Run: node server/chat-recommend.test.js
 */
const assert = require("assert");
const { matchByBudget, recommendationLines, BAND_PCT, MAX_MATCHES } = require("./chat-recommend");

const pg = (id, price, extra) => ({
  page_id: id, status: "active",
  property: { title: `נכס ${id}`, city: "חיפה", neighborhood: "הדר", rooms: 4, price, listing_type: "sale" },
  ...(extra || {}),
});
const opts = { budget: 2000000, listingType: "sale", excludePageId: "self", baseUrl: "https://x.test" };

// ── band edges: ±15% inclusive ──
let m = matchByBudget([pg("lo", 1700000), pg("hi", 2300000), pg("under", 1699999), pg("over", 2300001)], opts);
assert.deepEqual(m.map((x) => x.page_id).sort(), ["hi", "lo"]);
assert.equal(BAND_PCT, 15);

// ── edges are exact for awkward budgets (float arithmetic would drop 849999) ──
m = matchByBudget([pg("edge", 849999)], { ...opts, budget: 999999 });
assert.deepEqual(m.map((x) => x.page_id), ["edge"]);

// ── sorted by distance from budget, capped at 3 ──
m = matchByBudget([pg("a", 2200000), pg("b", 2000000), pg("c", 1900000), pg("d", 2100000)], opts);
assert.deepEqual(m.map((x) => x.page_id), ["b", "c", "d"]);
assert.equal(MAX_MATCHES, 3);

// ── the current page is never recommended to itself ──
m = matchByBudget([pg("self", 2000000), pg("other", 2000000)], opts);
assert.deepEqual(m.map((x) => x.page_id), ["other"]);

// ── deal type must match; rent budgets are monthly and never mix with sale ──
m = matchByBudget([
  pg("r1", 6000, { property: { title: "r1", price: 6000, listing_type: "rent" } }),
  pg("s1", 6000),
], { ...opts, budget: 6000, listingType: "rent" });
assert.deepEqual(m.map((x) => x.page_id), ["r1"]);

// ── unpublished, hidden, and unknown-price pages are skipped ──
m = matchByBudget([
  pg("expired", 2000000, { status: "expired" }),
  pg("hidden", 2000000, { portfolio_visible: false }),
  pg("noprice", 0),
  pg("expiring", 2000000, { status: "expiring" }),
], opts);
assert.deepEqual(m.map((x) => x.page_id), ["expiring"]);

// ── shape and URL ──
m = matchByBudget([pg("p1", 2050000)], opts);
assert.deepEqual(m[0], {
  page_id: "p1", title: "נכס p1", city: "חיפה", neighborhood: "הדר", rooms: 4,
  price: 2050000, url: "https://x.test/p/p1",
});

// ── defensive inputs ──
assert.deepEqual(matchByBudget(null, opts), []);
assert.deepEqual(matchByBudget([pg("p1", 2000000)], { ...opts, budget: 0 }), []);
assert.deepEqual(matchByBudget([{ page_id: "junk" }], opts), []);

// ── WhatsApp lines ──
assert.deepEqual(recommendationLines([]), []);
assert.deepEqual(recommendationLines(m), [
  "🏠 נכסים נוספים שהוצעו:",
  "• נכס p1, חיפה — ₪2,050,000 — https://x.test/p/p1",
]);

console.log("chat-recommend.test.js ✓");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node server/chat-recommend.test.js`
Expected: FAIL with `Cannot find module './chat-recommend'`

- [ ] **Step 3: Write minimal implementation**

```js
/*
 * chat-recommend.js — "other listings of this agent that fit the budget".
 *
 * Deterministic on purpose: the shortlist is computed here and handed to the
 * visitor as links and to the agent as text. The model is never asked to pick
 * or describe listings, so it cannot invent one. Pure; unit-tested in
 * chat-recommend.test.js.
 */
const { visiblePortfolioPages } = require("./portfolio");

const BAND_PCT = 15;          // ±15% of the budget
const MAX_MATCHES = 3;

const money = (n) => "₪" + Number(n).toLocaleString("en-US");

function matchByBudget(pages, opts) {
  const o = opts || {};
  const budget = Math.floor(Number(o.budget));
  if (!Array.isArray(pages) || !(budget > 0)) return [];
  const pct = Number.isFinite(o.bandPct) ? o.bandPct : BAND_PCT;
  const limit = Number.isFinite(o.limit) ? o.limit : MAX_MATCHES;
  const type = o.listingType || "sale";
  const base = String(o.baseUrl || "").replace(/\/+$/, "");
  // Integer comparison: budget * 0.85 is not exact in floating point and drops
  // a price sitting right on the edge for some budgets.
  const inBand = (price) => Math.abs(price - budget) * 100 <= budget * pct;

  return visiblePortfolioPages(pages)
    .filter((p) => p && p.page_id && p.page_id !== o.excludePageId && p.property)
    .filter((p) => (p.property.listing_type || "sale") === type)
    // 0 means "unknown" everywhere in the page schema, never a free listing.
    .filter((p) => Number(p.property.price) > 0)
    .filter((p) => inBand(Number(p.property.price)))
    .sort((a, b) => Math.abs(a.property.price - budget) - Math.abs(b.property.price - budget))
    .slice(0, limit)
    .map((p) => ({
      page_id: p.page_id,
      title: p.property.title || "",
      city: p.property.city || "",
      neighborhood: p.property.neighborhood || "",
      rooms: Number(p.property.rooms) || 0,
      price: Number(p.property.price),
      url: `${base}/p/${p.page_id}`,
    }));
}

function recommendationLines(matches) {
  if (!Array.isArray(matches) || !matches.length) return [];
  return ["🏠 נכסים נוספים שהוצעו:"].concat(matches.map((m) =>
    `• ${[m.title, m.city].filter(Boolean).join(", ")} — ${money(m.price)} — ${m.url}`));
}

module.exports = { BAND_PCT, MAX_MATCHES, matchByBudget, recommendationLines };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node server/chat-recommend.test.js`
Expected: `chat-recommend.test.js ✓`

- [ ] **Step 5: Register the test**

In `server/package.json`, append ` && node chat-recommend.test.js` to the `"test"` script string.

Run: `cd server && npm test`
Expected: all ✓, exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/chat-recommend.js server/chat-recommend.test.js server/package.json
git commit -m "feat(chat): deterministic budget matcher over the agent's published pages"
```

---

### Task 3: Config limit `offer_form_after_msgs`

**Files:**
- Modify: `server/chatbot-config.js:29-37` (the `limits` block in `DEFAULTS`)
- Test: `server/chatbot-config.test.js`

**Interfaces:**
- Produces: `resolve(...).limits.offer_form_after_msgs` (number, default 3, overridable per page/business like every other limit).

- [ ] **Step 1: Write the failing test**

Append to the end of `server/chatbot-config.test.js`, just above the final `console.log(...)` line:

```js
// ── proactive lead-form offer: default 3, overridable like every other limit ──
assert.equal(DEFAULTS.limits.offer_form_after_msgs, 3);
assert.equal(r(page(), ON).limits.offer_form_after_msgs, 3);
assert.equal(r({ chatbot: { limits: { offer_form_after_msgs: 5 } } }, ON).limits.offer_form_after_msgs, 5);
assert.equal(r({ chatbot: { limits: { offer_form_after_msgs: "x" } } }, ON).limits.offer_form_after_msgs, 3, "bad value ⇒ default");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node server/chatbot-config.test.js`
Expected: FAIL, `AssertionError: undefined == 3`

- [ ] **Step 3: Add the default**

In `server/chatbot-config.js`, inside `DEFAULTS.limits`, after `max_msgs_after_handoff: 5,` add:

```js
    // Offer the lead form once, proactively, on this answered turn — for the
    // engaged visitor whose questions the bot could all answer.
    offer_form_after_msgs: 3,
```

The existing loop in `resolve()` iterates `Object.keys(DEFAULTS.limits)`, so the new key is resolved and coerced with no further change.

- [ ] **Step 4: Run test to verify it passes**

Run: `node server/chatbot-config.test.js`
Expected: `chatbot-config.test.js ✓`

- [ ] **Step 5: Commit**

```bash
git add server/chatbot-config.js server/chatbot-config.test.js
git commit -m "feat(chat): configurable turn for the proactive lead-form offer"
```

---

### Task 4: `submitLead` persists qualification and recommended ids

**Files:**
- Modify: `server/leads.js:20-62`
- Test: `server/leads.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `submitLead({ ..., qualification?, recommended_page_ids? })`. Both `leads/{phone}` and `lead_submissions/{auto}` get `qualification: { budget, timeline, financing } | null` and `recommended_page_ids: string[]`.

- [ ] **Step 1: Write the failing test**

In `server/leads.test.js`, insert before the `console.log("leads.test.js ✓");` line:

```js
  // ── qualification + recommendations ride on both docs ──
  reset();
  await submitLead({
    page, name: "יוסי", phone: "972521234567", source: "chat", questions: [],
    qualification: { budget: 2300000, timeline: "now", financing: null },
    recommended_page_ids: ["pg2", "pg3"],
  });
  assert.deepEqual(db.mem.leadSubmissions[0].qualification, { budget: 2300000, timeline: "now", financing: null });
  assert.deepEqual(db.mem.leadSubmissions[0].recommended_page_ids, ["pg2", "pg3"]);
  assert.deepEqual(db.mem.leads.get("972521234567").qualification, { budget: 2300000, timeline: "now", financing: null });
  assert.deepEqual(db.mem.leads.get("972521234567").recommended_page_ids, ["pg2", "pg3"]);

  // ── a form lead (no qualification) stores null and [] — never undefined ──
  reset();
  await submitLead({ page, name: "רות", phone: "972539876543", source: "landing_page", questions: [] });
  assert.strictEqual(db.mem.leadSubmissions[0].qualification, null);
  assert.deepEqual(db.mem.leadSubmissions[0].recommended_page_ids, []);

  // ── a later submission without a budget must not wipe an earlier one ──
  reset();
  await submitLead({ page, name: "יוסי", phone: "972521234567", source: "chat", questions: [],
    qualification: { budget: 1000, timeline: null, financing: null }, recommended_page_ids: [] });
  await submitLead({ page, name: "יוסי", phone: "972521234567", source: "landing_page", questions: [] });
  assert.equal(db.mem.leads.get("972521234567").qualification.budget, 1000, "summary keeps the known budget");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node server/leads.test.js`
Expected: FAIL, `AssertionError` on `qualification` (undefined).

- [ ] **Step 3: Implement**

In `server/leads.js`:

Change the signature line to:

```js
async function submitLead({ page, context, name, phone, source, questions, message, portfolio_url, qualification, recommended_page_ids }) {
```

After `const q = Array.isArray(questions) ? ... ;` add:

```js
  const qual = qualification && Number(qualification.budget) > 0 ? {
    budget: Number(qualification.budget),
    timeline: qualification.timeline || null,
    financing: qualification.financing || null,
  } : null;
  const recIds = Array.isArray(recommended_page_ids) ? recommended_page_ids.filter(Boolean).map(String) : [];
```

In the `db.saveLead(phone, { ... })` object, after `agent_phone: agentPhone,` add:

```js
    // Only write what this submission knows — a form lead after a chat lead
    // must not null out the budget the chat captured (merge semantics).
    ...(qual ? { qualification: qual, recommended_page_ids: recIds } : {}),
```

In the `db.addLeadSubmission({ ... })` object, after `portfolio_url: portfolio_url || null,` add:

```js
    qualification: qual,
    recommended_page_ids: recIds,
```

Update the comment above the function to mention the new optional fields:

```js
// qualification: { budget, timeline, financing } (chat only). recommended_page_ids: string[] (chat only).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node server/leads.test.js`
Expected: `leads.test.js ✓`

- [ ] **Step 5: Commit**

```bash
git add server/leads.js server/leads.test.js
git commit -m "feat(leads): persist chat qualification and recommended pages"
```

---

### Task 5: Routes — proactive offer on `/api/chat`, qualification + matches on `/api/chat/handoff`

**Files:**
- Modify: `server/routes/chat.js` (imports at top; `/api/chat` response block ~lines 260-288; `/api/chat/handoff` ~lines 292-360)
- Modify: `server/index.js:245-257` (pass `pageBaseUrl`)

**Interfaces:**
- Consumes: `parseQualification`, `shouldOfferForm`, `qualificationLines` (Task 1); `matchByBudget`, `recommendationLines` (Task 2); `limits.offer_form_after_msgs` (Task 3); `submitLead` with new fields (Task 4); `db.listPagesByPhone(phone)` (exists in `server/db.js`).
- Produces:
  - `POST /api/chat` response gains `offer_lead: true` when the proactive offer fires; conversation doc gains `form_offered: boolean`.
  - `POST /api/chat/handoff` accepts `budget` (required), `timeline`, `financing`; returns `{ ok: true, recommendations: Match[] }`; `400 invalid_budget` on a bad budget.

There is no route test file for `chat.js`; the logic added here is delegated to the tested pure helpers. Verification is by running the server locally and calling the endpoints (Step 4).

- [ ] **Step 1: Wire `pageBaseUrl` into the router**

In `server/index.js`, inside the `createChatRouter({ ... })` object, after `greenToken: GREENAPI_TOKEN,` add:

```js
  // Recommendation links point at the public page URL.
  pageBaseUrl: PAGE_BASE_URL,
```

In `server/routes/chat.js`, change the destructuring line to:

```js
  const { apiKeys, ipSalt, greenInstance, greenToken, quota, pageBaseUrl } = ctx;
```

Add the imports after `const { submitLead } = require("../leads");`:

```js
const qualify = require("../chat-qualify");
const recommend = require("../chat-recommend");
```

- [ ] **Step 2: Proactive offer on `/api/chat`**

In the `POST /api/chat` handler, the block that begins `if (!answered && parsed) {` and ends before `await saveConversation(pageId, cid, convo);` is followed by the response. Change that region to:

```js
    if (!answered && parsed) {
      // Every unanswered question, not just the first — the handoff message lists
      // them all. Capped so a hostile visitor can't grow the doc unbounded.
      convo.unanswered = (convo.unanswered || [])
        .concat([parsed.unanswered_question || message]).slice(-10);
      if (!convo.handoff.triggered) {
        // "triggered" now means the form has been offered; lead.captured means
        // the agent has actually been told.
        convo.handoff = { triggered: true, at, question: parsed.unanswered_question || message };
        convo.status = "handoff_pending";
        convo.form_offered = true;
      }
    }

    // The engaged visitor whose questions the bot could all answer: offer the
    // form once, on the Nth answered turn. Decided by a pure helper so the
    // guards (once, no lead yet, no handoff yet) are unit-tested.
    const offerLead = qualify.shouldOfferForm(convo, lim, answered && !!parsed);
    if (offerLead) convo.form_offered = true;

    await saveConversation(pageId, cid, convo);
    await countMessage(pageId, page.business_phone, tokens);

    res.json({
      conversation_id: cid,
      reply,
      state: answered ? "answering" : "handoff",
      ...(offerLead ? { offer_lead: true } : {}),
    });
```

Note: `shouldOfferForm` reads `convo.message_count`, which was already incremented above this block in the existing code, so "3rd turn" means the third message of the conversation.

- [ ] **Step 3: Qualification and matches on `/api/chat/handoff`**

In the `POST /api/chat/handoff` handler, after the line `if (!prospectPhone) return res.status(400).json({ error: "invalid_phone" });` add:

```js
    // Budget is the one required qualification field; the two selects are
    // optional and unknown values become null rather than rejecting the lead.
    const qual = qualify.parseQualification(body);
    if (!qual.ok) return res.status(400).json({ error: qual.error });
```

Replace the block from `const questions = (convo.unanswered || []).filter(Boolean);` through the end of the `sendWhatsApp(...)` call with:

```js
    const questions = (convo.unanswered || []).filter(Boolean);
    const listingType = (page.property && page.property.listing_type) || "sale";

    // Other listings of the same agent that fit the budget. A Firestore hiccup
    // here must never cost the lead — fall back to no recommendations.
    const siblings = await db.listPagesByPhone(page.business_phone).catch((err) => {
      console.warn("chat listPagesByPhone failed (no recommendations):", err.message);
      return [];
    });
    const recommendations = recommend.matchByBudget(siblings, {
      budget: qual.value.budget, listingType, excludePageId: pageId, baseUrl: pageBaseUrl,
    });

    // Lead saved BEFORE the send — a Green API outage must never lose it.
    try {
      await submitLead({
        page, name, phone: prospectPhone, source: "chat", questions,
        qualification: qual.value,
        recommended_page_ids: recommendations.map((m) => m.page_id),
      });
    } catch (err) {
      console.error("chat submitLead failed:", err.message);
      return res.status(500).json({ error: "internal" });
    }

    const title = (page.property && page.property.address) || "";
    const city = (page.property && page.property.city) || "";
    const msg = [
      `🔔 ליד חדש מדף הנכס "${title}, ${city}"`,
      `👤 ${name}`,
      `📞 0${prospectPhone.slice(3)}`,
      ...qualify.qualificationLines(qual.value, listingType),
      ...(questions.length ? ["❓ שאלות שלא נענו:", ...questions.map((q) => `• ${q}`)] : []),
      ...recommend.recommendationLines(recommendations),
      `דברו איתו עכשיו: https://wa.me/${prospectPhone}`,
    ].join("\n");
    sendWhatsApp(page.business_phone, msg, greenInstance, greenToken)
      .catch((e) => console.error("chat lead notify failed:", e.message));
```

Then change the conversation update and response at the end of the handler to:

```js
    const at = new Date();
    convo.lead = {
      captured: true, at, name, phone: prospectPhone,
      qualification: qual.value,
      recommended_page_ids: recommendations.map((m) => m.page_id),
    };
    convo.status = "lead_captured";
    convo.post_handoff_count = 0;
    await saveConversation(pageId, cid, convo);

    res.json({ ok: true, recommendations });
```

Also update the dedupe early-return (the `if (prev && prev.captured && ...)` block) to return the same shape so a double-tap does not blank the cards:

```js
      return res.json({ ok: true, recommendations: [] });
```

- [ ] **Step 4: Verify by running the server**

Run the full suite first:

```bash
cd server && npm test
```
Expected: all ✓.

Then start the server with the in-memory store (no Firestore) and exercise the endpoints. The exact start command is the repo's usual one (`cd server && node index.js`); with no `GEMINI_API_KEY` the `/api/chat` call returns `503 unavailable`, which is fine. What must be checked is the handoff validation path, which does not need a model:

```bash
curl -s -X POST localhost:3000/api/chat/handoff -H 'Content-Type: application/json' \
  -d '{"page_id":"nope","conversation_id":"c1","name":"יוסי","phone":"0521234567"}'
```
Expected: `{"error":"invalid_budget"}` (budget validation runs before the page lookup, so no page is needed).

```bash
curl -s -X POST localhost:3000/api/chat/handoff -H 'Content-Type: application/json' \
  -d '{"page_id":"nope","conversation_id":"c1","name":"יוסי","phone":"0521234567","budget":"2,300,000"}'
```
Expected: `{"error":"not_found"}` (validation passed, page lookup failed).

If the port differs, read it from `server/index.js` (`PORT`).

- [ ] **Step 5: Commit**

```bash
git add server/routes/chat.js server/index.js
git commit -m "feat(chat): qualification on handoff, budget matches for visitor and agent, proactive form offer"
```

---

### Task 6: Widget — form fields, proactive offer, recommendation cards

**Files:**
- Modify: `public-nadlan/templates/chat.js` (FALLBACK strings ~lines 27-51; `pushLeadForm` ~lines 184-236; fetch `.then` ~lines 268-284)
- Modify: `public-nadlan/templates/chat.css` (after the `.flychat-lead-f button:disabled` rule, ~line 107)

**Interfaces:**
- Consumes: `POST /api/chat` `offer_lead: true`; `POST /api/chat/handoff` `{ ok, recommendations: [{ page_id, title, city, neighborhood, rooms, price, url }] }` and `400 invalid_budget`.
- The init payload is built by `pagePayload()` in `server/routes/pages.js` and includes the full `property` block, so `data.property.listing_type` is available to the widget (verified). A page without it is treated as `sale`.

No automated test: the widget is a DOM IIFE with no test harness in the repo. Verification is `node --check` plus the manual checks in Step 5.

- [ ] **Step 1: Strings**

In `FALLBACK.he`, after the `lead_sent:` line add:

```js
      lead_intro_offer: "רוצים שהמתווך יחזור אליכם? השאירו פרטים ואציע גם נכסים נוספים שמתאימים לתקציב:",
      lead_budget: "תקציב (₪)", lead_budget_rent: "תקציב חודשי (₪)",
      lead_timeline: "מתי מתכננים?", lead_financing: "מימון",
      tl_now: "מיידי", tl_1_3m: "1-3 חודשים", tl_3_6m: "3-6 חודשים", tl_6m_plus: "מעל חצי שנה", tl_looking: "רק מתעניין/ת",
      fn_mortgage: "צריך/ה משכנתא", fn_pre_approved: "יש אישור עקרוני", fn_cash: "הון עצמי מלא",
      fn_selling_first: "מוכר/ת נכס קודם", fn_unsure: "עדיין לא ברור",
      rec_intro: "לפי התקציב, אלה נכסים נוספים של המשרד שיכולים להתאים:",
      rec_rooms: "חד׳",
```

In `FALLBACK.en`, after its `lead_sent:` line add:

```js
      lead_intro_offer: "Want the agent to get back to you? Leave your details and I'll also suggest listings that fit your budget:",
      lead_budget: "Budget (₪)", lead_budget_rent: "Monthly budget (₪)",
      lead_timeline: "When are you planning?", lead_financing: "Financing",
      tl_now: "Right away", tl_1_3m: "1-3 months", tl_3_6m: "3-6 months", tl_6m_plus: "6+ months", tl_looking: "Just looking",
      fn_mortgage: "Need a mortgage", fn_pre_approved: "Mortgage pre-approved", fn_cash: "Cash",
      fn_selling_first: "Selling a property first", fn_unsure: "Not sure yet",
      rec_intro: "Based on your budget, these other listings from the office may fit:",
      rec_rooms: "rooms",
```

- [ ] **Step 2: Form fields and submit payload**

Replace the whole `pushLeadForm` function with:

```js
    // Mini lead form, inline in the log, shown ONCE per conversation.
    // Name + phone + budget are required; timeline and financing are selects
    // the visitor may skip. On submit it WhatsApps the agent (server side),
    // collapses to a thanks line and, when the server found other listings of
    // the same agent within the budget, renders them as link cards.
    // Tracks an open, unanswered form — not "a form was shown once". Two must
    // never stack, but a visitor who asks something else later and hits handoff
    // again is a second lead the agent still needs to hear about. The server
    // swallows a genuine double-tap (same number inside its dedupe window).
    var leadPending = false;
    var isRent = !!(data.property && data.property.listing_type === "rent");
    var TIMELINES = ["now", "1_3m", "3_6m", "6m_plus", "looking"];
    var FINANCINGS = ["mortgage", "pre_approved", "cash", "selling_first", "unsure"];

    function selectEl(label, keys, prefix) {
      var s = document.createElement("select");
      s.setAttribute("aria-label", label);
      var o0 = document.createElement("option");
      o0.value = ""; o0.textContent = label;
      s.appendChild(o0);
      keys.forEach(function (k) {
        var o = document.createElement("option");
        o.value = k; o.textContent = t(prefix + k);
        s.appendChild(o);
      });
      return s;
    }

    function pushLeadForm(intro) {
      if (leadPending) return;                 // never stack two forms
      leadPending = true;
      var w = el("div", "flychat-lead");
      var introEl = el("div", "flychat-lead-intro");
      introEl.textContent = intro || t("lead_intro");
      var f = document.createElement("form");
      f.className = "flychat-lead-f";
      var nm = document.createElement("input");
      nm.type = "text"; nm.placeholder = t("lead_name"); nm.setAttribute("aria-label", t("lead_name"));
      nm.maxLength = 60; nm.required = true;
      var ph = document.createElement("input");
      ph.type = "tel"; ph.placeholder = t("lead_phone"); ph.setAttribute("aria-label", t("lead_phone"));
      ph.maxLength = 20; ph.required = true;
      var bd = document.createElement("input");
      bd.type = "number"; bd.inputMode = "numeric"; bd.min = "1"; bd.step = "1";
      bd.placeholder = t(isRent ? "lead_budget_rent" : "lead_budget");
      bd.setAttribute("aria-label", bd.placeholder);
      bd.required = true; bd.className = "flychat-lead-wide";
      var tl = selectEl(t("lead_timeline"), TIMELINES, "tl_");
      var fn = selectEl(t("lead_financing"), FINANCINGS, "fn_");
      var sub = document.createElement("button");
      sub.type = "submit"; sub.textContent = t("lead_send");
      f.appendChild(nm); f.appendChild(ph); f.appendChild(bd); f.appendChild(tl); f.appendChild(fn); f.appendChild(sub);
      w.appendChild(introEl); w.appendChild(f);
      log.appendChild(w);
      log.scrollTop = log.scrollHeight;
      beacon("chat_handoff");

      var fields = [nm, ph, bd, tl, fn, sub];
      function lock(v) { fields.forEach(function (x) { x.disabled = v; }); }

      f.addEventListener("submit", function (e) {
        e.preventDefault();
        var name = nm.value.trim(), phone = ph.value.trim();
        var budget = parseInt(bd.value, 10);
        if (name.length < 2 || phone.length < 9 || !(budget > 0)) return;
        lock(true);
        fetch("/api/chat/handoff", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            page_id: pageId, conversation_id: cid, name: name, phone: phone,
            budget: budget, timeline: tl.value || null, financing: fn.value || null,
          }),
        }).then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (d) {
            if (d && d.ok) {
              w.textContent = t("lead_sent");   // collapse to confirmation
              leadPending = false;              // a later handoff may ask again
              beacon("chat_lead");
              if (d.recommendations && d.recommendations.length) pushRecommendations(d.recommendations);
            } else {
              lock(false);
              push("err", t("err"));
            }
          }).catch(function () {
            lock(false);
            push("err", t("err"));
          });
      });
    }

    // Link cards for the agent's other listings within the budget. Rendered
    // from server data only — this widget never composes a listing itself.
    function pushRecommendations(list) {
      var m = push("bot", t("rec_intro"));
      var wrap = el("div", "flychat-recs");
      list.slice(0, 3).forEach(function (r) {
        if (!/^https?:\/\//.test(String(r.url || ""))) return;
        var a = document.createElement("a");
        a.className = "flychat-rec";
        a.href = r.url; a.target = "_blank"; a.rel = "noopener";
        var meta = [r.city, r.rooms ? r.rooms + " " + t("rec_rooms") : ""].filter(Boolean).join(" · ");
        a.innerHTML = "<b>" + esc(r.title || r.city || "") + "</b>" +
          "<span>" + esc(meta) + "</span>" +
          "<em>₪" + esc(Number(r.price).toLocaleString("en-US")) + "</em>";
        wrap.appendChild(a);
      });
      if (wrap.childNodes.length) { m.appendChild(wrap); beacon("chat_recommendation"); }
      log.scrollTop = log.scrollHeight;
    }
```

`push(kind, text)` already returns the message element (see the `return m;` at the end of `push`), which is what `pushRecommendations` appends to.

- [ ] **Step 3: Proactive offer on the reply path**

In the `/api/chat` fetch `.then(function (d) { ... })`, change the last two lines of that callback from:

```js
        if (d.state === "handoff") pushLeadForm();
```

to:

```js
        if (d.state === "handoff") pushLeadForm();
        else if (d.offer_lead) pushLeadForm(t("lead_intro_offer"));
```

- [ ] **Step 4: CSS**

In `public-nadlan/templates/chat.css`, after the `.flychat-lead-f button:disabled { ... }` rule add:

```css
.flychat-lead-f select { flex: 1 1 44%; min-width: 0; font-family: inherit; font-size: .86rem;
  color: #17140f; background: #fff; border: 1px solid rgba(23, 20, 15, .12);
  border-radius: 10px; padding: 9px 12px; outline: none; }
.flychat-lead-f select:focus { border-color: rgba(23, 20, 15, .3); }
.flychat-lead-f .flychat-lead-wide { flex: 1 1 100%; }

/* other listings of the same agent that fit the budget */
.flychat-recs { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.flychat-rec { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; align-items: center;
  background: #fff; border: 1px solid rgba(23, 20, 15, .12); border-radius: 10px;
  padding: 8px 10px; color: #17140f; text-decoration: none; font-size: .84rem; }
.flychat-rec b { font-weight: 600; }
.flychat-rec span { grid-column: 1; opacity: .7; font-size: .78rem; }
.flychat-rec em { grid-column: 2; grid-row: 1 / span 2; font-style: normal; font-weight: 600; white-space: nowrap; }
.flychat-rec:hover { border-color: rgba(23, 20, 15, .3); }
```

- [ ] **Step 5: Verify**

```bash
node --check public-nadlan/templates/chat.js
```
Expected: no output, exit 0.

Manual, on a running server with two published pages of the same agent (one within ±15% of the other's price, same deal type):

1. Open a page, ask three answerable questions. After the third reply the form appears with the offer intro.
2. Submit without a budget: the browser blocks submit (required). Submit with a budget: thanks line, then the recommendation bubble with one card linking to the other page.
3. Open the other page, ask something the bot cannot answer: the form appears with the handoff intro. Submit with a budget far from every price: thanks line, no cards.
4. Check the agent's WhatsApp text (or the server log if Green API is not configured): 💰/🗓/🏦 lines present; 🏠 list present only in case 2.
5. Repeat case 1 on an `en` page for the English strings, and on a `rent` page for the monthly budget label.

- [ ] **Step 6: Commit**

```bash
git add public-nadlan/templates/chat.js public-nadlan/templates/chat.css
git commit -m "feat(chat widget): budget, timeline and financing fields, proactive offer, listing cards"
```

---

### Task 7: Final verification and push

**Files:** none new.

- [ ] **Step 1: Full test run**

```bash
cd server && npm test
```
Expected: every test prints ✓, exit 0.

- [ ] **Step 2: Line-count check on touched files**

```bash
wc -l server/routes/chat.js server/chat-qualify.js server/chat-recommend.js public-nadlan/templates/chat.js
```
Expected: `routes/chat.js` and `templates/chat.js` under 500; the two new modules under 200. If `routes/chat.js` crosses 500, move `closingReply`, `capReply` and `softFallback` into `server/chat-replies.js` (exporting all three) and require it from the route.

- [ ] **Step 3: Push**

```bash
git push -u origin claude/chatbot-budget-financing-questions-5en12g
```

- [ ] **Step 4: Update issue #42**

Comment on the issue with the branch name and a one-paragraph summary of what was built and what was left out (dashboard view, agency mirror pages), ending with the Claude Code attribution footer.
