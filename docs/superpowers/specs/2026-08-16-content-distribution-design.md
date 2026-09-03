# Content Distribution — Design (v2)

**Date:** 2026-08-16
**Status:** Approved by product owner (all design sections approved in session; implementation gated on separate plan approval)
**Repo:** forly-backend only. Approach A: Express server modules on the VPS.

## 1. Goal

When an agent's property content is ready (video, photos, structured data on a
generated property page), distribute it to:

1. **The agent's own Facebook Page** — automatic post via the official Meta Graph
   API (video post, or multi-photo post when no video exists).
2. **5+ Facebook groups** — via a WhatsApp **share kit**: ready-made post copy +
   one-tap share links to the agent's saved groups. (Meta removed the Groups
   publishing API in 2022; browser automation was rejected as a ban risk.)
3. **Instagram** (days 3–7) — feed/reel publish through the same Meta connection
   (`instagram_content_publish`, IG Business account linked to the Page).

**Explicitly out of scope this week** (product-owner decisions):
- Marketplace feeds (yad2 / madlan / keyz) — needs separate partner-program
  investigation; future project.
- Automatic Facebook post takedown on archive — posts stay up; the property
  page itself communicates unavailability.
- Browser automation of any kind.

## 2. Decisions (all confirmed by product owner in session)

| Topic | Decision |
|---|---|
| FB groups | Official API to Page + WhatsApp share kit for groups (1a) |
| Marketplaces | Deferred entirely — separate investigation first |
| Meta app | None exists; build works in Dev Mode day one; App Review documented |
| Trigger | Auto on page-ready, gated by one-tap WhatsApp confirm (4a) |
| Rollout | **Admin-gated per agent** — `features.distribution` toggle, off by default |
| Re-publish | Blocked with explicit confirm — agent may accept a deliberate repost ("1a but ask before reposting") |
| Takedown | None (2a) — archived listings just stop being promoted |
| Instagram | In scope, days 3–7 |
| Audit | **Every post action recorded in Firestore** (`post_actions`, append-only) |
| Architecture | Approach A: server modules + Firestore-backed job queue + in-process sweeper |

## 3. Architecture & data flow

```
property page goes live (routes/pages.js createPropertyPage)
   │  entitlement: features.distribution (live-resolved) under DISTRIBUTION_ENABLED kill-switch
   ▼
distributions/{id} created (awaiting_confirm) ── WhatsApp one-tap confirm link (signed action token)
   ▼  agent taps confirm (or dashboard "publish now")
job sweeper (60s tick, in-process, single-container; per-doc claim + idempotency)
   ├─ facebook_page target → Graph: POST /{page}/videos (file_url) | photos+feed (attached_media)
   ├─ instagram target (3–7) → Graph: media container → publish
   └─ share_kit target → WhatsApp: copy block + sharer link + agent's group links
   ▼
post_actions audit write (success AND failure) + WhatsApp result summary (post link)
```

**Double-post protection (layered):**
- A post id is persisted the moment Facebook accepts, before anything else runs.
- Every publish path (confirm link, dashboard, sweeper execution) checks
  page-wide for any distribution carrying a recorded post id — any status.
- Re-publish requires the agent's explicit confirmation; the server accepts it
  only with an explicit `force` flag.
- Timeout on the visible-post call is terminal, never retried.

**OG tags:** `/p/:id` server-renders Open Graph/Twitter meta tags (title,
description, poster image, video) for active pages in both serving branches —
Facebook/WhatsApp crawlers don't run JS, so shares currently preview blank; this
fix is a prerequisite for the whole feature and ships in the MVP.

## 4. Components

### Days 1–2 (MVP)
| Component | Responsibility |
|---|---|
| `server/distribution/config.js` | Entitlement resolver (mirrors chatbot-config.js): `features.distribution` under `DISTRIBUTION_ENABLED` (absent ⇒ on) |
| `server/distribution/meta.js` | Graph adapter: OAuth start URL, code→token→long-lived→page tokens, publish video / unpublished photos + feed post, pure builders + one form-encoded `graphCall` with `GraphError` (code/subcode/type surfaced), `isAuthError` (190/OAuthException) |
| `server/distribution/share-kit.js` | Pure Hebrew copy builders: post copy, sharer link, group sanitizer (facebook.com/groups/* only, cap 20), share-kit WhatsApp message |
| `server/distribution/jobs.js` | State machine: `awaiting_confirm → queued → running → done | failed | skipped_duplicate`; snapshot at enqueue; 3-attempt transient retry; auth-error → `needs_reconnect` flag + single nudge, then skip until reconnected; page-wide posted-sibling checks; `post_actions` writes; WhatsApp result summaries (incl. honest "duplicate prevented" and "not posted — not connected" lines) |
| `server/routes/distribution.js` | `/api/distribution`: `GET /oauth/start` (authed → FB), `GET /oauth/callback` (identity from HMAC state only, 10-min TTL), `POST /oauth/select` (multi-page picker), `GET /confirm` (action-token; renders Hebrew card incl. "already published"), `POST /publish` (owner-checked; 409 already_in_flight / already_published unless `force:true`; supersedes stale awaiting_confirm docs), `POST /groups`, `GET /status` (connection + per-listing state; never tokens/snapshots), `GET /packet` dropped (marketplaces deferred). All HTML escaped by default |
| `server/og.js` + `routes/pages.js` | Server-rendered OG tags, both `/p/:id` branches, active pages only; `$`-safe injection |
| `server/db.js` | `connections/facebook` (deep-merge-parity mem fallback), `distributions` (list by page / by phone; dot-path patch), `post_actions` append |
| `server/routes/admin.js` | `"distribution"` in the `FEATURES` whitelist; `distribution_enabled` in the agents view |
| Page-ready hook | In `createPropertyPage`, fire-and-forget: entitled + no in-flight/posted distribution ⇒ enqueue + WhatsApp confirm link. Never delays or fails page creation; crash-safe catch |

### Days 3–7
| Component | Responsibility |
|---|---|
| `server/distribution/instagram.js` | IG publish via connection's `ig_business_id`: media container (video→REELS / image) → status poll → publish; joins jobs.js as an `instagram` target, same retry/idempotency/audit rules |
| `public-agent/distribution.html/.js` | RTL Hebrew dashboard page: connect Facebook (with needs_reconnect + not-entitled states), groups editor (min-5 nudge), per-property publish with repost-confirm dialog, status chips from `/status`; XSS-safe DOM writes; error/retry states for non-401 failures |
| `docs/distribution/META-APP-SETUP.md` | Meta app creation, Dev Mode pilot path (Testers), Business Verification + App Review checklist (incl. `instagram_content_publish`), token model, reconnect flow |
| Hardening | Regression tests for every double-post scenario; review findings from the build |

## 5. Data model (Firestore, Admin-SDK-only — client rules already deny all)

- `businesses/{phone}/connections/facebook`
  `{ user_token, page_id, page_name, page_token, ig_business_id (3–7), pending_pages (transient), scopes[], connected_at, needs_reconnect }`
- `businesses/{phone}.distribution` → `{ groups: [urls] }`; entitlement at `businesses/{phone}.features.distribution`
- `distributions/{id}` → `{ id, page_id, business_phone, status, targets: { facebook_page: {status, post_id, error, attempts}, instagram (3–7), share_kit }, snapshot {page fields + groups}, created_at, updated_at, confirmed_at }`
- `post_actions/{auto}` (append-only audit, per product owner):
  `{ business_phone, page_id, distribution_id, target: "facebook_page"|"instagram"|"share_kit", action: "published"|"reposted"|"share_kit_sent"|"publish_failed", at, trigger: "confirm_link"|"dashboard"|"auto", post_id, post_url, content: { copy, media_type: "video"|"photos"|"none", media_count, media_urls[] }, error }`

## 6. Env / secrets (VPS `.env`, documented in `.env.example`)

`META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URL`, `META_GRAPH_VERSION`
(default v21.0), `DISTRIBUTION_ENABLED` (kill-switch, absent ⇒ on). Per-agent
tokens are data (Firestore), never env/Secret Manager.

## 7. Error handling

- Every external call: explicit `AbortSignal.timeout`; vendor error text → job doc + `post_actions.error` only (never browser, never WhatsApp).
- Code 190 / OAuthException → `needs_reconnect: true`, one WhatsApp nudge, all FB/IG publishing skipped for that agent until reconnect.
- Transient Graph errors: ≤3 attempts via sweeper ticks. Non-Graph failures (timeout/network) on the visible-post call: terminal `failed`, "check your page" message — never retried.
- Per-job isolation in the sweeper: one malformed doc → `failed`, sweep continues; unexpected error → doc returns to `queued`; overlapping sweeps prevented by an in-process latch (single-container deployment; documented limitation).
- All WhatsApp sends best-effort try/catch.

## 8. Testing

- `assert`-based test per pure module in the `npm test` chain: config resolver, meta builders + error classification, share-kit copy/sanitizer, og.js, OAuth state tokens, and the job state machine against injected fakes.
- Explicit regression tests for: confirm-after-publish, double-click publish, concurrent queued docs (one post only), failed-doc-with-live-post counted as posted, needs_reconnect skip, malformed doc not killing the sweep, post_actions written on success and failure.
- Manual e2e: Meta app in Dev Mode + test page, steps in META-APP-SETUP.md.

## 9. Build order (the week)

- **Day 1:** config, meta.js, share-kit, db additions, og.js — all pure + tested.
- **Day 2:** jobs.js, routes/distribution.js, page-ready hook, post_actions, admin flag → shippable MVP.
- **Days 3–4:** dashboard page.
- **Day 5:** Instagram target.
- **Day 6:** docs + hardening.
- **Day 7:** buffer + Dev-Mode e2e verification.

## 10. Open items for the product owner

- Create the Meta developer app (checklist doc is a Day-6 deliverable; Dev Mode unblocks pilots immediately).
- Choose pilot agents to flip the admin toggle for.
- Marketplace feeds: separate investigation to schedule (partner programs, feed specs).
