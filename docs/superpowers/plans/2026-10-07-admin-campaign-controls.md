# Admin Campaign Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "קמפיינים" admin tab where an admin creates, edits, stops and starts posting campaigns for agents.

**Architecture:** The agent API's create checks move to a shared module both APIs use. Campaign edits (add/remove groups, texts, end date, repeat, targets, mode) are one transactional `update()` in a new `posting-campaign-admin.js`, guarded by the campaign's `updated_at` as its version. A new router `/api/admin/campaigns` (admin + step-up on every change, audit row per change) and a new admin tab call it.

**Tech Stack:** Node 22, Express 4, Firestore through `server/posting-store.js` (memory path in tests), plain `assert` test files run by `npm test`, Chromium DOM tests through `patchright`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-07-admin-campaign-controls-design.md`.
- Every mutation: `requireAdmin` + `requireStepUp`, and an `audit_events` row through `store.addAuditEvent` with `operator_tail`, `action`, `target_phone_tail`, `detail`. Never a full phone, never a text.
- Consent recorded by the admin: `{ by: "admin", admin_tail, method, note }`, method ∈ `phone | in_person | whatsapp`, note 1–300 characters after trim.
- Campaign duration 1–30 days; repeat every 3–30 days or off; at most 60 copies, each ≤ `MAX_COPY` (3000).
- Mutations answer `503 posting_unavailable_in_env` unless `postingEnvAllowed(env)` (staging never changes campaigns; prod and a local box with `POSTING_SWEEPER=1` do).
- WhatsApp to the agent on admin create and admin stop only, also when `POSTING_MANUAL=1`.
- Hebrew UI text; RTL.
- No `Co-Authored-By` trailer in commits (CLAUDE.md).
- Run a single test file with `node <file>` from `server/`; the full suite with `npm test` from `server/`.

## File structure

| File | Responsibility |
|---|---|
| `server/routes/posting-create.js` (new) | Create-time checks shared by agent and admin APIs: `validCreate`, `vetGroups`, `campaignPermission`, `permActive`. |
| `server/routes/posting.js` (modify) | Uses `posting-create.js` instead of its private copies. |
| `server/posting-campaign.js` (modify) | Export `normalizeGroups`; store `consent_by` and `created_by`; `stop(…, "admin")` sends no "stopped" message. |
| `server/posting-campaign-admin.js` (new) | `update(id, edit, deps, { version, by })`: one transactional edit. |
| `server/posting-messages.js` (modify) | `admin_created`, `admin_stopped` texts. |
| `server/posting-account.js` (modify) | `say()` lets `admin_created` / `admin_stopped` through in manual mode. |
| `server/routes/admin-campaigns.js` (new) | `/api/admin/campaigns` routes. |
| `server/index.js` (modify) | Mount the router. |
| `public-agent/admin.html` (modify) | Tab button and pane markup. |
| `public-agent/admin-campaigns.js` (new) | The tab's behaviour. |
| Tests (new) | `server/routes/posting-create.test.js`, `server/posting-campaign-admin.test.js`, `server/routes/admin-campaigns.test.js`, `server/admin-campaigns.dom.test.js`. |

---

### Task 1: Shared create checks

**Files:**
- Create: `server/routes/posting-create.js`
- Modify: `server/routes/posting.js` (remove `campaignPermission`, `permActive`, `validCreate`, and the `vetGroups` closure; call the shared ones)
- Test: `server/routes/posting-create.test.js`

**Interfaces:**
- Produces:
  - `validCreate(body) → { ids: string[], targets: string[]|null } | null`
  - `vetGroups(catalogFn, conn, page, ids, includeUnknown) → Promise<{ groups } | { error, group_ids }>` where `catalogFn(listingType) → Promise<catalogEntry[]>`
  - `campaignPermission(prev, now, grantedBy = null) → permission object`
  - `permActive(permission) → boolean`

- [ ] **Step 1: Write the failing test**

```js
// server/routes/posting-create.test.js
/* routes/posting-create.js — the create-time checks the agent and admin APIs share. */
const assert = require("assert");
const K = require("../posting-testkit");
const PC = require("./posting-create");

(async () => {
  // validCreate
  assert.equal(PC.validCreate({ page_id: "pg1", mode: "standing", group_ids: ["111"] }).ids[0], "111");
  assert.equal(PC.validCreate({ page_id: "pg1", mode: "nope", group_ids: ["111"] }), null);
  assert.equal(PC.validCreate({ page_id: "pg1", mode: "standing", group_ids: ["111"], days: 31 }), null);
  assert.equal(PC.validCreate({ page_id: "pg1", mode: "standing", group_ids: ["111"], repeat_days: 2 }), null);

  // vetGroups: member gate, unknown gate, ok
  const conn = { facebook_groups_member: [K.member("111"), K.member("999")] };
  const page = K.page("pg1");
  const catalog = async () => [{ url: K.G(111), name: "A", agent_policy: "explicitly_allowed", listing_types: [] }];
  assert.deepEqual(await PC.vetGroups(catalog, conn, page, ["555"], false), { error: "not_member", group_ids: ["555"] });
  assert.deepEqual(await PC.vetGroups(catalog, conn, page, ["999"], false), { error: "unknown_group", group_ids: ["999"] });
  const ok = await PC.vetGroups(catalog, conn, page, ["111"], false);
  assert.equal(ok.groups.length, 1);
  assert.equal(ok.groups[0].group_id, "111");

  // campaignPermission / permActive
  const p = PC.campaignPermission(null, K.NOW, "…0009");
  assert.equal(PC.permActive(p), true);
  assert.equal(p.granted_by, "…0009");
  assert.equal(PC.permActive(null), false);
  console.log("routes/posting-create.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node routes/posting-create.test.js`
Expected: FAIL with `Cannot find module './posting-create'`.

- [ ] **Step 3: Write the module**

```js
// server/routes/posting-create.js
/*
 * routes/posting-create.js — the create-time checks shared by the agent's
 * campaign API (routes/posting.js) and the admin's (routes/admin-campaigns.js):
 * the body shape, the group gate, and the posting permission a campaign's
 * consent creates. Moved here unchanged from routes/posting.js.
 */
const A = require("../posting-account");
const S_ = require("./posting-shared");

const { CONSENT_VERSION } = S_;
const MODES = new Set(["per_post", "standing"]);

// A permission created by a campaign's own consent covers campaign posting
// only: no default groups and groups-only targets, so it never auto-enrolls
// new listings (posting-campaign.enrollNewPage) — that is PUT /settings' job.
// grantedBy: the admin's phone tail when an admin recorded the consent.
function campaignPermission(prev, now, grantedBy = null) {
  return {
    enabled: true, consent_version: CONSENT_VERSION, granted_at: A.iso(now), platforms: ["facebook"],
    targets: ["groups"], default_group_ids: [], page_id: (prev && prev.page_id) || null,
    auto_mode: "standing", allows_dwell: true, allows_visible_interactions: false, revoked_at: null,
    granted_by: grantedBy,
  };
}
const permActive = (p) => !!p && p.enabled === true && Array.isArray(p.platforms) && p.platforms.includes("facebook");

function validCreate(b) {
  if (typeof b.page_id !== "string" || !S_.ID_RE.test(b.page_id) || !MODES.has(b.mode)) return null;
  const g = S_.parseGroupIds(b.group_ids, { required: true });
  const t = S_.parseTargets(b.targets);
  if (g.error || t.error) return null;
  if (b.days !== undefined && !(Number.isFinite(b.days) && b.days >= 1 && b.days <= 30)) return null;
  if (b.repeat_days !== undefined && b.repeat_days !== null && !(Number.isInteger(b.repeat_days) && b.repeat_days >= 3 && b.repeat_days <= 30)) return null; // never the same property to a group within 3 days
  for (const k of ["repeat", "include_unknown", "account_aged", "posted_manually"]) if (b[k] !== undefined && typeof b[k] !== "boolean") return null;
  // The text approved per group (manual posting): { group_id: text }.
  if (b.copies !== undefined && b.copies !== null && (typeof b.copies !== "object" || Array.isArray(b.copies) || Object.keys(b.copies).length > 60
    || Object.values(b.copies).some((t) => typeof t !== "string" || t.length > require("../posting-campaign").MAX_COPY))) return null;
  return { ids: g.ids, targets: t.targets };
}

// The hard gate for groups a campaign may post to (create, add): only groups
// this account belongs to now; the catalog adds names and policy. A group
// the catalog forbids to agents, or whose listing types exclude this page's,
// is refused here rather than kept and never planned. → { groups } or
// { error, group_ids } (a 422).
async function vetGroups(catalogFn, conn, page, ids, includeUnknown) {
  const gate = S_.memberGate(conn, ids);
  if (gate.notMember) return { error: "not_member", group_ids: gate.notMember };
  const listingType = (page.property || {}).listing_type || null;
  const lookup = S_.catalogLookup(await catalogFn(listingType || "sale"));
  const unknown = gate.entries.filter((m) => !lookup(m)).map((m) => m.group_id);
  if (unknown.length && !includeUnknown) return { error: "unknown_group", group_ids: unknown };
  const disallowed = gate.entries.filter((m) => lookup.all(m).some(A.policyDisallowed) || A.nameBarsAgents(m.name)).map((m) => m.group_id);
  if (disallowed.length) return { error: "group_disallowed", group_ids: disallowed };
  const wrongType = gate.entries.filter((m) => lookup.all(m).some((e) => A.typeExcluded(e, listingType))).map((m) => m.group_id);
  if (wrongType.length) return { error: "listing_type_not_allowed", group_ids: wrongType };
  return { groups: gate.entries.map((m) => {
    const cat = lookup(m);
    return { group_id: m.group_id, url: S_.memberUrl(m), name: m.name || (cat && cat.name) || "", agent_policy: (cat && cat.agent_policy) || "unknown" };
  }) };
}

module.exports = { validCreate, vetGroups, campaignPermission, permActive, MODES };
```

- [ ] **Step 4: Point `routes/posting.js` at it**

In `server/routes/posting.js`:
1. Delete the functions `campaignPermission`, `permActive`, `validCreate` (lines 52–75) and the `vetGroups` closure (lines 115–138, with its comment), and the `MODES` constant.
2. After `const S_ = require("./posting-shared");` add:
   ```js
   const PC = require("./posting-create");
   const { validCreate, campaignPermission, permActive } = PC;
   ```
3. Replace the two calls:
   - `const vet = await vetGroups(conn, page, v.ids, b.include_unknown === true);` → `const vet = await PC.vetGroups(S.catalog, conn, page, v.ids, b.include_unknown === true);`
   - `const vet = await vetGroups((await db.getConnection(c.phone)) || {}, page, g.ids, b.include_unknown === true);` → `const vet = await PC.vetGroups(S.catalog, (await db.getConnection(c.phone)) || {}, page, g.ids, b.include_unknown === true);`

- [ ] **Step 5: Run the new test and the agent route tests**

Run: `node routes/posting-create.test.js && node routes/posting.test.js && node routes/posting-settings.test.js && node routes/posting-properties.test.js`
Expected: each prints its `ok` line.

- [ ] **Step 6: Commit**

```bash
git add server/routes/posting-create.js server/routes/posting-create.test.js server/routes/posting.js
git commit -m "refactor(posting): share the campaign create checks"
```

---

### Task 2: Campaign model for admin changes

**Files:**
- Modify: `server/posting-campaign.js` (`create`, `stop`, `module.exports`)
- Create: `server/posting-campaign-admin.js`
- Test: `server/posting-campaign-admin.test.js`

**Interfaces:**
- Consumes: `A.mutate(x, id, fn)`, `A.ctxOf`, `A.nowOf`, `A.fail`, `A.catalogIndex`, `A.targetsFor`, `C.normalizeGroups(groups, ctx)`, `C.cleanCopy(text)`, `x.store.listOpenAttemptsByCampaign(id)` (attempts carry `target_type`, `target_id`).
- Produces:
  - `create(...)` now stores `consent_by: { by: "agent" }` or `{ by: "admin", admin_tail, method, note }` and `created_by: "agent" | "admin"` (from `consent.by`).
  - `stop(id, deps, "admin")` sends no "stopped" message (the admin route sends `admin_stopped`).
  - `update(id, edit, deps, { version, by }) → Promise<campaign>`; `edit` keys: `add_groups` (vetted group objects), `remove_group_ids` (string[]), `copies` ({group_id: text}), `days` (1–30), `repeat_days` (0 or 3–30), `targets` (string[]), `mode` (`per_post|standing`). Throws `Error` with `.code` ∈ `not_found | not_live | stale_version | busy`.

- [ ] **Step 1: Write the failing test**

```js
// server/posting-campaign-admin.test.js
/* posting-campaign-admin.js update(), and the admin bits of create/stop:
   real memory db and posting store (posting-testkit). */
const assert = require("assert");
const K = require("./posting-testkit");
const C = require("./posting-campaign");
const CA = require("./posting-campaign-admin");

(async () => {
  // ── create records who consented ──
  {
    const { deps } = await K.setup();
    const c = await C.create(K.base({ consent: { at: K.iso(K.NOW), version: "v", by: "admin", admin_tail: "…0009", method: "phone", note: "דיברנו" } }), deps);
    assert.deepEqual(c.consent_by, { by: "admin", admin_tail: "…0009", method: "phone", note: "דיברנו" });
    assert.equal(c.created_by, "admin");
    const { deps: d2 } = await K.setup();
    const a = await C.create(K.base(), d2);
    assert.deepEqual(a.consent_by, { by: "agent" });
    assert.equal(a.created_by, "agent");
  }

  // ── update: add, remove (history kept), texts, days, repeat, mode ──
  {
    const { deps } = await K.setup();
    const c = await C.create(K.base(), deps);
    await K.store.mutatePostingCampaign(c.id, (cur) => ({ posts: [
      { id: "p1", target: "group", group_id: "111", status: "posted" },
      { id: "p2", target: "group", group_id: "111", status: "scheduled" },
    ] }));
    const v = (await K.store.getPostingCampaign(c.id)).updated_at;
    const out = await CA.update(c.id, {
      remove_group_ids: ["111"], copies: { 222: "טקסט חדש" }, days: 10, repeat_days: 5, mode: "per_post",
    }, deps, { version: v, by: "admin" });
    assert.deepEqual(out.groups.map((g) => g.group_id), ["222"]);
    assert.equal(out.groups[0].copy, "טקסט חדש");
    assert.equal(out.posts.find((p) => p.id === "p1").status, "posted", "posted history stays");
    assert.equal(out.posts.find((p) => p.id === "p2").status, "skipped");
    assert.equal(out.posts.find((p) => p.id === "p2").error_code, "removed");
    assert.equal(out.repeat, true); assert.equal(out.repeat_days, 5);
    assert.equal(out.mode, "per_post");
    assert.equal(new Date(out.expires_at).getTime(), K.NOW.getTime() + 10 * K.DAY);
    assert.equal(out.last_changed_by.by, "admin");
    // repeat off
    const off = await CA.update(c.id, { repeat_days: 0 }, deps, { version: out.updated_at });
    assert.equal(off.repeat, false); assert.equal(off.repeat_days, null);
  }

  // ── update: stale version, busy, ended, missing ──
  {
    const { deps } = await K.setup();
    const c = await C.create(K.base(), deps);
    await assert.rejects(CA.update(c.id, { days: 5 }, deps, { version: "old" }), (e) => e.code === "stale_version");
    await K.store.mutatePostingCampaign(c.id, () => ({ posts: [{ id: "p1", target: "group", group_id: "111", status: "posting" }] }));
    const v = (await K.store.getPostingCampaign(c.id)).updated_at;
    await assert.rejects(CA.update(c.id, { remove_group_ids: ["111"] }, deps, { version: v }), (e) => e.code === "busy");
    await C.stop(c.id, deps, "admin");
    await assert.rejects(CA.update(c.id, { days: 5 }, deps, {}), (e) => e.code === "not_live");
    await assert.rejects(CA.update("nope", { days: 5 }, deps, {}), (e) => e.code === "not_found");
  }

  // ── stop by admin sends no "stopped" message ──
  {
    const { deps, notes } = await K.setup();
    const c = await C.create(K.base(), deps);
    await C.stop(c.id, deps, "admin");
    assert.equal(notes.length, 0);
    const { deps: d2, notes: n2 } = await K.setup();
    const c2 = await C.create(K.base(), d2);
    await C.stop(c2.id, d2);
    assert.equal(n2.length, 1, "an agent stop still tells the agent");
  }
  console.log("posting-campaign-admin.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node posting-campaign-admin.test.js`
Expected: FAIL with `Cannot find module './posting-campaign-admin'`.

- [ ] **Step 3: Change `posting-campaign.js`**

1. In `create`, inside the `const c = { … }` literal, after `consent_at: iso(consent.at), consent_version: consent.version || null,` add:
   ```js
       consent_by: consent.by === "admin"
         ? { by: "admin", admin_tail: consent.admin_tail || null, method: consent.method || null, note: consent.note || null }
         : { by: "agent" },
       created_by: consent.by === "admin" ? "admin" : "agent",
   ```
2. In `create`'s restart object `fresh`, after `consent_at: c.consent_at, consent_version: c.consent_version,` add `consent_by: c.consent_by,`.
3. In `stop`, replace
   `if (was !== "stopped") await say(deps, out.phone, "stopped", "הפרסום נעצר. מה שכבר פורסם נשאר.", final);`
   with
   `if (was !== "stopped" && reason !== "admin") await say(deps, out.phone, "stopped", "הפרסום נעצר. מה שכבר פורסם נשאר.", final); // an admin stop: the route sends admin_stopped`
4. In `module.exports`, change `explainGroups, addGroups,` to `explainGroups, addGroups, normalizeGroups,`.

- [ ] **Step 4: Write `posting-campaign-admin.js`**

```js
// server/posting-campaign-admin.js
/*
 * posting-campaign-admin.js — an admin's edit of a live campaign, in one
 * campaign transaction: groups added and removed, per-group texts, end date,
 * repeat, targets, mode. `version` is the campaign's updated_at as the admin
 * loaded it; a campaign changed since is refused (stale_version), never
 * overwritten. Removing a group drops its not-yet-started posts (skipped,
 * error_code "removed") and keeps its history; a group with an attempt past
 * reservation is refused (busy) — that post is already on its way.
 */
const A = require("./posting-account");
const C = require("./posting-campaign");
const shareKit = require("./distribution/share-kit");
const localMode = require("./posting-local");

const { iso, fail, ctxOf, nowOf, MS_DAY } = A;
const LIVE = new Set(["running", "paused"]);
const NOT_STARTED = new Set(["scheduled", "pending_approval"]);

function withCopy(g, text) {
  const t = C.cleanCopy(text);
  if (t) return Object.assign({}, g, { copy: t });
  const { copy, ...rest } = g; // an emptied text: back to the generated copy
  return rest;
}

async function update(id, edit = {}, deps = {}, { version, by = "admin" } = {}) {
  const x = ctxOf(deps);
  const now = nowOf(deps, x);
  const c = await x.store.getPostingCampaign(id);
  if (!c) throw fail("not_found");
  if (!LIVE.has(c.status)) throw fail("not_live");
  const remove = new Set((edit.remove_group_ids || []).map(String));
  if (remove.size) {
    const open = await x.store.listOpenAttemptsByCampaign(id);
    if (open.some((a) => a.target_type === "group" && remove.has(String(a.target_id)))) throw fail("busy");
  }
  const page = (await x.db.getPage(c.page_id)) || {};
  const conn = (await x.db.getConnection(c.phone)) || {};
  const ctx = { conn, catalog: await A.catalogIndex(x.db), listingType: (page.property || {}).listing_type || null, now };
  const added = Array.isArray(edit.add_groups) && edit.add_groups.length ? C.normalizeGroups(edit.add_groups, ctx) : [];
  const env = deps.env || process.env;

  let refused = null;
  const out = await A.mutate(x, id, (cur) => {
    if (!LIVE.has(cur.status)) { refused = "not_live"; return null; }
    if (version && cur.updated_at !== version) { refused = "stale_version"; return null; }
    if ((cur.posts || []).some((p) => p.status === "posting" && remove.has(String(p.group_id)))) { refused = "busy"; return null; }
    let groups = (cur.groups || []).filter((g) => !remove.has(String(g.group_id)));
    const have = new Set(groups.map((g) => g.group_id));
    groups = groups.concat(added.filter((g) => !have.has(g.group_id))).slice(0, shareKit.MAX_GROUPS);
    if (edit.copies) groups = groups.map((g) => (typeof edit.copies[g.group_id] === "string" ? withCopy(g, edit.copies[g.group_id]) : g));
    const patch = { groups, wait_reason: null, last_changed_by: { by, at: iso(now) } };
    if (remove.size) {
      patch.posts = (cur.posts || []).map((p) => (remove.has(String(p.group_id)) && NOT_STARTED.has(p.status)
        ? { ...p, status: "skipped", error_code: "removed", copy: undefined } : p));
    }
    if (edit.days !== undefined) patch.expires_at = iso(now.getTime() + Math.min(Math.max(Number(edit.days) || 30, 1), 30) * MS_DAY);
    if (edit.repeat_days !== undefined) {
      const n = Number(edit.repeat_days) || 0;
      patch.repeat = n > 0;
      patch.repeat_days = n > 0 ? Math.min(30, Math.max(3, Math.round(n))) : null;
    }
    if (Array.isArray(edit.targets)) patch.targets = A.targetsFor(conn, edit.targets);
    if (edit.mode) patch.mode = localMode.requireApproval(env) || edit.mode === "per_post" ? "per_post" : "standing";
    return patch;
  });
  if (refused) throw fail(refused);
  return out;
}

module.exports = { update };
```

- [ ] **Step 5: Run the tests**

Run: `node posting-campaign-admin.test.js && node posting-campaign.test.js && node posting-races.test.js`
Expected: each prints its `ok` line.

- [ ] **Step 6: Commit**

```bash
git add server/posting-campaign.js server/posting-campaign-admin.js server/posting-campaign-admin.test.js
git commit -m "feat(posting): admin campaign edits, recorded admin consent"
```

---

### Task 3: Admin messages to the agent

**Files:**
- Modify: `server/posting-messages.js` (two builders), `server/posting-account.js` (`say`)
- Test: add to `server/posting-campaign-admin.test.js`

**Interfaces:**
- Consumes: `say(deps, phone, kind, fallback, ...args)`.
- Produces: message kinds `admin_created(c)` and `admin_stopped(c)`; `say()` sends them even when `POSTING_MANUAL=1`.

- [ ] **Step 1: Write the failing test** — append before the final `console.log` in `server/posting-campaign-admin.test.js`:

```js
  // ── admin messages go out in manual mode too; other kinds do not ──
  {
    const sent = [];
    const deps = { env: { POSTING_MANUAL: "1" }, notify: async (ph, m) => sent.push(m) };
    await A_.say(deps, "972500000001", "admin_created", "נפתח קמפיין");
    await A_.say(deps, "972500000001", "admin_stopped", "נעצר");
    await A_.say(deps, "972500000001", "paused", "הושהה");
    assert.deepEqual(sent, ["נפתח קמפיין", "נעצר"]);
    const M = require("./posting-messages").build({ pageBaseUrl: "https://f.ly", authSecret: "s" });
    assert.ok(M.admin_created({ id: "c1", groups: [{}, {}] }).body.includes("2"));
    assert.ok(M.admin_stopped({ id: "c1" }).header.length > 0);
  }
```

and at the top of the file, after `const CA = require("./posting-campaign-admin");`, add `const A_ = require("./posting-account");`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node posting-campaign-admin.test.js`
Expected: FAIL: `sent` is `[]` (manual mode drops the messages) or `M.admin_created is not a function`.

- [ ] **Step 3: Let the admin kinds through `say()`** — in `server/posting-account.js`, replace

```js
  if (require("./posting-manual").enabled(deps.env || process.env) && kind !== "completed") return;
```

with

```js
  if (require("./posting-manual").enabled(deps.env || process.env) && !MANUAL_KINDS.has(kind)) return;
```

and above `async function say` add:

```js
// Kinds an agent hears in manual posting too: the end, and what the team did.
const MANUAL_KINDS = new Set(["completed", "admin_created", "admin_stopped"]);
```

- [ ] **Step 4: Add the builders** — in `server/posting-messages.js`, inside `build`'s returned object, after `stopped: …,` add:

```js
    admin_created: (c) => {
      const n = ((c && c.groups) || []).length;
      return msg("📣 פורלי פתחה לכם קמפיין", `הצוות שלנו פתח קמפיין פרסום לנכס שלכם ב-${n} ${n === 1 ? "קבוצה" : "קבוצות"}. אפשר לראות ולעצור אותו בכל רגע מעמוד הפרסום.`, [publishBtn]);
    },
    admin_stopped: () => msg("✋ הצוות עצר את הפרסום", "הצוות שלנו עצר את הקמפיין. מה שכבר פורסם נשאר בקבוצות.", [publishBtn]),
```

- [ ] **Step 5: Run the tests**

Run: `node posting-campaign-admin.test.js && node posting-messages.test.js`
Expected: both print their `ok` line.

- [ ] **Step 6: Commit**

```bash
git add server/posting-messages.js server/posting-account.js server/posting-campaign-admin.test.js
git commit -m "feat(posting): tell the agent when the team opens or stops a campaign"
```

---

### Task 4: `/api/admin/campaigns` routes

**Files:**
- Create: `server/routes/admin-campaigns.js`
- Modify: `server/index.js` (mount next to `/api/admin/posting`, line 338)
- Test: `server/routes/admin-campaigns.test.js`

**Interfaces:**
- Consumes: Task 1 `PC.validCreate`, `PC.vetGroups`, `PC.campaignPermission`, `PC.permActive`; Task 2 `C.create`, `C.stop(id, deps, "admin")`, `C.resume`, `C._test.accountBlocked`, `CA.update`; Task 3 kinds `admin_created`, `admin_stopped`; `M.refOf(phone)` (posting-manual); `store.listConnectedPhones`, `store.listPostingCampaignsByStatus`, `store.getPostingCampaign`, `store.mutateConnection`, `store.addAuditEvent`; `db.getConnection`, `db.getPage`, `db.getBusiness`, `db.listPagesByPhone`.
- Produces (all JSON):
  - `GET /campaigns?status=&agent=` → `{ campaigns: Row[] }`, `Row = { id, ref, phone_tail, agent_name, page_id, page_title, status, pause_reason, mode, repeat, repeat_days, targets, expires_at, groups: [{group_id,name,copy?}], counts: {owed,posted,skipped}, created_by, consent_by, version }`
  - `GET /agents` → `{ agents: [{ ref, phone_tail, name }] }`
  - `GET /agents/:ref/properties` → `{ properties: [{ page_id, title }] }`
  - `GET /agents/:ref/groups` → `{ groups: [{ group_id, name, url }] }`
  - `POST /campaigns` → `201 { campaign: Row }` (new) or `200 { campaign: Row, existing: true }`
  - `PATCH /campaigns/:id` → `{ campaign: Row }`
  - `POST /campaigns/:id/stop` → `{ campaign: Row }`
  - `POST /campaigns/:id/start` → `{ campaign: Row }`
  - Errors `{ error }`: `invalid_input` 400, `consent_note_required` 400, `not_found` 404, `facebook_not_connected` 409, `page_not_confirmed` 409, `page_target_unavailable` 409, `stale_version` 409, `busy` 409, `not_live` 409, `account_halted` 409, vet errors 422.

- [ ] **Step 1: Write the failing test**

```js
// server/routes/admin-campaigns.test.js
/* routes/admin-campaigns.js — real admin and step-up guards over signed
   tokens, the memory db and posting store (posting-testkit), WhatsApp captured. */
process.env.PROFILE_KEY = "admin-campaigns-test-key";
process.env.FORLY_ENV = "local";
const assert = require("assert");
const express = require("express");
const http = require("http");
const auth = require("../auth");
const { makeAdminGuard, makeStepUpGuard } = require("../admin-auth");
const K = require("../posting-testkit");
const M = require("../posting-manual");
const createRouter = require("./admin-campaigns");

const SECRET = "admin-campaigns-secret", ADMIN = "972500000009", AGENT = "972500000001";
const { requireAdmin } = makeAdminGuard({ verifySession: auth.verifySession, readToken: auth.readToken, authSecret: SECRET, adminPhones: [ADMIN] });
const { requireStepUp } = makeStepUpGuard({ verifySession: auth.verifySession, authSecret: SECRET });
const headers = (stepup) => {
  const h = { authorization: `Bearer ${auth.signSession(SECRET, ADMIN)}`, "content-type": "application/json" };
  if (stepup) h.cookie = `forly_stepup=${encodeURIComponent(auth.signSession(SECRET, ADMIN, { scope: "stepup", ttlS: 600 }))}`;
  return h;
};
function call(server, method, path, body, stepup = true) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, path: `/api/admin/campaigns${path}`, method, headers: headers(stepup) }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const CATALOG = async () => [
  { url: K.G(111), name: "A", agent_policy: "explicitly_allowed", listing_types: [] },
  { url: K.G(222), name: "B", agent_policy: "explicitly_allowed", listing_types: [] },
];
const CONSENT = { method: "phone", note: "הסוכן אישר בטלפון" };

(async () => {
  const { deps, notes } = await K.setup(AGENT);
  await K.db.setBusiness(AGENT, { phone: AGENT, full_name: "דנה לוי" });
  const app = express(); app.use(express.json());
  app.use("/api/admin/campaigns", createRouter({ requireAdmin, requireStepUp, deps, env: deps.env, catalog: CATALOG }));
  const server = app.listen(0);
  const REF = M.refOf(AGENT);
  const audits = async () => (await K.store.listAuditEvents({ sinceMs: 0, limit: 50 }));
  try {
    // ── pickers ──
    assert.deepEqual((await call(server, "GET", "/agents", undefined, false)).body.agents.map((a) => a.ref), [REF]);
    assert.ok((await call(server, "GET", `/agents/${REF}/properties`, undefined, false)).body.properties.some((p) => p.page_id === "pg1"));
    assert.deepEqual((await call(server, "GET", `/agents/${REF}/groups`, undefined, false)).body.groups.map((g) => g.group_id), ["111", "222"]);

    // ── create: step-up, consent, checks ──
    const body = { agent: REF, page_id: "pg1", group_ids: ["111", "222"], mode: "standing", days: 14, consent: CONSENT };
    assert.equal((await call(server, "POST", "/campaigns", body, false)).status, 401, "step-up required");
    assert.equal((await call(server, "POST", "/campaigns", Object.assign({}, body, { consent: { method: "phone", note: " " } }))).body.error, "consent_note_required");
    assert.equal((await call(server, "POST", "/campaigns", Object.assign({}, body, { page_id: "pgX" }))).status, 404);
    const made = await call(server, "POST", "/campaigns", body);
    assert.equal(made.status, 201);
    const row = made.body.campaign;
    assert.equal(row.created_by, "admin");
    assert.equal(row.consent_by.method, "phone");
    assert.equal(notes.length, 1, "agent told about the new campaign");
    const again = await call(server, "POST", "/campaigns", body);
    assert.equal(again.status, 200); assert.equal(again.body.existing, true);

    // ── list ──
    const list = (await call(server, "GET", `/campaigns?agent=${REF}`, undefined, false)).body.campaigns;
    assert.equal(list.length, 1); assert.equal(list[0].agent_name, "דנה לוי");
    assert.ok(!JSON.stringify(list).includes(AGENT), "no full phone in the list");

    // ── edit: version, remove, text ──
    const stale = await call(server, "PATCH", `/campaigns/${row.id}`, { version: "old", days: 5 });
    assert.equal(stale.status, 409); assert.equal(stale.body.error, "stale_version");
    const edited = await call(server, "PATCH", `/campaigns/${row.id}`, { version: row.version, remove_group_ids: ["222"], copies: { 111: "שלום" } });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.body.campaign.groups.map((g) => g.group_id), ["111"]);
    const back = await call(server, "PATCH", `/campaigns/${row.id}`, { version: edited.body.campaign.version, add_group_ids: ["222"] });
    assert.deepEqual(back.body.campaign.groups.map((g) => g.group_id), ["111", "222"]);
    assert.equal(notes.length, 1, "edits are silent");

    // ── stop / start ──
    const stopped = await call(server, "POST", `/campaigns/${row.id}/stop`, {});
    assert.equal(stopped.body.campaign.status, "stopped");
    assert.equal(notes.length, 2, "agent told about the stop");
    assert.equal((await call(server, "POST", `/campaigns/${row.id}/start`, {})).body.error, "consent_note_required", "a restart needs a fresh consent");
    const restarted = await call(server, "POST", `/campaigns/${row.id}/start`, { consent: CONSENT });
    assert.equal(restarted.body.campaign.status, "running");
    await K.db.setConnection(AGENT, { posting_disabled_until_admin: true });
    await K.store.mutatePostingCampaign(row.id, () => ({ status: "paused", pause_reason: "agent" }));
    const halted = await call(server, "POST", `/campaigns/${row.id}/start`, {});
    assert.equal(halted.status, 409); assert.equal(halted.body.error, "account_halted");
    assert.equal(notes.length, 2, "starts are silent");

    // ── audit rows: one per change, no phone, no text ──
    const rows = await audits();
    for (const a of ["create_campaign", "edit_campaign", "stop_campaign", "start_campaign"]) assert.ok(rows.some((r) => r.action === a), a);
    assert.ok(!JSON.stringify(rows).includes(AGENT) && !JSON.stringify(rows).includes("שלום"));

    // ── staging never changes campaigns ──
    const sApp = express(); sApp.use(express.json());
    sApp.use("/api/admin/campaigns", createRouter({ requireAdmin, requireStepUp, deps, env: { FORLY_ENV: "staging" }, catalog: CATALOG }));
    const sServer = sApp.listen(0);
    try { assert.equal((await call(sServer, "POST", "/campaigns", body)).status, 503); } finally { sServer.close(); }
    console.log("routes/admin-campaigns.test.js ok");
  } finally { server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node routes/admin-campaigns.test.js`
Expected: FAIL with `Cannot find module './admin-campaigns'`.

- [ ] **Step 3: Write the router**

```js
// server/routes/admin-campaigns.js
/*
 * routes/admin-campaigns.js — /api/admin/campaigns: the admin's "קמפיינים"
 * tab. Create, edit, stop and start an agent's campaign. Every change needs
 * the admin guard and a fresh step-up, and writes an audit row (no phone, no
 * text). A campaign the admin creates carries the consent the admin recorded
 * (who agreed, how, a note). Agents are addressed by posting-manual.refOf.
 * Staging shares production's Firestore: no change outside prod (or a local
 * box with POSTING_SWEEPER=1), as routes/posting.js.
 */
const express = require("express");
const A = require("../posting-account");
const S_ = require("./posting-shared");
const PC = require("./posting-create");
const M = require("../posting-manual");
const { postingEnvAllowed } = require("../posting-guard");
const { redact } = require("../driver-browser");

const METHODS = new Set(["phone", "in_person", "whatsapp"]);
const LIVE = new Set(["running", "paused"]);
const STATUSES = ["running", "paused", "stopped", "completed"];
const ERR_STATUS = { not_found: 404, stale_version: 409, busy: 409, not_live: 409 };

function consentOf(b) {
  const c = b && b.consent;
  const note = c && typeof c.note === "string" ? c.note.trim() : "";
  if (!c || !METHODS.has(c.method) || !note || note.length > 300) return null;
  return { method: c.method, note };
}

module.exports = function createAdminCampaignsRouter({
  requireAdmin, requireStepUp, deps = {}, env = process.env, catalog,
  campaigns = require("../posting-campaign"), admin = require("../posting-campaign-admin"),
}) {
  if (typeof requireAdmin !== "function" || typeof requireStepUp !== "function") throw new Error("admin-campaigns: requireAdmin and requireStepUp required");
  const x = A.ctxOf(deps);
  const { db, store } = x;
  const catalogFn = catalog || ((want) => require("./distribution").mergedCatalog(db, want));
  const guard = [requireAdmin, requireStepUp];
  const router = express.Router();
  const opTail = (req) => A.tail(req.user && req.user.userId);
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    if (e && ERR_STATUS[e.code]) return res.status(ERR_STATUS[e.code]).json({ error: e.code });
    console.error(redact(`admin campaigns ${req.method} ${req.route && req.route.path}: ${(e && e.code) || "error"}`));
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  });
  router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use((req, res, next) => (req.method === "GET" || postingEnvAllowed(env) ? next() : res.status(503).json({ error: "posting_unavailable_in_env" })));

  async function audit(req, action, phone, detail) {
    try { await store.addAuditEvent({ operator_tail: opTail(req), action, target_phone_tail: A.tail(phone), reason: null, detail }, x.clock()); return true; }
    catch (e) { console.error(redact(`admin campaigns audit ${action} failed: ${(e && e.code) || "error"}`)); return false; }
  }
  async function phones() { return (await store.listConnectedPhones("facebook").catch(() => [])).map(String); }
  async function phoneOf(ref) { return (await phones()).find((p) => M.refOf(p) === String(ref)) || null; }
  const names = new Map();
  async function nameOf(phone) {
    if (!names.has(phone)) { const b = (await db.getBusiness(phone).catch(() => null)) || {}; names.set(phone, b.full_name || b.business_name || ""); }
    return names.get(phone);
  }
  async function rowOf(c) {
    const page = (await db.getPage(c.page_id).catch(() => null)) || {};
    const posts = c.posts || [];
    return {
      id: c.id, ref: M.refOf(c.phone), phone_tail: A.tail(c.phone), agent_name: await nameOf(c.phone),
      page_id: c.page_id, page_title: ((page.property || {}).title) || "", status: c.status, pause_reason: c.pause_reason || null,
      mode: c.mode, repeat: !!c.repeat, repeat_days: c.repeat_days || null, targets: c.targets || [], expires_at: c.expires_at,
      groups: (c.groups || []).map((g) => ({ group_id: g.group_id, name: g.name || "", copy: g.copy })),
      counts: { owed: (c.groups || []).length - new Set(posts.filter((p) => p.status === "posted").map((p) => p.group_id)).size,
        posted: posts.filter((p) => p.status === "posted").length, skipped: posts.filter((p) => p.status === "skipped").length },
      created_by: c.created_by || "agent", consent_by: c.consent_by || { by: "agent" }, version: c.updated_at,
    };
  }
  // The same gates as the agent's create: connected, the page is the agent's, a confirmed Page when targeted.
  async function gates(phone, pageId, targets) {
    const conn = (await db.getConnection(phone)) || {};
    if (!conn.facebook_browser_connected_at) return { status: 409, error: "facebook_not_connected" };
    const page = await db.getPage(pageId);
    if (!page || page.business_phone !== phone) return { status: 404, error: "not_found" };
    const wanted = targets || S_.DEFAULT_TARGETS;
    if (wanted.includes("page") && !S_.pageConfirmed(conn)) return { status: 409, error: "page_not_confirmed" };
    if (targets && targets.includes("page") && !A.pageTarget(conn)) return { status: 409, error: "page_target_unavailable" };
    return { conn, page };
  }
  async function grantPermission(phone, req) {
    await store.mutateConnection(phone, (cur) => (PC.permActive(cur.posting_permission) ? null : { posting_permission: PC.campaignPermission(cur.posting_permission, x.clock(), opTail(req)) }));
  }
  const consentRecord = (req, consent) => ({ at: A.iso(x.clock()), version: S_.CONSENT_VERSION, by: "admin", admin_tail: opTail(req), method: consent.method, note: consent.note });
  const notifyDeps = Object.assign({}, deps, { messages: deps.messages });

  // ── reads ──
  router.get("/campaigns", requireAdmin, wrap(async (req, res) => {
    const want = STATUSES.includes(req.query.status) ? [req.query.status] : STATUSES;
    let all = [];
    for (const s of want) all = all.concat(await store.listPostingCampaignsByStatus(s, 200));
    if (req.query.agent) all = all.filter((c) => M.refOf(c.phone) === String(req.query.agent));
    all.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    res.json({ campaigns: await Promise.all(all.map(rowOf)) });
  }));
  router.get("/agents", requireAdmin, wrap(async (req, res) => {
    const out = [];
    for (const p of await phones()) out.push({ ref: M.refOf(p), phone_tail: A.tail(p), name: await nameOf(p) });
    out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ agents: out });
  }));
  router.get("/agents/:ref/properties", requireAdmin, wrap(async (req, res) => {
    const phone = await phoneOf(req.params.ref);
    if (!phone) return res.status(404).json({ error: "not_found" });
    const pages = await db.listPagesByPhone(phone);
    res.json({ properties: pages.filter((p) => p.status !== "deleted").map((p) => ({ page_id: p.page_id, title: ((p.property || {}).title) || p.page_id })) });
  }));
  router.get("/agents/:ref/groups", requireAdmin, wrap(async (req, res) => {
    const phone = await phoneOf(req.params.ref);
    if (!phone) return res.status(404).json({ error: "not_found" });
    const conn = (await db.getConnection(phone)) || {};
    const members = S_.memberList(conn).filter((m) => m.membership_state === "member");
    res.json({ groups: members.map((m) => ({ group_id: String(m.group_id), name: m.name || "", url: S_.memberUrl(m) })) });
  }));

  // ── create ──
  router.post("/campaigns", ...guard, wrap(async (req, res) => {
    const b = req.body || {};
    const consent = consentOf(b);
    if (!consent) return res.status(400).json({ error: "consent_note_required" });
    const v = PC.validCreate(b);
    if (!v) return res.status(400).json({ error: "invalid_input" });
    const phone = await phoneOf(b.agent);
    if (!phone) return res.status(404).json({ error: "not_found" });
    const g = await gates(phone, b.page_id, v.targets);
    if (g.error) return res.status(g.status).json({ error: g.error });
    const vet = await PC.vetGroups(catalogFn, g.conn, g.page, v.ids, b.include_unknown === true);
    if (vet.error) return res.status(422).json(vet);
    const before = await store.getPostingCampaign(store.campaignId(phone, g.page.page_id));
    if (before && LIVE.has(before.status)) return res.json({ campaign: await rowOf(before), existing: true });
    await grantPermission(phone, req);
    const c = await campaigns.create({
      phone, page: g.page, groups: vet.groups, mode: b.mode, days: b.days, repeat: !!b.repeat_days, repeatDays: b.repeat_days || null,
      targets: v.targets || undefined, consent: consentRecord(req, consent), copies: b.copies || null,
    }, deps);
    await A.say(notifyDeps, phone, "admin_created", "📣 הצוות של פורלי פתח לכם קמפיין פרסום.", c);
    const audited = await audit(req, "create_campaign", phone, { campaign_tail: c.id.slice(-6), groups: vet.groups.length, method: consent.method });
    res.status(201).json({ campaign: await rowOf(c), audited });
  }));

  // ── edit ──
  router.patch("/campaigns/:id", ...guard, wrap(async (req, res) => {
    const b = req.body || {};
    const c = S_.ID_RE.test(String(req.params.id)) ? await store.getPostingCampaign(String(req.params.id)) : null;
    if (!c) return res.status(404).json({ error: "not_found" });
    const add = b.add_group_ids === undefined ? { ids: [] } : S_.parseGroupIds(b.add_group_ids, { required: true });
    const remove = b.remove_group_ids === undefined ? { ids: [] } : S_.parseGroupIds(b.remove_group_ids, { required: true });
    const t = b.targets === undefined ? { targets: undefined } : S_.parseTargets(b.targets);
    const probe = PC.validCreate({ page_id: c.page_id, mode: b.mode || "standing", group_ids: ["1"], days: b.days, copies: b.copies,
      repeat_days: b.repeat_days === 0 ? undefined : b.repeat_days });
    if (add.error || remove.error || t.error || !probe || typeof b.version !== "string") return res.status(400).json({ error: "invalid_input" });
    if (b.repeat_days !== undefined && b.repeat_days !== 0 && !(b.repeat_days >= 3 && b.repeat_days <= 30)) return res.status(400).json({ error: "invalid_input" });
    const edit = {};
    if (add.ids.length) {
      const g = await gates(c.phone, c.page_id, t.targets || null);
      if (g.error) return res.status(g.status).json({ error: g.error });
      const vet = await PC.vetGroups(catalogFn, g.conn, g.page, add.ids, b.include_unknown === true);
      if (vet.error) return res.status(422).json(vet);
      edit.add_groups = vet.groups;
    } else if (t.targets) {
      const g = await gates(c.phone, c.page_id, t.targets);
      if (g.error) return res.status(g.status).json({ error: g.error });
    }
    if (remove.ids.length) edit.remove_group_ids = remove.ids;
    for (const k of ["copies", "days", "repeat_days", "mode"]) if (b[k] !== undefined) edit[k] = b[k];
    if (t.targets) edit.targets = t.targets;
    const out = await admin.update(c.id, edit, deps, { version: b.version, by: "admin" });
    const audited = await audit(req, "edit_campaign", c.phone, { campaign_tail: c.id.slice(-6), fields: Object.keys(edit) });
    res.json({ campaign: await rowOf(out), audited });
  }));

  // ── stop / start ──
  router.post("/campaigns/:id/stop", ...guard, wrap(async (req, res) => {
    const c = S_.ID_RE.test(String(req.params.id)) ? await store.getPostingCampaign(String(req.params.id)) : null;
    if (!c) return res.status(404).json({ error: "not_found" });
    const was = c.status;
    const out = await campaigns.stop(c.id, deps, "admin");
    if (was !== "stopped") await A.say(notifyDeps, c.phone, "admin_stopped", "✋ הצוות עצר את הקמפיין. מה שכבר פורסם נשאר.", out);
    const audited = await audit(req, "stop_campaign", c.phone, { campaign_tail: c.id.slice(-6) });
    res.json({ campaign: await rowOf(out), audited });
  }));
  router.post("/campaigns/:id/start", ...guard, wrap(async (req, res) => {
    const c = S_.ID_RE.test(String(req.params.id)) ? await store.getPostingCampaign(String(req.params.id)) : null;
    if (!c) return res.status(404).json({ error: "not_found" });
    if (c.status === "running") return res.json({ campaign: await rowOf(c) });
    const conn = (await db.getConnection(c.phone)) || {};
    if (campaigns._test.accountBlocked(conn)) return res.status(409).json({ error: "account_halted" });
    let out;
    if (c.status === "paused") {
      out = await campaigns.resume(c.id, deps);
    } else {
      const consent = consentOf(req.body);
      if (!consent) return res.status(400).json({ error: "consent_note_required" });
      const g = await gates(c.phone, c.page_id, c.targets && c.targets.includes("page") ? c.targets : null);
      if (g.error) return res.status(g.status).json({ error: g.error });
      await grantPermission(c.phone, req);
      out = await campaigns.create({
        phone: c.phone, page: g.page, groups: c.groups, mode: c.mode, days: 30, repeat: !!c.repeat, repeatDays: c.repeat_days || null,
        targets: c.targets, consent: consentRecord(req, consent), copies: Object.fromEntries((c.groups || []).filter((x2) => x2.copy).map((x2) => [x2.group_id, x2.copy])),
      }, deps);
    }
    if (!out || out.status !== "running") return res.status(409).json({ error: "account_halted" });
    const audited = await audit(req, "start_campaign", c.phone, { campaign_tail: c.id.slice(-6), from: c.status });
    res.json({ campaign: await rowOf(out), audited });
  }));

  return router;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node routes/admin-campaigns.test.js`
Expected: `routes/admin-campaigns.test.js ok`.

- [ ] **Step 5: Mount it** — in `server/index.js`, after line 338 (`app.use("/api/admin/posting", …)`), add:

```js
  app.use("/api/admin/campaigns", require("./routes/admin-campaigns")({ requireAdmin, requireStepUp, deps: postingDeps }));
```

Run: `node --check index.js` (a syntax check; index.js starts a server, so it is not required directly).
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add server/routes/admin-campaigns.js server/routes/admin-campaigns.test.js server/index.js
git commit -m "feat(admin): campaign create, edit, stop and start API"
```

---

### Task 5: The "קמפיינים" tab

**Files:**
- Modify: `public-agent/admin.html` (tab button after `tabManual`, line 162; pane before `<!-- ── MANUAL POSTING`, line 272; script tag after `/admin-manual.js`, line 507)
- Create: `public-agent/admin-campaigns.js`
- Test: `server/admin-campaigns.dom.test.js`

**Interfaces:**
- Consumes: Task 4 endpoints and error codes; `FLY.req(path, { method, body, noRedirect })`, `FLY.toast(text)`, `FLY.esc(text)` from `public-agent/api.js`.
- Produces: DOM ids `tabCampaigns`, `paneCampaigns`, `campList`, `campStatus`, `campAgent`, `campNew`, `campForm`, `campStepUp`.

- [ ] **Step 1: Write the failing DOM test**

```js
// server/admin-campaigns.dom.test.js
/* The "קמפיינים" admin tab in real Chromium against a stub API: the list
   renders, create sends the recorded consent, a refused change shows its
   Hebrew reason, stop asks first. Skips cleanly without a Chromium binary. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const express = require("express");

function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter(Boolean)) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { continue; }
    for (const d of dirs) { const exe = path.join(root, d, "chrome-linux", "chrome"); if (fs.existsSync(exe)) return exe; }
  }
  return null;
}

(async () => {
  const exe = findChromium();
  if (!exe) { console.log("admin-campaigns.dom.test.js skipped (no Chromium binary)"); return; }
  const { chromium } = require("patchright");
  let browser;
  try { browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] }); }
  catch { console.log("admin-campaigns.dom.test.js skipped (launch failed)"); return; }

  const ROW = { id: "c1", ref: "acct_1", phone_tail: "…0001", agent_name: "דנה לוי", page_id: "pg1", page_title: "דירה בחיפה", status: "running",
    pause_reason: null, mode: "standing", repeat: false, repeat_days: null, targets: ["groups"], expires_at: "2026-10-20T10:00:00.000Z",
    groups: [{ group_id: "111", name: "A" }], counts: { owed: 1, posted: 0, skipped: 0 }, created_by: "agent", consent_by: { by: "agent" }, version: "v1" };
  const seen = { creates: [], stops: 0 };
  let editAnswer = { status: 409, body: { error: "stale_version" } };
  const app = express(); app.use(express.json());
  app.get("/api/admin/me", (q, r) => r.json({ ok: true }));
  app.get("/api/admin/campaigns/campaigns", (q, r) => r.json({ campaigns: [ROW] }));
  app.get("/api/admin/campaigns/agents", (q, r) => r.json({ agents: [{ ref: "acct_1", phone_tail: "…0001", name: "דנה לוי" }] }));
  app.get("/api/admin/campaigns/agents/:ref/properties", (q, r) => r.json({ properties: [{ page_id: "pg1", title: "דירה בחיפה" }] }));
  app.get("/api/admin/campaigns/agents/:ref/groups", (q, r) => r.json({ groups: [{ group_id: "111", name: "A", url: "https://www.facebook.com/groups/111" }] }));
  app.post("/api/admin/campaigns/campaigns", (q, r) => { seen.creates.push(q.body); r.status(201).json({ campaign: ROW }); });
  app.patch("/api/admin/campaigns/campaigns/c1", (q, r) => r.status(editAnswer.status).json(editAnswer.body));
  app.post("/api/admin/campaigns/campaigns/c1/stop", (q, r) => { seen.stops++; r.json({ campaign: Object.assign({}, ROW, { status: "stopped" }) }); });
  app.use("/api", (q, r) => r.json({}));
  app.use(express.static(path.join(__dirname, "..", "public-agent")));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await browser.newPage();
    page.on("dialog", (d) => d.accept());
    await page.goto(`${base}/admin.html`);
    await page.click("#tabCampaigns");
    await page.waitForSelector("#campList [data-camp='c1']");
    assert.ok((await page.innerText("#campList")).includes("דנה לוי"));

    // create with recorded consent
    await page.click("#campNew");
    await page.selectOption("#campFormAgent", "acct_1");
    await page.waitForSelector("#campFormProperty option[value='pg1']");
    await page.selectOption("#campFormProperty", "pg1");
    await page.waitForSelector("#campFormGroups input[value='111']");
    await page.check("#campFormGroups input[value='111']");
    await page.selectOption("#campFormConsentMethod", "phone");
    await page.fill("#campFormConsentNote", "אישר בטלפון");
    await page.click("#campFormSave");
    await page.waitForFunction(() => document.querySelector("#campForm").hidden);
    assert.equal(seen.creates.length, 1);
    assert.deepEqual(seen.creates[0].consent, { method: "phone", note: "אישר בטלפון" });
    assert.deepEqual(seen.creates[0].group_ids, ["111"]);

    // a refused edit shows its reason
    await page.click("[data-camp='c1'] [data-act='edit']");
    await page.fill("#campFormDays", "7");
    await page.click("#campFormSave");
    await page.waitForFunction(() => /השתנה/.test(document.body.innerText));

    // stop asks, then stops
    await page.click("[data-camp='c1'] [data-act='stop']");
    await page.waitForFunction(() => document.body.innerText.includes("נעצר"));
    assert.equal(seen.stops, 1);
    console.log("admin-campaigns.dom.test.js ok");
  } finally { server.close(); await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node admin-campaigns.dom.test.js`
Expected: FAIL: timeout waiting for `#tabCampaigns` (or `skipped` if no Chromium; then run it where Chromium exists).

- [ ] **Step 3: Add the markup** — in `public-agent/admin.html`:

After `<button id="tabManual">פרסום ידני</button>` add:

```html
    <button id="tabCampaigns">קמפיינים</button>
```

Before `<!-- ── MANUAL POSTING (admin-manual.js) ── -->` add:

```html
  <!-- ── CAMPAIGNS (admin-campaigns.js) ── -->
  <div id="paneCampaigns" class="hidden">
    <div class="posting-warn hidden" id="campStepUp">נדרש אימות מחדש — התחברו שוב</div>
    <div class="manual-agentbar">
      <select id="campStatus" aria-label="סטטוס">
        <option value="">כל הסטטוסים</option><option value="running">פעיל</option><option value="paused">מושהה</option>
        <option value="stopped">נעצר</option><option value="completed">הסתיים</option>
      </select>
      <select id="campAgent" aria-label="סוכן"><option value="">כל הסוכנים</option></select>
      <button type="button" class="btn btn-gold btn-sm" id="campNew">קמפיין חדש</button>
    </div>
    <form id="campForm" class="manual-agent" hidden>
      <h3 id="campFormTitle">קמפיין חדש</h3>
      <label>סוכן <select id="campFormAgent"></select></label>
      <label>נכס <select id="campFormProperty"></select></label>
      <fieldset><legend>קבוצות</legend><div id="campFormGroups"></div></fieldset>
      <label>ימים <input id="campFormDays" type="number" min="1" max="30" value="14"></label>
      <label>חזרה כל <input id="campFormRepeat" type="number" min="0" max="30" value="0"> ימים (0 = בלי חזרה)</label>
      <label>מצב <select id="campFormMode"><option value="standing">אישור אחד לכל הקמפיין</option><option value="per_post">אישור לכל פוסט</option></select></label>
      <label><input id="campFormPage" type="checkbox"> גם בדף העסקי</label>
      <fieldset id="campFormConsent"><legend>הסכמת הסוכן</legend>
        <select id="campFormConsentMethod"><option value="phone">בטלפון</option><option value="in_person">פנים אל פנים</option><option value="whatsapp">בוואטסאפ</option></select>
        <input id="campFormConsentNote" maxlength="300" placeholder="מה הסוכן אישר, ומתי">
      </fieldset>
      <button type="button" class="btn btn-gold btn-sm" id="campFormSave">שמירה</button>
      <button type="button" class="btn btn-ghost btn-sm" id="campFormCancel">ביטול</button>
    </form>
    <div id="campList"><p class="manual-muted">טוען…</p></div>
  </div>
```

After `<script src="/admin-manual.js"></script>` add:

```html
<script src="/admin-campaigns.js"></script>
```

- [ ] **Step 4: Write `public-agent/admin-campaigns.js`**

```js
/*
 * admin-campaigns.js — the admin's "קמפיינים" tab: every campaign, and
 * create / edit / stop / start for an agent (routes/admin-campaigns.js).
 * Every change needs a fresh step-up; a 401 stepup_required shows the
 * banner. A new campaign carries the consent the admin recorded.
 */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = FLY.esc;
  var API = "/api/admin/campaigns";
  var rows = [], agents = [], editing = null; // editing: the row being edited, or null for a new campaign
  var STATUS = { running: "פעיל", paused: "מושהה", stopped: "נעצר", completed: "הסתיים" };
  var ERR = {
    consent_note_required: "חובה לבחור איך הסוכן הסכים ולכתוב הערה.",
    stale_version: "הקמפיין השתנה בינתיים — טוענים מחדש.",
    busy: "פוסט לקבוצה הזו כבר בדרך. נסו שוב בעוד כמה דקות.",
    not_live: "הקמפיין כבר לא פעיל.",
    account_halted: "החשבון של הסוכן מושבת. קודם צריך להפעיל אותו מחדש בלשונית הפרסום האוטומטי.",
    facebook_not_connected: "הסוכן עוד לא חיבר את פייסבוק.",
    page_not_confirmed: "הסוכן עוד לא אישר את הדף העסקי.",
    page_target_unavailable: "הדף העסקי של הסוכן עוד לא זוהה.",
    not_member: "הסוכן לא חבר בחלק מהקבוצות.",
    unknown_group: "יש קבוצות שלא בקטלוג.",
    group_disallowed: "יש קבוצות שאסור לפרסם בהן.",
    listing_type_not_allowed: "יש קבוצות שלא מתאימות לסוג הנכס.",
    not_found: "לא נמצא.",
    invalid_input: "הנתונים לא תקינים.",
    posting_unavailable_in_env: "בשרת הזה אי אפשר לשנות קמפיינים.",
  };
  var fmt = function (v) { var d = new Date(v); return isNaN(d) ? "—" : d.toLocaleDateString("he-IL"); };

  function req(method, path, body) {
    return FLY.req(API + path, { method: method, body: body, noRedirect: true }).then(function (d) { $("#campStepUp").classList.add("hidden"); return d; });
  }
  function fail(e) {
    if (e && e.status === 401 && e.code === "stepup_required") { $("#campStepUp").classList.remove("hidden"); FLY.toast("נדרש אימות מחדש — התחברו שוב"); return; }
    FLY.toast((e && ERR[e.code]) || "הפעולה נכשלה");
    if (e && e.code === "stale_version") load();
  }

  function render() {
    $("#campList").innerHTML = !rows.length ? '<p class="manual-muted">אין קמפיינים.</p>' : rows.map(function (r) {
      var live = r.status === "running" || r.status === "paused";
      return '<div class="manual-agent" data-camp="' + esc(r.id) + '">' +
        "<h3>" + esc(r.agent_name || r.phone_tail) + " · " + esc(r.page_title) + " <small>" + esc(STATUS[r.status] || r.status) + "</small></h3>" +
        '<div class="manual-muted">' + r.groups.length + " קבוצות · פורסם " + r.counts.posted + " · עד " + fmt(r.expires_at) +
        (r.repeat ? " · חזרה כל " + r.repeat_days + " ימים" : "") + " · נוצר על ידי " + (r.created_by === "admin" ? "הצוות" : "הסוכן") + "</div>" +
        (live ? '<button type="button" class="btn btn-ghost btn-sm" data-act="edit">עריכה</button>' : "") +
        (live ? '<button type="button" class="btn btn-ghost btn-sm" data-act="stop">עצירה</button>' : "") +
        (r.status !== "running" ? '<button type="button" class="btn btn-ghost btn-sm" data-act="start">הפעלה</button>' : "") +
        "</div>";
    }).join("");
  }
  function load() {
    var q = [];
    if ($("#campStatus").value) q.push("status=" + encodeURIComponent($("#campStatus").value));
    if ($("#campAgent").value) q.push("agent=" + encodeURIComponent($("#campAgent").value));
    return req("GET", "/campaigns" + (q.length ? "?" + q.join("&") : "")).then(function (d) { rows = d.campaigns || []; render(); }).catch(fail);
  }
  function loadAgents() {
    return req("GET", "/agents").then(function (d) {
      agents = d.agents || [];
      var opts = agents.map(function (a) { return '<option value="' + esc(a.ref) + '">' + esc(a.name || a.phone_tail) + " (" + esc(a.phone_tail) + ")</option>"; }).join("");
      $("#campAgent").innerHTML = '<option value="">כל הסוכנים</option>' + opts;
      $("#campFormAgent").innerHTML = '<option value="">בחרו סוכן…</option>' + opts;
    }).catch(fail);
  }
  function loadAgentChoices(ref, checked) {
    if (!ref) { $("#campFormProperty").innerHTML = ""; $("#campFormGroups").innerHTML = ""; return Promise.resolve(); }
    return Promise.all([req("GET", "/agents/" + encodeURIComponent(ref) + "/properties"), req("GET", "/agents/" + encodeURIComponent(ref) + "/groups")]).then(function (r) {
      $("#campFormProperty").innerHTML = (r[0].properties || []).map(function (p) { return '<option value="' + esc(p.page_id) + '">' + esc(p.title) + "</option>"; }).join("");
      $("#campFormGroups").innerHTML = (r[1].groups || []).map(function (g) {
        var on = checked && checked.indexOf(g.group_id) >= 0 ? " checked" : "";
        return '<label><input type="checkbox" value="' + esc(g.group_id) + '"' + on + "> " + esc(g.name || g.group_id) + "</label>";
      }).join("");
    }).catch(fail);
  }
  function chosenGroups() { return Array.prototype.map.call(document.querySelectorAll("#campFormGroups input:checked"), function (i) { return i.value; }); }

  function openForm(row) {
    editing = row || null;
    $("#campFormTitle").textContent = row ? "עריכת קמפיין" : "קמפיין חדש";
    $("#campFormAgent").disabled = !!row; $("#campFormProperty").disabled = !!row;
    $("#campFormConsent").hidden = !!row;
    $("#campFormDays").value = "14";
    $("#campFormRepeat").value = row && row.repeat ? String(row.repeat_days) : "0";
    $("#campFormMode").value = row ? row.mode : "standing";
    $("#campFormPage").checked = !!(row && row.targets.indexOf("page") >= 0);
    $("#campFormConsentNote").value = "";
    $("#campForm").hidden = false;
    if (row) { $("#campFormAgent").value = row.ref; loadAgentChoices(row.ref, row.groups.map(function (g) { return g.group_id; })).then(function () { $("#campFormProperty").value = row.page_id; }); }
  }
  function save() {
    var targets = $("#campFormPage").checked ? ["groups", "page"] : ["groups"];
    var repeat = Number($("#campFormRepeat").value) || 0;
    if (!editing) {
      return req("POST", "/campaigns", {
        agent: $("#campFormAgent").value, page_id: $("#campFormProperty").value, group_ids: chosenGroups(),
        days: Number($("#campFormDays").value) || 14, repeat_days: repeat || undefined, mode: $("#campFormMode").value, targets: targets,
        consent: { method: $("#campFormConsentMethod").value, note: $("#campFormConsentNote").value.trim() },
      }).then(function (d) { $("#campForm").hidden = true; FLY.toast(d.existing ? "לנכס הזה כבר יש קמפיין — פתחו אותו לעריכה" : "הקמפיין נפתח והסוכן קיבל הודעה"); load(); }).catch(fail);
    }
    var before = editing.groups.map(function (g) { return g.group_id; }), now = chosenGroups();
    return req("PATCH", "/campaigns/" + encodeURIComponent(editing.id), {
      version: editing.version, days: Number($("#campFormDays").value) || 14, repeat_days: repeat, mode: $("#campFormMode").value, targets: targets,
      add_group_ids: now.filter(function (g) { return before.indexOf(g) < 0; }).length ? now.filter(function (g) { return before.indexOf(g) < 0; }) : undefined,
      remove_group_ids: before.filter(function (g) { return now.indexOf(g) < 0; }).length ? before.filter(function (g) { return now.indexOf(g) < 0; }) : undefined,
    }).then(function () { $("#campForm").hidden = true; FLY.toast("נשמר"); load(); }).catch(fail);
  }
  function act(id, what) {
    var row = rows.filter(function (r) { return r.id === id; })[0];
    if (!row) return;
    if (what === "edit") return openForm(row);
    if (what === "stop") {
      if (!window.confirm("לעצור את הקמפיין? הסוכן יקבל הודעה.")) return;
      return req("POST", "/campaigns/" + encodeURIComponent(id) + "/stop", {}).then(function () { FLY.toast("הקמפיין נעצר"); load(); }).catch(fail);
    }
    if (what === "start") {
      var body = {};
      if (row.status === "stopped" || row.status === "completed") {
        var note = window.prompt("הפעלה מחדש צריכה הסכמה של הסוכן. מה הסוכן אישר, ומתי?");
        if (!note || !note.trim()) { FLY.toast("בוטל — חובה לכתוב הערה"); return; }
        body.consent = { method: "phone", note: note.trim() };
      }
      return req("POST", "/campaigns/" + encodeURIComponent(id) + "/start", body).then(function () { FLY.toast("הקמפיין פעיל"); load(); }).catch(fail);
    }
  }

  $("#campStatus").addEventListener("change", load);
  $("#campAgent").addEventListener("change", load);
  $("#campNew").addEventListener("click", function () { openForm(null); });
  $("#campFormAgent").addEventListener("change", function () { loadAgentChoices($("#campFormAgent").value, null); });
  $("#campFormSave").addEventListener("click", save);
  $("#campFormCancel").addEventListener("click", function () { $("#campForm").hidden = true; });
  $("#campList").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-act]"); if (!b) return;
    act(b.closest("[data-camp]").getAttribute("data-camp"), b.getAttribute("data-act"));
  });

  // ── tab wiring (like admin-posting.js) ──
  var tab = $("#tabCampaigns"), pane = $("#paneCampaigns");
  if (!tab || !pane) return;
  tab.addEventListener("click", function () {
    document.querySelectorAll(".tabs button").forEach(function (b) { b.classList.toggle("on", b === tab); });
    document.querySelectorAll("#viewAdmin [id^='pane']").forEach(function (p) { p.classList.toggle("hidden", p !== pane); });
    (agents.length ? Promise.resolve() : loadAgents()).then(load);
  });
  document.querySelectorAll(".tabs button").forEach(function (b) {
    if (b !== tab) b.addEventListener("click", function () { tab.classList.remove("on"); pane.classList.add("hidden"); });
  });
})();
```

- [ ] **Step 5: Run the DOM test**

Run: `node admin-campaigns.dom.test.js`
Expected: `admin-campaigns.dom.test.js ok` (or `skipped` without Chromium; it must pass where Chromium exists: `/opt/pw-browsers`).

- [ ] **Step 6: Commit**

```bash
git add public-agent/admin.html public-agent/admin-campaigns.js server/admin-campaigns.dom.test.js
git commit -m "feat(admin): קמפיינים tab"
```

---

### Task 6: Wire into the suite, sync the spec, push

**Files:**
- Modify: `server/package.json` (`scripts.test`)
- Modify: `docs/superpowers/specs/2026-10-07-admin-campaign-controls-design.md` (two wording fixes)

- [ ] **Step 1: Register the tests** — in `server/package.json`'s `test` script, after `node posting-manual.test.js && node routes/admin-manual.test.js && ` insert:

```
node routes/posting-create.test.js && node posting-campaign-admin.test.js && node routes/admin-campaigns.test.js && node admin-campaigns.dom.test.js && 
```

- [ ] **Step 2: Sync the spec with what was built**

In the spec:
- Section 3: replace "`server/posting-campaign.js`: new `removeGroups(id, groupIds, deps)` and `update(id, patch, deps, { version })`" with "`server/posting-campaign-admin.js`: `update(id, edit, deps, { version, by })` (adds and removes groups, texts, end date, repeat, targets, mode in one transaction); `server/routes/posting-create.js`: the create checks shared with the agent API".
- Section 5, Create: replace "is edited instead (create answers 200 with `existing: true`), as the agent API does." with "is returned unchanged with `existing: true` (200), as the agent API does; the tab then offers it for editing."
- Section 4, first paragraph: add "`say()` sends `admin_created` and `admin_stopped` also when `POSTING_MANUAL=1` (it drops other kinds there); an admin stop sends `admin_stopped` instead of the agent's `stopped`."

- [ ] **Step 3: Run the full suite**

Run: `npm test` (in `server/`)
Expected: exit 0. Known: `dev-driver.dom.test.js` fails in some containers independent of this work — if it fails, run it on the base commit to confirm, and report it.

- [ ] **Step 4: Commit and push**

```bash
git add server/package.json docs/superpowers/specs/2026-10-07-admin-campaign-controls-design.md
git commit -m "test(admin): campaign controls in the suite; spec matches the build"
git push -u origin claude/funny-cray-7oi9w9
```
