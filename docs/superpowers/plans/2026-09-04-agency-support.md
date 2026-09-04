# Agency Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agency owner buy one plan covering N agent seats, see every member's listings, leads and usage read-only, set brand defaults once, and let members market each other's listings under their own name via mirror pages.

**Architecture:** A new `agencies/{agencyId}` collection with `members` and `invites` subcollections; `agency_id` denormalized onto `businesses`, `listings` and `property_pages`. Sharing is a "mirror page": a `property_pages` doc with `source_page_id` that carries only the mirroring agent's identity and theme, and is rendered by merging the source page's content under it. All decision logic lives in two pure modules (`server/agency.js`, `server/mirror.js`) with node-assert tests; routes stay thin.

**Tech Stack:** Express 4, Node 20+, Firestore via `firebase-admin` (with the in-memory `mem` fallback in `server/db.js`), vanilla HTML/JS in `public-agent/`. Tests are plain `node file.test.js` scripts chained in `server/package.json` `"test"`.

**Spec:** `docs/superpowers/specs/2026-09-04-agency-support-design.md`

## Global Constraints

- Phone is the identity everywhere: sessions, `business_phone`, admin allowlist. Never introduce a second identity for the owner; the owner is a normal business with member role `owner`.
- Owner access is read-only over members' data. No endpoint in this plan lets an owner edit a member's page, listing or profile.
- Quota stays per agent under `businesses/{phone}/quota`. No pooled counters.
- No payment code. Agency plan and seats are admin-set fields.
- No new Firestore composite indexes: every new query filters on a single field (`agency_id`, `source_page_id`, `business_phone`) and filters the rest in memory. Keep result limits at 500 or below.
- Agency brand fields are defaults only; an agent's own `logo_url`, `brand_colors`, `slogan` win when set.
- A mirror never stores `property`, `hero`, `gallery`, `carousel`, `area`, `cta`, `sections`, `texts`. Content always comes from the source page at read time.
- `listings.page_id` keeps pointing at the original page. Mirrors are found by `source_page_id`.
- Error codes are exactly: `409 seat_cap`, `410 invite_invalid`, `403 not_shareable`, `409 already_member`, `403 mirror_readonly`, `403 not_owner`, `404 not_found`.
- Follow the repo test style: `const assert = require("assert")`, pure functions only, no Express, no network. Every new test file is appended to the `"test"` script in `server/package.json`.
- Keep files under 500 lines. `server/routes/pages.js` is already large; add only the minimal hooks there and put logic in `server/mirror.js`.
- Commit after every task with a descriptive message. Do not add Co-Authored-By trailers.

---

## File Structure

- Create: `server/agency.js` — pure helpers: ids, seat check, invite validity, brand resolution, feature defaults, mirror eligibility, member summaries.
- Create: `server/agency.test.js` — assertions for `agency.js`.
- Create: `server/mirror.js` — pure helpers: detect a mirror, build a mirror doc, merge source + mirror into a payload, resolve effective status, whitelist mirror edits, expand mirrors in a page list.
- Create: `server/mirror.test.js` — assertions for `mirror.js`.
- Modify: `server/db.js` — `mem.businesses`, `mem.agencies`, `mem.members`, `mem.invites`; agency/member/invite CRUD; agency-scoped list queries; mirror lookups; `stampAgencyOnAssets`.
- Create: `server/db-agency.test.js` — exercises the new db helpers in mem mode.
- Create: `server/routes/agency.js` — `/api/agency/*` member and owner endpoints.
- Modify: `server/index.js` — mount the agency router.
- Modify: `server/routes/intake.js` — stamp `agency_id` and `agency_private` on new listings; activate pending membership on demo-create.
- Modify: `server/routes/profile.js` — activate pending membership on onboarding complete.
- Modify: `server/routes/pages.js` — stamp `agency_id` on new pages; mirror-aware `getPageHandler`, `/api/property-by-slug`, `loadPublicPortfolio`, `/api/page/update`.
- Modify: `server/routes/dashboard.js` — mirrors in `/api/properties`, `agency` block in `/api/profile`, `POST /api/properties/private`.
- Modify: `server/routes/admin.js` — `/api/admin/agencies*` endpoints.
- Modify: `server/leads.js` — store `source_page_id` on leads from mirrors.
- Modify: `server/package.json` — add the three new test files to `"test"`.
- Create: `public-agent/agency.html`, `public-agent/agency.js` — owner and member agency screens.
- Modify: `public-agent/index.html` — agency nav link, "shared from" badge, private toggle.
- Modify: `public-agent/admin.html`, `public-agent/admin.js` — Agencies tab.

---

### Task 1: Pure agency helpers

**Files:**
- Create: `server/agency.js`
- Create: `server/agency.test.js`
- Modify: `server/package.json` (the `"test"` script)

**Interfaces:**
- Produces:
  - `newAgencyId(): string` — 8 chars from `db.shortCode`-style alphabet, prefixed `ag_`.
  - `seatCheck(agency, members): { ok: boolean, used: number, seats: number }` — counts members with status `active` or `pending`.
  - `inviteValid(invite, now = new Date()): boolean` — false if missing, `used_by` set, or `expires_at` past.
  - `newInvite(createdBy, now = new Date(), ttlDays = 7): { token, created_by, created_at, expires_at, used_by: null, used_at: null }`.
  - `resolveBrand(business, agency): { logo_url, brand_colors, slogan }` — business wins when non-empty.
  - `mergeFeatureDefaults(businessFeatures, agencyFeatures): object` — copies keys the business lacks; never overrides an existing boolean.
  - `canMirror({ listing, sourcePage, callerPhone, callerAgencyId, existingMirror }): { ok: boolean, error?: string, status?: number }`.
  - `memberSummary(member, business, listings, pages, quota): object` — per-member counts for the owner dashboard.
  - `AGENCY_PLANS = ["agency_trial", "agency"]`.

- [ ] **Step 1: Write the failing test**

```js
// server/agency.test.js
/*
 * Unit tests for agency.js — pure helpers, no Express, no Firestore.
 * Run: node server/agency.test.js
 */
const assert = require("assert");
const {
  newAgencyId, seatCheck, inviteValid, newInvite, resolveBrand,
  mergeFeatureDefaults, canMirror, memberSummary, AGENCY_PLANS,
} = require("./agency");

// ── ids ──
assert.match(newAgencyId(), /^ag_[a-z0-9]{8}$/);
assert.notEqual(newAgencyId(), newAgencyId());

// ── seats: active + pending both count, removed does not ──
const ag = { seats: 3 };
assert.deepEqual(seatCheck(ag, []), { ok: true, used: 0, seats: 3 });
assert.deepEqual(seatCheck(ag, [{ status: "active" }, { status: "pending" }]), { ok: true, used: 2, seats: 3 });
assert.equal(seatCheck(ag, [{ status: "active" }, { status: "active" }, { status: "pending" }]).ok, false);
assert.equal(seatCheck({ seats: 0 }, []).ok, false, "zero seats admits nobody");
assert.equal(seatCheck({}, []).ok, false, "missing seats admits nobody");

// ── invites ──
const now = new Date("2026-09-04T10:00:00Z");
const inv = newInvite("972500000001", now);
assert.match(inv.token, /^[A-Za-z0-9_-]{22,}$/, "token is base64url of >=16 random bytes");
assert.equal(inv.created_by, "972500000001");
assert.equal(inv.expires_at.getTime(), now.getTime() + 7 * 86400000);
assert.equal(inv.used_by, null);
assert.equal(inviteValid(inv, now), true);
assert.equal(inviteValid(inv, new Date(now.getTime() + 8 * 86400000)), false, "expired");
assert.equal(inviteValid({ ...inv, used_by: "x" }, now), false, "already used");
assert.equal(inviteValid(null, now), false);

// ── brand: business wins when set, agency fills gaps ──
const agency = { brand: { logo_url: "A.png", brand_colors: ["#111"], slogan: "Agency" } };
assert.deepEqual(resolveBrand({ logo_url: "B.png" }, agency),
  { logo_url: "B.png", brand_colors: ["#111"], slogan: "Agency" });
assert.deepEqual(resolveBrand({ brand_colors: [] , slogan: "" }, agency),
  { logo_url: "A.png", brand_colors: ["#111"], slogan: "Agency" }, "empty array/string count as unset");
assert.deepEqual(resolveBrand({}, null), { logo_url: null, brand_colors: [], slogan: "" });

// ── feature defaults: fill gaps only ──
assert.deepEqual(mergeFeatureDefaults({ chatbot: false }, { chatbot: true, portfolio: true }),
  { chatbot: false, portfolio: true });
assert.deepEqual(mergeFeatureDefaults(undefined, { portfolio: true }), { portfolio: true });
assert.deepEqual(mergeFeatureDefaults({ x: true }, undefined), { x: true });

// ── canMirror decision table ──
const listing = { listing_id: "L1", business_phone: "A", agency_id: "ag_1", agency_private: false, status: "active" };
const src = { page_id: "P1", status: "active", business_phone: "A" };
const base = { listing, sourcePage: src, callerPhone: "B", callerAgencyId: "ag_1", existingMirror: null };
assert.deepEqual(canMirror(base), { ok: true });
assert.deepEqual(canMirror({ ...base, callerPhone: "A" }), { ok: false, status: 403, error: "not_shareable" }, "own listing");
assert.deepEqual(canMirror({ ...base, callerAgencyId: "ag_2" }), { ok: false, status: 403, error: "not_shareable" }, "other agency");
assert.deepEqual(canMirror({ ...base, callerAgencyId: null }), { ok: false, status: 403, error: "not_shareable" }, "no agency");
assert.deepEqual(canMirror({ ...base, listing: { ...listing, agency_private: true } }), { ok: false, status: 403, error: "not_shareable" });
assert.deepEqual(canMirror({ ...base, listing: { ...listing, status: "archived" } }), { ok: false, status: 403, error: "not_shareable" });
assert.deepEqual(canMirror({ ...base, sourcePage: null }), { ok: false, status: 403, error: "not_shareable" }, "no page yet");
assert.deepEqual(canMirror({ ...base, sourcePage: { ...src, status: "archived" } }), { ok: false, status: 403, error: "not_shareable" });
assert.deepEqual(canMirror({ ...base, sourcePage: { ...src, source_page_id: "P0" } }), { ok: false, status: 403, error: "not_shareable" }, "no mirror of a mirror");
assert.deepEqual(canMirror({ ...base, existingMirror: { page_id: "M1" } }), { ok: true, existing: "M1" }, "idempotent");

// ── memberSummary ──
const summary = memberSummary(
  { phone: "B", role: "agent", status: "active", joined_at: now },
  { full_name: "Bat", business_name: "Bat Realty", logo_url: null, onboarding_state: "complete" },
  [{ status: "active" }, { status: "archived" }],
  [{ status: "active", lead_count: 3, view_count: 10, source_page_id: null }, { status: "active", lead_count: 1, view_count: 5, source_page_id: "P1" }],
  { chat_msgs_month: 7, chat_msgs_month_key: "2026-09" }
);
assert.deepEqual(summary, {
  phone: "B", role: "agent", status: "active", joined_at: now,
  full_name: "Bat", business_name: "Bat Realty", logo_url: null, onboarding_state: "complete",
  active_listings: 1, pages: 1, mirrors: 1, leads: 4, views: 15, chat_msgs_month: 7,
});
assert.equal(memberSummary({ phone: "C", role: "agent", status: "pending" }, null, [], [], null).full_name, "");

assert.deepEqual(AGENCY_PLANS, ["agency_trial", "agency"]);
console.log("agency.test.js OK");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node agency.test.js`
Expected: FAIL with `Cannot find module './agency'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/agency.js
/*
 * agency.js — pure decision helpers for agency plans.
 * No Firestore, no Express: everything here is unit-tested in agency.test.js.
 * Storage lives in db.js, HTTP in routes/agency.js and routes/admin.js.
 */
const crypto = require("crypto");

const AGENCY_PLANS = ["agency_trial", "agency"];
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function newAgencyId() {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return `ag_${out}`;
}

// active + pending both hold a seat; a phone the owner added before the agent
// signed up must not be silently overbooked.
function seatCheck(agency, members) {
  const seats = Number((agency && agency.seats) || 0);
  const used = (members || []).filter((m) => m.status === "active" || m.status === "pending").length;
  return { ok: seats > 0 && used < seats, used, seats };
}

function newInvite(createdBy, now = new Date(), ttlDays = 7) {
  return {
    token: crypto.randomBytes(24).toString("base64url"),
    created_by: createdBy,
    created_at: now,
    expires_at: new Date(now.getTime() + ttlDays * 86400000),
    used_by: null,
    used_at: null,
  };
}

const toMs = (v) => (v && v.toDate ? v.toDate().getTime() : v ? new Date(v).getTime() : 0);

function inviteValid(invite, now = new Date()) {
  if (!invite || invite.used_by) return false;
  return toMs(invite.expires_at) > now.getTime();
}

const filled = (v) => (Array.isArray(v) ? v.length > 0 : v != null && v !== "");

function resolveBrand(business, agency) {
  const b = business || {};
  const a = (agency && agency.brand) || {};
  return {
    logo_url: filled(b.logo_url) ? b.logo_url : (filled(a.logo_url) ? a.logo_url : null),
    brand_colors: filled(b.brand_colors) ? b.brand_colors : (filled(a.brand_colors) ? a.brand_colors : []),
    slogan: filled(b.slogan) ? b.slogan : (filled(a.slogan) ? a.slogan : ""),
  };
}

function mergeFeatureDefaults(businessFeatures, agencyFeatures) {
  const out = Object.assign({}, businessFeatures || {});
  for (const [k, v] of Object.entries(agencyFeatures || {})) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

const NOT_SHAREABLE = { ok: false, status: 403, error: "not_shareable" };

function canMirror({ listing, sourcePage, callerPhone, callerAgencyId, existingMirror }) {
  if (!listing || !callerAgencyId) return NOT_SHAREABLE;
  if (listing.business_phone === callerPhone) return NOT_SHAREABLE;
  if (listing.agency_id !== callerAgencyId) return NOT_SHAREABLE;
  if (listing.agency_private === true) return NOT_SHAREABLE;
  if (listing.status !== "active") return NOT_SHAREABLE;
  if (!sourcePage || sourcePage.source_page_id) return NOT_SHAREABLE;
  if (sourcePage.status !== "active" && sourcePage.status !== "expiring") return NOT_SHAREABLE;
  if (existingMirror) return { ok: true, existing: existingMirror.page_id };
  return { ok: true };
}

function memberSummary(member, business, listings, pages, quota) {
  const b = business || {};
  const ps = pages || [];
  const own = ps.filter((p) => !p.source_page_id && p.status !== "archived" && p.status !== "expired");
  const mirrors = ps.filter((p) => p.source_page_id && p.status !== "archived");
  return {
    phone: member.phone, role: member.role, status: member.status, joined_at: member.joined_at,
    full_name: b.full_name || "", business_name: b.business_name || "",
    logo_url: b.logo_url || null, onboarding_state: b.onboarding_state || "",
    active_listings: (listings || []).filter((l) => l.status === "active").length,
    pages: own.length,
    mirrors: mirrors.length,
    leads: ps.reduce((n, p) => n + (p.lead_count || 0), 0),
    views: ps.reduce((n, p) => n + (p.view_count || 0), 0),
    chat_msgs_month: (quota && quota.chat_msgs_month) || 0,
  };
}

module.exports = {
  AGENCY_PLANS, newAgencyId, seatCheck, newInvite, inviteValid,
  resolveBrand, mergeFeatureDefaults, canMirror, memberSummary,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node agency.test.js`
Expected: `agency.test.js OK`

- [ ] **Step 5: Add the test to the npm script**

In `server/package.json`, append ` && node agency.test.js` to the end of the `"test"` value (before the closing quote; the current value ends with `node login-leads.test.js `).

Run: `cd server && npm test 2>&1 | tail -3`
Expected: last line `agency.test.js OK`, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add server/agency.js server/agency.test.js server/package.json
git commit -m "feat(agency): pure helpers for seats, invites, brand, mirror eligibility"
```

---

### Task 2: Pure mirror helpers

**Files:**
- Create: `server/mirror.js`
- Create: `server/mirror.test.js`
- Modify: `server/package.json`

**Interfaces:**
- Produces:
  - `isMirror(page): boolean` — true when `page.source_page_id` is a non-empty string.
  - `buildMirrorDoc({ sourcePage, listing, business, pageId, editToken, now }): object` — the doc to `savePage`.
  - `effectiveStatus(mirror, source, listing): string` — `"archived"` if mirror archived, source archived/expired, listing archived or `agency_private`; `"building"` if source building; otherwise source status.
  - `mirrorPayload(mirror, source, chatbot): object` — same shape as `pagePayload` in `routes/pages.js`, content from source, identity from mirror.
  - `mirrorEditPatch(body, now): object|null` — whitelist of fields a mirror owner may change (`agent.name`, `agent.brand_name`, `agent.tagline`, `agent.phone`, `theme`, `portfolio_visible`, `portfolio_rank`, `public_slug`). Returns `null` when the body contains only disallowed content fields.
  - `expandMirrors(pages, getPage, getListing): Promise<Array>` — replaces every mirror in `pages` with the merged doc whose `status` is the effective status, keeping `page_id`, `business_phone`, `public_slug`, `portfolio_visible`, `portfolio_rank` from the mirror. Non-mirror pages pass through untouched.

- [ ] **Step 1: Write the failing test**

```js
// server/mirror.test.js
/*
 * Unit tests for mirror.js — merging a mirror page with its source.
 * Pure functions; getPage/getListing are stubbed. Run: node server/mirror.test.js
 */
const assert = require("assert");
const { isMirror, buildMirrorDoc, effectiveStatus, mirrorPayload, mirrorEditPatch, expandMirrors } = require("./mirror");

const now = new Date("2026-09-04T10:00:00Z");
const source = {
  page_id: "P1", listing_id: "L1", business_phone: "A", agency_id: "ag_1", status: "active",
  agent: { name: "Avi", brand_name: "Avi Homes", logo_url: "a.png", tagline: "t", phone: "A", phone2: null, license: "1" },
  agent2: null, theme: { accent: "#f00" }, language: "he",
  property: { title: "3 rooms", price: 100 }, hero: { phrase: "hi" }, gallery: [{ url: "g.jpg" }],
  carousel: [], area: {}, cta: {}, sections: {}, texts: { a: "b" },
  view_count: 9, lead_count: 2,
};
const listing = { listing_id: "L1", business_phone: "A", agency_id: "ag_1", status: "active", agency_private: false };
const business = { phone: "B", full_name: "Bat", business_name: "Bat Realty", logo_url: "b.png", slogan: "best", license_number: "77" };

assert.equal(isMirror(source), false);
assert.equal(isMirror({ source_page_id: "P1" }), true);
assert.equal(isMirror({ source_page_id: "" }), false);
assert.equal(isMirror(null), false);

// ── buildMirrorDoc: identity from business, no content ──
const m = buildMirrorDoc({ sourcePage: source, listing, business, pageId: "bat-realty-x1y2z", editToken: "tok", now });
assert.equal(m.page_id, "bat-realty-x1y2z");
assert.equal(m.source_page_id, "P1");
assert.equal(m.listing_id, "L1");
assert.equal(m.business_phone, "B");
assert.equal(m.agency_id, "ag_1");
assert.equal(m.status, "active");
assert.equal(m.edit_token, "tok");
assert.deepEqual(m.agent, { name: "Bat", brand_name: "Bat Realty", logo_url: "b.png", tagline: "best", phone: "B", phone2: null, license: "77" });
assert.equal(m.agent2, null);
assert.equal(m.theme, null, "mirror starts with the default theme, not the source's");
assert.equal(m.language, "he");
assert.equal(m.view_count, 0); assert.equal(m.lead_count, 0);
assert.equal(m.created_at, now); assert.equal(m.updated_at, now);
for (const k of ["property", "hero", "gallery", "carousel", "area", "cta", "sections", "texts"]) {
  assert.equal(k in m, false, `mirror must not store ${k}`);
}

// ── effectiveStatus ──
assert.equal(effectiveStatus(m, source, listing), "active");
assert.equal(effectiveStatus(m, { ...source, status: "expiring" }, listing), "expiring");
assert.equal(effectiveStatus(m, { ...source, status: "building" }, listing), "building");
assert.equal(effectiveStatus(m, { ...source, status: "archived" }, listing), "archived");
assert.equal(effectiveStatus(m, { ...source, status: "expired" }, listing), "archived");
assert.equal(effectiveStatus(m, null, listing), "archived", "missing source");
assert.equal(effectiveStatus({ ...m, status: "archived" }, source, listing), "archived");
assert.equal(effectiveStatus(m, source, { ...listing, agency_private: true }), "archived");
assert.equal(effectiveStatus(m, source, { ...listing, status: "archived" }), "archived");
assert.equal(effectiveStatus(m, source, null), "active", "listing lookup failed: trust the page");

// ── mirrorPayload: source content, mirror identity ──
const bot = { enabled: false, greeting: null };
const payload = mirrorPayload({ ...m, theme: { accent: "#00f" } }, source, bot);
assert.equal(payload.page_id, "bat-realty-x1y2z");
assert.equal(payload.status, "active");
assert.deepEqual(payload.agent, m.agent);
assert.equal(payload.agent2, null);
assert.deepEqual(payload.theme, { accent: "#00f" });
assert.deepEqual(payload.property, source.property);
assert.deepEqual(payload.hero, source.hero);
assert.deepEqual(payload.gallery, source.gallery);
assert.deepEqual(payload.texts, source.texts);
assert.equal(payload.language, "he");
assert.deepEqual(payload.chatbot, bot);
assert.equal(payload.source_page_id, "P1");
assert.equal(payload.mirror, true);

// ── mirrorEditPatch: identity and portfolio fields only ──
const patch = mirrorEditPatch({
  agent: { name: "Bat K", brand_name: "BK", tagline: "x", phone: "0501" },
  theme: { accent: "#0f0" }, portfolio_visible: false, portfolio_rank: 2, public_slug: "dira-3",
  property: { title: "HACK" }, hero_phrase: "HACK", texts: { a: "HACK" },
}, now);
assert.deepEqual(patch, {
  updated_at: now,
  "agent.name": "Bat K", "agent.brand_name": "BK", "agent.tagline": "x", "agent.phone": "0501",
  theme: { accent: "#0f0" }, portfolio_visible: false, portfolio_rank: 2, public_slug: "dira-3",
});
assert.equal(mirrorEditPatch({ property: { title: "x" } }, now), null, "content-only edit is refused");
assert.equal(mirrorEditPatch({}, now), null);

// ── expandMirrors ──
(async () => {
  const pages = [source, { ...m, status: "active" }, { ...m, page_id: "m2", source_page_id: "missing" }];
  const getPage = async (id) => (id === "P1" ? source : null);
  const getListing = async (id) => (id === "L1" ? listing : null);
  const out = await expandMirrors(pages, getPage, getListing);
  assert.equal(out.length, 3);
  assert.strictEqual(out[0], source, "non-mirrors pass through by reference");
  assert.equal(out[1].page_id, "bat-realty-x1y2z");
  assert.equal(out[1].business_phone, "B");
  assert.deepEqual(out[1].property, source.property);
  assert.deepEqual(out[1].agent, m.agent);
  assert.equal(out[1].status, "active");
  assert.equal(out[1].source_page_id, "P1");
  assert.equal(out[2].status, "archived", "dangling mirror is hidden, not thrown");
  console.log("mirror.test.js OK");
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node mirror.test.js`
Expected: FAIL with `Cannot find module './mirror'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/mirror.js
/*
 * mirror.js — a "mirror page" is a property_pages doc that carries only the
 * mirroring agent's identity (agent, theme, portfolio fields) and points at a
 * source page via source_page_id. Content is never copied: every reader merges
 * the source under the mirror at request time with mirrorPayload/expandMirrors.
 */

const CONTENT_KEYS = ["property", "hero", "gallery", "carousel", "area", "cta", "sections", "texts"];

function isMirror(page) {
  return !!(page && typeof page.source_page_id === "string" && page.source_page_id);
}

function buildMirrorDoc({ sourcePage, listing, business, pageId, editToken, now }) {
  const b = business || {};
  return {
    page_id: pageId,
    source_page_id: sourcePage.page_id,
    listing_id: listing.listing_id,
    business_phone: b.phone,
    agency_id: listing.agency_id || sourcePage.agency_id || null,
    status: "active",
    created_at: now, updated_at: now,
    edit_token: editToken,
    edit_count: 0, extension_count: 0,
    view_count: 0, lead_count: 0,
    agent: {
      name: b.full_name || "",
      brand_name: b.business_name || b.full_name || "",
      logo_url: b.logo_url || null,
      tagline: b.slogan || "",
      phone: b.phone,
      phone2: null,
      license: b.license_number || "",
    },
    agent2: null,
    theme: null,
    language: sourcePage.language || "he",
    portfolio_visible: true,
    portfolio_rank: null,
    public_slug: null,
  };
}

function effectiveStatus(mirror, source, listing) {
  if (!mirror || mirror.status === "archived") return "archived";
  if (!source || source.status === "archived" || source.status === "expired") return "archived";
  if (listing && (listing.status === "archived" || listing.agency_private === true)) return "archived";
  if (source.status === "building") return "building";
  return source.status;
}

function mirrorPayload(mirror, source, chatbot) {
  const out = {
    page_id: mirror.page_id, status: mirror.status,
    agent: mirror.agent, agent2: mirror.agent2 || null,
    theme: mirror.theme || null,
    language: mirror.language || source.language || "he",
    chatbot: chatbot || { enabled: false, greeting: null },
    source_page_id: source.page_id,
    mirror: true,
  };
  for (const k of CONTENT_KEYS) out[k] = source[k] == null ? null : source[k];
  return out;
}

function mirrorEditPatch(body, now = new Date()) {
  const b = body || {};
  const patch = {};
  if (b.agent && typeof b.agent === "object") {
    if (b.agent.name != null) patch["agent.name"] = String(b.agent.name).slice(0, 60);
    if (b.agent.brand_name != null) patch["agent.brand_name"] = String(b.agent.brand_name).slice(0, 60);
    if (b.agent.tagline != null) patch["agent.tagline"] = String(b.agent.tagline).slice(0, 120);
    if (b.agent.phone != null) patch["agent.phone"] = String(b.agent.phone).slice(0, 20);
  }
  if (b.theme && typeof b.theme === "object") patch.theme = b.theme;
  if (typeof b.portfolio_visible === "boolean") patch.portfolio_visible = b.portfolio_visible;
  if (b.portfolio_rank === null || Number.isFinite(b.portfolio_rank)) patch.portfolio_rank = b.portfolio_rank;
  if (typeof b.public_slug === "string") patch.public_slug = b.public_slug.slice(0, 80);
  if (!Object.keys(patch).length) return null;
  return { updated_at: now, ...patch };
}

async function expandMirrors(pages, getPage, getListing) {
  const out = [];
  for (const p of pages) {
    if (!isMirror(p)) { out.push(p); continue; }
    const source = await getPage(p.source_page_id).catch(() => null);
    const listing = getListing ? await getListing(p.listing_id).catch(() => null) : null;
    const status = effectiveStatus(p, source, listing);
    if (!source) { out.push({ ...p, status }); continue; }
    const merged = { ...source, ...p, status };
    for (const k of CONTENT_KEYS) merged[k] = source[k];
    out.push(merged);
  }
  return out;
}

module.exports = { CONTENT_KEYS, isMirror, buildMirrorDoc, effectiveStatus, mirrorPayload, mirrorEditPatch, expandMirrors };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node mirror.test.js`
Expected: `mirror.test.js OK`

- [ ] **Step 5: Add to npm test and commit**

Append ` && node mirror.test.js` to the `"test"` script in `server/package.json`.

Run: `cd server && npm test 2>&1 | tail -2` — expect `mirror.test.js OK`.

```bash
git add server/mirror.js server/mirror.test.js server/package.json
git commit -m "feat(agency): mirror page helpers"
```

---

### Task 3: Storage helpers in db.js

**Files:**
- Modify: `server/db.js` (the `mem` object on line 11, `getBusiness`/`setBusiness` at lines 199-208, the exports block at line 498)
- Create: `server/db-agency.test.js`
- Modify: `server/package.json`

**Interfaces:**
- Produces (all async, all with a `mem` fallback so tests run without Firestore):
  - `getBusiness(phone)` / `setBusiness(phone, data, merge)` — now also work in mem mode via `mem.businesses`.
  - `getAgency(id)`, `saveAgency(agency)` (full set by `agency.agency_id`), `updateAgency(id, patch)` (merge), `listAgencies(limit = 200)`.
  - `getMember(agencyId, phone)`, `setMember(agencyId, member)` (member has `phone`), `deleteMember(agencyId, phone)`, `listMembers(agencyId)`.
  - `saveInvite(agencyId, invite)`, `getInvite(agencyId, token)`, `updateInvite(agencyId, token, patch)`.
  - `listListingsByAgency(agencyId, limit = 500)`, `listPagesByAgency(agencyId, limit = 500)`.
  - `listMirrorsBySource(sourcePageId)`, `findMirror(listingId, phone)` — mirror = page with `source_page_id` set.
  - `stampAgencyOnAssets(phone, agencyId)` — sets `agency_id` (string or `null`) on every listing and page whose `business_phone` is `phone`. Returns `{ listings, pages }` counts.

- [ ] **Step 1: Write the failing test**

```js
// server/db-agency.test.js
/*
 * Exercises the agency storage helpers in db.js against the in-memory store.
 * GOOGLE_APPLICATION_CREDENTIALS must be unset so db.init() picks mem mode.
 * Run: node server/db-agency.test.js
 */
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const assert = require("assert");
const db = require("./db");
db.init();

(async () => {
  // businesses now have a mem fallback
  assert.equal(await db.getBusiness("A"), null);
  await db.setBusiness("A", { phone: "A", full_name: "Avi" });
  await db.setBusiness("A", { logo_url: "a.png" });
  assert.deepEqual(await db.getBusiness("A"), { phone: "A", full_name: "Avi", logo_url: "a.png" }, "merge=true by default");
  await db.setBusiness("A", { phone: "A" }, false);
  assert.deepEqual(await db.getBusiness("A"), { phone: "A" }, "merge=false replaces");

  // agencies
  assert.equal(await db.getAgency("ag_x"), null);
  await db.saveAgency({ agency_id: "ag_x", name: "X", owner_phone: "A", seats: 3, status: "active" });
  assert.equal((await db.getAgency("ag_x")).name, "X");
  await db.updateAgency("ag_x", { seats: 5 });
  assert.equal((await db.getAgency("ag_x")).seats, 5);
  assert.equal((await db.getAgency("ag_x")).name, "X", "update merges");
  assert.equal((await db.listAgencies()).length, 1);

  // members
  assert.deepEqual(await db.listMembers("ag_x"), []);
  await db.setMember("ag_x", { phone: "A", role: "owner", status: "active" });
  await db.setMember("ag_x", { phone: "B", role: "agent", status: "pending" });
  assert.equal((await db.getMember("ag_x", "B")).status, "pending");
  await db.setMember("ag_x", { phone: "B", role: "agent", status: "active" });
  assert.equal((await db.getMember("ag_x", "B")).status, "active", "setMember replaces");
  assert.equal((await db.listMembers("ag_x")).length, 2);
  await db.deleteMember("ag_x", "B");
  assert.equal(await db.getMember("ag_x", "B"), null);
  assert.equal(await db.getMember("ag_nope", "A"), null);

  // invites
  await db.saveInvite("ag_x", { token: "t1", used_by: null });
  assert.equal((await db.getInvite("ag_x", "t1")).used_by, null);
  await db.updateInvite("ag_x", "t1", { used_by: "B" });
  assert.equal((await db.getInvite("ag_x", "t1")).used_by, "B");
  assert.equal(await db.getInvite("ag_x", "nope"), null);

  // agency-scoped lists + stamping
  await db.saveListing({ listing_id: "L1", business_phone: "A", status: "active" });
  await db.saveListing({ listing_id: "L2", business_phone: "B", status: "active" });
  await db.savePage({ page_id: "P1", listing_id: "L1", business_phone: "A", status: "active" });
  await db.savePage({ page_id: "M1", listing_id: "L1", business_phone: "B", source_page_id: "P1", status: "active" });
  assert.deepEqual(await db.listListingsByAgency("ag_x"), []);
  assert.deepEqual(await db.stampAgencyOnAssets("A", "ag_x"), { listings: 1, pages: 1 });
  assert.equal((await db.listListingsByAgency("ag_x")).length, 1);
  assert.equal((await db.listPagesByAgency("ag_x")).length, 1);
  assert.equal((await db.getListing("L2")).agency_id, undefined, "other phone untouched");
  await db.stampAgencyOnAssets("A", null);
  assert.equal((await db.getListing("L1")).agency_id, null);

  // mirrors
  assert.equal((await db.listMirrorsBySource("P1"))[0].page_id, "M1");
  assert.deepEqual(await db.listMirrorsBySource("P9"), []);
  assert.equal((await db.findMirror("L1", "B")).page_id, "M1");
  assert.equal(await db.findMirror("L1", "C"), null);
  console.log("db-agency.test.js OK");
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node db-agency.test.js`
Expected: FAIL at the first `assert.deepEqual(await db.getBusiness("A"), ...)` because `getBusiness` returns `null` in mem mode (or `db.getAgency is not a function`).

- [ ] **Step 3: Implement**

In `server/db.js`:

3a. Extend the `mem` literal on line 11 by adding these entries inside the object:

```js
businesses: new Map(), agencies: new Map(), members: new Map(), invites: new Map(),
```

3b. Replace `getBusiness` and `setBusiness` (lines 199-208) with:

```js
async function getBusiness(phone) {
  if (db) {
    const d = await db.collection("businesses").doc(phone).get();
    return d.exists ? d.data() : null;
  }
  return mem.businesses.get(phone) || null;
}

async function setBusiness(phone, data, merge = true) {
  if (db) { await db.collection("businesses").doc(phone).set(data, { merge }); return; }
  const prev = merge ? (mem.businesses.get(phone) || {}) : {};
  mem.businesses.set(phone, { ...prev, ...data });
}
```

3c. Add a new section before `module.exports`:

```js
// ── agencies (see docs/superpowers/specs/2026-09-04-agency-support-design.md) ──
// members and invites are subcollections; mem keys are `${agencyId}/${key}`.
const memKey = (agencyId, k) => `${agencyId}/${k}`;

async function getAgency(id) {
  if (db) { const d = await db.collection("agencies").doc(id).get(); return d.exists ? d.data() : null; }
  return mem.agencies.get(id) || null;
}
async function saveAgency(agency) {
  if (db) await db.collection("agencies").doc(agency.agency_id).set(agency);
  else mem.agencies.set(agency.agency_id, agency);
}
async function updateAgency(id, patch) {
  if (db) { await db.collection("agencies").doc(id).set(patch, { merge: true }); return; }
  mem.agencies.set(id, { ...(mem.agencies.get(id) || {}), ...patch });
}
async function listAgencies(limit = 200) {
  if (db) { const snap = await db.collection("agencies").limit(limit).get(); return snap.docs.map((d) => d.data()); }
  return [...mem.agencies.values()].slice(0, limit);
}

async function getMember(agencyId, phone) {
  if (db) {
    const d = await db.collection("agencies").doc(agencyId).collection("members").doc(phone).get();
    return d.exists ? d.data() : null;
  }
  return mem.members.get(memKey(agencyId, phone)) || null;
}
async function setMember(agencyId, member) {
  if (db) await db.collection("agencies").doc(agencyId).collection("members").doc(member.phone).set(member);
  else mem.members.set(memKey(agencyId, member.phone), member);
}
async function deleteMember(agencyId, phone) {
  if (db) await db.collection("agencies").doc(agencyId).collection("members").doc(phone).delete();
  else mem.members.delete(memKey(agencyId, phone));
}
async function listMembers(agencyId) {
  if (db) {
    const snap = await db.collection("agencies").doc(agencyId).collection("members").limit(500).get();
    return snap.docs.map((d) => d.data());
  }
  const prefix = memKey(agencyId, "");
  return [...mem.members.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
}

async function saveInvite(agencyId, invite) {
  if (db) await db.collection("agencies").doc(agencyId).collection("invites").doc(invite.token).set(invite);
  else mem.invites.set(memKey(agencyId, invite.token), invite);
}
async function getInvite(agencyId, token) {
  if (db) {
    const d = await db.collection("agencies").doc(agencyId).collection("invites").doc(token).get();
    return d.exists ? d.data() : null;
  }
  return mem.invites.get(memKey(agencyId, token)) || null;
}
async function updateInvite(agencyId, token, patch) {
  if (db) { await db.collection("agencies").doc(agencyId).collection("invites").doc(token).set(patch, { merge: true }); return; }
  const k = memKey(agencyId, token);
  mem.invites.set(k, { ...(mem.invites.get(k) || {}), ...patch });
}

// Single-field queries only: no composite index needed. Callers filter status in memory.
async function listListingsByAgency(agencyId, limit = 500) {
  if (db) {
    const snap = await db.collection("listings").where("agency_id", "==", agencyId).limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.listings.values()].filter((l) => l.agency_id === agencyId).slice(0, limit);
}
async function listPagesByAgency(agencyId, limit = 500) {
  if (db) {
    const snap = await db.collection("property_pages").where("agency_id", "==", agencyId).limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.pages.values()].filter((p) => p.agency_id === agencyId).slice(0, limit);
}
async function listMirrorsBySource(sourcePageId) {
  if (db) {
    const snap = await db.collection("property_pages").where("source_page_id", "==", sourcePageId).limit(200).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.pages.values()].filter((p) => p.source_page_id === sourcePageId);
}
async function findMirror(listingId, phone) {
  const pages = await listPagesByPhone(phone, 500);
  return pages.find((p) => p.source_page_id && p.listing_id === listingId) || null;
}

// Join/leave: keep the denormalized agency_id in step on everything the agent owns.
async function stampAgencyOnAssets(phone, agencyId) {
  const listings = await listListingsByPhone(phone);
  const pages = await listPagesByPhone(phone, 500);
  for (const l of listings) await updateListing(l.listing_id, { agency_id: agencyId });
  for (const p of pages) await updatePage(p.page_id, { agency_id: agencyId });
  return { listings: listings.length, pages: pages.length };
}
```

Note: `listListingsByPhone` caps at 100 today. Change its `.limit(100)` to `.limit(500)` so stamping covers busy agents.

3d. Add to `module.exports`:

```js
  getAgency, saveAgency, updateAgency, listAgencies,
  getMember, setMember, deleteMember, listMembers,
  saveInvite, getInvite, updateInvite,
  listListingsByAgency, listPagesByAgency, listMirrorsBySource, findMirror, stampAgencyOnAssets,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node db-agency.test.js`
Expected: `db-agency.test.js OK`

Check `updatePage` in mem mode handles a plain key (it iterates `Object.entries(patch)` and supports dotted paths; a plain `agency_id` key must set `p.agency_id`). If the test fails on `agency_id` being undefined after stamping, read `updatePage` lines 186-197 and make sure a key without a dot is assigned directly.

- [ ] **Step 5: Run the whole suite, add to npm test, commit**

Append ` && node db-agency.test.js` to the `"test"` script.

Run: `cd server && npm test 2>&1 | tail -3` — all OK lines, exit 0.

```bash
git add server/db.js server/db-agency.test.js server/package.json
git commit -m "feat(agency): storage helpers for agencies, members, invites, mirrors"
```

---

### Task 4: Stamp agency_id and agency_private on new listings and pages

**Files:**
- Modify: `server/routes/intake.js` (the listing literal at lines 129-160 inside `createListing`)
- Modify: `server/routes/pages.js` (the page `doc` literal at lines 210-224 in `/createPropertyPage`)
- Modify: `server/routes/dashboard.js` (new endpoint after `/properties`)

**Interfaces:**
- Consumes: `db.getBusiness(phone)`, `db.updateListing(id, patch)`, `db.listMirrorsBySource(pageId)`, `db.updatePage(id, patch)`.
- Produces: `listings.agency_id`, `listings.agency_private`, `property_pages.agency_id` on all new docs; `POST /api/properties/private { listing_id, agency_private }`.

- [ ] **Step 1: Stamp listings in intake.js**

Inside `createListing`, right before `const listingId = crypto.randomUUID();` (line 128), add:

```js
    // Agency denormalization: stamped once here, kept in step by stampAgencyOnAssets on join/leave.
    const ownerBiz = await db.getBusiness(phone).catch(() => null);
    const agencyId = (ownerBiz && ownerBiz.agency_id) || null;
```

In the listing literal add two fields after `status: "active", page_id: null,`:

```js
      agency_id: agencyId,
      agency_private: body.agency_private === true,
```

- [ ] **Step 2: Stamp pages in pages.js**

In `/createPropertyPage`, the code already loads `listing` at line 135. In the `doc` literal add after `business_phone: body.business_phone,`:

```js
        agency_id: (listing && listing.agency_id) || null,
```

- [ ] **Step 3: Add the private toggle endpoint in dashboard.js**

After the `/properties` handler (ends near line 49) add:

```js
  // ── agency pool opt-out: an exclusive listing the office must not mirror ──
  router.post("/properties/private", requireAuth(authSecret), async (req, res) => {
    const listingId = String((req.body && req.body.listing_id) || "");
    const priv = !!(req.body && req.body.agency_private);
    if (!listingId) return res.status(400).json({ error: "listing_id required" });
    try {
      const l = await db.getListing(listingId);
      if (!l || l.business_phone !== req.user.userId) return res.status(403).json({ error: "not_owner" });
      await db.updateListing(listingId, { agency_private: priv, updated_at: new Date() });
      // Existing mirrors go dark immediately; they come back if the flag is cleared.
      if (l.page_id) {
        const mirrors = await db.listMirrorsBySource(l.page_id);
        for (const m of mirrors) await db.updatePage(m.page_id, { status: priv ? "archived" : "active", updated_at: new Date() });
      }
      res.json({ ok: true, agency_private: priv });
    } catch (err) {
      console.error("properties/private failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });
```

- [ ] **Step 4: Manual check**

Run: `cd server && npm test 2>&1 | tail -1` — exit 0 (no unit test covers routes; this guards syntax via `require`).

Run: `cd server && node -e "require('./routes/intake'); require('./routes/pages'); require('./routes/dashboard'); console.log('routes load')"`
Expected: `routes load`

- [ ] **Step 5: Commit**

```bash
git add server/routes/intake.js server/routes/pages.js server/routes/dashboard.js
git commit -m "feat(agency): stamp agency_id on listings and pages, private toggle"
```

---

### Task 5: Agency router — membership (owner add, invite, accept, remove)

**Files:**
- Create: `server/routes/agency.js`
- Modify: `server/index.js` (mount after the dashboard router, line 119)

**Interfaces:**
- Consumes: `agency.js` (`seatCheck`, `newInvite`, `inviteValid`, `mergeFeatureDefaults`), `db.js` (Task 3 helpers, `getBusiness`, `setBusiness`, `stampAgencyOnAssets`, `listMirrorsBySource`, `listPagesByPhone`, `updatePage`), `requireAuth(authSecret)` from `auth.js`, `normalizeAuthPhone` from `utils.js`.
- Produces:
  - `GET /api/agency` → `{ agency: null }` for non-members; for members `{ agency: { agency_id, name, brand, plan, seats, owner_phone, role, status }, members: [...] }` where `members` is present only for the owner.
  - `POST /api/agency/members { phone }` (owner) → `{ ok, status: "active"|"pending" }`.
  - `DELETE /api/agency/members/:phone` (owner) → `{ ok }`.
  - `POST /api/agency/invites` (owner) → `{ url, expires_at }`.
  - `POST /api/agency/invites/accept { agency_id, token }` (any logged-in agent) → `{ ok, agency_id }`.
  - Exported helper `joinAgency(db, agencyId, phone, { role, addedBy, now })` and `leaveAgency(db, agencyId, phone)` reused by Task 6 (pending activation) and Task 8 (admin).

- [ ] **Step 1: Write the router**

```js
// server/routes/agency.js
/*
 * routes/agency.js — agency membership and owner dashboard.
 * Owner = businesses/{phone} whose phone is agencies/{id}.owner_phone. Owner
 * access is READ-ONLY over members' data (spec §2). Decision logic is in
 * ../agency.js; this file is HTTP glue.
 */
const express = require("express");
const db = require("../db");
const agencyLib = require("../agency");
const { normalizeAuthPhone } = require("../utils");

/** Attach a business to an agency: member doc, business fields, asset stamp, feature defaults. */
async function joinAgency(store, agencyId, phone, { role = "agent", addedBy = null, now = new Date() } = {}) {
  const agency = await store.getAgency(agencyId);
  if (!agency) throw Object.assign(new Error("not_found"), { status: 404 });
  const biz = await store.getBusiness(phone);
  if (biz && biz.agency_id && biz.agency_id !== agencyId) {
    throw Object.assign(new Error("already_member"), { status: 409 });
  }
  const existing = await store.getMember(agencyId, phone);
  if (!existing || existing.status !== "active") {
    const members = await store.listMembers(agencyId);
    const check = agencyLib.seatCheck(agency, members.filter((m) => m.phone !== phone));
    if (!check.ok) throw Object.assign(new Error("seat_cap"), { status: 409, detail: check });
  }
  const complete = !!biz && biz.onboarding_state === "complete";
  const status = complete ? "active" : "pending";
  await store.setMember(agencyId, {
    phone, role, status, added_by: addedBy,
    joined_at: complete ? now : null, created_at: (existing && existing.created_at) || now,
  });
  await store.setBusiness(phone, {
    agency_id: agencyId, agency_role: role, agency_status: status,
    features: agencyLib.mergeFeatureDefaults(biz && biz.features, agency.features),
    updated_at: now,
  });
  if (complete) await store.stampAgencyOnAssets(phone, agencyId);
  return { status };
}

/** Called when a pending member finishes signup (profile complete / demo-create). */
async function activatePendingMembership(store, phone, now = new Date()) {
  const biz = await store.getBusiness(phone);
  if (!biz || !biz.agency_id || biz.agency_status !== "pending") return false;
  const member = await store.getMember(biz.agency_id, phone);
  if (!member) return false;
  await store.setMember(biz.agency_id, { ...member, status: "active", joined_at: now });
  await store.setBusiness(phone, { agency_status: "active", updated_at: now });
  await store.stampAgencyOnAssets(phone, biz.agency_id);
  return true;
}

/** Detach: clear denormalized ids and archive every mirror in both directions. */
async function leaveAgency(store, agencyId, phone) {
  const now = new Date();
  await store.deleteMember(agencyId, phone);
  await store.setBusiness(phone, { agency_id: null, agency_role: null, agency_status: null, updated_at: now });
  await store.stampAgencyOnAssets(phone, null);
  const pages = await store.listPagesByPhone(phone, 500);
  for (const p of pages) {
    if (p.source_page_id) {
      await store.updatePage(p.page_id, { status: "archived", updated_at: now });      // leaver's mirrors of office listings
    } else {
      for (const m of await store.listMirrorsBySource(p.page_id)) {                   // office mirrors of leaver's listings
        await store.updatePage(m.page_id, { status: "archived", updated_at: now });
      }
    }
  }
}

module.exports = function createAgencyRouter(ctx) {
  const { requireAuth, authSecret, pageBaseUrl } = ctx;
  const router = express.Router();

  const fail = (res, err) => {
    if (err && err.status) return res.status(err.status).json({ error: err.message, ...(err.detail ? { detail: err.detail } : {}) });
    console.error("agency route failed:", err);
    return res.status(500).json({ error: "internal" });
  };

  // Loads caller's business + agency; req.agency / req.member / req.isOwner.
  async function loadContext(req, res, next) {
    try {
      const biz = await db.getBusiness(req.user.userId);
      req.business = biz;
      req.agency = biz && biz.agency_id ? await db.getAgency(biz.agency_id) : null;
      req.member = req.agency ? await db.getMember(req.agency.agency_id, req.user.userId) : null;
      req.isOwner = !!(req.agency && req.agency.owner_phone === req.user.userId);
      next();
    } catch (err) { fail(res, err); }
  }
  const requireMember = (req, res, next) => {
    if (!req.agency || !req.member || req.member.status !== "active") return res.status(403).json({ error: "not_member" });
    next();
  };
  const requireOwner = (req, res, next) => {
    if (!req.agency || !req.isOwner) return res.status(403).json({ error: "not_owner" });
    next();
  };
  const auth = [requireAuth(authSecret), loadContext];

  // ── GET /api/agency ──
  router.get("/", ...auth, async (req, res) => {
    if (!req.agency) return res.json({ agency: null });
    const a = req.agency;
    const out = {
      agency: {
        agency_id: a.agency_id, name: a.name, brand: a.brand || {}, plan: a.plan, seats: a.seats,
        owner_phone: a.owner_phone, status: a.status, role: req.isOwner ? "owner" : "agent",
        member_status: req.member ? req.member.status : null,
      },
    };
    if (req.isOwner) {
      try {
        const members = await db.listMembers(a.agency_id);
        const summaries = [];
        for (const m of members) {
          const [biz, listings, pages, quota] = await Promise.all([
            db.getBusiness(m.phone),
            db.listListingsByPhone(m.phone),
            db.listPagesByPhone(m.phone, 500),
            db.db ? db.db.collection("businesses").doc(m.phone).collection("quota").doc("current").get()
              .then((d) => (d.exists ? d.data() : null)).catch(() => null) : Promise.resolve(null),
          ]);
          summaries.push(agencyLib.memberSummary(m, biz, listings, pages, quota));
        }
        out.members = summaries;
        out.seats = agencyLib.seatCheck(a, members);
      } catch (err) { return fail(res, err); }
    }
    res.json(out);
  });

  // ── owner: add by phone ──
  router.post("/members", ...auth, requireOwner, async (req, res) => {
    const phone = normalizeAuthPhone(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ error: "valid phone required" });
    try {
      const r = await joinAgency(db, req.agency.agency_id, phone, { addedBy: req.user.userId });
      res.json({ ok: true, status: r.status });
    } catch (err) { fail(res, err); }
  });

  // ── owner or self: remove ──
  router.delete("/members/:phone", ...auth, async (req, res) => {
    if (!req.agency) return res.status(403).json({ error: "not_member" });
    const phone = normalizeAuthPhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: "valid phone required" });
    if (!req.isOwner && phone !== req.user.userId) return res.status(403).json({ error: "not_owner" });
    if (phone === req.agency.owner_phone) return res.status(400).json({ error: "owner_cannot_leave" });
    try {
      await leaveAgency(db, req.agency.agency_id, phone);
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  // ── owner: invite link ──
  router.post("/invites", ...auth, requireOwner, async (req, res) => {
    try {
      const inv = agencyLib.newInvite(req.user.userId);
      await db.saveInvite(req.agency.agency_id, inv);
      const url = `${pageBaseUrl}/agency.html?join=${encodeURIComponent(req.agency.agency_id)}&token=${encodeURIComponent(inv.token)}`;
      res.json({ url, expires_at: inv.expires_at });
    } catch (err) { fail(res, err); }
  });

  // ── any logged-in agent: accept invite ──
  router.post("/invites/accept", requireAuth(authSecret), async (req, res) => {
    const agencyId = String((req.body && req.body.agency_id) || "");
    const token = String((req.body && req.body.token) || "");
    if (!agencyId || !token) return res.status(400).json({ error: "agency_id and token required" });
    try {
      const inv = await db.getInvite(agencyId, token);
      if (!agencyLib.inviteValid(inv)) return res.status(410).json({ error: "invite_invalid" });
      const r = await joinAgency(db, agencyId, req.user.userId, { addedBy: inv.created_by });
      await db.updateInvite(agencyId, token, { used_by: req.user.userId, used_at: new Date() });
      res.json({ ok: true, agency_id: agencyId, status: r.status });
    } catch (err) { fail(res, err); }
  });

  return router;
};

module.exports.joinAgency = joinAgency;
module.exports.leaveAgency = leaveAgency;
module.exports.activatePendingMembership = activatePendingMembership;
```

- [ ] **Step 2: Mount it in index.js**

After the dashboard router block (after line 119) add:

```js
// ── agency routes (membership, owner read-only dashboard, mirrors) ──
const createAgencyRouter = require("./routes/agency");
app.use("/api/agency", createAgencyRouter({ requireAuth, authSecret: AUTH_SECRET, pageBaseUrl: PAGE_BASE_URL }));
```

- [ ] **Step 3: Smoke test in mem mode with curl**

Start: `cd server && NADLAN_JWT_SECRET=devsecret node index.js &` (`AUTH_SECRET` in `index.js` line 42 reads `NADLAN_JWT_SECRET`). Log in via the existing OTP flow is heavy; instead, run this node one-liner to mint a session cookie for phone `972500000001` using `signSession` from `auth.js`:

```bash
cd server && node -e "const a=require('./auth');console.log(a.signSession(process.env.NADLAN_JWT_SECRET||'devsecret','972500000001'))"
```

Then:

```bash
curl -s -b "forly_session=<token>" http://127.0.0.1:8787/api/agency
```
Expected: `{"agency":null}`

Stop the server (`kill %1`). Full owner flows are covered once Task 8's admin endpoint can create an agency; re-run then.

- [ ] **Step 4: Commit**

```bash
git add server/routes/agency.js server/index.js
git commit -m "feat(agency): membership router (add, invite, accept, remove) and owner summary"
```

---

### Task 6: Activate pending memberships on signup

**Files:**
- Modify: `server/routes/profile.js` (`/onboarding/complete`, after `db.setBusiness(... buildCompleteDoc ...)` near line 63)
- Modify: `server/routes/intake.js` (`/properties/demo-create`, after the `setBusiness` block near line 228)

**Interfaces:**
- Consumes: `activatePendingMembership(db, phone)` from `routes/agency.js`.

- [ ] **Step 1: profile.js**

Add at the top: `const { activatePendingMembership } = require("./agency");`

After the `await db.setBusiness(phone, onboarding.buildCompleteDoc(...))` line, add:

```js
      // Owner pre-added this phone: the seat becomes active the moment the profile is complete.
      try { await activatePendingMembership(db, phone, now); }
      catch (err) { console.error("agency activation failed (profile still saved):", err.message); }
```

- [ ] **Step 2: intake.js**

Add at the top: `const { activatePendingMembership } = require("./agency");`

`activatePendingMembership` only activates when `onboarding_state === "complete"` is *not* required (the demo path leaves the business at `demo_partial`). The spec says demo-create should activate too, so in `/properties/demo-create`, after the `if (!existing || existing.onboarding_state !== "complete") { ... }` block, add:

```js
    // A demo agent the owner pre-added joins the office now; listings created
    // from here on carry the agency_id (createListing reads it from the business).
    try { await activatePendingMembership(db, agentPhone); }
    catch (err) { console.error("agency activation failed (demo still created):", err.message); }
```

Note the ordering problem: `createListing` ran *before* this block, so the very first demo listing lacks `agency_id`. `activatePendingMembership` calls `stampAgencyOnAssets`, which fixes exactly that listing. No extra code needed; add this comment above the call so the next reader knows it is deliberate.

- [ ] **Step 3: Verify and commit**

Run: `cd server && node -e "require('./routes/profile'); require('./routes/intake'); console.log('ok')"` — expect `ok`. Run `npm test` — exit 0.

```bash
git add server/routes/profile.js server/routes/intake.js
git commit -m "feat(agency): activate pending membership when an agent completes signup"
```

---

### Task 7: Mirror endpoints and mirror-aware rendering

**Files:**
- Modify: `server/routes/agency.js` (add two routes)
- Modify: `server/routes/pages.js` (`getPageHandler` line 301, `/api/property-by-slug` line 671, `loadPublicPortfolio` line ~620, `/api/page/update` line 365)
- Modify: `server/routes/dashboard.js` (`/properties` line 22)
- Modify: `server/leads.js` (`submitLead` line 20)
- Modify: `server/pages-auth.test.js` (append)
- Modify: `server/leads.test.js` (append)

**Interfaces:**
- Consumes: `mirror.js` (`isMirror`, `buildMirrorDoc`, `effectiveStatus`, `mirrorPayload`, `mirrorEditPatch`, `expandMirrors`), `agency.js` (`canMirror`), `db.uniquePageId(agent)`, `pageEdit.newEditToken()` (already imported in pages.js).
- Produces:
  - `GET /api/agency/listings` → `{ listings: [{ listing_id, owner_phone, owner_name, title, address, thumb_url, page_id, page_url, listing_type, mirrored_page_id }] }`.
  - `POST /api/agency/mirror { listing_id }` → `{ page_id, page_url, existing: boolean }`.
  - `pagePayload`-shaped responses for mirrors from `/api/property-page`, `/api/page`, `/api/property-by-slug`.
  - Leads from mirrors carry `source_page_id`.

- [ ] **Step 1: Add tests for the auth and lead changes**

Append to `server/pages-auth.test.js` before its final `console.log`:

```js
// ── mirrors: the mirror's owner is its business_phone, same rule as any page ──
const mirror = { business_phone: "0501234567", page_id: "m1", source_page_id: "p1" };
assert.equal(check({ session: session("0501234567"), page: mirror }).ok, true, "mirror owner may edit the mirror");
assert.equal(check({ session: session("0509999999"), page: mirror }).ok, false, "source owner may NOT edit someone's mirror");
```

Append to `server/leads.test.js` a case that a lead built from a mirror page records `source_page_id`. Read the top of that file first to reuse its existing stub pattern for `db`; the assertion shape is:

```js
// lead from a mirror routes to the mirror owner and remembers the source
// (adapt the call to this file's existing stubbing of ./db)
const mirrorPage = { page_id: "m1", listing_id: "L1", business_phone: "B", source_page_id: "P1", agent: { name: "Bat" } };
await submitLead({ page: mirrorPage, name: "Lead", phone: "0501111111", source: "page" });
const saved = /* the lead the stub captured for phone 0501111111 */;
assert.equal(saved.agent_phone, "B");
assert.equal(saved.source_page_id, "P1");
```

If `leads.test.js` cannot capture `saveLead` writes without a large refactor, put this assertion in `mirror.test.js` instead by testing a new pure helper `leadExtras(page)` in `leads.js` that returns `{ source_page_id: page.source_page_id || null }`; then use it inside `submitLead`.

- [ ] **Step 2: Run tests to see the new cases fail**

Run: `cd server && node pages-auth.test.js && node leads.test.js`
Expected: pages-auth passes already (no code change needed there, the assertions document the invariant). leads fails on `source_page_id` undefined.

- [ ] **Step 3: leads.js**

In `submitLead`, add `source_page_id: p && p.source_page_id ? p.source_page_id : null,` to both the `saveLead` object (after `listing_id`) and the `addLeadSubmission` object (after `agent_phone`, line ~55).

Run: `cd server && node leads.test.js` — passes.

- [ ] **Step 4: Mirror routes in routes/agency.js**

Add at the top: `const mirrorLib = require("../mirror");` and `const pageEdit = require("../edit");` (verify `edit.js` exports `newEditToken`; `routes/pages.js` calls `pageEdit.newEditToken()`, so mirror the same import line from that file).

Add before `return router;`:

```js
  // ── member: the agency pool ──
  router.get("/listings", ...auth, requireMember, async (req, res) => {
    try {
      const me = req.user.userId;
      const all = await db.listListingsByAgency(req.agency.agency_id);
      const mine = await db.listPagesByPhone(me, 500);
      const mirroredByListing = new Map(mine.filter((p) => p.source_page_id && p.status !== "archived").map((p) => [p.listing_id, p.page_id]));
      const owners = new Map();
      const listings = [];
      for (const l of all) {
        if (l.status !== "active" || l.agency_private === true || l.business_phone === me || !l.page_id) continue;
        if (!owners.has(l.business_phone)) owners.set(l.business_phone, await db.getBusiness(l.business_phone).catch(() => null));
        const o = owners.get(l.business_phone) || {};
        listings.push({
          listing_id: l.listing_id, owner_phone: l.business_phone,
          owner_name: o.full_name || o.business_name || "",
          title: `${l.rooms || ""} חד׳ ב${l.neighborhood || l.city || ""}`.trim(),
          address: [l.address, l.city].filter(Boolean).join(", "),
          thumb_url: (l.photos_urls && l.photos_urls[0]) || null,
          page_id: l.page_id, page_url: `${pageBaseUrl}/p/${l.page_id}`,
          listing_type: l.listing_type || "sale",
          mirrored_page_id: mirroredByListing.get(l.listing_id) || null,
        });
      }
      res.json({ listings });
    } catch (err) { fail(res, err); }
  });

  // ── member: market a colleague's listing as my own (idempotent) ──
  router.post("/mirror", ...auth, requireMember, async (req, res) => {
    const listingId = String((req.body && req.body.listing_id) || "");
    if (!listingId) return res.status(400).json({ error: "listing_id required" });
    try {
      const me = req.user.userId;
      const listing = await db.getListing(listingId);
      const sourcePage = listing && listing.page_id ? await db.getPage(listing.page_id) : null;
      const existingMirror = await db.findMirror(listingId, me);
      const verdict = agencyLib.canMirror({ listing, sourcePage, callerPhone: me, callerAgencyId: req.agency.agency_id, existingMirror });
      if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });
      if (verdict.existing) {
        if (existingMirror.status === "archived") await db.updatePage(existingMirror.page_id, { status: "active", updated_at: new Date() });
        return res.json({ page_id: verdict.existing, page_url: `${pageBaseUrl}/p/${verdict.existing}`, existing: true });
      }
      const biz = req.business || { phone: me };
      const pageId = await db.uniquePageId({ brand_name: biz.business_name, name: biz.full_name });
      const doc = mirrorLib.buildMirrorDoc({ sourcePage, listing, business: { ...biz, phone: me }, pageId, editToken: pageEdit.newEditToken(), now: new Date() });
      await db.savePage(doc);
      res.json({ page_id: pageId, page_url: `${pageBaseUrl}/p/${pageId}`, existing: false });
    } catch (err) { fail(res, err); }
  });
```

Check `db.uniquePageId`'s `agentSlug(agent)` (db.js ~line 110-121) to confirm which keys it reads; pass the keys it expects.

- [ ] **Step 5: Mirror-aware getPageHandler in routes/pages.js**

Add at the top: `const mirrorLib = require("../mirror");`

Inside `getPageHandler`, after `const d = await db.getPage(id); if (!d) return res.status(404)...`, insert before the `expired/archived` check:

```js
    if (mirrorLib.isMirror(d)) {
      const source = await db.getPage(d.source_page_id).catch(() => null);
      const listing = await db.getListing(d.listing_id).catch(() => null);
      const status = mirrorLib.effectiveStatus(d, source, listing);
      if (status === "archived" || !source) {
        res.set("Cache-Control", "public, max-age=60");
        return res.json({ page_id: id, status: "archived", property: { title: (source && source.property && source.property.title) || "" },
          agent: { name: d.agent.name, brand_name: d.agent.brand_name, phone: d.agent.phone }, language: d.language || "he" });
      }
      if (status === "building") return res.status(404).json({ error: "not ready" });
      const token = typeof req.query.edit_token === "string" ? req.query.edit_token : "";
      const editable = !!(token && !pageEdit.editThrottled(id) && pageEdit.editTokenOk(d, token));
      res.set("Cache-Control", editable ? "no-store" : "public, max-age=60");
      const bot = await resolveChatbot(d);                     // chatbot entitlement follows the MIRROR owner
      return res.json({ ...mirrorLib.mirrorPayload({ ...d, status }, source, bot.public), ...(editable ? { editable: true, mirror_readonly_content: true } : {}) });
    }
```

- [ ] **Step 6: Mirror-aware portfolio paths**

In `loadPublicPortfolio` (line ~622) change:

```js
    const pages = await db.listPagesByPhone(reservation.business_phone, 100);
```
to
```js
    const pages = await mirrorLib.expandMirrors(await db.listPagesByPhone(reservation.business_phone, 100), db.getPage, db.getListing);
```

In `/api/property-by-slug` (line ~687) make the same replacement, and after `const page = pages.find(...)`, `pagePayload(page.page_id, page, bot.public)` already works because `expandMirrors` merged content in. No further change.

- [ ] **Step 7: Content edits on mirrors are refused**

In `/api/page/update`, right after the ownership verdict block and before `try {`, add:

```js
    if (mirrorLib.isMirror(d)) {
      const patch = mirrorLib.mirrorEditPatch(body, new Date());
      if (!patch) return res.status(403).json({ error: "mirror_readonly" });
      patch.edit_count = (d.edit_count || 0) + 1;
      await db.updatePage(pageId, patch);
      return res.json({ ok: true, mirror: true });
    }
```

Also in `/api/page/edit-text` (line 333): read the handler; if it writes `texts`, add the same guard returning `403 mirror_readonly` when `mirrorLib.isMirror(d)`.

- [ ] **Step 8: Mirrors in the agent dashboard list**

In `routes/dashboard.js` `/properties`, after the `for (const l of listings)` loop and before `res.json({ properties })`, add:

```js
    // Mirrors: pages I market for colleagues. Content comes from the source page.
    const mine = await db.listPagesByPhone(req.user.userId, 500);
    for (const m of mine) {
      if (!m.source_page_id || m.status === "archived") continue;
      const src = await db.getPage(m.source_page_id).catch(() => null);
      if (!src || src.status === "archived" || src.status === "expired") continue;
      const owner = await db.getBusiness(src.business_phone).catch(() => null);
      properties.push({
        listing_id: m.listing_id, mirror: true, source_page_id: m.source_page_id,
        shared_from: (owner && (owner.full_name || owner.business_name)) || "",
        title: (src.property && src.property.title) || "",
        address: [src.property && src.property.address, src.property && src.property.city].filter(Boolean).join(", "),
        thumb_url: (src.gallery && src.gallery[0] && src.gallery[0].url) || null,
        page_id: m.page_id, page_url: `${pageBaseUrl}/p/${m.page_id}`,
        page_status: src.status, listing_type: (src.property && src.property.listing_type) || "sale",
        days_left: null, view_count: m.view_count || 0, lead_count: m.lead_count || 0,
      });
    }
```

Also add `agency_private: l.agency_private === true,` to the existing per-listing object so the UI can render the toggle.

- [ ] **Step 9: Run everything and commit**

Run: `cd server && npm test 2>&1 | tail -3` — exit 0.
Run: `cd server && node -e "require('./routes/pages'); require('./routes/agency'); require('./routes/dashboard'); console.log('ok')"` — `ok`.

```bash
git add server/routes/agency.js server/routes/pages.js server/routes/dashboard.js server/leads.js server/pages-auth.test.js server/leads.test.js
git commit -m "feat(agency): mirror pages — pool listing, create mirror, mirror-aware render and edit"
```

---

### Task 8: Admin endpoints for agencies

**Files:**
- Modify: `server/routes/admin.js` (append before `return router;`)

**Interfaces:**
- Consumes: `agency.js` (`newAgencyId`, `AGENCY_PLANS`, `seatCheck`), `routes/agency.js` (`joinAgency`, `leaveAgency`), db helpers.
- Produces (all `requireAdmin`):
  - `GET /api/admin/agencies` → `{ agencies: [{ agency_id, name, owner_phone, plan, seats, status, used, members: [{ phone, role, status }] }] }`
  - `POST /api/admin/agencies { name, owner_phone, plan, seats, brand?, features? }` → `{ agency_id }` (creates the agency and joins the owner with role `owner`)
  - `POST /api/admin/agencies/:id { name?, plan?, seats?, status?, brand?, features? }` → `{ ok }`
  - `POST /api/admin/agencies/:id/members { phone, action: "add"|"remove" }` → `{ ok, status? }`

- [ ] **Step 1: Implement**

Add at the top of `routes/admin.js`:

```js
const agencyLib = require("../agency");
const { joinAgency, leaveAgency } = require("./agency");
```

Append before `return router;`:

```js
  // ── agencies (spec: docs/superpowers/specs/2026-09-04-agency-support-design.md) ──
  const cleanBrand = (b) => (b && typeof b === "object" ? {
    logo_url: typeof b.logo_url === "string" ? b.logo_url.slice(0, 500) : null,
    brand_colors: Array.isArray(b.brand_colors) ? b.brand_colors.filter((c) => /^#[0-9a-fA-F]{6}$/.test(String(c))).slice(0, 4) : [],
    slogan: typeof b.slogan === "string" ? b.slogan.slice(0, 120) : "",
  } : undefined);
  const cleanFeatures = (f) => (f && typeof f === "object"
    ? Object.fromEntries(Object.entries(f).filter(([k, v]) => ["chatbot", "portfolio", "distribution"].includes(k) && typeof v === "boolean"))
    : undefined);

  router.get("/agencies", requireAdmin, async (req, res) => {
    try {
      const agencies = await db.listAgencies();
      const out = [];
      for (const a of agencies) {
        const members = await db.listMembers(a.agency_id);
        out.push({ ...a, used: agencyLib.seatCheck(a, members).used, members: members.map((m) => ({ phone: m.phone, role: m.role, status: m.status })) });
      }
      res.json({ agencies: out });
    } catch (err) { console.error("admin/agencies failed:", err); res.status(500).json({ error: "internal" }); }
  });

  router.post("/agencies", requireAdmin, async (req, res) => {
    const b = req.body || {};
    const owner = normalizeAuthPhone(b.owner_phone);
    const name = String(b.name || "").trim().slice(0, 80);
    const seats = Number(b.seats);
    const plan = agencyLib.AGENCY_PLANS.includes(b.plan) ? b.plan : "agency_trial";
    if (!owner || !name || !Number.isInteger(seats) || seats < 1) return res.status(400).json({ error: "name, owner_phone, seats>=1 required" });
    try {
      const ownerBiz = await db.getBusiness(owner);
      if (ownerBiz && ownerBiz.agency_id) return res.status(409).json({ error: "already_member" });
      const now = new Date();
      const agency = {
        agency_id: agencyLib.newAgencyId(), name, owner_phone: owner, plan, seats, status: "active",
        brand: cleanBrand(b.brand) || { logo_url: null, brand_colors: [], slogan: "" },
        features: cleanFeatures(b.features) || {},
        created_at: now, updated_at: now,
      };
      await db.saveAgency(agency);
      await joinAgency(db, agency.agency_id, owner, { role: "owner", addedBy: req.user.userId, now });
      res.json({ agency_id: agency.agency_id });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error("admin/agencies create failed:", err); res.status(500).json({ error: "internal" });
    }
  });

  router.post("/agencies/:id", requireAdmin, async (req, res) => {
    const b = req.body || {};
    try {
      const a = await db.getAgency(req.params.id);
      if (!a) return res.status(404).json({ error: "not_found" });
      const patch = { updated_at: new Date() };
      if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim().slice(0, 80);
      if (agencyLib.AGENCY_PLANS.includes(b.plan)) patch.plan = b.plan;
      if (Number.isInteger(b.seats) && b.seats >= 1) patch.seats = b.seats;
      if (b.status === "active" || b.status === "suspended") patch.status = b.status;
      const brand = cleanBrand(b.brand); if (brand) patch.brand = brand;
      const features = cleanFeatures(b.features); if (features) patch.features = features;
      await db.updateAgency(a.agency_id, patch);
      res.json({ ok: true });
    } catch (err) { console.error("admin/agencies update failed:", err); res.status(500).json({ error: "internal" }); }
  });

  router.post("/agencies/:id/members", requireAdmin, async (req, res) => {
    const b = req.body || {};
    const phone = normalizeAuthPhone(b.phone);
    if (!phone) return res.status(400).json({ error: "valid phone required" });
    try {
      const a = await db.getAgency(req.params.id);
      if (!a) return res.status(404).json({ error: "not_found" });
      if (b.action === "remove") {
        if (phone === a.owner_phone) return res.status(400).json({ error: "owner_cannot_leave" });
        await leaveAgency(db, a.agency_id, phone);
        return res.json({ ok: true });
      }
      const r = await joinAgency(db, a.agency_id, phone, { addedBy: req.user.userId });
      res.json({ ok: true, status: r.status });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, ...(err.detail ? { detail: err.detail } : {}) });
      console.error("admin/agencies members failed:", err); res.status(500).json({ error: "internal" });
    }
  });
```

Also extend the existing `/agents` response (line ~190, the object with `plan: b.plan || ""`) with `agency_id: b.agency_id || null, agency_role: b.agency_role || null,` so the admin agent table can show membership.

- [ ] **Step 2: End-to-end smoke test in mem mode**

Start the server with an admin phone: `cd server && ADMIN_PHONES=972500000001 NADLAN_JWT_SECRET=devsecret node index.js &`. Mint cookies for `972500000001` (owner/admin) and `972500000002` (agent B) with the one-liner from Task 5. Then:

```bash
# Owner has no profile in mem mode, so their own seat shows status pending. That is expected.
A=<owner cookie>; B=<agent cookie>
curl -s -b "forly_session=$A" -H 'content-type: application/json' -d '{"name":"Office","owner_phone":"972500000001","seats":2,"plan":"agency"}' http://127.0.0.1:8787/api/admin/agencies
# → {"agency_id":"ag_..."}
curl -s -b "forly_session=$A" http://127.0.0.1:8787/api/agency
# → agency.role == "owner", members has 1 entry (status pending, because no profile yet in mem)
curl -s -b "forly_session=$A" -H 'content-type: application/json' -d '{"phone":"972500000002"}' http://127.0.0.1:8787/api/agency/members
# → {"ok":true,"status":"pending"}
curl -s -b "forly_session=$A" -H 'content-type: application/json' -d '{"phone":"972500000003"}' http://127.0.0.1:8787/api/agency/members
# → 409 {"error":"seat_cap",...}
curl -s -b "forly_session=$A" -X POST http://127.0.0.1:8787/api/agency/invites
# → {"url":".../agency.html?join=ag_...&token=..."}
curl -s -b "forly_session=$A" -X DELETE http://127.0.0.1:8787/api/agency/members/972500000002
# → {"ok":true}
```

Stop the server.

- [ ] **Step 3: Commit**

```bash
git add server/routes/admin.js
git commit -m "feat(agency): admin endpoints to create agencies, set plan/seats, manage members"
```

---

### Task 9: Brand inheritance and feature defaults at the read points

**Files:**
- Modify: `server/routes/pages.js` (`/createPropertyPage` logo fallback near line 140; portfolio profile logo near line 629)
- Modify: `server/routes/dashboard.js` (`/profile` response line 51)

**Interfaces:**
- Consumes: `resolveBrand(business, agency)` from `agency.js`, `db.getAgency`.

- [ ] **Step 1: Page creation**

In `/createPropertyPage`, `listing` is loaded at line 135 and `logoSrc` computed at line 140. Immediately after line 135 add:

```js
      const ownerBiz = await db.getBusiness(body.business_phone).catch(() => null);
      const ownerAgency = ownerBiz && ownerBiz.agency_id ? await db.getAgency(ownerBiz.agency_id).catch(() => null) : null;
      const brand = agencyLib.resolveBrand(ownerBiz, ownerAgency);
```

(and `const agencyLib = require("../agency");` at the top). Change line 140 to:

```js
      const logoSrc = agentIn.logo_url || listingAgent.logo_url || brand.logo_url || null;
```

- [ ] **Step 2: Portfolio profile**

In `loadPublicPortfolio` where the response builds `logo_url: business.logo_url || null` (line ~629), load the agency once above it:

```js
    const agency = business.agency_id ? await db.getAgency(business.agency_id).catch(() => null) : null;
    const brand = agencyLib.resolveBrand(business, agency);
```
and use `logo_url: brand.logo_url`. If the portfolio renderer reads `brand_colors` or `slogan` from `business.portfolio` fields, leave those alone: the spec limits inheritance to the three business-level brand fields.

- [ ] **Step 3: Profile response**

In `routes/dashboard.js` `/profile`, add to the `profile` object:

```js
          agency_id: d.agency_id || null,
          agency_role: d.agency_role || null,
          agency_status: d.agency_status || null,
```

- [ ] **Step 4: Verify and commit**

Run: `cd server && npm test 2>&1 | tail -1 && node -e "require('./routes/pages');require('./routes/dashboard');console.log('ok')"`

```bash
git add server/routes/pages.js server/routes/dashboard.js
git commit -m "feat(agency): inherit agency brand defaults; expose agency in /api/profile"
```

---

### Task 10: Agent-facing UI — agency page, dashboard hooks

**Files:**
- Create: `public-agent/agency.html`
- Create: `public-agent/agency.js`
- Modify: `public-agent/index.html` (nav near line 130, property card render near line 319-330 and the card template)

**Interfaces:**
- Consumes: `GET /api/agency`, `GET /api/agency/listings`, `POST /api/agency/mirror`, `POST /api/agency/members`, `DELETE /api/agency/members/:phone`, `POST /api/agency/invites`, `POST /api/agency/invites/accept`, `POST /api/properties/private`, `GET /api/profile` (`agency_id`, `agency_role`), `/api/properties` items (`mirror`, `shared_from`, `agency_private`). `window.FLY.req(path, { method, body, noRedirect })` and `FLY.toast(msg)` from `public-agent/api.js`.

- [ ] **Step 1: agency.html**

Copy the `<head>` and `<header class="topbar agent-topbar">` block from `public-agent/index.html` (lines 1-45) so the page matches the design system, then add this body content (RTL Hebrew, same `.btn`, `.card` classes used in index.html):

```html
<main class="wrap" dir="rtl">
  <section id="joinBox" class="card hidden">
    <h2>הצטרפות לסוכנות</h2>
    <p id="joinText">הוזמנת להצטרף לסוכנות. לאחר ההצטרפות נכסי המשרד יופיעו כאן.</p>
    <button id="joinBtn" class="btn">הצטרפות</button>
  </section>

  <section id="noAgency" class="card hidden">
    <h2>סוכנות</h2>
    <p>החשבון שלך אינו משויך לסוכנות. לפרטים על תוכנית סוכנות פנו אלינו.</p>
  </section>

  <section id="ownerBox" class="hidden">
    <div class="card">
      <h2 id="agencyName"></h2>
      <p id="seatLine" class="muted"></p>
      <div class="row">
        <input id="addPhone" type="tel" placeholder="טלפון של סוכן להוספה" />
        <button id="addBtn" class="btn">הוספת סוכן</button>
        <button id="inviteBtn" class="btn btn-ghost">יצירת קישור הזמנה</button>
      </div>
      <p id="inviteUrl" class="muted" style="word-break:break-all"></p>
    </div>
    <div class="card">
      <h3>סוכנים</h3>
      <table class="tbl" id="membersTbl">
        <thead><tr><th>שם</th><th>טלפון</th><th>סטטוס</th><th>נכסים</th><th>דפים</th><th>שיתופים</th><th>לידים</th><th>צפיות</th><th>צ׳אט החודש</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>

  <section id="poolBox" class="hidden">
    <div class="card">
      <h2>נכסי המשרד</h2>
      <p class="muted">נכסים של עמיתים בסוכנות. "שיווק כשלי" יוצר דף נכס עם הפרטים שלך; לידים מהדף מגיעים אליך.</p>
      <div id="poolGrid" class="grid"></div>
      <p id="poolEmpty" class="muted hidden">אין כרגע נכסים משותפים.</p>
    </div>
  </section>
</main>
<script src="/api.js"></script>
<script src="/agency.js"></script>
```

- [ ] **Step 2: agency.js**

```js
// public-agent/agency.js — owner dashboard (read-only members table, add/invite/remove)
// and member pool (mirror a colleague's listing). Data: /api/agency*.
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var params = new URLSearchParams(location.search);

  function show(id) { $(id).classList.remove("hidden"); }

  function statusLabel(s) { return s === "active" ? "פעיל" : s === "pending" ? "ממתין להרשמה" : s; }

  function renderOwner(d) {
    show("#ownerBox");
    $("#agencyName").textContent = d.agency.name;
    $("#seatLine").textContent = "מקומות בשימוש: " + d.seats.used + " מתוך " + d.seats.seats + " · תוכנית: " + d.agency.plan;
    var tb = $("#membersTbl tbody"); tb.innerHTML = "";
    (d.members || []).forEach(function (m) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + esc(m.full_name || m.business_name || "—") + (m.role === "owner" ? " (בעלים)" : "") + "</td>" +
        "<td dir=\"ltr\">" + esc(m.phone) + "</td><td>" + esc(statusLabel(m.status)) + "</td>" +
        "<td>" + m.active_listings + "</td><td>" + m.pages + "</td><td>" + m.mirrors + "</td><td>" + m.leads + "</td><td>" + m.views + "</td><td>" + m.chat_msgs_month + "</td>" +
        "<td>" + (m.role === "owner" ? "" : "<button class=\"btn btn-ghost\" data-remove=\"" + esc(m.phone) + "\">הסרה</button>") + "</td>";
      tb.appendChild(tr);
    });
    tb.onclick = function (e) {
      var b = e.target.closest("[data-remove]"); if (!b) return;
      if (!confirm("להסיר את " + b.dataset.remove + " מהסוכנות? דפים משותפים ייסגרו.")) return;
      FLY.req("/api/agency/members/" + encodeURIComponent(b.dataset.remove), { method: "DELETE" }).then(load).catch(function (e) { FLY.toast(e.message); });
    };
    $("#addBtn").onclick = function () {
      var phone = $("#addPhone").value.trim(); if (!phone) return;
      FLY.req("/api/agency/members", { method: "POST", body: { phone: phone } })
        .then(function (r) { FLY.toast(r.status === "pending" ? "נוסף — יופעל כשהסוכן ישלים הרשמה" : "נוסף"); $("#addPhone").value = ""; load(); })
        .catch(function (e) { FLY.toast(e.message === "seat_cap" ? "אין מקומות פנויים בתוכנית" : e.message); });
    };
    $("#inviteBtn").onclick = function () {
      FLY.req("/api/agency/invites", { method: "POST" }).then(function (r) {
        $("#inviteUrl").textContent = r.url;
        if (navigator.clipboard) navigator.clipboard.writeText(r.url).then(function () { FLY.toast("הקישור הועתק"); });
      }).catch(function (e) { FLY.toast(e.message); });
    };
  }

  function renderPool() {
    show("#poolBox");
    FLY.req("/api/agency/listings").then(function (d) {
      var g = $("#poolGrid"); g.innerHTML = "";
      var items = d.listings || [];
      $("#poolEmpty").classList.toggle("hidden", items.length > 0);
      items.forEach(function (l) {
        var card = document.createElement("div"); card.className = "card prop";
        card.innerHTML = (l.thumb_url ? "<img src=\"" + esc(l.thumb_url) + "\" alt=\"\">" : "") +
          "<h3>" + esc(l.title) + "</h3><p class=\"muted\">" + esc(l.address) + "</p>" +
          "<p class=\"muted\">של " + esc(l.owner_name) + "</p>" +
          (l.mirrored_page_id
            ? "<a class=\"btn\" target=\"_blank\" href=\"/p/" + esc(l.mirrored_page_id) + "\">הדף שלי</a>"
            : "<button class=\"btn\" data-mirror=\"" + esc(l.listing_id) + "\">שיווק כשלי</button>");
        g.appendChild(card);
      });
      g.onclick = function (e) {
        var b = e.target.closest("[data-mirror]"); if (!b) return;
        b.disabled = true;
        FLY.req("/api/agency/mirror", { method: "POST", body: { listing_id: b.dataset.mirror } })
          .then(function (r) { FLY.toast("נוצר דף משלך"); window.open(r.page_url, "_blank"); renderPool(); })
          .catch(function (e) { b.disabled = false; FLY.toast(e.message === "not_shareable" ? "הנכס אינו זמין לשיתוף" : e.message); });
      };
    });
  }

  function load() {
    FLY.req("/api/agency").then(function (d) {
      if (!d.agency) { show("#noAgency"); return; }
      if (d.agency.role === "owner") renderOwner(d);
      if (d.agency.member_status === "active") renderPool();
    });
  }

  if (params.get("join") && params.get("token")) {
    show("#joinBox");
    $("#joinBtn").onclick = function () {
      FLY.req("/api/agency/invites/accept", { method: "POST", body: { agency_id: params.get("join"), token: params.get("token") } })
        .then(function () { FLY.toast("הצטרפת לסוכנות"); history.replaceState(null, "", "/agency.html"); $("#joinBox").classList.add("hidden"); load(); })
        .catch(function (e) { FLY.toast(e.message === "invite_invalid" ? "הקישור פג תוקף" : e.message === "already_member" ? "החשבון כבר משויך לסוכנות" : e.message); });
    };
  } else {
    load();
  }
})();
```

Check how `FLY.req` surfaces non-2xx errors (api.js lines 5-27): if it rejects with `Error(data.error)`, the `e.message` comparisons above work; otherwise adapt to its shape.

- [ ] **Step 3: index.html hooks**

1. Next to `<a class="btn btn-ghost" href="/distribution.html">חיבורים וקבוצות</a>` (line 130) add `<a id="agencyNav" class="btn btn-ghost hidden" href="/agency.html">הסוכנות</a>`.
2. In the `/api/profile` handler near line 597 add: `if (d.profile && d.profile.agency_id) $("#agencyNav").classList.remove("hidden");`
3. In the property card rendering (the loop over `items` after line 320): when `item.mirror` is true, add a badge `<span class="dist-tag">משותף מ־` + esc(item.shared_from) + `</span>` and hide the archive/edit-content buttons for that card. When `item.mirror` is falsy and `d.profile.agency_id` is set, add a checkbox `<label><input type="checkbox" data-private="{listing_id}" {checked if agency_private}> פרטי לי בלבד</label>` and a change handler:

```js
    document.addEventListener("change", function (e) {
      var cb = e.target.closest("[data-private]"); if (!cb) return;
      FLY.req("/api/properties/private", { method: "POST", body: { listing_id: cb.dataset.private, agency_private: cb.checked } })
        .then(function () { FLY.toast(cb.checked ? "הנכס הוסר ממאגר המשרד" : "הנכס זמין למשרד"); })
        .catch(function (e) { cb.checked = !cb.checked; FLY.toast(e.message); });
    });
```

Since `/api/properties` runs before `/api/profile` in this file, either store the profile's `agency_id` in a module variable and re-render cards, or simply always render the checkbox and hide it via a class toggled when profile loads. Pick the class toggle: give the label class `agency-only hidden`, and remove `hidden` from all `.agency-only` when `agency_id` is present.

- [ ] **Step 4: Manual check**

Start the server in mem mode as in Task 8, create an agency via the admin endpoint, open `http://127.0.0.1:8787/agency.html` with the owner cookie set in the browser (or verify the JSON endpoints with curl and load the page for layout). Confirm: owner sees members table; add-by-phone works; invite link copies; a second browser profile with agent B's cookie opening the invite URL joins; B sees the pool once A has an active page.

- [ ] **Step 5: Commit**

```bash
git add public-agent/agency.html public-agent/agency.js public-agent/index.html
git commit -m "feat(agency): agent-facing agency page, dashboard nav, shared badge, private toggle"
```

---

### Task 11: Admin UI — Agencies tab

**Files:**
- Modify: `public-agent/admin.html` (tabs at lines 112-115, add a pane)
- Modify: `public-agent/admin.js` (`TAB_IDS` at line 449; add loader)

**Interfaces:**
- Consumes: `GET/POST /api/admin/agencies`, `POST /api/admin/agencies/:id`, `POST /api/admin/agencies/:id/members`.

- [ ] **Step 1: admin.html**

Add a tab button after `tabMessages`: `<button id="tabAgencies">סוכנויות</button>`.

Add a pane next to the existing `paneMessages` element (search for `id="paneMessages"` and mirror its wrapper markup):

```html
<section id="paneAgencies" class="hidden">
  <div class="card">
    <h3>סוכנות חדשה</h3>
    <div class="row">
      <input id="agName" placeholder="שם הסוכנות">
      <input id="agOwner" type="tel" placeholder="טלפון הבעלים">
      <input id="agSeats" type="number" min="1" value="5" style="width:80px">
      <select id="agPlan"><option value="agency_trial">agency_trial</option><option value="agency">agency</option></select>
      <button id="agCreate" class="btn">יצירה</button>
    </div>
  </div>
  <div id="agList"></div>
</section>
```

- [ ] **Step 2: admin.js**

Change `TAB_IDS` to include `agencies: "Agencies"`. Add:

```js
  function loadAgencies() {
    FLY.req("/api/admin/agencies").then(function (d) {
      var box = $("#agList"); box.innerHTML = "";
      (d.agencies || []).forEach(function (a) {
        var card = document.createElement("div"); card.className = "card";
        card.innerHTML = "<h3>" + esc(a.name) + " <small class=\"muted\">" + esc(a.agency_id) + "</small></h3>" +
          "<p class=\"muted\">בעלים: <span dir=\"ltr\">" + esc(a.owner_phone) + "</span> · " + a.used + "/" + a.seats + " מקומות · " + esc(a.plan) + " · " + esc(a.status) + "</p>" +
          "<div class=\"row\">" +
            "<input type=\"number\" min=\"1\" value=\"" + a.seats + "\" data-seats=\"" + esc(a.agency_id) + "\" style=\"width:80px\">" +
            "<select data-plan=\"" + esc(a.agency_id) + "\"><option" + (a.plan === "agency_trial" ? " selected" : "") + ">agency_trial</option><option" + (a.plan === "agency" ? " selected" : "") + ">agency</option></select>" +
            "<select data-status=\"" + esc(a.agency_id) + "\"><option" + (a.status === "active" ? " selected" : "") + ">active</option><option" + (a.status === "suspended" ? " selected" : "") + ">suspended</option></select>" +
            "<button class=\"btn\" data-save=\"" + esc(a.agency_id) + "\">שמירה</button>" +
          "</div>" +
          "<ul>" + a.members.map(function (m) {
            return "<li><span dir=\"ltr\">" + esc(m.phone) + "</span> · " + esc(m.role) + " · " + esc(m.status) +
              (m.role === "owner" ? "" : " <button class=\"btn btn-ghost\" data-rm=\"" + esc(a.agency_id) + "\" data-phone=\"" + esc(m.phone) + "\">הסרה</button>") + "</li>";
          }).join("") + "</ul>" +
          "<div class=\"row\"><input type=\"tel\" placeholder=\"טלפון סוכן\" data-addphone=\"" + esc(a.agency_id) + "\"><button class=\"btn\" data-add=\"" + esc(a.agency_id) + "\">הוספה</button></div>";
        box.appendChild(card);
      });
    });
  }
  $("#agCreate").onclick = function () {
    FLY.req("/api/admin/agencies", { method: "POST", body: {
      name: $("#agName").value, owner_phone: $("#agOwner").value, seats: Number($("#agSeats").value), plan: $("#agPlan").value,
    } }).then(function () { FLY.toast("נוצר"); loadAgencies(); }).catch(function (e) { FLY.toast(e.message); });
  };
  $("#agList").onclick = function (e) {
    var t = e.target;
    if (t.dataset.save) {
      var id = t.dataset.save;
      FLY.req("/api/admin/agencies/" + id, { method: "POST", body: {
        seats: Number($("[data-seats=\"" + id + "\"]").value), plan: $("[data-plan=\"" + id + "\"]").value, status: $("[data-status=\"" + id + "\"]").value,
      } }).then(function () { FLY.toast("נשמר"); loadAgencies(); }).catch(function (e) { FLY.toast(e.message); });
    } else if (t.dataset.rm) {
      if (!confirm("להסיר את " + t.dataset.phone + "?")) return;
      FLY.req("/api/admin/agencies/" + t.dataset.rm + "/members", { method: "POST", body: { phone: t.dataset.phone, action: "remove" } })
        .then(loadAgencies).catch(function (e) { FLY.toast(e.message); });
    } else if (t.dataset.add) {
      var ph = $("[data-addphone=\"" + t.dataset.add + "\"]").value;
      FLY.req("/api/admin/agencies/" + t.dataset.add + "/members", { method: "POST", body: { phone: ph, action: "add" } })
        .then(loadAgencies).catch(function (e) { FLY.toast(e.message === "seat_cap" ? "אין מקומות פנויים" : e.message); });
    }
  };
```

Hook `loadAgencies()` into the tab switch: where the code calls a loader per tab (look for how `messages` loads when `showTab("messages")` runs, near line 449-460) add the `agencies` case. Reuse the file's existing `esc` helper if one exists; otherwise add the same `esc` function used in `agency.js`.

- [ ] **Step 3: Check and commit**

Open `/admin.html` with an admin cookie in mem mode; create an agency, change seats, add and remove a member. Confirm the `/api/admin/agencies` JSON reflects each action.

```bash
git add public-agent/admin.html public-agent/admin.js
git commit -m "feat(agency): admin Agencies tab"
```

---

### Task 12: Final verification and docs pointer

**Files:**
- Modify: `server/package.json` (`"//"` comment array near line 7, add a short AGENCY block)

- [ ] **Step 1: Full test run**

Run: `cd server && npm test 2>&1 | grep -c OK` — expect the count to equal the number of test files in the script (previous count + 3).

- [ ] **Step 2: Load every route module**

Run: `cd server && node -e "['./routes/agency','./routes/admin','./routes/pages','./routes/dashboard','./routes/intake','./routes/profile'].forEach(function(m){require(m)});console.log('all routes load')"`

- [ ] **Step 3: Add operator notes**

In `server/package.json` `"//"` array append these strings after the RUNNING TESTS block:

```
"AGENCIES",
"  Admin creates an agency at POST /api/admin/agencies {name, owner_phone, seats, plan}.",
"  Owner (a normal agent) manages members at /agency.html; agents mirror office",
"  listings there. Design: docs/superpowers/specs/2026-09-04-agency-support-design.md",
```

- [ ] **Step 4: Commit and push**

```bash
git add server/package.json
git commit -m "docs(agency): operator notes in package.json"
git push -u origin claude/agency-support-strategy-mmpwtl
```

---

## Self-review against the spec

| Spec section | Task |
|---|---|
| §3 data model: agencies, members, invites, denormalized `agency_id`, `agency_private`, mirror doc shape | 1, 2, 3, 4 |
| §4 rendering a mirror (getPageHandler, /p/:id via getPageHandler, portfolio nested paths, chatbot follows mirror owner) | 7 |
| §4 leads/events route to mirror owner, `source_page_id` on lead | 7 |
| §4 portfolios include mirrors | 7 (expandMirrors in loadPublicPortfolio) |
| §4 agency pool endpoint, idempotent mirror creation | 7 |
| §4 owner dashboard read-only with per-member counts | 5 |
| §4 membership: add by phone (active/pending), pending activation on profile complete and demo-create, invite create/accept, removal cascade, admin add/remove | 5, 6, 8 |
| §4 brand inheritance at page creation and portfolio profile | 9 |
| §4 feature defaults on join | 5 (`joinAgency` → `mergeFeatureDefaults`) |
| §5 authorization (owner middleware, admin bypass via admin router, member-only pool, mirror edits identity-only) | 5, 7, 8 |
| §6 UI: agency.html, dashboard nav + badge + private toggle, admin tab | 10, 11 |
| §7 error codes | 1 (`not_shareable`), 5 (`seat_cap`, `already_member`, `invite_invalid`), 7 (`mirror_readonly`) |
| §8 tests | 1, 2, 3, 7 |

Known gaps accepted for this plan: the admin allowlist bypass for `/api/agency/*` owner routes is not implemented (admins use `/api/admin/agencies*` instead, which covers every owner action); `chat_msgs_month` in the owner summary reads the quota doc directly and is `0` in mem mode.
