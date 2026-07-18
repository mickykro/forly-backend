# Forly Nadlan — In-Page Text Edit Mode ("magic edit link")

**Goal:** the agent opens his own landing page through a secret link, taps any
text, edits it in place, hits שמירה — done. No drag & drop, no layout moves,
no image management, no theme changes. Text only.

**Why this shape:** a full Wix-style editor was ruled out as too complex. The
insight here is that the landing page *is already the perfect preview* — so
instead of building an editor UI, we unlock the existing page for inline text
editing when it's opened with a valid edit token.

---

## 1. The edit link

```
https://nadlan.call4li.com/p/{pageId}#edit={edit_token}
```

- `edit_token` — 32-hex random secret (`crypto.randomBytes(16)`), stored on
  `property_pages/{pageId}.edit_token`.
  - Generated at page creation; **lazily backfilled** for existing pages the
    first time the dashboard asks for the edit URL.
  - Stored-random (not HMAC-derived) so it is **revocable**: a "regenerate
    link" action can kill a leaked link without touching anything else.
- The token rides in the **URL hash fragment**, not a query param — fragments
  are never sent to servers, so the secret stays out of access logs, proxies,
  and referrer headers. `page.js` reads it client-side and presents it to the
  API explicitly.
- The token is **never included** in the public `GET /api/property-page`
  payload. It is surfaced in exactly one place: the authenticated agent
  dashboard (per product decision).
- Lifetime = page lifetime. Expired/archived pages reject edits regardless of
  token.

## 2. Backend

Two serving paths exist today (standalone `server/index.js` — the active dev
track — and the Firebase Functions path). Implement in **`server/index.js`
first**, then mirror in `functions/src/nadlan/pages.ts` for parity. The logic
is identical and small.

### 2.1 Token verification on page fetch

`GET /api/property-page?id={pageId}` gains an optional `X-Edit-Token` header
(or `&edit_token=` param):

- Valid token + page `active|expiring` → normal payload **plus
  `"editable": true`**, `Cache-Control: no-store`.
- Invalid/missing token → today's public payload, unchanged (no error, no
  hint that a token exists).
- Constant-time compare (`crypto.timingSafeEqual`).
- Brute-force guard: reuse the existing lead-throttle pattern — max ~10 failed
  token checks per page per hour → 429.

### 2.2 New endpoint: `POST /api/page/edit-text`

```jsonc
{ "page_id": "...", "edit_token": "...",
  "fields": {
    "hero_phrase":        "...",                     // ≤80
    "property_title":     "...",                     // ≤80
    "carousel_slides":    [{ "title","body","tag" }],// ≤60 / ≤300 / ≤30, by index
    "cta":                { "headline","sub","button_label" }, // ≤80/≤200/≤30
    "area_blurb":         "...",                     // ≤600
    "gallery_captions":   [{ "url","caption" }]      // ≤60, URL must already exist
  }}
```

- Token-authed sibling of `updatePropertyPage` — same whitelist-merge style,
  same length caps, plain text only (renderer already HTML-escapes everything).
- **Explicitly rejected:** photos add/remove/reorder, numbers (price, rooms,
  sqm, floor), section toggles, theme/template, agent identity fields. Those
  stay in the dashboard structured editor (`edit.html`).
- Effects: `edit_count++`, `updated_at = now`. Page must be `active|expiring`.

### 2.3 Dashboard surfacing (the only place the link lives)

- `listMyProperties` response gains `edit_url` per page (backfills the token
  if the doc predates this feature).
- `public-agent/index.html` property card gets two small actions next to the
  existing עריכה button:
  - **"עריכה בדף ↗"** — opens the magic link in a new tab.
  - **"העתקת קישור עריכה"** — copies the link (so the agent can open it on
    his phone).
- Optional (cheap, recommended): `POST /api/page/regen-edit-token` (session
  cookie auth, owner check) + a small "החלפת קישור" action.

## 3. Frontend — edit mode in `page.js` / `page.css`

~150–200 added lines; zero changes to the read-only experience.

### Boot

1. Parse `location.hash` for `edit={token}`; strip it from the address bar
   (`history.replaceState`) so it doesn't linger in screenshots/shares.
2. Fetch the payload **with the token**. `editable:true` → render normally,
   then `enterEditMode()`. Invalid token → render read-only + toast
   "קישור העריכה אינו תקף".

### Edit mode UX

- **Editable elements** get `contenteditable="plaintext-only"` +
  `data-edit="<field path>"`, a dashed outline on hover/focus and a small ✏️
  affordance. Mapped elements:
  hero `h1`, hero eyebrow-adjacent title, carousel card `h3`/`p`/`.tag`,
  CTA `h2`/`p`/button label, area blurb paragraphs, gallery captions.
- **Toolbar:** fixed strip — "מצב עריכה · לחצו על כל טקסט כדי לערוך" with
  **שמירה** (disabled until dirty) and **ביטול** (restores fetched values).
  Top on desktop, bottom-sticky on mobile (agents will do this from a phone).
- **Char limits** enforced live per field; a small counter bubble appears near
  the focused element as the limit approaches.
- **Enter key:** allowed once in the hero phrase (it renders as the two-line
  headline); blocked everywhere else.
- **While editing:** lead-form submit and CTA navigation are disabled
  (preventDefault on editable containers); the sound/lightbox/carousel
  controls keep working so the page still feels alive.
- **Analytics:** all beacons (`view`, `scroll_*`, `video_play`, `cta_click`)
  are suppressed in edit mode — the agent editing his page must not pollute
  his own view stats.

### Save

Collect all `data-edit` values → `POST /api/page/edit-text` → toast
"✓ נשמר · הדף עודכן" → mark clean. Errors keep the edits in the DOM and show
a retry toast. (`Cache-Control: no-store` on the tokened fetch means a reload
inside edit mode always shows fresh content; the public 60s cache is
unaffected.)

## 4. Out of scope (v1, by design)

Moving/resizing elements, drag & drop, adding/removing images, video, colors,
fonts, templates, section toggles, price/room numbers, agent branding. All of
these already have a home in the dashboard structured editor.

## 5. Testing

- **Server path (in-memory mode):** create a demo page → open
  `/p/{id}#edit={token}` in Playwright → edit hero + one card + CTA → save →
  reload *without* token → text persisted, no editable affordances, no token
  anywhere in the DOM. Wrong token → read-only + toast. 11 bad tokens →
  429. Expired page + valid token → read-only.
- **Functions path:** emulator curl suite for `edit-text` (whitelist, caps,
  wrong token, expired page) mirroring `scripts/` conventions.
- **Regression:** public page renders byte-identical without a token; lead
  submit unaffected; view beacon still fires for normal visitors.

## 6. Rollout

1. Implement + local verification (no prod impact).
2. Commit/push to the working branch; review.
3. Deploy — **approval gate per CLAUDE.md**: standalone server redeploy, and
   (if mirroring ships same release)
   `firebase deploy --only functions:getPropertyPage,functions:updatePropertyPage,functions:listMyProperties,hosting:nadlan,hosting:agent`.
4. Verify live with one real page: edit from phone via dashboard link,
   confirm public visitors see updated text within the 60s cache window.

**Effort:** ~1 session (S–M). No new dependencies, no schema migration
(lazy token backfill), no n8n changes.

## 7. Decisions (owner, 2026-07-13) & implementation notes

1. **Serving path:** standalone server only (`server/index.js` + `server/edit.js`).
   The Firebase Functions path was NOT touched.
2. **Field scope:** *every* text on the page. Beyond the payload fields, the
   template's static strings (section headings, buttons, form labels, footer,
   sticky bar…) are editable through a whitelisted `texts` override map stored
   on the page doc and applied after render. Derived strings (eyebrow, hero
   subline, spec values) are editable as overrides via the same map.
3. **Edit link surface:** agent-facing only — currently the create-flow
   "page ready" screen (`create.html` doneBox, fed by `edit_url` from
   `/api/listing-status`, which also lazily backfills tokens for old pages).
   When a dashboard lands in the server path, surface it there too. The n8n
   WhatsApp message is unchanged.

**Shipped files:** `server/edit.js` (token + whitelist merge),
`server/index.js` (routes), `public-nadlan/p/edit.js` + `edit.css`
(lazy-loaded editor), `public-nadlan/p/page.js` + `index.html` (hooks),
`public-agent/create.html` (link surfacing),
`scripts/edit-mode-e2e.local.js` (Playwright suite — 23 checks).
Bonus fixes: mock leftovers ("אלון", "PEER", "בתל אביב") in the footer,
thank-you card and area subtitle are now derived from the payload.
