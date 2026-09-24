# Driver-Backed Listing Import & Group Posting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent paste a Yad2, Madlan, or social-media listing URL and have Forly fill the create-wizard fields from it, using a hosted real-Chrome session (driver.dev) where Firecrawl cannot reach; connect their own social accounts through a browser embedded in the Forly dashboard; and then post each property to their chosen Facebook groups on a paced schedule — from a background browser they never see — under either per-post approval or a standing permission they can revoke with one tap.

**Architecture:** Import (Phase 1–2) adds three server modules: `driver-browser.js` (Driver API client, always stops in a `finally`), `listing-driver.js` (page → the exact result shape `listing-sources.js` already produces for Firecrawl, so `listing-extract.js` is untouched), and `extract-jobs.js` (queued-job state machine + sweeper, mirroring `distribution/jobs.js`). Posting (Phase 3) adds four more: `posting-safety.js` (pure pacing + signal classification — the anti-ban core, and the most-tested file in the plan), `posting-campaign.js` (campaign state machine + sweeper, one serial browser per agent), `posting-driver.js` (the browser actions, with a dry-run mode that stops before submit), and `routes/posting.js`. Copy variation and tracked URLs are reused from `distribution/share-kit.js`, group selection from `property_groups`, and the catalog's `agent_policy` field becomes a hard gate.

**A decision this plan reverses, on purpose:** `distribution/share-kit.js` records that browser automation to groups "was rejected as a ban risk (spec §1)" in favour of a WhatsApp share kit. The product owner has asked for automated posting anyway. Phase 3 therefore treats "the agent's account must never get blocked or look suspicious" as a first-class requirement with its own module, its own tests, a calibration task, and a kill switch — not a caveat.

## Review outcomes (2026-09-24)

Four independent reviews ran on the first complete draft: engineering correctness, blind spots, account-safety + application security, and UX. Every finding was checked against the repository before being accepted. What changed, in one place, so a reader of an earlier draft knows what moved:

**Premise corrected.** The first draft reasoned about Cloud Run with many instances. `.github/workflows/deploy-server.yml` runs **one Docker container on a VPS** (`docker run … --restart unless-stopped`), and `distribution/jobs.js` says so. Every sweeper therefore uses an in-process latch (the `sweeping` pattern already in `jobs.js`) and one in-process Driver semaphore; Firestore holds state so it survives restarts, not to coordinate instances. Stale-state reapers replace distributed locks.

**Blockers fixed in place** (Tasks 4, 6, 10, 13–16): the routing change broke three pre-existing `listing-sources` assertions; the extract-route test used top-level `await` in CommonJS and injected a `resolve` the route never read; the Firecrawl→Driver fallback fired on *any* error (including "no Firecrawl key"), which would send every URL to a paid browser; the posting-driver test matched selector strings by the words "submit"/"composer"; campaigns built `page_url` from a field page docs don't have (they'd crash on every tick); `liveDeps` called `sendWhatsApp` without the Green API credentials it requires (per-post approvals would silently never send); the catalog lookup used a vocabulary (`allowed`/`forbidden`) the seed doesn't have (`explicitly_allowed`/`unknown`) and a function (`mergedCatalog`) that isn't exported; `finish` tried to delete a nested key through a merge-write, which can't; the demo wizard got a 202 it could never poll; `codeFor()` leaked Driver's vendor codes into `error_code`; the `profileFor` regex wasn't left-anchored (`netflix.com` matched `x.com`) *and* attached the customer's logged-in profile on the fallback path.

**Safety design changed** (Tasks 13–15, 19): checkpoint or CAPTCHA now **disables** automation for that account until a Forly operator re-enables it — not a 48h pause; a second halt of any kind in 30 days does the same. Caps roughly halved, gaps doubled, warm-up starts at one post a day for a week and asks two questions about the account first. The schedule is no longer periodic (random daily start, random daily target, one active day in five skipped). Typing cadence is drawn from a distribution with word-boundary pauses; every session dwells on the feed before opening a group. The tracked link moves to the first comment (`share-kit.linkInComment`, which the existing code already offers for exactly this reason) and its group parameter becomes an opaque hash — fixing, in passing, a real bug where `routes/pages.js` truncates `group_token` to 24 characters, which is exactly the length of `https://www.facebook.com`. Signal matching is scoped to dialogs and alerts, never the feed. `pending_approval` (admin-moderated groups, which [Inference] most Israeli real-estate groups are) is a recognised outcome, not a failure.

**Added** (new Tasks 16b, 10b, 14b; Task 1 and 18 rewritten): a global kill switch (`settings/posting.enabled` + `POSTING_ENABLED`), a fleet breaker that flips it when three accounts halt in 24h, and an admin overview; persisted consent (`{consent_at, text_version}`) on both the connection and the campaign, a `DELETE` disconnect route that stops campaigns and deletes the Driver profile, and retention rules; WhatsApp one-tap approve / skip / stop using the existing `signActionToken` + `confirmOffer` pattern, with a WhatsApp line on every state change; the campaign card moves to `publish.html`, where the property and its groups already are; Task 1 now measures egress ASN and per-profile IP stickiness; Task 18 is a 30-day run on an aged test account in real groups with admin permission, not 48 hours on a throwaway.

**Removed as YAGNI** (critic §26): the `awaiting_approval` state and `/approve` route (consent *is* the approval; a campaign is created running), the `explicit` flag (every group in a campaign is explicit by construction), `acknowledgeHalt` as a separate verb (one `paused` state with a `reason`, one `resume`), the browser-type escalation ladder for posting (one rung; the profile's cookies are the point), the `max_posts` bound (the number of groups is the bound the agent actually thinks in), and the five-platform dropdown (Facebook only until a feature needs another).

**Pushed back on:** per-customer landing hostnames (safety A3) — right in principle, an infrastructure project of its own; noted under Deferred with the global per-group cap and the domain-level daily cap as the mitigations that ship. "Browse-only" warm-up sessions for a week (safety A6) — adopted as a *single* browse-only first session after connect (so the "new device" event is not a post), not seven days of paid sessions that post nothing. Jewish holidays (safety A13) — adopted as a ten-line static table, since the cost is nil.

**Tech Stack:** Node >= 20 CommonJS, Express 4, Firebase Admin (Firestore), `patchright` (Playwright-compatible, connect-only), vanilla browser JS in `public-agent/`, plain `node x.test.js` assertion scripts.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node >= 20** (`.nvmrc` is `22`). `server/` is CommonJS — `require`, `module.exports`, no TypeScript.
- **`patchright` only.** Never `playwright` or `puppeteer`. Never `chromium.launch()`, `launchPersistentContext()`, or `playwright install`. The only browser entry point is `chromium.connectOverCDP(cdpUrl)`.
- **Reuse the browser's first context and tab:** `browser.contexts()[0] ?? await browser.newContext()`, `context.pages()[0] ?? await context.newPage()`. Extra contexts look like automation.
- **No broad CDP hooks:** no `page.route`, `context.route`, `page.on('request')`, `page.exposeFunction`, `page.addInitScript`, `context.addInitScript`. No fingerprint patching (`navigator`, user agent, WebGL, canvas, timezone, locale) — set `country` / `timezone` / `language` on the create call instead.
- **Always stop the session** with `DELETE /v1/browser/session?sessionId=<id>` in a `finally`. `browser.close()` only disconnects; the session keeps running and holds a concurrency slot until `duration` expires.
- **Driver error policy, exactly:** `402` and `403` → report, never loop. `503` → back off from `Retry-After` with jitter, capped at 5 attempts, then report. `504` and `500` → retry once. `429` → back off, capped at 3 attempts.
- **Single-container deployment.** `deploy-server.yml` runs one Docker container on a VPS. Sweepers use an in-process `sweeping` latch (copy `distribution/jobs.js:651-665`) and one in-process Driver semaphore shared by extract, connect and posting. Firestore holds job and campaign state so a restart loses nothing; every sweeper reaps `running`/`posting` records older than their maximum lifetime at boot and on each pass. A second container is a documented non-goal.
- **`DRIVER_API_KEY` comes from `process.env`** and is never committed, never logged, never returned in an API response. **It is a master key**: with it alone, anyone can open any customer's persisted profile. One key per environment (prod / staging / local), never shared; docs say `export DRIVER_API_KEY=…` once from a secret store, never inline on a command line. Profile names are `facebook-<env>-<hmac_sha256(phone, PROFILE_KEY).slice(0,20)>`, so the key cannot enumerate customers by phone. Driver session `note`s carry ids, never a phone.
- **A redacting logger.** `driver-browser.js` exports `redact(msg)` (`/wss?:\/\/\S+/g` and `/ws=\S+/g` → `[cdp]`) and every `console.error` in the new sweepers and routes goes through it; a unit test stubs `console` and asserts nothing logged contains `wss://`, `ws=`, or the fake key.
- **Never log a `cdpUrl` or a live-view URL.** Anyone holding one can drive that browser. They go only to the authenticated owner of the session.
- **Base URL** is `https://api.driver.dev`. Ids go in the query string, not the path: `GET|DELETE /v1/browser/session?sessionId=<id>`. Pool ids are the exception (path), and **no pool is created by this plan.**
- **Tests** are plain assertion scripts run as `node <file>.test.js`, using `require("assert")` and injected fakes — no test framework, no network in unit tests. Every new test file must be appended to the `scripts.test` chain in `server/package.json`.
- **Keep files under 500 lines** (CLAUDE.md). Split before exceeding.
- **Commit messages carry no `Co-Authored-By` trailer** — `.claude/settings.json` has no `attribution.commit` key, and CLAUDE.md forbids it in that case.
- **Branch:** all work lands on `claude/zen-davinci-lu4hoq`.
- **Posting is background-only.** A posting session never surfaces a `view_url`; the agent sees a timeline, not a browser. The embedded browser (Task 11) is the escape hatch when Facebook demands a human (checkpoint, identity check), and only then.
- **One browser per profile at a time — across extract, connect and posting.** An in-process per-phone mutex (`profile-lock.js`, Task 5) is acquired by every code path that opens a persisted profile: a Facebook-group extract, the login browser, a post. Two sessions on one profile from two IPs is the hijack pattern; it must be impossible, not unlikely.
- **Every pacing number is a tunable, conservative default marked [Unverified].** None was measured against Facebook; Task 18 measures over 30 days on an aged account. A number is never hard-coded in a call site — it comes from `posting-safety.DEFAULTS` and can be overridden per account.
- **Groups are canonicalised and looked up in the merged catalog.** The catalog vocabulary is `explicitly_allowed` / `unknown` (there is no `forbidden`; the operator removes such groups). A URL not in the catalog needs the agent's explicit opt-in on the request. This is a gate in code, not a UI hint.
- **Checkpoint or CAPTCHA disables automation for that account until a Forly operator re-enables it.** Not a cooldown — a stop. A second halt of any kind within 30 days does the same. `rate_limited` and `feature_blocked` pause the account for 14 days with caps halved and warm-up restarted. Only `login_required` (a benign cookie expiry) clears with the agent reconnecting.
- **A global kill switch exists and is checked on every sweep**: `settings/posting.enabled` in Firestore AND `POSTING_ENABLED` in env. Either off → no post starts. A fleet breaker flips the Firestore flag off when three accounts halt within 24 hours and messages the operator.
- **Consent is recorded, not just ticked.** `POST /connections/browser/start` and `POST /posting/campaigns` require `consent: true` and persist `{consent_at, consent_text_version}`; either without it is a 400. There is a `DELETE` that disconnects, stops campaigns, and deletes the Driver profile.
- **Never identical copy twice, and the link is not in the body.** Every post goes through `share-kit.buildPostCopy` with a `variantSeed` of `page_id + group_url` and `linkInComment: true`; the tracked URL is posted as the first comment, with an opaque 12-character group token. Copy is generated at *scheduling* time from the page as it is then, never frozen at campaign creation.
- **Hebrew user-facing copy only.** Vendor error text (Driver's, Facebook's) never reaches the agent — map to a stable `code` and a Hebrew string in `public-agent/form-i18n.js`, the pattern `distribution/jobs.js` already follows.

---

## Routing Rules (the amended spec, verbatim)

```
input is text                         → "text"       (unchanged, synchronous)
facebook.com page post (/posts/, /videos/, story_fbid, fbid)
                                      → "facebook"   (unchanged Graph API, synchronous)
DRIVER_HOSTS (social + yad2 + madlan) → "driver"     (async job)
anything else                         → "scrape"     (Firecrawl, synchronous)
                                        └─ on ANY Firecrawl error → "driver" (async job)
```

`DRIVER_HOSTS` = `yad2.co.il`, `madlan.co.il`, `facebook.com` (group/profile URLs that are not page posts), `instagram.com`, `tiktok.com`, `linkedin.com`, `x.com`, `twitter.com` — matched on registrable domain with an optional subdomain, never a substring.

A Facebook **page post** keeps the existing Graph path because it is faster, free, and already works. A Facebook **group** URL has no Graph equivalent and needs a logged-in browser.

## File Structure

**Server — new**

| File | Responsibility |
|---|---|
| `server/driver-browser.js` | Driver REST client + `withPage(opts, fn)`. Session lifecycle, error policy, orphan cleanup. Knows nothing about listings. |
| `server/driver-browser.test.js` | Error policy, stop-in-finally, orphan matching. Fake `fetch`, fake `connectOverCDP`. |
| `server/listing-driver.js` | Page → `{source:"driver", text, description, photos}`. Login-wall detection. Knows nothing about HTTP or jobs. |
| `server/listing-driver.test.js` | Shape parity with `fromFirecrawl`, login-wall codes. Fake `page`. |
| `server/extract-jobs.js` | Job state machine + sweeper. `queued → running → done \| failed`. Deps-injected. |
| `server/extract-jobs.test.js` | Transitions, attempt cap, browser-type escalation, concurrency cap. |
| `server/routes/connections-browser.js` | `start` / `status` / `finish` for the embedded login browser. |
| `server/routes/connections-browser.test.js` | Ownership, no-cdpUrl-leak, finish verification. |
| `scripts/driver-extract.local.js` | Live verification against a real Yad2 URL. Not in the test chain. |

**Server — new (Phase 3)**

| File | Responsibility |
|---|---|
| `server/profile-lock.js` | In-process per-phone mutex + Driver semaphore shared by extract, connect and posting. |
| `server/posting-safety.js` | Pure functions: `nextSlot()` (may this account post now, and where), `classifySignal()` (scoped to dialogs/alerts), `DEFAULTS`, holidays. No I/O. |
| `server/posting-safety.test.js` | Pacing invariants, warm-up ramp, cooldowns, active hours incl. Shabbat, signal classification. |
| `server/posting-campaign.js` | Campaign state machine + sweeper. `running → paused(reason) \| stopped \| completed`. Account-level `disabled`/`penalty` on the connection doc. Kill switch + fleet breaker in `sweep`. |
| `server/posting-campaign.test.js` | Transitions, approval modes, standing-permission expiry, breaker, serial guarantee, idempotent post ids. |
| `server/posting-driver.js` | Browser actions: open group, compose, paste, submit, verify the post landed. `dryRun` stops before submit. |
| `server/posting-driver.test.js` | Fake page: happy path, dry run never submits, verification failure is a failure, signals bubble up as codes. |
| `server/routes/posting.js` | Create campaign (consent required, canonicalised group gate), pause, resume, stop, timeline; `GET /act` for signed WhatsApp one-tap approve / skip / stop. |
| `server/routes/posting.test.js` | Ownership, `agent_policy` gate, standing permission bounds, revoke is immediate. |
| `server/routes/admin-posting.js` | Operator overview, kill switch, per-account re-enable. |
| `scripts/posting-calibrate.local.js` | Dry run, then ONE real post; then the 30-day observation checklist. |

**Server — modified**

| File | Change |
|---|---|
| `server/listing-sources.js` | `sourceFor()` gains the `driver` branch; `listingImages` / `IMAGE_EXT` / `NOT_LISTING` exported for reuse; `resolve()` routes `driver`. |
| `server/listing-sources.test.js` | Routing assertions for the new hosts. |
| `server/db.js` | `saveExtractJob` / `getExtractJob` / `updateExtractJob` / `listExtractJobsByStatus`, and browser-connection fields on the existing connection doc. |
| `server/routes/extract.js` | 202 + job id, `GET /properties/extract/:job_id`, Firecrawl→Driver fallback, separate driver daily cap. |
| `server/routes/extract.test.js` | New routing, 202 shape, poll ownership, fallback. |
| `server/index.js` | Mount `connections-browser`, start the sweeper, run boot orphan cleanup. |
| `server/package.json` | `patchright` dependency; new test files in the chain. |
| `server/Dockerfile` | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. |
| `server/db.js` (Phase 3) | `savePostingCampaign` / `getPostingCampaign` / `updatePostingCampaign` / `listPostingCampaignsByStatus` / `listPostingCampaignsByPhone`. |
| `server/index.js` (Phase 3) | Mount `routes/posting.js`, start the posting sweeper. |

**Front-end — modified**

| File | Change |
|---|---|
| `public-agent/extract.js` | `pollJob()` helper + new error keys. |
| `public-agent/extract.test.js` | Poll helper tests. |
| `public-agent/create.html` | Handle 202 → poll → same fill path. |
| `public-agent/form-i18n.js` | New Hebrew strings. |
| `public-agent/distribution.html` | Embedded-browser connect card + modal (Facebook only). Inline Hebrew; the page loads only `distribution.js`. |
| `public-agent/distribution.js` | Modal wiring, status polling, disconnect. |
| `public-agent/app.css` | Modal styles. |
| `public-agent/publish.html` (Phase 3) | Campaign card under "שיתוף ידני בקבוצות": computed plan, mode, consent, timeline, STOP. Inline Hebrew + the page's local `toast()` — `publish.html` does not load `form-i18n.js`. |
| `public-agent/publish.js` (Phase 3) | Campaign wiring, timeline polling, halt banner → embedded browser. |

---

## Phases

- **Tasks 1–9 — Phase 1.** Driver scraping for Yad2/Madlan + Firecrawl fallback. Ships and is useful on its own.
- **Tasks 10–12 — Phase 2.** Embedded browser connect + social/Facebook-group scraping. Depends on Task 2.
- **Tasks 13–20 — Phase 3.** Paced background posting to groups under agent approval. Depends on Tasks 2, 10, 11 (a connected profile) and on Task 12's answer: `no` → Phase 3 cannot start; `partial` → per-post mode only, with a login pre-flight before each post; `yes` → both modes.

## Human gates

A coding agent cannot complete these; each stops and hands off, and says what artefact it needs back. Faking the findings file is the failure mode to avoid.

| Gate | Task | Needs a person for | Artefact |
|---|---|---|---|
| G1 | 1 | `DRIVER_API_KEY` in the environment; reading Driver's billing page | `2026-09-22-driver-spike-findings.md` with `VIEWER_EMBEDDABLE`, `EGRESS_ASN`, `IP_STICKY_PER_PROFILE` |
| G2 | 9 | Checking parsed fields *by eye* against a live Yad2/Madlan page | Console output pasted into the findings file |
| G3 | 11 | Typing a **test** account's password and 2FA code into the embedded browser | "connected" chip observed; screenshot |
| G4 | 12 | Waiting 24h between two runs | `PROFILE_COOKIES_PERSIST` recorded |
| G5 | 18 | An **aged** test Facebook account (older than 6 months, with prior manual posting history), 2–3 real public groups whose admins have agreed in writing, and 30 calendar days of daily `facebook.com/accountquality` checks | The calibration table in the findings file, dated daily |

Who owns the test account and the group admins' permission is decided before Task 10 starts; the plan does not assume they exist.

---

### Task 1: Verification spike — Driver reachability, patchright install, viewer framing

No production code. This task answers three questions the rest of the plan branches on. **Do not skip it**; Task 11 has two mutually exclusive implementations and this task picks one.

**Files:**
- Create: `docs/superpowers/plans/2026-09-22-driver-spike-findings.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a findings document containing the literal line `VIEWER_EMBEDDABLE=yes` or `VIEWER_EMBEDDABLE=no`, read by Task 11.

- [ ] **Step 1: Confirm the API key is present and the account is reachable**

```bash
test -n "$DRIVER_API_KEY" || { echo "set DRIVER_API_KEY first"; exit 1; }
curl -sS https://api.driver.dev/v1/account/billing \
  -H "Authorization: Bearer $DRIVER_API_KEY" | tee /tmp/billing.json
```

Record `plan.concurrent_browsers` from the output. This is the hard ceiling for `DRIVER_MAX_CONCURRENT` in Task 5.

- [ ] **Step 2: Install patchright and confirm it needs no browser download**

```bash
cd server && npm install patchright --save
ls node_modules/patchright/package.json && echo "installed"
```

Expected: install completes without downloading a Chromium binary. If it tries to download, set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in the environment and reinstall — we only ever connect over CDP.

- [ ] **Step 3: Create one session, read the viewer's framing headers, stop it**

```bash
# The response carries a cdpUrl: keep it in a shell variable, never in a file.
SID=$(curl -sS -X POST https://api.driver.dev/v1/browser/session \
  -H "Authorization: Bearer $DRIVER_API_KEY" -H "Content-Type: application/json" \
  -d '{"country":"IL","duration":180,"note":"forly-spike"}' | \
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).sessionId)')
echo "sessionId=$SID"
curl -sSI "https://viewer.driver.dev/" | grep -iE "x-frame-options|content-security-policy|referrer-policy"
curl -sS -X DELETE "https://api.driver.dev/v1/browser/session?sessionId=$SID" \
  -H "Authorization: Bearer $DRIVER_API_KEY"
curl -sS "https://api.driver.dev/v1/browser/session?sessionId=$SID" \
  -H "Authorization: Bearer $DRIVER_API_KEY"
```

Expected: the final GET shows `"status":"completed"` with a `stoppedAt`.

- [ ] **Step 3b: Measure what the posting design depends on — egress ASN and IP stickiness**

Two sessions on one persisted profile, each reading its own public IP. Whether the IP is the same, and whether it is a datacenter or residential ASN, decides how the posting flow behaves ([Inference] a login from one IP followed by posts from a different datacenter IP each time is itself a signal).

```bash
cd server && node -e '
const D = require("./driver-browser");
(async () => {
  const ips = [];
  for (let i = 0; i < 2; i++) {
    ips.push(await D.withPage({ country: "IL", duration: 120, profile: { name: "forly-spike-profile", persist: true }, note: "forly-spike" },
      async (page) => { await page.goto("https://ipinfo.io/json"); return JSON.parse(await page.innerText("body")); }));
  }
  console.log(JSON.stringify(ips.map((x) => ({ ip: x.ip, org: x.org, city: x.city })), null, 2));
})();'
```

Record `EGRESS_ASN=<org string>` and `IP_STICKY_PER_PROFILE=<yes|no>`. If the ASN is a hosting provider, note it: Task 15 then uses `type: "hosted_privacy"` for posting sessions, and Task 18's first question to Driver is whether a profile can be pinned to a dedicated IP (`proxyUrl: "dedicated://…"` exists on the create call).

- [ ] **Step 4: Decide embeddability and write the findings file**

Decision rule, applied to the headers from Step 3:
- No `X-Frame-Options` **and** either no `frame-ancestors` or one that permits the Forly origin → `VIEWER_EMBEDDABLE=yes`.
- `X-Frame-Options: DENY`/`SAMEORIGIN`, or a `frame-ancestors` that excludes the Forly origin → `VIEWER_EMBEDDABLE=no`.

If the answer is `no`, do **not** attempt to proxy or strip the header — that defeats a deliberate security control and breaks the viewer's websocket. Task 11 Branch B (popup window) is the supported path.

```bash
cat > docs/superpowers/plans/2026-09-22-driver-spike-findings.md <<'EOF'
# Driver spike findings (2026-09-22)

VIEWER_EMBEDDABLE=<yes|no>
EGRESS_ASN=<org string from ipinfo>
IP_STICKY_PER_PROFILE=<yes|no>

- plan.concurrent_browsers: <n>
- viewer response headers (incl. referrer-policy): <paste the grep output>
- patchright install downloaded a browser: <yes|no>
- Driver supports a per-profile dedicated IP: <yes|no|asked, awaiting answer>
EOF
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-09-22-driver-spike-findings.md server/package.json server/package-lock.json
git commit -m "chore(driver): add patchright dependency and record spike findings"
```

---

### Task 2: `driver-browser.js` — the Driver client

**Files:**
- Create: `server/driver-browser.js`
- Create: `server/driver-browser.test.js`
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Consumes: `patchright` (`chromium.connectOverCDP`), `process.env.DRIVER_API_KEY`.
- Produces:
  - `DriverError` — `class DriverError extends Error { status: number, code?: string, retryAfter?: number }`
  - `createSession(opts, deps?) -> Promise<Session>` where `Session = { sessionId, status, cdpUrl, note, stoppedAt, bandwidthBytes? }`
  - `getSession(id, deps?) -> Promise<Session>`
  - `stopSession(id, deps?) -> Promise<void>` (never throws)
  - `listSessions(status, deps?) -> Promise<{ sessions: Session[] }>`
  - `cleanupOrphans(notePrefix, deps?) -> Promise<number>` (count stopped)
  - `withPage(opts, fn, deps?) -> Promise<T>`, `fn(page, session)`
  - `_test = { backoffMs }`

- [ ] **Step 1: Write the failing test**

Create `server/driver-browser.test.js`:

```js
/* driver-browser.js — session lifecycle and the error policy. No network:
   fetch and connectOverCDP are stubbed. */
const assert = require("assert");
const D = require("./driver-browser");

const ok = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => null } });
const err = (status, body, retryAfter) => ({
  ok: false, status, statusText: "e", json: async () => body || {},
  headers: { get: (h) => (h.toLowerCase() === "retry-after" && retryAfter ? String(retryAfter) : null) },
});

(async () => {
  // ── 402 and 403 are reported immediately, never retried ──
  for (const status of [402, 403]) {
    let calls = 0;
    const fetchFn = async () => { calls++; return err(status, { error: "nope", code: "x" }); };
    await assert.rejects(
      D.createSession({}, { fetchFn, apiKey: "k", sleep: async () => {} }),
      (e) => e instanceof D.DriverError && e.status === status,
    );
    assert.equal(calls, 1, `${status} must not loop`);
  }

  // ── 503 backs off, capped at 5 attempts, then reports ──
  let calls503 = 0; const slept = [];
  const fetch503 = async () => { calls503++; return err(503, { code: "browser_capacity_unavailable" }, 2); };
  await assert.rejects(
    D.createSession({}, { fetchFn: fetch503, apiKey: "k", sleep: async (ms) => slept.push(ms), random: () => 0 }),
    (e) => e.status === 503,
  );
  assert.equal(calls503, 6, "1 initial + 5 retries");
  assert.deepEqual(slept, [2000, 4000, 6000, 8000, 10000]);

  // ── 504 and 500 retry exactly once, then succeed ──
  for (const status of [504, 500]) {
    let n = 0;
    const fetchFn = async () => (++n === 1 ? err(status, {}) : ok({ sessionId: "s1", status: "active", cdpUrl: "ws://x" }));
    const s = await D.createSession({}, { fetchFn, apiKey: "k", sleep: async () => {} });
    assert.equal(s.sessionId, "s1");
    assert.equal(n, 2);
  }

  // ── stopSession never throws, so a finally cannot mask the real error ──
  await D.stopSession("s1", { fetchFn: async () => err(500, {}), apiKey: "k", sleep: async () => {} });

  // ── withPage stops the session even when fn throws ──
  const stopped = [];
  const deps = {
    apiKey: "k", sleep: async () => {}, random: () => 0,
    fetchFn: async (url, init) => {
      if ((init && init.method) === "DELETE") { stopped.push(url); return ok({ success: true }); }
      if ((init && init.method) === "POST") return ok({ sessionId: "s2", status: "active", cdpUrl: "ws://y" });
      return ok({ sessionId: "s2", status: "completed", cdpUrl: null, bandwidthBytes: 10 });
    },
    connectOverCDP: async () => ({
      contexts: () => [{ pages: () => [{ marker: "page" }] }],
      close: async () => {},
    }),
  };
  await assert.rejects(D.withPage({}, async () => { throw new Error("boom"); }, deps), /boom/);
  assert.equal(stopped.length, 1);
  assert.ok(stopped[0].includes("sessionId=s2"));

  // ── withPage reuses the first context and page, and returns fn's value ──
  const got = await D.withPage({}, async (page) => page.marker, deps);
  assert.equal(got, "page");

  // ── cleanupOrphans stops only our own notes ──
  const deleted = [];
  const cleanupDeps = {
    apiKey: "k", sleep: async () => {},
    fetchFn: async (url, init) => {
      if ((init && init.method) === "DELETE") { deleted.push(url); return ok({ success: true }); }
      if (url.includes("status=active")) return ok({ sessions: [{ sessionId: "a", note: "forly-extract:1" }, { sessionId: "b", note: "someone-else" }] });
      return ok({ sessions: [{ sessionId: "c", note: "forly-extract:2" }] });
    },
  };
  assert.equal(await D.cleanupOrphans("forly-extract:", cleanupDeps), 2);
  assert.ok(deleted.some((u) => u.includes("sessionId=a")));
  assert.ok(deleted.some((u) => u.includes("sessionId=c")));
  assert.ok(!deleted.some((u) => u.includes("sessionId=b")));

  console.log("driver-browser.test.js ok");
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node driver-browser.test.js`
Expected: FAIL with `Cannot find module './driver-browser'`

- [ ] **Step 3: Write minimal implementation**

Create `server/driver-browser.js`:

```js
/*
 * driver-browser.js — hosted real-Chrome sessions from driver.dev.
 *
 * Three calls: POST to create, connectOverCDP to use, DELETE to stop. The
 * DELETE is not optional — browser.close() only drops our websocket, and an
 * unstopped session holds a concurrency slot until its `duration` runs out.
 *
 * Retry policy is deliberately asymmetric (docs.driver.dev/docs/sessions/errors):
 * 402 (no credits) and 403 (over the plan limit) are conditions a PERSON has to
 * fix, so looping only burns time; 503 is capacity, which time does fix.
 *
 * Every function takes `deps` so the tests drive the whole lifecycle with fakes.
 */
const API = "https://api.driver.dev";

class DriverError extends Error {
  constructor(status, message, code, retryAfter) {
    super(`Driver ${status}: ${message}`);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (base, attempt, rnd) => base * 1000 * attempt + rnd * 1000;

async function call(method, path, body, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const apiKey = deps.apiKey || process.env.DRIVER_API_KEY;
  if (!apiKey) throw new DriverError(401, "DRIVER_API_KEY is not set");
  const res = await fetchFn(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const ra = Number(res.headers.get("retry-after")) || undefined;
    throw new DriverError(res.status, e.error || res.statusText, e.code, ra);
  }
  return res.json();
}

async function createSession(opts = {}, deps = {}) {
  const sleep = deps.sleep || sleepReal;
  const random = deps.random || Math.random;
  let attempt = 0;
  for (;;) {
    try {
      return await call("POST", "/v1/browser/session", opts, deps);
    } catch (e) {
      if (!(e instanceof DriverError)) throw e;
      attempt++;
      if (e.status === 503 && attempt <= 5) { await sleep(backoffMs(e.retryAfter || 2, attempt, random())); continue; }
      if ((e.status === 504 || e.status === 500) && attempt <= 1) continue;
      if (e.status === 429 && attempt <= 3) { await sleep(backoffMs(2, attempt, random())); continue; }
      throw e; // 400, 401, 402, 403, or out of attempts: a person has to act
    }
  }
}

const getSession = (id, deps) => call("GET", `/v1/browser/session?sessionId=${encodeURIComponent(id)}`, null, deps);
const listSessions = (status, deps) => call("GET", `/v1/browser/sessions?pageSize=50${status ? `&status=${status}` : ""}`, null, deps);

// Idempotent, and never throws: called from a finally, where replacing the
// error already in flight would hide what actually went wrong.
async function stopSession(id, deps = {}) {
  try {
    const r = await call("DELETE", `/v1/browser/session?sessionId=${encodeURIComponent(id)}`, null, deps);
    if (!r || r.success !== true) console.error(`driver: stop of ${id} did not succeed`);
  } catch (e) {
    console.error(`driver: stop of ${id} failed: ${e.message}`);
  }
}

// A crash before the finally leaves a session running until its duration. Every
// session we create carries a note; at boot we stop the ones that are ours.
async function cleanupOrphans(notePrefix, deps = {}) {
  let stopped = 0;
  for (const status of ["active", "starting"]) {
    const r = await listSessions(status, deps).catch(() => ({ sessions: [] }));
    for (const s of (r && r.sessions) || []) {
      if (!String(s.note || "").startsWith(notePrefix)) continue;
      await stopSession(s.sessionId, deps);
      stopped++;
    }
  }
  return stopped;
}

async function waitForActive(session, deps = {}) {
  const sleep = deps.sleep || sleepReal;
  const deadline = Date.now() + (deps.timeoutMs || 60000);
  let s = session;
  while (!(s.status === "active" && s.cdpUrl)) {
    if (s.status === "completed" || s.status === "error") throw new DriverError(500, `session ended: ${s.status}`);
    if (Date.now() > deadline) throw new DriverError(504, "timed out waiting for the browser");
    await sleep(1000);
    s = await getSession(s.sessionId, deps);
  }
  return s;
}

/*
 * The only way this module hands out a page. Reuses the browser's own context
 * and tab (a fresh context is itself an automation signal) and guarantees the
 * DELETE, whatever fn does.
 */
async function withPage(opts, fn, deps = {}) {
  const session = await createSession(opts, deps);
  try {
    const active = await waitForActive(session, deps);
    const connect = deps.connectOverCDP || require("patchright").chromium.connectOverCDP;
    const browser = await connect(active.cdpUrl);
    try {
      const context = browser.contexts()[0] || (await browser.newContext());
      const page = context.pages()[0] || (await context.newPage());
      return await fn(page, active);
    } finally {
      await browser.close(); // our connection only; the session is still up
    }
  } finally {
    await stopSession(session.sessionId, deps);
  }
}

module.exports = {
  DriverError, createSession, getSession, listSessions, stopSession,
  cleanupOrphans, waitForActive, withPage, _test: { backoffMs },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node driver-browser.test.js`
Expected: PASS, printing `driver-browser.test.js ok`

- [ ] **Step 5: Add to the test chain**

In `server/package.json`, append ` && node driver-browser.test.js` to the end of the `scripts.test` string.

Run: `cd server && npm test`
Expected: the whole chain passes.

- [ ] **Step 6: Commit**

```bash
git add server/driver-browser.js server/driver-browser.test.js server/package.json
git commit -m "feat(driver): add hosted-browser session client with stop-in-finally"
```

---

### Task 3: `listing-driver.js` — a rendered page becomes listing text and photos

**Files:**
- Create: `server/listing-driver.js`
- Create: `server/listing-driver.test.js`
- Modify: `server/listing-sources.js` (export the image filters for reuse)
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Consumes: `driver-browser.withPage`, and from `listing-sources`: `_test.listingImages`, plus new exports `IMAGE_EXT`, `NOT_LISTING`, `MAX_PHOTOS`.
- Produces:
  - `fromDriver({ url, profileName, browserType }, deps?) -> Promise<{ source:"driver", text, description, photos }>` where `photos` is `Array<{url: string, source: "driver"}>` — **the same shape `fromFirecrawl` returns**, so `resolve()` callers need no change.
  - `_test = { pickImages, isLoginWall, readPage }`

- [ ] **Step 1: Write the failing test**

Create `server/listing-driver.test.js`:

```js
/* listing-driver.js — a rendered page in, the firecrawl-shaped result out.
   No browser: withPage and the page object are stubbed. */
const assert = require("assert");
const LD = require("./listing-driver");
const { pickImages, isLoginWall } = LD._test;

// ── image picking: same rules as the markdown path, applied to <img> srcs ──
assert.deepEqual(
  pickImages([
    "https://img.yad2.co.il/Pic/1.jpg",
    "https://img.yad2.co.il/Pic/1.jpg",          // duplicate
    "https://cdn.yad2.co.il/assets/logo.png",    // NOT_LISTING
    "https://img.yad2.co.il/Pic/2.webp",
    "data:image/png;base64,AAAA",                // not http(s)
    "https://img.yad2.co.il/Pic/3.svg",          // wrong extension
  ]),
  ["https://img.yad2.co.il/Pic/1.jpg", "https://img.yad2.co.il/Pic/2.webp"],
);

// ── login walls, by landing URL and by page text ──
assert.equal(isLoginWall("https://www.facebook.com/login/?next=%2Fgroups%2F1", "התחברות"), true);
assert.equal(isLoginWall("https://www.instagram.com/accounts/login/", "Log in"), true);
assert.equal(isLoginWall("https://www.yad2.co.il/item/abc", "דירה 4 חדרים"), false);

(async () => {
  // ── happy path: text + photos, firecrawl-compatible shape ──
  const page = {
    goto: async () => {},
    url: () => "https://www.yad2.co.il/item/abc",
    innerText: async () => "דירה 4 חדרים\nמחיר:2,200,000 ₪\nקומה:2",
    imageSrcs: async () => ["https://img.yad2.co.il/Pic/1.jpg"],
  };
  const withPage = async (opts, fn) => fn(page, { sessionId: "s1", cdpUrl: "ws://x" });
  const out = await LD.fromDriver({ url: "https://www.yad2.co.il/item/abc" }, { withPage });
  assert.equal(out.source, "driver");
  assert.ok(out.text.includes("2,200,000"));
  assert.equal(out.description, out.text);
  assert.deepEqual(out.photos, [{ url: "https://img.yad2.co.il/Pic/1.jpg", source: "driver" }]);

  // ── an empty page is an error, not an empty success ──
  const blank = { goto: async () => {}, url: () => "https://www.madlan.co.il/x", innerText: async () => "   ", imageSrcs: async () => [] };
  await assert.rejects(
    LD.fromDriver({ url: "https://www.madlan.co.il/x" }, { withPage: async (o, fn) => fn(blank, {}) }),
    (e) => e.code === "page_unreadable",
  );

  // ── a login wall is its own code, so the route can point at the connect flow ──
  const wall = {
    goto: async () => {}, url: () => "https://www.facebook.com/login/?next=x",
    innerText: async () => "התחברות לפייסבוק", imageSrcs: async () => [],
  };
  await assert.rejects(
    LD.fromDriver({ url: "https://www.facebook.com/groups/1/posts/2", profileName: "facebook-0500000000" },
      { withPage: async (o, fn) => fn(wall, {}) }),
    (e) => e.code === "social_login_required",
  );

  // ── the profile and browser type reach the session options ──
  let seen = null;
  await LD.fromDriver(
    { url: "https://www.facebook.com/groups/1/posts/2", profileName: "facebook-0500000000", browserType: "hosted_stealth" },
    { withPage: async (opts, fn) => { seen = opts; return fn(page, {}); } },
  );
  assert.deepEqual(seen.profile, { name: "facebook-0500000000", persist: true });
  assert.equal(seen.type, "hosted_stealth");
  assert.equal(seen.country, "IL");
  assert.ok(String(seen.note || "").startsWith("forly-extract:"));

  console.log("listing-driver.test.js ok");
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node listing-driver.test.js`
Expected: FAIL with `Cannot find module './listing-driver'`

- [ ] **Step 3: Export the shared image filters from `listing-sources.js`**

In `server/listing-sources.js`, change the final export line to also expose the constants (keep everything already exported):

```js
module.exports = {
  resolve, isPublicUrl, TIMEOUT_MS, MAX_PHOTOS, IMAGE_EXT, NOT_LISTING,
  _test: { sourceFor, facebookPostId, listingImages, isPrivateIp, attachmentImages },
};
```

- [ ] **Step 4: Write minimal implementation**

Create `server/listing-driver.js`:

```js
/*
 * listing-driver.js — the Driver-backed listing source.
 *
 * Yad2 and Madlan render their facts with JavaScript and sit behind bot
 * defences that answer Firecrawl with a challenge page; a Facebook group post
 * is invisible without a session. All three are readable in a real browser.
 *
 * The result is deliberately the SAME shape fromFirecrawl() returns, so
 * listing-extract.js and every caller stay untouched: the page's innerText
 * carries the "label:value" lines the Hebrew prompt already knows how to read.
 */
const { MAX_PHOTOS, IMAGE_EXT, NOT_LISTING } = require("./listing-sources");
const driver = require("./driver-browser");

const GOTO_TIMEOUT_MS = 45000;

function fail(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

// Same filters the markdown path uses, applied to <img> srcs instead.
function pickImages(srcs) {
  const out = [];
  for (const raw of srcs || []) {
    const src = String(raw || "");
    if (!/^https?:\/\//.test(src)) continue;
    if (!IMAGE_EXT.test(src) || NOT_LISTING.test(src) || out.includes(src)) continue;
    out.push(src);
    if (out.length >= MAX_PHOTOS) break;
  }
  return out;
}

const LOGIN_URL = /\/(login|accounts\/login|checkpoint|signin)(\/|\?|$)/i;

function isLoginWall(landedUrl, text) {
  if (LOGIN_URL.test(String(landedUrl || ""))) return true;
  const t = String(text || "");
  return t.length < 400 && /(log in to continue|יש להתחבר כדי להמשיך)/i.test(t);
}

async function readPage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
  // Auto-waiting, not a fixed sleep: settle on the network going quiet, and
  // carry on regardless if it never does — a chatty analytics beacon must not
  // cost us the scrape.
  if (page.waitForLoadState) await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  const text = String(await page.innerText("body")).trim();
  const srcs = page.imageSrcs
    ? await page.imageSrcs()
    : await page.$$eval("img", (els) => els.map((e) => e.currentSrc || e.src).filter(Boolean));
  return { landedUrl: page.url(), text, srcs };
}

async function fromDriver(input, deps = {}) {
  const withPage = deps.withPage || driver.withPage;
  // resolve() hands these through `deps` (extract-jobs sets them per attempt);
  // a direct caller passes them on the input. Accept both, input wins.
  const url = input.url;
  const profileName = input.profileName || deps.profileName || null;
  const browserType = input.browserType || deps.browserType || null;
  const opts = {
    country: "IL",
    duration: 300,
    note: `forly-extract:${deps.jobId || "adhoc"}`,
    type: browserType || "hosted",
  };
  if (profileName) opts.profile = { name: profileName, persist: true };

  const { landedUrl, text, srcs } = await withPage(opts, (page) => readPage(page, url));
  if (isLoginWall(landedUrl, text)) throw fail("social_login_required", "login wall");
  const photos = pickImages(srcs).map((u) => ({ url: u, source: "driver" }));
  if (!text && !photos.length) throw fail("page_unreadable", "empty page");
  if (!text) throw fail("page_unreadable", "no text");
  return { source: "driver", text, description: text, photos };
}

module.exports = { fromDriver, _test: { pickImages, isLoginWall, readPage } };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && node listing-driver.test.js && node listing-sources.test.js`
Expected: both PASS.

- [ ] **Step 6: Add to the test chain and commit**

Append ` && node listing-driver.test.js` to `scripts.test` in `server/package.json`.

```bash
cd server && npm test
git add server/listing-driver.js server/listing-driver.test.js server/listing-sources.js server/package.json
git commit -m "feat(driver): render listing pages into the firecrawl result shape"
```

---

### Task 4: Routing — which source handles which URL

**Files:**
- Modify: `server/listing-sources.js:33-36` (`sourceFor`), `server/listing-sources.js:141-148` (`resolve`)
- Modify: `server/listing-sources.test.js:7-14` (routing block)

**Interfaces:**
- Consumes: `listing-driver.fromDriver`.
- Produces: `sourceFor({text, url}) -> "text" | "facebook" | "driver" | "scrape"`; `resolve()` gains a `driver` branch returning the `fromDriver` result. `DRIVER_HOSTS` is exported on `_test` for the tests.

- [ ] **Step 1: Write the failing test**

In `server/listing-sources.test.js`, replace the two existing Yad2/Madlan assertions (currently asserting `"scrape"`) and add the new cases. The routing block becomes:

```js
// ── routing by host ──
assert.equal(sourceFor({ text: "3 חדרים" }), "text");

// facebook PAGE posts keep the Graph path: faster, free, already working
assert.equal(sourceFor({ url: "https://www.facebook.com/golan.nadlan/posts/123" }), "facebook");
assert.equal(sourceFor({ url: "https://fb.watch/abc" }), "facebook"); // fb.watch is always a video post
assert.equal(sourceFor({ url: "https://www.facebook.com/permalink.php?story_fbid=555&id=777" }), "facebook");

// groups have no Graph equivalent, and a bare profile is not a post → browser
assert.equal(sourceFor({ url: "https://www.facebook.com/groups/123/posts/456" }), "driver");
assert.equal(sourceFor({ url: "https://www.facebook.com/golan.nadlan" }), "driver");

// the rest of the driver allowlist
assert.equal(sourceFor({ url: "https://www.yad2.co.il/item/abc" }), "driver");
assert.equal(sourceFor({ url: "https://madlan.co.il/listings/x" }), "driver");
assert.equal(sourceFor({ url: "https://www.instagram.com/p/abc/" }), "driver");
assert.equal(sourceFor({ url: "https://www.tiktok.com/@a/video/1" }), "driver");
assert.equal(sourceFor({ url: "https://www.linkedin.com/posts/abc" }), "driver");
assert.equal(sourceFor({ url: "https://x.com/a/status/1" }), "driver");

// everything else still goes to firecrawl first
assert.equal(sourceFor({ url: "https://www.komo.co.il/item/1" }), "scrape");
assert.equal(sourceFor({ url: "https://example.com/listing" }), "scrape");

// a lookalike host must NOT match the allowlist by substring
assert.equal(sourceFor({ url: "https://yad2.co.il.evil.com/x" }), "scrape");
assert.equal(sourceFor({ url: "https://notyad2.co.il/x" }), "scrape");

assert.throws(() => sourceFor({ url: "ftp://x" }), (e) => e.code === "invalid_input");
assert.throws(() => sourceFor({}), (e) => e.code === "invalid_input");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node listing-sources.test.js`
Expected: FAIL on the first Yad2 assertion — `'scrape' == 'driver'`

- [ ] **Step 3: Write minimal implementation**

In `server/listing-sources.js`, add the constant next to `FB_HOSTS` (around line 20):

```js
// Sites a plain HTTP scrape cannot read: JS-rendered facts, bot defences, or a
// login wall. Anchored on the registrable domain — a substring test would let
// yad2.co.il.evil.com through.
const DRIVER_HOSTS = /(^|\.)(yad2\.co\.il|madlan\.co\.il|instagram\.com|tiktok\.com|linkedin\.com|x\.com|twitter\.com)$/i;
```

Replace `sourceFor` (currently lines 33-36) with:

```js
function sourceFor({ text, url }) {
  if (typeof text === "string" && text.trim()) return "text";
  if (!url) throw fail("invalid_input", "text or url required");
  const u = parseUrl(url);
  if (FB_HOSTS.test(u.hostname)) {
    // A group post has no Graph equivalent, and a bare profile URL is not a
    // post at all — both need a real browser. Page posts keep the Graph path.
    if (/^\/groups\//i.test(u.pathname)) return "driver";
    if (/(^|\.)fb\.watch$/i.test(u.hostname)) return "facebook"; // always a video post
    return facebookPostId(url) ? "facebook" : "driver";
  }
  if (DRIVER_HOSTS.test(u.hostname)) return "driver";
  return "scrape";
}
```

Replace `resolve` (currently lines 141-148) with:

```js
async function resolve(input, deps = {}) {
  const kind = deps.forceSource || sourceFor(input);
  if (kind === "text") { const text = input.text.trim(); return { source: "text", text, description: text, photos: [] }; }
  if (kind === "facebook") return fromFacebook(input, deps);
  if (kind === "driver") return require("./listing-driver").fromDriver(input, deps);
  return fromFirecrawl(input, deps);
}
```

`forceSource` is how the Firecrawl→Driver fallback in Task 6 re-runs the same input through the browser.

Three assertions already in `listing-sources.test.js` break with this routing and must be updated in the same step, or `npm test` fails at Step 4:
- the Firecrawl happy path `S.resolve({ url: "https://www.yad2.co.il/item/1" }, { fetchFn, firecrawlKey })` → change the host to `https://www.komo.co.il/item/1` (a non-allowlisted host);
- `S.resolve({ url: "https://www.facebook.com/golan", userId })` expecting `page_unreadable` → a bare profile now routes to `driver`; change the expectation to `S.resolve(…, { withPage: async () => { throw Object.assign(new Error("x"), { code: "page_unreadable" }); } })` rejecting with `page_unreadable`, which exercises the driver branch with a stub;
- any remaining `yad2`/`madlan` → `"scrape"` assertion is replaced by the block above. `listing-driver` is required lazily inside the function because it requires `listing-sources` back for the image filters — a top-level require would be a cycle.

Add `DRIVER_HOSTS` to the `_test` export.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && node listing-sources.test.js && node listing-driver.test.js`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add server/listing-sources.js server/listing-sources.test.js
git commit -m "feat(extract): route social, yad2 and madlan URLs to the browser source"
```

---

### Task 5: Job persistence and the job state machine

**Files:**
- Modify: `server/db.js:11` (mem store), `server/db.js:498-517` (exports)
- Create: `server/extract-jobs.js`
- Create: `server/extract-jobs.test.js`
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Consumes: `db.saveExtractJob/getExtractJob/updateExtractJob/listExtractJobsByStatus`, `listing-sources.resolve`, `listing-extract.parseListing`.
- Produces:
  - `create({ phone, url, forceSource, profileName }, deps) -> Promise<Job>` — status `queued`
  - `runJob(job, deps) -> Promise<Job>`
  - `sweep(deps) -> Promise<number>` (jobs started)
  - `startSweeper(deps) -> () => void` (returns a stop function)
  - `liveDeps() -> deps`
  - `BROWSER_LADDER = ["hosted", "hosted_stealth", "hosted_privacy"]`, `MAX_ATTEMPTS = 3`
  - Job shape: `{ id, phone, url, status: "queued"|"running"|"done"|"failed", attempts, force_source, profile_name, created_at, updated_at, result: {source, description, fields, missing, photos} | null, error_code: string | null }`

- [ ] **Step 1: Write the failing test**

Create `server/extract-jobs.test.js`:

```js
/* extract-jobs.js — the queued-scrape state machine. No network, no browser:
   resolve, parseListing and the store are fakes. */
const assert = require("assert");
const J = require("./extract-jobs");

function fakeStore() {
  const jobs = new Map();
  return {
    jobs,
    saveExtractJob: async (j) => { jobs.set(j.id, JSON.parse(JSON.stringify(j))); },
    getExtractJob: async (id) => jobs.get(id) || null,
    updateExtractJob: async (id, patch) => { const j = jobs.get(id); if (j) Object.assign(j, patch); },
    listExtractJobsByStatus: async (s, limit = 10) => [...jobs.values()].filter((j) => j.status === s).slice(0, limit),
  };
}

(async () => {
  // ── create starts queued and never runs inline ──
  const store = fakeStore();
  const job = await J.create({ phone: "0500000000", url: "https://www.yad2.co.il/item/a" }, { db: store });
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 0);
  assert.equal(job.phone, "0500000000");
  assert.ok(job.id);

  // ── a successful run parses and stores fields, then goes done ──
  const deps = {
    db: store,
    resolve: async () => ({ source: "driver", text: "דירה", description: "דירה", photos: [{ url: "https://i/1.jpg", source: "driver" }] }),
    parseListing: async () => ({ fields: { city: "חיפה", price: 100 }, missing: ["rooms"] }),
  };
  const done = await J.runJob(job, deps);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result.fields, { city: "חיפה", price: 100 });
  assert.deepEqual(done.result.missing, ["rooms"]);
  assert.deepEqual(done.result.photos, [{ url: "https://i/1.jpg", source: "driver" }]);
  assert.equal(done.error_code, null);

  // ── a blocked page escalates the browser type on each attempt, then fails ──
  const store2 = fakeStore();
  const job2 = await J.create({ phone: "p", url: "https://www.madlan.co.il/x" }, { db: store2 });
  const types = [];
  const blockDeps = {
    db: store2,
    resolve: async (input, d) => { types.push(d.browserType); const e = new Error("blocked"); e.code = "page_unreadable"; throw e; },
    parseListing: async () => ({ fields: {}, missing: [] }),
  };
  let j2 = job2;
  for (let i = 0; i < 3; i++) j2 = await J.runJob(await store2.getExtractJob(job2.id), blockDeps);
  assert.deepEqual(types, J.BROWSER_LADDER);
  assert.equal(j2.status, "failed");
  assert.equal(j2.error_code, "page_unreadable");
  assert.equal(j2.attempts, 3);

  // ── a login wall is terminal on the first attempt: retrying cannot help ──
  const store3 = fakeStore();
  const job3 = await J.create({ phone: "p", url: "https://www.facebook.com/groups/1/posts/2" }, { db: store3 });
  const wallDeps = {
    db: store3,
    resolve: async () => { const e = new Error("wall"); e.code = "social_login_required"; throw e; },
    parseListing: async () => ({ fields: {}, missing: [] }),
  };
  const j3 = await J.runJob(job3, wallDeps);
  assert.equal(j3.status, "failed");
  assert.equal(j3.error_code, "social_login_required");
  assert.equal(j3.attempts, 1, "no retry on a login wall");

  // ── 402/403 are terminal too, and the VENDOR code never becomes ours ──
  const store4 = fakeStore();
  const job4 = await J.create({ phone: "p", url: "https://www.yad2.co.il/item/b" }, { db: store4 });
  const brokeDeps = {
    db: store4,
    resolve: async () => { const e = new Error("no credits"); e.status = 402; e.code = "insufficient_credits"; throw e; },
    parseListing: async () => ({ fields: {}, missing: [] }),
  };
  const j4 = await J.runJob(job4, brokeDeps);
  assert.equal(j4.status, "failed");
  assert.equal(j4.error_code, "extract_unavailable", "vendor code must not leak");
  assert.equal(j4.attempts, 1);

  // ── a job stuck in "running" (crash before catch) is reaped, so the queue never wedges ──
  const store7 = fakeStore();
  await store7.saveExtractJob({ id: "stuck", phone: "p", url: "u", status: "running", attempts: 1, updated_at: new Date(Date.now() - 10 * 60000).toISOString() });
  await store7.saveExtractJob({ id: "dead", phone: "p", url: "u", status: "running", attempts: 3, updated_at: new Date(Date.now() - 10 * 60000).toISOString() });
  await J.reapStale({ db: store7 }, new Date());
  assert.equal((await store7.getExtractJob("stuck")).status, "queued");
  assert.equal((await store7.getExtractJob("dead")).status, "failed");

  // ── a job that needs a profile takes the per-phone lock, and yields while it is held ──
  const store8 = fakeStore();
  const locks = require("./profile-lock");
  const release = locks.acquire("p");
  const job8 = await J.create({ phone: "p", url: "https://www.facebook.com/groups/1/posts/2", profileName: "facebook-x" }, { db: store8 });
  const held = await J.runJob(job8, { db: store8, resolve: async () => { throw new Error("must not run while locked"); }, parseListing: async () => ({}) });
  assert.equal(held.status, "queued", "not attempted, not counted");
  assert.equal(held.attempts, 0);
  release();

  // ── sweep starts at most (cap - running) jobs ──
  const store5 = fakeStore();
  for (let i = 0; i < 5; i++) await J.create({ phone: "p", url: `https://www.yad2.co.il/item/${i}` }, { db: store5 });
  await store5.saveExtractJob({ id: "busy", phone: "p", url: "u", status: "running", attempts: 1 });
  let started = 0;
  const swept = await J.sweep({
    db: store5, maxConcurrent: 3,
    runJob: async () => { started++; },
    resolve: async () => ({}), parseListing: async () => ({}),
  });
  assert.equal(swept, 2, "cap 3 minus 1 already running");
  assert.equal(started, 2);

  // ── forceSource rides through to resolve, for the firecrawl fallback ──
  const store6 = fakeStore();
  const job6 = await J.create({ phone: "p", url: "https://example.com/x", forceSource: "driver" }, { db: store6 });
  let sawForce = null;
  await J.runJob(job6, {
    db: store6,
    resolve: async (input, d) => { sawForce = d.forceSource; return { source: "driver", text: "t", description: "t", photos: [] }; },
    parseListing: async () => ({ fields: {}, missing: [] }),
  });
  assert.equal(sawForce, "driver");

  console.log("extract-jobs.test.js ok");
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node extract-jobs.test.js`
Expected: FAIL with `Cannot find module './extract-jobs'`

- [ ] **Step 3: Add the store to `db.js`**

At `server/db.js:11`, add `extractJobs: new Map()` to the `mem` object literal (alongside `distributions: new Map()`).

Add these functions next to the distribution ones (after `listQueuedDistributions`, around line 315):

```js
// ── extract jobs (browser-backed listing scrapes) ──
// Same shape as distributions: doc-per-job, dot-path patches, single-field
// where so no composite index is needed.
async function saveExtractJob(j) {
  if (db) await db.collection("extract_jobs").doc(j.id).set(j);
  else mem.extractJobs.set(j.id, JSON.parse(JSON.stringify(j)));
}

async function getExtractJob(id) {
  if (db) { const d = await db.collection("extract_jobs").doc(id).get(); return d.exists ? d.data() : null; }
  return mem.extractJobs.get(id) || null;
}

async function updateExtractJob(id, patch) {
  if (db) { await db.collection("extract_jobs").doc(id).update(patch); return; }
  const j = mem.extractJobs.get(id);
  if (j) Object.assign(j, patch);
}

async function listExtractJobsByStatus(status, limit = 10) {
  if (db) {
    const snap = await db.collection("extract_jobs").where("status", "==", status).limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.extractJobs.values()].filter((j) => j.status === status).slice(0, limit);
}
```

Add `saveExtractJob, getExtractJob, updateExtractJob, listExtractJobsByStatus,` to `module.exports`.

- [ ] **Step 4: Write the state machine**

Create `server/extract-jobs.js`:

```js
/*
 * extract-jobs.js — queued browser scrapes.
 *
 * A Firecrawl scrape answers inside one HTTP request; a browser scrape takes
 * 30–90s (session start, render, network idle) and would hold a Cloud Run
 * request open the whole time. So the route queues a job and the wizard polls.
 *
 * The state is in Firestore rather than in process because Cloud Run runs many
 * instances: the poll that follows a POST usually lands somewhere else.
 *
 * Lifecycle: queued → running → done | failed.
 *
 * Retry policy mirrors driver-browser.js: only what time or a different
 * browser type can fix gets another attempt. A login wall and an out-of-credits
 * account both need a PERSON, so they fail on the first try.
 */
const crypto = require("crypto");

const MAX_ATTEMPTS = 3;
const SWEEP_MS = 5 * 1000;
// Each rung looks less like automation than the last, and costs more. Start cheap.
const BROWSER_LADDER = ["hosted", "hosted_stealth", "hosted_privacy"];
// Terminal on the first attempt — retrying cannot change the answer.
const TERMINAL_CODES = new Set(["social_login_required", "invalid_input", "extract_unavailable"]);

const nowIso = () => new Date().toISOString();

async function create({ phone, url, forceSource = null, profileName = null }, deps) {
  const job = {
    id: crypto.randomUUID(),
    phone: String(phone),
    url: String(url),
    status: "queued",
    attempts: 0,
    force_source: forceSource,
    profile_name: profileName,
    created_at: nowIso(),
    updated_at: nowIso(),
    result: null,
    error_code: null,
  };
  await deps.db.saveExtractJob(job);
  return job;
}

// Driver's own HTTP statuses reach us on the error; map them to the stable
// codes the route already knows, so no vendor text ever reaches an agent.
// DriverError carries the VENDOR body's `code` (e.g. "insufficient_credits"),
// so the status check must come first or that string leaks into error_code.
const OURS = new Set(["page_unreadable", "social_login_required", "invalid_input", "extract_unavailable"]);
function codeFor(err) {
  if (typeof err.status === "number") {
    if (err.status === 402 || err.status === 403 || err.status === 503 || err.status === 401) return "extract_unavailable";
    return "page_unreadable";
  }
  return OURS.has(err.code) ? err.code : "page_unreadable";
}

// Anything left "running" past its maximum lifetime died with the process.
// Without this, DRIVER_MAX_CONCURRENT such ghosts wedge the queue for good.
const STALE_MS = 5 * 60 * 1000;
async function reapStale(deps, now = new Date()) {
  const running = await deps.db.listExtractJobsByStatus("running", 50);
  for (const j of running) {
    if (now.getTime() - new Date(j.updated_at || 0).getTime() < STALE_MS) continue;
    const dead = (j.attempts || 0) >= MAX_ATTEMPTS;
    await deps.db.updateExtractJob(j.id, { status: dead ? "failed" : "queued", error_code: dead ? "page_unreadable" : j.error_code || null, updated_at: nowIso() });
  }
}

async function runJob(job, deps) {
  // A persisted profile is one browser at a time, across extract, connect and
  // posting — the same lock every one of them takes (profile-lock.js).
  const locks = deps.locks || require("./profile-lock");
  const release = job.profile_name ? locks.tryAcquire(job.phone) : () => {};
  if (job.profile_name && !release) return job; // someone else has the profile open; next sweep
  try {
    return await runJobLocked(job, deps);
  } finally { release(); }
}

async function runJobLocked(job, deps) {
  const attempt = (job.attempts || 0) + 1;
  const browserType = BROWSER_LADDER[Math.min(attempt, BROWSER_LADDER.length) - 1];
  await deps.db.updateExtractJob(job.id, { status: "running", attempts: attempt, updated_at: nowIso() });

  try {
    const source = await deps.resolve(
      { url: job.url, userId: job.phone },
      { forceSource: job.force_source || "driver", browserType, profileName: job.profile_name, jobId: job.id },
    );
    const parsed = await deps.parseListing(source.text);
    const patch = {
      status: "done",
      error_code: null,
      updated_at: nowIso(),
      result: {
        source: source.source,
        description: source.description || "",
        photos: source.photos || [],
        fields: parsed.fields,
        missing: parsed.missing,
      },
    };
    await deps.db.updateExtractJob(job.id, patch);
    return Object.assign({}, job, patch, { attempts: attempt });
  } catch (err) {
    const code = codeFor(err);
    const terminal = TERMINAL_CODES.has(code) || attempt >= MAX_ATTEMPTS;
    const patch = {
      status: terminal ? "failed" : "queued",
      error_code: code,
      updated_at: nowIso(),
    };
    await deps.db.updateExtractJob(job.id, patch);
    return Object.assign({}, job, patch, { attempts: attempt });
  }
}

/*
 * One pass: start as many queued jobs as the concurrency budget allows. The
 * budget is the Driver plan's concurrent_browsers minus what posting and the
 * login browser are using — one process, so profile-lock.js knows exactly.
 */
let sweeping = false; // in-process latch: one container, overlapping sweeps are the only race
async function sweep(deps) {
  if (sweeping) return 0;
  sweeping = true;
  try { return await sweepOnce(deps); } finally { sweeping = false; }
}
async function sweepOnce(deps) {
  await reapStale(deps);
  const cap = deps.maxConcurrent || Number(process.env.DRIVER_MAX_CONCURRENT || 2);
  const running = await deps.db.listExtractJobsByStatus("running", cap + 1);
  const budget = cap - running.length;
  if (budget <= 0) return 0;
  const queued = await deps.db.listExtractJobsByStatus("queued", budget);
  const run = deps.runJob || runJob;
  for (const job of queued) {
    // Deliberately not awaited: the sweep starts jobs, it does not wait on them.
    Promise.resolve(run(job, deps)).catch((e) => console.error(`extract job ${job.id} crashed: ${e.message}`));
  }
  return queued.length;
}

function startSweeper(deps) {
  const every = deps.sweepMs || SWEEP_MS;
  const t = setInterval(() => { sweep(deps).catch((e) => console.error(`extract sweep failed: ${e.message}`)); }, every);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

function liveDeps() {
  return {
    db: require("./db"),
    resolve: require("./listing-sources").resolve,
    parseListing: require("./listing-extract").parseListing,
  };
}

module.exports = { create, runJob, reapStale, sweep, startSweeper, liveDeps, MAX_ATTEMPTS, SWEEP_MS, BROWSER_LADDER };
```

- [ ] **Step 4b: Write `profile-lock.js` — the one lock every profile user takes**

Create `server/profile-lock.js`:

```js
/*
 * profile-lock.js — one browser per persisted profile, one process.
 *
 * Extract (a Facebook group URL), the login browser, and posting all open the
 * SAME Driver profile for a phone. Two of them at once means one cookie set
 * live from two IPs — the pattern that gets an account checkpointed. This is
 * the single place that rule is enforced. Single-container deployment, so an
 * in-process map is exact; a second container is a documented non-goal.
 *
 * Also the Driver concurrency budget: every session, of any kind, counts.
 */
const held = new Map();          // phone → expiresAt
const MAX_HOLD_MS = 20 * 60 * 1000; // longer than any session we create
let sessions = 0;

function tryAcquire(phone) {
  const now = Date.now();
  const until = held.get(phone);
  if (until && until > now) return null;
  held.set(phone, now + MAX_HOLD_MS);
  return () => { if (held.get(phone)) held.delete(phone); };
}
function acquire(phone) { const r = tryAcquire(phone); if (!r) throw new Error(`profile ${phone} is busy`); return r; }
function isHeld(phone) { const u = held.get(phone); return !!u && u > Date.now(); }

const budget = () => Number(process.env.DRIVER_MAX_CONCURRENT || 2);
function trySession() { if (sessions >= budget()) return null; sessions++; return () => { sessions = Math.max(0, sessions - 1); }; }
function activeSessions() { return sessions; }

module.exports = { tryAcquire, acquire, isHeld, trySession, activeSessions, _test: { held, reset: () => { held.clear(); sessions = 0; } } };
```

`driver-browser.withPage` and `attachPage` (Task 10) call `trySession()` before creating/joining and release in their `finally`; when it returns `null` they throw `DriverError(429, "local concurrency budget")`, which the sweepers treat as "try next pass", not as a failure.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && node extract-jobs.test.js`
Expected: PASS, printing `extract-jobs.test.js ok`

- [ ] **Step 6: Add to the test chain and commit**

Append ` && node extract-jobs.test.js` to `scripts.test` in `server/package.json`.

```bash
cd server && npm test
git add server/db.js server/extract-jobs.js server/extract-jobs.test.js server/profile-lock.js server/package.json
git commit -m "feat(extract): queue browser scrapes as jobs with a sweeper and a profile lock"
```

---

### Task 6: The route — 202, polling, and the Firecrawl fallback

**Files:**
- Modify: `server/routes/extract.js:17-19` (STATUS map), `server/routes/extract.js` (the POST handler and a new GET)
- Modify: `server/routes/extract.test.js`

**Interfaces:**
- Consumes: `extract-jobs.create`, `listing-sources.sourceFor` (via `_test`), `db.getExtractJob`.
- Produces:
  - `POST /api/properties/extract` → `200 {source, fields, missing, description, photos}` (text / facebook / firecrawl) **or** `202 {job_id, status:"queued"}` (driver, or firecrawl that errored).
  - `GET /api/properties/extract/:job_id` → `200 {status, fields?, missing?, description?, photos?, error_code?}`; `404` when the job is missing **or** belongs to another phone.

- [ ] **Step 1: Write the failing test**

Append to `server/routes/extract.test.js`. The existing file never builds an Express app (it tests `importImage`/`validateBody` directly), so add the helpers once. The file is CommonJS: every block below lives inside one `(async () => { … })()` — a bare `{ await … }` at top level is a `SyntaxError`.

```js
const express = require("express");
const http = require("http");
const createExtractRouter = require("./extract");

function makeApp(o = {}) {
  const phone = o.phone || "0500000000";
  const requireAuth = () => (req, res, next) => { req.user = { userId: phone }; next(); };
  const app = express(); app.use(express.json());
  app.use("/api", createExtractRouter({ requireAuth, authSecret: "s", resolve: o.resolve, db: o.db, extractJobs: o.extractJobs, driverEnabled: o.driverEnabled !== false }));
  return app;
}
function call(app, method, path, body, headers) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const req = http.request({ port: server.address().port, path, method, headers: Object.assign({ "content-type": "application/json" }, headers || {}) }, (res) => {
        let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(d || "{}") }); });
      });
      if (body) req.write(JSON.stringify(body)); req.end();
    });
  });
}
const post = (app, path, body, headers) => call(app, "POST", path, body, headers);
const get = (app, path) => call(app, "GET", path);

(async () => {
// ── a driver-routed URL queues a job instead of answering inline ──
{
  const created = [];
  const app = makeApp({
    extractJobs: { create: async (input) => { created.push(input); return { id: "job-1", status: "queued" }; } },
  });
  const res = await post(app, "/api/properties/extract", { url: "https://www.yad2.co.il/item/abc" });
  assert.equal(res.status, 202);
  assert.equal(res.body.job_id, "job-1");
  assert.equal(res.body.status, "queued");
  assert.equal(created.length, 1);
  assert.equal(created[0].url, "https://www.yad2.co.il/item/abc");
  assert.equal(created[0].forceSource, null, "a driver host needs no forcing");
}

// ── firecrawl failing to READ falls back to a driver job, not an error ──
{
  const created = [];
  const app = makeApp({
    resolve: async () => { const e = new Error("challenge page"); e.code = "page_unreadable"; throw e; },
    extractJobs: { create: async (input) => { created.push(input); return { id: "job-2", status: "queued" }; } },
  });
  const res = await post(app, "/api/properties/extract", { url: "https://www.komo.co.il/item/1" });
  assert.equal(res.status, 202);
  assert.equal(res.body.job_id, "job-2");
  assert.equal(created[0].forceSource, "driver");
  assert.equal(created[0].profileName, null, "a fallback scrape NEVER gets a customer's logged-in profile");
}

// ── but firecrawl being UNCONFIGURED is not a reason to spend a browser ──
{
  const app = makeApp({
    resolve: async () => { const e = new Error("no key"); e.code = "extract_unavailable"; throw e; },
    extractJobs: { create: async () => { throw new Error("must not queue"); } },
  });
  const res = await post(app, "/api/properties/extract", { url: "https://www.komo.co.il/item/1" });
  assert.equal(res.status, 503);
}

// ── demo callers never reach a browser: they get told to sign in ──
{
  const app = makeApp({ extractJobs: { create: async () => { throw new Error("must not queue"); } } });
  const res = await post(app, "/api/properties/extract", { url: "https://www.yad2.co.il/item/abc" }, { "x-demo-key": "demo" });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "login_required_for_browser");
}

// ── and with Driver not configured, the answer is an honest 503, not a job that never runs ──
{
  const app = makeApp({ driverEnabled: false, extractJobs: { create: async () => { throw new Error("must not queue"); } } });
  const res = await post(app, "/api/properties/extract", { url: "https://www.yad2.co.il/item/abc" });
  assert.equal(res.status, 503);
}

// ── but a bad input is still a 400: the browser cannot fix a malformed URL ──
{
  const app = makeApp({
    resolve: async () => { const e = new Error("bad"); e.code = "invalid_input"; throw e; },
    extractJobs: { create: async () => { throw new Error("must not queue"); } },
  });
  const res = await post(app, "/api/properties/extract", { url: "https://example.com/x" });
  assert.equal(res.status, 400);
}

// ── polling returns the job, and only to its owner ──
{
  const job = { id: "job-3", phone: "0500000000", status: "done", error_code: null,
    result: { source: "driver", description: "דירה", fields: { city: "חיפה" }, missing: ["rooms"], photos: [] } };
  const app = makeApp({ db: { getExtractJob: async (id) => (id === "job-3" ? job : null) } });
  const ok = await get(app, "/api/properties/extract/job-3");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "done");
  assert.deepEqual(ok.body.fields, { city: "חיפה" });
  assert.deepEqual(ok.body.missing, ["rooms"]);

  const missing = await get(app, "/api/properties/extract/nope");
  assert.equal(missing.status, 404);

  const otherApp = makeApp({
    phone: "0509999999",
    db: { getExtractJob: async () => job },
  });
  const stolen = await get(otherApp, "/api/properties/extract/job-3");
  assert.equal(stolen.status, 404, "another agent's job must be indistinguishable from a missing one");
}

// ── a failed job reports its stable code, never vendor text ──
{
  const job = { id: "job-4", phone: "0500000000", status: "failed", error_code: "social_login_required", result: null };
  const app = makeApp({ db: { getExtractJob: async () => job } });
  const res = await get(app, "/api/properties/extract/job-4");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "failed");
  assert.equal(res.body.error_code, "social_login_required");
  assert.ok(!("text" in res.body));
}

// ── the browser cap is separate from, and lower than, the firecrawl cap ──
{
  let queued = 0;
  const app = makeApp({ extractJobs: { create: async () => { queued++; return { id: `j${queued}`, status: "queued" }; } } });
  for (let i = 0; i < 10; i++) await post(app, "/api/properties/extract", { url: `https://www.yad2.co.il/item/${i}` });
  const over = await post(app, "/api/properties/extract", { url: "https://www.yad2.co.il/item/over" });
  assert.equal(over.status, 429);
  assert.equal(over.body.error, "extract_limit");
  assert.equal(queued, 10, "DRIVER_DAILY_CAP is 10");
}

// ── profileFor: anchored, and twitter is x ──
{
  const { profileFor } = createExtractRouter._test;
  assert.equal(profileFor("https://www.facebook.com/groups/1", "05x", "k"), profileFor("https://facebook.com/groups/2", "05x", "k"));
  assert.ok(/^facebook-[a-z]+-[0-9a-f]{20}$/.test(profileFor("https://www.facebook.com/groups/1", "05x", "k")), "hmac, not the phone");
  assert.equal(profileFor("https://twitter.com/a/status/1", "05x", "k"), profileFor("https://x.com/a/status/1", "05x", "k"));
  assert.equal(profileFor("https://netflix.com/x", "05x", "k"), null, "not left-anchored → netflix matched x.com");
  assert.equal(profileFor("https://evilfacebook.com/x", "05x", "k"), null);
  assert.equal(profileFor("https://www.yad2.co.il/item/1", "05x", "k"), null, "no profile for non-social hosts");
}
})();
```

If `makeApp`, `post` or `get` do not already exist in that file, add them once at the top, building the router through `createExtractRouter({ requireAuth, authSecret, ... })` the way the file's existing cases do. The `overrides` argument must be able to replace `resolve`, `db`, `extractJobs`, **and `phone`** — `phone` sets what the stubbed `requireAuth` puts in `req.user.userId`, and the ownership case depends on it:

```js
function makeApp(overrides) {
  const o = overrides || {};
  const phone = o.phone || "0500000000";
  const requireAuth = () => (req, res, next) => { req.user = { userId: phone }; next(); };
  const app = express();
  app.use(express.json());
  app.use("/api", createExtractRouter({ requireAuth, authSecret: "s", resolve: o.resolve, db: o.db, extractJobs: o.extractJobs }));
  return app;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node routes/extract.test.js`
Expected: FAIL — the driver URL returns 200 (or 5xx) instead of 202.

- [ ] **Step 3: Write minimal implementation**

In `server/routes/extract.js`, extend the status map (line 17-19):

```js
const STATUS = {
  invalid_input: 400, facebook_not_connected: 409, social_login_required: 409,
  page_unreadable: 422, extract_limit: 429, extract_unavailable: 503,
};
```

Add near `DAILY_CAP`:

```js
// A browser scrape is a whole Chrome instance plus metered bandwidth, where a
// firecrawl scrape is one HTTP call. Same abuse surface, very different cost.
const DRIVER_DAILY_CAP = 10;
```

Give the router a second `DailyLimit` instance (`const driverLimit = new DailyLimit(DRIVER_DAILY_CAP);`) alongside the existing one. `resolve` is currently a top-level import in this file — make it injectable, and inject the rest, at the top of the factory:

```js
const resolve = ctx.resolve || require("../listing-sources").resolve;
const database = ctx.db || require("../db");
const extractJobs = ctx.extractJobs || require("../extract-jobs");
const jobDeps = ctx.jobDeps || require("../extract-jobs").liveDeps();
const driverEnabled = ctx.driverEnabled !== undefined ? ctx.driverEnabled : !!process.env.DRIVER_API_KEY;
const { sourceFor } = require("../listing-sources")._test;
```

The block below goes **inside the existing `try { … } catch (err) { sendError(res, err) }`** of the POST handler, replacing its resolve step — Express 4 does not catch async rejections, so `sourceFor` throwing `invalid_input` or `queueDriverJob` throwing `extract_limit` outside the `try` would hang the request. `phone` is the handler's existing `keyFor(req)` binding.

```js
// Driver-routed hosts never try firecrawl: we already know it cannot read them.
const kind = input.text ? "text" : sourceFor(input);

async function queueDriverJob(forceSource, withProfile) {
  if (!driverEnabled) throw fail("extract_unavailable", "DRIVER_API_KEY is not set");
  // A browser session is a paid resource and, for social hosts, opens the
  // customer's own logged-in profile. Demo callers get neither.
  if (!req.user) throw fail("login_required_for_browser");
  if (!driverLimit.take(phone)) throw fail("extract_limit");
  const job = await extractJobs.create(
    { phone, url: input.url, forceSource, profileName: withProfile ? profileFor(input.url, phone, profileKey) : null },
    jobDeps,
  );
  return { job_id: job.id, status: job.status };
}

if (kind === "driver") return res.status(202).json(await queueDriverJob(null, true));

let source;
try {
  source = await resolve(Object.assign({}, input, { userId: phone }), deps);
} catch (err) {
  // "or if firecrawl returns an error": a browser is the next thing to try —
  // but only when firecrawl actually failed to READ the page. A missing key
  // (extract_unavailable) or a bad URL (invalid_input) is not that. And the
  // fallback never carries a profile: an arbitrary URL must not be opened in
  // a browser that holds the customer's Facebook cookies.
  if (kind === "scrape" && err.code === "page_unreadable") {
    return res.status(202).json(await queueDriverJob("driver", false));
  }
  throw err;
}
```

Add `login_required_for_browser: 409` to `STATUS`, and `const fail = (code, msg) => { const e = new Error(msg || code); e.code = code; return e; };` if the file does not already have one at module scope.

Add the profile helper next to `importImage`, and export it on `module.exports._test = { profileFor }`:

```js
// One persisted browser profile per agent per platform. The agent logs in once
// through the embedded browser; the cookies live in the profile, never here.
// The name is an HMAC of the phone: the Driver key alone must not be able to
// enumerate customers. connections-browser.js builds the same name.
const crypto = require("crypto");
const SOCIAL = /(^|\.)(facebook\.com|instagram\.com|tiktok\.com|linkedin\.com|x\.com|twitter\.com)$/i;
function profileFor(url, phone, key = process.env.PROFILE_KEY, env = process.env.FORLY_ENV || "prod") {
  let host;
  try { host = new URL(url).hostname; } catch (e) { return null; }
  const m = host.match(SOCIAL);
  if (!m) return null;
  const name = m[2].split(".")[0].toLowerCase();
  const platform = name === "twitter" ? "x" : name; // one account, one profile
  const tag = crypto.createHmac("sha256", String(key || "dev")).update(String(phone)).digest("hex").slice(0, 20);
  return `${platform}-${env}-${tag}`;
}
```

Move this function into `server/profile-name.js` (exporting `profileFor(url, phone)` and `profileName(platform, phone)`) so `routes/connections-browser.js` (Task 10) and `posting-campaign.js` (Task 14) build the identical string from the same code. `PROFILE_KEY` is a new secret (`openssl rand -hex 32`), separate from `META_TOKEN_KEY`.

Add the poll route after the POST:

```js
// Poll target for a queued browser scrape. A job that belongs to someone else
// answers exactly like one that does not exist — an agent must not be able to
// probe for other agents' job ids.
router.get("/properties/extract/:job_id", requireAuth(authSecret), async (req, res) => {
  const job = await database.getExtractJob(String(req.params.job_id)).catch(() => null);
  if (!job || job.phone !== req.user.userId) return res.status(404).json({ error: "not_found" });
  const out = { status: job.status };
  if (job.status === "done" && job.result) {
    out.source = job.result.source;
    out.fields = job.result.fields;
    out.missing = job.result.missing;
    out.description = job.result.description;
    out.photos = job.result.photos;
  }
  if (job.status === "failed") out.error_code = job.error_code;
  return res.json(out);
});
```

Bind `const database = ctx.db || require("../db");` at the top of the factory.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && node routes/extract.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/extract.js server/routes/extract.test.js
git commit -m "feat(extract): queue driver jobs, poll for results, fall back from firecrawl"
```

---

### Task 7: Wire it into the running server

**Files:**
- Modify: `server/index.js:184-190` (extract router mount), plus a new boot block
- Modify: `server/Dockerfile`
- Modify: `server/package.json` (already has `patchright` from Task 1)

**Interfaces:**
- Consumes: `extract-jobs.startSweeper/liveDeps`, `driver-browser.cleanupOrphans`.
- Produces: a running sweeper and a clean session list at boot. No new exports.

- [ ] **Step 1: Add the boot block to `index.js`**

After the extract router is mounted (around line 190):

```js
// ── browser-backed extracts ──
// A crash between "session created" and the finally leaves a browser running
// until its duration expires, holding a concurrency slot the whole time. Ours
// all carry a forly-extract: note, so we can tell them from anyone else's.
if (process.env.DRIVER_API_KEY) {
  const extractJobs = require("./extract-jobs");
  const driverBrowser = require("./driver-browser");
  driverBrowser.cleanupOrphans("forly-extract:")
    .then((n) => { if (n) console.log(`driver: stopped ${n} orphaned session(s) at boot`); })
    .catch((e) => console.warn(`driver: orphan cleanup failed: ${e.message}`));
  extractJobs.startSweeper(extractJobs.liveDeps());
  console.log("driver: extract sweeper started");
} else {
  console.warn("DRIVER_API_KEY not set — yad2/madlan/social URLs will fail to extract");
}
```

- [ ] **Step 2: Stop the Dockerfile from fetching a browser**

Add above the `npm install`/`npm ci` line in `server/Dockerfile`:

```dockerfile
# patchright drives a REMOTE Chrome over CDP — we never launch one locally, so
# the bundled browser download is pure image weight.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
```

- [ ] **Step 3: Verify the server still boots both ways**

```bash
cd server && node -e "require('./index.js')" & sleep 3; curl -sS localhost:8787/api/quota >/dev/null && echo "boots without DRIVER_API_KEY"; kill %1
DRIVER_API_KEY=dummy node -e "require('./extract-jobs').startSweeper(require('./extract-jobs').liveDeps()); setTimeout(()=>{console.log('sweeper survived a tick');process.exit(0)},6000)"
```

Expected: the first prints the warning line and serves; the second prints `sweeper survived a tick` without an unhandled rejection.

- [ ] **Step 4: Run the whole suite**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/Dockerfile
git commit -m "feat(driver): start the extract sweeper and clean orphaned sessions at boot"
```

---

### Task 8: Front-end — the wizard handles a queued extract

**Files:**
- Modify: `public-agent/extract.js:63-69` (`errorKey`) and the export block
- Modify: `public-agent/extract.test.js`
- Modify: `public-agent/create.html:1076-1107` (`runExtract`)
- Modify: `public-agent/form-i18n.js` (new keys, both language maps)

**Interfaces:**
- Consumes: `POST /api/properties/extract` (200 or 202), `GET /api/properties/extract/:job_id`.
- Produces: `FlyExtract.pollJob(jobId, opts) -> Promise<{status, fields?, missing?, description?, photos?, error_code?}>`, where `opts = { fetchFn, sleep, timeoutMs, intervalMs, headers }`. `errorKey` gains the `social_login_required` case.

- [ ] **Step 1: Write the failing test**

Append to `public-agent/extract.test.js`:

```js
// ── pollJob: keeps asking until the job settles ──
(async () => {
  const states = [{ status: "queued" }, { status: "running" }, { status: "done", fields: { city: "חיפה" }, missing: [], photos: [] }];
  let n = 0;
  const slept = [];
  const out = await X.pollJob("job-1", {
    fetchFn: async () => ({ ok: true, json: async () => states[Math.min(n++, states.length - 1)] }),
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(out.status, "done");
  assert.deepEqual(out.fields, { city: "חיפה" });
  assert.equal(slept.length, 2, "polled twice before the answer");

  // a failed job comes back as-is, not as a throw — the caller shows its code
  const failed = await X.pollJob("job-2", {
    fetchFn: async () => ({ ok: true, json: async () => ({ status: "failed", error_code: "social_login_required" }) }),
    sleep: async () => {},
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error_code, "social_login_required");

  // a job that never settles gives up rather than polling forever
  let calls = 0;
  await assert.rejects(
    X.pollJob("job-3", {
      fetchFn: async () => { calls++; return { ok: true, json: async () => ({ status: "running" }) }; },
      sleep: async () => {},
      timeoutMs: 0,
    }),
    /timeout/,
  );
  assert.ok(calls >= 1);

  // an HTTP error on the poll is a plain failure, not a silent hang
  await assert.rejects(
    X.pollJob("job-4", { fetchFn: async () => ({ ok: false, status: 404, json: async () => ({}) }), sleep: async () => {} }),
    /404/,
  );
})();

// ── the new error code maps to its own Hebrew string ──
assert.equal(X.errorKey(409, "social_login_required"), "ext_err_social_login");
assert.equal(X.errorKey(409, "facebook_not_connected"), "ext_err_fb_connect");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd public-agent && node extract.test.js`
Expected: FAIL — `X.pollJob is not a function`

- [ ] **Step 3: Write minimal implementation**

In `public-agent/extract.js`, add before the `api` object:

```js
  // A browser scrape is queued, not answered inline: POST gives a job id, this
  // asks for it until it settles. Fixed interval, hard deadline — a job that
  // never finishes must surface as an error, not as a spinner forever.
  function pollJob(jobId, opts) {
    var o = opts || {};
    var fetchFn = o.fetchFn || (typeof fetch === "function" ? fetch : null);
    var sleep = o.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var interval = o.intervalMs == null ? 2000 : o.intervalMs;
    // Long enough for a queued job to wait for a slot and run every attempt:
    // cap-2 queue + 3 × (60s start + 45s goto + LLM). Giving up earlier discards
    // a result Driver has already been paid for.
    var deadline = Date.now() + (o.timeoutMs == null ? 300000 : o.timeoutMs);
    function step() {
      return fetchFn("/api/properties/extract/" + encodeURIComponent(jobId), {
        credentials: "include", headers: o.headers || {},
      }).then(function (r) {
        if (!r.ok) throw new Error("poll failed: " + r.status);
        return r.json();
      }).then(function (j) {
        if (j.status === "done" || j.status === "failed") return j;
        if (Date.now() > deadline) throw new Error("poll timeout");
        return sleep(interval).then(step);
      });
    }
    return step();
  }
```

Extend `errorKey`:

```js
  function errorKey(status, code) {
    if (code === "social_login_required") return "ext_err_social_login";
    if (code === "facebook_not_connected") return "ext_err_fb_connect";
    if (code === "page_unreadable") return "ext_err_unreadable";
    if (code === "extract_limit") return "ext_err_limit";
    return "ext_err_unavailable";
  }
```

Add `pollJob: pollJob,` to the `api` object.

- [ ] **Step 4: Add the Hebrew strings**

In `public-agent/form-i18n.js`, add to the `"he"` map (and the matching entry in every other language map the file defines, translated):

```
"ext_stage_open":"פותחים את הדף…",
"ext_stage_read":"קוראים את המודעה…",
"ext_stage_photos":"מחפשים תמונות…",
"ext_stage_slow":"לוקח קצת יותר מהרגיל — עוד רגע. בינתיים אפשר להדביק את הטקסט למטה.",
"ext_err_social_login":"כדי לקרוא פוסט מקבוצה פורלי צריכה להיות מחוברת לחשבון הפייסבוק שלכם. הכי מהיר: הדביקו כאן את טקסט הפוסט.",
```

- [ ] **Step 5: Handle 202 in the wizard**

In `public-agent/create.html`, inside `runExtract`, replace the `.then(function (res) {` body's opening so a 202 goes through the poll and everything else stays exactly as it is:

```js
    }).then(function (res) {
      if (res.status === 202 && res.body.job_id) {
        // The button keeps the short "working" label (a sentence in a gold
        // button wraps on a phone); a muted line under it advances so 60–90s
        // reads as progress, and the manual path stays one tap away.
        var stage = $("#extractStage"); // a muted <p> under the button, added next to #extractErr
        var stages = [[0, "ext_stage_open"], [15000, "ext_stage_read"], [35000, "ext_stage_photos"], [60000, "ext_stage_slow"]];
        var timers = stages.map(function (st) { return setTimeout(function () { stage.textContent = FT(st[1]); }, st[0]); });
        return X.pollJob(res.body.job_id, { headers: uploadHeaders }).then(function (j) {
          timers.forEach(clearTimeout); stage.textContent = "";
          if (j.status === "failed") {
            showExtractErr(X.errorKey(409, j.error_code));
            revealManual();
            return null;
          }
          return { status: 200, ok: true, body: j };
        }).catch(function () {
          showExtractErr("ext_err_unavailable"); revealManual(); return null;
        });
      }
      return res;
    }).then(function (res) {
      if (!res) return;
      if (!res.ok) {
        showExtractErr(X.errorKey(res.status, res.body.error));
        if (res.status === 422 || res.status === 409) $("#extractInput").focus(); else revealManual();
        return;
      }
      if (res.body.source === "scrape" || res.body.source === "facebook" || res.body.source === "driver") extractedFromUrl = true;
      X.fillFields(res.body.fields, $);
      syncDealButtons(); updatePriceLabel(); renderPriceChips();
      if (!$("#pDesc").value.trim()) $("#pDesc").value = String(res.body.description || "").slice(0, 2000);
      (res.body.photos || []).forEach(function (p) { addImportedPhoto(p.url); });
      showMissingCard(X.missingFor(res.body.missing, $, isDemo));
      updateLivePreview();
    }).catch(function () {
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd public-agent && node extract.test.js && node loader.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add public-agent/extract.js public-agent/extract.test.js public-agent/create.html public-agent/form-i18n.js
git commit -m "feat(wizard): poll queued browser extracts and show their progress"
```

---

### Task 9: Live verification against a real listing

Unit tests prove the wiring; only a real run proves the scrape. A run that "worked" but read the wrong element is worse than one that failed loudly.

**Files:**
- Create: `scripts/driver-extract.local.js`

**Interfaces:**
- Consumes: `server/listing-sources.resolve`, `server/listing-extract.parseListing`, `server/driver-browser.getSession`.
- Produces: nothing importable. Exits non-zero when the result was not verified.

- [ ] **Step 1: Write the script**

Create `scripts/driver-extract.local.js`:

```js
/*
 * scripts/driver-extract.local.js — one real scrape, end to end.
 *
 *   DRIVER_API_KEY=… ANTHROPIC_API_KEY=… node scripts/driver-extract.local.js <url>
 *
 * Checks what the unit tests cannot: that the page actually renders, that the
 * fields are the RIGHT fields, and that the session was really stopped.
 * Exits non-zero on anything unproven — this is meant for CI too.
 */
const { resolve } = require("../server/listing-sources");
const { parseListing } = require("../server/listing-extract");
const driver = require("../server/driver-browser");

const url = process.argv[2] || "https://www.yad2.co.il/realestate/forsale";

(async () => {
  if (!process.env.DRIVER_API_KEY) { console.error("set DRIVER_API_KEY"); process.exit(2); }

  const before = await driver.listSessions("active").catch(() => ({ sessions: [] }));
  console.log(`active sessions before: ${(before.sessions || []).length}`);

  const source = await resolve({ url }, { jobId: "local-verify" });
  console.log(`source=${source.source} text=${source.text.length} chars photos=${source.photos.length}`);
  console.log(source.text.slice(0, 400));

  const parsed = await parseListing(source.text);
  console.log("fields:", JSON.stringify(parsed.fields, null, 2));
  console.log("missing:", parsed.missing.join(", ") || "(none)");

  // The checks, in order of what would embarrass us most.
  if (source.text.length < 200) { console.error("FAIL: page text is too short to be a listing"); process.exit(1); }
  if (!parsed.fields.price && !parsed.fields.rooms) { console.error("FAIL: neither price nor rooms was read"); process.exit(1); }

  const after = await driver.listSessions("active").catch(() => ({ sessions: [] }));
  const leaked = (after.sessions || []).filter((s) => String(s.note || "").startsWith("forly-extract:"));
  if (leaked.length) {
    console.error(`FAIL: ${leaked.length} session(s) still active: ${leaked.map((s) => s.sessionId).join(", ")}`);
    process.exit(1);
  }
  console.log("OK: fields read and no session left running");
})().catch((e) => { console.error(`FAIL: ${e.code || ""} ${e.message}`); process.exit(1); });
```

- [ ] **Step 2: Run it against a real Yad2 listing**

Open yad2.co.il, copy a real listing URL (`https://www.yad2.co.il/item/<id>`), then:

```bash
cd /home/user/forly-backend
DRIVER_API_KEY=$DRIVER_API_KEY node scripts/driver-extract.local.js "https://www.yad2.co.il/item/<id>"
```

Expected: `OK: fields read and no session left running`, and the printed `fields` match what the listing page actually shows (check price, rooms, floor by eye — this is the step that catches reading the wrong element).

- [ ] **Step 3: Repeat for Madlan**

```bash
DRIVER_API_KEY=$DRIVER_API_KEY node scripts/driver-extract.local.js "https://www.madlan.co.il/listings/<id>"
```

Expected: same. If the page comes back as a challenge or a near-empty body, escalate by hand once — re-run with `type: "hosted_stealth"` by temporarily passing `browserType` in the script's `resolve` call — and record which rung the site needs in the spike findings file.

- [ ] **Step 4: Confirm the session record in the dashboard**

```bash
curl -sS "https://api.driver.dev/v1/browser/sessions?status=completed&pageSize=5" \
  -H "Authorization: Bearer $DRIVER_API_KEY"
```

Expected: the run's session shows `status: "completed"` with a `stoppedAt` and a non-null `bandwidthBytes`.

- [ ] **Step 5: Commit**

```bash
git add scripts/driver-extract.local.js docs/superpowers/plans/2026-09-22-driver-spike-findings.md
git commit -m "test(driver): add live listing-extract verification script"
```

---

## Phase 2 — the embedded browser

### Task 10: Connection endpoints for the embedded browser

**Files:**
- Create: `server/routes/connections-browser.js`
- Create: `server/routes/connections-browser.test.js`
- Modify: `server/driver-browser.js` (add `attachPage`)
- Modify: `server/driver-browser.test.js` (cover it)
- Modify: `server/index.js` (mount the router)
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Consumes: `driver-browser.createSession/getSession/stopSession`, new `driver-browser.attachPage(sessionId, fn, deps)`, `listing-driver._test.isLoginWall`, `db.getConnection/setConnection`.
- Produces:
  - `POST /api/connections/browser/start` body `{platform, consent: true}` → `200 {platform, session_id, view_url, expires_in}`; `400 {error:"consent_required"}` without `consent: true`. Persists `browser_consent_at` and `browser_consent_version` on the connection doc.
  - `DELETE /api/connections/browser/:platform` → stops every running campaign for the phone, clears `<platform>_browser_connected_at`, deletes the Driver profile (`DELETE /v1/browser/profiles/<name>` — confirm the exact endpoint in Task 1; if Driver has none, the profile is overwritten by a fresh empty session with `persist:true`), and records `disconnected_at`. `200 {state:"none"}`.
  - `GET /api/connections/browser/:platform/status` → `200 {state: "none"|"open"|"connected", connected_at?}`
  - `POST /api/connections/browser/:platform/finish` → `200 {state:"connected"}` or `409 {error:"not_logged_in"}`
  - `attachPage(sessionId, fn, deps) -> Promise<T>` — connects to an **already running** session and does **not** stop it.
  - `PLATFORMS` — `{ facebook: {loginUrl, checkUrl}, instagram: {...}, tiktok, linkedin, x }`

- [ ] **Step 1: Write the failing test**

Create `server/routes/connections-browser.test.js`:

```js
/* routes/connections-browser.js — the embedded login browser. No network:
   driver and db are fakes. */
const assert = require("assert");
const express = require("express");
const http = require("http");
const createRouter = require("./connections-browser");

const PHONE = "0500000000";
const requireAuth = () => (req, res, next) => { req.user = { userId: PHONE }; next(); };

function makeApp(overrides) {
  const app = express();
  app.use(express.json());
  app.use("/api/connections/browser", createRouter(Object.assign({ requireAuth, authSecret: "s" }, overrides)));
  return app;
}
function call(app, method, path, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const req = http.request({ port: server.address().port, path, method, headers: { "content-type": "application/json" } }, (res) => {
        let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(d || "{}") }); });
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

(async () => {
  // ── start: creates a persisted-profile session and hands back the view URL ──
  let created = null;
  const conn = {};
  const app = makeApp({
    driver: {
      createSession: async (opts) => { created = opts; return { sessionId: "s1", status: "active", cdpUrl: "wss://node/abc" }; },
      getSession: async () => ({ sessionId: "s1", status: "active", cdpUrl: "wss://node/abc" }),
      stopSession: async () => {},
      attachPage: async () => { throw new Error("not used here"); },
    },
    db: { getConnection: async () => conn, setConnection: async (p, patch) => Object.assign(conn, patch) },
  });
  const noConsent = await call(app, "POST", "/api/connections/browser/start", { platform: "facebook" });
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.body.error, "consent_required");
  const started = await call(app, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true });
  assert.equal(started.status, 200);
  assert.ok(conn.browser_consent_at, "consent is persisted, not just ticked");
  assert.equal(started.body.session_id, "s1");
  assert.equal(started.body.view_url, "https://viewer.driver.dev?ws=" + encodeURIComponent("wss://node/abc"));
  assert.equal(created.profile.name, require("../profile-name").profileName("facebook", PHONE));
  assert.equal(created.profile.persist, true);
  assert.equal(created.url, "https://www.facebook.com/login");
  assert.ok(created.duration <= 1500, "long enough for SMS 2FA, not an hour");
  assert.ok(String(created.note).startsWith("forly-connect:"));

  // ── an unknown platform is rejected before any session is created ──
  let touched = false;
  const badApp = makeApp({
    driver: { createSession: async () => { touched = true; return {}; } },
    db: { getConnection: async () => ({}), setConnection: async () => {} },
  });
  const bad = await call(badApp, "POST", "/api/connections/browser/start", { platform: "myspace", consent: true });
  assert.equal(bad.status, 400);
  assert.equal(touched, false);

  // ── status reflects the stored connection, and never leaks a cdpUrl ──
  const st = await call(app, "GET", "/api/connections/browser/facebook/status");
  assert.equal(st.status, 200);
  assert.equal(st.body.state, "open");
  assert.ok(!JSON.stringify(st.body).includes("wss://"), "no cdpUrl in a status response");

  // ── finish: logged in → connected, and the session is stopped ──
  const stopped = [];
  const conn2 = { browser_session_facebook: { session_id: "s2", started_at: new Date().toISOString() } };
  const okApp = makeApp({
    driver: {
      getSession: async () => ({ sessionId: "s2", status: "active", cdpUrl: "wss://n/2" }),
      stopSession: async (id) => stopped.push(id),
      attachPage: async (id, fn) => fn({
        goto: async () => {}, url: () => "https://www.facebook.com/me", innerText: async () => "הפיד שלי",
      }),
    },
    db: { getConnection: async () => conn2, setConnection: async (p, patch) => Object.assign(conn2, patch) },
  });
  const fin = await call(okApp, "POST", "/api/connections/browser/facebook/finish");
  assert.equal(fin.status, 200);
  assert.equal(fin.body.state, "connected");
  assert.deepEqual(stopped, ["s2"]);
  assert.ok(conn2.facebook_browser_connected_at);

  // ── finish while still on a login wall → 409, and the session is KEPT: the agent
  //    is probably waiting for an SMS code; killing it forces a second login from a
  //    second IP within minutes ──
  const stopped2 = [];
  const conn3 = { browser_session_facebook: { session_id: "s3" } };
  const wallApp = makeApp({
    driver: {
      getSession: async () => ({ sessionId: "s3", status: "active", cdpUrl: "wss://n/3" }),
      stopSession: async (id) => stopped2.push(id),
      attachPage: async (id, fn) => fn({
        goto: async () => {}, url: () => "https://www.facebook.com/login/?next=%2Fme", innerText: async () => "התחברות",
      }),
    },
    db: { getConnection: async () => conn3, setConnection: async (p, patch) => Object.assign(conn3, patch) },
  });
  const notIn = await call(wallApp, "POST", "/api/connections/browser/facebook/finish");
  assert.equal(notIn.status, 409);
  assert.equal(notIn.body.error, "not_logged_in");
  assert.deepEqual(stopped2, [], "session kept alive for another try");
  assert.ok(conn3.browser_session_facebook, "still recorded as open");
  assert.ok(!conn3.facebook_browser_connected_at);

  // ── disconnect: stops campaigns, clears the connection, deletes the profile ──
  const deleted = [];
  const conn4 = { facebook_browser_connected_at: "2026-09-01T00:00:00Z" };
  const stoppedCampaigns = [];
  const discApp = makeApp({
    driver: { deleteProfile: async (name) => deleted.push(name), stopSession: async () => {} },
    db: {
      getConnection: async () => conn4, setConnection: async (p, patch) => Object.assign(conn4, patch),
      listPostingCampaignsByPhone: async () => [{ id: "c1", status: "running" }, { id: "c2", status: "completed" }],
    },
    campaigns: { stop: async (id) => stoppedCampaigns.push(id) },
  });
  const disc = await call(discApp, "DELETE", "/api/connections/browser/facebook");
  assert.equal(disc.status, 200);
  assert.deepEqual(stoppedCampaigns, ["c1"], "only the live campaign is stopped");
  assert.equal(deleted.length, 1);
  assert.equal(conn4.facebook_browser_connected_at, null);
  assert.ok(conn4.facebook_browser_disconnected_at);

  console.log("routes/connections-browser.test.js ok");
})();
```

Append to `server/driver-browser.test.js`, before the final `console.log`:

```js
  // ── attachPage joins a RUNNING session and must not stop it ──
  const stops = [];
  const attachDeps = {
    apiKey: "k", sleep: async () => {},
    fetchFn: async (url, init) => {
      if ((init && init.method) === "DELETE") { stops.push(url); return ok({ success: true }); }
      return ok({ sessionId: "s9", status: "active", cdpUrl: "ws://z" });
    },
    connectOverCDP: async () => ({ contexts: () => [{ pages: () => [{ marker: "live" }] }], close: async () => {} }),
  };
  assert.equal(await D.attachPage("s9", async (p) => p.marker, attachDeps), "live");
  assert.equal(stops.length, 0, "attachPage must leave the session running");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node routes/connections-browser.test.js`
Expected: FAIL with `Cannot find module './connections-browser'`

- [ ] **Step 3: Add `attachPage` to `driver-browser.js`**

```js
/*
 * Join a session that is ALREADY running and leave it running. This is the
 * embedded-login case: the agent is typing into that browser right now, so the
 * finally that withPage guarantees would be exactly wrong here.
 */
async function attachPage(sessionId, fn, deps = {}) {
  const session = await waitForActive(await getSession(sessionId, deps), deps);
  const connect = deps.connectOverCDP || require("patchright").chromium.connectOverCDP;
  const browser = await connect(session.cdpUrl);
  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());
    return await fn(page, session);
  } finally {
    await browser.close(); // our connection only — the agent's session stays up
  }
}
```

Add `attachPage` to `module.exports`.

- [ ] **Step 4: Write the router**

Create `server/routes/connections-browser.js`:

```js
/*
 * routes/connections-browser.js — "connect my account", with a real browser.
 *
 * Yad2 and Madlan are readable logged-out; a Facebook group post is not. Rather
 * than ask an agent for their password (which we would then have to hold), we
 * start a browser with a PERSISTED PROFILE and show it to them inside Forly.
 * They log in themselves, 2FA and all. The cookies live in the Driver profile;
 * Forly stores a session id and a timestamp, and never a credential.
 *
 * The cdpUrl is the one secret here: anyone holding it drives that browser. It
 * is returned once, to the authenticated owner, and never stored or logged.
 */
const express = require("express");
const driverLive = require("../driver-browser");
const dbLive = require("../db");
const { isLoginWall } = require("../listing-driver")._test;

const SESSION_SECONDS = 1500; // SMS 2FA on a phone that is also showing the modal takes a while
const CONSENT_VERSION = "2026-09-24";
const { profileName } = require("../profile-name");

// Facebook only: it is the one platform a feature posts to. Add a platform
// here when a feature needs it, not before.
const PLATFORMS = {
  facebook: { loginUrl: "https://www.facebook.com/login", checkUrl: "https://www.facebook.com/me" },
};

module.exports = function createConnectionsBrowserRouter(ctx) {
  const { requireAuth, authSecret } = ctx;
  const driver = ctx.driver || driverLive;
  const db = ctx.db || dbLive;
  const router = express.Router();

  const viewUrl = (cdpUrl) => `https://viewer.driver.dev?ws=${encodeURIComponent(cdpUrl)}`;
  const campaigns = ctx.campaigns || require("../posting-campaign");

  router.post("/start", requireAuth(authSecret), async (req, res) => {
    const platform = String((req.body && req.body.platform) || "");
    const spec = PLATFORMS[platform];
    if (!spec) return res.status(400).json({ error: "invalid_input" });
    if (!(req.body && req.body.consent === true)) return res.status(400).json({ error: "consent_required" });
    const phone = req.user.userId;

    let session;
    try {
      session = await driver.createSession({
        country: "IL",
        duration: SESSION_SECONDS,
        url: spec.loginUrl,
        profile: { name: profileName(platform, phone), persist: true },
        note: `forly-connect:${platform}`, // never the phone
      });
    } catch (e) {
      const status = e.status === 402 || e.status === 403 ? 503 : 503;
      return res.status(status).json({ error: "extract_unavailable" });
    }

    // Top-level keys, not a nested map: setConnection is a merge write, and a
    // merge cannot delete a nested key — finish/disconnect need to clear this.
    await db.setConnection(phone, {
      [`browser_session_${platform}`]: { session_id: session.sessionId, started_at: new Date().toISOString() },
      browser_consent_at: new Date().toISOString(),
      browser_consent_version: CONSENT_VERSION,
    });

    // view_url carries the cdpUrl: response only, never a log line, never Firestore.
    return res.json({
      platform,
      session_id: session.sessionId,
      view_url: viewUrl(session.cdpUrl),
      expires_in: SESSION_SECONDS,
    });
  });

  router.get("/:platform/status", requireAuth(authSecret), async (req, res) => {
    const platform = String(req.params.platform);
    if (!PLATFORMS[platform]) return res.status(400).json({ error: "invalid_input" });
    const conn = (await db.getConnection(req.user.userId)) || {};
    const connectedAt = conn[`${platform}_browser_connected_at`] || null;
    if (connectedAt) return res.json({ state: "connected", connected_at: connectedAt });
    const open = conn[`browser_session_${platform}`];
    return res.json({ state: open ? "open" : "none" });
  });

  router.post("/:platform/finish", requireAuth(authSecret), async (req, res) => {
    const platform = String(req.params.platform);
    const spec = PLATFORMS[platform];
    if (!spec) return res.status(400).json({ error: "invalid_input" });
    const phone = req.user.userId;
    const conn = (await db.getConnection(phone)) || {};
    const open = conn[`browser_session_${platform}`];
    if (!open || !open.session_id) return res.status(409).json({ error: "no_open_session" });

    let loggedIn = false, label = null;
    try {
      ({ loggedIn, label } = await driver.attachPage(open.session_id, async (page) => {
        await page.goto(spec.checkUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        const text = await page.innerText("body");
        if (isLoginWall(page.url(), text)) return { loggedIn: false, label: null };
        // The profile's display name, so the campaign card can say "posting as …"
        // and an agent with two accounts can see which one they connected.
        const title = await page.title().catch(() => "");
        return { loggedIn: true, label: String(title || "").split("|")[0].trim().slice(0, 60) || null };
      }));
    } catch (e) {
      // A session that already ended reads as expired, not as "not logged in".
      return res.status(409).json({ error: "session_expired" });
    }

    // Not logged in yet: KEEP the session. The agent is most likely waiting for
    // an SMS code; stopping here forces a second login from a second IP.
    if (!loggedIn) return res.status(409).json({ error: "not_logged_in" });

    await driver.stopSession(open.session_id);
    const first = conn[`${platform}_browser_first_connected_at`] || new Date().toISOString();
    await db.setConnection(phone, {
      [`${platform}_browser_connected_at`]: new Date().toISOString(),
      [`${platform}_browser_first_connected_at`]: first, // warm-up counts from here, not from every reconnect
      [`${platform}_identity_label`]: label,
      [`browser_session_${platform}`]: null,
    });
    return res.json({ state: "connected", identity_label: label });
  });

  // The way out. Stops what is running, forgets the login, deletes the profile
  // at Driver. Required by the privacy law the plan's intro names, and by
  // common decency: the agent must be able to take back what they handed over.
  router.delete("/:platform", requireAuth(authSecret), async (req, res) => {
    const platform = String(req.params.platform);
    if (!PLATFORMS[platform]) return res.status(400).json({ error: "invalid_input" });
    const phone = req.user.userId;
    const conn = (await db.getConnection(phone)) || {};
    for (const c of await db.listPostingCampaignsByPhone(phone)) {
      if (["running", "paused"].includes(c.status)) await campaigns.stop(c.id, { db });
    }
    const open = conn[`browser_session_${platform}`];
    if (open && open.session_id) await driver.stopSession(open.session_id);
    await driver.deleteProfile(profileName(platform, phone));
    await db.setConnection(phone, {
      [`${platform}_browser_connected_at`]: null,
      [`${platform}_browser_disconnected_at`]: new Date().toISOString(),
      [`${platform}_identity_label`]: null,
      [`browser_session_${platform}`]: null,
    });
    return res.json({ state: "none" });
  });

  return router;
};

module.exports.PLATFORMS = PLATFORMS;
```

`attachPage` and `withPage` in `driver-browser.js` must also acquire `profile-lock.tryAcquire(phone)` when `opts.profile` is set — pass `phone` in `deps` — and release in their `finally`; `/start` answers `409 {error:"profile_busy"}` when a post or extract currently holds the profile. Add `deleteProfile(name, deps)` to `driver-browser.js` (`DELETE /v1/browser/profiles/<name>`; adjust to what Task 1 finds) — like `stopSession`, it logs rather than throws.

- [ ] **Step 5: Mount it**

In `server/index.js`, next to the other router mounts:

```js
const createConnectionsBrowserRouter = require("./routes/connections-browser");
app.use("/api/connections/browser", createConnectionsBrowserRouter({ requireAuth, authSecret: AUTH_SECRET }));
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && node routes/connections-browser.test.js && node driver-browser.test.js`
Expected: both PASS.

- [ ] **Step 7: Add to the test chain and commit**

Append ` && node routes/connections-browser.test.js` to `scripts.test`.

```bash
cd server && npm test
git add server/routes/connections-browser.js server/routes/connections-browser.test.js server/driver-browser.js server/driver-browser.test.js server/index.js server/package.json
git commit -m "feat(connections): start a persisted-profile browser for account login"
```

---

### Task 11: The embedded browser in the dashboard

Task 1 decided which branch to build. Read `docs/superpowers/plans/2026-09-22-driver-spike-findings.md` and implement **Branch A if `VIEWER_EMBEDDABLE=yes`, Branch B if `no`**. Everything outside the viewer element itself — the card, the warning, the "I'm done" button, the status polling — is identical in both.

**Files:**
- Modify: `public-agent/distribution.html:80-84` (a new card after `connectCard`)
- Modify: `public-agent/distribution.js`
- Modify: `public-agent/app.css`
- Modify: `public-agent/form-i18n.js`

**Interfaces:**
- Consumes: `POST /api/connections/browser/start`, `GET /api/connections/browser/:platform/status`, `POST /api/connections/browser/:platform/finish`.
- Produces: no exports. A `#browserConnectCard` section and a `#browserModal` dialog.

- [ ] **Step 1: Add the card markup**

`distribution.html` loads only `distribution.js` — no `form-i18n.js`, no `FT`, no `FLY`. Strings are inline Hebrew, as everything else on that page is, and the page's own `toast()` is used. The card is Facebook-only and named by what it is, so it cannot be confused with the Page-OAuth card above it (rename that card's heading to **"הדף העסקי בפייסבוק"** in the same change).

In `public-agent/distribution.html`, immediately after the existing `connectCard` div (line 84):

```html
  <div class="card dist-card" id="browserConnectCard" hidden>
    <h2>החשבון האישי בפייסבוק <span class="conn-chip" id="browserConnChip"></span></h2>
    <p class="muted">כדי לקרוא פוסטים מקבוצות ולפרסם בהן, פורלי צריכה להיות מחוברת לחשבון האישי שלכם — לא רק לדף העסקי. מתחברים כאן פעם אחת, כמו בדפדפן רגיל.</p>
    <p class="muted">הסיסמה נשארת אצלכם: היא לא עוברת דרך פורלי ולא נשמרת אצלנו.</p>
    <p class="muted small">פרסום אוטומטי בקבוצות נעשה על אחריותכם — נסביר בדיוק לפני שמתחילים.</p>
    <label class="consent-line"><input type="checkbox" id="browserConsent"> <span>הבנתי, ואני רוצה לחבר את החשבון</span></label>
    <div class="conn-row">
      <button class="btn btn-gold" id="browserConnectBtn">חיבור החשבון האישי בפייסבוק</button>
      <button class="btn btn-danger" id="browserDisconnectBtn" hidden>ניתוק החשבון</button>
      <span class="muted small" id="browserIdentity"></span>
    </div>
  </div>

  <div class="browser-modal" id="browserModal" hidden role="dialog" aria-modal="true" aria-labelledby="browserModalTitle">
    <div class="browser-modal-inner">
      <header>
        <div>
          <strong id="browserModalTitle">התחברות לפייסבוק</strong>
          <div class="muted small">זה פייסבוק האמיתי. מתחברים כרגיל — פורלי לא רואה את הסיסמה ולא שומרת אותה.</div>
        </div>
        <button class="btn btn-ghost" id="browserModalClose" aria-label="סגירה">✕</button>
      </header>
      <div class="browser-modal-body" id="browserModalBody"></div>
      <footer>
        <span class="muted small" id="browserModalMsg">קיבלתם קוד בסמס? אפשר לצאת לרגע ולחזור — החלון מחכה לכם כמה דקות.</span>
        <button class="btn btn-gold" id="browserDoneBtn">סיימתי להתחבר</button>
      </footer>
    </div>
  </div>
```

- [ ] **Step 2: Add the styles**

Forly is cream and gold (`--bg:#F7F3EC`, `--gold`, `--dark`, `--red`); there are no `--card`/`--muted`/`--line` tokens, and `.btn-danger` already exists as an outline button — do not redefine it. Append to `public-agent/app.css`:

```css
/* Embedded connect browser — a full-bleed dialog, because a real page inside a
   small box is unusable on a phone. dvh, not vh: iOS Safari's bottom bar. */
.browser-modal { position: fixed; inset: 0; background: rgba(20,17,12,.72); display: flex; align-items: center; justify-content: center; z-index: 90; }
.browser-modal[hidden] { display: none; }
.browser-modal-inner { background: var(--bg); border-radius: var(--radius); width: min(1100px, 96vw); height: min(760px, 92dvh); display: flex; flex-direction: column; overflow: hidden; }
.browser-modal-inner > header, .browser-modal-inner > footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; }
.browser-modal-inner > footer { padding-bottom: calc(10px + env(safe-area-inset-bottom)); }
.browser-modal-body { flex: 1; min-height: 0; background: #fff; }
.browser-modal-body iframe { width: 100%; height: 100%; border: 0; display: block; }
.browser-modal-body .popup-note { padding: 32px; text-align: center; color: var(--ink-soft, #6b655c); line-height: 1.7; }
.conn-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.consent-line { display: flex; gap: 8px; align-items: flex-start; margin: 10px 0; line-height: 1.5; }
@media (max-width: 640px) { .browser-modal-inner { width: 100vw; height: 100dvh; border-radius: 0; } }
```

- [ ] **Step 3 (Branch A — `VIEWER_EMBEDDABLE=yes`): iframe the viewer**

Append to `public-agent/distribution.js` (inside the file's IIFE, after the existing connect-card code, using its `$`, `api` and `toast`):

```js
  // ── the personal-account browser ──
  // The viewer is a live view of a real Chrome in Driver's cloud: the agent
  // types their own password into it, and it never touches our server.
  const bModal = $("browserModal"), bBody = $("browserModalBody"), bMsg = $("browserModalMsg");
  let bOpen = false;

  function openBrowser(viewUrl) {
    bBody.innerHTML = "";
    const frame = document.createElement("iframe");
    // No allow-same-origin: a foreign origin with no business in this page's storage.
    frame.setAttribute("sandbox", "allow-scripts allow-popups");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.src = viewUrl;
    bBody.appendChild(frame);
    bModal.hidden = false; bOpen = true;
  }
  function closeBrowser() { bModal.hidden = true; bBody.innerHTML = ""; bOpen = false; }

  async function refreshBrowserChip() {
    try {
      const j = await api("/api/connections/browser/facebook/status");
      const on = j.state === "connected";
      $("browserConnChip").textContent = on ? "מחובר" : "";
      $("browserIdentity").textContent = on && j.identity_label ? `מחובר בתור ${j.identity_label}` : "";
      $("browserDisconnectBtn").hidden = !on;
      $("browserConnectBtn").textContent = on ? "חיבור מחדש" : "חיבור החשבון האישי בפייסבוק";
    } catch (e) { /* card stays in its default state */ }
  }

  $("browserConnectBtn").addEventListener("click", async function () {
    if (!$("browserConsent").checked) { toast("סמנו את האישור שמעל הכפתור"); return; }
    const btn = this; btn.disabled = true; btn.textContent = "פותחים דפדפן…";
    try {
      const j = await api("/api/connections/browser/start", { method: "POST", body: JSON.stringify({ platform: "facebook", consent: true }) });
      openBrowser(j.view_url);
    } catch (e) {
      toast(e && e.code === "profile_busy" ? "פורלי מפרסמת כרגע מהחשבון — נסו שוב בעוד כמה דקות" : "לא הצלחנו לפתוח דפדפן כרגע — נסו שוב בעוד רגע");
    } finally { btn.disabled = false; refreshBrowserChip(); }
  });

  $("browserDoneBtn").addEventListener("click", async function () {
    const btn = this; btn.disabled = true; bMsg.textContent = "בודקים…";
    try {
      const j = await api("/api/connections/browser/facebook/finish", { method: "POST" });
      toast(j.identity_label ? `החשבון מחובר ✓ (${j.identity_label})` : "החשבון מחובר ✓");
      closeBrowser(); refreshBrowserChip();
    } catch (e) {
      bMsg.textContent = e && e.code === "session_expired"
        ? "עבר יותר מדי זמן והחלון נסגר. פתחו אותו שוב ונסו להתחבר."
        : "נראה שעדיין לא התחברתם — השלימו את ההתחברות בדפדפן ואז לחצו שוב.";
    } finally { btn.disabled = false; }
  });

  $("browserModalClose").addEventListener("click", closeBrowser);
  $("browserDisconnectBtn").addEventListener("click", async function () {
    if (!confirm("לנתק את החשבון? פורלי תפסיק לפרסם ותמחק את ההתחברות השמורה.")) return;
    try { await api("/api/connections/browser/facebook", { method: "DELETE" }); toast("החשבון נותק"); }
    catch (e) { toast("לא הצלחנו לנתק — נסו שוב"); }
    refreshBrowserChip();
  });

  // If the agent leaves for the SMS and comes back, the modal is still here;
  // only when they close it explicitly is the session's fate decided by /finish.
  $("browserConnectCard").hidden = false;
  refreshBrowserChip();
```

`api()` in `distribution.js` throws on non-2xx; make sure the thrown error carries `code` from the JSON body (`e.code = j.error`) — if the file's helper doesn't already, add that one line to it.

- [ ] **Step 3 (Branch B — `VIEWER_EMBEDDABLE=no`): a popup window instead**

Use the exact block above with **only `openBrowser` replaced**:

```js
  function openBrowser(viewUrl) {
    // The viewer refuses to be framed (X-Frame-Options / frame-ancestors), so
    // it opens in its own window. Stripping that header server-side would mean
    // proxying their websocket and defeating a deliberate control.
    const win = window.open(viewUrl, "forly-connect", "width=1200,height=820,noopener");
    bBody.innerHTML = '<p class="popup-note">ההתחברות נפתחה בחלון נפרד. כשסיימתם, חזרו לכאן ולחצו "סיימתי להתחבר".</p>';
    if (!win) bBody.innerHTML = '<p class="popup-note">הדפדפן חסם את החלון — אשרו חלונות קופצים לאתר ונסו שוב.</p>';
    bModal.hidden = false; bOpen = true;
  }
```

- [ ] **Step 4: Content-Security-Policy for the frame**

`security.js` sets no `script-src` today. Add, for `distribution.html` only, `frame-src https://viewer.driver.dev` (Branch A) — the smallest CSP that stops a stray script from framing anything else, without touching the rest of the site's policy. Where `security.js` builds its headers, add the directive when `req.path` ends with `/distribution.html`.

- [ ] **Step 5: Verify by hand in the dashboard**

```bash
cd server && DRIVER_API_KEY=$DRIVER_API_KEY npm run local
```

Open `http://127.0.0.1:8787/agent/distribution.html`, log in as a test agent, pick Facebook, press "פתיחת דפדפן מאובטח".

Expected: a real Chrome appears (framed or in its own window), showing Facebook's login page. Type a **test account's** credentials — never a real agent's. Press "סיימתי להתחבר". Expected: the chip turns to "החשבון מחובר ✓".

Then press it again with a session where you did **not** log in. Expected: "נראה שעדיין לא התחברתם".

- [ ] **Step 6: Confirm nothing leaked**

```bash
grep -rn "cdpUrl\|viewer.driver.dev" server/ --include=*.js | grep -v test | grep -vi "never\|only\|carries"
```

Expected: the only hits are `driver-browser.js` (using it to connect) and `routes/connections-browser.js` (building `view_url` for the response). No `console.log` of either.

- [ ] **Step 7: Commit**

```bash
git add public-agent/distribution.html public-agent/distribution.js public-agent/app.css server/security.js
git commit -m "feat(connections): embed the login browser in the dashboard"
```

---

### Task 12: Prove the connected profile actually reads a group post

The whole of phase 2 rests on one unverified assumption: that Driver's persisted profile keeps Facebook's auth cookies across sessions. The docs say persistent cookies carry over and session-only cookies do not, exactly as in desktop Chrome — whether Facebook's land on the right side of that line is **not** established. This task settles it before anyone depends on it.

**Files:**
- Create: `scripts/driver-connect-check.local.js`
- Modify: `docs/superpowers/plans/2026-09-22-driver-spike-findings.md`

**Interfaces:**
- Consumes: `server/listing-sources.resolve` with a `profileName`.
- Produces: a recorded answer, `PROFILE_COOKIES_PERSIST=<yes|no|partial>`.

- [ ] **Step 1: Write the check script**

Create `scripts/driver-connect-check.local.js`:

```js
/*
 * scripts/driver-connect-check.local.js — does a connected profile still work?
 *
 *   DRIVER_API_KEY=… node scripts/driver-connect-check.local.js <profile-name> <group-post-url>
 *
 * Run it right after connecting, then again the next day. If the second run
 * reports social_login_required, the profile is not keeping the login and the
 * connect flow has to become a recurring prompt rather than a one-time setup.
 */
const { fromDriver } = require("../server/listing-driver");

const [profileName, url] = process.argv.slice(2);

(async () => {
  if (!profileName || !url) { console.error("usage: <profile-name> <group-post-url>"); process.exit(2); }
  try {
    const out = await fromDriver({ url, profileName });
    console.log(`OK: read ${out.text.length} chars and ${out.photos.length} photo(s) as ${profileName}`);
    console.log(out.text.slice(0, 300));
    process.exit(0);
  } catch (e) {
    if (e.code === "social_login_required") { console.error("NOT LOGGED IN: the profile did not keep the session"); process.exit(1); }
    console.error(`FAIL: ${e.code || ""} ${e.message}`);
    process.exit(1);
  }
})();
```

- [ ] **Step 2: Run it immediately after connecting**

Use the test account connected in Task 11, and a post URL from a group that account belongs to.

```bash
cd /home/user/forly-backend
DRIVER_API_KEY=$DRIVER_API_KEY node scripts/driver-connect-check.local.js "facebook-<test-phone>" "https://www.facebook.com/groups/<gid>/posts/<pid>"
```

Expected: `OK: read N chars…`, and the text is the post's actual body. If it says NOT LOGGED IN right after connecting, the profile name in Task 6's `profileFor()` does not match the one Task 10's `/start` created — compare them before looking anywhere else.

- [ ] **Step 3: Run it again after at least 24 hours**

Same command. Record the answer.

- [ ] **Step 4: Write the answer into the findings file**

Append to `docs/superpowers/plans/2026-09-22-driver-spike-findings.md`:

```
PROFILE_COOKIES_PERSIST=<yes|no|partial>

- checked immediately after connect: <ok|not logged in>
- checked after 24h: <ok|not logged in>
- if not yes: the dashboard must show the connection as expired and re-prompt.
  Add a `browser_connection_checked_at` field and a status check before the
  first group scrape of each day.
```

- [ ] **Step 5: Run the whole suite once more and commit**

```bash
cd server && npm test
cd .. && git add scripts/driver-connect-check.local.js docs/superpowers/plans/2026-09-22-driver-spike-findings.md
git commit -m "test(driver): verify a connected profile can read a group post"
git push -u origin claude/zen-davinci-lu4hoq
```

---

## Phase 3 — paced background posting to groups

**What "safe" means here, stated once.** No number below was measured against Facebook; the platform publishes no thresholds and changes its heuristics without notice. [Unverified] The defaults are deliberately slower than a busy human agent, and the design leans on things that *are* known to matter: an account that posts at 3am, posts identical text to twelve groups in an hour, opens a group URL cold and drops a link and vanishes, or keeps going after a warning, gets flagged; one that posts a few varied messages a day during waking hours, from a browser it has logged into before, after scrolling its feed, mostly does not. Task 20 turns the defaults into measured values over 30 days. Until then, slower is the only defensible direction, and any change to a default after a signal goes **down**.

**What the agent sees.** A timeline, never a browser. The embedded browser (Task 11) is the escape hatch when Facebook demands a human, and only then.

### Task 13: `posting-safety.js` — pacing, schedule shape, and signal classification

The anti-ban core. Pure functions, no I/O, and the most thoroughly tested file in the plan: every invariant the product owner is relying on lives here as an assertion.

**Files:**
- Create: `server/posting-safety.js`
- Create: `server/posting-safety.test.js`
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DEFAULTS` — the pacing config (below).
  - `nextSlot({ now, account, candidates, pageId, config, rand }) -> { at: Date, group_url } | { at: null, reason }` where `account = { first_connected_at, halts: [{at, code}], disabled_until_admin: bool, penalty_until: ISO|null, account_aged: bool|null, posted_manually: bool|null, posts: Array<{at, group_url, page_id, ok: boolean|null}> }` (`ok: null` = a reservation from another campaign, not yet posted) and `candidates = Array<{ url, agent_policy: "explicitly_allowed"|"unknown" }>`. Reasons: `disabled`, `penalty`, `signal_cooldown`, `day_skipped`, `daily_cap`, `weekly_cap`, `no_eligible_group`.
  - `isActiveTime(date, config) -> boolean` (hours, Shabbat, holidays)
  - `dayPlan(localDate, config, rand) -> { start_offset_min, target }` — the per-day randomness, derived from a seed so a day's plan is stable across ticks.
  - `classifySignal({ landedUrl, dialogText, alertText }) -> "ok" | "login_required" | "checkpoint" | "captcha" | "rate_limited" | "feature_blocked" | "restricted" | "group_blocked" | "not_member" | "pending_approval"`
  - `SIGNAL_DISABLES = Set(checkpoint, captcha, restricted)`, `SIGNAL_PENALISES = Set(rate_limited, feature_blocked)`, `SIGNAL_SKIPS = Set(group_blocked, not_member, pending_approval)`.

- [ ] **Step 1: Write the failing test**

Create `server/posting-safety.test.js`:

```js
/* posting-safety.js — every pacing promise, as an assertion. Pure, no I/O.
   All times derive from NOW, never from Date.now(): a test that ages with the
   calendar is a test that fails in November. */
const assert = require("assert");
const S = require("./posting-safety");

const NOW = new Date("2026-09-23T10:00:00+03:00"); // Wed
const IL = (iso) => new Date(iso);
const day = (n) => n * 24 * 3600 * 1000;
const cfg = S.DEFAULTS;
const noRand = () => 0.5;
const ok = (url) => ({ url, agent_policy: "explicitly_allowed" });
const account = (o = {}) => Object.assign({
  first_connected_at: new Date(NOW.getTime() - day(90)).toISOString(),
  halts: [], disabled_until_admin: false, penalty_until: null,
  account_aged: true, posted_manually: true, posts: [],
}, o);
const at = (d) => new Date(NOW.getTime() - d).toISOString();

// ── active hours: Israeli waking hours, never Shabbat, never a listed holiday ──
assert.equal(S.isActiveTime(IL("2026-09-23T10:00:00+03:00"), cfg), true, "Wed 10:00");
assert.equal(S.isActiveTime(IL("2026-09-23T03:00:00+03:00"), cfg), false, "Wed 03:00");
assert.equal(S.isActiveTime(IL("2026-09-25T16:00:00+03:00"), cfg), false, "Fri 16:00 — Shabbat");
assert.equal(S.isActiveTime(IL("2026-09-26T12:00:00+03:00"), cfg), false, "Sat noon — Shabbat");
assert.equal(S.isActiveTime(IL("2026-09-25T11:00:00+03:00"), cfg), true, "Fri 11:00 — before Shabbat");
assert.equal(S.isActiveTime(IL("2026-09-21T11:00:00+03:00"), cfg), false, "Yom Kippur 2026 — listed holiday");

// ── the schedule is not periodic: each day has its own start and its own target ──
{
  const a = S.dayPlan("2026-09-23", cfg, Math.random), b = S.dayPlan("2026-09-24", cfg, Math.random);
  assert.ok(a.start_offset_min >= 0 && a.start_offset_min <= cfg.day_start_jitter_min);
  assert.ok(a.target >= 0 && a.target <= cfg.daily_cap);
  assert.deepEqual(S.dayPlan("2026-09-23", cfg, Math.random), a, "a day's plan is stable across ticks");
  let skipped = 0;
  for (let i = 1; i <= 200; i++) if (S.dayPlan(`2026-10-${String((i % 28) + 1).padStart(2, "0")}-${i}`, cfg, Math.random).target === 0) skipped++;
  assert.ok(skipped > 20 && skipped < 80, `about one day in five is skipped, got ${skipped}/200`);
}

// ── disabled and penalised accounts never get a slot, whatever the caps say ──
assert.equal(S.nextSlot({ now: NOW, account: account({ disabled_until_admin: true }), candidates: [ok("g")], pageId: "p", config: cfg, rand: noRand }).reason, "disabled");
assert.equal(S.nextSlot({ now: NOW, account: account({ halts: [{ at: at(day(3)), code: "rate_limited" }, { at: at(day(20)), code: "rate_limited" }] }), candidates: [ok("g")], pageId: "p", config: cfg, rand: noRand }).reason, "disabled", "two halts in 30 days = disabled");
assert.equal(S.nextSlot({ now: NOW, account: account({ penalty_until: at(-day(5)) }), candidates: [ok("g")], pageId: "p", config: cfg, rand: noRand }).reason, "penalty");

// ── warm-up: a freshly connected account, or one that answered "no", posts once a day ──
{
  const one = [{ at: at(3600000), group_url: "a", page_id: "p", ok: true }];
  const fresh = account({ first_connected_at: at(day(2)), posts: one });
  assert.equal(S.nextSlot({ now: NOW, account: fresh, candidates: [ok("g")], pageId: "p", config: cfg, rand: noRand }).reason, "daily_cap", "week 1: one a day");
  const young = account({ account_aged: false, posts: one });
  assert.equal(S.nextSlot({ now: NOW, account: young, candidates: [ok("g")], pageId: "p", config: cfg, rand: noRand }).reason, "daily_cap", "a young Facebook account is treated like a fresh connection");
  const mature = account({ posts: one });
  const m = S.nextSlot({ now: NOW, account: mature, candidates: [ok("g")], pageId: "p", config: cfg, rand: noRand });
  assert.ok(m.at || m.reason === "day_skipped", "a mature account may post again today (unless today is a skipped day)");
}

// ── minimum gap, jitter only adds, and reservations from other campaigns count ──
{
  const acct = account({ posts: [{ at: at(10 * 60000), group_url: "g0", page_id: "p0", ok: true }] });
  const cfgNoSkip = Object.assign({}, cfg, { skip_day_probability: 0, day_start_jitter_min: 0 });
  const slot = S.nextSlot({ now: NOW, account: acct, candidates: [ok("g1")], pageId: "p1", config: cfgNoSkip, rand: () => 0 });
  assert.ok((slot.at.getTime() - new Date(acct.posts[0].at).getTime()) / 60000 >= cfg.min_gap_minutes);
  const later = S.nextSlot({ now: NOW, account: acct, candidates: [ok("g1")], pageId: "p1", config: cfgNoSkip, rand: () => 1 });
  assert.ok(later.at.getTime() > slot.at.getTime(), "rand=1 pushes later, never earlier");
  const reserved = account({ posts: [{ at: at(-5 * 60000), group_url: "g0", page_id: "p0", ok: null }] }); // another campaign, 5 min from now
  const r = S.nextSlot({ now: NOW, account: reserved, candidates: [ok("g1")], pageId: "p1", config: cfgNoSkip, rand: () => 0 });
  assert.ok((r.at.getTime() - (NOW.getTime() + 5 * 60000)) / 60000 >= cfg.min_gap_minutes, "paced against the reservation");
}

// ── caps count attempts and reservations, not successes ──
{
  const posts = [];
  for (let i = 0; i < cfg.daily_cap; i++) posts.push({ at: at(3600000 * (i + 1)), group_url: `g${i}`, page_id: "p", ok: i % 2 === 0 });
  const cfgNoSkip = Object.assign({}, cfg, { skip_day_probability: 0 });
  assert.equal(S.nextSlot({ now: NOW, account: account({ posts }), candidates: [ok("z")], pageId: "p", config: cfgNoSkip, rand: noRand }).reason, "daily_cap");
  const week = [];
  for (let i = 0; i < cfg.weekly_cap; i++) week.push({ at: at(day(1) + i * 3600000), group_url: `w${i}`, page_id: "p", ok: true });
  assert.equal(S.nextSlot({ now: NOW, account: account({ posts: week }), candidates: [ok("z")], pageId: "p", config: cfgNoSkip, rand: noRand }).reason, "weekly_cap");
}

// ── group cooldowns pick the other group; unknown-policy groups are eligible (the agent listed them) ──
{
  const cfgNoSkip = Object.assign({}, cfg, { skip_day_probability: 0 });
  const acct = account({ posts: [{ at: at(day(2)), group_url: "g1", page_id: "other", ok: true }] });
  assert.equal(S.nextSlot({ now: NOW, account: acct, candidates: [ok("g1"), { url: "g2", agent_policy: "unknown" }], pageId: "p", config: cfgNoSkip, rand: noRand }).group_url, "g2");
  assert.equal(S.nextSlot({ now: NOW, account: acct, candidates: [ok("g1")], pageId: "p", config: cfgNoSkip, rand: noRand }).reason, "no_eligible_group");
  const old = account({ posts: [{ at: at(day(10)), group_url: "g1", page_id: "p", ok: true }] });
  assert.equal(S.nextSlot({ now: NOW, account: old, candidates: [ok("g1")], pageId: "p", config: cfgNoSkip, rand: noRand }).reason, "no_eligible_group", "same property → same group inside 14 days");
}

// ── outside active hours, the slot is inside the next window ──
{
  const night = IL("2026-09-23T23:30:00+03:00");
  const cfgNoSkip = Object.assign({}, cfg, { skip_day_probability: 0 });
  const slot = S.nextSlot({ now: night, account: account(), candidates: [ok("g1")], pageId: "p", config: cfgNoSkip, rand: noRand });
  assert.equal(S.isActiveTime(slot.at, cfg), true);
  assert.ok(slot.at.getTime() > night.getTime() + 8 * 3600000);
}

// ── signals: scoped input, and the outcomes that matter are all there ──
const sig = (o) => S.classifySignal(Object.assign({ landedUrl: "https://www.facebook.com/groups/1", dialogText: "", alertText: "" }, o));
assert.equal(sig({}), "ok");
assert.equal(sig({ landedUrl: "https://www.facebook.com/login/?next=x" }), "login_required");
assert.equal(sig({ landedUrl: "https://www.facebook.com/checkpoint/1501092823525282/" }), "checkpoint");
assert.equal(sig({ landedUrl: "https://www.facebook.com/checkpoint/block/" }), "restricted", "a disabled account is not a cookie expiry");
assert.equal(sig({ dialogText: "Confirm you're human" }), "captcha");
assert.equal(sig({ alertText: "You're temporarily blocked from posting" }), "rate_limited");
assert.equal(sig({ alertText: "אתם חסומים זמנית" }), "rate_limited");
assert.equal(sig({ dialogText: "You can't use this feature right now" }), "feature_blocked");
assert.equal(sig({ dialogText: "לא ניתן להשתמש בתכונה זו כרגע" }), "feature_blocked");
assert.equal(sig({ alertText: "Your post is pending approval" }), "pending_approval");
assert.equal(sig({ alertText: "הפוסט שלך ממתין לאישור" }), "pending_approval");
assert.equal(sig({ dialogText: "You can't post in this group" }), "group_blocked");
assert.equal(sig({ dialogText: "Join group to post" }), "not_member");
// what the feed says is NOT a signal: another member's post must never halt an account
assert.equal(S.classifySignal({ landedUrl: "https://www.facebook.com/groups/1", dialogText: "", alertText: "", feedText: "אתם חסומים זמנית security check join group" }), "ok");
for (const x of ["checkpoint", "captcha", "restricted"]) assert.ok(S.SIGNAL_DISABLES.has(x));
for (const x of ["rate_limited", "feature_blocked"]) assert.ok(S.SIGNAL_PENALISES.has(x));
for (const x of ["group_blocked", "not_member", "pending_approval"]) assert.ok(S.SIGNAL_SKIPS.has(x));
assert.ok(!S.SIGNAL_DISABLES.has("login_required") && !S.SIGNAL_PENALISES.has("login_required"), "a cookie expiry is a reconnect, not a punishment");

console.log("posting-safety.test.js ok");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node posting-safety.test.js`
Expected: FAIL with `Cannot find module './posting-safety'`

- [ ] **Step 3: Write the implementation**

Create `server/posting-safety.js`:

```js
/*
 * posting-safety.js — when may this account post, and where.
 *
 * Pure functions. Everything that decides whether a post happens lives here,
 * so the promise "the agent's account never looks like a bot" is a set of unit
 * tests rather than a hope.
 *
 * [Unverified] None of DEFAULTS was measured against Facebook. They sit well
 * below what an active human agent does by hand; Task 20 calibrates over 30
 * days. After any signal, a default only ever moves DOWN.
 *
 * Three ideas carry the design:
 *  - shape, not just rate: a real person does not start at 09:00 sharp every
 *    day and post the same count; dayPlan() gives each day its own start,
 *    its own target, and a one-in-five chance of nothing at all;
 *  - the account's history matters more than ours: two questions at connect
 *    time (is the Facebook account older than six months? has it posted in
 *    these groups by hand?) double the warm-up when the answer is no;
 *  - a checkpoint is a stop, not a pause: automation for that account ends
 *    until a person at Forly turns it back on.
 */

const DEFAULTS = {
  timezone: "Asia/Jerusalem",
  active_hours: { start: 9, end: 21 },
  shabbat: { start_dow: 5, start_hour: 15, end_dow: 6, end_hour: 20 },
  // Yom Kippur, Rosh Hashana, Pesach (first/last), Shavuot, Sukkot (first), Simchat Torah — 5787 & 5788.
  holidays: ["2026-09-12", "2026-09-13", "2026-09-21", "2026-09-26", "2026-10-03", "2027-04-22", "2027-04-28", "2027-06-11",
             "2027-10-02", "2027-10-03", "2027-10-11", "2027-10-16", "2027-10-23"],
  min_gap_minutes: 120,
  gap_jitter: 0.8,                  // adds up to +80% of the gap, never subtracts
  long_break_probability: 0.25,     // sometimes the gap is 3–5 hours, like a person with a job
  daily_cap: 3,
  weekly_cap: 12,
  day_start_jitter_min: 150,        // the first post of a day lands 0–150 min after active_hours.start
  skip_day_probability: 0.2,        // one active day in five, nothing at all
  warmup: [{ days: 7, daily_cap: 1 }, { days: 21, daily_cap: 2 }],
  warmup_multiplier_if_unsure: 2,   // account_aged === false or posted_manually === false
  group_cooldown_days: 7,
  property_group_cooldown_days: 14,
  penalty_days: 14,                 // after rate_limited / feature_blocked
  penalty_cap_divisor: 2,
  halts_window_days: 30,
  halts_to_disable: 2,
  max_consecutive_failures: 2,
};

const MS_MIN = 60000, MS_HOUR = 3600000, MS_DAY = 24 * MS_HOUR;

function localParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, weekday: "short", hour: "numeric", minute: "numeric" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
const localDate = (date, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

function inShabbat({ dow, hour }, sh) {
  if (dow === sh.start_dow) return hour >= sh.start_hour;
  if (dow === sh.end_dow) return hour < sh.end_hour;
  return false;
}
function isActiveTime(date, config = DEFAULTS) {
  const lp = localParts(date, config.timezone);
  if (config.shabbat && inShabbat(lp, config.shabbat)) return false;
  if ((config.holidays || []).includes(localDate(date, config.timezone))) return false;
  return lp.hour >= config.active_hours.start && lp.hour < config.active_hours.end;
}
function nextActiveTime(from, config) {
  let t = new Date(from.getTime());
  for (let i = 0; i < 10 * 96; i++) { if (isActiveTime(t, config)) return t; t = new Date(t.getTime() + 15 * MS_MIN); }
  return t;
}

// A stable per-day random source, so every tick that day agrees on the plan.
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 4294967296; };
}
function dayPlan(localDay, config = DEFAULTS, _rand) {
  const r = seeded(String(localDay));
  if (r() < config.skip_day_probability) return { start_offset_min: 0, target: 0 };
  return { start_offset_min: Math.floor(r() * config.day_start_jitter_min), target: 1 + Math.floor(r() * config.daily_cap) };
}

function dailyCapFor(account, now, config) {
  const ageDays = (now.getTime() - new Date(account.first_connected_at).getTime()) / MS_DAY;
  const mult = (account.account_aged === false || account.posted_manually === false) ? config.warmup_multiplier_if_unsure : 1;
  for (const w of config.warmup) if (ageDays < w.days * mult) return w.daily_cap;
  const base = config.daily_cap;
  return account.penalty_until && now.getTime() < new Date(account.penalty_until).getTime() ? Math.max(1, Math.floor(base / config.penalty_cap_divisor)) : base;
}

function nextSlot({ now, account, candidates, pageId, config = DEFAULTS, rand = Math.random }) {
  if (account.disabled_until_admin) return { at: null, reason: "disabled" };
  const recentHalts = (account.halts || []).filter((h) => now.getTime() - new Date(h.at).getTime() < config.halts_window_days * MS_DAY);
  if (recentHalts.length >= config.halts_to_disable) return { at: null, reason: "disabled" };
  if (account.penalty_until && now.getTime() < new Date(account.penalty_until).getTime() && recentHalts.some((h) => now.getTime() - new Date(h.at).getTime() < MS_DAY)) {
    return { at: null, reason: "penalty" }; // the first day after a penalising signal: nothing
  }

  const posts = (account.posts || []).map((p) => ({ ...p, t: new Date(p.at).getTime() }));
  const today = localDate(now, config.timezone);
  const plan = dayPlan(today, config, rand);
  if (plan.target === 0) return { at: null, reason: "day_skipped" };

  const todays = posts.filter((p) => localDate(new Date(p.t), config.timezone) === today).length;
  if (todays >= Math.min(plan.target, dailyCapFor(account, now, config))) return { at: null, reason: "daily_cap" };
  if (posts.filter((p) => now.getTime() - p.t < 7 * MS_DAY).length >= config.weekly_cap) return { at: null, reason: "weekly_cap" };

  const eligible = candidates.filter((c) => {
    const toGroup = posts.filter((p) => p.group_url === c.url);
    if (toGroup.some((p) => now.getTime() - p.t < config.group_cooldown_days * MS_DAY)) return false;
    if (toGroup.some((p) => p.page_id === pageId && now.getTime() - p.t < config.property_group_cooldown_days * MS_DAY)) return false;
    return true;
  });
  if (!eligible.length) return { at: null, reason: "no_eligible_group" };
  const lastTo = (url) => Math.max(0, ...posts.filter((p) => p.group_url === url).map((p) => p.t));
  eligible.sort((a, b) => lastTo(a.url) - lastTo(b.url));

  // Earliest: after the last post OR reservation by the gap (with jitter, and
  // sometimes a long break), and never before today's randomised start.
  const lastAny = Math.max(0, ...posts.map((p) => p.t));
  const longBreak = rand() < config.long_break_probability;
  const gapMin = longBreak ? 180 + rand() * 120 : config.min_gap_minutes * (1 + config.gap_jitter * rand());
  const dayStart = new Date(now.getTime()); dayStart.setUTCHours(0, 0, 0, 0);
  const lp = localParts(now, config.timezone);
  const startToday = new Date(now.getTime() - (lp.hour * 60 + lp.minute) * MS_MIN + (config.active_hours.start * 60 + plan.start_offset_min) * MS_MIN);
  const earliest = new Date(Math.max(now.getTime(), lastAny + gapMin * MS_MIN, startToday.getTime()));
  return { at: nextActiveTime(earliest, config), group_url: eligible[0].url };
}

// ── what the page is telling us — from the DIALOG and ALERT regions only ──
// The feed is other people's text. A member who writes "אתם חסומים זמנית" in a
// post must not halt every Forly agent who lands there.
const URL_SIGNALS = [
  ["restricted", /\/checkpoint\/block/i],
  ["checkpoint", /\/checkpoint\//i],
  ["login_required", /\/(login|recover)(\/|\?|$)/i],
];
const TEXT_SIGNALS = [
  ["captcha", /(confirm you'?re human|security check|בדיקת אבטחה|לוודא שאת)/i],
  ["feature_blocked", /(can'?t use this feature|we limit how often|לא ניתן להשתמש בתכונה|אנחנו מגבילים)/i],
  ["rate_limited", /(temporarily blocked|posting too fast|slow down|חסומים זמנית|חסום זמנית|לאט יותר)/i],
  ["restricted", /(account (is )?restricted|החשבון שלך מוגבל)/i],
  ["pending_approval", /(pending approval|will be reviewed|ממתין לאישור|ייבדק על ידי מנהל)/i],
  ["group_blocked", /(can'?t post in this group|no longer able to post|לא ניתן לפרסם בקבוצה)/i],
  ["not_member", /(join group to post|הצטרפו לקבוצה כדי לפרסם|הצטרפות לקבוצה)/i],
];
const SIGNAL_DISABLES = new Set(["checkpoint", "captcha", "restricted"]);
const SIGNAL_PENALISES = new Set(["rate_limited", "feature_blocked"]);
const SIGNAL_SKIPS = new Set(["group_blocked", "not_member", "pending_approval"]);

function classifySignal({ landedUrl, dialogText, alertText }) {
  const u = String(landedUrl || "");
  for (const [code, re] of URL_SIGNALS) if (re.test(u)) return code;
  const t = `${dialogText || ""}\n${alertText || ""}`;
  for (const [code, re] of TEXT_SIGNALS) if (re.test(t)) return code;
  return "ok";
}

module.exports = { DEFAULTS, nextSlot, isActiveTime, nextActiveTime, dayPlan, classifySignal, SIGNAL_DISABLES, SIGNAL_PENALISES, SIGNAL_SKIPS, _test: { localParts, dailyCapFor } };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node posting-safety.test.js`
Expected: PASS. Node 20+ ships full ICU; if the Shabbat assertions fail, check `node -p "Intl.DateTimeFormat('en-US',{timeZone:'Asia/Jerusalem'}).format(new Date())"` does not throw.

- [ ] **Step 5: Add to the test chain and commit**

Append ` && node posting-safety.test.js` to `scripts.test` in `server/package.json`.

```bash
cd server && npm test
git add server/posting-safety.js server/posting-safety.test.js server/package.json
git commit -m "feat(posting): pacing, schedule shape and scoped signal rules"
```

---

### Task 14: `posting-campaign.js` — the campaign state machine

**Files:**
- Create: `server/posting-campaign.js`
- Create: `server/posting-campaign.test.js`
- Modify: `server/db.js` (campaign store; `listPostActionsByPhone`)
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Consumes: `posting-safety.*`, `share-kit.buildPostCopy/trackedUrl`, `profile-lock`, `profile-name.profileName`, `db.*PostingCampaign*`, `db.getPage`, `db.getConnection/setConnection`, `db.addPostAction/listPostActionsByPhone`, `posting-driver.postToGroup` (Task 15, as `deps.post`), `deps.notify(phone, text)` (Task 17 supplies the signed-link messages).
- Produces:
  - `create({ phone, page, groups, mode, days, repeat, consent }, deps) -> Campaign` — status `running` (consent is the approval)
  - `pause(id, reason, deps)`, `resume(id, deps)`, `stop(id, deps)`, `approvePost(id, postId, deps)`, `skipPost(id, postId, deps)`
  - `tick(campaign, deps, now)`, `sweep(deps, now)`, `startSweeper(deps)`, `liveDeps({ greenInstance, greenToken, pageBaseUrl, authSecret })`
  - Campaign shape:
    ```
    { id, phone, page_id, mode: "per_post"|"standing", repeat: boolean,
      expires_at: ISO, consent_at: ISO, consent_version: string,
      groups: [{ url, slug, name, agent_policy }],
      status: "running"|"paused"|"stopped"|"completed",
      pause_reason: "agent"|"consecutive_failures"|"infrastructure"|"internal"|"account"|null,
      posts: [{ id, group_url, group_slug, group_token, status: "pending_approval"|"scheduled"|"posting"|"posted"|"failed"|"skipped",
                scheduled_at, posting_started_at, posted_at, post_url, error_code, copy, copy_hash }],
      consecutive_failures, tick_errors, created_at, updated_at }
    ```
  - On the connection doc: `posting_ledger` (30 days, `{at, group_slug, page_id, ok}`), `posting_halts` (`[{at, code}]`), `posting_disabled_until_admin`, `posting_penalty_until`, `posting_account_aged`, `posting_posted_manually`.

- [ ] **Step 1: Write the failing test**

Create `server/posting-campaign.test.js`:

```js
/* posting-campaign.js — the campaign lifecycle. No browser: post() is a fake.
   Every time derives from NOW. */
const assert = require("assert");
const C = require("./posting-campaign");
const locks = require("./profile-lock");

const NOW = new Date("2026-09-23T10:00:00+03:00");
const day = (n) => n * 86400000;
const cfg = Object.assign({}, require("./posting-safety").DEFAULTS, { skip_day_probability: 0, day_start_jitter_min: 0, long_break_probability: 0 });

function fakeDb() {
  const camps = new Map(), conns = new Map(), pages = new Map(), actions = [], settings = { "posting": { enabled: true } };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  return {
    camps, conns, pages, actions, settings,
    savePostingCampaign: async (c) => { camps.set(c.id, clone(c)); },
    getPostingCampaign: async (id) => (camps.has(id) ? clone(camps.get(id)) : null),
    updatePostingCampaign: async (id, patch) => { const c = camps.get(id); if (c) Object.assign(c, clone(patch)); },
    listPostingCampaignsByStatus: async (st) => [...camps.values()].filter((c) => c.status === st).map(clone),
    listPostingCampaignsByPhone: async (ph) => [...camps.values()].filter((c) => c.phone === ph).map(clone),
    getConnection: async (ph) => (conns.has(ph) ? clone(conns.get(ph)) : null),
    setConnection: async (ph, patch) => { conns.set(ph, Object.assign(conns.get(ph) || {}, clone(patch))); },
    getPage: async (id) => pages.get(id) || null,
    addPostAction: async (a) => { actions.push(a); },
    listPostActionsByPhone: async () => [],
    getSetting: async (k) => settings[k] || null,
    setSetting: async (k, v) => { settings[k] = v; },
  };
}
const page = (id = "pg1") => ({ page_id: id, status: "active", business_phone: "p", property: { title: "דירה בחיפה", city: "חיפה", price: 2000000, rooms: 4 }, agent: { name: "דנה", phone: "0500000000" } });
const groups = [
  { url: "https://www.facebook.com/groups/111", slug: "111", name: "A", agent_policy: "explicitly_allowed" },
  { url: "https://www.facebook.com/groups/222", slug: "222", name: "B", agent_policy: "explicitly_allowed" },
];
async function setup(phone = "p", pageId = "pg1") {
  const db = fakeDb();
  db.pages.set(pageId, page(pageId));
  await db.setConnection(phone, { facebook_browser_connected_at: new Date(NOW.getTime() - day(90)).toISOString(), facebook_browser_first_connected_at: new Date(NOW.getTime() - day(90)).toISOString(), posting_account_aged: true, posting_posted_manually: true });
  const notes = [];
  const deps = { db, config: cfg, rand: () => 0, pageBaseUrl: "https://f.ly", post: async () => ({ post_url: "https://www.facebook.com/groups/111/posts/999" }), notify: async (ph, msg) => notes.push(msg) };
  return { db, deps, notes };
}
const base = (o = {}) => Object.assign({ phone: "p", page: page(), groups, mode: "standing", days: 14, repeat: false, consent: { at: NOW.toISOString(), version: "2026-09-24" } }, o);
const dueOf = (c, i = 0) => new Date(new Date(c.posts[i].scheduled_at).getTime() + 1000);

(async () => {
  locks._test.reset();

  // ── create: running at once (consent is the approval); nothing scheduled yet ──
  const { db, deps, notes } = await setup();
  const c = await C.create(base(), deps);
  assert.equal(c.status, "running");
  assert.equal(c.posts.length, 0);
  assert.ok(c.consent_at && c.expires_at);
  assert.equal(c.groups[0].slug, "111");

  // ── tick schedules one post with copy built NOW from the page, link in the comment, opaque group token ──
  let t = await C.tick(c, deps, NOW);
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].status, "scheduled");
  assert.ok(t.posts[0].copy.includes("חיפה"));
  assert.ok(!/https?:\/\//.test(t.posts[0].copy), "no link in the body");
  assert.ok(/^[0-9a-f]{12}$/.test(t.posts[0].group_token));
  assert.ok(t.posts[0].comment.includes(`g=${t.posts[0].group_token}`) && t.posts[0].comment.includes("s=" + c.id));

  // ── when due, it posts; the ledger and post_actions record it; the copy is replaced by a hash ──
  t = await C.tick(t, deps, dueOf(t));
  assert.equal(t.posts[0].status, "posted");
  assert.equal(t.posts[0].post_url, "https://www.facebook.com/groups/111/posts/999");
  assert.equal(t.posts[0].copy, undefined, "copy no longer stored once posted");
  assert.ok(t.posts[0].copy_hash);
  const conn = await db.getConnection("p");
  assert.equal(conn.posting_ledger.length, 1);
  assert.equal(conn.posting_ledger[0].group_slug, "111");
  assert.equal(db.actions.length, 1);
  assert.equal(db.actions[0].source, "campaign");

  // ── the price changed: the next post's copy reflects it ──
  db.pages.get("pg1").property.price = 1900000;
  t = await C.tick(t, deps, new Date(dueOf(t).getTime() + 1000));
  assert.ok(t.posts[1].copy.includes("1,900,000"));
  assert.equal(t.posts[1].group_url, groups[1].url, "least-recently-posted group");
  assert.ok(new Date(t.posts[1].scheduled_at).getTime() - dueOf(t).getTime() >= cfg.min_gap_minutes * 60000);

  // ── the page is archived mid-campaign: stop, say why ──
  db.pages.get("pg1").status = "archived";
  const gone = await C.tick(t, deps, dueOf(t, 1));
  assert.equal(gone.status, "stopped");
  assert.equal(gone.pause_reason, "page_gone");
  assert.equal(gone.posts[1].status, "skipped");
  db.pages.get("pg1").status = "active";

  // ── one pass over the groups completes a non-repeating campaign ──
  {
    const { db: d2, deps: p2 } = await setup("q");
    let c2 = await C.create(base({ phone: "q" }), p2);
    let clock = NOW;
    for (let i = 0; i < 2; i++) { c2 = await C.tick(c2, p2, clock); clock = dueOf(c2, i); c2 = await C.tick(c2, p2, clock); }
    c2 = await C.tick(c2, p2, new Date(clock.getTime() + day(1)));
    assert.equal(c2.status, "completed", "every group posted once; repeat=false");
  }

  // ── per_post: waits for approval; approval re-times the post to a safe slot ──
  {
    const { deps: p3, notes: n3 } = await setup("r");
    let c3 = await C.create(base({ phone: "r", mode: "per_post" }), p3);
    c3 = await C.tick(c3, p3, NOW);
    assert.equal(c3.posts[0].status, "pending_approval");
    assert.equal(n3.length, 1, "agent told, with the exact copy");
    assert.ok(n3[0].includes(c3.posts[0].copy.slice(0, 20)));
    c3 = await C.tick(c3, p3, new Date(NOW.getTime() + 3600000));
    assert.equal(c3.posts[0].status, "pending_approval", "unapproved, still waiting");
    const night = new Date("2026-09-23T23:40:00+03:00");
    c3 = await C.approvePost(c3.id, c3.posts[0].id, Object.assign({}, p3, { now: night }));
    assert.equal(c3.posts[0].status, "scheduled");
    assert.ok(new Date(c3.posts[0].scheduled_at) > night, "approved at night → posts in the morning, not now");
  }

  // ── stop cancels what is scheduled; a later tick posts nothing ──
  const s = await C.stop(c.id, deps);
  assert.equal(s.status, "stopped");
  assert.equal(await C.tick(s, deps, new Date(NOW.getTime() + day(1))).then((x) => x.posts.filter((p) => p.status === "posted").length), 1);

  // ── a checkpoint DISABLES the account until an operator re-enables it, and every campaign on it stops ──
  {
    const { db: d4, deps: p4, notes: n4 } = await setup("s");
    let c4 = await C.create(base({ phone: "s" }), p4);
    const c4b = await C.create(base({ phone: "s", page: page("pg2") }), p4); d4.pages.set("pg2", page("pg2"));
    c4 = await C.tick(c4, p4, NOW);
    c4 = await C.tick(c4, Object.assign({}, p4, { post: async () => { throw Object.assign(new Error("cp"), { code: "checkpoint" }); } }), dueOf(c4));
    assert.equal(c4.status, "paused"); assert.equal(c4.pause_reason, "account");
    const conn4 = await d4.getConnection("s");
    assert.equal(conn4.posting_disabled_until_admin, true);
    assert.deepEqual(conn4.posting_halts.map((h) => h.code), ["checkpoint"]);
    assert.equal((await d4.getPostingCampaign(c4b.id)).status, "paused", "the other campaign on the account is paused too");
    assert.ok(n4.some((m) => /פייסבוק/.test(m)), "the agent hears about it on WhatsApp");
    const r = await C.resume(c4.id, p4);
    assert.equal(r.status, "paused", "the agent cannot resume a disabled account");
  }

  // ── rate_limited: a penalty, campaigns keep running slower, one more halt → disabled ──
  {
    const { db: d5, deps: p5 } = await setup("t");
    let c5 = await C.create(base({ phone: "t" }), p5);
    c5 = await C.tick(c5, p5, NOW);
    c5 = await C.tick(c5, Object.assign({}, p5, { post: async () => { throw Object.assign(new Error("rl"), { code: "rate_limited" }); } }), dueOf(c5));
    const conn5 = await d5.getConnection("t");
    assert.ok(conn5.posting_penalty_until && !conn5.posting_disabled_until_admin);
    assert.equal(c5.status, "running");
  }

  // ── not_member / pending_approval are per-group outcomes: spent slot, no breaker ──
  {
    const { deps: p6 } = await setup("u");
    let c6 = await C.create(base({ phone: "u" }), p6);
    c6 = await C.tick(c6, p6, NOW);
    c6 = await C.tick(c6, Object.assign({}, p6, { post: async () => { throw Object.assign(new Error("pa"), { code: "pending_approval" }); } }), dueOf(c6));
    assert.equal(c6.posts[0].status, "posted"); assert.equal(c6.posts[0].error_code, "pending_approval");
    assert.equal(c6.consecutive_failures, 0);
  }

  // ── an infrastructure failure (Driver 503) is not the agent's failure: no ledger, no breaker, retry later ──
  {
    const { db: d7, deps: p7 } = await setup("v");
    let c7 = await C.create(base({ phone: "v" }), p7);
    c7 = await C.tick(c7, p7, NOW);
    c7 = await C.tick(c7, Object.assign({}, p7, { post: async () => { throw Object.assign(new Error("cap"), { status: 503 }); } }), dueOf(c7));
    assert.equal(c7.posts[0].status, "scheduled", "rescheduled, not failed");
    assert.equal(((await d7.getConnection("v")).posting_ledger || []).length, 0);
    assert.equal(c7.pause_reason, "infrastructure");
    assert.equal(c7.status, "running");
  }

  // ── consecutive real failures trip the breaker ──
  {
    const { deps: p8 } = await setup("w");
    let c8 = await C.create(base({ phone: "w" }), p8);
    const bad = Object.assign({}, p8, { post: async () => { throw Object.assign(new Error("x"), { code: "post_failed" }); } });
    let clock = NOW;
    for (let i = 0; i < 2; i++) { c8 = await C.tick(c8, bad, clock); clock = dueOf(c8, i); c8 = await C.tick(c8, bad, clock); }
    assert.equal(c8.status, "paused"); assert.equal(c8.pause_reason, "consecutive_failures");
  }

  // ── a post stuck in "posting" is reaped into the ledger before anything new is scheduled ──
  {
    const { db: d9, deps: p9 } = await setup("x");
    let c9 = await C.create(base({ phone: "x" }), p9);
    c9 = await C.tick(c9, p9, NOW);
    await d9.updatePostingCampaign(c9.id, { posts: [Object.assign(c9.posts[0], { status: "posting", posting_started_at: new Date(NOW.getTime() - 20 * 60000).toISOString() })] });
    c9 = await C.tick(c9, p9, new Date(NOW.getTime() + 60000));
    assert.equal(c9.posts[0].status, "failed"); assert.equal(c9.posts[0].error_code, "not_verified");
    assert.equal((await d9.getConnection("x")).posting_ledger.length, 1, "counted as spent");
  }

  // ── the profile lock is respected: nothing posts while an extract or login holds it ──
  {
    const { deps: p10 } = await setup("y");
    let c10 = await C.create(base({ phone: "y" }), p10);
    c10 = await C.tick(c10, p10, NOW);
    const release = locks.acquire("y");
    const held = await C.tick(c10, Object.assign({}, p10, { post: async () => { throw new Error("must not post while locked"); } }), dueOf(c10));
    assert.equal(held.posts[0].status, "scheduled");
    release();
  }

  // ── two campaigns on one account: the second paces against the first's reservation ──
  {
    const { db: d11, deps: p11 } = await setup("z");
    d11.pages.set("pg2", page("pg2"));
    let a = await C.create(base({ phone: "z" }), p11);
    let b = await C.create(base({ phone: "z", page: page("pg2") }), p11);
    a = await C.tick(a, p11, NOW); b = await C.tick(b, p11, NOW);
    const gap = Math.abs(new Date(b.posts[0].scheduled_at) - new Date(a.posts[0].scheduled_at)) / 60000;
    assert.ok(gap >= cfg.min_gap_minutes, `two campaigns scheduled ${gap} min apart`);
  }

  // ── the kill switch: nothing happens while it is off ──
  {
    const { db: d12, deps: p12 } = await setup("k");
    let c12 = await C.create(base({ phone: "k" }), p12);
    await d12.setSetting("posting", { enabled: false });
    assert.equal(await C.sweep(p12, NOW), 0);
    assert.equal((await d12.getPostingCampaign(c12.id)).posts.length, 0);
    await d12.setSetting("posting", { enabled: true });
    assert.equal(await C.sweep(p12, NOW), 1);
  }

  // ── the fleet breaker: three accounts disabled in 24h → the switch goes off, the operator is told ──
  {
    const { db: d13, deps: p13 } = await setup("f");
    const ops = [];
    const at = new Date(NOW.getTime() - 3600000).toISOString();
    for (const ph of ["f1", "f2", "f3"]) await d13.setConnection(ph, { posting_halts: [{ at, code: "checkpoint" }] });
    await C.sweep(Object.assign({}, p13, { notifyOperator: async (m) => ops.push(m), listRecentlyHaltedPhones: async () => ["f1", "f2", "f3"] }), NOW);
    assert.equal((await d13.getSetting("posting")).enabled, false);
    assert.equal(ops.length, 1);
  }

  console.log("posting-campaign.test.js ok");
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node posting-campaign.test.js`
Expected: FAIL with `Cannot find module './posting-campaign'`

- [ ] **Step 3: Add the store to `db.js`**

Add `postingCampaigns: new Map(), settings: new Map()` to the `mem` literal. Add after the extract-job functions:

```js
// ── posting campaigns (background group posting) ──
async function savePostingCampaign(c) {
  if (db) await db.collection("posting_campaigns").doc(c.id).set(c);
  else mem.postingCampaigns.set(c.id, JSON.parse(JSON.stringify(c)));
}
async function getPostingCampaign(id) {
  if (db) { const d = await db.collection("posting_campaigns").doc(id).get(); return d.exists ? d.data() : null; }
  return mem.postingCampaigns.get(id) || null;
}
async function updatePostingCampaign(id, patch) {
  if (db) { await db.collection("posting_campaigns").doc(id).update(patch); return; }
  const c = mem.postingCampaigns.get(id);
  if (c) Object.assign(c, JSON.parse(JSON.stringify(patch)));
}
async function listPostingCampaignsByStatus(status, limit = 50) {
  if (db) { const snap = await db.collection("posting_campaigns").where("status", "==", status).limit(limit).get(); return snap.docs.map((d) => d.data()); }
  return [...mem.postingCampaigns.values()].filter((c) => c.status === status).slice(0, limit);
}
async function listPostingCampaignsByPhone(phone, limit = 100) {
  if (db) { const snap = await db.collection("posting_campaigns").where("phone", "==", phone).limit(limit).get(); return snap.docs.map((d) => d.data()); }
  return [...mem.postingCampaigns.values()].filter((c) => c.phone === phone).slice(0, limit);
}
// Manual share-kit posts live in post_actions (routes/distribution.js share-session/mark);
// the pacer must see them or it will post to a group the agent hit by hand an hour ago.
async function listPostActionsByPhone(phone, sinceMs) {
  if (db) { const snap = await db.collection("post_actions").where("phone", "==", phone).limit(200).get(); return snap.docs.map((d) => d.data()).filter((a) => !sinceMs || new Date(a.at.toDate ? a.at.toDate() : a.at).getTime() > sinceMs); }
  return mem.postActions.filter((a) => a.phone === phone && (!sinceMs || new Date(a.at).getTime() > sinceMs));
}
// ── operator settings (the kill switch lives here so it can be flipped without a deploy) ──
async function getSetting(key) {
  if (db) { const d = await db.collection("settings").doc(key).get(); return d.exists ? d.data() : null; }
  return mem.settings.get(key) || null;
}
async function setSetting(key, value) {
  if (db) await db.collection("settings").doc(key).set(value, { merge: true });
  else mem.settings.set(key, Object.assign(mem.settings.get(key) || {}, value));
}
```

Export all eight. Check whether `addPostAction` rows carry `phone`; if `share-session/mark` writes only `session_id`, add `phone` there in the same change.

- [ ] **Step 4: Write the state machine**

Create `server/posting-campaign.js`:

```js
/*
 * posting-campaign.js — one property, its groups, over days.
 *
 * A campaign is the agent's recorded consent plus a ledger of what was done
 * with it. Two shapes:
 *   per_post  — every post is shown to the agent (exact copy, exact group,
 *               proposed time) and posted only after a one-tap approval;
 *   standing  — one approval covers one pass over the groups (repeat: false)
 *               or repeated passes until expires_at (repeat: true), and STOP
 *               works at any moment.
 *
 * The scheduling decision is never made here: tick() asks posting-safety.js.
 * Nothing that opens the agent's browser happens without profile-lock.js.
 *
 * Account-level facts — halts, penalties, the disabled flag, the ledger — live
 * on the CONNECTION doc: every campaign for one agent shares one pace, one
 * halt history, and one kill.
 */
const crypto = require("crypto");
const safety = require("./posting-safety");
const shareKit = require("./distribution/share-kit");
const locks = require("./profile-lock");
const { profileName } = require("./profile-name");
const { redact } = require("./driver-browser");

const SWEEP_MS = 60 * 1000;
const POSTING_MAX_MS = 15 * 60 * 1000;
const LEDGER_DAYS = 30;
const MAX_TICK_ERRORS = 3;
const FLEET_BREAKER_HALTS = 3;

const iso = (d) => new Date(d).toISOString();
const sha = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const groupSlug = (url) => (String(url).match(/\/groups\/([^/?#]+)/) || [])[1] || sha(url).slice(0, 16);
const groupToken = (url) => sha(url).slice(0, 12); // opaque in the outbound link; never the group URL

async function create({ phone, page, groups, mode, days, repeat, consent }, deps) {
  if (!consent || !consent.at) throw Object.assign(new Error("consent required"), { code: "consent_required" });
  const now = deps.now || new Date();
  const c = {
    id: crypto.randomUUID(),
    phone: String(phone),
    page_id: page.page_id,
    mode: mode === "per_post" ? "per_post" : "standing",
    repeat: repeat === true,
    expires_at: iso(now.getTime() + Math.min(Math.max(Number(days) || 14, 1), 30) * 86400000),
    consent_at: consent.at, consent_version: consent.version || null,
    groups: (groups || []).slice(0, shareKit.MAX_GROUPS).map((g) => ({ url: g.url, slug: groupSlug(g.url), name: g.name || "", agent_policy: g.agent_policy || "unknown" })),
    status: "running", pause_reason: null,
    posts: [], consecutive_failures: 0, tick_errors: 0,
    created_at: iso(now), updated_at: iso(now),
  };
  await deps.db.savePostingCampaign(c);
  return c;
}

async function patch(id, p, deps) { p.updated_at = iso(deps.now || Date.now()); await deps.db.updatePostingCampaign(id, p); return deps.db.getPostingCampaign(id); }

async function pause(id, reason, deps) { return patch(id, { status: "paused", pause_reason: reason }, deps); }

async function resume(id, deps) {
  const c = await deps.db.getPostingCampaign(id);
  if (!c || c.status !== "paused") return c;
  const conn = (await deps.db.getConnection(c.phone)) || {};
  if (conn.posting_disabled_until_admin) return c; // the agent cannot lift an operator-level stop
  return patch(id, { status: "running", pause_reason: null, consecutive_failures: 0, tick_errors: 0 }, deps);
}

async function stop(id, deps, reason = "agent") {
  const c = await deps.db.getPostingCampaign(id);
  if (!c) return null;
  const posts = c.posts.map((p) => (["scheduled", "pending_approval"].includes(p.status) ? { ...p, status: "skipped", error_code: "stopped", copy: undefined } : p));
  const out = await patch(id, { status: "stopped", pause_reason: reason, posts }, deps);
  if (deps.notify) await deps.notify(c.phone, deps.messages ? deps.messages.stopped(out) : "הפרסום נעצר. מה שכבר פורסם נשאר.");
  return out;
}

// Approval is also a re-timing: the agent may tap at 23:40, and the slot the
// post was proposed for is long gone. Ask posting-safety again.
async function approvePost(id, postId, deps) {
  const now = deps.now || new Date();
  const c = await deps.db.getPostingCampaign(id);
  if (!c) return null;
  const { account } = await accountFor(c, deps, now);
  const post = c.posts.find((p) => p.id === postId && p.status === "pending_approval");
  if (!post) return c;
  const slot = safety.nextSlot({ now, account, candidates: c.groups.filter((g) => g.url === post.group_url), pageId: c.page_id, config: deps.config, rand: deps.rand });
  const at = slot.at || safety.nextActiveTime(new Date(now.getTime() + 3600000), deps.config || safety.DEFAULTS);
  const posts = c.posts.map((p) => (p.id === postId ? { ...p, status: "scheduled", scheduled_at: iso(at) } : p));
  return patch(id, { posts }, deps);
}
async function skipPost(id, postId, deps) {
  const c = await deps.db.getPostingCampaign(id);
  if (!c) return null;
  return patch(id, { posts: c.posts.map((p) => (p.id === postId && p.status === "pending_approval" ? { ...p, status: "skipped", error_code: "agent", copy: undefined } : p)) }, deps);
}

// ── the account as posting-safety sees it: this campaign's siblings' reservations,
//    manual share-kit posts, and the halt history ──
async function accountFor(c, deps, now) {
  const conn = (await deps.db.getConnection(c.phone)) || {};
  const cutoff = now.getTime() - LEDGER_DAYS * 86400000;
  const ledger = (conn.posting_ledger || []).filter((p) => new Date(p.at).getTime() > cutoff);
  const manual = (await deps.db.listPostActionsByPhone(c.phone, cutoff)).filter((a) => a.target === "facebook_group" && a.group_url)
    .map((a) => ({ at: iso(a.at.toDate ? a.at.toDate() : a.at), group_slug: groupSlug(a.group_url), page_id: a.page_id || null, ok: true }));
  const siblings = (await deps.db.listPostingCampaignsByPhone(c.phone)).filter((s) => s.id !== c.id && s.status === "running");
  const reserved = siblings.flatMap((s) => s.posts.filter((p) => ["scheduled", "pending_approval", "posting"].includes(p.status)).map((p) => ({ at: p.scheduled_at, group_slug: p.group_slug, page_id: s.page_id, ok: null })));
  const posts = ledger.concat(manual, reserved).map((p) => ({ ...p, group_url: c.groups.find((g) => g.slug === p.group_slug) ? c.groups.find((g) => g.slug === p.group_slug).url : p.group_slug }));
  return {
    conn,
    account: {
      first_connected_at: conn.facebook_browser_first_connected_at || conn.facebook_browser_connected_at || iso(now),
      halts: conn.posting_halts || [],
      disabled_until_admin: conn.posting_disabled_until_admin === true,
      penalty_until: conn.posting_penalty_until || null,
      account_aged: conn.posting_account_aged === undefined ? null : conn.posting_account_aged,
      posted_manually: conn.posting_posted_manually === undefined ? null : conn.posting_posted_manually,
      posts,
    },
  };
}

async function recordPost(c, entry, deps, now) {
  const conn = (await deps.db.getConnection(c.phone)) || {};
  const cutoff = now.getTime() - LEDGER_DAYS * 86400000;
  const ledger = (conn.posting_ledger || []).filter((p) => new Date(p.at).getTime() > cutoff).concat([entry]);
  await deps.db.setConnection(c.phone, { posting_ledger: ledger });
  await deps.db.addPostAction({ phone: c.phone, page_id: c.page_id, target: "facebook_group", group_url: c.groups.find((g) => g.slug === entry.group_slug)?.url || null, source: "campaign", campaign_id: c.id, ok: entry.ok, at: entry.at });
}

function allGroupsDone(c) {
  const terminal = new Set(c.posts.filter((p) => ["posted", "skipped", "failed"].includes(p.status)).map((p) => p.group_slug));
  return c.groups.every((g) => terminal.has(g.slug));
}

/*
 * One step. In order: reap anything stuck, re-read reality, post what is due,
 * else schedule the next one. Never two of those in a tick: the ledger the
 * next decision needs is written by this one.
 */
async function tick(campaign, deps, now = deps.now || new Date()) {
  let c = await deps.db.getPostingCampaign(campaign.id);
  if (!c || c.status !== "running") return c;
  try {
    return await tickInner(c, deps, now);
  } catch (e) {
    console.error(redact(`posting campaign ${c.id} tick: ${e.message}`));
    const n = (c.tick_errors || 0) + 1;
    return patch(c.id, n >= MAX_TICK_ERRORS ? { status: "paused", pause_reason: "internal", tick_errors: n } : { tick_errors: n }, deps);
  }
}

async function tickInner(c, deps, now) {
  const config = deps.config || safety.DEFAULTS;

  // A post left "posting" past its lifetime died with the process. It is a spent
  // slot (Facebook may well have it) — count it, then move on.
  const stuck = c.posts.find((p) => p.status === "posting" && now.getTime() - new Date(p.posting_started_at || 0).getTime() > POSTING_MAX_MS);
  if (stuck) {
    await recordPost(c, { at: iso(now), group_slug: stuck.group_slug, page_id: c.page_id, ok: false }, deps, now);
    return patch(c.id, { posts: c.posts.map((p) => (p.id === stuck.id ? { ...p, status: "failed", error_code: "not_verified", copy: undefined } : p)) }, deps);
  }
  if (c.posts.some((p) => p.status === "posting")) return c; // in flight right now

  if (now.getTime() > new Date(c.expires_at).getTime()) return patch(c.id, { status: "completed", pause_reason: "expired" }, deps);
  if (!c.repeat && c.posts.length && allGroupsDone(c) && !c.posts.some((p) => ["scheduled", "pending_approval"].includes(p.status))) {
    return patch(c.id, { status: "completed", pause_reason: null }, deps);
  }

  // Re-read reality: the page may be gone or changed; the catalog may have
  // changed its mind about a group.
  const page = await deps.db.getPage(c.page_id);
  if (!page || !["active", "expiring"].includes(page.status || "active")) {
    return stop(c.id, deps, "page_gone");
  }

  const { conn, account } = await accountFor(c, deps, now);
  if (account.disabled_until_admin) return patch(c.id, { status: "paused", pause_reason: "account" }, deps);

  const due = c.posts.find((p) => p.status === "scheduled" && new Date(p.scheduled_at).getTime() <= now.getTime());
  if (due) {
    // Safety is re-checked at the moment of posting, not just at scheduling:
    // the agent may have approved late, or a sibling campaign posted since.
    const lastAny = Math.max(0, ...account.posts.filter((p) => p.ok !== null).map((p) => new Date(p.at).getTime()));
    if (!safety.isActiveTime(now, config) || now.getTime() - lastAny < config.min_gap_minutes * 60000) {
      const at = safety.nextActiveTime(new Date(Math.max(now.getTime(), lastAny + config.min_gap_minutes * 60000)), config);
      return patch(c.id, { posts: c.posts.map((p) => (p.id === due.id ? { ...p, scheduled_at: iso(at) } : p)) }, deps);
    }
    return postNow(c, due, page, deps, now);
  }
  if (c.posts.some((p) => ["scheduled", "pending_approval"].includes(p.status))) return c;

  const slot = safety.nextSlot({ now, account, candidates: c.groups, pageId: c.page_id, config, rand: deps.rand });
  if (!slot.at) return patch(c.id, { wait_reason: slot.reason }, deps);
  const group = c.groups.find((g) => g.url === slot.group_url);
  const token = groupToken(group.url);
  const pageUrl = `${deps.pageBaseUrl}/p/${c.page_id}`;
  const url = shareKit.trackedUrl(pageUrl, { session: c.id, group: token });
  // Copy is built from the page AS IT IS NOW, never frozen at create time — a
  // price cut yesterday must not be advertised at the old price today.
  const copy = shareKit.buildPostCopy({ property: page.property || {}, agent: page.agent || {}, title: (page.property || {}).title }, url, { variantSeed: c.page_id + group.url, linkInComment: true });
  const post = {
    id: crypto.randomUUID(), group_url: group.url, group_slug: group.slug, group_name: group.name, group_token: token,
    status: c.mode === "per_post" ? "pending_approval" : "scheduled",
    scheduled_at: iso(slot.at), posting_started_at: null, posted_at: null, post_url: null, error_code: null,
    copy, comment: url,
  };
  const next = await patch(c.id, { posts: c.posts.concat([post]), wait_reason: null }, deps);
  if (c.mode === "per_post" && deps.notify) await deps.notify(c.phone, deps.messages ? deps.messages.approve(next, post) : `📣 פוסט מוכן לאישור לקבוצה "${group.name || group.url}":\n──────────\n${copy}\n──────────`);
  return next;
}

async function postNow(c, post, page, deps, now) {
  const release = locks.tryAcquire(c.phone);
  if (!release) return c; // an extract or the login browser has the profile; next sweep
  let posts = c.posts.map((p) => (p.id === post.id ? { ...p, status: "posting", posting_started_at: iso(now) } : p));
  await deps.db.updatePostingCampaign(c.id, { posts });
  let result = null, err = null;
  try {
    result = await deps.post({ groupUrl: post.group_url, copy: post.copy, comment: post.comment, profileName: profileName("facebook", c.phone), dryRun: deps.dryRun === true, campaignId: c.id, phone: c.phone });
  } catch (e) { err = e; }

  try {
    if (!err || (err.code && safety.SIGNAL_SKIPS.has(err.code) && err.code === "pending_approval")) {
      // Posted, or sitting in an admin queue: either way the slot is spent and the
      // group is on cooldown. The copy is replaced by its hash now that it is out.
      await recordPost(c, { at: iso(now), group_slug: post.group_slug, page_id: c.page_id, ok: true }, deps, now);
      posts = posts.map((p) => (p.id === post.id ? { ...p, status: "posted", posted_at: iso(now), post_url: result ? result.post_url : null, error_code: err ? err.code : null, copy: undefined, copy_hash: sha(p.copy) } : p));
      const next = await patch(c.id, { posts, consecutive_failures: 0, pause_reason: null }, deps);
      if (deps.notify && deps.messages) await deps.notify(c.phone, deps.messages.posted(next, next.posts.find((p) => p.id === post.id)));
      return next;
    }

    // Driver's problem, not the agent's: no ledger entry, no breaker, try in half an hour.
    if (typeof err.status === "number" || !err.code) {
      posts = posts.map((p) => (p.id === post.id ? { ...p, status: "scheduled", scheduled_at: iso(now.getTime() + 30 * 60000), posting_started_at: null } : p));
      return patch(c.id, { posts, pause_reason: "infrastructure" }, deps);
    }

    const code = err.code;
    await recordPost(c, { at: iso(now), group_slug: post.group_slug, page_id: c.page_id, ok: false }, deps, now);

    if (safety.SIGNAL_DISABLES.has(code) || safety.SIGNAL_PENALISES.has(code) || code === "login_required") {
      return await haltAccount(c, post, posts, code, deps, now);
    }
    const skip = safety.SIGNAL_SKIPS.has(code);
    posts = posts.map((p) => (p.id === post.id ? { ...p, status: skip ? "skipped" : "failed", error_code: code, copy: undefined } : p));
    const failures = skip ? 0 : c.consecutive_failures + 1;
    const max = (deps.config || safety.DEFAULTS).max_consecutive_failures;
    const next = await patch(c.id, failures >= max ? { posts, consecutive_failures: failures, status: "paused", pause_reason: "consecutive_failures" } : { posts, consecutive_failures: failures }, deps);
    if (failures >= max && deps.notify && deps.messages) await deps.notify(c.phone, deps.messages.paused(next));
    return next;
  } finally { release(); }
}

// The ACCOUNT halts, not the campaign. A checkpoint ends automation until an
// operator turns it back on; rate limiting is a two-week penalty; a cookie
// expiry just needs the agent to reconnect.
async function haltAccount(c, post, posts, code, deps, now) {
  const conn = (await deps.db.getConnection(c.phone)) || {};
  const config = deps.config || safety.DEFAULTS;
  const halts = (conn.posting_halts || []).concat([{ at: iso(now), code }]);
  const patchConn = { posting_halts: halts, posting_last_halt_code: code };
  const disable = safety.SIGNAL_DISABLES.has(code) || halts.filter((h) => now.getTime() - new Date(h.at).getTime() < config.halts_window_days * 86400000).length >= config.halts_to_disable;
  if (disable) patchConn.posting_disabled_until_admin = true;
  else if (safety.SIGNAL_PENALISES.has(code)) { patchConn.posting_penalty_until = iso(now.getTime() + config.penalty_days * 86400000); patchConn.facebook_browser_first_connected_at = iso(now); }
  if (code === "login_required") patchConn.facebook_browser_connected_at = null;
  await deps.db.setConnection(c.phone, patchConn);

  posts = posts.map((p) => (p.id === post.id ? { ...p, status: "failed", error_code: code, copy: undefined } : p));
  const reason = disable || code === "login_required" ? "account" : null;
  const me = await patch(c.id, reason ? { posts, status: "paused", pause_reason: reason } : { posts }, deps);
  if (reason) for (const s of await deps.db.listPostingCampaignsByPhone(c.phone)) if (s.id !== c.id && s.status === "running") await patch(s.id, { status: "paused", pause_reason: "account" }, deps);
  if (deps.notify) await deps.notify(c.phone, deps.messages ? deps.messages.halted(me, code) : `⚠️ פייסבוק עצרה את הפרסום (${code}).`);
  if (disable && deps.notifyOperator) await deps.notifyOperator(`posting: account disabled (${code}) for a customer; campaign ${c.id}`);
  return me;
}

// ── the sweeper: kill switch, fleet breaker, then every running campaign ──
let sweeping = false;
async function sweep(deps, now = new Date()) {
  if (sweeping) return 0;
  sweeping = true;
  try {
    if (process.env.POSTING_ENABLED === "0") return 0;
    const setting = (await deps.db.getSetting("posting")) || { enabled: true };
    if (setting.enabled === false) return 0;

    // Fleet breaker: several accounts halting at once means Facebook changed
    // something, not that several agents did. Stop everyone before the next slot.
    const halted = deps.listRecentlyHaltedPhones ? await deps.listRecentlyHaltedPhones(now) : [];
    if (halted.length >= FLEET_BREAKER_HALTS) {
      await deps.db.setSetting("posting", { enabled: false, disabled_at: iso(now), disabled_reason: `fleet_breaker:${halted.length}` });
      if (deps.notifyOperator) await deps.notifyOperator(`posting: FLEET BREAKER tripped — ${halted.length} accounts halted in 24h; posting is OFF`);
      return 0;
    }

    const running = await deps.db.listPostingCampaignsByStatus("running");
    const run = deps.tick || tick;
    let n = 0;
    for (const c of running) { n++; await run(c, deps, now).catch((e) => console.error(redact(`posting campaign ${c.id}: ${e.message}`))); }
    return n;
  } finally { sweeping = false; }
}

function startSweeper(deps) {
  const t = setInterval(() => { sweep(deps).catch((e) => console.error(redact(`posting sweep: ${e.message}`))); }, deps.sweepMs || SWEEP_MS);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

function liveDeps({ greenInstance, greenToken, pageBaseUrl, authSecret, operatorPhone }) {
  const db = require("./db");
  const { sendWhatsApp } = require("./utils");
  const messages = require("./posting-messages").build({ pageBaseUrl, authSecret });
  return {
    db, pageBaseUrl,
    post: require("./posting-driver").postToGroup,
    notify: (phone, msg) => sendWhatsApp(phone, msg, greenInstance, greenToken),
    notifyOperator: operatorPhone ? (msg) => sendWhatsApp(operatorPhone, msg, greenInstance, greenToken) : null,
    listRecentlyHaltedPhones: (now) => db.listPhonesHaltedSince(now.getTime() - 86400000),
    messages,
  };
}

module.exports = { create, pause, resume, stop, approvePost, skipPost, tick, sweep, startSweeper, liveDeps, SWEEP_MS, _test: { groupSlug, groupToken, allGroupsDone } };
```

`db.listPhonesHaltedSince(ms)` is a query over connections where `posting_last_halt_at > since` — add `posting_last_halt_at` to the `patchConn` in `haltAccount` and the query to `db.js` (single-field where, no composite index). `posting-messages.js` is written in Task 17; until then `deps.messages` is undefined and the inline fallbacks above apply.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && node posting-campaign.test.js && node distribution/share-kit.test.js`
Expected: both PASS.

- [ ] **Step 6: Add to the test chain and commit**

Append ` && node posting-campaign.test.js` to `scripts.test`.

```bash
cd server && npm test
git add server/db.js server/posting-campaign.js server/posting-campaign.test.js server/package.json
git commit -m "feat(posting): campaign state machine with account-level halts and a kill switch"
```

---

### Task 15: `posting-driver.js` — the browser actions

The most brittle file in the plan, on purpose isolated so it is the *only* file that knows what Facebook's composer looks like. Every selector lives in one object at the top. [Unverified] The selectors below are a starting point; Task 20's dry run is where they get fixed against the real page.

What this file does that the first draft did not: it **behaves like a person before it posts**. Land on the home feed, scroll for a while, then go to the group, scroll once, then write — with a typing cadence drawn from a distribution, pauses at word boundaries, and a beat before pressing Post. The link goes in a comment, not the body. Verification is by the post's own words and captures the permalink.

**Files:**
- Create: `server/posting-driver.js`
- Create: `server/posting-driver.test.js`
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Consumes: `driver-browser.withPage`, `posting-safety.classifySignal`, `profile-lock` (via `withPage`'s `phone` dep).
- Produces: `postToGroup({ groupUrl, copy, comment, profileName, dryRun, campaignId, phone }, deps) -> Promise<{ post_url: string|null, dry_run: boolean }>`. Throws with `code` ∈ `classifySignal` values or `composer_not_found` / `post_failed` / `not_verified`; Driver errors keep their `status`.

- [ ] **Step 1: Write the failing test**

Create `server/posting-driver.test.js`:

```js
/* posting-driver.js — the composer choreography, against a fake page.
   The fake matches on the EXPORTED selectors, not on words in them. */
const assert = require("assert");
const PD = require("./posting-driver");
const S = PD.SELECTORS;

function fakePage(script = {}) {
  const typed = [], clicked = [], visited = [], scrolls = [];
  let url = script.landed || "https://www.facebook.com/groups/1";
  const regionText = (sel) => (sel === S.dialog ? script.dialogText || "" : sel === S.alert ? script.alertText || "" : script.bodyText || "כתבו משהו…");
  return {
    typed, clicked, visited, scrolls,
    goto: async (u) => { visited.push(u); url = script.landed || u; },
    url: () => url,
    title: async () => "Group | Facebook",
    innerText: async (sel) => regionText(sel),
    locator: (sel) => {
      const present = !(script.missing || []).includes(sel);
      const node = { count: async () => (present ? 1 : 0), click: async () => { clicked.push(sel); }, waitFor: async () => { if (!present) throw new Error("timeout"); }, innerText: async () => regionText(sel), getAttribute: async () => script.permalink || null };
      return Object.assign(node, { first: () => node, nth: () => node });
    },
    keyboard: { type: async (t) => typed.push(t), press: async () => {} },
    mouse: { wheel: async (x, y) => scrolls.push(y), move: async () => {} },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    $$eval: async (sel) => (sel === S.feedPost ? (script.feedPosts || []) : []),
  };
}
const args = (o = {}) => Object.assign({ groupUrl: "https://www.facebook.com/groups/1", copy: "🏠 דירה בחיפה 4 חדרים", comment: "https://f.ly/p/pg1?src=fb_group&s=c1&g=abcdef123456", profileName: "facebook-prod-x", dryRun: false, campaignId: "c1", phone: "p" }, o);
const withPageOf = (page, onOpts) => async (opts, fn) => { if (onOpts) onOpts(opts); return fn(page, { sessionId: "s" }); };

(async () => {
  // ── happy path: feed first, scroll, then the group; type the copy (in chunks); post; comment the link; verify by text; return the permalink ──
  const page = fakePage({ feedPosts: [{ text: "🏠 דירה בחיפה 4 חדרים …", href: "https://www.facebook.com/groups/1/posts/999" }] });
  let seen = null;
  const out = await PD.postToGroup(args(), { withPage: withPageOf(page, (o) => { seen = o; }), typingDelay: () => 0, dwell: () => 0 });
  assert.deepEqual(seen.profile, { name: "facebook-prod-x", persist: true });
  assert.ok(String(seen.note).startsWith("forly-post:c1") && !seen.note.includes("p:"), "note carries the campaign id, never the phone");
  assert.ok(!("url" in seen));
  assert.equal(page.visited[0], "https://www.facebook.com/", "the feed comes first");
  assert.equal(page.visited[1], "https://www.facebook.com/groups/1");
  assert.ok(page.scrolls.length >= 3, "scrolled the feed like a person");
  assert.equal(page.typed.join(""), "🏠 דירה בחיפה 4 חדרים");
  assert.ok(page.typed.length > 1, "typed in word-sized chunks with pauses, not one insertText");
  assert.ok(page.clicked.includes(S.submit));
  assert.ok(page.typed.some((t) => t.includes("f.ly")) && page.clicked.includes(S.commentSubmit), "the link went into a comment");
  assert.equal(out.post_url, "https://www.facebook.com/groups/1/posts/999");
  assert.equal(out.dry_run, false);

  // ── dry run does everything except submit (and therefore no comment either) ──
  const page2 = fakePage();
  const dry = await PD.postToGroup(args({ dryRun: true }), { withPage: withPageOf(page2), typingDelay: () => 0, dwell: () => 0 });
  assert.equal(dry.dry_run, true);
  assert.equal(page2.typed.join(""), "🏠 דירה בחיפה 4 חדרים");
  assert.ok(!page2.clicked.includes(S.submit) && !page2.clicked.includes(S.commentSubmit));

  // ── a URL that is not a Facebook group is refused before any navigation ──
  await assert.rejects(PD.postToGroup(args({ groupUrl: "https://evil.example/x" }), { withPage: async () => { throw new Error("must not open"); } }), (e) => e.code === "invalid_input");

  // ── signals come from the URL, the dialog and the alert — never the feed ──
  for (const [script, code] of [
    [{ landed: "https://www.facebook.com/checkpoint/123/" }, "checkpoint"],
    [{ landed: "https://www.facebook.com/login/?next=x" }, "login_required"],
    [{ alertText: "You're temporarily blocked" }, "rate_limited"],
    [{ dialogText: "You can't use this feature right now" }, "feature_blocked"],
  ]) {
    const pg = fakePage(script);
    await assert.rejects(PD.postToGroup(args(), { withPage: withPageOf(pg), typingDelay: () => 0, dwell: () => 0 }), (e) => e.code === code);
    assert.equal(pg.typed.length, 0, `${code}: nothing typed`);
  }
  const feedOnly = fakePage({ bodyText: "אתם חסומים זמנית security check", feedPosts: [{ text: "🏠 דירה בחיפה 4 חדרים", href: "https://www.facebook.com/groups/1/posts/1" }] });
  await PD.postToGroup(args(), { withPage: withPageOf(feedOnly), typingDelay: () => 0, dwell: () => 0 }); // does not throw

  // ── no composer: fail loudly with the code the calibration script looks for ──
  const pg3 = fakePage({ missing: [S.composer] });
  await assert.rejects(PD.postToGroup(args(), { withPage: withPageOf(pg3), typingDelay: () => 0, dwell: () => 0 }), (e) => e.code === "composer_not_found");

  // ── submitted, but an admin-approval alert appeared: pending_approval, not a failure ──
  const pg4 = fakePage({ feedPosts: [] });
  pg4.innerText = async (sel) => (sel === S.alert && pg4.clicked.includes(S.submit) ? "הפוסט שלך ממתין לאישור" : "");
  await assert.rejects(PD.postToGroup(args(), { withPage: withPageOf(pg4), typingDelay: () => 0, dwell: () => 0 }), (e) => e.code === "pending_approval");

  // ── submitted, nothing in the feed, no alert: not_verified ──
  const pg5 = fakePage({ feedPosts: [{ text: "someone else", href: "x" }] });
  await assert.rejects(PD.postToGroup(args(), { withPage: withPageOf(pg5), typingDelay: () => 0, dwell: () => 0 }), (e) => e.code === "not_verified");

  console.log("posting-driver.test.js ok");
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node posting-driver.test.js`
Expected: FAIL with `Cannot find module './posting-driver'`

- [ ] **Step 3: Write the implementation**

Create `server/posting-driver.js`:

```js
/*
 * posting-driver.js — put one post into one group, from a background browser,
 * the way a person would.
 *
 * This is the ONLY file that knows what Facebook's page looks like. When the
 * composer changes, SELECTORS is what changes. Nothing here retries: a failed
 * post is a failed post, and the campaign decides what that means.
 *
 * Nothing here is hidden from the platform — no init scripts, no request
 * routing, no fingerprint tricks. It is a real Chrome with the agent's own
 * profile. What makes it look human is what it DOES: it opens the feed and
 * reads for a while, then the group, then writes at a human cadence, pauses,
 * posts, and puts the link in a comment like the share kit already advises.
 *
 * [Unverified] SELECTORS is a starting point. Task 20 fixes it against the live
 * page before the first real post.
 */
const driver = require("./driver-browser");
const { classifySignal } = require("./posting-safety");

const SELECTORS = {
  composer: 'div[role="main"] [role="button"]:has-text("כתבו משהו"), div[role="main"] [role="button"]:has-text("Write something"), div[aria-label="כתבו משהו..."], div[aria-label="Write something..."]',
  editor: 'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
  submit: 'div[role="dialog"] div[aria-label="פרסום"][role="button"], div[role="dialog"] div[aria-label="Post"][role="button"]',
  dialog: 'div[role="dialog"]',
  alert: '[role="alert"], [role="status"]',
  feedPost: 'div[role="feed"] > div',
  feedPostText: 'div[data-ad-preview="message"], div[dir="auto"]',
  feedPostLink: 'a[href*="/posts/"]',
  commentBox: 'div[aria-label="כתיבת תגובה…"], div[aria-label="Write a comment…"], div[aria-label^="Write a comment"], div[aria-label^="כתיבת תגובה"]',
  commentSubmit: 'div[aria-label="תגובה"][role="button"], div[aria-label="Comment"][role="button"]',
};

const GROUP_URL = /^https:\/\/www\.facebook\.com\/groups\/[A-Za-z0-9._-]+\/?$/;
function fail(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

// Human-ish numbers. Lognormal-ish per-character delay with word-boundary
// pauses; a dwell measured in tens of seconds, not milliseconds.
const rnd = (a, b) => a + Math.random() * (b - a);
const defaultTypingDelay = () => Math.round(Math.exp(rnd(3.9, 5.1)));    // ~50–165 ms
const defaultDwell = (a, b) => Math.round(rnd(a, b) * 1000);

async function readSignal(page) {
  const dialogText = await page.locator(SELECTORS.dialog).first().innerText().catch(() => "");
  const alertText = await page.locator(SELECTORS.alert).first().innerText().catch(() => "");
  return classifySignal({ landedUrl: page.url(), dialogText, alertText });
}

async function humanType(page, text, typingDelay) {
  // Word-sized chunks with a per-character delay, and a longer pause at some
  // word boundaries. Never one insertText of the whole message.
  const words = String(text).split(/(\s+)/);
  for (const w of words) {
    if (!w) continue;
    await page.keyboard.type(w, { delay: typingDelay() });
    if (/\s/.test(w) && Math.random() < 0.06) await page.waitForTimeout(rnd(400, 1500));
  }
}

async function browse(page, dwell) {
  // Read the feed for a while before doing anything. Yes, this costs bandwidth.
  await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  const scrolls = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, Math.round(rnd(300, 900)));
    await page.waitForTimeout(dwell(4, 12));
  }
}

async function postToGroup({ groupUrl, copy, comment, profileName, dryRun = false, campaignId, phone }, deps = {}) {
  if (!GROUP_URL.test(String(groupUrl || ""))) throw fail("invalid_input", "not a facebook group url");
  const withPage = deps.withPage || driver.withPage;
  const typingDelay = deps.typingDelay || defaultTypingDelay;
  const dwell = deps.dwell || defaultDwell;
  const opts = {
    country: "IL",
    duration: 900,
    type: deps.browserType || process.env.POSTING_BROWSER_TYPE || "hosted",
    note: `forly-post:${campaignId || "adhoc"}`,
    profile: { name: profileName, persist: true },
  };
  return withPage(opts, async (page) => {
    await browse(page, dwell);
    let signal = await readSignal(page);
    if (signal !== "ok") throw fail(signal, `signal on feed: ${signal}`);

    await page.goto(groupUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.mouse.wheel(0, Math.round(rnd(200, 600)));
    await page.waitForTimeout(dwell(3, 8));
    signal = await readSignal(page);
    if (signal !== "ok") throw fail(signal, `signal on group: ${signal}`);

    const composer = page.locator(SELECTORS.composer).first();
    if ((await composer.count()) === 0) throw fail("composer_not_found", "no composer on the group page");
    await composer.click();
    const editor = page.locator(SELECTORS.editor).first();
    await editor.waitFor({ timeout: 10000 }).catch(() => { throw fail("composer_not_found", "editor did not open"); });
    await editor.click();
    await humanType(page, copy, typingDelay);
    await page.waitForTimeout(dwell(5, 20)); // re-read before posting, like anyone would

    if (dryRun) return { post_url: null, dry_run: true };

    await page.locator(SELECTORS.submit).first().click();
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(dwell(2, 5));

    const after = await readSignal(page);
    if (after !== "ok") throw fail(after, `signal after submit: ${after}`);

    // Verify by what a person would check: our words, in the feed, now.
    const marker = String(copy).split("\n").find((l) => l.trim().length > 12) || String(copy).slice(0, 40);
    const posts = await page.$$eval(SELECTORS.feedPost, (els, sels) => els.slice(0, 6).map((el) => ({
      text: Array.from(el.querySelectorAll(sels.text)).map((t) => t.textContent || "").join(" "),
      href: (el.querySelector(sels.link) || {}).href || null,
    })), { text: SELECTORS.feedPostText, link: SELECTORS.feedPostLink }).catch(() => []);
    const mine = posts.find((p) => p.text.includes(marker.trim()));
    if (!mine) throw fail("not_verified", "post not found in feed after submit");

    // The link, as a first comment — where the share kit already tells agents
    // to put it, and where it does not colour the post itself.
    if (comment) {
      await page.waitForTimeout(dwell(8, 25));
      const box = page.locator(SELECTORS.commentBox).first();
      if ((await box.count()) > 0) {
        await box.click();
        await humanType(page, comment, typingDelay);
        await page.waitForTimeout(dwell(1, 3));
        await page.locator(SELECTORS.commentSubmit).first().click().catch(() => page.keyboard.press("Enter"));
        await page.waitForTimeout(dwell(2, 4));
      }
    }
    return { post_url: mine.href || page.url(), dry_run: false };
  }, Object.assign({ phone }, deps));
}

module.exports = { postToGroup, SELECTORS };
```

If Task 1 recorded a datacenter `EGRESS_ASN`, set `POSTING_BROWSER_TYPE=hosted_privacy` in the environment; the code above reads it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node posting-driver.test.js`
Expected: PASS.

- [ ] **Step 5: Add to the test chain and commit**

Append ` && node posting-driver.test.js` to `scripts.test`.

```bash
cd server && npm test
git add server/posting-driver.js server/posting-driver.test.js server/package.json
git commit -m "feat(posting): human-paced browser choreography with link-in-comment and dry run"
```

---

### Task 16: `routes/posting.js` — the campaign API

**Files:**
- Create: `server/routes/posting.js`
- Create: `server/routes/posting.test.js`
- Modify: `server/routes/distribution.js` (export `mergedCatalog`)
- Modify: `server/index.js` (mount + sweeper with credentials)
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Consumes: `posting-campaign.*`, `share-kit.sanitizeGroups`, `routes/distribution.mergedCatalog`, `db.getPage/getConnection/setConnection/listPostingCampaignsByPhone`.
- Produces:
  - `POST /api/posting/campaigns` body `{ page_id, group_urls: string[], mode: "per_post"|"standing", days?: number, repeat?: boolean, consent: true, account_aged?: boolean, posted_manually?: boolean }` → `201 {campaign}`; `400 consent_required | invalid_input`; `409 facebook_not_connected | too_many_campaigns`; `422 {error:"unknown_group", groups:[…]}` when a URL is not in the catalog and the request did not set `include_unknown: true`.
  - `POST /api/posting/campaigns/:id/pause | resume | stop`, `POST /api/posting/campaigns/:id/posts/:post_id/approve | skip` → `200 {campaign}`
  - `GET /api/posting/campaigns?page_id=` → `200 {campaigns:[…]}`; `GET /api/posting/campaigns/:id` → `200 {campaign}`; `404` for another phone's.
  - `GET /api/posting/act?c=&p=&a=approve|skip|stop&t=` — the signed WhatsApp one-tap link (Task 17 builds the links; this handles them, mirroring `routes/distribution.js` `/confirm`).
  - `publicView(campaign)` strips `page_snapshot`, `copy_hash`, and anything matching `wss://` / `viewer.driver.dev`.

- [ ] **Step 1: Write the failing test**

Create `server/routes/posting.test.js`:

```js
/* routes/posting.js — ownership, the policy gate, consent, and that nothing leaks. */
const assert = require("assert");
const express = require("express");
const http = require("http");
const createRouter = require("./posting");
const { signActionToken } = require("../auth");

const PHONE = "0500000000";
function makeApp(o = {}) {
  const phone = o.phone || PHONE;
  const requireAuth = () => (req, res, next) => { req.user = { userId: phone }; next(); };
  const app = express(); app.use(express.json());
  app.use("/api/posting", createRouter({ requireAuth, authSecret: "s", pageBaseUrl: "https://f.ly", db: o.db, campaigns: o.campaigns, catalog: o.catalog || (async () => catalog), deps: o.deps || {} }));
  return app;
}
function call(app, method, path, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const req = http.request({ port: server.address().port, path, method, headers: { "content-type": "application/json" } }, (res) => {
        let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: d.startsWith("{") ? JSON.parse(d) : {}, raw: d }); });
      });
      if (body) req.write(JSON.stringify(body)); req.end();
    });
  });
}
const catalog = [
  { url: "https://www.facebook.com/groups/111", name: "OK", agent_policy: "explicitly_allowed" },
  { url: "https://www.facebook.com/groups/222", name: "?", agent_policy: "unknown" },
];
const baseDb = (over = {}) => Object.assign({
  getPage: async (id) => (id === "pg1" ? { page_id: "pg1", business_phone: PHONE, status: "active", property: { title: "t" }, agent: {} } : null),
  getConnection: async () => ({ facebook_browser_connected_at: "2026-09-01T00:00:00Z" }),
  setConnection: async () => {},
  listPostingCampaignsByPhone: async () => [],
}, over);
const consented = (b) => Object.assign({ consent: true, account_aged: true, posted_manually: true }, b);

(async () => {
  let created = null;
  const campaigns = { create: async (input) => { created = input; return { id: "c1", phone: PHONE, status: "running", posts: [], groups: input.groups }; } };
  const app = makeApp({ db: baseDb(), campaigns });

  // ── consent is required, and recorded with a version ──
  const noConsent = await call(app, "POST", "/api/posting/campaigns", { page_id: "pg1", group_urls: [catalog[0].url], mode: "standing" });
  assert.equal(noConsent.status, 400); assert.equal(noConsent.body.error, "consent_required");

  // ── URLs are canonicalised before the catalog lookup: a trailing slash must not dodge the policy ──
  const ok = await call(app, "POST", "/api/posting/campaigns", consented({ page_id: "pg1", group_urls: ["https://www.facebook.com/groups/111/?ref=share"], mode: "standing", days: 14 }));
  assert.equal(ok.status, 201);
  assert.equal(created.groups[0].url, catalog[0].url);
  assert.equal(created.groups[0].agent_policy, "explicitly_allowed");
  assert.equal(created.consent.version, createRouter.CONSENT_VERSION);
  assert.ok(!("page_snapshot" in ok.body.campaign));

  // ── a group outside the catalog needs an explicit opt-in ──
  const unknown = await call(app, "POST", "/api/posting/campaigns", consented({ page_id: "pg1", group_urls: ["https://www.facebook.com/groups/999"], mode: "standing" }));
  assert.equal(unknown.status, 422); assert.equal(unknown.body.error, "unknown_group");
  const optIn = await call(app, "POST", "/api/posting/campaigns", consented({ page_id: "pg1", group_urls: ["https://www.facebook.com/groups/999"], mode: "standing", include_unknown: true }));
  assert.equal(optIn.status, 201); assert.equal(created.groups[0].agent_policy, "unknown");

  // ── the account's two questions are persisted for the pacer ──
  let connPatch = null;
  await call(makeApp({ db: baseDb({ setConnection: async (p, patch) => { connPatch = patch; } }), campaigns }), "POST", "/api/posting/campaigns", consented({ page_id: "pg1", group_urls: [catalog[0].url], mode: "standing", account_aged: false }));
  assert.equal(connPatch.posting_account_aged, false);

  // ── gates: connection, ownership, group count, campaign count ──
  assert.equal((await call(makeApp({ db: baseDb({ getConnection: async () => ({}) }), campaigns }), "POST", "/api/posting/campaigns", consented({ page_id: "pg1", group_urls: [catalog[0].url], mode: "standing" }))).status, 409);
  assert.equal((await call(makeApp({ phone: "0509999999", db: baseDb(), campaigns }), "POST", "/api/posting/campaigns", consented({ page_id: "pg1", group_urls: [catalog[0].url], mode: "standing" }))).status, 404);
  assert.equal((await call(app, "POST", "/api/posting/campaigns", consented({ page_id: "pg1", group_urls: [], mode: "standing" }))).status, 400);
  const busy = makeApp({ db: baseDb({ listPostingCampaignsByPhone: async () => [{ status: "running" }, { status: "running" }, { status: "paused" }] }), campaigns });
  assert.equal((await call(busy, "POST", "/api/posting/campaigns", consented({ page_id: "pg1", group_urls: [catalog[0].url], mode: "standing" }))).body.error, "too_many_campaigns");

  // ── stop is owner-only; another phone's campaign reads as missing ──
  const db3 = baseDb({ getPostingCampaign: async () => ({ id: "c1", phone: PHONE, status: "running", posts: [] }) });
  assert.equal((await call(makeApp({ db: db3, campaigns: { stop: async (id) => ({ id, phone: PHONE, status: "stopped", posts: [] }) } }), "POST", "/api/posting/campaigns/c1/stop")).body.campaign.status, "stopped");
  assert.equal((await call(makeApp({ phone: "0509999999", db: db3, campaigns: { stop: async () => { throw new Error("must not"); } } }), "POST", "/api/posting/campaigns/c1/stop")).status, 404);

  // ── the signed one-tap link: right token acts, wrong token does not, and it renders a page, not JSON ──
  let approved = null;
  const actApp = makeApp({ db: db3, campaigns: { approvePost: async (id, pid) => { approved = [id, pid]; return { id, phone: PHONE, status: "running", posts: [{ id: pid, status: "scheduled", scheduled_at: "2026-09-24T11:00:00+03:00", group_name: "OK" }] }; } } });
  const good = await call(actApp, "GET", `/api/posting/act?c=c1&p=p1&a=approve&t=${signActionToken(["c1", "p1", "approve"], "s")}`);
  assert.equal(good.status, 200); assert.ok(good.raw.includes("אושר"));
  assert.deepEqual(approved, ["c1", "p1"]);
  const bad = await call(actApp, "GET", `/api/posting/act?c=c1&p=p1&a=stop&t=${signActionToken(["c1", "p1", "approve"], "s")}`);
  assert.equal(bad.status, 403);

  // ── no browser secret in any response, ever ──
  const leaky = { id: "c1", phone: PHONE, status: "running", posts: [{ id: "p", status: "posted", copy_hash: "h" }], view_url: "https://viewer.driver.dev?ws=wss://x", cdpUrl: "wss://x" };
  const get = await call(makeApp({ db: baseDb({ getPostingCampaign: async () => leaky }) }), "GET", "/api/posting/campaigns/c1");
  assert.equal(get.status, 200);
  assert.ok(!get.raw.includes("wss://") && !get.raw.includes("viewer.driver.dev") && !get.raw.includes("copy_hash"));

  console.log("routes/posting.test.js ok");
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node routes/posting.test.js`
Expected: FAIL with `Cannot find module './posting'`

- [ ] **Step 3: Export `mergedCatalog` from `routes/distribution.js`**

`mergedCatalog(want)` is a closure inside the router factory (line 293). Lift it to module scope (it uses `db.listGroupCatalog` and `GROUP_SEED`, both already module-level) and add `module.exports.mergedCatalog = mergedCatalog;`. `group-catalog-seed.test.js` and `session-groups.test.js` must still pass.

- [ ] **Step 4: Write the router**

Create `server/routes/posting.js`:

```js
/*
 * routes/posting.js — an agent's recorded permission to post, and the ledger
 * of what was done with it.
 *
 * Four gates on create, all server-side: consent; the browser profile is
 * connected; the page is theirs; every group is canonicalised and looked up in
 * the merged catalog, and an unknown group needs an explicit opt-in. There is
 * no "forbidden" policy in the catalog — the operator removes such groups.
 */
const express = require("express");
const campaignsLive = require("../posting-campaign");
const dbLive = require("../db");
const shareKit = require("../distribution/share-kit");
const { verifyActionToken } = require("../auth");

const CONSENT_VERSION = "2026-09-24";
const MAX_ACTIVE_CAMPAIGNS = 3;
const PUBLIC_FIELDS = ["id", "page_id", "mode", "repeat", "expires_at", "groups", "status", "pause_reason", "wait_reason", "posts", "consecutive_failures", "created_at", "updated_at"];
const POST_FIELDS = ["id", "group_url", "group_name", "status", "scheduled_at", "posted_at", "post_url", "error_code", "copy"];
const SECRET = /wss?:\/\/|viewer\.driver\.dev/;

function publicView(c) {
  if (!c) return null;
  const out = {};
  for (const k of PUBLIC_FIELDS) if (k in c) out[k] = c[k];
  out.posts = (c.posts || []).map((p) => { const q = {}; for (const k of POST_FIELDS) if (k in p) q[k] = p[k]; return q; });
  const json = JSON.stringify(out);
  return SECRET.test(json) ? JSON.parse(json.replace(/wss?:\/\/[^"\s]+/g, "[cdp]").replace(/https:\/\/viewer\.driver\.dev[^"\s]*/g, "[view]")) : out;
}

const card = (title, body) => `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Heebo,sans-serif;background:#F7F3EC;padding:24px;max-width:480px;margin:auto"><h2>${title}</h2><p style="line-height:1.7">${body}</p></body></html>`;

module.exports = function createPostingRouter(ctx) {
  const { requireAuth, authSecret, pageBaseUrl } = ctx;
  const db = ctx.db || dbLive;
  const campaigns = ctx.campaigns || campaignsLive;
  const catalog = ctx.catalog || ((want) => require("./distribution").mergedCatalog(want));
  const deps = Object.assign({ db, pageBaseUrl }, ctx.deps || {});
  const router = express.Router();

  async function owned(req, res) {
    const c = await db.getPostingCampaign(String(req.params.id)).catch(() => null);
    if (!c || c.phone !== req.user.userId) { res.status(404).json({ error: "not_found" }); return null; }
    return c;
  }

  router.post("/campaigns", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    const b = req.body || {};
    if (b.consent !== true) return res.status(400).json({ error: "consent_required" });
    const urls = shareKit.sanitizeGroups(Array.isArray(b.group_urls) ? b.group_urls.map((u) => ({ url: String(u) })) : []).map((g) => g.url);
    if (!b.page_id || !urls.length || !["per_post", "standing"].includes(b.mode)) return res.status(400).json({ error: "invalid_input" });

    const conn = (await db.getConnection(phone)) || {};
    if (!conn.facebook_browser_connected_at) return res.status(409).json({ error: "facebook_not_connected" });
    const page = await db.getPage(String(b.page_id)).catch(() => null);
    if (!page || page.business_phone !== phone) return res.status(404).json({ error: "not_found" });
    const live = (await db.listPostingCampaignsByPhone(phone)).filter((c) => ["running", "paused"].includes(c.status));
    if (live.length >= MAX_ACTIVE_CAMPAIGNS) return res.status(409).json({ error: "too_many_campaigns" });

    const known = new Map((await catalog((page.property || {}).deal || "sale")).map((g) => [g.url, g]));
    const groups = urls.map((u) => { const g = known.get(u); return g ? { url: g.url, name: g.name || "", agent_policy: g.agent_policy || "unknown" } : { url: u, name: "", agent_policy: "unknown", unknown: true }; });
    const unknown = groups.filter((g) => g.unknown);
    if (unknown.length && b.include_unknown !== true) return res.status(422).json({ error: "unknown_group", groups: unknown.map((g) => g.url) });

    // The two questions the pacer's warm-up depends on. Unanswered = unsure = slower.
    await db.setConnection(phone, {
      posting_account_aged: b.account_aged === true ? true : b.account_aged === false ? false : conn.posting_account_aged ?? null,
      posting_posted_manually: b.posted_manually === true ? true : b.posted_manually === false ? false : conn.posting_posted_manually ?? null,
    });

    const c = await campaigns.create({
      phone, page, groups: groups.map(({ url, name, agent_policy }) => ({ url, name, agent_policy })),
      mode: b.mode, days: b.days, repeat: b.repeat === true,
      consent: { at: new Date().toISOString(), version: CONSENT_VERSION, ip: req.ip },
    }, deps);
    return res.status(201).json({ campaign: publicView(c) });
  });

  for (const [action, fn] of [["pause", (id) => campaigns.pause(id, "agent", deps)], ["resume", (id) => campaigns.resume(id, deps)], ["stop", (id) => campaigns.stop(id, deps)]]) {
    router.post(`/campaigns/:id/${action}`, requireAuth(authSecret), async (req, res) => {
      if (!(await owned(req, res))) return;
      return res.json({ campaign: publicView(await fn(req.params.id)) });
    });
  }
  router.post("/campaigns/:id/posts/:post_id/approve", requireAuth(authSecret), async (req, res) => {
    if (!(await owned(req, res))) return;
    return res.json({ campaign: publicView(await campaigns.approvePost(req.params.id, String(req.params.post_id), deps)) });
  });
  router.post("/campaigns/:id/posts/:post_id/skip", requireAuth(authSecret), async (req, res) => {
    if (!(await owned(req, res))) return;
    return res.json({ campaign: publicView(await campaigns.skipPost(req.params.id, String(req.params.post_id), deps)) });
  });

  // The WhatsApp one-tap. Same shape as routes/distribution.js /confirm: a
  // signed token over [campaign, post, action], an HTML card back, no login
  // needed — the token IS the proof the link came from us to this phone.
  router.get("/act", async (req, res) => {
    const c = String(req.query.c || ""), p = String(req.query.p || ""), a = String(req.query.a || ""), t = String(req.query.t || "");
    if (!["approve", "skip", "stop"].includes(a) || !verifyActionToken([c, p, a], t, authSecret)) return res.status(403).send(card("הקישור לא תקין", "ייתכן שפג תוקפו. אפשר לאשר או לעצור גם מעמוד הנכס בדשבורד."));
    const camp = await db.getPostingCampaign(c).catch(() => null);
    if (!camp) return res.status(404).send(card("לא נמצא", "הקמפיין הזה כבר לא קיים."));
    if (a === "stop") { await campaigns.stop(c, deps); return res.send(card("✋ הפרסום נעצר", "מה שכבר פורסם נשאר בקבוצות. אפשר להתחיל שוב מתי שתרצו, מעמוד הנכס.")); }
    if (a === "skip") { await campaigns.skipPost(c, p, deps); return res.send(card("⏭ דילגנו על הקבוצה הזו", "נמשיך לקבוצה הבאה בתור.")); }
    const out = await campaigns.approvePost(c, p, deps);
    const post = (out.posts || []).find((x) => x.id === p) || {};
    const when = post.scheduled_at ? new Date(post.scheduled_at).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    return res.send(card("✅ אושר!", `הפוסט יעלה לקבוצה "${post.group_name || ""}" ב-${when}. נעדכן בוואטסאפ כשזה קורה.`));
  });

  router.get("/campaigns", requireAuth(authSecret), async (req, res) => {
    const all = await db.listPostingCampaignsByPhone(req.user.userId);
    const pageId = req.query.page_id ? String(req.query.page_id) : null;
    return res.json({ campaigns: all.filter((c) => !pageId || c.page_id === pageId).map(publicView) });
  });
  router.get("/campaigns/:id", requireAuth(authSecret), async (req, res) => {
    const c = await owned(req, res);
    if (c) return res.json({ campaign: publicView(c) });
  });

  return router;
};
module.exports.publicView = publicView;
module.exports.CONSENT_VERSION = CONSENT_VERSION;
```

`verifyActionToken(parts, token, secret)` — confirm the argument order against `server/auth.js` before writing the call; `routes/distribution.js` `/confirm` shows it in use.

- [ ] **Step 5: Mount and start the sweeper with real credentials**

In `server/index.js`, inside the `if (process.env.DRIVER_API_KEY)` block from Task 7, **with the Green API credentials `distribution/jobs.liveDeps` already receives** — without them `sendWhatsApp` returns silently and per-post approval never reaches anyone:

```js
  const posting = require("./posting-campaign");
  posting.startSweeper(posting.liveDeps({ greenInstance: GREEN_INSTANCE, greenToken: GREEN_TOKEN, pageBaseUrl: PAGE_BASE_URL, authSecret: AUTH_SECRET, operatorPhone: process.env.POSTING_OPERATOR_PHONE }));
  console.log("driver: posting sweeper started");
```

and with the other router mounts:

```js
const createPostingRouter = require("./routes/posting");
app.use("/api/posting", createPostingRouter({ requireAuth, authSecret: AUTH_SECRET, pageBaseUrl: PAGE_BASE_URL,
  deps: require("./posting-campaign").liveDeps({ greenInstance: GREEN_INSTANCE, greenToken: GREEN_TOKEN, pageBaseUrl: PAGE_BASE_URL, authSecret: AUTH_SECRET }) }));
```

Use the exact variable names `index.js` already has for the Green instance/token and page base URL (see the `createDistributionRouter` call around line 219).

- [ ] **Step 6: Run tests, add to the chain, commit**

Run: `cd server && node routes/posting.test.js && node distribution/group-catalog-seed.test.js && node distribution/session-groups.test.js`
Expected: all PASS. Append ` && node routes/posting.test.js` to `scripts.test`.

```bash
cd server && npm test
git add server/routes/posting.js server/routes/posting.test.js server/routes/distribution.js server/index.js server/package.json
git commit -m "feat(posting): campaign API with consent, canonical group gate and one-tap links"
```

---

### Task 17: `posting-messages.js` — every state change reaches the agent's phone

The agent is mid-showing when the checkpoint fires. The dashboard polls only while open. The existing product's idiom is a WhatsApp line with a signed one-tap link (`distribution/jobs.js` `M.confirmOffer` + `BTN`), and per-post approval — the default mode — must be one tap, not "open the dashboard, find the page, find the card, find the row".

**Files:**
- Create: `server/posting-messages.js`
- Create: `server/posting-messages.test.js`
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Consumes: `auth.signActionToken`.
- Produces: `build({ pageBaseUrl, authSecret }) -> { approve(campaign, post), posted(campaign, post), paused(campaign), halted(campaign, code), stopped(campaign), completed(campaign) }` — each returns a Hebrew string.

- [ ] **Step 1: Write the failing test**

Create `server/posting-messages.test.js`:

```js
/* posting-messages.js — the WhatsApp lines. Every one is Hebrew, in Forly's
   voice (plural imperatives, Forly as "she"), and the ones that need a tap
   carry a signed link. Vendor codes never appear. */
const assert = require("assert");
const { verifyActionToken } = require("./auth");
const M = require("./posting-messages").build({ pageBaseUrl: "https://f.ly", authSecret: "s" });
const camp = { id: "c1", groups: [{ url: "g", name: "דירות בחיפה" }] };
const post = { id: "p1", group_name: "דירות בחיפה", scheduled_at: "2026-09-24T11:00:00+03:00", copy: "🏠 דירה 4 חדרים בחיפה\nמחיר 1,900,000 ₪" };

const approve = M.approve(camp, post);
assert.ok(approve.includes("דירות בחיפה") && approve.includes("4 חדרים"), "group and the exact copy");
for (const a of ["approve", "skip", "stop"]) {
  const m = approve.match(new RegExp(`https://f\\.ly/api/posting/act\\?c=c1&p=p1&a=${a}&t=([^\\s]+)`));
  assert.ok(m, `${a} link present`);
  assert.ok(verifyActionToken(["c1", "p1", a], m[1], "s"), `${a} link is signed`);
}
assert.ok(approve.includes("לא מפרסמים בלי האישור שלכם"));
assert.ok(!/undefined|null/.test(approve));

assert.ok(M.posted(camp, Object.assign({}, post, { post_url: "https://www.facebook.com/groups/1/posts/9" })).includes("posts/9"));
assert.ok(M.halted(camp, "checkpoint").includes("פייסבוק") && !M.halted(camp, "checkpoint").includes("checkpoint"), "no vendor code");
assert.ok(M.halted(camp, "login_required").includes("לחבר"));
assert.ok(M.halted(camp, "rate_limited").includes("להאט"));
assert.ok(M.paused(camp).match(/act\?c=c1&p=-&a=stop/), "even a pause message offers stop");
assert.ok(M.stopped(camp).includes("נשאר"));
assert.ok(M.completed(camp).includes("סיימה"));
console.log("posting-messages.test.js ok");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node posting-messages.test.js`
Expected: FAIL with `Cannot find module './posting-messages'`

- [ ] **Step 3: Write the messages**

Create `server/posting-messages.js`:

```js
/*
 * posting-messages.js — the WhatsApp side of a campaign.
 *
 * Same rules as distribution/jobs.js's M: user-facing Hebrew only, vendor
 * error text NEVER, and the approval shows the EXACT copy that will go out
 * under the agent's name. Links are signed with the existing action-token
 * scheme, so a tap needs no login — the token is the proof.
 */
const { signActionToken } = require("./auth");
const FENCE = "──────────";
const when = (iso) => (iso ? new Date(iso).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

function build({ pageBaseUrl, authSecret }) {
  const link = (c, p, a) => `${pageBaseUrl}/api/posting/act?c=${encodeURIComponent(c)}&p=${encodeURIComponent(p)}&a=${a}&t=${signActionToken([c, p, a], authSecret)}`;
  const HALT = {
    checkpoint: "פייסבוק רוצה לוודא שזה אתם — זה קורה, והחשבון שלכם בסדר. פורלי הפסיקה לפרסם מהחשבון עד שנבדוק יחד. נחזור אליכם.",
    captcha: "פייסבוק ביקשה אימות — זה קורה, והחשבון שלכם בסדר. פורלי הפסיקה לפרסם מהחשבון עד שנבדוק יחד. נחזור אליכם.",
    restricted: "פייסבוק הגבילה את החשבון. פורלי הפסיקה לפרסם ממנו. כדאי להיכנס לפייסבוק ולבדוק את ההודעות שם — ונחזור אליכם.",
    rate_limited: "פייסבוק ביקשה להאט. לא צריך לעשות כלום — פורלי תחכה שבועיים ותמשיך לאט יותר.",
    feature_blocked: "פייסבוק חסמה זמנית את הפרסום מהחשבון. לא צריך לעשות כלום — פורלי תחכה שבועיים ותמשיך לאט יותר.",
    login_required: "החיבור לחשבון הפייסבוק האישי שלכם פג — זה קורה מדי פעם. כדי להמשיך, צריך לחבר אותו מחדש בעמוד ההפצה.",
  };
  return {
    approve: (c, p) =>
      `📣 פוסט מוכן לקבוצה "${p.group_name || ""}"\nיעלה ב-${when(p.scheduled_at)} — אחרי האישור שלכם.\n${FENCE}\n${p.copy}\n${FENCE}\n\n` +
      `✅ לאישור: ${link(c.id, p.id, "approve")}\n⏭ לדילוג על הקבוצה הזו: ${link(c.id, p.id, "skip")}\n✋ לעצירת כל הפרסום: ${link(c.id, p.id, "stop")}\n\nלא מפרסמים בלי האישור שלכם.`,
    posted: (c, p) => `✅ הפוסט עלה לקבוצה "${p.group_name || ""}".${p.post_url ? `\n${p.post_url}` : ""}\n\nלעצירת הפרסום: ${link(c.id, "-", "stop")}`,
    paused: (c) => `⏸ שני פוסטים ברצף לא עלו, אז פורלי עצרה לבדוק. בדקו שאתם עדיין חברים בקבוצות, ואז אפשר להמשיך מעמוד הנכס.\nלעצירה מוחלטת: ${link(c.id, "-", "stop")}`,
    halted: (c, code) => `⚠️ ${HALT[code] || HALT.checkpoint}`,
    stopped: () => `✋ הפרסום נעצר. מה שכבר פורסם נשאר בקבוצות. אפשר להתחיל שוב מתי שתרצו, מעמוד הנכס.`,
    completed: (c) => `🎉 פורלי סיימה לפרסם את הנכס בכל הקבוצות שבחרתם. אפשר להפעיל שוב אחרי שבועיים, מעמוד הנכס.`,
  };
}
module.exports = { build };
```

- [ ] **Step 4: Run, chain, commit**

Run: `cd server && node posting-messages.test.js`
Expected: PASS. Append ` && node posting-messages.test.js` to `scripts.test`.

```bash
cd server && npm test
git add server/posting-messages.js server/posting-messages.test.js server/package.json
git commit -m "feat(posting): WhatsApp messages with signed one-tap approve, skip and stop"
```

---

### Task 18: Operator controls and retention

The agent can stop their campaign. Forly must be able to stop **everyone's**, see the fleet, and turn a disabled account back on — and must not keep what it no longer needs.

**Files:**
- Create: `server/routes/admin-posting.js`
- Create: `server/routes/admin-posting.test.js`
- Modify: `server/db.js` (`listPhonesHaltedSince`, `listPostingCampaignsSince`)
- Modify: `server/index.js` (mount under the existing admin router's `requireAdmin`)
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Produces (all behind `requireAdmin` from `routes/admin.js`):
  - `GET /api/admin/posting/overview` → `{ enabled, disabled_reason, campaigns: {running, paused, stopped, completed}, halts_24h: [{phone_tail, code, at}], accounts_disabled: n }`
  - `POST /api/admin/posting/switch` body `{enabled: boolean, reason?}` → the kill switch.
  - `POST /api/admin/posting/accounts/:phone/reenable` → clears `posting_disabled_until_admin`, records `posting_reenabled_at` and the admin's id, resets warm-up (`facebook_browser_first_connected_at = now`).

- [ ] **Step 1: Write the failing test**

Create `server/routes/admin-posting.test.js`:

```js
const assert = require("assert");
const express = require("express");
const http = require("http");
const createRouter = require("./admin-posting");

const requireAdmin = (req, res, next) => { req.admin = { id: "ops" }; next(); };
function makeApp(db) { const app = express(); app.use(express.json()); app.use("/api/admin/posting", createRouter({ requireAdmin, db })); return app; }
function call(app, method, path, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const req = http.request({ port: server.address().port, path, method, headers: { "content-type": "application/json" } }, (res) => {
        let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(d || "{}") }); });
      });
      if (body) req.write(JSON.stringify(body)); req.end();
    });
  });
}
(async () => {
  const settings = { posting: { enabled: true } }; const conns = { "0500000000": { posting_disabled_until_admin: true, posting_halts: [{ at: new Date().toISOString(), code: "checkpoint" }] } };
  const db = {
    getSetting: async (k) => settings[k], setSetting: async (k, v) => { settings[k] = Object.assign(settings[k] || {}, v); },
    listPostingCampaignsSince: async () => [{ status: "running" }, { status: "running" }, { status: "paused" }],
    listPhonesHaltedSince: async () => ["0500000000"],
    getConnection: async (p) => conns[p], setConnection: async (p, patch) => Object.assign(conns[p], patch),
  };
  const app = makeApp(db);
  const ov = await call(app, "GET", "/api/admin/posting/overview");
  assert.equal(ov.body.enabled, true); assert.equal(ov.body.campaigns.running, 2);
  assert.equal(ov.body.halts_24h[0].phone_tail, "0000", "never the full phone in an overview");
  assert.equal(ov.body.halts_24h[0].code, "checkpoint");

  await call(app, "POST", "/api/admin/posting/switch", { enabled: false, reason: "dom change" });
  assert.equal(settings.posting.enabled, false); assert.equal(settings.posting.disabled_reason, "dom change");

  const re = await call(app, "POST", "/api/admin/posting/accounts/0500000000/reenable");
  assert.equal(re.status, 200);
  assert.equal(conns["0500000000"].posting_disabled_until_admin, false);
  assert.equal(conns["0500000000"].posting_reenabled_by, "ops");
  assert.ok(conns["0500000000"].facebook_browser_first_connected_at, "warm-up restarts");
  console.log("routes/admin-posting.test.js ok");
})();
```

- [ ] **Step 2: Write the router**

Create `server/routes/admin-posting.js`:

```js
/*
 * routes/admin-posting.js — the operator's three levers: see the fleet, stop
 * the fleet, and turn one account back on after a checkpoint.
 */
const express = require("express");
const dbLive = require("../db");
const tail = (p) => String(p || "").slice(-4);

module.exports = function createAdminPostingRouter({ requireAdmin, db = dbLive }) {
  const router = express.Router();
  router.get("/overview", requireAdmin, async (req, res) => {
    const since = Date.now() - 86400000;
    const setting = (await db.getSetting("posting")) || { enabled: true };
    const camps = await db.listPostingCampaignsSince(since - 29 * 86400000);
    const counts = {};
    for (const c of camps) counts[c.status] = (counts[c.status] || 0) + 1;
    const halted = [];
    let disabled = 0;
    for (const phone of await db.listPhonesHaltedSince(since)) {
      const conn = (await db.getConnection(phone)) || {};
      if (conn.posting_disabled_until_admin) disabled++;
      for (const h of (conn.posting_halts || []).filter((h) => new Date(h.at).getTime() > since)) halted.push({ phone_tail: tail(phone), code: h.code, at: h.at });
    }
    return res.json({ enabled: setting.enabled !== false, disabled_reason: setting.disabled_reason || null, campaigns: counts, halts_24h: halted, accounts_disabled: disabled });
  });
  router.post("/switch", requireAdmin, async (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    await db.setSetting("posting", { enabled, disabled_reason: enabled ? null : String((req.body && req.body.reason) || "operator"), changed_by: req.admin && req.admin.id, changed_at: new Date().toISOString() });
    return res.json({ enabled });
  });
  router.post("/accounts/:phone/reenable", requireAdmin, async (req, res) => {
    const phone = String(req.params.phone);
    if (!(await db.getConnection(phone))) return res.status(404).json({ error: "not_found" });
    await db.setConnection(phone, { posting_disabled_until_admin: false, posting_reenabled_at: new Date().toISOString(), posting_reenabled_by: req.admin && req.admin.id, facebook_browser_first_connected_at: new Date().toISOString() });
    return res.json({ ok: true });
  });
  return router;
};
```

Add to `db.js`: `listPhonesHaltedSince(ms)` (connections where `posting_last_halt_at > since`; store that field as an ISO string in `haltAccount`) and `listPostingCampaignsSince(ms)` (campaigns where `updated_at > since`). Mount in `index.js` with the same `requireAdmin` the admin router uses: `app.use("/api/admin/posting", createAdminPostingRouter({ requireAdmin }))`.

- [ ] **Step 3: Retention**

In `posting-campaign.js`, `patch()` sets `expire_at = updated_at + 30 days` whenever the status becomes `stopped` or `completed`; in `extract-jobs.js`, `create()` sets `expire_at = created_at + 7 days`. Configure a Firestore TTL policy on `expire_at` for both collections (console or `gcloud firestore fields ttls update`), and document the command in the findings file. The ledger already keeps 30 days; `copy` is already dropped once posted. Nothing stores the agent's phone in a Driver `note`.

- [ ] **Step 4: Run, chain, commit**

Run: `cd server && node routes/admin-posting.test.js`
Expected: PASS. Append ` && node routes/admin-posting.test.js` to `scripts.test`.

```bash
cd server && npm test
git add server/routes/admin-posting.js server/routes/admin-posting.test.js server/db.js server/index.js server/posting-campaign.js server/extract-jobs.js server/package.json
git commit -m "feat(posting): operator overview, kill switch, account re-enable, retention"
```

---

### Task 19: The campaign card, on the property's publish page

The card lives on `publish.html` — the per-property page that already has "שיתוף ידני בקבוצות", `session.page_id`, and `session.groups`. `distribution.html` is account-level and has none of those. `publish.html` loads only `publish.js` (no `form-i18n.js`): strings are inline Hebrew and the page's own `toast()` is used, as the rest of that file does.

**Files:**
- Modify: `public-agent/publish.html` (a card directly under the "שיתוף ידני בקבוצות" heading)
- Modify: `public-agent/publish.js`
- Modify: `public-agent/app.css`

- [ ] **Step 1: The card markup**

In `public-agent/publish.html`, under the manual-share section:

```html
  <section class="card" id="campaignCard" hidden>
    <h2>או: פורלי תפרסם בשבילכם <span class="conn-chip" id="campStatusChip"></span></h2>
    <p class="muted">פורלי תפרסם את הנכס בקבוצות שבחרתם, לאט ובזהירות — כמה פוסטים ביום, בשעות היום, לא בשבת — כמו שמתווך אמיתי מפרסם. כאן רואים מה כבר עלה ומה הבא בתור, ואפשר לעצור בכל רגע.</p>

    <div id="campNeedConnect" class="rules" hidden>
      לפרסום בקבוצות צריך קודם לחבר את החשבון האישי שלכם בפייסבוק.
      <a class="btn btn-gold" href="distribution.html#browserConnectCard">חיבור החשבון</a>
    </div>

    <div id="campSetup">
      <p class="muted" id="campIdentity"></p>
      <div id="campGroupChips" class="chips"></div>
      <p class="muted small" id="campUnknownWarn" hidden>בחלק מהקבוצות לא ברור אם מתווכים מורשים לפרסם — כדאי להציץ בכללים שלהן לפני שמתחילים.</p>

      <fieldset class="camp-mode">
        <legend>מתי פורלי מפרסמת?</legend>
        <label class="camp-opt"><input type="radio" name="campMode" value="per_post" checked>
          <span><strong>רק אחרי אישור שלכם, פוסט-פוסט</strong><small>לפני כל פוסט תקבלו וואטסאפ עם הטקסט והקבוצה. אישור בלחיצה אחת — בלי אישור לא מפרסמים.</small></span></label>
        <label class="camp-opt"><input type="radio" name="campMode" value="standing">
          <span><strong>לבד, עד שתעצרו</strong><small>מאשרים פעם אחת, פורלי מפרסמת בקצב שלה, ואפשר לעצור בכל רגע בלחיצה.</small></span></label>
        <p class="muted small" id="campPlan"></p>

        <div class="camp-questions">
          <label><input type="checkbox" id="campAged" checked> חשבון הפייסבוק שלי בן יותר מחצי שנה</label>
          <label><input type="checkbox" id="campManual" checked> כבר פרסמתי בקבוצות האלה בעצמי</label>
          <p class="muted small">אם אחד מאלה לא נכון, פורלי תתחיל לאט במיוחד.</p>
        </div>

        <label class="camp-consent" id="campConsentRow"><input type="checkbox" id="campConsent">
          <span>הבנתי שפייסבוק לא אוהבת פרסום אוטומטי מחשבון אישי ולפעמים מגבילה חשבונות בגלל זה. פורלי מפרסמת לאט ובזהירות כדי להקטין את הסיכון, ואני רוצה להמשיך.</span></label>
        <p class="muted small" id="campConsentDone" hidden>מפרסמים על אחריותכם · פורלי מפרסמת לאט ובזהירות</p>
        <button class="btn btn-gold" id="campStartBtn">התחלת פרסום</button>
      </fieldset>
    </div>

    <div id="campLive" hidden>
      <div class="camp-head">
        <span class="muted" id="campNext"></span>
        <span class="camp-actions"><button class="btn btn-danger" id="campStopBtn">עצירה</button></span>
      </div>
      <p class="muted small"><a href="#" id="campPauseLink">השהיה זמנית</a></p>
      <div class="camp-halt rules" id="campHalt" hidden>
        <p id="campHaltMsg"></p>
        <a class="btn btn-gold" id="campHaltBrowserBtn" href="distribution.html#browserConnectCard" hidden>חיבור החשבון מחדש</a>
        <button class="btn btn-ghost" id="campResumeBtn" hidden>להמשיך</button>
      </div>
      <p class="muted" id="campSummary"></p>
      <ol class="camp-timeline" id="campTimeline"></ol>
    </div>
    <details id="campLast" hidden><summary class="muted">הקמפיין האחרון</summary><ol class="camp-timeline" id="campLastTimeline"></ol></details>
  </section>
```

- [ ] **Step 2: Styles**

Append to `public-agent/app.css` (cream/gold tokens; `.btn-danger` and `.rules` already exist):

```css
.camp-mode { border: 1px solid rgba(23,20,15,.1); border-radius: var(--radius); padding: 12px 16px; margin: 12px 0; }
.camp-opt { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; cursor: pointer; }
.camp-opt small { display: block; color: var(--ink-soft, #6b655c); margin-top: 2px; line-height: 1.5; }
.camp-questions { margin: 10px 0; display: grid; gap: 6px; }
.camp-consent { display: flex; gap: 8px; align-items: flex-start; margin: 12px 0; line-height: 1.55; color: var(--dark); }
.camp-head { position: sticky; top: 0; background: var(--bg); display: flex; align-items: center; gap: 12px; padding: 8px 0; z-index: 2; }
.camp-actions { margin-inline-start: auto; }
.camp-timeline { list-style: none; padding: 0; margin: 0; }
.camp-timeline li { padding: 10px 0; border-bottom: 1px solid rgba(23,20,15,.07); }
.camp-timeline .l1 { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.camp-timeline .l2 { color: var(--ink-soft, #6b655c); font-size: .9rem; margin-top: 2px; }
.camp-timeline .st-posted { color: #157A3F; } .camp-timeline .st-failed { color: var(--red); } .camp-timeline .st-skipped { color: var(--ink-soft, #6b655c); }
.camp-timeline pre { white-space: pre-wrap; font: inherit; background: rgba(23,20,15,.04); padding: 8px; border-radius: 8px; margin: 6px 0 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.chips .chip { border: 1px solid rgba(23,20,15,.12); border-radius: 999px; padding: 3px 10px; font-size: .9rem; }
```

- [ ] **Step 3: Wire it**

Append inside `publish.js`'s IIFE, after the share-kit code, using its `$`, `api`, `toast` and `session`:

```js
  // ── automatic group posting ──
  let campaign = null, campTimer = null, consentGiven = false;
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString("he-IL", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
  const HALT_TEXT = {
    account_checkpoint: "פייסבוק רוצה לוודא שזה אתם — זה קורה, והחשבון שלכם בסדר. פורלי הפסיקה לפרסם מהחשבון עד שנבדוק יחד; נחזור אליכם.",
    account_login_required: "החיבור לחשבון הפייסבוק האישי שלכם פג — זה קורה מדי פעם. חברו אותו מחדש ואז לחצו \"להמשיך\".",
    account_rate_limited: "פייסבוק ביקשה להאט. לא צריך לעשות כלום — פורלי תחכה שבועיים ותמשיך לאט יותר.",
    consecutive_failures: "שני פוסטים ברצף לא עלו. בדקו שאתם עדיין חברים בקבוצות האלה, ואז לחצו \"להמשיך\".",
    infrastructure: "תקלה זמנית אצלנו — פורלי תנסה שוב בעוד חצי שעה. לא צריך לעשות כלום.",
    agent: "הפרסום מושהה. לחצו \"להמשיך\" כשתרצו.",
  };
  const groupsPicked = () => (session.groups || []).map((g) => ({ url: g.url, name: g.name || g.url, agent_policy: g.agent_policy || "unknown" }));

  function renderSetup() {
    const gs = groupsPicked();
    $("campGroupChips").innerHTML = gs.map((g) => `<span class="chip">${g.name}${g.agent_policy === "unknown" ? " · בדקו את כללי הקבוצה" : ""}</span>`).join("");
    $("campUnknownWarn").hidden = !gs.some((g) => g.agent_policy === "unknown");
    const standing = document.querySelector('input[name="campMode"]:checked').value === "standing";
    $("campPlan").textContent = standing
      ? `פורלי תפרסם פעם אחת בכל אחת מ-${gs.length} הקבוצות, בימים הקרובים, ואז תעצור לבד. ההרשאה תקפה לשבועיים.`
      : `לפני כל אחד מ-${gs.length} הפוסטים תקבלו וואטסאפ לאישור.`;
    $("campConsentRow").hidden = consentGiven; $("campConsentDone").hidden = !consentGiven;
  }
  document.querySelectorAll('input[name="campMode"]').forEach((r) => r.addEventListener("change", renderSetup));

  $("campStartBtn").addEventListener("click", async function () {
    const gs = groupsPicked();
    if (!gs.length) return toast("בחרו לפחות קבוצה אחת");
    if (!consentGiven && !$("campConsent").checked) return toast("סמנו את האישור שמעל הכפתור");
    const mode = document.querySelector('input[name="campMode"]:checked').value;
    const btn = this; btn.disabled = true; btn.textContent = "מתחילים…";
    try {
      const j = await api("/api/posting/campaigns", { method: "POST", body: JSON.stringify({
        page_id: session.page_id, group_urls: gs.map((g) => g.url), mode, days: 14, repeat: false, consent: true, include_unknown: true,
        account_aged: $("campAged").checked, posted_manually: $("campManual").checked,
      }) });
      consentGiven = true; show(j.campaign); toast("התחלנו ✓");
    } catch (e) {
      toast(e && e.code === "facebook_not_connected" ? "קודם חברו את החשבון האישי בפייסבוק" : e && e.code === "too_many_campaigns" ? "יש כבר שלושה קמפיינים פעילים — עצרו אחד קודם" : "לא הצלחנו להתחיל — נסו שוב");
    } finally { btn.disabled = false; btn.textContent = "התחלת פרסום"; }
  });

  function row(p) {
    const st = { posted: "פורסם", scheduled: "מתוכנן", pending_approval: "ממתין לאישור שלכם", posting: "מפרסמים עכשיו…", failed: "נכשל", skipped: p.error_code === "not_member" ? "אינכם חברים בקבוצה" : p.error_code === "group_blocked" ? "הקבוצה לא מאפשרת פרסום" : "דולג" }[p.status] || p.status;
    const li = document.createElement("li");
    li.innerHTML = `<div class="l1"><span>${p.group_name || p.group_url}</span><span class="st-${p.status}">${st}${p.error_code === "pending_approval" ? " (ממתין לאישור מנהל הקבוצה)" : ""}</span></div>` +
      `<div class="l2">${fmt(p.posted_at || p.scheduled_at)}${p.post_url ? ` · <a href="${p.post_url}" target="_blank" rel="noopener">לפוסט ↗</a>` : ""}</div>`;
    if (p.status === "pending_approval") {
      const b = document.createElement("button"); b.className = "btn btn-gold"; b.textContent = "אישור ופרסום";
      b.addEventListener("click", async () => { try { show((await api(`/api/posting/campaigns/${campaign.id}/posts/${p.id}/approve`, { method: "POST" })).campaign); } catch (e) { toast("לא הצלחנו לאשר — נסו שוב"); } });
      li.appendChild(b);
    }
    if (p.copy) { const d = document.createElement("details"); d.innerHTML = "<summary>מה יפורסם</summary><pre></pre>"; d.querySelector("pre").textContent = p.copy; li.appendChild(d); }
    return li;
  }

  function show(c) {
    campaign = c;
    const live = c && ["running", "paused"].includes(c.status);
    $("campSetup").hidden = !!live; $("campLive").hidden = !live;
    $("campStatusChip").textContent = c ? ({ running: "פעיל", paused: c.pause_reason === "account" ? "נעצר — נדרשת התערבות" : "מושהה", stopped: "נעצר", completed: `הושלם — ${(c.posts || []).filter((p) => p.status === "posted").length} פוסטים עלו` })[c.status] || "" : "";
    if (!live) {
      clearInterval(campTimer); campTimer = null;
      if (c && c.posts && c.posts.length) { $("campLast").hidden = false; const ol = $("campLastTimeline"); ol.innerHTML = ""; c.posts.slice().reverse().forEach((p) => ol.appendChild(row(p))); }
      renderSetup(); return;
    }
    const pending = (c.posts || []).filter((p) => p.status === "pending_approval");
    const next = pending[0] || (c.posts || []).filter((p) => p.status === "scheduled").sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];
    $("campNext").textContent = next ? `הפוסט הבא: ${fmt(next.scheduled_at)} · ${next.group_name || next.group_url}` : c.wait_reason === "day_skipped" ? "היום פורלי נחה — ממשיכים מחר." : "אין פוסט מתוכנן כרגע — נמתין לחלון הבא.";
    const halt = $("campHalt");
    const haltKey = c.status === "paused" ? (c.pause_reason === "account" ? `account_${(c.last_halt_code || "checkpoint")}` : c.pause_reason) : null;
    halt.hidden = !haltKey;
    if (haltKey) {
      $("campHaltMsg").textContent = HALT_TEXT[haltKey] || HALT_TEXT.consecutive_failures;
      $("campHaltBrowserBtn").hidden = haltKey !== "account_login_required";
      $("campResumeBtn").hidden = haltKey.startsWith("account_") && haltKey !== "account_login_required";
    }
    $("campPauseLink").parentElement.hidden = !!haltKey;
    const posted = (c.posts || []).filter((p) => p.status === "posted").length, sched = (c.posts || []).filter((p) => ["scheduled", "pending_approval"].includes(p.status)).length;
    $("campSummary").textContent = `${posted} פורסמו · ${sched} מתוכנן`;
    const ol = $("campTimeline"); ol.innerHTML = "";
    pending.forEach((p) => ol.appendChild(row(p)));
    (c.posts || []).filter((p) => p.status !== "pending_approval").slice().reverse().forEach((p) => ol.appendChild(row(p)));
    if (!campTimer) campTimer = setInterval(reload, 30000);
  }
  async function reload() { if (!campaign) return; try { show((await api(`/api/posting/campaigns/${campaign.id}`)).campaign); } catch (e) {} }
  const act = (path) => async () => { try { show((await api(`/api/posting/campaigns/${campaign.id}/${path}`, { method: "POST" })).campaign); } catch (e) { toast("לא הצלחנו — נסו שוב"); } };
  $("campStopBtn").addEventListener("click", () => { if (confirm("לעצור את הפרסום? מה שכבר עלה נשאר בקבוצות. אפשר להתחיל שוב מתי שתרצו.")) act("stop")().then(() => toast("הפרסום נעצר. מה שכבר פורסם נשאר.")); });
  $("campPauseLink").addEventListener("click", (e) => { e.preventDefault(); act(campaign.status === "paused" ? "resume" : "pause")(); });
  $("campResumeBtn").addEventListener("click", act("resume"));

  // Boot: is the personal account connected, is there a campaign for this page?
  (async () => {
    try {
      const st = await api("/api/connections/browser/facebook/status");
      const on = st.state === "connected";
      $("campNeedConnect").hidden = on; $("campSetup").hidden = !on;
      $("campIdentity").textContent = on && st.identity_label ? `מפרסמים בתור ${st.identity_label}` : "";
      const j = await api(`/api/posting/campaigns?page_id=${encodeURIComponent(session.page_id)}`);
      consentGiven = (j.campaigns || []).length > 0;
      const live = (j.campaigns || []).find((c) => ["running", "paused"].includes(c.status)) || (j.campaigns || []).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
      show(live || null);
    } catch (e) { renderSetup(); }
    $("campaignCard").hidden = false;
  })();
```

`publicView` in Task 16 must include `last_halt_code` (set it in `haltAccount` on the campaign patch) and `wait_reason` — add both to `PUBLIC_FIELDS`. `api()` in `publish.js` must attach `e.code` from the JSON body on non-2xx, as in Task 11.

- [ ] **Step 4: Walk it by hand, as a first-time agent on a phone**

```bash
cd server && DRIVER_API_KEY=… npm run local   # export the key once beforehand; never inline it
```

Open `publish.html` for a test property. Without being told anything, each of these must read at a glance, with the next action on screen:

1. Not connected → the card says so with a button that goes to the connect card.
2. Connected → "מפרסמים בתור <name>", the group chips, the default "רק אחרי אישור שלכם" and its one-line plan.
3. Start without consent → toast names the checkbox. Tick → start → the live view: chip "פעיל", "הפוסט הבא: …", red "עצירה".
4. A `pending_approval` row is first, with "אישור ופרסום"; the WhatsApp message arrived with three links; tapping approve shows the "✅ אושר!" card and the row flips to "מתוכנן".
5. STOP → confirm → the timeline stays under "הקמפיין האחרון".
6. Simulate `pause_reason:"account", last_halt_code:"checkpoint"` on the doc: the amber box explains it is Facebook, the account is fine, and that Forly will be in touch — no resume button.
7. Simulate `account_login_required`: the box offers "חיבור החשבון מחדש".
8. On a 375px viewport: the head with STOP stays sticky; rows are two lines.

- [ ] **Step 5: Commit**

```bash
git add public-agent/publish.html public-agent/publish.js public-agent/app.css
git commit -m "feat(posting): campaign card on the property's publish page"
```

---

### Task 20: Calibration — selectors, one live post, then thirty days

Everything in Phase 3 up to here is unit-tested against fakes. This task is where the plan's [Unverified] claims become measurements — and it is honest about what a short test can and cannot prove. **48 hours on a throwaway account in groups the tester owns proves the selectors work and nothing else**: it exercises no group admin, no member reports, no admin-approval queue, no domain reputation, no account age. The evidence that matters takes an aged account, real groups, and a month.

**Use only the test account and groups from Human gate G5.** Never an agent's real account for this.

**Files:**
- Create: `scripts/posting-calibrate.local.js`
- Modify: `docs/superpowers/plans/2026-09-22-driver-spike-findings.md`

- [ ] **Step 1: Write the calibration script**

Create `scripts/posting-calibrate.local.js`:

```js
/*
 * scripts/posting-calibrate.local.js — the first real posts, watched closely.
 *
 *   export DRIVER_API_KEY=…   (once, from the secret store — never inline)
 *   node scripts/posting-calibrate.local.js <profile-name> <group-url> [--live]
 *
 * Without --live: a DRY RUN — feed, scroll, group, composer, types the copy,
 * stops before submit. Confirms SELECTORS in posting-driver.js match the real
 * page. Run until it passes three times in a row.
 * With --live: ONE real post plus the link comment, then verifies the feed.
 */
const { postToGroup, SELECTORS } = require("../server/posting-driver");
const { buildPostCopy, trackedUrl } = require("../server/distribution/share-kit");

const [profileName, groupUrl] = process.argv.slice(2);
const live = process.argv.includes("--live");

(async () => {
  if (!profileName || !groupUrl) { console.error("usage: <profile-name> <group-url> [--live]"); process.exit(2); }
  const page = { property: { title: "בדיקת מערכת — נא להתעלם", city: "תל אביב", rooms: 3, price: 1 }, agent: { name: "בדיקה" } };
  const url = trackedUrl("https://forly.example/p/test", { session: "calib", group: "abcdef123456" });
  const copy = buildPostCopy(page, url, { variantSeed: "calib" + groupUrl, linkInComment: true });
  console.log(`mode=${live ? "LIVE" : "dry run"} selectors=${Object.keys(SELECTORS).join(",")}\ncopy:\n${copy}\ncomment: ${url}\n`);
  const t0 = Date.now();
  try {
    const out = await postToGroup({ groupUrl, copy, comment: url, profileName, dryRun: !live, campaignId: "calib", phone: "calib" });
    console.log(`OK in ${((Date.now() - t0) / 1000).toFixed(0)}s:`, out);
    process.exit(0);
  } catch (e) {
    console.error(`FAIL ${e.code || e.status || ""}: ${e.message}`);
    process.exit(1);
  }
})();
```

- [ ] **Step 2: Dry run until the selectors are right**

```bash
node scripts/posting-calibrate.local.js "<profile from profile-name.profileName('facebook', <test-phone>)>" "https://www.facebook.com/groups/<test-group>"
```

Expected: `OK … dry_run: true`, taking 60–150 s (the dwell is deliberate). On `composer_not_found`, open the same group in the embedded browser (Task 11), inspect, and fix `SELECTORS` in `server/posting-driver.js` — the only file to touch. Three clean passes in a row before Step 3.

- [ ] **Step 3: One live post**

Same command with `--live`. Expected: `OK … dry_run: false`, the post is visible in the group in a normal browser **with the link as the first comment**, and `post_url` is the post's permalink, not the group URL. If it reports `not_verified` while the post *is* there, fix `SELECTORS.feedPost*` — a false negative makes the campaign count a success as a failure.

- [ ] **Step 4: Thirty days**

From the dashboard, on the aged test account (G5), start one `standing` campaign per test property (two properties, the same 2–3 real groups, admins' written permission on file), `repeat: true`, 30 days. Then, **daily**:

```bash
cd server && node -e '
const db = require("./db"); db.init();
const S = require("./posting-safety");
(async () => {
  const phone = process.argv[1];
  const conn = await db.getConnection(phone);
  const ledger = (conn.posting_ledger || []).map(p => new Date(p.at)).sort((a,b)=>a-b);
  let ok = true;
  for (let i = 1; i < ledger.length; i++) { const gap = (ledger[i]-ledger[i-1])/60000; if (gap < S.DEFAULTS.min_gap_minutes) { console.error("GAP VIOLATION", gap.toFixed(0), "min"); ok = false; } }
  for (const d of ledger) if (!S.isActiveTime(d, S.DEFAULTS)) { console.error("OUTSIDE ACTIVE HOURS", d.toISOString()); ok = false; }
  const byDay = {}; for (const d of ledger) { const k = d.toISOString().slice(0,10); byDay[k] = (byDay[k]||0)+1; }
  console.log(`posts=${ledger.length} days=${Object.keys(byDay).length} max/day=${Math.max(0,...Object.values(byDay))} halts=${JSON.stringify(conn.posting_halts||[])} disabled=${!!conn.posting_disabled_until_admin} penalty=${conn.posting_penalty_until||"-"}`);
  process.exit(ok ? 0 : 1);
})();' "<test-phone>"
```

and, in a normal browser logged into the test account, open `https://www.facebook.com/accountquality` and note anything there. Record a line per day in the findings file:

```
| day | posts | max/day | gaps ok | halts | accountquality | admin removed | notes |
```

- [ ] **Step 5: Decide, and only ever downward**

At day 30, with the table in front of you: if there was **no** halt, no `accountquality` entry, and no admin removal, the DEFAULTS stand. If there was **any** of those, lower `daily_cap`/`weekly_cap` and raise `min_gap_minutes` before any real agent is offered Phase 3 — and note that a sample of one account proves little either way; the fleet breaker (Task 18) is what actually protects customers.

Append to `docs/superpowers/plans/2026-09-22-driver-spike-findings.md`:

```
## Posting calibration (<dates>)

- selectors changed from the plan's defaults: <yes: which | no>
- dry runs to a clean pass: <n>
- live post verified in feed with link comment: <yes|no>; time to post: <s>
- EGRESS_ASN / POSTING_BROWSER_TYPE used: <…>
- 30-day table: (above)
- DEFAULTS kept as-is / lowered to: <values>
- go / no-go for real agents: <…, signed by …>
```

- [ ] **Step 6: Commit and push**

```bash
cd server && npm test
cd .. && git add scripts/posting-calibrate.local.js docs/superpowers/plans/2026-09-22-driver-spike-findings.md server/posting-driver.js
git commit -m "test(posting): calibration script and the thirty-day observation record"
git push -u origin claude/zen-davinci-lu4hoq
```

---

## Done means

- `cd server && npm test` passes, with all six new test files in the chain.
- A real Yad2 URL and a real Madlan URL both fill the wizard through the queued path, verified by eye against the live page (Task 9).
- No Driver session is left `active` after a run (`GET /v1/browser/sessions?status=active` shows none with a `forly-extract:` note).
- A non-allowlisted URL still goes to Firecrawl, and only falls back to a browser when Firecrawl errors (Task 6 tests).
- The embedded browser opens in the dashboard, and `finish` refuses to mark an account connected when nobody logged in (Task 11).
- `PROFILE_COOKIES_PERSIST` has a recorded answer (Task 12).
- Thirty days of the calibration table (Task 20) with no gap or active-hours violation, and a signed go / no-go.
- Pressing STOP cancels the next post before it starts (Task 14 test, Task 19 by hand); the WhatsApp stop link does the same without a login (Task 16 test).
- Per-post approval works from the WhatsApp link, and an approval at 23:40 posts the next morning, not at 23:41 (Task 14 test).
- A simulated checkpoint disables the account, pauses every campaign on it, and the card says so without offering resume; only an operator can re-enable (Tasks 14, 18, 19).
- Flipping the kill switch stops every campaign before its next slot; three halted accounts in 24h flip it automatically and message the operator (Task 14 test).
- Consent is recorded with a version on both the connection and the campaign, and `DELETE /api/connections/browser/facebook` stops campaigns and deletes the profile (Tasks 10, 16).
- No response from any new route ever contains `wss://` or `viewer.driver.dev`, and no log line does either (Tasks 2, 10, 16 tests).
- A first-time agent on a phone walks Task 19 step 4 and Task 11 step 5 without being told anything; each state's next action is on screen.

## Deferred, on purpose

- **Publish-out to Yad2 / Madlan.** Phase 3 posts to Facebook groups only. Yad2 and Madlan are structured listing forms with their own accounts, photo uploads and paid tiers — a separate spec each.
- **Account-wide bulk sweep** (walking an agent's whole Yad2 office page or Madlan profile) — needs pagination, dedup and a different job shape.
- **Per-customer landing hostnames.** Every post's comment links one Forly domain, so domain reputation is shared across customers (safety review A3). Right, and an infrastructure project of its own (`PAGE_BASE_URL` per business, certificates, OG). What ships instead: the link in a comment, an opaque group token, and — to add in Task 14 before real agents — a global per-group daily cap across accounts (`group_activity/{slug}.posts_today`, cap 3) so ten Forly agents cannot hit one group in one day.
- **Browser pools.** They would cut the ~20s session start, but they hold warm browsers against an account-wide cap, and the docs say not to create one unasked. Revisit only if start latency becomes the complaint.
- **`captchaSolver`.** Off by default; it costs credits. Turn it on per-host, with evidence, after the `hosted_privacy` rung has been seen to fail.
