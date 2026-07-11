# Forly Nadlan — Implementation Plan

**Scope:** property landing pages (nadlan.call4li.com) + agent platform (agent.call4li.com)
**Companion docs:** `DESIGN.md` (product/architecture decisions), `template.html` (approved page)
**Repos touched:** `forly-backend` (everything), n8n (2 workflows), DNS (owner)
**Prime directives:** mirror the carousel-editor patterns; every prod deploy needs explicit
per-action approval (CLAUDE.md); n8n changes ship INACTIVE / as reviewable diffs.

---

## Phase map

| Phase | Deliverable | Depends on | Effort | Prod gate |
|---|---|---|---|---|
| 0 | Prep: schema, secrets, hosting targets, repo layout | — | S | none (local) |
| 1 | Page core: create/get Functions + `/p/` page | 0 | M | deploy #1 |
| 2 | Lead loop: form → lead → agent WhatsApp → funnel | 1 | S | deploy #2 |
| 3 | Pipeline: n8n Page Builder + Area Intelligence + WW1 hook | 1 | M | n8n publish |
| 4 | Agent platform: OTP auth + dashboard CRUD + page editor | 1 | L | deploy #3 |
| 5 | Lifecycle: 30d expiry, reminders, extend; web signup | 4 | M | deploy #4 |
| 6 | Launch: rules lockdown, domains, monitoring, rollback | all | S | deploy #5 + DNS |

Effort: S ≈ half a working session, M ≈ 1–2 sessions, L ≈ 2–4 sessions.
Phases 1→2→3 give a complete auto-pipeline (WhatsApp-triggered pages with leads)
before any platform work — value ships early.

---

## Phase 0 — Prep (no prod impact)

### 0.1 Repo layout (forly-backend)

```
forly-backend/
├─ functions/src/
│  ├─ index.ts              # existing carousel fns — untouched, re-exports below
│  ├─ shared.ts             # NEW: extracted helpers (uploadBuffer, downloadAndUpload,
│  │                        #   tokenedUrl, setCors, sendWhatsApp, pad) — moved from
│  │                        #   index.ts verbatim, imported back into it
│  ├─ nadlan/
│  │  ├─ pages.ts           # createPropertyPage, getPropertyPage, updatePropertyPage
│  │  ├─ leads.ts           # submitPropertyLead, trackPropertyEvent
│  │  ├─ auth.ts            # sendLoginOtp, verifyLoginOtp, requireAuth middleware
│  │  ├─ properties.ts      # listMyProperties, createProperty, deleteProperty,
│  │  │                     #   archiveProperty, getUploadUrls
│  │  ├─ lifecycle.ts       # extendPropertyPage, expirePagesDaily
│  │  └─ types.ts           # PropertyPage, Listing, AreaProfile interfaces
│  └─ signup/web.ts         # (Phase 5) submitWebSignup
├─ public-nadlan/           # NEW hosting target "nadlan"
│  └─ p/index.html          #   built from docs/property-landing-page/template.html
├─ public-agent/            # NEW hosting target "agent"
│  ├─ index.html            #   dashboard shell (login → list)
│  ├─ app.js / app.css
│  ├─ create.html           #   create-property form
│  ├─ edit.html             #   structured page editor
│  └─ signup.html           #   (Phase 5) web signup
└─ public/                  # existing carousel editor — untouched
```

Rule: `index.ts` only gains `export * from "./nadlan/..."` lines; zero changes to
carousel logic. Keep every new file <500 lines.

### 0.2 firebase.json / .firebaserc — multi-site hosting

```jsonc
// .firebaserc
{ "projects": { "default": "call4li" },
  "targets": { "call4li": { "hosting": {
    "app":    ["call4li"],          // existing site (carousel editor)
    "nadlan": ["call4li-nadlan"],   // NEW site
    "agent":  ["call4li-agent"]     // NEW site
  }}}}
```

```jsonc
// firebase.json → "hosting" becomes an array:
[
  { "target": "app",    ...existing config unchanged... },
  { "target": "nadlan", "public": "public-nadlan",
    "rewrites": [
      { "source": "/api/property-page",  "function": { "functionId": "getPropertyPage",   "region": "europe-west1" } },
      { "source": "/api/property-lead",  "function": { "functionId": "submitPropertyLead","region": "europe-west1" } },
      { "source": "/api/property-event", "function": { "functionId": "trackPropertyEvent","region": "europe-west1" } },
      { "source": "/api/extend",         "function": { "functionId": "extendPropertyPage","region": "europe-west1" } },
      { "source": "/p/**", "destination": "/p/index.html" }
    ],
    "headers": [{ "source": "**/*.html", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] }] },
  { "target": "agent",  "public": "public-agent",
    "rewrites": [
      { "source": "/api/auth/otp",        "function": { "functionId": "sendLoginOtp",     "region": "europe-west1" } },
      { "source": "/api/auth/verify",     "function": { "functionId": "verifyLoginOtp",   "region": "europe-west1" } },
      { "source": "/api/properties",      "function": { "functionId": "listMyProperties", "region": "europe-west1" } },
      { "source": "/api/properties/create","function": { "functionId": "createProperty",  "region": "europe-west1" } },
      { "source": "/api/properties/delete","function": { "functionId": "deleteProperty",  "region": "europe-west1" } },
      { "source": "/api/upload-urls",     "function": { "functionId": "getUploadUrls",    "region": "europe-west1" } },
      { "source": "/api/page/update",     "function": { "functionId": "updatePropertyPage","region": "europe-west1" } },
      { "source": "/api/page/extend",     "function": { "functionId": "extendPropertyPage","region": "europe-west1" } },
      { "source": "/api/signup",          "function": { "functionId": "submitWebSignup",  "region": "europe-west1" } }
    ] }
]
```

Owner console step (with deploy #1): `firebase hosting:sites:create call4li-nadlan`
and `call4li-agent` (or via console UI). Same-origin `/api/*` → no CORS anywhere.

### 0.3 Secrets & env

| Secret (Secret Manager + `.secret.local`) | Used by | Notes |
|---|---|---|
| `GREENAPI_INSTANCE`, `GREENAPI_TOKEN` | existing + all WhatsApp sends | already provisioned |
| `NADLAN_JWT_SECRET` | auth.ts, lifecycle.ts (signed links) | NEW — 32B random |
| `GOOGLE_MAPS_KEY` | n8n (geocode/distance/static map) | NEW — one key, 3 APIs |
| `ANTHROPIC_API_KEY` | n8n (copy + area research) | exists in n8n creds |
| `N8N_LEAD_WEBHOOK_URL` | leads.ts → Leads Handler | env param, not secret |
| `N8N_PIPELINE_WEBHOOK_URL` | properties.ts → Page Builder/Vision | env param |

### 0.4 Firestore schema (authoritative)

```jsonc
// listings/{listingId}  — extended (existing collection)
{ "listing_id": "uuid", "business_phone": "9725...",
  "source": "dashboard" | "chat_burst",
  "address": "", "neighborhood": "", "city": "",
  "price": 0, "rooms": 0, "size_sqm": 0, "floor": 0, "parking": 0,
  "description": "", "photos_urls": [], "own_video_url": null,
  "status": "active" | "archived" | "deleted",
  "page_id": null,                    // back-ref once page exists
  "created_at": ts }

// property_pages/{pageId}
{ "page_id": "uuid", "listing_id": "", "business_phone": "",
  "status": "building" | "active" | "expiring" | "expired" | "archived",
  "created_at": ts, "updated_at": ts,
  "expires_at": ts,                   // created_at + 30d
  "reminder_sent_at": null, "extension_count": 0, "edit_count": 0,
  "agent":    { "name","brand_name","logo_url","tagline","phone","license" },
  "property": { "title","address","neighborhood","city","price","rooms","size_sqm","floor","parking" },
  "hero":     { "phrase","video_url","poster_url" },
  "gallery":  { "images": [{ "url","caption" }] },          // ordered
  "carousel": { "slides": [{ "num","title","body","tag" }] },
  "area":     { "blurb","stops":[{"label","minutes"}],"stats":[{"value","label","source_url"}],
                "map_image_url","profile_slug" },
  "cta":      { "headline","sub","bullets":[],"button_label" },
  "sections": { "gallery": true, "carousel": true, "area": true },  // editor toggles
  "view_count": 0, "lead_count": 0 }

// area_profiles/{slug}   e.g. "tel-aviv__bavli"
{ "slug","city","neighborhood", "blurb",
  "stats": [{ "value","label","source_url" }], "sources": [],
  "researched_at": ts, "expires_at": ts /* +90d */, "locked": false }

// otp_codes/{phone}
{ "code_hash": "sha256(code+salt)", "expires_at": ts /* +5m */,
  "attempts": 0, "sends_today": 0, "last_sent_at": ts }

// leads/{prospectPhone}  — existing; landing-page additions:
{ ..., "source": "landing_page", "page_id": "", "listing_id": "",
  "prospect_name": "" }
```

Storage layout: `property_pages/{pageId}/walkthrough.mp4|poster.jpg|photo-NN.jpg`,
`agent_uploads/{phone}/{uuid}.jpg` (pre-page uploads), `logos/{phone}.png`.

### 0.5 Phase-0 exit checklist
- [ ] `shared.ts` extracted; `npm run build` green; carousel fns byte-identical behavior
- [ ] firebase.json multi-site config committed (deploys later)
- [ ] `types.ts` with all interfaces above
- [ ] Owner has provided: GOOGLE_MAPS_KEY; confirmed DNS access for call4li.com
- [ ] Open item chased: original walkthrough video URL (sound) — needed for template
      verification, not blocking

---

## Phase 1 — Page core

### 1.1 `nadlan/pages.ts`

**`createPropertyPage`** — POST (from n8n or `createProperty`), `timeoutSeconds: 300`, `memory: 1GiB`.

```jsonc
// request
{ "listing_id": "", "business_phone": "",
  "video_url": "", "poster_url": null,          // poster: extract via ffmpeg? NO —
                                                //   n8n supplies; fallback = first photo
  "photos": [{ "url": "", "caption": "" }],
  "agent": {...}, "property": {...},
  "hero_phrase": "", "carousel_slides": [...],
  "area": {...}, "cta": {...} }
// response
{ "page_id": "uuid", "page_url": "https://nadlan.call4li.com/p/{page_id}" }
```

Behavior (mirrors `createCarouselDraft`): validate body (reject missing video/photos/phone)
→ `Promise.all` `downloadAndUpload` every asset into `property_pages/{id}/` (re-hosting
makes pages immune to source-URL expiry) → write doc with `status:"active"`,
`expires_at:+30d` → update `listings/{listing_id}.page_id` → return. Idempotency: if a
non-archived page already exists for `listing_id`, **update it** instead of duplicating.

**`getPropertyPage`** — GET `?id=`. Returns payload for `active|expiring`; for
`expired|archived` returns `{ status, property: {title}, agent: {name,phone} }` only
(page renders the graceful expired state). 404 otherwise. `Cache-Control: public, max-age=60`.

**`updatePropertyPage`** — POST, JWT-authed (Phase 4 wires the auth; function ships now
gated to `requireAuth`). Whitelist-merge editable paths only:
`hero.phrase, property.*, gallery.images (order/captions/remove), carousel.slides[].title|body|tag,
cta.*, sections.*`. Rejects unknown paths. `edit_count++`, `updated_at=now`.

### 1.2 `/p/` page — `public-nadlan/p/index.html`

Transform `docs/property-landing-page/template.html` (keep design pixel-identical):
1. Strip doc-header comment; extract inline CSS/JS → `p/page.css`, `p/page.js` (repo
   hygiene; still no build step).
2. Replace tokens with a `render(payload)` layer: `id = location.pathname.split("/p/")[1]`
   → `fetch('/api/property-page?id='+id)` → populate DOM. Skeleton shimmer while loading.
3. Data-driven bits: brand logo (`agent.logo_url` img, else serif text-mark), gallery grid
   built from `gallery.images[]` (grid adapts 1–12 photos; first = feature), carousel cards
   from payload, area stats **with source links** (`לפי {hostname}` under stat), sections
   hidden per `sections.*`, wa.me links from `agent.phone`.
4. States: loading / active / expired ("הדף אינו פעיל" + agent contact) / 404.
5. `<meta property="og:*">` populated post-fetch + `<title>` — plus **prerender fallback**:
   `getPropertyPage` also serves `?og=1` HTML head for WhatsApp link-preview bots
   (WhatsApp doesn't run JS). Implementation: rewrite `/p/**` hits from known bot UAs to
   the function (checked via `User-Agent` in a lightweight `pageOg` handler) —*defer to
   Phase 2 if time-boxed; track as 1.2-og.*
6. Analytics beacons (wired Phase 2): view on load, scroll-depth 50/90, video play,
   CTA click.

### 1.3 Local verification (no prod)
- `firebase emulators:start` (functions + firestore + hosting + storage)
- Seed script `scripts/seed-page.local.ts`: writes a full fake payload doc (uses the
  Bavli mock content) — run against **emulator only** (guard: refuses if
  `FIRESTORE_EMULATOR_HOST` unset).
- curl `createPropertyPage` with sample body → assert Storage files + doc.
- Playwright smoke (reuse session harness): open emulated `/p/{id}`, assert hero video
  el, 6 gallery items, form submit disabled-until-valid, screenshot vs mock.

### 1.4 Deploy #1 (approval gate)
Command shown for approval: `firebase deploy --only functions:createPropertyPage,functions:getPropertyPage,functions:updatePropertyPage,hosting:nadlan`
Post-deploy: seed one real page via curl (test listing), open on
`call4li-nadlan.web.app/p/{id}`, verify on mobile. **No public link shared yet.**

### 1.5 Acceptance
- [ ] Page pixel-matches approved mock at 390px and 1440px (screenshot diff)
- [ ] Payload → page in <2s cold, <500ms warm
- [ ] Expired/404 states render correctly
- [ ] Carousel editor untouched (regression: create+open a carousel draft)

---

## Phase 2 — Lead loop

### 2.1 `nadlan/leads.ts`

**`submitPropertyLead`** — POST `{ page_id, name, phone }`.
1. Validate: phone matches `^0?5\d{8}$` (normalize to `972...`), name 2–60 chars,
   page exists & `active|expiring`.
2. Rate limit: max 3 submissions / phone / hour (transaction on
   `lead_throttle/{phone}`), silently accept duplicates (return ok, skip side effects).
3. Write/merge `leads/{prospectPhone}`: `source:"landing_page"`, `page_id`, `listing_id`,
   `prospect_name`, `status:"new"` (don't clobber an existing `converted`).
4. `property_pages/{page_id}.lead_count++`.
5. WhatsApp the **agent** (best-effort, never fails the request — carousel pattern):
   `🔔 ליד חדש מדף הנכס "{property.title}"! {name}, {phone} — דברו איתו עכשיו: wa.me/{phone}`
6. Fire-and-forget POST `N8N_LEAD_WEBHOOK_URL` (Forly Leads Handler
   `/webhook/lead-trigger`) with the lead payload → prospect enters the funnel.
7. Response `{ ok: true }` → page shows 🥂 state.

**`trackPropertyEvent`** — POST `{ page_id, event }`, `event ∈ {view, scroll_50,
scroll_90, video_play, cta_click}`. Fire-and-forget `sendBeacon` from page. Increments
`view_count` (event=view) + appends daily counter doc
`property_pages/{id}/metrics/{YYYY-MM-DD}` `{view: n, ...}` for the future dashboard.

### 2.2 Page wiring (`p/page.js`)
Form POST → `/api/property-lead`; optimistic 🥂; error toast on non-200 with retry.
Beacons on the four events. WhatsApp button URL: `wa.me/{agent.phone}?text=` prefilled
with property title.

### 2.3 Test plan
Emulator: valid submit → all 5 side effects (assert via emulator Firestore); rate-limit
kicks on 4th; invalid phone 400; expired page 410. Green-API + n8n webhook mocked via
env override to local echo server.

### 2.4 Deploy #2 (approval gate)
`firebase deploy --only functions:submitPropertyLead,functions:trackPropertyEvent,hosting:nadlan`
Then live E2E with MY OWN phone as prospect on the test page; verify agent WhatsApp
arrives + lead doc + Leads Handler execution log.

---

## Phase 3 — n8n pipeline

### 3.1 New workflow: **Property Page Builder** (built INACTIVE)

Trigger: `ExecuteWorkflowTrigger` — input `{ listing_id, business_phone, video_url }`.

| # | Node | Detail |
|---|---|---|
| 1 | ExecuteWorkflow Trigger | inputs above |
| 2 | HTTP: Firestore GET `listings/{listing_id}` | photos, property fields |
| 3 | HTTP: Firestore GET `businesses/{business_phone}` | agent name/brand/logo/license |
| 4 | Code: `slug = slugify(city)+"__"+slugify(neighborhood)` | |
| 5 | HTTP: Firestore GET `area_profiles/{slug}` | continueOnFail |
| 6 | IF fresh (`exists && expires_at>now`) | → 10 |
| 7 | HTTP: Anthropic Messages — **area research** | model `claude-opus-4-8`, tools `[{type:"web_search_20260209", name:"web_search", max_uses:8}]`, Hebrew prompt per DESIGN.md; ~60–90s |
| 8 | Code: parse → **source-or-drop** filter (stat without source_url ⇒ dropped) | |
| 9 | HTTP: Firestore PATCH `area_profiles/{slug}` (+90d, skip if `locked`) | |
| 10 | HTTP: Google Geocoding (address) → lat/lng | |
| 11 | HTTP: Google Distance Matrix → fixed landmark set → `stops[]` | park/beach/Ayalon/rail per city config |
| 12 | Code: build Static Map URL (`GOOGLE_MAPS_KEY`) | |
| 13 | HTTP: Anthropic Messages — **copy** | model `claude-sonnet-4-5-20250929`, structured output `{hero_phrase, carousel_slides[4]{num,title,body,tag}, cta{headline,sub,bullets,button_label}}`; input: property+agent+area |
| 14 | Code: poster = first gallery photo (until WW1 emits poster frame) | |
| 15 | HTTP: POST `createPropertyPage` (full assembled body) | |
| 16 | HTTP: Green-API sendMessage → agent | `🎉 דף הנכס שלך באוויר: {page_url}\nתקף ל-30 יום · לעריכה: agent.call4li.com` |
| E | Error branch (any node) → Green-API to admin phone + n8n execution tag | never leave agent waiting silently |

Build via MCP flow: `search_nodes` → `get_node_types` → `validate_workflow` →
`create_workflow_from_code` (description set). Test with `test_workflow` + pinned
input data before any activation.

### 3.2 WW1 edit (one node) — approval gate
Append `ExecuteWorkflow → Property Page Builder` passing
`{listing_id, business_phone, video_url}` at WW1's success terminus.
Protocol: `get_workflow_details(vHUj7CfmGQszcRV7)` → present exact before/after node
diff in chat → owner approves → `update_workflow` → `test_workflow` with pinned data
→ leave WW1 published state unchanged.
⚠️ While here, verify WW1's video output **preserves the audio track** end-to-end
(the chat-upload test clip had none — check Seedance output + any ffmpeg steps).

### 3.3 Own-video path
`createProperty` (Phase 4) with `own_video_url` skips WW1: backend POSTs
`N8N_PIPELINE_WEBHOOK_URL` (a small Webhook trigger added to Property Page Builder as
a second entry point) directly.

### 3.4 Acceptance
- [ ] Test execution: chat-burst listing in → live page out, end to end, <4 min
- [ ] Area profile cached; second listing in same neighborhood skips research (logs prove)
- [ ] Every rendered stat has a working source link
- [ ] Error branch fires (kill the Maps key in a test) → admin WhatsApp received
- [ ] Cost sampled per page: 1 sonnet call (+1 opus per new neighborhood) + 2 Maps calls

---

## Phase 4 — Agent platform (agent.call4li.com)

### 4.1 `nadlan/auth.ts`

**`sendLoginOtp`** — POST `{ phone }`. Normalize; require `businesses/{phone}` exists
(else 404 → UI offers signup). Throttle: ≥60s between sends, ≤5/day (otp_codes doc).
6-digit code → store `sha256(code + NADLAN_JWT_SECRET)`, `expires_at:+5m`, `attempts:0`
→ Green-API: `🔐 קוד הכניסה שלך לפורלי: {code}`.

**`verifyLoginOtp`** — POST `{ phone, code }`. ≤5 attempts (then invalidate code).
On match: delete otp doc, issue JWT `{ sub: phone, iat, exp: +30d }` HS256
(`NADLAN_JWT_SECRET`) → `Set-Cookie: fly_session=...; HttpOnly; Secure; SameSite=Lax;
Max-Age=2592000; Path=/`. Response `{ ok, agent: {name, brand_name, logo_url} }`.

**`requireAuth(req)`** helper — parse cookie, verify JWT, return phone; 401 otherwise.
All Phase-4/5 dashboard functions call it first. Ownership rule everywhere:
`doc.business_phone === jwt.sub`.

### 4.2 `nadlan/properties.ts`

**`getUploadUrls`** — POST `{ files: [{name, contentType}] }` (JWT). ≤12 files, images
only, ≤10MB each declared. Returns V4 signed PUT URLs to
`agent_uploads/{phone}/{uuid}.{ext}` (15-min expiry) + final tokened GET URLs.
Browser uploads directly to Storage — Functions never proxy bytes.

**`createProperty`** — POST (JWT) `{ address, city, neighborhood, price, rooms,
size_sqm, floor, parking, description, photos_urls[], own_video_url? }`.
Validate (address+city+price+rooms+≥3 photos required) → write `listings/{uuid}`
`source:"dashboard"` → trigger: own_video ? Page-Builder webhook : WW1 webhook (which
runs Vision Tagger→video→builder) → `{ listing_id, status: "building" }`.
UI shows "הדף בבנייה 🏗️ נעדכן אותך בוואטסאפ" (builder's WhatsApp closes the loop).

**`listMyProperties`** — GET (JWT). Join `listings` + `property_pages` by phone →
`[{ listing_id, page_id, title, status, days_left, view_count, lead_count, page_url,
thumb_url }]` sorted newest-first.

**`deleteProperty`** — POST `{ listing_id, mode: "archive" | "delete" }` (JWT, owner).
archive: listing+page → `archived` (page hidden, restorable). delete: statuses →
`deleted` + `bucket.deleteFiles({prefix})` for page assets. Require UI double-confirm.

### 4.3 Dashboard front-end (`public-agent/`)
Same design system as the property page (gold/cream/charcoal, Heebo/Frank Ruhl, RTL).
- `index.html` — login screen (phone → OTP 6-cell input) ⇄ property list (cards:
  thumb, title, status chip, days-left bar, views/leads counters, buttons:
  צפייה / עריכה / הארכה / ארכיון). Session check on load (`/api/properties` 401 → login).
- `create.html` — form + drag-drop photo upload (progress per file, reorder by drag),
  optional video upload, submit → building state.
- `edit.html?id=` — structured editor: hero phrase (counter ≤40 chars), price/details
  inputs, gallery grid (drag-reorder, caption edit, remove), carousel card texts,
  CTA texts, section toggles. Sticky "שמור" → `/api/page/update` → "✓ נשמר · הדף עודכן"
  + live preview iframe of `/p/{id}` (reloads on save).
- Vanilla JS, `fetch` with `credentials:"same-origin"`; shared `api.js` wrapper
  handling 401→login redirect.

### 4.4 Test plan
Emulator: full OTP flow (code read from emulator Firestore), JWT cookie round-trip,
throttles, wrong-owner 403s, upload-URL content-type enforcement. Playwright: login →
create (3 fixture photos) → building state; edit → save → `/p/` reflects change;
screenshot suite.

### 4.5 Deploy #3 (approval gate)
`firebase deploy --only functions:sendLoginOtp,functions:verifyLoginOtp,functions:getUploadUrls,functions:createProperty,functions:listMyProperties,functions:deleteProperty,hosting:agent`
Live E2E with owner's real agent account before sharing with any external agent.

---

## Phase 5 — Lifecycle + web signup

### 5.1 `nadlan/lifecycle.ts`

**`extendPropertyPage`** — two auth modes:
- Dashboard: POST `{ page_id }` + JWT (owner).
- WhatsApp one-tap: GET `/api/extend?id={page_id}&t={token}` where
  `t = HMAC_SHA256(NADLAN_JWT_SECRET, page_id + ":" + expires_at_iso)` — single-use
  because extending changes `expires_at`, invalidating the token. Renders a tiny
  confirmation HTML ("✅ הוארך עד {date}").
Effect: `expires_at = max(now, expires_at) + 30d`, `status:"active"`,
`extension_count++`, `reminder_sent_at:null`.

**`expirePagesDaily`** — `onSchedule("every day 09:00", {timeZone:"Asia/Jerusalem"})`:
1. `status=="active" && expires_at ≤ now+5d && reminder_sent_at==null` → WhatsApp:
   `⏳ דף הנכס "{title}" יפוג בעוד {n} ימים.\nלהארכה בחינם (30 יום נוספים): {extend_link}\nלניהול: agent.call4li.com`
   → set `reminder_sent_at`, `status:"expiring"`.
2. `expires_at < now && status in (active,expiring)` → `status:"expired"` (assets kept).
Batched (≤100/run like `cleanupExpiredDrafts`), per-doc try/catch.

### 5.2 `signup/web.ts` — **`submitWebSignup`**
POST `{ full_name, business_name, phone, city, niche, logo_url? }` → OTP verify flow
(reuse sendLoginOtp/verify with `mode:"signup"` allowing non-existing phone) → write
`businesses/{phone}` + quota subcol (schema-compatible with Signup Bot2's writes — one
canonical shape) → WhatsApp welcome (same text as bot) → JWT cookie → dashboard.
Logo: upload via `getUploadUrls`, or "אין לי לוגו" → flag `logo_requested:true`
(generation job = v2; text-mark fallback meanwhile). `signup.html` = 2-step form + OTP.

### 5.3 Deploy #4 (approval gate)
`firebase deploy --only functions:extendPropertyPage,functions:expirePagesDaily,functions:submitWebSignup,hosting:agent`
Verify: manually set a test page `expires_at=+3d` → run function via emulator/manual
trigger → reminder arrives → tap link → extended.

---

## Phase 6 — Launch hardening

### 6.1 Security lockdown (before ANY public traffic)
- **firestore.rules**: replace the expiring allow-all with default-deny for all
  client SDK access (`allow read, write: if false;` catch-all). Everything goes
  through Functions (admin SDK bypasses rules). Carousel editor check: `public/c/`
  uses Functions only → unaffected. Deploy `--only firestore:rules` (approval).
- **storage.rules**: default deny; uploads happen via signed URLs (bypass rules);
  reads via tokened URLs (bypass rules) → safe to deny-all client SDK.
- Function-level: JWT on all dashboard fns; throttles verified; body size limits
  (`maxRequestSize` defaults fine, photos never proxied).
- Secrets audit: no key in client JS (Maps key lives only in n8n; static map URLs are
  generated server-side and stored as fetched images — do NOT embed a raw keyed URL
  in payloads. Builder node 12 downloads the map PNG and `createPropertyPage` re-hosts).

### 6.2 Custom domains (owner actions)
1. Console → Hosting → `call4li-nadlan` site → add custom domain `nadlan.call4li.com`
   → copy TXT (verification) + A/CNAME records → owner adds at DNS → SSL auto (~1h).
2. Same for `call4li-agent` → `agent.call4li.com`.
3. Until DNS lands, everything works on `call4li-nadlan.web.app` (page_url is built
   from an env param `PAGE_BASE_URL` — flip it when the domain is live).

### 6.3 Activation sequence
1. Deploys #1–#4 done, tested on web.app URLs.
2. n8n: activate Property Page Builder → publish WW1 one-node edit (approved diff).
3. Create 2–3 real pages for a friendly pilot agent; watch execution logs + page
   analytics for 48h.
4. Flip `PAGE_BASE_URL` to `https://nadlan.call4li.com` post-DNS.
5. Announce to agents (WhatsApp broadcast + dashboard link).

### 6.4 Monitoring & rollback
- Monitor: n8n execution failures (error branch → admin WhatsApp), Functions error
  rate (console), daily `expirePagesDaily` log line (# reminded / # expired),
  `metrics` subcollection sanity.
- Rollback levers (each independent): deactivate Page Builder workflow (pages stop
  generating; WhatsApp flow otherwise untouched — WW1's ExecuteWorkflow node
  `continueOnFail:true` so WW1 itself never breaks); revert WW1 via n8n version
  history; `firebase hosting:rollback` per site; Functions redeploy previous revision;
  pages themselves are docs — worst case set `status:"archived"` in bulk.

### 6.5 Launch acceptance
- [ ] E2E journey A (WhatsApp): burst → video → page → prospect form → agent lead ping
- [ ] E2E journey B (dashboard): signup(web) → create → building → page live → edit → extend
- [ ] E2E journey C (lifecycle): page ages → reminder → one-tap extend / expire state
- [ ] Firestore/Storage rules deny client access (verified with anon SDK attempt)
- [ ] Lighthouse mobile on a real page: Perf ≥85, a11y ≥90
- [ ] Load: page fetch is 1 doc read — no scaling concern; Green-API within plan limits

---

## Cross-cutting standards

- **Every function**: input validation at boundary, try/catch with `logger.error`,
  best-effort WhatsApp (never fail the request on notify errors), owner-check via JWT.
- **Files <500 lines**; helpers in `shared.ts`; no new deps beyond `jsonwebtoken`
  (or `jose`) — everything else (uuid, axios, firebase-admin) already present.
- **Git**: feature branches per phase → this working branch; commits per component;
  no push to main without approval.
- **Testing**: emulator suite per phase (curl scripts under `scripts/`, committed);
  Playwright visual checks reuse the session harness; NEVER seed prod Firestore
  from scripts (guard on emulator env var).
- **Hebrew copy**: all agent/prospect-facing strings reviewed by owner before deploy #2
  (list collected in `COPY.md` as they're written).

## Dependencies on owner (rolling list)
| Item | Needed by | Status |
|---|---|---|
| GOOGLE_MAPS_KEY (Geocoding+Distance Matrix+Static Maps enabled) | Phase 3 | ⏳ |
| Original walkthrough video URL (with sound) | template check | ⏳ |
| Hosting sites creation + DNS records | Phase 6 | ⏳ |
| Deploy approvals #1–#5, n8n WW1 diff approval | each gate | per-action |
| Pilot agent for soft launch | Phase 6 | ⏳ |
