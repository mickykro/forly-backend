# Manual group posting (admin tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For launch on 4 Oct 2026, the agent approves every group's post text up front on the web. An admin then publishes the posts by hand from a new admin tab, in a live Driver browser on the agent's own Facebook profile. When every group is done, the agent gets one WhatsApp listing the groups.

**Architecture:** A new env switch, `POSTING_MANUAL=1`, turns the automatic sweeper and planner off and keeps WhatsApp to the final summary. The agent's approved text per group is stored on the campaign (`campaign.groups[i].copy`). A new module, `server/posting-manual.js`, derives the admin's work queue from running campaigns and records each group as posted or skipped. When nothing is left, it completes the campaign and sends the summary. A new router, `server/routes/admin-manual.js`, opens a Driver session on the agent's saved profile, streams it through the existing `connect-viewer.js`, and offers one-click helpers: open the group, type the text, attach the video. A new admin tab, `public-agent/admin-manual.js`, puts the queue and the live browser side by side.

**Tech Stack:** Node 20, Express, Firestore (`posting-store`), Driver browser sessions (`driver-browser.js`), Playwright page via `connect-viewer.js`, plain browser JS (no framework), Node `assert` tests run as `node <file>.test.js`.

## Global Constraints

- The repo is `~/Desktop/Call4li/call4li_creator_website/forly-backend`. Run tests from `server/`: one file with `node <file>.test.js`, all with `npm test`.
- Branch `feat/driver-listing-import-publish`. Commit messages end with `Co-Authored-By` only if `.claude/settings.json` has `attribution.commit`; otherwise no trailer.
- `POSTING_MANUAL=1` means:
  - no automatic posting;
  - no planning;
  - no per-post WhatsApp. Only the `completed` message is sent. Account-safety halts (`halted`, `reconnect`) are suppressed too in manual mode: the admin sees the browser and handles them.
- Unset `POSTING_MANUAL` means behaviour is unchanged.
- No autoplay-off step anywhere.
- No phone number in an admin API response or a log line beyond a last-4 tail (`A.tail`). Campaigns are addressed by campaign id.
- The Driver session URL (`cdpUrl`) never leaves the server.
- Files stay under 500 lines. `admin.js` is already over its cap, so the new tab lives in its own file, like `admin-posting.js`.
- Hebrew UI copy follows the humanizer rules:
  - no long dashes (—);
  - no "·" separators in post text;
  - plural address (כתבו, אשרו).
- Each session has a cap of 5 browser posts. That doesn't apply here: the admin posts by hand.

---

## File map

| File | What changes |
|---|---|
| `server/posting-fbsettings.js`, `server/posting-fbsettings.test.js` | Deleted (no autoplay-off) |
| `server/posting-tick.js`, `server/social-dwell.js` | Drop the two `ensureAutoplayOff` calls |
| `server/package.json` | Drop `posting-fbsettings.test.js` from `test`, add the new test files |
| `server/posting-manual.js` (new) | `enabled(env)`, `owed(c)`, `queue(deps)`, `markDone(campaignId, groupId, status, deps)` |
| `server/posting-manual.test.js` (new) | Tests for the above |
| `server/posting-sweeper.js` | `sweep()` returns early in manual mode |
| `server/routes/posting.js` | `planNow` no-op in manual mode; create skips the posting switch in manual mode and accepts `copies` |
| `server/routes/posting-settings.js` | `GET /settings` returns `manual: true/false` |
| `server/posting-account.js` | `say()` drops every kind but `completed` in manual mode |
| `server/posting-campaign.js` | `create({ copies })` stores the approved text per group |
| `server/posting-messages.js` | `completed(c)` lists the groups it was posted in, with their links |
| `server/routes/admin-manual.js` (new) | Admin queue + done/skip + live browser routes |
| `server/routes/admin-manual.test.js` (new) | Route tests with a fake driver and viewer |
| `server/index.js` | Mount `/api/admin/manual` |
| `public-agent/admin.html` | New tab button and pane, plus the `connect-viewer.js` and `admin-manual.js` scripts |
| `public-agent/admin-manual.js` (new) | The tab: queue on one side, live browser on the other |
| `public-agent/autopublish.js` | Confirm step shows an editable text per group and sends `copies`; manual-mode wording |

---

### Task 1: Remove the autoplay-off step

**Files:**
- Delete: `server/posting-fbsettings.js`, `server/posting-fbsettings.test.js`
- Modify: `server/posting-tick.js` (the `ensureAutoplayOff` call near line 380), `server/social-dwell.js` (lines ~391–392), `server/package.json` (`test` script)

**Interfaces:** Consumes nothing. Produces nothing.

- [ ] **Step 1: Find every reference**

Run: `cd server && grep -rn "fbsettings\|ensureAutoplayOff\|facebook_autoplay" --include=*.js . | grep -v node_modules`
Expected: the two call sites, the module, its test, and maybe a test fixture. Read each call site with ~6 lines of context before deleting it, so you remove the whole statement, including any `.catch()` chained to it.

- [ ] **Step 2: Delete the call sites and the module**

In `posting-tick.js`, delete the whole `await require("./posting-fbsettings").ensureAutoplayOff(page, { … });` statement, keeping the code around it. In `social-dwell.js`, delete the comment line `// Once per account: Facebook's own "Autoplay: Off" …` and the `await require("./posting-fbsettings").ensureAutoplayOff(…);` statement under it. Then:

```bash
git rm server/posting-fbsettings.js server/posting-fbsettings.test.js
```

In `server/package.json`, remove ` && node posting-fbsettings.test.js` from the `test` script.

- [ ] **Step 3: Run the suite**

Run: `cd server && npm test`
Expected: exit 0. If a test asserts the autoplay call, delete only that assertion.

- [ ] **Step 4: Commit**

```bash
git add -A server/posting-tick.js server/social-dwell.js server/package.json
git commit -m "Posting: drop the autoplay-off settings step (a 2-post session costs ~\$0.10)"
```

---

### Task 2: Manual mode switch

**Files:**
- Create: `server/posting-manual.js`, `server/posting-manual.test.js`
- Modify: `server/posting-sweeper.js:189-192`, `server/routes/posting.js:91-93` and the create route (`:141-186`), `server/routes/posting-settings.js` (`GET /settings` response), `server/posting-account.js:328-333`, `server/package.json`

**Interfaces:**
- Produces: `require("./posting-manual").enabled(env) → boolean` (true when `env.POSTING_MANUAL === "1"`). Tasks 4–7 use it.

- [ ] **Step 1: Write the failing test**

Create `server/posting-manual.test.js`:

```js
/* posting-manual.js: the manual-posting switch, queue and completion. */
const assert = require("assert");
const M = require("./posting-manual");
const A = require("./posting-account");

(async () => {
  // ── the switch ──
  assert.equal(M.enabled({ POSTING_MANUAL: "1" }), true);
  assert.equal(M.enabled({}), false);
  assert.equal(M.enabled({ POSTING_MANUAL: "0" }), false);

  // ── manual mode: only the end-of-campaign message reaches WhatsApp ──
  const sent = [];
  const deps = { env: { POSTING_MANUAL: "1" }, notify: async (ph, m) => sent.push(m) };
  await A.say(deps, "972500000001", "approve", "approve text");
  await A.say(deps, "972500000001", "posted", "posted text");
  await A.say(deps, "972500000001", "halted", "halted text");
  await A.say(deps, "972500000001", "completed", "done text");
  assert.deepEqual(sent, ["done text"], "only completed goes out");
  sent.length = 0;
  await A.say({ env: {}, notify: deps.notify }, "972500000001", "approve", "approve text");
  assert.deepEqual(sent, ["approve text"], "automatic mode unchanged");

  console.log("posting-manual.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd server && node posting-manual.test.js`
Expected: FAIL with `Cannot find module './posting-manual'`.

- [ ] **Step 3: Create the module with the switch**

`server/posting-manual.js`:

```js
/*
 * posting-manual.js — group posts published by hand (launch, 4 Oct 2026).
 *
 * POSTING_MANUAL=1: the agent approves every group's text up front on the
 * web; an admin publishes it from the admin "פרסום ידני" tab in a live
 * browser on the agent's own profile and ticks it off here. No automatic
 * posting, no planner, no WhatsApp until the campaign is complete.
 */
const enabled = (env = process.env) => env.POSTING_MANUAL === "1";

module.exports = { enabled };
```

- [ ] **Step 4: Gate `say()`**

In `server/posting-account.js`, change `say` to:

```js
async function say(deps, phone, kind, fallback, ...args) {
  if (typeof deps.notify !== "function") return;
  // Manual posting (posting-manual): the agent hears from us once, at the end.
  if (require("./posting-manual").enabled(deps.env || process.env) && kind !== "completed") return;
  const text = deps.messages && typeof deps.messages[kind] === "function" ? deps.messages[kind](...args) : fallback;
  if (!text) return;
  try { await deps.notify(phone, text); } catch (e) { console.error(redact(`posting notify ${kind} ${tail(phone)} failed: ${(e && e.code) || "error"}`)); }
}
```

- [ ] **Step 5: Stop the sweeper and the planner in manual mode**

In `server/posting-sweeper.js`, as the first lines of `sweep()` (before `if (sweeping) return 0;`):

```js
  // Manual posting: an admin publishes every post by hand (posting-manual).
  if (require("./posting-manual").enabled(deps.env || process.env)) { state.last = { at: stamp(), result: "manual" }; return 0; }
```

In `server/routes/posting.js`, as the first line inside `planNow(c, opts = {})`:

```js
    if (require("../posting-manual").enabled(ctx.env || deps.env || process.env)) return c; // manual posting: nothing is planned
```

In the create route (`router.post("/campaigns", …)`), replace both `allowed(...)` checks so manual mode skips the posting switch:

```js
    const manual = require("../posting-manual").enabled(deps.env || process.env);
    if (!manual && !(await allowed(S, phone, res, PERMISSION_CURED))) return;
```

and, further down:

```js
    if (!manual && !(await allowed(S, phone, res))) return;
```

In `server/routes/posting-settings.js`, add to the `GET /settings` JSON response:

```js
      manual: require("../posting-manual").enabled(deps.env || process.env),
```

(Use the same `deps` variable that file already uses for `env`; grep `deps.env` in it to confirm the name.)

- [ ] **Step 6: Add a sweeper test**

Append to `server/posting-manual.test.js`, inside the async block before `console.log`:

```js
  // ── the sweeper never posts in manual mode ──
  const S = require("./posting-sweeper");
  assert.equal(await S.sweep({ env: { POSTING_MANUAL: "1" } }), 0);
  assert.equal(S.status().last.result, "manual");
```

- [ ] **Step 7: Run the tests**

Run: `cd server && node posting-manual.test.js && npm test`
Expected: `posting-manual.test.js ok`, then exit 0. Add ` && node posting-manual.test.js` to the end of the `test` script in `server/package.json`.

- [ ] **Step 8: Commit**

```bash
git add server/posting-manual.js server/posting-manual.test.js server/posting-account.js server/posting-sweeper.js server/routes/posting.js server/routes/posting-settings.js server/package.json
git commit -m "Posting: POSTING_MANUAL=1 turns off automatic posting, planning and per-post WhatsApp"
```

---

### Task 3: The agent's approved text per group

**Files:**
- Modify: `server/posting-campaign.js` (`create`, ~line 59–80), `server/routes/posting.js` (`validCreate` ~line 63, create route ~line 178)
- Test: `server/posting-campaign.test.js`

**Interfaces:**
- Consumes: `cleanCopy(text) → string|""` and `MAX_COPY` (already in `posting-campaign.js`).
- Produces: `campaign.groups[i].copy` (string, optional). This is the exact text the agent approved for that group. Task 4 reads it.

- [ ] **Step 1: Write the failing test**

Append to `server/posting-campaign.test.js`, inside its main async block, next to the other `C.create` tests:

```js
  // ── create: the agent's approved text per group is kept on the group ──
  {
    const { deps } = await setup();
    const c = await C.create(base({ copies: { 111: "  טקסט שאושר לקבוצה A  ", 999: "לא בקמפיין" } }), deps);
    const a = c.groups.find((g) => g.group_id === "111"), b = c.groups.find((g) => g.group_id === "222");
    assert.equal(a.copy, "טקסט שאושר לקבוצה A", "trimmed, cleaned");
    assert.equal(b.copy, undefined, "a group without approved text gets none");
    assert.ok(!c.groups.some((g) => g.group_id === "999"), "a copy for a group not in the campaign adds nothing");
  }
```

(`setup` and `base` come from `posting-testkit`; check the top of the file, which already destructures them from `K`.)

- [ ] **Step 2: Run it to see it fail**

Run: `cd server && node posting-campaign.test.js`
Expected: FAIL on `a.copy` being `undefined`.

- [ ] **Step 3: Implement**

In `posting-campaign.js`, add `copies` to `create`'s parameter list and map the groups:

```js
async function create({ phone, page, groups, mode, days, repeat, repeatDays, consent, targets, copies } = {}, deps = {}, opts = {}) {
```

and replace `groups: normalizeGroups(groups, ctx),` with:

```js
    // The text the agent approved for each group (manual posting): kept as written.
    groups: normalizeGroups(groups, ctx).map((g) => {
      const t = copies && typeof copies[g.group_id] === "string" ? cleanCopy(copies[g.group_id]) : "";
      return t ? { ...g, copy: t } : g;
    }),
```

If `cleanCopy` is declared with `const` below `create`, it's still fine: `create` runs after module load.

In `routes/posting.js`, extend `validCreate` with this before `return`:

```js
  if (b.copies !== undefined && (!b.copies || typeof b.copies !== "object" || Array.isArray(b.copies) || Object.keys(b.copies).length > 60
    || Object.values(b.copies).some((t) => typeof t !== "string" || t.length > campaigns.MAX_COPY))) return null;
```

(`campaigns` is not in scope in `validCreate`; use `require("../posting-campaign").MAX_COPY` there.) In the route's `campaigns.create({ … })` call, add `copies: b.copies || null,`.

- [ ] **Step 4: Run the tests**

Run: `cd server && node posting-campaign.test.js && node routes/posting.test.js`
Expected: both print `ok`.

- [ ] **Step 5: Commit**

```bash
git add server/posting-campaign.js server/routes/posting.js server/posting-campaign.test.js
git commit -m "Posting: keep the agent's approved text per group on the campaign"
```

---

### Task 4: The manual queue, ticking a group off, and the final WhatsApp

**Files:**
- Modify: `server/posting-manual.js`, `server/posting-messages.js` (`completed`, ~line 101)
- Test: `server/posting-manual.test.js`, `server/posting-messages.test.js`

**Interfaces:**
- Consumes: `campaign.groups[i].copy` (Task 3); `C.buildCopy(page, c, target, kind, pageBaseUrl)`; `C.videoOf(page) → { video_url, poster_url }`; `A.ctxOf`, `A.mutate(x, id, fn)`, `A.currentPosts(c)`, `A.say`, `A.iso`.
- Produces:
  - `owed(c) → group[]`: the campaign's groups with no `posted`/`skipped` post in the current pass.
  - `queue(deps) → Promise<Item[]>`, where `Item = { campaign_id, phone_tail, agent_name, title, page_url, group_id, group_name, group_url, copy, video_url }`.
  - `markDone(campaignId, groupId, status, deps) → Promise<campaign|null>`, with `status` being `"posted"` or `"skipped"`. It completes the campaign and sends `completed` when nothing is owed.

- [ ] **Step 1: Write the failing tests**

Append to `server/posting-manual.test.js` (before `console.log`):

```js
  // ── queue → markDone → completed + one WhatsApp with the group links ──
  {
    const K = require("./posting-testkit");
    const C = require("./posting-campaign");
    const { deps, notes } = await K.setup();
    deps.env = { POSTING_MANUAL: "1" };
    deps.messages = require("./posting-messages").build({ pageBaseUrl: "https://f.ly", authSecret: "s" });
    const c = await C.create(K.base({ copies: { 111: "הטקסט שאושר" } }), deps);

    const q = await M.queue(deps);
    assert.deepEqual(q.map((i) => i.group_id), ["111", "222"]);
    assert.equal(q[0].copy, "הטקסט שאושר", "the approved text, as approved");
    assert.ok(q[1].copy.length > 0, "a group without approved text gets the built text");
    assert.ok(!JSON.stringify(q).includes("972500000001"), "no full phone");

    await M.markDone(c.id, "111", "posted", deps);
    assert.equal((await M.queue(deps)).length, 1);
    assert.equal(notes.length, 0, "nothing is sent mid-campaign");

    const done = await M.markDone(c.id, "222", "skipped", deps);
    assert.equal(done.status, "completed");
    assert.equal((await M.queue(deps)).length, 0);
    assert.equal(notes.length, 1, "one message at the end");
    const body = JSON.stringify(notes[0]);
    assert.ok(body.includes("facebook.com/groups/111"), "the posted group's link");
    assert.ok(!body.includes("facebook.com/groups/222"), "a skipped group is not listed");

    assert.equal(await M.markDone(c.id, "111", "posted", deps), null, "a group already done is refused");
    assert.equal(await M.markDone(c.id, "333", "posted", deps), null, "a group not in the campaign is refused");
  }
```

In `server/posting-messages.test.js`, next to the existing `completed` assertion (grep `completed`), add:

```js
  {
    const m = M.build({ pageBaseUrl: "https://f.ly", authSecret: "s" });
    const out = m.completed({ posts: [
      { status: "posted", group_name: "A", group_url: "https://www.facebook.com/groups/111" },
      { status: "skipped", group_name: "B", group_url: "https://www.facebook.com/groups/222" },
    ] });
    assert.ok(out.body.includes("A") && out.body.includes("https://www.facebook.com/groups/111"));
    assert.ok(!out.body.includes("groups/222"));
  }
```

(Use the module alias that file already uses for `posting-messages`; grep its `require`.)

- [ ] **Step 2: Run to see them fail**

Run: `cd server && node posting-manual.test.js; node posting-messages.test.js`
Expected: FAIL (`M.queue is not a function`, and no group link in `completed`).

- [ ] **Step 3: Implement `completed(c)`**

In `server/posting-messages.js`, replace the `completed:` line with:

```js
    // The end of a campaign: where it went up, each group with its link.
    completed: (c) => {
      const since = c && c.restarted_at;
      const done = ((c && c.posts) || []).filter((p) => p && p.status === "posted" && (!since || String(p.posted_at || "") >= since));
      const lines = done.slice(0, 10).map((p) => `• ${p.group_name || GROUP}${p.group_url ? `\n${p.group_url}` : ""}`);
      const more = done.length > 10 ? `\nועוד ${done.length - 10} קבוצות.` : "";
      const body = done.length
        ? `הנכס פורסם ב${done.length === 1 ? "קבוצה אחת" : `-${done.length} קבוצות`}:\n${lines.join("\n")}${more}`
        : "פורלי סיימה את הפרסום של הנכס.";
      return msg("🎉 הפרסום הושלם", body, [publishBtn]);
    },
```

- [ ] **Step 4: Implement `owed`, `queue` and `markDone`**

Replace the body of `server/posting-manual.js` below the header comment with:

```js
const crypto = require("crypto");
const A = require("./posting-account");
const C = require("./posting-campaign");

const enabled = (env = process.env) => env.POSTING_MANUAL === "1";
const DONE = new Set(["posted", "skipped", "pending_group_approval"]);
const urlOf = (g) => g.url || g.canonical_url || `https://www.facebook.com/groups/${g.group_id}`;

// The campaign's groups this pass still owes a post, in campaign order.
function owed(c) {
  const done = new Set(A.currentPosts(c).filter((p) => p && DONE.has(p.status)).map((p) => String(p.group_id)));
  return (c.groups || []).filter((g) => g && !done.has(String(g.group_id)));
}

// The admin's work list: one item per group still owed, oldest campaign first.
async function queue(deps = {}) {
  const x = A.ctxOf(deps);
  const running = (await x.store.listPostingCampaignsByStatus("running", 500))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const out = [];
  for (const c of running) {
    const page = await x.db.getPage(c.page_id);
    if (!page) continue;
    for (const g of owed(c)) {
      out.push({
        campaign_id: c.id, phone_tail: A.tail(c.phone),
        agent_name: (page.agent && page.agent.name) || "", title: (page.property && page.property.title) || c.page_id,
        page_url: `${String(deps.pageBaseUrl || "").replace(/\/+$/, "")}/p/${c.page_id}`,
        group_id: String(g.group_id), group_name: g.name || "", group_url: urlOf(g),
        copy: g.copy || C.buildCopy(page, c, { ...g, target: "group" }, "property", deps.pageBaseUrl || ""),
        video_url: C.videoOf(page).video_url,
      });
    }
  }
  return out;
}

// One group done by hand: "posted" or "skipped". → the campaign, or null when
// that group is not owed (not in the campaign, or already done).
async function markDone(campaignId, groupId, status, deps = {}) {
  if (!["posted", "skipped"].includes(status)) return null;
  const x = A.ctxOf(deps), now = A.iso(x.clock());
  let finished = false;
  const next = await A.mutate(x, campaignId, (cur) => {
    if (!cur || cur.status !== "running") return null;
    const g = owed(cur).find((q) => String(q.group_id) === String(groupId));
    if (!g) return null;
    const post = {
      id: crypto.randomUUID(), target: "group", group_id: String(g.group_id), group_url: urlOf(g), group_name: g.name || null,
      status, manual: true, scheduled_at: now, posted_at: status === "posted" ? now : null, error_code: status === "skipped" ? "manual_skip" : null,
    };
    const posts = (cur.posts || []).concat([post]);
    finished = owed({ ...cur, posts }).length === 0;
    return finished ? { posts, status: "completed" } : { posts };
  });
  if (!next || !(next.posts || []).some((p) => p.manual && String(p.group_id) === String(groupId) && p.scheduled_at === now)) return null;
  if (finished) await A.say(deps, next.phone, "completed", "🎉 הפרסום הושלם", next);
  return next;
}

module.exports = { enabled, owed, queue, markDone };
```

Check that `A.mutate` returns the updated campaign, and `null` when `fn` returns `null`: read `posting-account.js:311-325` and `posting-store.mutatePostingCampaign`. If it returns the unchanged campaign instead of `null`, the second `if` already catches that case.

- [ ] **Step 5: Run the tests**

Run: `cd server && node posting-manual.test.js && node posting-messages.test.js && npm test`
Expected: `ok`, `ok`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/posting-manual.js server/posting-manual.test.js server/posting-messages.js server/posting-messages.test.js
git commit -m "Manual posting: work queue, tick a group off, one WhatsApp with the group links at the end"
```

---

### Task 5: Admin routes, the queue and the live browser

**Files:**
- Create: `server/routes/admin-manual.js`, `server/routes/admin-manual.test.js`
- Modify: `server/index.js` (mount next to `/api/admin/posting`, ~line 301), `server/package.json`

**Interfaces:**
- Consumes: `M.queue`, `M.markDone` (Task 4); `driver.createSession(opts, { phone })`, `driver.stopSession(id)`; `viewer.attach(key, sessionId)`, `viewer.pipe(req, res, hub)`, `viewer.input(key, body)`, `viewer.close(key, reason)`, `viewer._hubs.get(key).page` (a Playwright page); `profileName("facebook", phone, gen)`; `locks.tryAcquire(phone, "facebook") → release|null`; `media.fetchVideo(url, deps) → { name, mimeType, buffer }`; `SELECTORS.mediaInput` from `posting-driver-proof`.
- Produces (all `requireAdmin`, mounted at `/api/admin/manual`):
  - `GET /queue` → `{ items: Item[] }`
  - `POST /campaigns/:id/groups/:gid/done` with body `{ status: "posted"|"skipped" }` → `{ ok: true, completed: bool }`, or 404
  - `POST /browser/:id` → opens a session on that campaign's agent profile → `{ open: true }`, or 409 `profile_busy`, or 503 `browser_unavailable`
  - `GET /browser/:id/view` → frame stream (same protocol as `/api/connections/browser/:p/view`)
  - `POST /browser/:id/view/input` → viewer input
  - `POST /browser/:id/goto` with `{ group_id }` → opens that group
  - `POST /browser/:id/type` with `{ group_id }` → types that group's text into the focused box
  - `POST /browser/:id/video` → attaches the property video to the open composer, or 409 `composer_not_open`
  - `DELETE /browser/:id` → closes the session

The browser is per agent (phone), addressed by any of that agent's campaign ids.

- [ ] **Step 1: Write the failing route test**

`server/routes/admin-manual.test.js`:

```js
/* routes/admin-manual.js: the manual-posting tab's API, with a fake Driver and viewer. */
const assert = require("assert");
const express = require("express");
const http = require("http");
const auth = require("../auth");
const { makeAdminGuard } = require("../admin-auth");
const K = require("../posting-testkit");
const C = require("../posting-campaign");
const createRouter = require("./admin-manual");

const SECRET = "admin-manual-secret", ADMIN = "972500000009";
const { requireAdmin } = makeAdminGuard({ verifySession: auth.verifySession, readToken: auth.readToken, authSecret: SECRET, adminPhones: [ADMIN] });
const H = { authorization: `Bearer ${auth.signSession(SECRET, ADMIN)}`, "content-type": "application/json" };
function call(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, path, method, headers: H }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let b = d; try { b = JSON.parse(d); } catch { /* text */ } resolve({ status: res.statusCode, body: b, raw: d }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const { deps } = await K.setup();
  deps.env = { POSTING_MANUAL: "1" };
  const c = await C.create(K.base({ copies: { 111: "שורה ראשונה\nשורה שנייה" } }), deps);

  const typed = [], files = [], gotos = [], stopped = [];
  const page = { goto: async (u) => gotos.push(u), locator: () => ({ count: async () => 1, first() { return this; }, setInputFiles: async (f) => files.push(f) }) };
  const hubs = new Map();
  const viewer = {
    _hubs: hubs,
    attach: async (key) => { hubs.set(key, { page }); return hubs.get(key); },
    pipe: (req, res) => res.json({ streaming: true }),
    input: async (key, b) => { typed.push(b); return { ok: true }; },
    close: async (key) => { hubs.delete(key); },
  };
  const driver = { createSession: async () => ({ sessionId: "s1" }), stopSession: async (id) => stopped.push(id) };
  const media = { fetchVideo: async () => ({ name: "property.mp4", mimeType: "video/mp4", buffer: Buffer.from("v") }) };

  const app = express();
  app.use(express.json());
  app.use("/api/admin/manual", createRouter({ requireAdmin, deps, driver, viewer, media }));
  const server = app.listen(0);
  try {
    const q = await call(server, "GET", "/api/admin/manual/queue");
    assert.equal(q.status, 200);
    assert.deepEqual(q.body.items.map((i) => i.group_id), ["111", "222"]);
    assert.ok(!q.raw.includes("972500000001"), "no full phone");

    assert.equal((await call(server, "POST", `/api/admin/manual/browser/${c.id}`)).status, 200);
    assert.equal((await call(server, "POST", `/api/admin/manual/browser/${c.id}`)).status, 200, "opening again reuses it");
    await call(server, "GET", `/api/admin/manual/browser/${c.id}/view`);

    await call(server, "POST", `/api/admin/manual/browser/${c.id}/goto`, { group_id: "111" });
    assert.match(gotos[0], /facebook\.com\/groups\/111/);

    await call(server, "POST", `/api/admin/manual/browser/${c.id}/type`, { group_id: "111" });
    assert.deepEqual(typed, [{ t: "text", text: "שורה ראשונה" }, { t: "key", key: "Enter" }, { t: "text", text: "שורה שנייה" }]);

    assert.equal((await call(server, "POST", `/api/admin/manual/browser/${c.id}/video`)).status, 200);
    assert.equal(files[0].mimeType, "video/mp4");

    const d1 = await call(server, "POST", `/api/admin/manual/campaigns/${c.id}/groups/111/done`, { status: "posted" });
    assert.deepEqual(d1.body, { ok: true, completed: false });
    assert.equal((await call(server, "POST", `/api/admin/manual/campaigns/${c.id}/groups/111/done`, { status: "posted" })).status, 404);
    assert.equal((await call(server, "POST", `/api/admin/manual/campaigns/${c.id}/groups/222/done`, { status: "nope" })).status, 400);

    assert.equal((await call(server, "DELETE", `/api/admin/manual/browser/${c.id}`)).status, 200);
    assert.deepEqual(stopped, ["s1"]);
    console.log("routes/admin-manual.test.js ok");
  } finally { server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd server && node routes/admin-manual.test.js`
Expected: FAIL with `Cannot find module './admin-manual'`.

- [ ] **Step 3: Implement the router**

`server/routes/admin-manual.js`:

```js
/*
 * routes/admin-manual.js — the admin "פרסום ידני" tab (posting-manual).
 *
 * The queue of group posts owed, a tick per group, and one live browser per
 * agent on that agent's own saved Facebook profile, shown through
 * connect-viewer (the cdpUrl never leaves the server). Helpers do the tedious
 * parts on request: open the group, type the approved text, attach the video.
 * The admin clicks Post themselves.
 */
const express = require("express");
const M = require("../posting-manual");
const A = require("../posting-account");

const SESSION_S = 3600; // Driver's limit
const CHUNK = 200;      // connect-viewer takes at most 256 characters per text event

module.exports = function createAdminManualRouter({
  requireAdmin, deps = {},
  driver = require("../driver-browser"), viewer = require("../connect-viewer"),
  media = require("../posting-media"), locks = require("../profile-lock"),
}) {
  const router = express.Router();
  const x = A.ctxOf(deps);
  const open = new Map(); // phone → { sessionId, release, timer }
  const key = (phone) => `manual|${phone}`;
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error(driver.redact ? driver.redact(`admin manual: ${(e && (e.code || e.name)) || "error"}`) : "admin manual: error");
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  });
  const campaignOf = async (id) => (await x.store.getPostingCampaign(String(id))) || null;
  const itemOf = async (c, groupId) => (await M.queue(deps)).find((i) => i.campaign_id === c.id && i.group_id === String(groupId)) || null;

  async function closeFor(phone, reason) {
    const s = open.get(phone);
    if (!s) return;
    open.delete(phone);
    clearTimeout(s.timer);
    await viewer.close(key(phone), reason).catch(() => {});
    await driver.stopSession(s.sessionId).catch(() => {});
    s.release();
  }

  router.get("/queue", requireAdmin, wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ items: await M.queue(deps) });
  }));

  router.post("/campaigns/:id/groups/:gid/done", requireAdmin, wrap(async (req, res) => {
    const status = req.body && req.body.status;
    if (!["posted", "skipped"].includes(status)) return res.status(400).json({ error: "invalid_input" });
    const c = await M.markDone(String(req.params.id), String(req.params.gid), status, deps);
    if (!c) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, completed: c.status === "completed" });
  }));

  router.post("/browser/:id", requireAdmin, wrap(async (req, res) => {
    const c = await campaignOf(req.params.id);
    if (!c) return res.status(404).json({ error: "not_found" });
    if (open.has(c.phone)) return res.json({ open: true });
    const release = locks.tryAcquire(c.phone, "facebook");
    if (!release) return res.status(409).json({ error: "profile_busy" });
    try {
      const conn = (await x.db.getConnection(c.phone)) || {};
      if (!conn.facebook_browser_connected_at) { release(); return res.status(409).json({ error: "facebook_not_connected" }); }
      const { profileName } = require("../profile-name");
      const s = await driver.createSession({
        duration: SESSION_S, url: "https://www.facebook.com/",
        profile: { name: profileName("facebook", c.phone, conn.facebook_profile_gen || 0), persist: true },
        note: "forly-manual:facebook", // never the phone
      }, { phone: c.phone });
      const timer = setTimeout(() => closeFor(c.phone, "expired"), SESSION_S * 1000);
      if (timer.unref) timer.unref();
      open.set(c.phone, { sessionId: s.sessionId, release, timer });
      res.json({ open: true });
    } catch (e) {
      release();
      console.error(driver.redact ? driver.redact(`admin manual browser ${A.tail(c.phone)}: ${(e && (e.code || e.name)) || "error"}`) : "admin manual browser failed");
      res.status(503).json({ error: "browser_unavailable" });
    }
  }));

  // The routes below act on the agent's open browser.
  const withBrowser = (fn) => wrap(async (req, res) => {
    const c = await campaignOf(req.params.id);
    if (!c) return res.status(404).json({ error: "not_found" });
    const s = open.get(c.phone);
    if (!s) return res.status(409).json({ error: "no_open_browser" });
    return fn(req, res, c, s);
  });
  const pageOf = (c) => { const h = viewer._hubs && viewer._hubs.get(key(c.phone)); return h && h.page; };

  router.get("/browser/:id/view", requireAdmin, withBrowser(async (req, res, c, s) => {
    let hub;
    try { hub = await viewer.attach(key(c.phone), s.sessionId); }
    catch (e) { return res.status(503).json({ error: (e && e.code) || "viewer_unavailable" }); }
    viewer.pipe(req, res, hub);
  }));

  router.post("/browser/:id/view/input", requireAdmin, withBrowser(async (req, res, c) => {
    try { res.json(await viewer.input(key(c.phone), req.body)); }
    catch (e) { res.status({ no_viewer: 409, invalid_input: 400, slow_down: 429 }[e && e.code] || 502).json({ error: (e && e.code) || "input_failed" }); }
  }));

  router.post("/browser/:id/goto", requireAdmin, withBrowser(async (req, res, c) => {
    const item = await itemOf(c, req.body && req.body.group_id);
    const page = pageOf(c);
    if (!item) return res.status(404).json({ error: "not_found" });
    if (!page) return res.status(409).json({ error: "no_viewer" });
    await page.goto(item.group_url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    res.json({ ok: true });
  }));

  // Types the group's approved text where the cursor is (the admin clicks the
  // composer first). Lines go as text, line breaks as Enter.
  router.post("/browser/:id/type", requireAdmin, withBrowser(async (req, res, c) => {
    const item = await itemOf(c, req.body && req.body.group_id);
    if (!item) return res.status(404).json({ error: "not_found" });
    const lines = String(item.copy).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await viewer.input(key(c.phone), { t: "key", key: "Enter" });
      for (let j = 0; j < lines[i].length; j += CHUNK) await viewer.input(key(c.phone), { t: "text", text: lines[i].slice(j, j + CHUNK) });
    }
    res.json({ ok: true });
  }));

  // The property video into the open composer's file input.
  router.post("/browser/:id/video", requireAdmin, withBrowser(async (req, res, c) => {
    const page = pageOf(c);
    if (!page) return res.status(409).json({ error: "no_viewer" });
    const item = (await M.queue(deps)).find((i) => i.campaign_id === c.id);
    if (!item || !item.video_url) return res.status(404).json({ error: "no_video" });
    const { SELECTORS: S } = require("../posting-driver-proof");
    const input = page.locator(S.mediaInput).first();
    if ((await input.count().catch(() => 0)) < 1) return res.status(409).json({ error: "composer_not_open" });
    let file;
    try { file = await media.fetchVideo(item.video_url, deps); }
    catch (e) { return res.status(502).json({ error: (e && e.code) || "media_unavailable" }); }
    await input.setInputFiles(file);
    res.json({ ok: true });
  }));

  router.delete("/browser/:id", requireAdmin, wrap(async (req, res) => {
    const c = await campaignOf(req.params.id);
    if (!c) return res.status(404).json({ error: "not_found" });
    await closeFor(c.phone, "closed");
    res.json({ ok: true });
  }));

  return router;
};
```

In the test's fake page, `locator()` returns an object whose `first()` returns itself, so `.count()` and `.setInputFiles()` work. The real Playwright API has the same shape.

- [ ] **Step 4: Run the test**

Run: `cd server && node routes/admin-manual.test.js`
Expected: `routes/admin-manual.test.js ok`. Add ` && node routes/admin-manual.test.js` to the `test` script.

- [ ] **Step 5: Mount it**

In `server/index.js`, right after the `app.use("/api/admin/posting", …)` line:

```js
  // Manual group posting (POSTING_MANUAL=1): the admin's queue and a live browser per agent.
  app.use("/api/admin/manual", require("./routes/admin-manual")({ requireAdmin, deps: postingDeps }));
```

- [ ] **Step 6: Run the suite**

Run: `cd server && npm test`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/routes/admin-manual.js server/routes/admin-manual.test.js server/index.js server/package.json
git commit -m "Admin: manual posting API, with a queue and a live browser on the agent's profile"
```

---

### Task 6: Admin tab "פרסום ידני"

**Files:**
- Create: `public-agent/admin-manual.js`
- Modify: `public-agent/admin.html` (tab button ~line 124; a pane next to `panePosting` ~line 165; scripts ~line 434)

**Interfaces:**
- Consumes: the Task 5 routes; `window.ForlyViewer.create(box, baseUrl, opts)` from `public-agent/connect-viewer.js`, which reads `baseUrl` and posts input to `baseUrl + "/input"`. Check this in `connect-viewer.js` `create()`, and adjust if the input path is built differently. `FLY.esc` and `FLY.toast` come from `admin.js`.
- Produces: the tab, with no API of its own.

- [ ] **Step 1: Add the tab, the pane and the scripts**

In `public-agent/admin.html`, after `<button id="tabPosting">פרסום אוטומטי</button>`, add `<button id="tabManual">פרסום ידני</button>`. While you're there, delete the duplicate second `<button id="tabPortfolios">פורטפוליו</button>`: two elements with the same id break `$("#tabPortfolios")`.

After the closing `</div>` of `panePosting`, add:

```html
  <!-- ── MANUAL POSTING (admin-manual.js) ── -->
  <div id="paneManual" class="hidden">
    <div class="manual-grid">
      <section>
        <h2>פוסטים לפרסום <button class="btn btn-ghost btn-sm" id="manualReload">רענון</button></h2>
        <p class="camp-muted">לכל קבוצה: פתחו את הקבוצה, לחצו בדפדפן על "כתבו משהו", הקלידו את הטקסט, צרפו את הסרטון ולחצו על "פרסום" בפייסבוק. אחר כך סמנו "פורסם".</p>
        <div id="manualQueue"></div>
      </section>
      <section>
        <h2 id="manualBrowserTitle">דפדפן</h2>
        <div id="manualBrowser" class="manual-browser"><p class="camp-muted">בחרו סוכן ולחצו "פתיחת דפדפן".</p></div>
      </section>
    </div>
  </div>
```

Before `<script src="/admin-posting.js"></script>`, add `<script src="/connect-viewer.js"></script>`. After it, add `<script src="/admin-manual.js"></script>`. In the page's `<style>`, add:

```css
  .manual-grid { display:grid; grid-template-columns: minmax(320px, 1fr) minmax(480px, 1.4fr); gap:16px; align-items:start; }
  @media (max-width: 900px) { .manual-grid { grid-template-columns: 1fr; } }
  .manual-browser { position:sticky; top:12px; min-height:420px; border:1px solid #ddd; border-radius:8px; overflow:hidden; background:#fafafa; }
  .manual-agent { border:1px solid #e5e5e5; border-radius:8px; padding:12px; margin-bottom:12px; }
  .manual-item { border-top:1px solid #eee; padding:10px 0; }
  .manual-item pre { white-space:pre-wrap; font:inherit; background:#f6f6f6; padding:8px; border-radius:6px; margin:6px 0; }
  .manual-item .row { display:flex; flex-wrap:wrap; gap:6px; }
```

- [ ] **Step 2: Write `public-agent/admin-manual.js`**

```js
/* Forly Admin Console — the "פרסום ידני" tab (posting-manual, launch 4 Oct 2026).
   The posts agents approved, per agent and property, next to a live browser
   on that agent's own Facebook profile. Helpers open the group, type the
   approved text and attach the video; the admin clicks Post in Facebook and
   ticks the group off. The last tick sends the agent one WhatsApp. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = FLY.esc;
  var API = "/api/admin/manual";
  var items = [], current = null, viewer = null; // current: the campaign id whose agent's browser is shown

  function call(method, path, body) {
    return fetch(API + path, { method: method, credentials: "include", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw Object.assign(new Error(j.error || r.status), { code: j.error, status: r.status }); return j; }); });
  }
  var ERR = {
    profile_busy: "הפרופיל של הסוכן תפוס כרגע. נסו שוב בעוד דקה.",
    facebook_not_connected: "הסוכן עוד לא חיבר את פייסבוק.",
    browser_unavailable: "הדפדפן לא נפתח. נסו שוב.",
    no_open_browser: "קודם פתחו דפדפן לסוכן הזה.",
    no_viewer: "הדפדפן עוד נטען. נסו שוב בעוד רגע.",
    composer_not_open: "קודם פתחו בפייסבוק את חלון הפוסט (\"כתבו משהו\").",
    no_video: "לנכס הזה אין סרטון.",
    not_found: "הקבוצה כבר סומנה, או שהקמפיין הסתיים.",
  };
  var fail = function (e) { FLY.toast(ERR[e && e.code] || "הפעולה נכשלה"); };

  function byAgent() {
    var groups = {};
    items.forEach(function (i) {
      var k = i.phone_tail;
      (groups[k] = groups[k] || { tail: k, name: i.agent_name, list: [] }).list.push(i);
    });
    return Object.keys(groups).map(function (k) { return groups[k]; });
  }

  function render() {
    var agents = byAgent();
    $("#manualQueue").innerHTML = !agents.length ? '<p class="camp-muted">אין כרגע פוסטים לפרסום.</p>' : agents.map(function (a) {
      var cid = a.list[0].campaign_id;
      return '<div class="manual-agent"><h3>' + esc(a.name || "סוכן") + ' <small class="camp-muted">' + esc(a.tail) + '</small> ' +
        '<button class="btn btn-gold btn-sm" data-open="' + esc(cid) + '">פתיחת דפדפן</button></h3>' +
        a.list.map(function (i) {
          var k = 'data-cid="' + esc(i.campaign_id) + '" data-gid="' + esc(i.group_id) + '"';
          return '<div class="manual-item"><b>' + esc(i.title) + '</b> ← ' + esc(i.group_name || "קבוצה") +
            ' <a href="' + esc(i.group_url) + '" target="_blank" rel="noopener">↗</a>' +
            '<pre dir="auto">' + esc(i.copy) + '</pre><div class="row">' +
            '<button class="btn btn-ghost btn-sm" data-act="goto" ' + k + '>1. פתיחת הקבוצה</button>' +
            '<button class="btn btn-ghost btn-sm" data-act="type" ' + k + '>2. הקלדת הטקסט</button>' +
            (i.video_url ? '<button class="btn btn-ghost btn-sm" data-act="video" ' + k + '>3. צירוף הסרטון</button>' : "") +
            '<button class="btn btn-ghost btn-sm" data-act="copy" ' + k + '>העתקה</button>' +
            '<button class="btn btn-gold btn-sm" data-act="posted" ' + k + '>פורסם ✓</button>' +
            '<button class="btn btn-ghost btn-sm" data-act="skipped" ' + k + '>דילוג</button></div></div>';
        }).join("") + "</div>";
    }).join("");
  }

  function load() {
    return call("GET", "/queue").then(function (j) { items = j.items || []; render(); }).catch(fail);
  }

  function show(cid) {
    if (viewer && viewer.stop) viewer.stop();
    current = cid;
    var box = $("#manualBrowser");
    box.innerHTML = "";
    viewer = window.ForlyViewer.create(box, API + "/browser/" + encodeURIComponent(cid) + "/view", {
      onEnd: function () { box.innerHTML = '<p class="camp-muted">הדפדפן נסגר. לחצו שוב על "פתיחת דפדפן".</p>'; },
    });
  }

  $("#manualQueue").addEventListener("click", function (ev) {
    var b = ev.target.closest("button");
    if (!b) return;
    if (b.dataset.open) {
      b.disabled = true;
      return call("POST", "/browser/" + encodeURIComponent(b.dataset.open))
        .then(function () { show(b.dataset.open); }).catch(fail).then(function () { b.disabled = false; });
    }
    var cid = b.dataset.cid, gid = b.dataset.gid, act = b.dataset.act;
    var item = items.filter(function (i) { return i.campaign_id === cid && i.group_id === gid; })[0];
    if (!item) return;
    if (act === "copy") return navigator.clipboard.writeText(item.copy).then(function () { FLY.toast("הטקסט הועתק"); });
    if (act === "posted" || act === "skipped") {
      if (act === "skipped" && !confirm("לדלג על הקבוצה הזו? היא לא תופיע בהודעה לסוכן.")) return;
      b.disabled = true;
      return call("POST", "/campaigns/" + encodeURIComponent(cid) + "/groups/" + encodeURIComponent(gid) + "/done", { status: act })
        .then(function (j) { FLY.toast(j.completed ? "הקמפיין הושלם, הסוכן קיבל הודעה" : "סומן ✓"); return load(); })
        .catch(function (e) { b.disabled = false; fail(e); });
    }
    if (current !== cid) { FLY.toast(ERR.no_open_browser); return; }
    b.disabled = true;
    var path = { goto: "/goto", type: "/type", video: "/video" }[act];
    call("POST", "/browser/" + encodeURIComponent(cid) + path, { group_id: gid })
      .then(function () { FLY.toast(act === "type" ? "הטקסט הוקלד" : act === "video" ? "הסרטון מצורף, חכו שיעלה" : "הקבוצה נפתחה"); })
      .catch(fail).then(function () { b.disabled = false; });
  });
  $("#manualReload").addEventListener("click", load);

  var tab = $("#tabManual"), pane = $("#paneManual");
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

Two things to check before running:
- **The viewer handle.** Confirm `ForlyViewer.create` returns an object with a stop method. `connect-viewer.js` uses `stop(me)` internally. If `create`'s return value has no `stop`, call `window.ForlyViewer.unmount()` instead, or add a `stop: () => stop(me)` to the object `create` returns.
- **Messages from `admin-posting.js`.** Its "leaving ours just hides it" listener also runs when this tab is clicked, which is fine.

- [ ] **Step 3: Check in the browser**

Start the server with manual mode: `cd server && POSTING_MANUAL=1 npm run posting:local` (or your usual local start with `POSTING_MANUAL=1`). Then:
1. Sign in as an admin and open `/admin.html`. The tab "פרסום ידני" shows the queue: one card per agent, with each owed group's text.
2. Press "פתיחת דפדפן". The live browser shows that agent's Facebook.
3. Press "1. פתיחת הקבוצה". The group opens.
4. Click "כתבו משהו" in the live view, then press "2. הקלדת הטקסט". The text appears with its line breaks.
5. Press "3. צירוף הסרטון". The video preview appears.
6. Don't press Facebook's Post in this check. Close the composer, press "דילוג" on a test item, and confirm it leaves the queue.

- [ ] **Step 4: Commit**

```bash
git add public-agent/admin.html public-agent/admin-manual.js
git commit -m "Admin: פרסום ידני tab, with the queue next to a live browser and helpers"
```

---

### Task 7: The agent approves every group's text up front

**Files:**
- Modify: `public-agent/autopublish.js` (preview `loadPreview`/`previewHtml` ~lines 44–75; `start()` ~line 318; `toggle()` ~line 340)

**Interfaces:**
- Consumes: `GET /api/posting/preview?page_id&group_id` (exists, returns `{ copy, group_name, video_url, … }`); `settings.manual` (Task 2); `POST /api/posting/campaigns` with `copies` (Task 3).
- Produces: nothing for later tasks.

- [ ] **Step 1: Load a preview for every chosen group**

Replace `loadPreview(p)` with a version that loads every group, keyed `${page_id}|${group_id}`:

```js
  function loadPreview(p) {
    for (const gid of groupsOf(p)) {
      const k = `${p.page_id}|${gid}`;
      if (previews.has(k)) continue;
      previews.set(k, "loading");
      api(`/api/posting/preview?page_id=${encodeURIComponent(p.page_id)}&group_id=${encodeURIComponent(gid)}`)
        .then((j) => previews.set(k, j), () => previews.set(k, "error"))
        .then(renderProps);
    }
  }
```

`previewKey(p)` (first group) stays, for the single-preview view outside confirmation.

- [ ] **Step 2: Show one editable text per group while confirming (manual mode)**

At the top of `previewHtml(p)`, add a manual-mode branch:

```js
    if (settings && settings.manual && confirming.has(p.page_id)) {
      const ids = [...groupsOf(p)], name = (gid) => (members().find((g) => String(g.group_id) === gid) || {}).name || "קבוצה";
      const cards = ids.map((gid) => {
        const v = previews.get(`${p.page_id}|${gid}`);
        if (!v || v === "loading") return `<div class="ap-fb"><p class="camp-muted">טוענים את הפוסט ל${U.esc(name(gid))}…</p></div>`;
        if (v === "error") return `<div class="ap-fb"><p class="ap-note">לא הצלחנו להציג את הפוסט ל${U.esc(name(gid))}.</p></div>`;
        return `<div class="ap-fb"><div class="ap-fb-head"><b>${U.esc(v.author || "החשבון שלכם")}</b> ◂ ${U.esc(v.group_name || name(gid))}</div>${copyBox(`${p.page_id}|${gid}`, v.copy)}</div>`;
      }).join("");
      return `<div class="ap-preview">${cards}
        <p class="camp-muted camp-small">זה הנוסח שיעלה לכל קבוצה. אפשר לערוך כל אחד. אחרי האישור לא נבקש אישור נוסף, ובסוף תקבלו הודעת וואטסאפ עם הקבוצות שבהן פורסם.</p>
        <button type="button" class="btn btn-gold btn-sm" data-confirm="${U.esc(p.page_id)}">אישור והתחלת הפרסום</button></div>`;
    }
```

The textareas' `data-draft` keys are `${page_id}|${group_id}`, so `draftOf(key).copy` holds each edit. The existing `input` listener that writes `draftOf(...).copy` from `data-draft` handles them; grep `data-draft` to confirm it reads `dataset.draft` generically.

- [ ] **Step 3: Send the approved texts**

In `start(p, ids)`, add `copies` to the `post("/api/posting/campaigns", { … })` body:

```js
          copies: settings.manual ? Object.fromEntries(left.map((gid) => {
            const v = previews.get(`${p.page_id}|${gid}`), d = draftOf(`${p.page_id}|${gid}`).copy;
            return [gid, typeof d === "string" && d.trim() ? d : (v && v.copy) || ""];
          }).filter(([, t]) => t)) : undefined,
```

In `toggle(p, on)`, skip `approveFirst` in manual mode:

```js
        const approved = settings.manual ? true : perPost ? await approveFirst(p, original) : true;
```

- [ ] **Step 4: Check in the browser**

With the server running with `POSTING_MANUAL=1`, open `/autopublish.html` as an agent. Switch a property on with 2 groups:
1. Two editable texts appear, one per group, each headed by the group's name.
2. Edit one of them and press "אישור והתחלת הפרסום".
3. In `/admin.html` → "פרסום ידני", that group shows your edited text and the other shows the built text.
4. No WhatsApp message is sent. Check the server log for `[whatsapp]` lines.

- [ ] **Step 5: Commit**

```bash
git add public-agent/autopublish.js
git commit -m "Auto-publish: agents approve every group's text up front (manual posting)"
```

---

### Task 8: Launch check

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `cd server && npm test`
Expected: exit 0.

- [ ] **Step 2: Production env**

Set `POSTING_MANUAL=1` in the production env file on the VPS (`/root/forly-backend/.env` or the deploy env that `deploy-server.yml` reads). Grep the workflow for how env vars reach the container before editing. After deploy, check the logs for `driver: posting sweeper started`. The first sweep's status reads `manual`: `GET /api/dev/driver/posting` is local-only, so check `posting-sweeper` `state.last` via the admin overview or a log line.

- [ ] **Step 3: One real end-to-end run on the admin's own property**

As your own agent account:
1. Approve one property into your own test group.
2. In "פרסום ידני", open the browser, open the group, type the text, attach the video, and click Post in Facebook.
3. Press "פורסם ✓".
4. Expected: the campaign shows "completed", and your phone gets one WhatsApp listing the group with its link.

---

## Self-review notes

- **Spec coverage:**
  - Autoplay removed: Task 1.
  - Editable versions plus groups before start: Tasks 3 and 7.
  - No WhatsApp approvals or validations: Task 2 (`say` gate, planner off).
  - End-of-campaign WhatsApp with links: Task 4. These are group links, because the admin only ticks "posted" (no permalink).
  - Admin tab for manual upload in a Driver browser: Tasks 5 and 6.
- **Assumption to confirm:** in manual mode, the halt and reconnect WhatsApps are suppressed too (Global Constraints). Say if they should still go out.
- **Out of scope:**
  - Automatic posting's WhatsApp messages and approvals stay as they are.
  - The 5-post batching and the other uncommitted fixes from 3 Oct are already in the working tree. Commit them first, as their own commit, before Task 1.
