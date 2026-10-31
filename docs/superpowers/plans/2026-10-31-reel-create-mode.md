# /reel = the demo create page + paywall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** `/reel` serves `public-agent/create.html` (the same page as the admin demo, `create.html?key=demo`) in a "reel mode". A visitor logs in by WhatsApp OTP, fills the exact same 3-step wizard (paste a link or text to auto-fill, agent details, photos, design), presses **המשך**, and is either built straight away or sent to Cardcom first. The listing always goes to the reel n8n workflow (`source: "reel_promo"`). `public-agent/reel.html` is deleted.

**Builds on:** the reel promo already on this branch (plan `docs/superpowers/plans/2026-10-30-reel-promo.md`):
- `server/routes/promo.js`: `/lead/start`, `/lead`, `/quote`, `/order`, `/cardcom/webhook`, `GET /order/:id`, and the admin routes;
- `server/promo.js`: `priceFor`, the store, `start()` transaction;
- promo-scope sessions (`server/auth.js` `PROMO_SCOPES`, `UPLOAD_SCOPES`);
- the admin "ריל" tab.

**Tech:** Node/Express 4 (`h()` wrapper for async handlers), Firestore via `server/db.js` with in-memory fallback, plain `node x.test.js` tests chained in `server/package.json` `test`, vanilla JS pages.

## Global Constraints

- **The reel creator must look EXACTLY like the demo create page (`create.html?key=demo`). The user marked this very important.**
  - It is the same file, rendered the same way: same header, same demo workspace note, same wizard, step indicator, fields, agent block, photo step, design step, preview, buttons, fonts, colors and spacing.
  - Reel mode adds **no new CSS and no restyling**.
  - The only additions are the OTP login card and the summary screen. Both are built only from markup and classes already used in create.html, such as its cards, `.field`, `.btn btn-gold`, the wizard panel and section titles.
  - The only removals are elements that cannot work for a stranger, listed in Task 3. Each is hidden with the page's existing `.hidden` class and leaves no gap.
  - The demo look comes from `isDemo` (create.html ~735, ~882-884, ~1401: agent block shown, DEMO note shown, agent name/phone required). So reel mode sets **`isDemo = !!demoKey || reelMode`**. Admin-only behaviour (`/api/admin/me`, `/api/admin/agent-profile`, `/api/admin/listing`, `/api/demo-save-agent`, and the `x-demo-key` header in `uploadHeaders` ~1072 and ~1020) moves behind **`adminDemo = !!demoKey`**. The three visual lines (~882-884) move out of the admin block so reel mode runs them too.
  - The DEMO note (`#demoWorkspaceNote`, ~153) stays visible with the same markup. In reel mode only its text changes, because "we save your details automatically" would be false (no autosave for strangers). Use the same elements: index "REEL / 01", title "בונים סרטון רילס ודף נכס.", body "ממלאים פרטים ותמונות, ובסוף מקבלים בוואטסאפ את הסרטון ואת הדף."
  - The agent phone `#agPhone` (~204) and country `#agCC` (~193) are prefilled from the session and set with `readOnly`, never `disabled` (disabled turns grey).
  - Allowed differences, the only ones: the login card and summary screen; the hidden elements listed in Task 3b; the DEMO note text; the stage-3 button text המשך; and the building screen without the groups iframe, retry button or posting offer, with a 45-minute wait.
  - The Task 4 browser check compares screenshots of `/reel` and `create.html?key=demo` side by side at 375px and desktop, step by step. Any other visual difference is a bug. The DOM test checks that reel mode adds no `<style>` and no class name absent from create.html.

- **Who pays** (the user's decision):
  - Admins (`ADMIN_PHONES`, decided only by `isAdmin(req.user)` on the server, never from the body) never pay and never consume a phone's free reel.
  - Existing paying clients (quota plan set and not `"trial"`): 1st reel ₪0, then ₪49.
  - Everyone else: ₪59 while the promo date is set, ₪219 after.
  - Prices come from the server only (`priceFor`).
  - Known limit (accepted): parallel unpaid orders are each priced at the first-reel price, because the counter moves only on start.
- **No button in reel mode says "pay"/"לתשלום".** The stage-3 button and the summary button both read **המשך**. Stage 3 shows no price; the price appears only on the summary screen.
- **Facebook links use the admin's account** (the user's decision), narrowed for safety:
  - Scrape admin = env `REEL_SCRAPE_PHONE`, default the first phone of `ADMIN_PHONES`.
  - For a promo-scope visitor, the admin's logged-in profile is used **only for Facebook group-post URLs** (`facebook.com/groups/<id>/(posts|permalink)/<id>`, including the `m.`/`www.` forms).
  - Every other Facebook URL (profiles, pages, group home pages) and every Instagram/TikTok/LinkedIn/X URL runs in the hosted browser with **no profile**.
  - Facebook page-post links, which today go to the Graph API with the visitor's own connection (409 for strangers), fall back to a no-profile browser job for promo visitors.
  - No scrape admin configured → 409 `login_required_for_browser`.
- **Admin-profile jobs run fully as the admin's profile.** extract-jobs stores `profile_owner`, and `runJobLocked` uses `job.profile_owner || job.phone` for the profile lock, `getConnection`, `profileNameFor` and the `phone` passed to `resolve`. `job.phone` stays the visitor, and is used only for the poll ownership check.
- **Scrape caps for promo visitors** (`DailyLimit` is per instance, so approximate):
  - per visitor phone: 10 extracts/day, 3 browser jobs/day;
  - a separate site-wide promo browser pool, `REEL_SCRAPE_DAILY_CAP`, default 20/day;
  - the admin's own `DRIVER_DAILY_CAP` is **not** charged by promo jobs;
  - admins, clients and the `x-demo-key` path behave exactly as today.
- **Promo scope may now call** `POST /api/properties/extract`, `GET /api/properties/extract/:job_id` (own jobs; that route takes `UPLOAD_SCOPES`) and `POST /api/photos/import-url`.
  - `import-url` gets the promo cap and must not follow redirects to non-public hosts: `redirect: "manual"`, re-checking `isPublicUrl` on each hop, at most 3 hops.
  - **DELETE /upload stays closed to promo.** In reel mode, removing a photo only drops it from the form (no server call).
  - Nothing else opens to promo.
- **`/api/promo/order` takes create.html's real body** (create.html ~1748-1782) through whitelists:
  - Listing fields: the existing `LISTING_FIELDS` + `size_built, size_balcony, size_garden, parking, storage, elevator, shabbat_elevator` + `theme`.
  - `theme` is itself whitelisted: template, colors, language, title… read from create.html. **`theme.font_url` is dropped.**
  - Agent: `agent.name`, `agent.brand_name`, `agent.license`, `agent.logo_url`. `agent_name` comes from `agent.name`; the phone is always the session's. `agent.phone`, `phone2`, `agent2`, `agent_phones` are dropped.
  - Never accepted: `own_video_url`, `listing_draft_id`, `replaces_listing_id`, `whatsapp_draft`.
  - Photos: at least **4**, enforced in promo.js (`validateListing` allows 3). Photo and logo URLs must start with `photoBase` and contain no `..`, `?` or `#`.
  - The 32 KB cap stays.
- **No business doc for strangers.** `/order` never calls demo-create and never writes `businesses/{phone}`.
- **Terms and consent stay as built:** the terms box gates the code; `terms_accepted:true` is required on `/lead/start` and `/order`; marketing consent is recorded only at `/lead` stage `verified`. The summary screen links `/legal/terms.html#reel`.
- **Cardcom return URLs stay as built:** `/reel?order=<id>` and `&failed=1`.
- Files under 500 lines. Reel-mode client code goes in a new `public-agent/reel-mode.js`; create.html gets only small hooks. No new npm deps.

**Operator to-do (not code):** `legal/terms.html` has no `#reel` section yet. The user must supply the cancellation/refund text before launch.

---

### Task 1: Scraper open to /reel logins (server)

**Files:**
- Modify: `server/routes/extract.js`, `server/extract-jobs.js`, `server/listing-sources.js` (if needed for the promo FB fallback), `server/index.js` (pass `reelScrapePhone`).
- Test: new `server/routes/extract-promo.test.js`, added to the `test` script.

- [ ] extract.js `auth`: keep the `x-demo-key` branch; otherwise accept `["session","review","promo"]` and set `req.promo` when the scope is promo. Apply the same to `/photos/import-url`. The poll route takes `UPLOAD_SCOPES`.
- [ ] Promo caps: 10/day extract per phone; 3/day browser jobs per phone; site pool `REEL_SCRAPE_DAILY_CAP` (env, default 20). Promo jobs don't charge the admin's `driverLimit`.
- [ ] Promo `queueDriverJob`:
  - group-post Facebook URL + scrape admin set → `profileName` from the admin's connection (`profileNameFor`), `profile_owner: reelScrapePhone`;
  - any other social URL → no profile;
  - FB page-post Graph route for a promo user → no-profile browser job.
- [ ] extract-jobs `create()` persists `profile_owner`. `runJobLocked` uses `job.profile_owner || job.phone` for lock, connection, profile name and the resolve phone.
- [ ] `import-url`: manual redirects with `isPublicUrl` per hop (max 3), plus the promo cap.
- [ ] Tests:
  - a promo token extracts text;
  - the 11th extract → 429;
  - a group-post job gets the admin profile + `profile_owner`, and the job owner is the visitor;
  - another phone polling → 404;
  - a promo Instagram/FB-profile URL → no profile;
  - the lock key is the owner;
  - the admin `driverLimit` is untouched;
  - a redirect to 127.0.0.1 is refused;
  - an admin session and the `x-demo-key` path behave as before.
- [ ] `npm test` in server/. Commit.

### Task 2: `/api/promo/order` takes the demo form; admins free (server)

**Files:**
- Modify: `server/routes/promo.js`, `server/promo.js` (`start` admin branch), `server/index.js` (pass `isAdmin`).
- Test: `server/routes/promo.test.js`, `server/promo.test.js`.

- [ ] Whitelists per the Global Constraints. Read the exact `theme` keys from create.html ~1748-1782.
- [ ] `build(order)` passes `{name, brand_name, license, logo_url, phone: order.phone}` to `createListing` the way demo-create builds its agent, without writing a business doc.
- [ ] Admins:
  - `/quote` → `{price:0, reason:"admin"}`;
  - `/order` → `start(id, {admin:true, by})`, which skips the free-reel decision and doesn't increment `promo_counters`;
  - the order is saved with `price:0, reason:"admin"`, and the lead is marked `paid`.
  - Admin is decided only by `isAdmin(req.user)`.
- [ ] Tests:
  - design/agent fields pass; forbidden ones (`font_url`, `agent2`, `phone2`, `own_video_url`, `agent.phone`) are dropped;
  - 3 photos → 400; a foreign photo/logo URL → 400;
  - admin → 0, the counter is unchanged, and two admin orders both build;
  - client 2nd → 49; stranger → 219, or 59 in the promo;
  - a body claiming admin has no effect.
- [ ] `npm test`. Commit.

### Task 3a: create.html reel mode — login and identical wizard (client)

**Files:**
- Create: `public-agent/reel-mode.js`.
- Modify: `public-agent/create.html` (hooks only), `server/index.js` (`GET /reel` and `/reel/` serve create.html).
- Delete: `public-agent/reel.html`.
- Test: new `public-agent/reel-mode.dom.test.js` (pattern of the existing `*.dom.test.js`), added to the `test` script.

- [ ] `reelMode = /^\/reel\/?$/.test(location.pathname)`. Split `adminDemo = !!demoKey` from `isDemo = adminDemo || reelMode` per the Global Constraints. Move lines ~882-884 so reel mode runs them. In reel mode, skip both the admin block (~846-880) and the `/api/profile` branch (~898).
- [ ] **Login card**, shown in place of `#viewForm` (like `#viewBuilding`) until logged in:
  - markup only from existing classes: `.creation-card`, `.field`, `.btn btn-gold`, and the checkbox markup of `#pStorage` for the terms and updates boxes;
  - phone, terms box (links to terms/privacy), optional updates box, OTP;
  - calls: `/api/promo/lead/start` → `/api/auth/otp` (purpose "reel") → verify → `/api/promo/lead` stage verified with consent;
  - skip the card if `GET /api/promo/quote` answers 200.
  - Any later 401 in reel mode shows the login card again; it never redirects to `/?next=`.
- [ ] After login: prefill `#agPhone`/`#agCC` from the session, `readOnly`. Change the DEMO note text per the Global Constraints.
- [ ] Hidden in reel mode, with the existing `.hidden` class:
  - the own-video card (~315) and font upload (~412) — the order drops `own_video_url`/`font_url`;
  - the "+ מספר נוסף" and "+ סוכן נוסף" buttons — the order drops `phone2`/`agent2`.
  - Nothing else is removed. "My properties" is already hidden in demo.
- [ ] Photo remove in reel mode only drops the photo from the form (no `FLY.deleteUpload`).
- [ ] The DOM test checks, in reel mode:
  - the agent block and DEMO note are visible;
  - the hidden list is hidden;
  - no admin endpoint is fetched and no `x-demo-key` is sent;
  - no `<style>` is added and no new class names.
- [ ] `npm test`. Commit.

### Task 3b: summary screen, order, Cardcom return, building screen (client)

**Files:**
- Modify: `public-agent/reel-mode.js`, `public-agent/create.html` (hooks only).
- Test: extend `public-agent/reel-mode.dom.test.js`.

- [ ] Refactor create.html's submit (~1719-1810) into `collectBody()`, which validates, waits for uploads and returns the body, and `send(body)`. Demo/client paths must behave exactly as before.
- [ ] Reel mode stage 3:
  - The button text is **המשך**, with no price on stage 3.
  - Click → `collectBody()` → show the **summary screen** in place of `#viewForm` (same classes as the login card): what they get, the price from `/api/promo/quote` (₪0 → "on us 🎁"), the line linking `/legal/terms.html#reel`, a **המשך** button and "← חזרה".
  - "← חזרה" brings back `#viewForm` on stage 3 with the button re-enabled.
- [ ] Summary המשך → `POST /api/promo/order` with the body + `terms_accepted:true`:
  - `pay_url` → redirect;
  - `listing_id` → `startBuildingScreen(listingId, false)`;
  - pending without Cardcom → "נחזור אליך בוואטסאפ";
  - errors use reel.html's Hebrew messages;
  - `409 already_used` → show the new price.
- [ ] Cardcom return:
  - `?order=` → poll `GET /api/promo/order/:id`, then the building screen when it has a `listing_id`;
  - `&failed=1` → lead `payment_failed` and "לא חויבת";
  - resume logged in.
- [ ] Building screen in reel mode: 45-minute cutoff; hide the groups iframe (~1885), retry button and posting offer; `#createAnother` → `/reel` without `?order=`.
- [ ] DOM test: stage 3 has no price; the summary shows it; both buttons say המשך; back works; demo-mode submit is unchanged.
- [ ] `npm test`. Commit.

### Task 4: Final check (controller)

- [ ] Final whole-branch review on the most capable model.
- [ ] Browser on `reel-local`, 375px + desktop: compare `/reel` vs `create.html?key=demo` step by step; only the allowed differences may appear. Then: paste text fills the fields; photos upload and remove; the summary shows the price; the admin phone builds free.
- [ ] Full `npm test` passes.
