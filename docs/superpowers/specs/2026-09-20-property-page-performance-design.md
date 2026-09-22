# Property Page Performance — Design

Date: 2026-09-20
Status: Approved for implementation, Package A first

## Problem

Property pages are reported slow. No baseline existed at the start of this work.

### What was measured

A static, code-level audit of `public-nadlan/templates/` (all 8 templates) and the
`server/` read path. Findings below are read off the code and are reproducible.

### Baseline (measured 2026-09-22)

A Lighthouse run against a real listing on `http://127.0.0.1:8787` (orbite
template) produced the first usable numbers. They supersede the static audit
wherever the two disagree:

| Metric | Value |
|---|---|
| Page weight | **38.6 MB** |
| LCP | **66.3 s** (LCP element: the hero `<video>`) |
| CLS | **0** |
| TBT | **0 ms** |
| Render-blocking | **2,407 ms** (FCP savings 2,400 ms) |
| Text compression | absent — 61,911 of the document's 92,897 bytes recoverable |
| Image delivery | ~6,102 KiB recoverable (format + right-sizing) |

Composition: one 25.9 MB hero walkthrough plus ~13.2 MB of images. The
render-blocking total breaks down as Google Fonts CSS 829 ms, `/tpl/runtime.js`
756 ms, `/templates/i18n.js` 756 ms, `/tpl/demo.js` 154 ms.

The report's "unused JavaScript — 109 KiB" finding is entirely a Loom browser
extension (`liecbddmkiiihnedobmlmillhodjkdmb`) present in the profile. It is not
this application's code and is not actionable.

An earlier run against `https://dev.srv1173890.hstgr.cloud/...` returned `NO_FCP`
for every audit and carried zero performance data; it was discarded, not used as
a baseline. The dev host is unreachable from the agent sandbox (network policy
denies CONNECT), so nothing has been verified against it independently.

### Corrections this baseline forced

- **"Defer non-critical scripts — not render-blocking" was wrong.** That row has
  been removed from the out-of-scope table. The claim was that scripts at the end
  of `<body>` cannot block first paint. Lighthouse measures 2,407 ms of
  render-blocking and three of the four contributors are those scripts: a
  synchronous `<script src>` blocks the parser wherever it sits, and the browser
  does not even *discover* an end-of-body script until it has parsed everything
  above it. Position in the document changes when the block starts, not whether
  there is one.
- **The CLS claim holds.** An earlier draft called missing `width`/`height` "a
  direct CLS cost"; that was withdrawn as unsupported, and the run confirms CLS
  is exactly 0.
- **The minification claim holds.** Headroom is 14 KiB CSS + 29 KiB JS, which is
  as marginal as Package C assumed.

## Scope

Three packages, one spec. Implementation order: A, then B, then C.

### Out of scope, with reasons

These were requested but do not apply to this architecture. Implementing them
would add complexity with no measurable benefit:

| Item | Why not |
|---|---|
| Add a CDN | Firebase Hosting already serves through Google's CDN. |
| Add a load balancer | Single container. This is a hosting decision (Cloud Run autoscaling), not application code. |
| DB connection pooling | Firestore is a managed HTTP/gRPC service. There is no connection pool to size. |
| Code splitting | No bundler. Plain `<script>` tags; the largest app file is 32KB. |
| Paginate large lists | Every Firestore query in `db.js` already carries a `.limit()`. |
| Cache API responses | Both public endpoints already set `Cache-Control: public, max-age=60`. |

---

## Package A — Backend hot path

Every property page view hits `GET /api/property-by-slug`
(`server/routes/pages.js:674-710`), which currently performs four **sequential**
Firestore operations:

```
1. db.getPortfolioSlugReservation(slug)        1 read
2. db.getBusiness(phone)                       1 read, bypasses businessCache
3. db.listPagesByPhone(phone, 100)             up to 100 reads, then .find() in JS
4. resolveChatbot(page) -> businessCache.get() same business doc, second fetch
```

Worst case ~102 document reads to serve a page that needs 3. Firestore bills per
document read, so this is a cost multiplier on the busiest endpoint, not only a
latency problem. There are zero uses of `Promise.all` anywhere in `server/`.

### A1 — Replace over-fetch-then-filter with a scoped query

`server/routes/pages.js:688-689` fetches up to 100 page documents and locates one
in JavaScript:

```js
const pages = await db.listPagesByPhone(reservation.business_phone, 100);
const page = pages.find((p) => p.public_slug === propSlug);
```

Add `db.findPageBySlug(phone, publicSlug)` to `server/db.js`, alongside
`listPagesByPhone` (`db.js:489-496`), and call it here instead.

The query must stay scoped to the business — `public_slug` is only unique within
one agent's pages, so a global slug query could return another agent's property:

```js
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

The in-memory branch is required: `db.js` runs without Firestore (`db` null) and
`npm test` depends on that path.

**Fixes a latent bug.** The current code only searches the first 100 pages
returned in arbitrary order, so an agent with more than 100 pages gets a 404 on
properties outside that window. The scoped query has no such ceiling. The
server-rendered route at `/:portfolioSlug/:propertySlug` carried the
same scan and the same ceiling; it was migrated in a follow-up commit
after a whole-branch review caught it. The "at most 3 reads" figure below
describes the `/api/property-by-slug` endpoint alone — a full page view
also pays the SSR route's own reads.

**Index.** `firestore.indexes.json` currently declares one index, for
`conversations`. Firestore can serve multiple equality filters via zigzag merge
over single-field indexes, so this query may need no composite index — that is
[Unverified] and must be confirmed by running it. If Firestore returns
`FAILED_PRECONDITION`, the error carries an index-creation link; add the
resulting `property_pages (business_phone ASC, public_slug ASC)` entry to
`firestore.indexes.json` and deploy it.

### A2 — Stop double-fetching the business document, safely

`server/routes/pages.js:686` calls `db.getBusiness()` directly while line 82's
`resolveChatbot` reads the same document through `businessCache`. Route line 686
through `businessCache.get()` so the pair costs one read.

**This is unsafe without an invalidation fix.** `server/routes/dashboard.js`
writes business documents — including `portfolio` — at lines 117, 207, 250 and
263, and never calls `businessCache.invalidate()`. Only `admin.js:264` and
`distribution.js:349,385` do. Caching line 686 as-is would make an agent's
portfolio open/close toggle take up to the 60s TTL to appear on their pages.

So A2 is two changes, and the second is a precondition for the first:

1. Add `businessCache.invalidate(phone)` after each business write in
   `dashboard.js` (4 sites).
2. Change line 686 to `businessCache.get(reservation.business_phone)`.

Step 1 also improves existing behavior: `resolveChatbot` already reads through
the cache on this path, so chatbot config is *already* subject to this staleness
today.

### A3 — Parallelize the independent reads

After A1 and A2, steps 2 and 3 both depend only on `reservation.business_phone`
and not on each other. Run them concurrently:

```js
const [business, page] = await Promise.all([
  businessCache.get(reservation.business_phone),
  db.findPageBySlug(reservation.business_phone, propSlug),
]);
```

Step 1 must stay sequential (it produces the phone). Step 4 must stay sequential
(it consumes `page`), and after A2 it is a cache hit rather than a read.

### Resulting hot path

```
1. getPortfolioSlugReservation(slug)   1 read
2. businessCache.get(phone)     ─┐     1 read (cached ~60s)
3. findPageBySlug(phone, slug)  ─┘     1 read      (parallel)
4. resolveChatbot(page)                0 reads (cache hit)
```

Up to ~102 reads becomes at most 3, with two of them overlapped.

### Testing

- Existing suites must pass unchanged: `cd server && npm test` (pure unit tests,
  no network, exercises the in-memory `db.js` branch).
- Add coverage for `findPageBySlug`: match found, no match, and a page belonging
  to a different `business_phone` not being returned.
- Add a regression test that a property whose page sits outside the old 100-page
  window now resolves.
- Verify the portfolio toggle round-trip after A2: change portfolio status in the
  dashboard, confirm a property page reflects it immediately rather than after
  the TTL.

### Success criteria

- `/api/property-by-slug` performs at most 3 Firestore reads per uncached
  request, confirmed by instrumenting or logging reads in a local run.
- No behavior change to the endpoint's responses, including the 301 redirect on a
  renamed portfolio slug and the 404s for missing or inactive pages.
- Portfolio visibility changes appear on property pages without a TTL delay.

---

## Package B — Frontend media and layout

Rewritten 2026-09-22 against the measured baseline. Everything below is
implemented on this branch except where marked **Not done**.

### B1 — The hero video is the LCP element (25.9 MB, LCP 66.3 s)

`autoplay muted` makes the browser fetch the whole file regardless of the
`preload` attribute, so `preload="metadata"` bought nothing. The download was
both the LCP candidate and the thing starving every image on the page.

`runtime.js` now gives the hero a poster and withholds its `src` until the
visible page has loaded (`window.load`, with a 4 s timeout so one stalled image
cannot leave the hero permanently paused). LCP resolves against the poster
instead. Where the listing has no `hero.poster_url`, the first gallery photo is
used — a file the page is already fetching.

`data-video-manual` elements (click-to-play, `preload="metadata"`/`"none"`) keep
their `src` immediately: they cost a few KB and must stay clickable from first
paint.

Expected effect is on LCP and on bandwidth contention, not on page weight: the
video is still 25.9 MB, it just stops blocking. Cutting the weight itself needs
B4.

### B2 — Render-blocking, 2,407 ms

- The three page scripts are now `<link rel="preload" as="script">` in `<head>`.
  Preload rather than `defer`: five templates (`loupe`, `movie`, `nocturne`,
  `orbite`, `reel`) have an inline `<script>` *after* the external ones that
  reads `window.__PAGE__` and `window.I18N`. Deferred scripts run after inline
  ones, so `defer` would break those five. Preload moves the fetch without
  moving execution, which is the part that was costing time.
- The Google Fonts stylesheet (829 ms) is loaded as
  `rel="preload" as="style" onload="this.rel='stylesheet'"` with a `<noscript>`
  fallback, in the 6 templates that use it. The families already request
  `display=swap`; blocking first paint on the stylesheet that says "paint in the
  fallback" was self-defeating. `nocturne` and `original` self-host `@font-face`
  woff2 and were untouched.

### B3 — Logo: 849 KB fetched three times, one of them a CORS failure

`sampleLogoBackground` set `crossOrigin = "anonymous"` on its probe image. A
CORS-mode request is a separate HTTP cache entry from the two plain `<img>`
fetches, so it was always a third download — and against any host that does not
send `Access-Control-Allow-Origin` (every host but this one; `/files` is plain
`express.static` and `cors.json` covers neither these origins nor this header)
it failed outright and logged a CORS error on every page view.

The opt-in is removed. The probe now shares the cache entry, and the
cross-origin case lands in the existing tainted-canvas `catch`, which produces
exactly the "leave the template as authored" outcome the opt-in was meant to
protect.

**Not done:** the logo is still an 849 KB, 1035x1024 PNG displayed at 57x38 and
87x58. That is B4's problem.

### B4 — Image delivery, ~6,102 KiB recoverable — **Not done, needs a decision**

Agent uploads are written to disk by `server/index.js` and served verbatim by
`express.static`. There is no transcode step: no `sharp` dependency, and the one
piece of media tooling in the tree (`server/photo-vision.js`) shells out to an
`ffmpeg` binary via `FFMPEG_PATH`.

So right-sizing and WebP/AVIF is a pipeline to build, not a flag to set, and it
splits into choices that are not mine to make:

1. Transcode on upload (predictable cost, rewrites nothing already stored) or on
   request with a cache (handles the existing corpus, adds a hot path).
2. Where it runs — in the container next to `ffmpeg`, or off it.
3. Whether to backfill everything already uploaded.

Until one of those is chosen, ~13.2 MB of images stays ~13.2 MB.

### B5 — Withdrawn findings, kept for the record

- **Lazy loading was already done.** `runtime.js:387` and `original.js:66` both
  set `loading="lazy"` and `decoding="async"`. An earlier draft said otherwise.
- **The CLS claim was withdrawn, and the measurement agrees** — CLS is 0.
- **A loading skeleton is still unjustified.** TBT is 0 ms and the fix for the
  blank phase was B1, not a placeholder for it.

### B6 — Correctness findings from the same run

- `<meta name="description" content="">` shipped empty on all 8 templates —
  every template reserved the tag and nothing ever filled it. `runtime.js` now
  builds one from the listing.
- `orbite.html`: `role="button"` on a `<video>` is not an allowed role. Removed;
  `tabindex` and `aria-label` stay, so it is still focusable and named.
- `orbite.html`: the two `.peek-hole` buttons failed `label-content-name-mismatch`
  because their caption span is filled at runtime and then disagrees with the
  `aria-label`. The caption is decorative overlay text and is now
  `aria-hidden="true"`.
- **Not done — colour contrast 2.74 on `#8f3b52` over `#090a0f`.** This is
  `var(--accent, #8f3b52)`, i.e. an agent-configurable brand colour with a
  failing default. Changing it is a design decision, and it would not fix the
  agents who have set their own failing accent. The durable fix is to derive a
  readable on-dark variant from whatever accent is configured — a product change,
  not a cleanup.
- **Not done — a 137 ms forced reflow at `runtime.js:271`**, in the avatar
  sizing (`el.offsetHeight` read after style writes). TBT is 0 ms, so it is
  costing nothing measurable today.

## Package C — Cheap wins

- **Text compression — done.** The run measured `usesCompression: false` with
  61,911 of 92,897 document bytes recoverable. `compression` is now mounted in
  `server/index.js` above the static handlers, with `threshold: 1024`. This is
  the largest measured win per line changed in the whole spec.
- **Minify app JS/CSS — not done, still judged not worth a build step.** The run
  puts the headroom at 14 KiB CSS + 29 KiB JS, against introducing a bundler to a
  codebase that deliberately has none.

## Open questions

1. Whether the A1 query requires a composite index (see A1). Still unverified —
   it needs Firestore credentials and network the agent sandbox denies.
2. Which image pipeline to build (B4).
3. Whether the accent-contrast failure is fixed by changing the default or by
   deriving an on-dark variant (B6).
4. A re-run of Lighthouse against the same listing, to size what B1, B2 and C
   actually bought. Every number in this document below "Baseline" is a
   prediction until that run exists.

## Deferred findings from the whole-branch review

Real, deliberately not fixed on this branch. Each needs a decision rather than a
mechanical fix.

1. **`businessCache.get` swallows an error that `db.getBusiness` used to throw.**
   `business-cache.js` catches a failed fetch and returns the last cached value
   or `null`. Before A2, a transient Firestore error on the business read reached
   the handler's `catch` and produced a 500. Now the request returns **200 with
   `portfolio_url` silently absent**, and `Cache-Control: public, max-age=60`
   caches that degraded payload for a minute. Whether a quiet degrade beats a
   loud failure here is a product call, not a code cleanup.
2. **Two business writers still do not invalidate the cache.**
   `server/routes/intake.js` (the `demo-save-agent` handler) and
   `server/routes/profile.js` (two sites). Both are correct *today* — the fields
   they write are not read through the cache — but that holds only by inspection,
   and `profile.js` writes a whitelisted field set that someone will extend.
   Adding `invalidate()` at all three makes the invariant "every `setBusiness`
   invalidates", which is checkable with a single grep instead of an argument.
3. **`scripts/backfill-portfolios.js` batch-writes `businesses.portfolio` from a
   separate process.** An in-process cache cannot be invalidated across processes,
   so live servers serve stale portfolio state for up to the TTL after a backfill.
   Acceptable, but undocumented at the call site.
4. **`server/routes/pages.js` is 885 lines**, against the 500-line guideline in
   CLAUDE.md. Pre-existing; this branch added three lines net to it.

The first two both trace to the same root: the cache's contract — who must
invalidate it, and what it does on failure — is enforced by convention rather
than by the module itself.
