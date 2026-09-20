# Property Page Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the property page read path from up to ~102 Firestore document reads to at most 3. Client-side work is deliberately minimal: two of the four original frontend findings did not survive checking against the code, so the rest waits on real measurements.

**Architecture:** `GET /api/property-by-slug` currently resolves a page by fetching every page belonging to an agent and filtering in JavaScript, fetches the same business document twice (once bypassing an existing cache), and runs all four steps sequentially. Package A replaces the scan with a scoped two-equality query, routes the duplicate fetch through the existing `business-cache`, and overlaps the two independent reads. Packages B and C reduce client media weight and revalidation round trips.

**Tech Stack:** Node 20 / Express 4 / Firestore (firebase-admin 13). No bundler, no test framework — tests are standalone Node scripts using `require("assert")`.

Spec: `docs/superpowers/specs/2026-09-20-property-page-performance-design.md`

## Global Constraints

- **Tests are pure functions.** No Express, no Firestore, no network, no `npm install` required. Every test must run standalone via `node server/<name>.test.js`.
- **Every new test file must be appended to the `test` script in `server/package.json`**, which is a single `&&`-chained command. A test not in that chain does not run.
- **`server/db.js` has two branches in every function:** a Firestore branch (`if (db)`) and an in-memory `mem` branch (`db.js:11`). New db functions MUST implement both — the test suite exercises only the `mem` branch, since `db` stays null unless `init()` is called with `GOOGLE_APPLICATION_CREDENTIALS` set.
- **Explanatory comments in this codebase use the `ponytail:` prefix** (see `db.js:20`, `portfolio.test.js:6`). Follow that convention where a comment explains *why*.
- **Keep files under 500 lines** (CLAUDE.md).
- **Never commit secrets or `.env` files** (CLAUDE.md).
- **Do not add a `Co-Authored-By` trailer** — `.claude/settings.json` has no `attribution.commit` key (CLAUDE.md).
- **Branch:** all work lands on `claude/pensive-goldberg-3zp5sf`.
- **Run `cd server && npm test` before every commit.** It must pass.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `server/db.js` | Modify (~line 496) | Add `findPageBySlug(phone, publicSlug)` beside `listPagesByPhone`; export it. |
| `server/db.test.js` | Create | Tests for `findPageBySlug` against the in-memory branch. New file — no `db.test.js` exists today. |
| `server/package.json` | Modify (`scripts.test`) | Append `node db.test.js` to the chain. |
| `server/routes/pages.js` | Modify (674-710) | Use the scoped query, the cache, and `Promise.all`. |
| `server/routes/dashboard.js` | Modify (imports, 117, 207, 250, 263) | Invalidate `business-cache` after every business write. |
| `firestore.indexes.json` | Modify (conditional) | Composite index for `property_pages`, only if Firestore demands one. |
| `public-nadlan/templates/nocturne.html` | Modify (145) | Hero video `preload="auto"` → `metadata`. |

---

## Package A — Backend hot path

### Task 1: Add `db.findPageBySlug`

**Files:**
- Create: `server/db.test.js`
- Modify: `server/db.js` (insert after `listPagesByPhone`, which ends at line 496; add to `module.exports` at line 504)
- Modify: `server/package.json` (`scripts.test`)

**Interfaces:**
- Consumes: `mem` (`db.js:11`), `savePage` (`db.js:69`)
- Produces: `findPageBySlug(phone: string, publicSlug: string) => Promise<object|null>` — resolves to the page object, or `null` when no page with that `public_slug` belongs to that `business_phone`. Task 2 calls this.

- [ ] **Step 1: Write the failing test**

Create `server/db.test.js`:

```js
#!/usr/bin/env node
/*
 * db.test.js — tests for db.js helpers against the in-memory branch.
 * Pure: no Firestore, no network. init() is never called, so `db` stays
 * null and every function takes its mem path.
 * Run: node server/db.test.js
 */
const assert = require("assert");
const db = require("./db");

const page = (id, phone, slug) => ({
  page_id: id, business_phone: phone, public_slug: slug, status: "active",
});

(async () => {
  await db.savePage(page("p1", "972501111111", "dira-herzl-12"));
  await db.savePage(page("p2", "972501111111", "penthouse-rotshild-5"));
  await db.savePage(page("p3", "972502222222", "dira-herzl-12"));

  // ── finds the page belonging to the given business ──
  let found = await db.findPageBySlug("972501111111", "dira-herzl-12");
  assert.ok(found, "should find a page that exists");
  assert.strictEqual(found.page_id, "p1");

  found = await db.findPageBySlug("972501111111", "penthouse-rotshild-5");
  assert.strictEqual(found.page_id, "p2");

  // ── never returns another agent's page with the same slug ──
  found = await db.findPageBySlug("972502222222", "dira-herzl-12");
  assert.strictEqual(found.page_id, "p3", "same slug, different owner, different page");

  // ── no match ⇒ null, not undefined and not a throw ──
  assert.strictEqual(await db.findPageBySlug("972501111111", "nope"), null);
  assert.strictEqual(await db.findPageBySlug("972509999999", "dira-herzl-12"), null);

  // ── no ceiling: a page beyond the old 100-doc scan window still resolves ──
  for (let i = 0; i < 150; i++) {
    await db.savePage(page(`bulk${i}`, "972503333333", `bulk-slug-${i}`));
  }
  found = await db.findPageBySlug("972503333333", "bulk-slug-149");
  assert.ok(found, "the 150th page must resolve; the old .find() over 100 docs missed it");
  assert.strictEqual(found.page_id, "bulk149");

  console.log("db.test.js OK");
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node db.test.js`
Expected: FAIL with `TypeError: db.findPageBySlug is not a function`

- [ ] **Step 3: Write minimal implementation**

In `server/db.js`, immediately after `listPagesByPhone` (which closes at line 496):

```js
// ponytail: resolves one page by its public slug without reading the agent's
// whole catalogue. The slug is only unique within one business, so the phone
// filter is load-bearing, not an optimisation — dropping it would let one
// agent's slug resolve to another's page.
async function findPageBySlug(phone, publicSlug) {
  if (db) {
    const snap = await db.collection("property_pages")
      .where("business_phone", "==", phone)
      .where("public_slug", "==", publicSlug)
      .limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  }
  return [...mem.pages.values()].find(
    (p) => p.business_phone === phone && p.public_slug === publicSlug
  ) || null;
}
```

Then add `findPageBySlug` to the exports list at `db.js:504`, which currently reads:

```js
  savePage, getPage, findActivePageByListing, listPublicPages, listPagesForExpiry, incrPageCounter, updatePage, uniquePageId, listAllPages, listPagesByPhone,
```

Change it to:

```js
  savePage, getPage, findActivePageByListing, listPublicPages, listPagesForExpiry, incrPageCounter, updatePage, uniquePageId, listAllPages, listPagesByPhone, findPageBySlug,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node db.test.js`
Expected: `db.test.js OK`

- [ ] **Step 5: Add the test to the suite**

In `server/package.json`, append ` && node db.test.js` to the end of the `scripts.test` value.

- [ ] **Step 6: Run the whole suite**

Run: `cd server && npm test`
Expected: all tests pass, and `db.test.js OK` appears in the output.

- [ ] **Step 7: Commit**

```bash
git add server/db.js server/db.test.js server/package.json
git commit -m "feat(db): add findPageBySlug scoped lookup

Resolves one page by public_slug within a business instead of reading
the agent's whole catalogue. The phone filter is load-bearing: slugs are
unique per business, not globally."
```

---

### Task 2: Use the scoped query in the property route

**Files:**
- Modify: `server/routes/pages.js:688-689`

**Interfaces:**
- Consumes: `findPageBySlug` from Task 1.
- Produces: nothing new. The endpoint's responses are unchanged.

This task has no automated test: the suite is pure-unit by design (no Express, per Global Constraints), so route behavior is verified by reading the diff and by the manual check in Step 3.

- [ ] **Step 1: Replace the scan**

In `server/routes/pages.js`, this is the current code at lines 688-689:

```js
      const pages = await db.listPagesByPhone(reservation.business_phone, 100);
      const page = pages.find((p) => p.public_slug === propSlug);
```

Replace those two lines with:

```js
      const page = await db.findPageBySlug(reservation.business_phone, propSlug);
```

Leave the three lines that follow exactly as they are — they still apply:

```js
      if (!page) return res.status(404).json({ error: "not_found" });
      if (page.status !== "active" && page.status !== "expiring") {
        return res.status(404).json({ error: "not_found" });
      }
```

- [ ] **Step 2: Confirm nothing else used that `pages` variable**

Run: `cd server && sed -n '674,712p' routes/pages.js`
Expected: the word `pages` no longer appears anywhere in the handler body. If it does, that reference must be reworked before continuing — stop and report it rather than guessing.

- [ ] **Step 3: Run the suite**

Run: `cd server && npm test`
Expected: all pass. (No test covers this route; this run guards against an accidental syntax error or a broken import.)

- [ ] **Step 4: Commit**

```bash
git add server/routes/pages.js
git commit -m "perf(pages): resolve property by slug with a scoped query

/api/property-by-slug read up to 100 page docs and filtered in JS to use
one. It now reads one. Also lifts the latent 100-page ceiling: properties
outside the old scan window returned 404."
```

---

### Task 3: Invalidate business-cache on dashboard writes

**Files:**
- Modify: `server/routes/dashboard.js` (imports at line 12; write sites at 117, 207, 250, 263)

**Interfaces:**
- Consumes: `invalidate(phone)` from `server/business-cache.js` (exported as `{ get, invalidate, clear, TTL_MS }`).
- Produces: the guarantee Task 4 depends on — a business write is visible to the next cached read.

**This task is a precondition for Task 4 and must land first.** `dashboard.js` writes business documents at four sites and never invalidates the cache. Task 4 puts a cached read on the property page path; without this task, an agent toggling their portfolio open would not see it on their pages for up to `TTL_MS` (60s). This also fixes existing staleness: `resolveChatbot` (`routes/pages.js:82`) already reads through that cache today.

- [ ] **Step 1: Import the cache**

In `server/routes/dashboard.js`, after line 12 (`const { portfolioSlug, ... } = require("../portfolio");`), add:

```js
const businessCache = require("../business-cache");
```

- [ ] **Step 2: Invalidate after the signup write (line ~117)**

Find the `await db.setBusiness(phone, {` call that begins at line 117 and carries `source: "web_signup"`. Immediately after that call's closing `});`, add:

```js
      // ponytail: the page render path reads this doc through business-cache;
      // without this the agent's own pages lag their edit by up to the TTL.
      businessCache.invalidate(phone);
```

- [ ] **Step 3: Invalidate after the profile/portfolio write (line ~207)**

Find the `await db.setBusiness(phone, {` call carrying `portfolio: normalized,`. Immediately after its closing `}, true);`, add:

```js
      businessCache.invalidate(phone);
```

- [ ] **Step 4: Invalidate after both writes in the portfolio-create handler (lines ~250 and ~263)**

There are two `setBusiness` calls in this handler. After the minimal-record write:

```js
        await db.setBusiness(phone, { phone, created_at: now }, true);
        businessCache.invalidate(phone);
```

And after the write that carries the `portfolio: { slug, status: "open", ... }` object, immediately following its closing `}, true);`:

```js
      businessCache.invalidate(phone);
```

- [ ] **Step 5: Verify all four sites are covered**

Run: `cd server && grep -c "businessCache.invalidate" routes/dashboard.js`
Expected: `4`

Run: `cd server && grep -c "db.setBusiness" routes/dashboard.js`
Expected: `4` — the counts must match. If `setBusiness` returns a higher number, a write site was missed; add an `invalidate` call after it.

- [ ] **Step 6: Run the suite**

Run: `cd server && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add server/routes/dashboard.js
git commit -m "fix(dashboard): invalidate business-cache after business writes

The page render path reads business docs through business-cache, but the
four dashboard write sites never invalidated it, so profile and portfolio
edits could lag by up to the 60s TTL. Precondition for caching the read
in the property route."
```

---

### Task 4: Route the duplicate business read through the cache

**Files:**
- Modify: `server/routes/pages.js:686`

**Interfaces:**
- Consumes: `businessCache` (already imported at `routes/pages.js:17`), and the invalidation guarantee from Task 3.
- Produces: nothing new.

**Do not start this task until Task 3 is committed.**

- [ ] **Step 1: Confirm Task 3 landed**

Run: `cd server && grep -c "businessCache.invalidate" routes/dashboard.js`
Expected: `4`. If it is `0`, stop — Task 3 has not been done, and this change would introduce stale portfolio state.

- [ ] **Step 2: Swap the direct read for the cached one**

In `server/routes/pages.js`, line 686 currently reads:

```js
      const business = await db.getBusiness(reservation.business_phone);
```

Replace it with:

```js
      const business = await businessCache.get(reservation.business_phone);
```

`businessCache` is already imported at line 17 — do not add a second import.

- [ ] **Step 3: Verify the handler now reads the business once**

Run: `cd server && sed -n '674,712p' routes/pages.js | grep -n "getBusiness\|businessCache"`
Expected: exactly one match, the `businessCache.get` line. `db.getBusiness` must not appear in this handler. (`resolveChatbot` at line 82 makes a second `businessCache.get` call for the same phone, which is now a cache hit rather than a read.)

- [ ] **Step 4: Run the suite**

Run: `cd server && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes/pages.js
git commit -m "perf(pages): read the business doc through business-cache

The handler fetched the business doc directly while resolveChatbot fetched
the same doc through the cache, costing two reads per request. Safe now
that dashboard writes invalidate."
```

---

### Task 5: Overlap the two independent reads

**Files:**
- Modify: `server/routes/pages.js:686-688`

**Interfaces:**
- Consumes: Tasks 1, 2 and 4.
- Produces: nothing new.

After Tasks 2 and 4, the business read and the page read both depend only on `reservation.business_phone` and not on each other, so they can run concurrently. There are currently zero uses of `Promise.all` in `server/`; this is the first.

- [ ] **Step 1: Combine the two awaits**

The handler currently has these two consecutive statements (with the `portfolio` line between them):

```js
      const business = await businessCache.get(reservation.business_phone);
      const portfolio = business?.portfolio;
      const page = await db.findPageBySlug(reservation.business_phone, propSlug);
```

Replace all three lines with:

```js
      // ponytail: both reads need only the phone from the reservation above,
      // and nothing between them — so they overlap instead of queueing.
      const [business, page] = await Promise.all([
        businessCache.get(reservation.business_phone),
        db.findPageBySlug(reservation.business_phone, propSlug),
      ]);
      const portfolio = business?.portfolio;
```

The `getPortfolioSlugReservation` call above stays sequential — it produces the phone. `resolveChatbot(page)` below stays sequential — it consumes `page`.

- [ ] **Step 2: Verify the ordering is still correct**

Run: `cd server && sed -n '674,714p' routes/pages.js`
Expected: `getPortfolioSlugReservation` and its two guard clauses come first; then the `Promise.all`; then the `if (!page)` and status guards; then `resolveChatbot`. Confirm `portfolio` is still defined before the `if (portfolio?.status === "open")` block near the end.

- [ ] **Step 3: Run the suite**

Run: `cd server && npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add server/routes/pages.js
git commit -m "perf(pages): overlap the business and page reads

Both depend only on the phone from the slug reservation, not on each
other, so they no longer queue behind one another."
```

---

### Task 6: Confirm whether a composite index is needed

**Files:**
- Modify (conditional): `firestore.indexes.json`

**Interfaces:**
- Consumes: the query shipped in Task 1.
- Produces: a deployed index, or a recorded finding that none is required.

Firestore can serve multiple equality filters by zigzag merge over automatic single-field indexes, so `where(business_phone ==).where(public_slug ==)` may need no composite index. **This is unverified and cannot be verified from the agent sandbox, which has no network route to Firestore.** It must be checked against a real instance.

- [ ] **Step 1: Exercise the query against real Firestore**

With `GOOGLE_APPLICATION_CREDENTIALS` set for the dev project, run the server (`cd server && npm run local`) and request a known property page, e.g.:

```bash
curl -s "http://127.0.0.1:8787/api/property-by-slug?portfolio_slug=krvytvrv-nksym&property_slug=<a-real-slug>" | head -5
```

Expected, if no index is needed: a JSON page payload.
Expected, if an index IS needed: HTTP 500, and the server log carries a Firestore `FAILED_PRECONDITION` error containing a `https://console.firebase.google.com/.../indexes?create_composite=...` link.

- [ ] **Step 2 (only if Step 1 raised FAILED_PRECONDITION): Add the index**

`firestore.indexes.json` currently declares one index, for `conversations`. Add a second entry to the `indexes` array:

```json
    {
      "collectionGroup": "property_pages",
      "queryScope": "COLLECTION",
      "fields": [
        {
          "fieldPath": "business_phone",
          "order": "ASCENDING"
        },
        {
          "fieldPath": "public_slug",
          "order": "ASCENDING"
        }
      ],
      "density": "SPARSE_ALL"
    }
```

Deploy it: `firebase deploy --only firestore:indexes`, then re-run Step 1 and confirm the page resolves.

- [ ] **Step 3: Record the outcome in the spec**

Edit `docs/superpowers/specs/2026-09-20-property-page-performance-design.md`, open question 2, replacing it with what Step 1 actually showed — either "confirmed: no composite index required" or "confirmed: composite index required, added and deployed".

- [ ] **Step 4: Commit**

```bash
git add firestore.indexes.json docs/superpowers/specs/2026-09-20-property-page-performance-design.md
git commit -m "chore(firestore): record index requirement for findPageBySlug"
```

(If no index was needed, only the spec file will be staged — that is expected.)

---

### Task 7: Verify the read count end to end

**Files:** none modified — this is a verification gate for Package A.

- [ ] **Step 1: Count reads on a cold cache**

With Firestore credentials set and the server running locally, restart it (to clear the in-process `business-cache`), then request one property page and count Firestore reads. The quickest instrument is a temporary counter — add this at the top of `server/db.js` `init()`, run the check, then **revert it before committing**:

```js
    const _origCollection = db.collection.bind(db);
    let _reads = 0;
    db.collection = (name) => {
      const ref = _origCollection(name);
      const _origGet = ref.get.bind(ref);
      ref.get = () => { _reads++; console.log(`FIRESTORE GET #${_reads} -> ${name}`); return _origGet(); };
      return ref;
    };
```

Expected on the first request: 3 gets — `portfolio_slugs`, `businesses`, `property_pages`.
Expected on a second request within 60s: 2 gets — the `businesses` read is served from cache.

- [ ] **Step 2: Confirm behavior is unchanged**

Check each of these against the dev server and confirm the response matches pre-change behavior:

- A valid portfolio + property slug returns the page payload.
- A renamed portfolio slug still returns `301` to `/<current_slug>/<propSlug>`.
- An unknown property slug returns `404 {"error":"not_found"}`.
- A page whose `status` is neither `active` nor `expiring` returns `404`.
- A page belonging to an agent whose portfolio is `open` includes `portfolio_url`; one whose portfolio is not open omits it.

- [ ] **Step 3: Confirm the portfolio toggle is not stale**

In the dashboard, toggle the portfolio status, then immediately reload a property page for that agent. The change must be reflected at once, not after 60s. (This is what Task 3 bought.)

- [ ] **Step 4: Revert the instrumentation**

Run: `cd server && git diff db.js`
Expected: empty. If the counter from Step 1 is still present, remove it.

---

## Package B — Frontend media and layout

Package B's sizing depends on a PageSpeed Insights run that is still outstanding, and on open question 3 in the spec (whether agent-uploaded video is transcoded anywhere today). Only Task 8 is concrete and unblocked. Do not invent the remaining B work before the PSI numbers land — re-open the spec instead.

### Withdrawn: lazy-loading and CLS work

An earlier draft of this plan carried a task to lazy-load gallery images and one
to add image dimensions for CLS. **Both were based on incorrect findings and have
been removed.** Do not reinstate them:

- Gallery images already carry `loading="lazy"` and `decoding="async"`
  (`runtime.js:387`, `original.js:66`). The only eager `createElement("img")` is
  the agent logo at `runtime.js:282`, which is above the fold and must stay
  eager.
- The missing `width`/`height` attributes are not a demonstrated CLS cost. Tile
  boxes are sized by CSS, not by the images: `.gallery-grid` uses
  `grid-auto-rows:115px` with explicit per-tile spans plus
  `.gallery-grid img{width:100%;height:100%;object-fit:cover}`, and
  `.room-image img` / `.area-image img` are pinned to `78vh`. If PSI reports a
  real CLS figure, revisit with that number in hand.

### Task 8: Stop preloading the full hero video on nocturne

**Files:**
- Modify: `public-nadlan/templates/nocturne.html:145`

Seven of eight templates autoplay a hero video. `nocturne.html:145` is the only one using `preload="auto"`, which tells the browser to fetch the whole file; the others use `metadata` or none.

- [ ] **Step 1: Read the element**

Run: `cd public-nadlan/templates && sed -n '145p' nocturne.html`
Expected: a `<video class="hero-video" data-video autoplay muted loop playsinline preload="auto" ...>` element.

- [ ] **Step 2: Downgrade the hint**

Change `preload="auto"` to `preload="metadata"` on that element only. Leave every other attribute alone — `autoplay muted loop playsinline` are what make the hero play inline on mobile.

- [ ] **Step 3: Verify autoplay still works**

Load a nocturne property page on a mobile viewport (DevTools device emulation) and confirm the hero video still autoplays. `autoplay` with `muted` overrides `preload="metadata"` in practice, but this must be confirmed visually, not assumed. If autoplay breaks, revert this task — a broken hero is worse than an eager fetch.

- [ ] **Step 4: Commit**

```bash
git add public-nadlan/templates/nocturne.html
git commit -m "perf(nocturne): preload hero video metadata instead of the file

The other templates already use metadata or none. Autoplay still triggers
the fetch when playback starts."
```

---

## Package C — Cheap wins

### Correction to the spec's framing

The spec lists "minify app JS/CSS" under cheap wins. **It is not cheap in this repo, and it should not be done as described.** There is no bundler and no build step; adding minification means adding a build pipeline, a build artifact directory, and a deploy step that can serve stale or unbuilt assets. The headroom is ~100KB of app JS (the 136KB of vendor code is already minified) and 12KB of CSS. Transport compression achieves most of the same byte reduction with a single middleware and no build step. Task 9 does that instead. Do not add a JS build step without re-opening the spec.

### Task 9: Enable response compression

**Files:**
- Modify: `server/index.js` (after line 134)
- Modify: `server/package.json` (`dependencies`)

`server/package.json` declares exactly two dependencies — `express` and `firebase-admin`. There is no compression middleware. **It is unverified whether nginx on the Hostinger VPS already compresses responses**; if it does, this task is redundant and should be skipped.

- [ ] **Step 1: Check whether responses are already compressed**

From a machine that can reach the dev host (the agent sandbox cannot — its network policy denies that host):

```bash
curl -sI -H 'Accept-Encoding: gzip, br' https://dev.srv1173890.hstgr.cloud/tpl/runtime.js | grep -i 'content-encoding\|content-length'
```

If a `Content-Encoding: gzip` or `br` header comes back, **stop — this task is done already.** Record that in the spec and move on. Only continue if no such header appears.

- [ ] **Step 2: Add the dependency**

Run: `cd server && npm install compression@^1.7.4`

- [ ] **Step 3: Mount the middleware**

In `server/index.js`, immediately after line 134 (`app.use(express.json({ limit: "2mb" }));`) and **before** the static handlers at 141-144, add:

```js
const compression = require("compression");
app.use(compression());
```

Move the `require` up to sit with the other requires at the top of the file if that matches the surrounding style — check the first 20 lines and follow whatever is there.

- [ ] **Step 4: Verify locally**

Run `cd server && npm run local`, then:

```bash
curl -sI -H 'Accept-Encoding: gzip' http://127.0.0.1:8787/tpl/runtime.js | grep -i 'content-encoding'
```

Expected: `Content-Encoding: gzip`

- [ ] **Step 5: Run the suite**

Run: `cd server && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add server/index.js server/package.json server/package-lock.json
git commit -m "perf(server): gzip responses

Text assets and API payloads were served uncompressed. Chosen over adding
a JS build step for minification: most of the byte saving, none of the
build-pipeline risk."
```

---

### Task 10: Asset caching for `/tpl` — investigate, do not change blind

**Files:** none yet — this task produces a decision, not a diff.

`server/index.js:138-140` deliberately sets `Cache-Control: no-cache` on every `.html`, `.js` and `.css` in `public-agent` and `public-nadlan`, with the comment *"App shell always revalidates; the ETag makes an unchanged file a 304."* `/tpl` (line 144) gets `express.static` defaults, which also revalidate.

So every property page load makes a conditional request for the document plus `demo.js`, `i18n.js`, `runtime.js`, `chat.js` and `chat.css` — roughly six round trips that return 304 rather than being served from cache. On a mobile connection with ~150ms RTT that is real latency.

**This is deliberate, documented behavior. Do not simply raise `max-age`** — agents would get stale templates after a deploy, which is a correctness regression, not a perf trade.

- [ ] **Step 1: Quantify the cost**

From the pending PageSpeed Insights run, or a DevTools Network capture of a real property page, record: how many requests return 304, and their combined wall-clock contribution on the mobile profile.

- [ ] **Step 2: Decide with the numbers in hand**

If the 304 chain is a material share of load time, the fix is content-hashed or version-stamped asset URLs (e.g. `/tpl/runtime.js?v=<build-sha>`) plus a long `max-age` — which requires a version token available at render time. That is a design change, so write it into the spec and get it approved before implementing. If the cost is marginal, record that and close this task with no change.

- [ ] **Step 3: Record the outcome in the spec**

Add the measurement and the decision to `docs/superpowers/specs/2026-09-20-property-page-performance-design.md` under open questions, then commit the spec edit.

---

## Verification checklist

Package A is complete when all of these hold:

- [ ] `cd server && npm test` passes, including `db.test.js OK`.
- [ ] One uncached property page request costs 3 Firestore reads; a second within 60s costs 2 (Task 7).
- [ ] All five behavior cases in Task 7 Step 2 match pre-change behavior.
- [ ] A portfolio toggle appears on property pages immediately (Task 7 Step 3).
- [ ] A property beyond the old 100-page window resolves instead of 404ing.
- [ ] No instrumentation code remains in `server/db.js`.
