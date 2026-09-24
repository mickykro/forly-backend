# Driver-Backed Listing Import & Group Posting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent paste a Yad2, Madlan, or social-media listing URL and have Forly fill the create-wizard fields from it, using a hosted real-Chrome session (driver.dev) where Firecrawl cannot reach; connect their own social accounts through a browser embedded in the Forly dashboard; and then post each property to their chosen Facebook groups on a paced schedule — from a background browser they never see — under either per-post approval or a standing permission they can revoke with one tap.

**Architecture:** Import (Phase 1–2) adds three server modules: `driver-browser.js` (Driver API client, always stops in a `finally`), `listing-driver.js` (page → the exact result shape `listing-sources.js` already produces for Firecrawl, so `listing-extract.js` is untouched), and `extract-jobs.js` (queued-job state machine + sweeper, mirroring `distribution/jobs.js`). Posting (Phase 3) adds four more: `posting-safety.js` (pure pacing + signal classification — the anti-ban core, and the most-tested file in the plan), `posting-campaign.js` (campaign state machine + sweeper, one serial browser per agent), `posting-driver.js` (the browser actions, with a dry-run mode that stops before submit), and `routes/posting.js`. Copy variation and tracked URLs are reused from `distribution/share-kit.js`, group selection from `property_groups`, and the catalog's `agent_policy` field becomes a hard gate.

**A decision this plan reverses, on purpose:** `distribution/share-kit.js` records that browser automation to groups "was rejected as a ban risk (spec §1)" in favour of a WhatsApp share kit. The product owner has asked for automated posting anyway. Phase 3 therefore treats "the agent's account must never get blocked or look suspicious" as a first-class requirement with its own module, its own tests, a calibration task, and a kill switch — not a caveat.

**Tech Stack:** Node >= 20 CommonJS, Express 4, Firebase Admin (Firestore), `patchright` (Playwright-compatible, connect-only), vanilla browser JS in `public-agent/`, plain `node x.test.js` assertion scripts.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node >= 20** (`.nvmrc` is `22`). `server/` is CommonJS — `require`, `module.exports`, no TypeScript.
- **`patchright` only.** Never `playwright` or `puppeteer`. Never `chromium.launch()`, `launchPersistentContext()`, or `playwright install`. The only browser entry point is `chromium.connectOverCDP(cdpUrl)`.
- **Reuse the browser's first context and tab:** `browser.contexts()[0] ?? await browser.newContext()`, `context.pages()[0] ?? await context.newPage()`. Extra contexts look like automation.
- **No broad CDP hooks:** no `page.route`, `context.route`, `page.on('request')`, `page.exposeFunction`, `page.addInitScript`, `context.addInitScript`. No fingerprint patching (`navigator`, user agent, WebGL, canvas, timezone, locale) — set `country` / `timezone` / `language` on the create call instead.
- **Always stop the session** with `DELETE /v1/browser/session?sessionId=<id>` in a `finally`. `browser.close()` only disconnects; the session keeps running and holds a concurrency slot until `duration` expires.
- **Driver error policy, exactly:** `402` and `403` → report, never loop. `503` → back off from `Retry-After` with jitter, capped at 5 attempts, then report. `504` and `500` → retry once. `429` → back off, capped at 3 attempts.
- **`DRIVER_API_KEY` comes from `process.env`** and is never committed, never logged, never returned in an API response.
- **Never log a `cdpUrl` or a live-view URL.** Anyone holding one can drive that browser. They go only to the authenticated owner of the session.
- **Base URL** is `https://api.driver.dev`. Ids go in the query string, not the path: `GET|DELETE /v1/browser/session?sessionId=<id>`. Pool ids are the exception (path), and **no pool is created by this plan.**
- **Tests** are plain assertion scripts run as `node <file>.test.js`, using `require("assert")` and injected fakes — no test framework, no network in unit tests. Every new test file must be appended to the `scripts.test` chain in `server/package.json`.
- **Keep files under 500 lines** (CLAUDE.md). Split before exceeding.
- **Commit messages carry no `Co-Authored-By` trailer** — `.claude/settings.json` has no `attribution.commit` key, and CLAUDE.md forbids it in that case.
- **Branch:** all work lands on `claude/zen-davinci-lu4hoq`.
- **Posting is background-only.** A posting session never surfaces a `view_url`; the agent sees a timeline, not a browser. The embedded browser (Task 11) is the escape hatch when Facebook demands a human (checkpoint, identity check), and only then.
- **One browser per agent at a time.** Posting jobs for the same phone run serially. Never two Facebook sessions on one profile concurrently.
- **Every pacing number is a tunable, conservative default marked [Unverified].** None was measured against Facebook; Task 18 measures. A number is never hard-coded in a call site — it comes from `posting-safety.DEFAULTS` and can be overridden per account.
- **Never post to a group whose catalog `agent_policy` is `"forbidden"`.** `"unknown"` posts only when the agent explicitly ticked that group. This is a gate in code, not a UI hint.
- **Any platform signal halts the whole account, not just the post.** Checkpoint, CAPTCHA, "posting too fast", post removed, group blocked → campaign `halted`, no further posts for that phone until the agent re-confirms after a cooldown.
- **Never identical copy twice.** Every post goes through `share-kit.buildPostCopy` with a `variantSeed` of `page_id + group_url`; the tracked URL differs per group.
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
| `server/posting-safety.js` | Pure functions: `nextSlot()` (may this account post now, and where), `classifySignal()` (is this page a checkpoint / rate-limit / block), `DEFAULTS`. No I/O. |
| `server/posting-safety.test.js` | Pacing invariants, warm-up ramp, cooldowns, active hours incl. Shabbat, signal classification. |
| `server/posting-campaign.js` | Campaign state machine + sweeper. `draft → awaiting_approval → running → paused \| halted \| stopped \| completed`. Per-post `posts[]` ledger. Serial per phone. |
| `server/posting-campaign.test.js` | Transitions, approval modes, standing-permission expiry, breaker, serial guarantee, idempotent post ids. |
| `server/posting-driver.js` | Browser actions: open group, compose, paste, submit, verify the post landed. `dryRun` stops before submit. |
| `server/posting-driver.test.js` | Fake page: happy path, dry run never submits, verification failure is a failure, signals bubble up as codes. |
| `server/routes/posting.js` | Create campaign, approve / grant standing / revoke, pause, stop, timeline. |
| `server/routes/posting.test.js` | Ownership, `agent_policy` gate, standing permission bounds, revoke is immediate. |
| `scripts/posting-calibrate.local.js` | Dry run, then ONE real post to a test group the test account owns; records what actually happened. |

**Server — modified**

| File | Change |
|---|---|
| `server/listing-sources.js` | `sourceFor()` gains the `driver` branch; `listingImages` / `IMAGE_EXT` / `NOT_LISTING` exported for reuse; `resolve()` routes `driver`. |
| `server/listing-sources.test.js` | Routing assertions for the new hosts. |
| `server/db.js` | `saveExtractJob` / `getExtractJob` / `updateExtractJob` / `listQueuedExtractJobs`, and browser-connection fields on the existing connection doc. |
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
| `public-agent/distribution.html` | Embedded-browser connect modal markup. |
| `public-agent/distribution.js` | Modal wiring, status polling. |
| `public-agent/app.css` | Modal styles. |
| `public-agent/distribution.html` (Phase 3) | Campaign card: groups, mode toggle, schedule preview, timeline, STOP. |
| `public-agent/distribution.js` (Phase 3) | Campaign wiring, timeline polling, halt banner → embedded browser. |
| `public-agent/form-i18n.js` (Phase 3) | Campaign strings. |

---

## Phases

- **Tasks 1–9 — Phase 1.** Driver scraping for Yad2/Madlan + Firecrawl fallback. Ships and is useful on its own.
- **Tasks 10–12 — Phase 2.** Embedded browser connect + social/Facebook-group scraping. Depends on Task 2.
- **Tasks 13–18 — Phase 3.** Paced background posting to groups under agent approval. Depends on Tasks 2, 10, 11 (a connected profile) and on Task 12's answer: if `PROFILE_COOKIES_PERSIST=no`, Phase 3 cannot start.

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
SID=$(curl -sS -X POST https://api.driver.dev/v1/browser/session \
  -H "Authorization: Bearer $DRIVER_API_KEY" -H "Content-Type: application/json" \
  -d '{"country":"IL","duration":120,"note":"forly-spike"}' | tee /tmp/sess.json | \
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).sessionId)')
echo "sessionId=$SID"
curl -sSI "https://viewer.driver.dev/" | grep -iE "x-frame-options|content-security-policy"
curl -sS -X DELETE "https://api.driver.dev/v1/browser/session?sessionId=$SID" \
  -H "Authorization: Bearer $DRIVER_API_KEY"
curl -sS "https://api.driver.dev/v1/browser/session?sessionId=$SID" \
  -H "Authorization: Bearer $DRIVER_API_KEY"
```

Expected: the final GET shows `"status":"completed"` with a `stoppedAt`.

- [ ] **Step 4: Decide embeddability and write the findings file**

Decision rule, applied to the headers from Step 3:
- No `X-Frame-Options` **and** either no `frame-ancestors` or one that permits the Forly origin → `VIEWER_EMBEDDABLE=yes`.
- `X-Frame-Options: DENY`/`SAMEORIGIN`, or a `frame-ancestors` that excludes the Forly origin → `VIEWER_EMBEDDABLE=no`.

If the answer is `no`, do **not** attempt to proxy or strip the header — that defeats a deliberate security control and breaks the viewer's websocket. Task 11 Branch B (popup window) is the supported path.

```bash
cat > docs/superpowers/plans/2026-09-22-driver-spike-findings.md <<'EOF'
# Driver spike findings (2026-09-22)

VIEWER_EMBEDDABLE=<yes|no>

- plan.concurrent_browsers: <n>
- viewer response headers: <paste the grep output>
- patchright install downloaded a browser: <yes|no>
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
assert.equal(sourceFor({ url: "https://fb.watch/abc" }), "facebook");
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

`forceSource` is how the Firecrawl→Driver fallback in Task 6 re-runs the same input through the browser. `listing-driver` is required lazily inside the function because it requires `listing-sources` back for the image filters — a top-level require would be a cycle.

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

  // ── 402/403 are terminal too: a person has to act ──
  const store4 = fakeStore();
  const job4 = await J.create({ phone: "p", url: "https://www.yad2.co.il/item/b" }, { db: store4 });
  const brokeDeps = {
    db: store4,
    resolve: async () => { const e = new Error("no credits"); e.status = 402; throw e; },
    parseListing: async () => ({ fields: {}, missing: [] }),
  };
  const j4 = await J.runJob(job4, brokeDeps);
  assert.equal(j4.status, "failed");
  assert.equal(j4.error_code, "extract_unavailable");
  assert.equal(j4.attempts, 1);

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
function codeFor(err) {
  if (err.code && err.code !== "unknown") return err.code;
  if (err.status === 402 || err.status === 403) return "extract_unavailable";
  if (err.status === 503) return "extract_unavailable";
  return "page_unreadable";
}

async function runJob(job, deps) {
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
 * One pass: start as many queued jobs as the concurrency budget allows.
 * The running count is read, not held — two instances can briefly overshoot by
 * one. Driver answers the overshoot with 403, which fails that job cleanly, so
 * a distributed lock would cost more than it saves.
 */
async function sweep(deps) {
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

module.exports = { create, runJob, sweep, startSweeper, liveDeps, MAX_ATTEMPTS, SWEEP_MS, BROWSER_LADDER };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && node extract-jobs.test.js`
Expected: PASS, printing `extract-jobs.test.js ok`

- [ ] **Step 6: Add to the test chain and commit**

Append ` && node extract-jobs.test.js` to `scripts.test` in `server/package.json`.

```bash
cd server && npm test
git add server/db.js server/extract-jobs.js server/extract-jobs.test.js server/package.json
git commit -m "feat(extract): queue browser scrapes as jobs with a sweeper"
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

Append to `server/routes/extract.test.js` (keep the existing cases; this block uses whatever app/request helper that file already defines — reuse it rather than adding a second one):

```js
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

// ── firecrawl failing falls back to a driver job, not an error ──
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

Give the router a second `DailyLimit` instance (`const driverLimit = new DailyLimit(DRIVER_DAILY_CAP);`) alongside the existing one. `phone` below is the same per-request identity the handler already uses for the existing cap (`req.user.userId`, or the demo key when there is no session) — reuse that binding, do not introduce a second one, and inject `extractJobs` / `sourceFor` through `ctx` with live defaults:

```js
const extractJobs = ctx.extractJobs || require("../extract-jobs");
const jobDeps = ctx.jobDeps || require("../extract-jobs").liveDeps();
const { sourceFor } = require("../listing-sources")._test;
```

Replace the body of the POST handler's resolve step with:

```js
// Driver-routed hosts never try firecrawl: we already know it cannot read them.
const kind = input.text ? "text" : sourceFor(input);

async function queueDriverJob(forceSource) {
  if (!driverLimit.take(phone)) { const e = new Error("extract_limit"); e.code = "extract_limit"; throw e; }
  const job = await extractJobs.create(
    { phone, url: input.url, forceSource, profileName: profileFor(input.url, phone) },
    jobDeps,
  );
  return { job_id: job.id, status: job.status };
}

if (kind === "driver") return res.status(202).json(await queueDriverJob(null));

let source;
try {
  source = await resolve(Object.assign({}, input, { userId: phone }), deps);
} catch (err) {
  // "or if firecrawl returns an error" — a browser is the next thing to try,
  // but only for a scrape that failed, and only when the input itself was fine.
  if (kind === "scrape" && err.code !== "invalid_input") {
    return res.status(202).json(await queueDriverJob("driver"));
  }
  throw err;
}
```

Add the profile helper next to `importImage`:

```js
// One persisted browser profile per agent per platform. The agent logs in once
// through the embedded browser; the cookies live in the profile, never here.
function profileFor(url, phone) {
  let host;
  try { host = new URL(url).hostname; } catch (e) { return null; }
  const m = host.match(/(facebook\.com|instagram\.com|tiktok\.com|linkedin\.com|x\.com|twitter\.com)$/i);
  if (!m) return null;
  const name = m[1].split(".")[0].toLowerCase();
  // twitter.com and x.com are one account, and connections-browser.js keys it
  // as "x" — two spellings here would mean two profiles and a login that never
  // seems to stick.
  const platform = name === "twitter" ? "x" : name;
  return `${platform}-${phone}`;
}
```

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
    var deadline = Date.now() + (o.timeoutMs == null ? 120000 : o.timeoutMs);
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
"ext_working_browser":"פותחים דפדפן וקוראים את המודעה… זה עשוי לקחת עד דקה",
"ext_err_social_login":"כדי לקרוא את הפוסט צריך שהחשבון שלכם יהיה מחובר — אפשר לחבר אותו בעמוד ההפצה",
```

- [ ] **Step 5: Handle 202 in the wizard**

In `public-agent/create.html`, inside `runExtract`, replace the `.then(function (res) {` body's opening so a 202 goes through the poll and everything else stays exactly as it is:

```js
    }).then(function (res) {
      if (res.status === 202 && res.body.job_id) {
        btn.textContent = FT("ext_working_browser");
        return X.pollJob(res.body.job_id, { headers: uploadHeaders }).then(function (j) {
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
  - `POST /api/connections/browser/start` body `{platform}` → `200 {platform, session_id, view_url, expires_in}`
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
  const started = await call(app, "POST", "/api/connections/browser/start", { platform: "facebook" });
  assert.equal(started.status, 200);
  assert.equal(started.body.session_id, "s1");
  assert.equal(started.body.view_url, "https://viewer.driver.dev?ws=wss://node/abc");
  assert.deepEqual(created.profile, { name: `facebook-${PHONE}`, persist: true });
  assert.equal(created.url, "https://www.facebook.com/login");
  assert.ok(created.duration <= 900, "a forgotten login browser must not live an hour");
  assert.ok(String(created.note).startsWith("forly-connect:"));

  // ── an unknown platform is rejected before any session is created ──
  let touched = false;
  const badApp = makeApp({
    driver: { createSession: async () => { touched = true; return {}; } },
    db: { getConnection: async () => ({}), setConnection: async () => {} },
  });
  const bad = await call(badApp, "POST", "/api/connections/browser/start", { platform: "myspace" });
  assert.equal(bad.status, 400);
  assert.equal(touched, false);

  // ── status reflects the stored connection, and never leaks a cdpUrl ──
  const st = await call(app, "GET", "/api/connections/browser/facebook/status");
  assert.equal(st.status, 200);
  assert.equal(st.body.state, "open");
  assert.ok(!JSON.stringify(st.body).includes("wss://"), "no cdpUrl in a status response");

  // ── finish: logged in → connected, and the session is stopped ──
  const stopped = [];
  const conn2 = { browser_sessions: { facebook: { session_id: "s2", started_at: new Date().toISOString() } } };
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

  // ── finish while still on a login wall → 409, and the session still stops ──
  const stopped2 = [];
  const conn3 = { browser_sessions: { facebook: { session_id: "s3" } } };
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
  assert.deepEqual(stopped2, ["s3"], "a failed check must not leak the session either");
  assert.ok(!conn3.facebook_browser_connected_at);

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

const SESSION_SECONDS = 900;

const PLATFORMS = {
  facebook: { loginUrl: "https://www.facebook.com/login", checkUrl: "https://www.facebook.com/me" },
  instagram: { loginUrl: "https://www.instagram.com/accounts/login/", checkUrl: "https://www.instagram.com/accounts/edit/" },
  tiktok: { loginUrl: "https://www.tiktok.com/login", checkUrl: "https://www.tiktok.com/setting" },
  linkedin: { loginUrl: "https://www.linkedin.com/login", checkUrl: "https://www.linkedin.com/feed/" },
  x: { loginUrl: "https://x.com/login", checkUrl: "https://x.com/home" },
};

module.exports = function createConnectionsBrowserRouter(ctx) {
  const { requireAuth, authSecret } = ctx;
  const driver = ctx.driver || driverLive;
  const db = ctx.db || dbLive;
  const router = express.Router();

  const viewUrl = (cdpUrl) => `https://viewer.driver.dev?ws=${cdpUrl}`;

  router.post("/start", requireAuth(authSecret), async (req, res) => {
    const platform = String((req.body && req.body.platform) || "");
    const spec = PLATFORMS[platform];
    if (!spec) return res.status(400).json({ error: "invalid_input" });
    const phone = req.user.userId;

    let session;
    try {
      session = await driver.createSession({
        country: "IL",
        duration: SESSION_SECONDS,
        url: spec.loginUrl,
        profile: { name: `${platform}-${phone}`, persist: true },
        note: `forly-connect:${platform}:${phone}`,
      });
    } catch (e) {
      const status = e.status === 402 || e.status === 403 ? 503 : 503;
      return res.status(status).json({ error: "extract_unavailable" });
    }

    const conn = (await db.getConnection(phone)) || {};
    const sessions = Object.assign({}, conn.browser_sessions);
    sessions[platform] = { session_id: session.sessionId, started_at: new Date().toISOString() };
    await db.setConnection(phone, { browser_sessions: sessions });

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
    const open = conn.browser_sessions && conn.browser_sessions[platform];
    return res.json({ state: open ? "open" : "none" });
  });

  router.post("/:platform/finish", requireAuth(authSecret), async (req, res) => {
    const platform = String(req.params.platform);
    const spec = PLATFORMS[platform];
    if (!spec) return res.status(400).json({ error: "invalid_input" });
    const phone = req.user.userId;
    const conn = (await db.getConnection(phone)) || {};
    const open = conn.browser_sessions && conn.browser_sessions[platform];
    if (!open || !open.session_id) return res.status(409).json({ error: "no_open_session" });

    let loggedIn = false;
    try {
      loggedIn = await driver.attachPage(open.session_id, async (page) => {
        await page.goto(spec.checkUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        return !isLoginWall(page.url(), await page.innerText("body"));
      });
    } catch (e) {
      loggedIn = false;
    } finally {
      // Whether the check passed or not, the browser stops here: the profile
      // already holds whatever cookies the login produced.
      await driver.stopSession(open.session_id);
      const sessions = Object.assign({}, conn.browser_sessions);
      delete sessions[platform];
      await db.setConnection(phone, { browser_sessions: sessions });
    }

    if (!loggedIn) return res.status(409).json({ error: "not_logged_in" });
    await db.setConnection(phone, { [`${platform}_browser_connected_at`]: new Date().toISOString() });
    return res.json({ state: "connected" });
  });

  return router;
};

module.exports.PLATFORMS = PLATFORMS;
```

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

- [ ] **Step 1: Add the Hebrew strings**

In `public-agent/form-i18n.js`, add to the `"he"` map (and translate into every other map the file defines):

```
"conn_browser_title":"חיבור חשבונות לקריאת מודעות",
"conn_browser_hint":"כדי לקרוא פוסטים מקבוצות פייסבוק ומרשתות חברתיות, צריך שהחשבון שלכם יהיה מחובר. נפתח כאן דפדפן מאובטח — מתחברים בו בעצמכם, בדיוק כמו בדפדפן רגיל.",
"conn_browser_privacy":"הסיסמה נשארת אצלכם: היא לא עוברת דרך פורלי ולא נשמרת אצלנו.",
"conn_browser_warning":"לתשומת לבכם: חיבור אוטומטי לחשבון אישי נוגד את תנאי השימוש של הפלטפורמות ועלול להוביל לחסימת החשבון. החיבור נעשה על אחריותכם בלבד.",
"conn_browser_open":"פתיחת דפדפן מאובטח",
"conn_browser_opening":"פותחים דפדפן…",
"conn_browser_done":"סיימתי להתחבר",
"conn_browser_checking":"בודקים…",
"conn_browser_connected":"החשבון מחובר ✓",
"conn_browser_not_logged_in":"נראה שעדיין לא התחברתם — השלימו את ההתחברות בדפדפן ונסו שוב",
"conn_browser_failed":"לא הצלחנו לפתוח דפדפן כרגע — נסו שוב בעוד רגע",
"conn_browser_popup_blocked":"הדפדפן חסם את החלון — אשרו חלונות קופצים לאתר ונסו שוב",
"conn_browser_expired":"החלון נסגר. פתחו דפדפן מחדש כדי להתחבר",
```

- [ ] **Step 2: Add the card markup**

In `public-agent/distribution.html`, immediately after the existing `connectCard` div (line 84):

```html
  <div class="card dist-card" id="browserConnectCard" hidden>
    <h2 data-i18n="conn_browser_title">חיבור חשבונות לקריאת מודעות</h2>
    <p class="muted" data-i18n="conn_browser_hint"></p>
    <p class="muted" data-i18n="conn_browser_privacy"></p>
    <p class="warn" data-i18n="conn_browser_warning"></p>
    <div class="conn-row">
      <select id="browserPlatform" aria-label="פלטפורמה">
        <option value="facebook">פייסבוק</option>
        <option value="instagram">אינסטגרם</option>
        <option value="tiktok">טיקטוק</option>
        <option value="linkedin">לינקדאין</option>
        <option value="x">X</option>
      </select>
      <button class="btn btn-gold" id="browserConnectBtn" data-i18n="conn_browser_open"></button>
      <span class="conn-chip" id="browserConnChip"></span>
    </div>
  </div>

  <div class="browser-modal" id="browserModal" hidden role="dialog" aria-modal="true" aria-labelledby="browserModalTitle">
    <div class="browser-modal-inner">
      <header>
        <strong id="browserModalTitle" data-i18n="conn_browser_title"></strong>
        <button class="btn btn-ghost" id="browserModalClose" aria-label="סגירה">✕</button>
      </header>
      <div class="browser-modal-body" id="browserModalBody"></div>
      <footer>
        <span class="muted" id="browserModalMsg"></span>
        <button class="btn btn-gold" id="browserDoneBtn" data-i18n="conn_browser_done"></button>
      </footer>
    </div>
  </div>
```

- [ ] **Step 3: Add the styles**

Append to `public-agent/app.css`:

```css
/* Embedded connect browser — a full-bleed dialog, because a real page inside a
   small box is unusable on a phone. */
.browser-modal { position: fixed; inset: 0; background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center; z-index: 90; }
.browser-modal[hidden] { display: none; }
.browser-modal-inner { background: var(--card, #14161c); border-radius: 14px; width: min(1100px, 96vw); height: min(760px, 92vh); display: flex; flex-direction: column; overflow: hidden; }
.browser-modal-inner > header,
.browser-modal-inner > footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; }
.browser-modal-body { flex: 1; min-height: 0; background: #fff; }
.browser-modal-body iframe { width: 100%; height: 100%; border: 0; display: block; }
.browser-modal-body .popup-note { padding: 32px; text-align: center; color: var(--muted, #9aa0a6); line-height: 1.7; }
.conn-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.warn { color: #e0b341; }
@media (max-width: 640px) { .browser-modal-inner { width: 100vw; height: 100vh; border-radius: 0; } }
```

- [ ] **Step 4 (Branch A — `VIEWER_EMBEDDABLE=yes`): iframe the viewer**

Append to `public-agent/distribution.js`:

```js
// ── embedded connect browser ──
// The viewer is a live view of a real Chrome running in Driver's cloud: the
// agent types their own password into it, and it never touches our server.
(function () {
  var modal = $("browserModal"), body = $("browserModalBody"), msg = $("browserModalMsg");
  var current = null;

  function say(key) { msg.textContent = key ? FT(key) : ""; }

  function openModal(viewUrl) {
    body.innerHTML = "";
    var frame = document.createElement("iframe");
    // No allow-same-origin: the viewer is a foreign origin and has no business
    // reaching this page's storage.
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.src = viewUrl;
    body.appendChild(frame);
    modal.hidden = false;
  }

  function closeModal() { modal.hidden = true; body.innerHTML = ""; current = null; say(""); }

  $("browserConnectBtn").addEventListener("click", function () {
    var platform = $("browserPlatform").value;
    var btn = this;
    btn.disabled = true; btn.textContent = FT("conn_browser_opening");
    fetch("/api/connections/browser/start", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: platform }),
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (j) { current = platform; openModal(j.view_url); })
      .catch(function () { FLY.toast(FT("conn_browser_failed")); })
      .then(function () { btn.disabled = false; btn.textContent = FT("conn_browser_open"); });
  });

  $("browserDoneBtn").addEventListener("click", function () {
    if (!current) return closeModal();
    var btn = this;
    btn.disabled = true; say("conn_browser_checking");
    fetch("/api/connections/browser/" + current + "/finish", { method: "POST", credentials: "include" })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (res.ok) { FLY.toast(FT("conn_browser_connected")); closeModal(); refreshBrowserChip(); return; }
        say(res.body.error === "no_open_session" ? "conn_browser_expired" : "conn_browser_not_logged_in");
      })
      .catch(function () { say("conn_browser_failed"); })
      .then(function () { btn.disabled = false; });
  });

  $("browserModalClose").addEventListener("click", closeModal);

  function refreshBrowserChip() {
    var platform = $("browserPlatform").value;
    fetch("/api/connections/browser/" + platform + "/status", { credentials: "include" })
      .then(function (r) { return r.json(); })
      .then(function (j) { $("browserConnChip").textContent = j.state === "connected" ? FT("conn_browser_connected") : ""; })
      .catch(function () {});
  }
  $("browserPlatform").addEventListener("change", refreshBrowserChip);
  $("browserConnectCard").hidden = false;
  refreshBrowserChip();
})();
```

- [ ] **Step 4 (Branch B — `VIEWER_EMBEDDABLE=no`): a popup window instead**

Use the exact block above with **only `openModal` replaced**, and nothing else changed:

```js
  function openModal(viewUrl) {
    // The viewer refuses to be framed (X-Frame-Options / frame-ancestors), so
    // it opens in its own window. Stripping that header server-side would mean
    // proxying their websocket and defeating a deliberate control — not worth
    // it, and it would break on their next deploy.
    var win = window.open(viewUrl, "forly-connect", "width=1200,height=820,noopener");
    body.innerHTML = '<p class="popup-note">' + FT("conn_browser_hint") + "</p>";
    modal.hidden = false;
    if (!win) { body.innerHTML = '<p class="popup-note">' + FT("conn_browser_popup_blocked") + "</p>"; }
  }
```

and in `closeModal`, nothing changes — the popup is the agent's to close.

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
git add public-agent/distribution.html public-agent/distribution.js public-agent/app.css public-agent/form-i18n.js
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

**What "safe" means here, stated once.** No number below was measured against Facebook; the platform publishes no thresholds and changes its heuristics without notice. [Unverified] The defaults are deliberately slower than a busy human agent, and the design leans on things that *are* known to matter: an account that posts at 3am, posts identical text to twelve groups in an hour, or keeps going after a warning gets flagged; one that posts a few varied messages a day during waking hours from a browser it has logged into before mostly does not. Task 18 turns the defaults into measured values. Until then, slower is the only defensible direction.

### Task 13: `posting-safety.js` — pacing and signal classification

The anti-ban core. Pure functions, no I/O, and the most thoroughly tested file in the plan: every invariant the product owner is relying on lives here as an assertion.

**Files:**
- Create: `server/posting-safety.js`
- Create: `server/posting-safety.test.js`
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DEFAULTS` — the pacing config (below).
  - `nextSlot({ now, account, candidates, pageId, config, rand }) -> { at: Date, group_url: string } | { at: null, reason: string }` where `account = { connected_at: ISO, posts: Array<{at: ISO, group_url, page_id, ok: boolean}> }` and `candidates = Array<{ url, agent_policy: "allowed"|"unknown"|"forbidden", explicit: boolean }>`.
  - `isActiveTime(date, config) -> boolean`
  - `classifySignal(landedUrl, text) -> "ok" | "login_required" | "checkpoint" | "captcha" | "rate_limited" | "group_blocked" | "not_member"`
  - `SIGNAL_HALTS = Set` — the signals that halt the whole account.

- [ ] **Step 1: Write the failing test**

Create `server/posting-safety.test.js`:

```js
/* posting-safety.js — every pacing promise, as an assertion. Pure, no I/O. */
const assert = require("assert");
const S = require("./posting-safety");

const IL = (iso) => new Date(iso); // ISO strings below carry the +03:00 offset (Asia/Jerusalem, DST)
const day = (n) => n * 24 * 3600 * 1000;
const cfg = S.DEFAULTS;
const noRand = () => 0.5; // jitter midpoint → deterministic

const allowed = (url) => ({ url, agent_policy: "allowed", explicit: true });
const account = (connectedDaysAgo, posts = []) => ({
  connected_at: new Date(Date.now() - day(connectedDaysAgo)).toISOString(), posts,
});

// ── active hours: Israeli waking hours, never Shabbat ──
assert.equal(S.isActiveTime(IL("2026-09-23T10:00:00+03:00"), cfg), true, "Wed 10:00");
assert.equal(S.isActiveTime(IL("2026-09-23T03:00:00+03:00"), cfg), false, "Wed 03:00");
assert.equal(S.isActiveTime(IL("2026-09-23T22:30:00+03:00"), cfg), false, "Wed 22:30");
assert.equal(S.isActiveTime(IL("2026-09-25T16:00:00+03:00"), cfg), false, "Fri 16:00 — Shabbat");
assert.equal(S.isActiveTime(IL("2026-09-26T12:00:00+03:00"), cfg), false, "Sat noon — Shabbat");
assert.equal(S.isActiveTime(IL("2026-09-26T21:00:00+03:00"), cfg), false, "Sat 21:00 — after Shabbat but after hours");
assert.equal(S.isActiveTime(IL("2026-09-25T11:00:00+03:00"), cfg), true, "Fri 11:00 — before Shabbat");

// ── nextSlot: the very first post of a fresh account may go now, in hours ──
{
  const now = IL("2026-09-23T10:00:00+03:00");
  const slot = S.nextSlot({ now, account: account(0), candidates: [allowed("g1")], pageId: "p1", config: cfg, rand: noRand });
  assert.equal(slot.group_url, "g1");
  assert.ok(slot.at.getTime() >= now.getTime());
}

// ── minimum gap between ANY two posts, with jitter that only ever adds ──
{
  const now = IL("2026-09-23T10:00:00+03:00");
  const lastAt = new Date(now.getTime() - 10 * 60000).toISOString(); // 10 min ago
  const acct = account(30, [{ at: lastAt, group_url: "g0", page_id: "p0", ok: true }]);
  const slot = S.nextSlot({ now, account: acct, candidates: [allowed("g1")], pageId: "p1", config: cfg, rand: () => 0 });
  const gapMin = (slot.at.getTime() - new Date(lastAt).getTime()) / 60000;
  assert.ok(gapMin >= cfg.min_gap_minutes, `gap ${gapMin} < min ${cfg.min_gap_minutes}`);
  const slotHi = S.nextSlot({ now, account: acct, candidates: [allowed("g1")], pageId: "p1", config: cfg, rand: () => 1 });
  assert.ok(slotHi.at.getTime() > slot.at.getTime(), "rand=1 must push later, never earlier");
}

// ── warm-up: a freshly connected account gets the smallest daily cap ──
{
  const now = IL("2026-09-23T15:00:00+03:00");
  const today = (h) => IL(`2026-09-23T${String(h).padStart(2, "0")}:00:00+03:00`).toISOString();
  const two = [{ at: today(10), group_url: "a", page_id: "p", ok: true }, { at: today(12), group_url: "b", page_id: "p", ok: true }];
  const fresh = S.nextSlot({ now, account: account(1, two), candidates: [allowed("g9")], pageId: "p", config: cfg, rand: noRand });
  assert.equal(fresh.at, null, "day-1 account is capped at 2/day");
  assert.equal(fresh.reason, "daily_cap");
  const mature = S.nextSlot({ now, account: account(60, two), candidates: [allowed("g9")], pageId: "p", config: cfg, rand: noRand });
  assert.ok(mature.at, "a 60-day account may post a third time");
}

// ── caps count attempts, not successes: a failed post still spent the slot ──
{
  const now = IL("2026-09-23T15:00:00+03:00");
  const posts = [];
  for (let h = 9; h < 9 + cfg.daily_cap; h++) posts.push({ at: IL(`2026-09-23T${String(h).padStart(2, "0")}:00:00+03:00`).toISOString(), group_url: `g${h}`, page_id: "p", ok: h % 2 === 0 });
  const slot = S.nextSlot({ now, account: account(60, posts), candidates: [allowed("gz")], pageId: "p", config: cfg, rand: noRand });
  assert.equal(slot.at, null);
  assert.equal(slot.reason, "daily_cap");
}

// ── weekly cap ──
{
  const now = IL("2026-09-23T15:00:00+03:00");
  const posts = [];
  for (let i = 0; i < cfg.weekly_cap; i++) posts.push({ at: new Date(now.getTime() - day(1) - i * 3600000).toISOString(), group_url: `w${i}`, page_id: "p", ok: true });
  const slot = S.nextSlot({ now, account: account(60, posts), candidates: [allowed("gz")], pageId: "p", config: cfg, rand: noRand });
  assert.equal(slot.reason, "weekly_cap");
}

// ── same group cooldown, and same property→group cooldown, pick the other group ──
{
  const now = IL("2026-09-23T15:00:00+03:00");
  const recent = new Date(now.getTime() - day(2)).toISOString();
  const acct = account(60, [{ at: recent, group_url: "g1", page_id: "other", ok: true }]);
  const slot = S.nextSlot({ now, account: acct, candidates: [allowed("g1"), allowed("g2")], pageId: "p", config: cfg, rand: noRand });
  assert.equal(slot.group_url, "g2", "g1 was posted to 2 days ago");
  const only = S.nextSlot({ now, account: acct, candidates: [allowed("g1")], pageId: "p", config: cfg, rand: noRand });
  assert.equal(only.at, null);
  assert.equal(only.reason, "no_eligible_group");
  const old = account(60, [{ at: new Date(now.getTime() - day(10)).toISOString(), group_url: "g1", page_id: "p", ok: true }]);
  const sameProp = S.nextSlot({ now, account: old, candidates: [allowed("g1")], pageId: "p", config: cfg, rand: noRand });
  assert.equal(sameProp.reason, "no_eligible_group", "same property to same group inside 14 days");
}

// ── the agent_policy gate is in code, not in the UI ──
{
  const now = IL("2026-09-23T15:00:00+03:00");
  const cands = [
    { url: "forbidden", agent_policy: "forbidden", explicit: true },
    { url: "unknown-unticked", agent_policy: "unknown", explicit: false },
    { url: "unknown-ticked", agent_policy: "unknown", explicit: true },
  ];
  const slot = S.nextSlot({ now, account: account(60), candidates: cands, pageId: "p", config: cfg, rand: noRand });
  assert.equal(slot.group_url, "unknown-ticked");
  const none = S.nextSlot({ now, account: account(60), candidates: cands.slice(0, 2), pageId: "p", config: cfg, rand: noRand });
  assert.equal(none.reason, "no_eligible_group");
}

// ── outside active hours, the slot is the next active window, not now ──
{
  const now = IL("2026-09-23T23:30:00+03:00");
  const slot = S.nextSlot({ now, account: account(60), candidates: [allowed("g1")], pageId: "p", config: cfg, rand: noRand });
  assert.ok(slot.at.getTime() > now.getTime() + 8 * 3600000, "must wait for the morning");
  assert.equal(S.isActiveTime(slot.at, cfg), true);
}

// ── after a signal, nothing for the cooldown, whatever the caps say ──
{
  const now = IL("2026-09-23T15:00:00+03:00");
  const acct = Object.assign(account(60), { halted_at: new Date(now.getTime() - 3600000).toISOString() });
  const slot = S.nextSlot({ now, account: acct, candidates: [allowed("g1")], pageId: "p", config: cfg, rand: noRand });
  assert.equal(slot.reason, "signal_cooldown");
}

// ── signal classification ──
assert.equal(S.classifySignal("https://www.facebook.com/groups/1", "כתבו משהו…"), "ok");
assert.equal(S.classifySignal("https://www.facebook.com/login/?next=x", ""), "login_required");
assert.equal(S.classifySignal("https://www.facebook.com/checkpoint/1501092823525282/", ""), "checkpoint");
assert.equal(S.classifySignal("https://www.facebook.com/groups/1", "Confirm you're human"), "captcha");
assert.equal(S.classifySignal("https://www.facebook.com/groups/1", "You're temporarily blocked from posting"), "rate_limited");
assert.equal(S.classifySignal("https://www.facebook.com/groups/1", "אתם חסומים זמנית"), "rate_limited");
assert.equal(S.classifySignal("https://www.facebook.com/groups/1", "You can't post in this group"), "group_blocked");
assert.equal(S.classifySignal("https://www.facebook.com/groups/1", "הצטרפות לקבוצה"), "not_member");
for (const sig of ["checkpoint", "captcha", "rate_limited", "login_required"]) assert.ok(S.SIGNAL_HALTS.has(sig), `${sig} halts the account`);
assert.ok(!S.SIGNAL_HALTS.has("not_member"), "not being a member is a per-group skip, not an account halt");

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
 * [Unverified] None of DEFAULTS was measured against Facebook. They are set
 * well below what an active human agent does by hand; Task 18 calibrates.
 * A number is never hard-coded at a call site — always read from the config.
 */

const DEFAULTS = {
  timezone: "Asia/Jerusalem",
  active_hours: { start: 9, end: 21 },      // local; end is exclusive
  shabbat: { start_dow: 5, start_hour: 15, end_dow: 6, end_hour: 20 }, // Fri 15:00 → Sat 20:00
  min_gap_minutes: 45,                       // between ANY two posts by one account
  gap_jitter: 0.6,                           // adds up to +60% of the gap, never subtracts
  daily_cap: 6,
  weekly_cap: 25,
  warmup: [{ days: 3, daily_cap: 2 }, { days: 10, daily_cap: 4 }], // then daily_cap
  group_cooldown_days: 7,                    // this account → same group
  property_group_cooldown_days: 14,          // same property → same group
  cooldown_after_signal_hours: 48,
  max_consecutive_failures: 2,
};

const MS_MIN = 60000, MS_HOUR = 3600000, MS_DAY = 24 * MS_HOUR;

// Local wall-clock parts without a tz library: Intl handles DST for us.
function localParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, weekday: "short", hour: "numeric", minute: "numeric" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { dow, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

function inShabbat({ dow, hour }, sh) {
  if (dow === sh.start_dow) return hour >= sh.start_hour;
  if (dow === sh.end_dow) return hour < sh.end_hour;
  return false;
}

function isActiveTime(date, config = DEFAULTS) {
  const lp = localParts(date, config.timezone);
  if (config.shabbat && inShabbat(lp, config.shabbat)) return false;
  return lp.hour >= config.active_hours.start && lp.hour < config.active_hours.end;
}

// Walk forward in 15-minute steps to the next active minute. Bounded: 8 days
// covers any Shabbat + hours combination twice over.
function nextActiveTime(from, config) {
  let t = new Date(from.getTime());
  for (let i = 0; i < 8 * 96; i++) {
    if (isActiveTime(t, config)) return t;
    t = new Date(t.getTime() + 15 * MS_MIN);
  }
  return t;
}

function dailyCapFor(connectedAt, now, config) {
  const ageDays = (now.getTime() - new Date(connectedAt).getTime()) / MS_DAY;
  for (const w of config.warmup) if (ageDays < w.days) return w.daily_cap;
  return config.daily_cap;
}

const sameLocalDay = (a, b, tz) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(a) === f.format(b);
};

/*
 * The decision. Order matters: cheapest, most absolute reasons first, so a
 * halted account never even reaches the group-picking step.
 */
function nextSlot({ now, account, candidates, pageId, config = DEFAULTS, rand = Math.random }) {
  const posts = (account.posts || []).map((p) => ({ ...p, t: new Date(p.at).getTime() }));

  if (account.halted_at) {
    const until = new Date(account.halted_at).getTime() + config.cooldown_after_signal_hours * MS_HOUR;
    if (now.getTime() < until) return { at: null, reason: "signal_cooldown" };
  }

  const todays = posts.filter((p) => sameLocalDay(new Date(p.t), now, config.timezone)).length;
  if (todays >= dailyCapFor(account.connected_at, now, config)) return { at: null, reason: "daily_cap" };

  const weeks = posts.filter((p) => now.getTime() - p.t < 7 * MS_DAY).length;
  if (weeks >= config.weekly_cap) return { at: null, reason: "weekly_cap" };

  const eligible = candidates.filter((c) => {
    if (c.agent_policy === "forbidden") return false;
    if (c.agent_policy === "unknown" && !c.explicit) return false;
    const toGroup = posts.filter((p) => p.group_url === c.url);
    if (toGroup.some((p) => now.getTime() - p.t < config.group_cooldown_days * MS_DAY)) return false;
    if (toGroup.some((p) => p.page_id === pageId && now.getTime() - p.t < config.property_group_cooldown_days * MS_DAY)) return false;
    return true;
  });
  if (!eligible.length) return { at: null, reason: "no_eligible_group" };

  // Least-recently-posted group first: spreads the account's activity out
  // instead of hammering whichever group is first in the list.
  const lastTo = (url) => Math.max(0, ...posts.filter((p) => p.group_url === url).map((p) => p.t));
  eligible.sort((a, b) => lastTo(a.url) - lastTo(b.url));

  const lastAny = Math.max(0, ...posts.map((p) => p.t));
  const gap = config.min_gap_minutes * MS_MIN * (1 + config.gap_jitter * rand());
  const earliest = new Date(Math.max(now.getTime(), lastAny + gap));
  return { at: nextActiveTime(earliest, config), group_url: eligible[0].url };
}

// ── what the page is telling us ──
const SIGNALS = [
  ["login_required", /\/(login|checkpoint\/block)(\/|\?|$)/i, null],
  ["checkpoint", /\/checkpoint\//i, /(confirm your identity|אימות הזהות)/i],
  ["captcha", null, /(confirm you'?re human|security check|אנחנו רוצים לוודא שאת|בדיקת אבטחה)/i],
  ["rate_limited", null, /(temporarily blocked|posting too fast|slow down|חסומים זמנית|חסום זמנית|לאט יותר)/i],
  ["group_blocked", null, /(can'?t post in this group|no longer able to post|לא ניתן לפרסם בקבוצה)/i],
  ["not_member", null, /(join group|הצטרפות לקבוצה|הצטרפו לקבוצה)/i],
];
const SIGNAL_HALTS = new Set(["login_required", "checkpoint", "captcha", "rate_limited"]);

function classifySignal(landedUrl, text) {
  const u = String(landedUrl || ""), t = String(text || "");
  for (const [code, urlRe, textRe] of SIGNALS) {
    if (urlRe && urlRe.test(u)) return code;
    if (textRe && textRe.test(t)) return code;
  }
  return "ok";
}

module.exports = { DEFAULTS, nextSlot, isActiveTime, nextActiveTime, classifySignal, SIGNAL_HALTS, _test: { localParts, dailyCapFor } };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node posting-safety.test.js`
Expected: PASS. If the Shabbat assertions fail, check that `Intl` in your Node has full ICU (`node -p "Intl.DateTimeFormat('en-US',{timeZone:'Asia/Jerusalem'}).format(new Date())"` must not throw); Node 20+ ships full ICU by default.

- [ ] **Step 5: Add to the test chain and commit**

Append ` && node posting-safety.test.js` to `scripts.test` in `server/package.json`.

```bash
cd server && npm test
git add server/posting-safety.js server/posting-safety.test.js server/package.json
git commit -m "feat(posting): pure pacing and signal rules for group posting"
```

---

### Task 14: `posting-campaign.js` — the campaign state machine

**Files:**
- Create: `server/posting-campaign.js`
- Create: `server/posting-campaign.test.js`
- Modify: `server/db.js` (campaign store + posting lock on the connection doc)
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Consumes: `posting-safety.nextSlot/SIGNAL_HALTS/DEFAULTS`, `share-kit.buildPostCopy/trackedUrl`, `db.*PostingCampaign*`, `db.getConnection/setConnection`, `posting-driver.postToGroup` (Task 15, injected as `deps.post`).
- Produces:
  - `create({ phone, page, pageUrl, groups, mode, standing }, deps) -> Campaign` — status `awaiting_approval`
  - `approve(id, { mode, standing }, deps)`, `approvePost(id, postId, deps)`, `pause(id, deps)`, `resume(id, deps)`, `stop(id, deps)`, `acknowledgeHalt(id, deps)`
  - `tick(campaign, deps, now) -> Campaign` — one scheduling/posting step
  - `sweep(deps, now) -> number`, `startSweeper(deps)`, `liveDeps()`
  - Campaign shape:
    ```
    { id, phone, page_id, page_url, title, mode: "per_post"|"standing",
      standing: { granted_at, expires_at, max_posts } | null,
      groups: [{ url, name, agent_policy, explicit }],
      status: "awaiting_approval"|"running"|"paused"|"halted"|"stopped"|"completed",
      halt_reason: string|null, next_at: ISO|null,
      posts: [{ id, group_url, status: "pending_approval"|"scheduled"|"posting"|"posted"|"failed"|"skipped",
                scheduled_at, posted_at, post_url, error_code, copy }],
      consecutive_failures: number, created_at, updated_at }
    ```

- [ ] **Step 1: Write the failing test**

Create `server/posting-campaign.test.js`:

```js
/* posting-campaign.js — the campaign lifecycle. No browser: post() is a fake. */
const assert = require("assert");
const C = require("./posting-campaign");

function fakeDb() {
  const camps = new Map(), conns = new Map();
  return {
    camps, conns,
    savePostingCampaign: async (c) => { camps.set(c.id, JSON.parse(JSON.stringify(c))); },
    getPostingCampaign: async (id) => (camps.has(id) ? JSON.parse(JSON.stringify(camps.get(id))) : null),
    updatePostingCampaign: async (id, patch) => { const c = camps.get(id); if (c) Object.assign(c, JSON.parse(JSON.stringify(patch))); },
    listPostingCampaignsByStatus: async (st) => [...camps.values()].filter((c) => c.status === st).map((c) => JSON.parse(JSON.stringify(c))),
    listPostingCampaignsByPhone: async (ph) => [...camps.values()].filter((c) => c.phone === ph),
    getConnection: async (ph) => conns.get(ph) || null,
    setConnection: async (ph, patch) => { conns.set(ph, Object.assign(conns.get(ph) || {}, patch)); },
  };
}
const page = { page_id: "pg1", title: "דירה בחיפה", property: { city: "חיפה", price: 2000000, rooms: 4 }, agent: { name: "דנה" } };
const groups = [
  { url: "https://www.facebook.com/groups/1", name: "A", agent_policy: "allowed", explicit: true },
  { url: "https://www.facebook.com/groups/2", name: "B", agent_policy: "allowed", explicit: true },
];
const NOW = new Date("2026-09-23T10:00:00+03:00");
const connected = (db, ph, daysAgo = 60) => db.setConnection(ph, { facebook_browser_connected_at: new Date(NOW.getTime() - daysAgo * 86400000).toISOString() });

(async () => {
  // ── create: awaiting approval, nothing scheduled ──
  const db = fakeDb(); await connected(db, "p");
  const c = await C.create({ phone: "p", page, pageUrl: "https://f.ly/pg1", groups, mode: "standing", standing: { days: 14, max_posts: 10 } }, { db });
  assert.equal(c.status, "awaiting_approval");
  assert.equal(c.posts.length, 0);
  assert.equal(c.next_at, null);

  // ── approve (standing) → running with a bounded permission ──
  const a = await C.approve(c.id, { mode: "standing", standing: { days: 14, max_posts: 10 } }, { db, now: NOW });
  assert.equal(a.status, "running");
  assert.equal(a.standing.max_posts, 10);
  assert.ok(new Date(a.standing.expires_at) > NOW);

  // ── tick schedules a post, then posts it when due, with per-group copy and a tracked url ──
  const posted = [];
  const deps = { db, now: NOW, rand: () => 0, post: async (args) => { posted.push(args); return { post_url: "https://www.facebook.com/groups/1/posts/999" }; } };
  let t = await C.tick(a, deps, NOW);
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].status, "scheduled");
  assert.ok(t.posts[0].copy.includes("חיפה"));
  assert.ok(t.posts[0].copy.includes("s=" + c.id), "tracked url carries the campaign id");
  const due = new Date(t.posts[0].scheduled_at);
  t = await C.tick(t, deps, new Date(due.getTime() + 1000));
  assert.equal(t.posts[0].status, "posted");
  assert.equal(t.posts[0].post_url, "https://www.facebook.com/groups/1/posts/999");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].groupUrl, groups[0].url);
  assert.equal(posted[0].profileName, "facebook-p");
  assert.equal(posted[0].dryRun, false);

  // ── the next post goes to the OTHER group, after the minimum gap ──
  t = await C.tick(t, deps, new Date(due.getTime() + 2000));
  const second = t.posts[1];
  assert.equal(second.group_url, groups[1].url);
  assert.ok(new Date(second.scheduled_at).getTime() - due.getTime() >= 45 * 60000);

  // ── serial per phone: a tick while a post is in flight does nothing ──
  await db.setConnection("p", { posting_lock_until: new Date(Date.now() + 60000).toISOString() });
  const before = JSON.stringify(t.posts);
  const blocked = await C.tick(t, deps, new Date(second.scheduled_at));
  assert.equal(JSON.stringify(blocked.posts), before, "locked phone: no posting");
  await db.setConnection("p", { posting_lock_until: null });

  // ── per_post mode: the post waits for approval, and is posted only after it ──
  const db2 = fakeDb(); await connected(db2, "q");
  const c2 = await C.create({ phone: "q", page, pageUrl: "https://f.ly/pg1", groups, mode: "per_post" }, { db: db2 });
  const notified = [];
  const deps2 = { db: db2, now: NOW, rand: () => 0, post: async () => ({ post_url: "u" }), notify: async (ph, msg) => notified.push(msg) };
  let r2 = await C.approve(c2.id, { mode: "per_post" }, deps2);
  r2 = await C.tick(r2, deps2, NOW);
  assert.equal(r2.posts[0].status, "pending_approval");
  assert.equal(notified.length, 1, "agent was told there is a post to approve");
  assert.ok(notified[0].includes(r2.posts[0].copy.slice(0, 20)), "the notification shows the exact copy");
  r2 = await C.tick(r2, deps2, new Date(NOW.getTime() + 3600000));
  assert.equal(r2.posts[0].status, "pending_approval", "unapproved: still waiting an hour later");
  r2 = await C.approvePost(c2.id, r2.posts[0].id, deps2);
  assert.equal(r2.posts[0].status, "scheduled");

  // ── stop: cancels the scheduled post; a later tick posts nothing ──
  const s = await C.stop(c.id, { db });
  assert.equal(s.status, "stopped");
  const after = await C.tick(s, deps, new Date(second.scheduled_at));
  assert.equal(after.posts.filter((p) => p.status === "posted").length, 1, "still only the first post");

  // ── a halting signal halts the campaign, records why, and marks the account ──
  const db3 = fakeDb(); await connected(db3, "r");
  const c3 = await C.create({ phone: "r", page, pageUrl: "https://f.ly/pg1", groups, mode: "standing", standing: { days: 7, max_posts: 5 } }, { db: db3 });
  let r3 = await C.approve(c3.id, { mode: "standing", standing: { days: 7, max_posts: 5 } }, { db: db3, now: NOW });
  const deps3 = { db: db3, now: NOW, rand: () => 0, post: async () => { const e = new Error("checkpoint"); e.code = "checkpoint"; throw e; } };
  r3 = await C.tick(r3, deps3, NOW);
  r3 = await C.tick(r3, deps3, new Date(new Date(r3.posts[0].scheduled_at).getTime() + 1000));
  assert.equal(r3.status, "halted");
  assert.equal(r3.halt_reason, "checkpoint");
  assert.ok((await db3.getConnection("r")).posting_halted_at, "the ACCOUNT is marked, not just this campaign");
  // a second campaign on the same account is held by the same halt
  const c3b = await C.create({ phone: "r", page: { ...page, page_id: "pg2" }, pageUrl: "https://f.ly/pg2", groups, mode: "standing", standing: { days: 7, max_posts: 5 } }, { db: db3 });
  let r3b = await C.approve(c3b.id, { mode: "standing", standing: { days: 7, max_posts: 5 } }, { db: db3, now: NOW });
  r3b = await C.tick(r3b, deps3, new Date(NOW.getTime() + 3600000));
  assert.equal(r3b.posts.length, 0, "no scheduling while the account is in signal cooldown");

  // ── not_member is a per-group skip, not a halt ──
  const db4 = fakeDb(); await connected(db4, "s");
  const c4 = await C.create({ phone: "s", page, pageUrl: "https://f.ly/pg1", groups, mode: "standing", standing: { days: 7, max_posts: 5 } }, { db: db4 });
  let r4 = await C.approve(c4.id, { mode: "standing", standing: { days: 7, max_posts: 5 } }, { db: db4, now: NOW });
  const deps4 = { db: db4, now: NOW, rand: () => 0, post: async () => { const e = new Error("nm"); e.code = "not_member"; throw e; } };
  r4 = await C.tick(r4, deps4, NOW);
  r4 = await C.tick(r4, deps4, new Date(new Date(r4.posts[0].scheduled_at).getTime() + 1000));
  assert.equal(r4.posts[0].status, "skipped");
  assert.equal(r4.status, "running");

  // ── consecutive failures trip the breaker ──
  const db5 = fakeDb(); await connected(db5, "t");
  const c5 = await C.create({ phone: "t", page, pageUrl: "https://f.ly/pg1", groups, mode: "standing", standing: { days: 7, max_posts: 5 } }, { db: db5 });
  let r5 = await C.approve(c5.id, { mode: "standing", standing: { days: 7, max_posts: 5 } }, { db: db5, now: NOW });
  const deps5 = { db: db5, now: NOW, rand: () => 0, post: async () => { const e = new Error("x"); e.code = "post_failed"; throw e; } };
  let clock = NOW.getTime();
  for (let i = 0; i < 2; i++) {
    r5 = await C.tick(r5, deps5, new Date(clock));
    const dueAt = new Date(r5.posts[r5.posts.length - 1].scheduled_at).getTime() + 1000;
    r5 = await C.tick(r5, deps5, new Date(dueAt));
    clock = dueAt;
  }
  assert.equal(r5.status, "paused");
  assert.equal(r5.halt_reason, "consecutive_failures");

  // ── standing permission ends: by expiry, and by max_posts ──
  const db6 = fakeDb(); await connected(db6, "u");
  const c6 = await C.create({ phone: "u", page, pageUrl: "https://f.ly/pg1", groups, mode: "standing", standing: { days: 1, max_posts: 1 } }, { db: db6 });
  let r6 = await C.approve(c6.id, { mode: "standing", standing: { days: 1, max_posts: 1 } }, { db: db6, now: NOW });
  const deps6 = { db: db6, now: NOW, rand: () => 0, post: async () => ({ post_url: "u" }) };
  r6 = await C.tick(r6, deps6, NOW);
  r6 = await C.tick(r6, deps6, new Date(new Date(r6.posts[0].scheduled_at).getTime() + 1000));
  assert.equal(r6.status, "completed", "max_posts reached");
  const c7 = await C.create({ phone: "u", page, pageUrl: "https://f.ly/pg1", groups, mode: "standing", standing: { days: 1, max_posts: 9 } }, { db: db6 });
  let r7 = await C.approve(c7.id, { mode: "standing", standing: { days: 1, max_posts: 9 } }, { db: db6, now: NOW });
  r7 = await C.tick(r7, deps6, new Date(NOW.getTime() + 2 * 86400000));
  assert.equal(r7.status, "completed", "permission expired");
  assert.equal(r7.posts.length, 0);

  // ── sweep runs due campaigns only ──
  const db8 = fakeDb(); await connected(db8, "v");
  const c8 = await C.create({ phone: "v", page, pageUrl: "https://f.ly/pg1", groups, mode: "standing", standing: { days: 7, max_posts: 5 } }, { db: db8 });
  await C.approve(c8.id, { mode: "standing", standing: { days: 7, max_posts: 5 } }, { db: db8, now: NOW });
  let ticked = 0;
  const n = await C.sweep({ db: db8, tick: async () => { ticked++; } }, NOW);
  assert.equal(n, 1); assert.equal(ticked, 1);

  console.log("posting-campaign.test.js ok");
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node posting-campaign.test.js`
Expected: FAIL with `Cannot find module './posting-campaign'`

- [ ] **Step 3: Add the store to `db.js`**

Add `postingCampaigns: new Map()` to the `mem` literal at `server/db.js:11`. Add after the extract-job functions:

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
  if (db) {
    const snap = await db.collection("posting_campaigns").where("status", "==", status).limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.postingCampaigns.values()].filter((c) => c.status === status).slice(0, limit);
}
async function listPostingCampaignsByPhone(phone, limit = 100) {
  if (db) {
    const snap = await db.collection("posting_campaigns").where("phone", "==", phone).limit(limit).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.postingCampaigns.values()].filter((c) => c.phone === phone).slice(0, limit);
}
```

Export all five.

- [ ] **Step 4: Write the state machine**

Create `server/posting-campaign.js`:

```js
/*
 * posting-campaign.js — one property, many groups, over days.
 *
 * A campaign is the agent's permission plus a ledger of what was done with it.
 * Two permission shapes:
 *   per_post  — every single post is shown to the agent (exact copy, exact
 *               group) and posted only after they approve it;
 *   standing  — "post until I stop", bounded by an expiry AND a max count, and
 *               revocable at any moment with stop().
 *
 * The scheduling decision is never made here: tick() asks posting-safety.js
 * and does what it says. This file only moves state and calls the browser.
 *
 * Account-level facts (halts, the posting lock, the post ledger used for
 * pacing) live on the CONNECTION doc, not the campaign — two campaigns for one
 * agent must share one pace and one halt.
 */
const crypto = require("crypto");
const safety = require("./posting-safety");
const shareKit = require("./distribution/share-kit");

const SWEEP_MS = 60 * 1000;
const LOCK_MS = 5 * 60 * 1000;
const LEDGER_DAYS = 30;

const iso = (d) => new Date(d).toISOString();

async function create({ phone, page, pageUrl, groups, mode, standing }, deps) {
  const c = {
    id: crypto.randomUUID(),
    phone: String(phone),
    page_id: page.page_id,
    page_url: String(pageUrl),
    title: page.title || "",
    page_snapshot: { property: page.property || {}, agent: page.agent || {} },
    mode: mode === "per_post" ? "per_post" : "standing",
    standing: null,
    groups: (groups || []).slice(0, shareKit.MAX_GROUPS).map((g) => ({
      url: g.url, name: g.name || "", agent_policy: g.agent_policy || "unknown", explicit: g.explicit === true,
    })),
    status: "awaiting_approval",
    halt_reason: null,
    next_at: null,
    posts: [],
    consecutive_failures: 0,
    created_at: iso(Date.now()),
    updated_at: iso(Date.now()),
  };
  if (c.mode === "standing" && standing) c.standing = { days: standing.days, max_posts: standing.max_posts, granted_at: null, expires_at: null };
  await deps.db.savePostingCampaign(c);
  return c;
}

async function patch(id, p, deps) {
  p.updated_at = iso(deps.now || Date.now());
  await deps.db.updatePostingCampaign(id, p);
  return deps.db.getPostingCampaign(id);
}

async function approve(id, { mode, standing }, deps) {
  const now = deps.now || new Date();
  const c = await deps.db.getPostingCampaign(id);
  if (!c || c.status !== "awaiting_approval") return c;
  const p = { status: "running", mode: mode === "per_post" ? "per_post" : "standing" };
  if (p.mode === "standing") {
    const days = Math.min(Math.max(Number(standing && standing.days) || 7, 1), 30);
    const max = Math.min(Math.max(Number(standing && standing.max_posts) || 10, 1), 100);
    p.standing = { days, max_posts: max, granted_at: iso(now), expires_at: iso(now.getTime() + days * 86400000) };
  } else p.standing = null;
  return patch(id, p, deps);
}

async function approvePost(id, postId, deps) {
  const c = await deps.db.getPostingCampaign(id);
  if (!c) return null;
  const posts = c.posts.map((p) => (p.id === postId && p.status === "pending_approval" ? { ...p, status: "scheduled" } : p));
  return patch(id, { posts }, deps);
}

const pause = (id, deps) => patch(id, { status: "paused", halt_reason: "agent" }, deps);
const resume = (id, deps) => patch(id, { status: "running", halt_reason: null, consecutive_failures: 0 }, deps);

// Stop is immediate and final: whatever was scheduled is cancelled, and the
// sweeper never picks a stopped campaign up again.
async function stop(id, deps) {
  const c = await deps.db.getPostingCampaign(id);
  if (!c) return null;
  const posts = c.posts.map((p) => (p.status === "scheduled" || p.status === "pending_approval" ? { ...p, status: "skipped", error_code: "stopped" } : p));
  return patch(id, { status: "stopped", posts, next_at: null }, deps);
}

// The agent has dealt with the checkpoint (through the embedded browser) and
// says so. The safety cooldown still applies from posting_halted_at.
async function acknowledgeHalt(id, deps) {
  const c = await deps.db.getPostingCampaign(id);
  if (!c || c.status !== "halted") return c;
  return patch(id, { status: "running", halt_reason: null, consecutive_failures: 0 }, deps);
}

// ── the account-level view posting-safety needs ──
async function accountFor(phone, deps, now) {
  const conn = (await deps.db.getConnection(phone)) || {};
  const cutoff = now.getTime() - LEDGER_DAYS * 86400000;
  return {
    conn,
    account: {
      connected_at: conn.facebook_browser_connected_at || iso(now),
      halted_at: conn.posting_halted_at || null,
      posts: (conn.posting_ledger || []).filter((p) => new Date(p.at).getTime() > cutoff),
    },
  };
}

async function recordPost(phone, conn, entry, deps, now) {
  const cutoff = now.getTime() - LEDGER_DAYS * 86400000;
  const ledger = (conn.posting_ledger || []).filter((p) => new Date(p.at).getTime() > cutoff).concat([entry]);
  await deps.db.setConnection(phone, { posting_ledger: ledger });
}

function standingExhausted(c, now) {
  if (c.mode !== "standing" || !c.standing) return false;
  if (c.standing.expires_at && now.getTime() > new Date(c.standing.expires_at).getTime()) return true;
  return c.posts.filter((p) => p.status === "posted").length >= c.standing.max_posts;
}

/*
 * One step. Either schedules the next post (asking posting-safety when and
 * where), or, if a scheduled post is due, posts it. Never both in one tick:
 * the ledger the next decision needs is written by this one.
 */
async function tick(campaign, deps, now = deps.now || new Date()) {
  let c = await deps.db.getPostingCampaign(campaign.id);
  if (!c || c.status !== "running") return c;
  if (standingExhausted(c, now)) return patch(c.id, { status: "completed", next_at: null }, deps);

  const { conn, account } = await accountFor(c.phone, deps, now);
  if (conn.posting_lock_until && new Date(conn.posting_lock_until).getTime() > now.getTime()) return c;

  const due = c.posts.find((p) => p.status === "scheduled" && new Date(p.scheduled_at).getTime() <= now.getTime());
  if (due) return postNow(c, due, conn, deps, now);

  if (c.posts.some((p) => p.status === "scheduled" || p.status === "pending_approval")) return c;

  // Nothing in flight: ask when and where the next one may go.
  const slot = safety.nextSlot({ now, account, candidates: c.groups, pageId: c.page_id, config: deps.config || safety.DEFAULTS, rand: deps.rand });
  if (!slot.at) {
    if (slot.reason === "no_eligible_group" && !c.posts.some((p) => p.status === "posted")) return c;
    return patch(c.id, { next_at: null, halt_reason: null }, deps);
  }
  const group = c.groups.find((g) => g.url === slot.group_url);
  const url = shareKit.trackedUrl(c.page_url, { session: c.id, group: group.url });
  const copy = shareKit.buildPostCopy({ property: c.page_snapshot.property, agent: c.page_snapshot.agent, title: c.title }, url, { variantSeed: c.page_id + group.url });
  const post = {
    id: crypto.randomUUID(), group_url: group.url, group_name: group.name,
    status: c.mode === "per_post" ? "pending_approval" : "scheduled",
    scheduled_at: iso(slot.at), posted_at: null, post_url: null, error_code: null, copy,
  };
  if (c.mode === "per_post" && deps.notify) {
    await deps.notify(c.phone, `📣 פוסט מוכן לאישור לקבוצה "${group.name || group.url}":\n──────────\n${copy}\n──────────\nלאישור, היכנסו לעמוד ההפצה בדשבורד.`);
  }
  return patch(c.id, { posts: c.posts.concat([post]), next_at: post.scheduled_at }, deps);
}

async function postNow(c, post, conn, deps, now) {
  await deps.db.setConnection(c.phone, { posting_lock_until: iso(now.getTime() + LOCK_MS) });
  let posts = c.posts.map((p) => (p.id === post.id ? { ...p, status: "posting" } : p));
  await deps.db.updatePostingCampaign(c.id, { posts });
  let result = null, err = null;
  try {
    result = await deps.post({ groupUrl: post.group_url, copy: post.copy, profileName: `facebook-${c.phone}`, dryRun: deps.dryRun === true, campaignId: c.id });
  } catch (e) { err = e; }
  finally { await deps.db.setConnection(c.phone, { posting_lock_until: null }); }

  const conn2 = (await deps.db.getConnection(c.phone)) || conn;
  if (!err) {
    posts = posts.map((p) => (p.id === post.id ? { ...p, status: "posted", posted_at: iso(now), post_url: result && result.post_url } : p));
    await recordPost(c.phone, conn2, { at: iso(now), group_url: post.group_url, page_id: c.page_id, ok: true }, deps, now);
    const next = await patch(c.id, { posts, consecutive_failures: 0, next_at: null }, deps);
    return standingExhausted(next, now) ? patch(c.id, { status: "completed" }, deps) : next;
  }

  const code = err.code || "post_failed";
  await recordPost(c.phone, conn2, { at: iso(now), group_url: post.group_url, page_id: c.page_id, ok: false }, deps, now);
  if (safety.SIGNAL_HALTS.has(code)) {
    // The account, not the campaign: every other campaign on this phone is
    // held by the same cooldown through posting_halted_at.
    await deps.db.setConnection(c.phone, { posting_halted_at: iso(now), posting_halt_reason: code });
    posts = posts.map((p) => (p.id === post.id ? { ...p, status: "failed", error_code: code } : p));
    return patch(c.id, { posts, status: "halted", halt_reason: code, next_at: null }, deps);
  }
  const skip = code === "not_member" || code === "group_blocked";
  posts = posts.map((p) => (p.id === post.id ? { ...p, status: skip ? "skipped" : "failed", error_code: code } : p));
  const failures = skip ? c.consecutive_failures : c.consecutive_failures + 1;
  const max = (deps.config || safety.DEFAULTS).max_consecutive_failures;
  if (failures >= max) return patch(c.id, { posts, consecutive_failures: failures, status: "paused", halt_reason: "consecutive_failures", next_at: null }, deps);
  return patch(c.id, { posts, consecutive_failures: failures, next_at: null }, deps);
}

async function sweep(deps, now = new Date()) {
  const running = await deps.db.listPostingCampaignsByStatus("running");
  const run = deps.tick || tick;
  let n = 0;
  for (const c of running) {
    n++;
    await run(c, deps, now).catch((e) => console.error(`posting campaign ${c.id}: ${e.message}`));
  }
  return n;
}

function startSweeper(deps) {
  const t = setInterval(() => { sweep(deps).catch((e) => console.error(`posting sweep: ${e.message}`)); }, deps.sweepMs || SWEEP_MS);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

function liveDeps() {
  return {
    db: require("./db"),
    post: require("./posting-driver").postToGroup,
    notify: (phone, msg) => require("./utils").sendWhatsApp(phone, msg),
  };
}

module.exports = { create, approve, approvePost, pause, resume, stop, acknowledgeHalt, tick, sweep, startSweeper, liveDeps, SWEEP_MS };
```

`sendWhatsApp`'s exact signature is in `server/utils.js`; match it in `liveDeps` rather than assuming `(phone, msg)` — the existing `distribution/jobs.js` shows the call in use.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && node posting-campaign.test.js && node distribution/share-kit.test.js`
Expected: both PASS.

- [ ] **Step 6: Add to the test chain and commit**

Append ` && node posting-campaign.test.js` to `scripts.test`.

```bash
cd server && npm test
git add server/db.js server/posting-campaign.js server/posting-campaign.test.js server/package.json
git commit -m "feat(posting): campaign state machine with per-post and standing approval"
```

---

### Task 15: `posting-driver.js` — the browser actions

The most brittle file in the plan, on purpose isolated so it is the *only* file that knows what Facebook's composer looks like. Every selector lives in one object at the top. [Unverified] The selectors below are a starting point, not a fact — Task 18's dry run is where they get fixed against the real page.

**Files:**
- Create: `server/posting-driver.js`
- Create: `server/posting-driver.test.js`
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Consumes: `driver-browser.withPage`, `posting-safety.classifySignal`.
- Produces: `postToGroup({ groupUrl, copy, profileName, dryRun, campaignId }, deps) -> Promise<{ post_url: string|null, dry_run: boolean }>`. Throws with `code` ∈ `classifySignal` values (`checkpoint`, `captcha`, `rate_limited`, `login_required`, `group_blocked`, `not_member`) or `composer_not_found` / `post_failed` / `not_verified`.

- [ ] **Step 1: Write the failing test**

Create `server/posting-driver.test.js`:

```js
/* posting-driver.js — the composer choreography, against a fake page. */
const assert = require("assert");
const PD = require("./posting-driver");

function fakePage(script) {
  // script: { landed, text, composer: bool, feedTexts: [] }
  const typed = [], clicked = [];
  let url = script.landed;
  return {
    typed, clicked,
    goto: async (u) => { url = script.landed || u; },
    url: () => url,
    innerText: async () => script.text || "כתבו משהו…",
    locator: (sel) => ({
      first: () => ({
        count: async () => (script.composer === false && /composer/.test(sel) ? 0 : 1),
        click: async () => { clicked.push(sel); },
        waitFor: async () => { if (script.composer === false && /composer/.test(sel)) throw new Error("timeout"); },
      }),
      count: async () => (script.composer === false && /composer/.test(sel) ? 0 : 1),
    }),
    keyboard: { type: async (t) => typed.push(t) },
    waitForLoadState: async () => {},
    $$eval: async () => script.feedTexts || [],
  };
}

(async () => {
  // ── happy path: navigates, types the copy, submits, verifies our link in the feed ──
  const page = fakePage({ landed: "https://www.facebook.com/groups/1", feedTexts: ["… https://f.ly/pg1?src=fb_group&s=c1&g=x …"] });
  const withPage = async (opts, fn) => {
    assert.deepEqual(opts.profile, { name: "facebook-p", persist: true });
    assert.ok(String(opts.note).startsWith("forly-post:c1"));
    assert.ok(!("url" in opts), "no landing url in the session opts — we navigate ourselves");
    return fn(page, { sessionId: "s" });
  };
  const out = await PD.postToGroup({ groupUrl: "https://www.facebook.com/groups/1", copy: "דירה https://f.ly/pg1?src=fb_group&s=c1&g=x", profileName: "facebook-p", dryRun: false, campaignId: "c1" }, { withPage });
  assert.equal(out.dry_run, false);
  assert.equal(page.typed.join(""), "דירה https://f.ly/pg1?src=fb_group&s=c1&g=x");
  assert.ok(page.clicked.some((s) => /submit/.test(s)), "the submit button was clicked");

  // ── dry run does everything except submit ──
  const page2 = fakePage({ landed: "https://www.facebook.com/groups/1" });
  const dry = await PD.postToGroup({ groupUrl: "https://www.facebook.com/groups/1", copy: "x", profileName: "facebook-p", dryRun: true, campaignId: "c1" }, { withPage: async (o, fn) => fn(page2, {}) });
  assert.equal(dry.dry_run, true);
  assert.equal(page2.typed.join(""), "x", "the copy was typed");
  assert.ok(!page2.clicked.some((s) => /submit/.test(s)), "but nothing was submitted");

  // ── signals surface as codes, before any typing ──
  for (const [landed, text, code] of [
    ["https://www.facebook.com/checkpoint/123/", "", "checkpoint"],
    ["https://www.facebook.com/login/?next=x", "", "login_required"],
    ["https://www.facebook.com/groups/1", "You're temporarily blocked", "rate_limited"],
    ["https://www.facebook.com/groups/1", "הצטרפות לקבוצה", "not_member"],
  ]) {
    const pg = fakePage({ landed, text });
    await assert.rejects(PD.postToGroup({ groupUrl: "https://www.facebook.com/groups/1", copy: "x", profileName: "facebook-p", campaignId: "c" }, { withPage: async (o, fn) => fn(pg, {}) }), (e) => e.code === code);
    assert.equal(pg.typed.length, 0, `${code}: nothing typed`);
  }

  // ── no composer means the DOM changed: fail loudly, do not guess ──
  const pg3 = fakePage({ landed: "https://www.facebook.com/groups/1", composer: false });
  await assert.rejects(PD.postToGroup({ groupUrl: "https://www.facebook.com/groups/1", copy: "x", profileName: "facebook-p", campaignId: "c" }, { withPage: async (o, fn) => fn(pg3, {}) }), (e) => e.code === "composer_not_found");

  // ── submitted but our link never appeared: not_verified, so the ledger still counts it ──
  const pg4 = fakePage({ landed: "https://www.facebook.com/groups/1", feedTexts: ["someone else's post"] });
  await assert.rejects(PD.postToGroup({ groupUrl: "https://www.facebook.com/groups/1", copy: "https://f.ly/pg1?s=c1&g=x", profileName: "facebook-p", campaignId: "c1" }, { withPage: async (o, fn) => fn(pg4, {}) }), (e) => e.code === "not_verified");

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
 * posting-driver.js — put one post into one group, from a background browser.
 *
 * This is the ONLY file that knows what Facebook's page looks like. When the
 * composer changes, SELECTORS is what changes. Nothing here retries: a failed
 * post is a failed post, and the campaign decides what that means.
 *
 * Nothing here is hidden from the platform either — no init scripts, no
 * request routing, no fingerprint tricks. It is a real Chrome with the agent's
 * own profile, typing at a human pace. That is the whole anti-ban strategy.
 *
 * [Unverified] SELECTORS is a starting point. Task 18 fixes it against the
 * live page before the first real post.
 */
const driver = require("./driver-browser");
const { classifySignal } = require("./posting-safety");

const SELECTORS = {
  // the "Write something…" box on a group page (he + en)
  composer: '[role="button"]:has-text("כתבו משהו"), [role="button"]:has-text("Write something"), div[aria-label="כתבו משהו..."], div[aria-label="Write something..."]',
  // the editable field once the composer dialog is open
  editor: 'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
  // the Post button in that dialog
  submit: 'div[role="dialog"] div[aria-label="פרסום"][role="button"], div[role="dialog"] div[aria-label="Post"][role="button"]',
  // any feed post's text, for verification
  feedPostText: 'div[role="feed"] div[data-ad-preview="message"], div[role="feed"] div[dir="auto"]',
};

const TYPE_DELAY_MS = 40;      // per character: a fast typist, not a paste
const VERIFY_TIMEOUT_MS = 20000;

function fail(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

async function readSignal(page) {
  const text = await page.innerText("body").catch(() => "");
  return classifySignal(page.url(), text);
}

async function postToGroup({ groupUrl, copy, profileName, dryRun = false, campaignId }, deps = {}) {
  const withPage = deps.withPage || driver.withPage;
  const opts = {
    country: "IL",
    duration: 600,
    note: `forly-post:${campaignId || "adhoc"}`,
    profile: { name: profileName, persist: true },
  };
  return withPage(opts, async (page) => {
    await page.goto(groupUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    const signal = await readSignal(page);
    if (signal !== "ok") throw fail(signal, `signal on load: ${signal}`);

    const composer = page.locator(SELECTORS.composer).first();
    if ((await composer.count()) === 0) throw fail("composer_not_found", "no composer on the group page");
    await composer.click();
    const editor = page.locator(SELECTORS.editor).first();
    await editor.waitFor({ timeout: 10000 }).catch(() => { throw fail("composer_not_found", "editor did not open"); });
    await editor.click();
    await page.keyboard.type(copy, { delay: TYPE_DELAY_MS });
    // Let the link preview attach before submitting — a post without its card
    // looks different from what a person posts.
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    if (dryRun) return { post_url: null, dry_run: true };

    await page.locator(SELECTORS.submit).first().click();
    await page.waitForLoadState("networkidle", { timeout: VERIFY_TIMEOUT_MS }).catch(() => {});

    const after = await readSignal(page);
    if (after !== "ok") throw fail(after, `signal after submit: ${after}`);

    // Verify by what a person would check: is our post in the feed now?
    const marker = (copy.match(/https?:\/\/\S+/) || [copy.slice(0, 40)])[0];
    const texts = await page.$$eval(SELECTORS.feedPostText, (els) => els.map((e) => e.textContent || "")).catch(() => []);
    if (!texts.some((t) => t.includes(marker))) throw fail("not_verified", "post not found in feed after submit");
    return { post_url: page.url(), dry_run: false };
  }, deps);
}

module.exports = { postToGroup, SELECTORS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node posting-driver.test.js`
Expected: PASS.

- [ ] **Step 5: Add to the test chain and commit**

Append ` && node posting-driver.test.js` to `scripts.test`.

```bash
cd server && npm test
git add server/posting-driver.js server/posting-driver.test.js server/package.json
git commit -m "feat(posting): browser choreography for posting to a group, with dry run"
```

---

### Task 16: `routes/posting.js` — the campaign API

**Files:**
- Create: `server/routes/posting.js`
- Create: `server/routes/posting.test.js`
- Modify: `server/index.js` (mount + sweeper)
- Modify: `server/package.json` (test chain)

**Interfaces:**
- Consumes: `posting-campaign.*`, `db.getPage/getPropertyGroups/listGroupCatalog/getConnection/listPostingCampaignsByPhone`.
- Produces:
  - `POST /api/posting/campaigns` body `{ page_id, group_urls: string[], mode: "per_post"|"standing", standing?: { days, max_posts } }` → `201 {campaign}`; `409 {error:"facebook_not_connected"}`; `400 {error:"invalid_input"}`; `422 {error:"forbidden_group", groups:[…]}`.
  - `POST /api/posting/campaigns/:id/approve` body `{ mode, standing? }` → `200 {campaign}`
  - `POST /api/posting/campaigns/:id/posts/:post_id/approve` → `200 {campaign}`
  - `POST /api/posting/campaigns/:id/pause | resume | stop | acknowledge-halt` → `200 {campaign}`
  - `GET /api/posting/campaigns?page_id=` → `200 {campaigns:[…]}`
  - `GET /api/posting/campaigns/:id` → `200 {campaign}`; `404` for another phone's campaign.
  - Every response is passed through `publicView(campaign)` which strips `page_snapshot` and never contains `cdpUrl`, `view_url` or `wss://`.

- [ ] **Step 1: Write the failing test**

Create `server/routes/posting.test.js`:

```js
/* routes/posting.js — ownership, the policy gate, and that nothing leaks. */
const assert = require("assert");
const express = require("express");
const http = require("http");
const createRouter = require("./posting");

const PHONE = "0500000000";
function makeApp(o = {}) {
  const phone = o.phone || PHONE;
  const requireAuth = () => (req, res, next) => { req.user = { userId: phone }; next(); };
  const app = express(); app.use(express.json());
  app.use("/api/posting", createRouter({ requireAuth, authSecret: "s", db: o.db, campaigns: o.campaigns, deps: o.deps }));
  return app;
}
function call(app, method, path, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const req = http.request({ port: server.address().port, path, method, headers: { "content-type": "application/json" } }, (res) => {
        let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(d || "{}"), raw: d }); });
      });
      if (body) req.write(JSON.stringify(body)); req.end();
    });
  });
}
const catalog = [
  { url: "https://www.facebook.com/groups/ok", name: "OK", agent_policy: "allowed" },
  { url: "https://www.facebook.com/groups/no", name: "NO", agent_policy: "forbidden" },
  { url: "https://www.facebook.com/groups/unk", name: "?", agent_policy: "unknown" },
];
const baseDb = (over = {}) => Object.assign({
  getPage: async (id) => (id === "pg1" ? { page_id: "pg1", business_phone: PHONE, title: "t", property: {}, agent: {} } : null),
  listGroupCatalog: async () => catalog,
  getConnection: async () => ({ facebook_browser_connected_at: "2026-09-01T00:00:00Z" }),
  listPostingCampaignsByPhone: async () => [],
}, over);

(async () => {
  // ── create: gate on connection, on ownership of the page, on agent_policy ──
  let created = null;
  const campaigns = {
    create: async (input) => { created = input; return { id: "c1", phone: PHONE, status: "awaiting_approval", posts: [], groups: input.groups, page_snapshot: { secret: 1 } }; },
  };
  const app = makeApp({ db: baseDb(), campaigns });
  const ok = await call(app, "POST", "/api/posting/campaigns", { page_id: "pg1", group_urls: [catalog[0].url, catalog[2].url], mode: "standing", standing: { days: 7, max_posts: 5 } });
  assert.equal(ok.status, 201);
  assert.deepEqual(created.groups.map((g) => [g.url, g.agent_policy, g.explicit]), [[catalog[0].url, "allowed", true], [catalog[2].url, "unknown", true]]);
  assert.ok(!("page_snapshot" in ok.body.campaign), "internal snapshot is not exposed");

  const forbidden = await call(app, "POST", "/api/posting/campaigns", { page_id: "pg1", group_urls: [catalog[1].url], mode: "standing" });
  assert.equal(forbidden.status, 422);
  assert.equal(forbidden.body.error, "forbidden_group");

  const notConnected = await call(makeApp({ db: baseDb({ getConnection: async () => ({}) }), campaigns }), "POST", "/api/posting/campaigns", { page_id: "pg1", group_urls: [catalog[0].url], mode: "standing" });
  assert.equal(notConnected.status, 409);
  assert.equal(notConnected.body.error, "facebook_not_connected");

  const notMine = await call(makeApp({ phone: "0509999999", db: baseDb(), campaigns }), "POST", "/api/posting/campaigns", { page_id: "pg1", group_urls: [catalog[0].url], mode: "standing" });
  assert.equal(notMine.status, 404);

  const noGroups = await call(app, "POST", "/api/posting/campaigns", { page_id: "pg1", group_urls: [], mode: "standing" });
  assert.equal(noGroups.status, 400);

  // ── standing bounds are clamped server-side, whatever the client sends ──
  let approved = null;
  const camp2 = { approve: async (id, a) => { approved = a; return { id, phone: PHONE, status: "running", posts: [] }; } };
  const db2 = baseDb({ getPostingCampaign: async () => ({ id: "c1", phone: PHONE, status: "awaiting_approval" }) });
  await call(makeApp({ db: db2, campaigns: camp2 }), "POST", "/api/posting/campaigns/c1/approve", { mode: "standing", standing: { days: 9999, max_posts: 100000 } });
  assert.equal(approved.standing.days, 30);
  assert.equal(approved.standing.max_posts, 100);

  // ── stop is owner-only, and another phone's campaign reads as missing ──
  const db3 = baseDb({ getPostingCampaign: async () => ({ id: "c1", phone: PHONE, status: "running", posts: [] }) });
  const stopped = await call(makeApp({ db: db3, campaigns: { stop: async (id) => ({ id, phone: PHONE, status: "stopped", posts: [] }) } }), "POST", "/api/posting/campaigns/c1/stop");
  assert.equal(stopped.status, 200); assert.equal(stopped.body.campaign.status, "stopped");
  const stolen = await call(makeApp({ phone: "0509999999", db: db3, campaigns: { stop: async () => { throw new Error("must not"); } } }), "POST", "/api/posting/campaigns/c1/stop");
  assert.equal(stolen.status, 404);

  // ── no browser secret in any response, ever ──
  const leaky = { id: "c1", phone: PHONE, status: "running", posts: [{ id: "p", copy: "x", status: "posted" }], page_snapshot: {}, view_url: "https://viewer.driver.dev?ws=wss://x", cdpUrl: "wss://x" };
  const get = await call(makeApp({ db: baseDb({ getPostingCampaign: async () => leaky }) }), "GET", "/api/posting/campaigns/c1");
  assert.equal(get.status, 200);
  assert.ok(!get.raw.includes("wss://") && !get.raw.includes("viewer.driver.dev"), "response scrubbed");

  console.log("routes/posting.test.js ok");
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node routes/posting.test.js`
Expected: FAIL with `Cannot find module './posting'`

- [ ] **Step 3: Write the router**

Create `server/routes/posting.js`:

```js
/*
 * routes/posting.js — an agent's permission to post, and the ledger of what
 * was done with it.
 *
 * Three gates on create, all server-side: the agent's browser profile must be
 * connected; the page must be theirs; every group must be in the catalog and
 * not agent_policy:"forbidden". "unknown" groups are allowed only because the
 * agent listed them by url — that is what `explicit` records.
 */
const express = require("express");
const campaignsLive = require("../posting-campaign");
const dbLive = require("../db");

const PUBLIC_FIELDS = ["id", "page_id", "page_url", "title", "mode", "standing", "groups", "status", "halt_reason", "next_at", "posts", "consecutive_failures", "created_at", "updated_at"];
function publicView(c) {
  if (!c) return null;
  const out = {};
  for (const k of PUBLIC_FIELDS) if (k in c) out[k] = c[k];
  return out;
}
const clampStanding = (s) => ({
  days: Math.min(Math.max(Number(s && s.days) || 7, 1), 30),
  max_posts: Math.min(Math.max(Number(s && s.max_posts) || 10, 1), 100),
});

module.exports = function createPostingRouter(ctx) {
  const { requireAuth, authSecret } = ctx;
  const db = ctx.db || dbLive;
  const campaigns = ctx.campaigns || campaignsLive;
  const deps = ctx.deps || Object.assign(campaignsLive.liveDeps(), { db });
  const router = express.Router();

  async function owned(req, res) {
    const c = await db.getPostingCampaign(String(req.params.id)).catch(() => null);
    if (!c || c.phone !== req.user.userId) { res.status(404).json({ error: "not_found" }); return null; }
    return c;
  }

  router.post("/campaigns", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    const b = req.body || {};
    const urls = Array.isArray(b.group_urls) ? b.group_urls.map(String).filter(Boolean) : [];
    if (!b.page_id || !urls.length || !["per_post", "standing"].includes(b.mode)) return res.status(400).json({ error: "invalid_input" });

    const conn = (await db.getConnection(phone)) || {};
    if (!conn.facebook_browser_connected_at) return res.status(409).json({ error: "facebook_not_connected" });
    const page = await db.getPage(String(b.page_id)).catch(() => null);
    if (!page || page.business_phone !== phone) return res.status(404).json({ error: "not_found" });

    const catalog = await db.listGroupCatalog();
    const byUrl = new Map(catalog.map((g) => [g.url, g]));
    const groups = urls.map((u) => { const g = byUrl.get(u) || { url: u, name: "", agent_policy: "unknown" }; return { url: g.url, name: g.name || "", agent_policy: g.agent_policy || "unknown", explicit: true }; });
    const forbidden = groups.filter((g) => g.agent_policy === "forbidden");
    if (forbidden.length) return res.status(422).json({ error: "forbidden_group", groups: forbidden.map((g) => g.url) });

    const c = await campaigns.create({ phone, page, pageUrl: page.url || page.page_url || "", groups, mode: b.mode, standing: b.mode === "standing" ? clampStanding(b.standing) : null }, deps);
    return res.status(201).json({ campaign: publicView(c) });
  });

  router.post("/campaigns/:id/approve", requireAuth(authSecret), async (req, res) => {
    if (!(await owned(req, res))) return;
    const b = req.body || {};
    const mode = b.mode === "per_post" ? "per_post" : "standing";
    const c = await campaigns.approve(req.params.id, { mode, standing: mode === "standing" ? clampStanding(b.standing) : null }, deps);
    return res.json({ campaign: publicView(c) });
  });

  router.post("/campaigns/:id/posts/:post_id/approve", requireAuth(authSecret), async (req, res) => {
    if (!(await owned(req, res))) return;
    return res.json({ campaign: publicView(await campaigns.approvePost(req.params.id, String(req.params.post_id), deps)) });
  });

  for (const [action, fn] of [["pause", "pause"], ["resume", "resume"], ["stop", "stop"], ["acknowledge-halt", "acknowledgeHalt"]]) {
    router.post(`/campaigns/:id/${action}`, requireAuth(authSecret), async (req, res) => {
      if (!(await owned(req, res))) return;
      return res.json({ campaign: publicView(await campaigns[fn](req.params.id, deps)) });
    });
  }

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
```

- [ ] **Step 4: Mount and start the sweeper**

In `server/index.js`, inside the existing `if (process.env.DRIVER_API_KEY)` block from Task 7:

```js
  const posting = require("./posting-campaign");
  posting.startSweeper(posting.liveDeps());
  console.log("driver: posting sweeper started");
```

and with the other router mounts:

```js
const createPostingRouter = require("./routes/posting");
app.use("/api/posting", createPostingRouter({ requireAuth, authSecret: AUTH_SECRET }));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && node routes/posting.test.js`
Expected: PASS.

- [ ] **Step 6: Add to the test chain and commit**

Append ` && node routes/posting.test.js` to `scripts.test`.

```bash
cd server && npm test
git add server/routes/posting.js server/routes/posting.test.js server/index.js server/package.json
git commit -m "feat(posting): campaign API with ownership and group-policy gates"
```

---

### Task 17: The campaign card in the dashboard

The agent sees a timeline, never a browser. What they need to understand at a glance: which groups, under which permission, what happens next, and how to stop.

**Files:**
- Modify: `public-agent/distribution.html` (a new card after `groupsCard`)
- Modify: `public-agent/distribution.js`
- Modify: `public-agent/app.css`
- Modify: `public-agent/form-i18n.js`

**Interfaces:**
- Consumes: `GET/POST /api/posting/campaigns…`, the page's selected groups already loaded by `distribution.js` (`state.selected_groups` or the equivalent that file keeps), `GET /api/connections/browser/facebook/status`.
- Produces: `#campaignCard`, `#campaignTimeline`, `#campaignStopBtn`.

- [ ] **Step 1: Add the Hebrew strings**

In `public-agent/form-i18n.js` `"he"` map (and translate into each other map):

```
"camp_title":"פרסום אוטומטי בקבוצות",
"camp_intro":"פורלי תפרסם את הנכס בקבוצות שבחרתם, בקצב איטי ומדורג — כמה פוסטים ביום, בשעות היום, לא בשבת — כדי לא לעורר חשד. הפרסום נעשה מדפדפן ברקע; אתם רואים כאן מה קרה ומה מתוכנן.",
"camp_need_connect":"כדי לפרסם צריך קודם לחבר את חשבון הפייסבוק שלכם למעלה.",
"camp_mode_label":"איך לאשר?",
"camp_mode_per_post":"לאשר כל פוסט בנפרד",
"camp_mode_per_post_hint":"לפני כל פוסט תקבלו הודעת וואטסאפ עם הטקסט המדויק והקבוצה. בלי אישור שלכם — לא מפרסמים.",
"camp_mode_standing":"לפרסם עד שאעצור",
"camp_mode_standing_hint":"אישור אחד לכל הקמפיין, בגבולות שתקבעו. אפשר לעצור בכל רגע בלחיצה אחת.",
"camp_standing_days":"למשך",
"camp_standing_max":"עד",
"camp_standing_posts":"פוסטים",
"camp_days_7":"שבוע","camp_days_14":"שבועיים","camp_days_30":"חודש",
"camp_groups_n":"קבוצות נבחרות",
"camp_groups_unknown_warn":"בקבוצות המסומנות ב-? לא ידוע אם מתווכים מורשים לפרסם. אתם בוחרים לכלול אותן.",
"camp_start":"התחלת פרסום",
"camp_starting":"מתחילים…",
"camp_stop":"עצירה",
"camp_stop_confirm":"לעצור את הפרסום? פוסטים שכבר פורסמו נשארים. אפשר להתחיל קמפיין חדש בכל זמן.",
"camp_pause":"השהיה","camp_resume":"המשך",
"camp_next":"הפוסט הבא:",
"camp_next_none":"אין פוסט מתוכנן כרגע — נמתין לחלון הבא.",
"camp_waiting_approval":"ממתין לאישור שלכם",
"camp_approve_post":"אישור ופרסום",
"camp_status_running":"פעיל","camp_status_paused":"מושהה","camp_status_stopped":"נעצר","camp_status_completed":"הושלם","camp_status_halted":"נעצר — נדרשת התערבות",
"camp_halt_checkpoint":"פייסבוק ביקשה אימות. פתחו את הדפדפן, השלימו את האימות, ואז לחצו \"טיפלתי\". נחכה יומיים לפני שנמשיך, ליתר ביטחון.",
"camp_halt_rate_limited":"פייסבוק הגבילה זמנית את הפרסום מהחשבון. נמתין יומיים ונמשיך לאט יותר. לא צריך לעשות כלום.",
"camp_halt_login_required":"החיבור לפייסבוק פג. חברו את החשבון מחדש למעלה ואז לחצו \"טיפלתי\".",
"camp_halt_failures":"כמה פוסטים ברצף לא הצליחו. בדקו את הקבוצות ולחצו \"המשך\".",
"camp_halt_ack":"טיפלתי",
"camp_post_posted":"פורסם","camp_post_scheduled":"מתוכנן","camp_post_skipped":"דולג","camp_post_failed":"נכשל","camp_post_posting":"מפרסמים עכשיו…",
"camp_skip_not_member":"אינכם חברים בקבוצה","camp_skip_group_blocked":"הקבוצה לא מאפשרת פרסום",
"camp_err_forbidden_group":"אחת הקבוצות אוסרת פרסום של מתווכים — הסירו אותה מהבחירה",
"camp_err_generic":"לא הצלחנו להתחיל את הקמפיין — נסו שוב",
"camp_consent":"אני מבין/ה שפרסום אוטומטי מחשבון אישי נוגד את תנאי השימוש של פייסבוק ועלול להוביל להגבלת החשבון, ומאשר/ת זאת על אחריותי.",
```

- [ ] **Step 2: Add the card markup**

In `public-agent/distribution.html`, after the `groupsCard` div:

```html
  <div class="card dist-card" id="campaignCard" hidden>
    <h2 data-i18n="camp_title"></h2>
    <p class="muted" data-i18n="camp_intro"></p>
    <p class="warn" id="campNeedConnect" data-i18n="camp_need_connect" hidden></p>

    <div id="campSetup">
      <p class="muted"><span id="campGroupsCount">0</span> <span data-i18n="camp_groups_n"></span></p>
      <p class="muted small" id="campUnknownWarn" data-i18n="camp_groups_unknown_warn" hidden></p>

      <fieldset class="camp-mode">
        <legend data-i18n="camp_mode_label"></legend>
        <label class="camp-opt"><input type="radio" name="campMode" value="per_post" checked>
          <span><strong data-i18n="camp_mode_per_post"></strong><small data-i18n="camp_mode_per_post_hint"></small></span></label>
        <label class="camp-opt"><input type="radio" name="campMode" value="standing">
          <span><strong data-i18n="camp_mode_standing"></strong><small data-i18n="camp_mode_standing_hint"></small></span></label>
      </fieldset>

      <div class="camp-bounds" id="campBounds" hidden>
        <label><span data-i18n="camp_standing_days"></span>
          <select id="campDays"><option value="7" data-i18n="camp_days_7"></option><option value="14" selected data-i18n="camp_days_14"></option><option value="30" data-i18n="camp_days_30"></option></select></label>
        <label><span data-i18n="camp_standing_max"></span>
          <select id="campMax"><option>5</option><option selected>10</option><option>20</option><option>40</option></select>
          <span data-i18n="camp_standing_posts"></span></label>
      </div>

      <label class="camp-consent"><input type="checkbox" id="campConsent"> <span data-i18n="camp_consent"></span></label>
      <button class="btn btn-gold" id="campStartBtn" data-i18n="camp_start" disabled></button>
    </div>

    <div id="campLive" hidden>
      <div class="camp-head">
        <span class="conn-chip" id="campStatusChip"></span>
        <span class="muted" id="campNext"></span>
        <span class="camp-actions">
          <button class="btn btn-ghost" id="campPauseBtn" data-i18n="camp_pause"></button>
          <button class="btn btn-danger" id="campStopBtn" data-i18n="camp_stop"></button>
        </span>
      </div>
      <div class="camp-halt" id="campHalt" hidden>
        <p id="campHaltMsg"></p>
        <button class="btn btn-gold" id="campHaltBrowserBtn" data-i18n="conn_browser_open"></button>
        <button class="btn btn-ghost" id="campHaltAckBtn" data-i18n="camp_halt_ack"></button>
      </div>
      <ol class="camp-timeline" id="campaignTimeline"></ol>
    </div>
  </div>
```

- [ ] **Step 3: Add the styles**

Append to `public-agent/app.css`:

```css
/* Campaign card: one glance = groups, permission, what's next, how to stop. */
.camp-mode { border: 1px solid var(--line, #2a2d36); border-radius: 12px; padding: 10px 14px; margin: 12px 0; }
.camp-opt { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; cursor: pointer; }
.camp-opt small { display: block; color: var(--muted, #9aa0a6); margin-top: 2px; line-height: 1.5; }
.camp-bounds { display: flex; gap: 16px; flex-wrap: wrap; margin: 8px 0 12px; }
.camp-consent { display: flex; gap: 8px; align-items: flex-start; font-size: .9rem; color: var(--muted, #9aa0a6); margin: 12px 0; line-height: 1.5; }
.camp-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.camp-actions { margin-inline-start: auto; display: flex; gap: 8px; }
.btn-danger { background: #b3261e; color: #fff; }
.camp-halt { border: 1px solid #e0b341; border-radius: 12px; padding: 12px 14px; margin: 10px 0; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.camp-halt p { flex: 1 1 100%; margin: 0 0 6px; line-height: 1.6; }
.camp-timeline { list-style: none; padding: 0; margin: 0; }
.camp-timeline li { display: grid; grid-template-columns: 90px 1fr auto; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line, #2a2d36); align-items: center; }
.camp-timeline .when { color: var(--muted, #9aa0a6); font-variant-numeric: tabular-nums; }
.camp-timeline .st-posted { color: #4caf7d; } .camp-timeline .st-failed { color: #e57373; } .camp-timeline .st-skipped { color: var(--muted, #9aa0a6); }
.camp-timeline details { grid-column: 1 / -1; } .camp-timeline pre { white-space: pre-wrap; font: inherit; background: rgba(255,255,255,.04); padding: 8px; border-radius: 8px; }
@media (max-width: 640px) { .camp-timeline li { grid-template-columns: 1fr; } .camp-actions { margin-inline-start: 0; width: 100%; } .camp-actions .btn { flex: 1; } }
```

- [ ] **Step 4: Wire it**

Append to `public-agent/distribution.js`:

```js
// ── automatic group posting ──
(function () {
  var card = $("campaignCard"); if (!card) return;
  var current = null, pollTimer = null;
  var pageId = state.page_id; // the page this distribution view is for
  var fmt = function (iso) { if (!iso) return ""; var d = new Date(iso); return d.toLocaleString("he-IL", { weekday: "short", hour: "2-digit", minute: "2-digit", day: "numeric", month: "numeric" }); };
  var post = function (path, body) {
    return fetch(path, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); });
  };

  function selectedGroups() { return (state.selected_groups || []).map(function (g) { return typeof g === "string" ? g : g.url; }); }
  function refreshSetup() {
    var urls = selectedGroups();
    $("campGroupsCount").textContent = urls.length;
    var unknown = (state.groups || []).some(function (g) { return urls.indexOf(g.url) >= 0 && g.agent_policy === "unknown"; });
    $("campUnknownWarn").hidden = !unknown;
    $("campStartBtn").disabled = !(urls.length && $("campConsent").checked && state.fbBrowserConnected);
    $("campNeedConnect").hidden = !!state.fbBrowserConnected;
  }
  document.querySelectorAll('input[name="campMode"]').forEach(function (r) {
    r.addEventListener("change", function () { $("campBounds").hidden = this.value !== "standing"; });
  });
  $("campConsent").addEventListener("change", refreshSetup);

  $("campStartBtn").addEventListener("click", function () {
    var btn = this; btn.disabled = true; btn.textContent = FT("camp_starting");
    var mode = document.querySelector('input[name="campMode"]:checked').value;
    var body = { page_id: pageId, group_urls: selectedGroups(), mode: mode };
    if (mode === "standing") body.standing = { days: Number($("campDays").value), max_posts: Number($("campMax").value) };
    post("/api/posting/campaigns", body).then(function (res) {
      if (!res.ok) { FLY.toast(FT(res.body.error === "forbidden_group" ? "camp_err_forbidden_group" : "camp_err_generic")); return; }
      return post("/api/posting/campaigns/" + res.body.campaign.id + "/approve", { mode: mode, standing: body.standing });
    }).then(function (res) { if (res && res.ok) show(res.body.campaign); })
      .catch(function () { FLY.toast(FT("camp_err_generic")); })
      .then(function () { btn.textContent = FT("camp_start"); refreshSetup(); });
  });

  function show(c) {
    current = c;
    var live = c && ["running", "paused", "halted"].indexOf(c.status) >= 0;
    $("campSetup").hidden = !!live; $("campLive").hidden = !live;
    if (!live) { clearInterval(pollTimer); pollTimer = null; return; }
    $("campStatusChip").textContent = FT("camp_status_" + c.status);
    var next = (c.posts || []).filter(function (p) { return p.status === "scheduled" || p.status === "pending_approval"; })[0];
    $("campNext").textContent = next ? FT("camp_next") + " " + fmt(next.scheduled_at) + " · " + (next.group_name || next.group_url) : FT("camp_next_none");
    $("campPauseBtn").textContent = FT(c.status === "paused" ? "camp_resume" : "camp_pause");
    $("campPauseBtn").hidden = c.status === "halted";
    var halt = $("campHalt"); halt.hidden = c.status !== "halted" && !(c.status === "paused" && c.halt_reason === "consecutive_failures");
    if (!halt.hidden) {
      var key = c.halt_reason === "consecutive_failures" ? "camp_halt_failures" : ("camp_halt_" + c.halt_reason);
      $("campHaltMsg").textContent = FT(key) || FT("camp_halt_failures");
      $("campHaltBrowserBtn").hidden = !(c.halt_reason === "checkpoint" || c.halt_reason === "login_required");
    }
    var ol = $("campaignTimeline"); ol.innerHTML = "";
    (c.posts || []).slice().reverse().forEach(function (p) {
      var li = document.createElement("li");
      var st = p.status === "skipped" ? FT("camp_skip_" + p.error_code) || FT("camp_post_skipped") : FT("camp_post_" + (p.status === "pending_approval" ? "scheduled" : p.status));
      li.innerHTML = '<span class="when">' + fmt(p.posted_at || p.scheduled_at) + '</span><span>' + (p.group_name || p.group_url) + '</span><span class="st-' + p.status + '">' + st + '</span>';
      if (p.status === "pending_approval") {
        var b = document.createElement("button"); b.className = "btn btn-gold"; b.textContent = FT("camp_approve_post");
        b.addEventListener("click", function () { post("/api/posting/campaigns/" + c.id + "/posts/" + p.id + "/approve").then(function (r) { if (r.ok) show(r.body.campaign); }); });
        li.appendChild(b);
      }
      var d = document.createElement("details"); d.innerHTML = "<summary>" + FT("ext_show_all") + "</summary><pre></pre>"; d.querySelector("pre").textContent = p.copy || "";
      li.appendChild(d); ol.appendChild(li);
    });
    if (!pollTimer) pollTimer = setInterval(reload, 30000);
  }
  function reload() {
    if (!current) return;
    fetch("/api/posting/campaigns/" + current.id, { credentials: "include" }).then(function (r) { return r.json(); }).then(function (j) { if (j.campaign) show(j.campaign); }).catch(function () {});
  }
  $("campPauseBtn").addEventListener("click", function () {
    post("/api/posting/campaigns/" + current.id + "/" + (current.status === "paused" ? "resume" : "pause")).then(function (r) { if (r.ok) show(r.body.campaign); });
  });
  $("campStopBtn").addEventListener("click", function () {
    if (!confirm(FT("camp_stop_confirm"))) return;
    post("/api/posting/campaigns/" + current.id + "/stop").then(function (r) { if (r.ok) { show(r.body.campaign); FLY.toast(FT("camp_status_stopped")); } });
  });
  $("campHaltAckBtn").addEventListener("click", function () {
    var path = current.status === "halted" ? "acknowledge-halt" : "resume";
    post("/api/posting/campaigns/" + current.id + "/" + path).then(function (r) { if (r.ok) show(r.body.campaign); });
  });
  // The embedded browser (Task 11) is the fix for a checkpoint: same button, same modal.
  $("campHaltBrowserBtn").addEventListener("click", function () { $("browserPlatform").value = "facebook"; $("browserConnectBtn").click(); });

  // Boot: is the browser connected, is there a live campaign for this page?
  fetch("/api/connections/browser/facebook/status", { credentials: "include" }).then(function (r) { return r.json(); })
    .then(function (j) { state.fbBrowserConnected = j.state === "connected"; refreshSetup(); }).catch(refreshSetup);
  fetch("/api/posting/campaigns?page_id=" + encodeURIComponent(pageId), { credentials: "include" }).then(function (r) { return r.json(); })
    .then(function (j) { var live = (j.campaigns || []).filter(function (c) { return ["running", "paused", "halted"].indexOf(c.status) >= 0; })[0]; if (live) show(live); })
    .catch(function () {});
  card.hidden = false;
  refreshSetup();
})();
```

`state.page_id`, `state.selected_groups` and `state.groups` are whatever names `distribution.js` already uses for the current page and its group selection — read that file's `state` object and use its real field names; do not add a parallel copy.

- [ ] **Step 5: Verify by hand**

```bash
cd server && DRIVER_API_KEY=$DRIVER_API_KEY npm run local
```

Open the distribution page for a test property with the test account connected (Task 11). Walk it as a first-time agent would, and check each of these reads without explanation:

1. Before connecting Facebook: the card shows the "connect first" line and the start button is disabled.
2. Consent unticked → start disabled. Tick → enabled.
3. "לאשר כל פוסט בנפרד" is the default. Choosing "לפרסם עד שאעצור" reveals the bounds (duration, max posts).
4. Start → the card flips to the live view with a status chip, "הפוסט הבא: …", a red STOP.
5. STOP → confirm → chip reads "נעצר", timeline stays, setup returns.
6. Simulate a halt (set `status:"halted", halt_reason:"checkpoint"` on the campaign doc): the amber box explains what happened and offers the browser button, which opens Task 11's modal on Facebook.

- [ ] **Step 6: Commit**

```bash
git add public-agent/distribution.html public-agent/distribution.js public-agent/app.css public-agent/form-i18n.js
git commit -m "feat(posting): campaign card with per-post and standing approval, timeline and stop"
```

---

### Task 18: Calibration — the first real post, then two days unattended

Everything in Phase 3 up to here is unit-tested against fakes. This task is where the plan's [Unverified] claims become measurements. **Use only a test Facebook account and test groups that account owns.** Never an agent's real account for this.

**Files:**
- Create: `scripts/posting-calibrate.local.js`
- Modify: `docs/superpowers/plans/2026-09-22-driver-spike-findings.md`

- [ ] **Step 1: Write the calibration script**

Create `scripts/posting-calibrate.local.js`:

```js
/*
 * scripts/posting-calibrate.local.js — the first real posts, watched closely.
 *
 *   DRIVER_API_KEY=… node scripts/posting-calibrate.local.js <profile-name> <group-url> [--live]
 *
 * Without --live: a DRY RUN — opens the group, opens the composer, types the
 * copy, stops before submit. Confirms the selectors in posting-driver.js
 * match the real page. Run this until it passes cleanly.
 * With --live: ONE real post, then verifies it is in the feed.
 */
const { postToGroup, SELECTORS } = require("../server/posting-driver");
const { buildPostCopy, trackedUrl } = require("../server/distribution/share-kit");

const [profileName, groupUrl] = process.argv.slice(2);
const live = process.argv.includes("--live");

(async () => {
  if (!profileName || !groupUrl) { console.error("usage: <profile-name> <group-url> [--live]"); process.exit(2); }
  const page = { title: "בדיקת מערכת — נא להתעלם", property: { city: "תל אביב", rooms: 3, price: 1 }, agent: { name: "בדיקה" } };
  const url = trackedUrl("https://forly.example/test", { session: "calib", group: groupUrl });
  const copy = buildPostCopy(page, url, { variantSeed: "calib" + groupUrl });
  console.log(`mode=${live ? "LIVE" : "dry run"} selectors=${JSON.stringify(Object.keys(SELECTORS))}`);
  console.log("copy:\n" + copy + "\n");
  const t0 = Date.now();
  try {
    const out = await postToGroup({ groupUrl, copy, profileName, dryRun: !live, campaignId: "calib" });
    console.log(`OK in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, out);
    process.exit(0);
  } catch (e) {
    console.error(`FAIL ${e.code || ""}: ${e.message}`);
    process.exit(1);
  }
})();
```

- [ ] **Step 2: Dry run until the selectors are right**

```bash
cd /home/user/forly-backend
DRIVER_API_KEY=$DRIVER_API_KEY node scripts/posting-calibrate.local.js "facebook-<test-phone>" "https://www.facebook.com/groups/<your-test-group>"
```

Expected: `OK … dry_run: true`. On `composer_not_found`, open the same group in the embedded browser (Task 11), inspect the composer, and fix `SELECTORS` in `server/posting-driver.js` — that is the only file to touch. Repeat until three consecutive dry runs pass.

- [ ] **Step 3: One live post**

```bash
DRIVER_API_KEY=$DRIVER_API_KEY node scripts/posting-calibrate.local.js "facebook-<test-phone>" "https://www.facebook.com/groups/<your-test-group>" --live
```

Expected: `OK … dry_run: false`, and the post is visible in the group when you look with a normal browser, with the link card attached. If it reports `not_verified` but the post *is* there, fix `SELECTORS.feedPostText`; a false negative here would make the campaign count a success as a failure and trip the breaker for nothing.

- [ ] **Step 4: Two days unattended**

Create a `standing` campaign from the dashboard for the test property with two test groups, 7 days, 6 posts. Leave it. After 48 hours, pull the ledger and check every invariant the plan promised:

```bash
cd server && node -e '
const db = require("./db"); db.init();
(async () => {
  const c = (await db.listPostingCampaignsByPhone(process.argv[1]))[0];
  const posted = c.posts.filter(p => p.status === "posted").map(p => new Date(p.posted_at)).sort((a,b)=>a-b);
  const S = require("./posting-safety");
  let ok = true;
  for (let i = 1; i < posted.length; i++) { const gap = (posted[i]-posted[i-1])/60000; if (gap < S.DEFAULTS.min_gap_minutes) { console.error("GAP VIOLATION", gap); ok = false; } }
  for (const d of posted) if (!S.isActiveTime(d, S.DEFAULTS)) { console.error("OUTSIDE ACTIVE HOURS", d.toISOString()); ok = false; }
  console.log(`${posted.length} posts, status=${c.status}, halt=${c.halt_reason}`); process.exit(ok ? 0 : 1);
})();' "<test-phone>"
```

Expected: exit 0, no violations, status `running` or `completed`, `halt_reason` null. Also open the test account in a normal browser: no warning banners, no "unusual activity" notice.

- [ ] **Step 5: Record what was measured**

Append to `docs/superpowers/plans/2026-09-22-driver-spike-findings.md`:

```
## Posting calibration (<date>)

- selectors changed from the plan's defaults: <yes: which | no>
- dry runs to a clean pass: <n>
- live post verified in feed: <yes|no>; time to post: <s>
- 48h standing run: <n> posts, <n> skipped, halt: <none|reason>; account warnings seen: <none|describe>
- DEFAULTS kept as-is / changed to: <values>
```

If the 48h run produced any platform signal, **lower** the caps and lengthen the gaps before letting a real agent near this — never the reverse.

- [ ] **Step 6: Commit and push**

```bash
cd server && npm test
cd .. && git add scripts/posting-calibrate.local.js docs/superpowers/plans/2026-09-22-driver-spike-findings.md server/posting-driver.js
git commit -m "test(posting): calibration script and measured pacing defaults"
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
- A campaign in `standing` mode posts to two test groups across two days without ever violating a `posting-safety` invariant (Task 18's ledger shows every gap ≥ the configured minimum, none outside active hours, none on Shabbat).
- Pressing STOP on a running campaign cancels the next post before it starts (Task 16 test + Task 17 by hand).
- A simulated checkpoint page halts the account and surfaces the embedded browser as the fix (Task 15 test + Task 17 by hand).
- No posting session ever returned a `view_url` (Task 16 test).

## Deferred, on purpose

- **Publish-out to Yad2 / Madlan.** Phase 3 posts to Facebook groups only. Yad2 and Madlan are structured listing forms with their own accounts, photo uploads and paid tiers — a separate spec each.
- **Account-wide bulk sweep** (walking an agent's whole Yad2 office page or Madlan profile) — needs pagination, dedup and a different job shape.
- **Browser pools.** They would cut the ~20s session start, but they hold warm browsers against an account-wide cap, and the docs say not to create one unasked. Revisit only if start latency becomes the complaint.
- **`captchaSolver`.** Off by default; it costs credits. Turn it on per-host, with evidence, after the `hosted_privacy` rung has been seen to fail.
