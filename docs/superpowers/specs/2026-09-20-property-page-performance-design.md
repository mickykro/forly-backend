# Property Page Performance — Design

Date: 2026-09-20
Status: Approved for implementation, Package A first

## Problem

Property pages are reported slow. No baseline existed at the start of this work.

### What was measured

A static, code-level audit of `public-nadlan/templates/` (all 8 templates) and the
`server/` read path. Findings below are read off the code and are reproducible.

### What was NOT measured

- **No Core Web Vitals baseline.** A Lighthouse run against
  `https://dev.srv1173890.hstgr.cloud/krvytvrv-nksym/property-sew` returned
  `NO_FCP` for every audit — the page never painted, so the report carries zero
  performance data. The report was produced by the DevTools panel
  (`channel: "devtools"`), whose known failure mode is a backgrounded tab; a
  genuinely hanging page produces the same error. The two causes cannot be
  distinguished from that report.
- The dev host is unreachable from the agent sandbox (network policy denies
  CONNECT), so this could not be verified independently.
- A PageSpeed Insights run is pending. Package B's sizing depends on it.
  Package A does not.

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
| Defer non-critical scripts | All 4 script tags in every template already sit at end of `<body>` (e.g. `nocturne.html:154-157`, after `</head>` at line 139). Not render-blocking. |
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
properties outside that window. The scoped query has no such ceiling.

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

Sizing depends on the pending PageSpeed Insights run. Findings so far:

- **Video dominates asset weight.** `tour.mp4` (5.8MB) and `tour1.mp4` (3.1MB)
  total 8.9MB against ~680KB for all JS, CSS, HTML and fonts combined. Both are
  demo assets, referenced only from `demo.js:7`. Real page weight depends on
  agent-uploaded video, which is not visible from the repo.
- 7 of 8 templates autoplay a hero video. `nocturne.html:145` uses
  `preload="auto"`; review whether `metadata` or `none` suffices.
- **Lazy loading is already done — no work here.** An earlier draft of this spec
  claimed gallery images were injected without it. That was wrong.
  `runtime.js:387` sets `im.loading = "lazy"; im.decoding = "async"` and
  `original.js:66` does the same. The one eager `createElement("img")`, at
  `runtime.js:282`, is the agent logo: a single above-the-fold image that should
  stay eager.
- **The CLS claim is withdrawn as unsupported.** An earlier draft called the
  absence of `width`/`height` attributes "a direct CLS cost". Those attributes
  matter when an image sizes its own box; here it does not. `.gallery-grid` sets
  `grid-auto-rows:115px` with explicit per-tile spans and
  `.gallery-grid img{width:100%;height:100%;object-fit:cover}`; `.room-image img`
  and `.area-image img` are pinned to `78vh`. Images fill pre-sized boxes.
  Whether CLS is actually a problem is now an open question for PSI to answer,
  not an established finding.
- A loading skeleton was requested. Nothing measured so far shows it is needed;
  decide once PSI reports actual LCP and whether the page has a blank phase.

Two of the four original Package B findings did not survive checking against the
code. That is the argument for measuring before implementing, and the reason
Package B stays gated on PSI rather than being built out now.

## Package C — Cheap wins

Low value but harmless, accepted knowingly:

- Minify app JS/CSS. Headroom is small: CSS totals 12KB; of 236KB JS, 136KB is
  vendor (gsap, lenis, ScrollTrigger) and already minified.
- Confirm gzip/brotli is applied to API responses.

## Open questions

1. PageSpeed Insights numbers for the dev property page — validates B, and
   confirms whether the `NO_FCP` was a tooling artifact or a real page failure.
2. Whether the A1 query requires a composite index (see A1).
3. Whether agents' uploaded hero videos are transcoded anywhere today, or served
   at original upload size. Determines how much of B's video work is client-side
   versus pipeline.
