# DEMO PLAN — "Property in, landing page out" (prospect-facing)

**Goal:** one flawless live demo: open the create-property page → upload photos +
property info + (demo-only) agent info → WW1 generates the walkthrough video →
landing page goes live at nadlan URL → WhatsApp pings the agent's phone with the
link — all while the prospect watches.

**This is a vertical slice of `IMPLEMENTATION-PLAN.md`** (phases 0/1/2-lite/3/4-create
only). Everything not needed for the demo is cut: no OTP auth, no dashboard list/edit,
no lifecycle/expiry, no web signup, no rules lockdown (page reads already go through
Functions), custom domain optional.

---

## The demo journey (what the prospect sees)

```
 1. Browser: agent.call4li.com create form (clean, branded, RTL)
 2. Fill: agent details (name/brand/logo/phone) + property details + drag in ~8 photos
 3. Submit → "🏗️ הדף בבנייה" progress screen (photos→video→copy→page steps animate)
 4. [~2-4 min: WW1 renders video; we narrate Area Intelligence researching the
    neighborhood with real sourced stats]
 5. 📱 The agent phone BUZZES: "🎉 דף הנכס שלך באוויר: nadlan.../p/xxx"  ← money moment
 6. Open the link on the phone: video hero, gallery, area stats with sources, CTA
 7. Bonus beat: prospect fills the lead form on THEIR phone →
    agent phone buzzes again: "🔔 ליד חדש!"                     ← second money moment
```

Two WhatsApp buzzes = the pitch. Everything serves those.

---

## Build phases

### D0 — Prep (local only, no approvals)
- Extract `functions/src/shared.ts` (uploadBuffer, downloadAndUpload, tokenedUrl,
  setCors, sendWhatsApp) — carousel behavior unchanged, build green.
- `functions/src/nadlan/types.ts` — PropertyPage/Listing interfaces (per master plan §0.4).
- firebase.json → multi-site (`app` untouched + `nadlan` + `agent` targets, master plan §0.2).
- Secrets: reuse GREENAPI_*; add `DEMO_SECRET` (gates the demo create endpoint);
  `GOOGLE_MAPS_KEY` goes to n8n only.
- Exit: `npm run build` green; emulator boots all targets.

### D1 — Page core (deploy gate #1)
- `nadlan/pages.ts`: `createPropertyPage` (idempotent per listing, re-hosts all assets
  to `property_pages/{id}/`) + `getPropertyPage` (60s cache header).
- `public-nadlan/p/` — approved template → payload-driven render (loading / active /
  404 states; gallery adapts to photo count; area stats show source links; agent
  logo or text-mark fallback).
- Emulator tests: seed script (emulator-guarded) + curl + Playwright screenshot
  vs approved mock @390px/@1440px.
- **Deploy #1** (needs approval): `firebase deploy --only functions:createPropertyPage,functions:getPropertyPage,hosting:nadlan`
  → verify a seeded page on `call4li-nadlan.web.app/p/{id}` on a real phone.
  (Owner console pre-step: create hosting sites `call4li-nadlan`, `call4li-agent`.)

### D2 — Demo create form (deploy gate #2)
- `nadlan/properties.ts`:
  - `getUploadUrls` — V4 signed PUT URLs to `agent_uploads/demo/{uuid}.jpg`
    (≤12 images, ≤10MB, gated by `DEMO_SECRET` header instead of JWT for now).
  - `demoCreateProperty` — POST `{secret, agent{name,brand,logo_url,phone,license},
    property{address,city,neighborhood,price,rooms,size_sqm,floor,description},
    photos_urls[]}` → validate → write `listings/{uuid}` (`source:"dashboard"`)
    → POST WW1 webhook `{listing_id, business_phone, photos_urls}` → `{listing_id}`.
    (Demo-only sibling of the real `createProperty`; same body shape so swapping in
    JWT auth later is trivial.)
- `public-agent/`: `create.html` + `app.css/js` — same design language as the page
  (gold/cream/charcoal, Heebo/Frank Ruhl, RTL): agent block (with logo upload),
  property block, drag-drop photo grid with per-file progress + reorder, submit →
  building screen with animated step tracker (photos ✓ → וידאו 🎬 → תוכן ✍️ → דף 🚀;
  polls `listings/{id}.page_id` via a tiny `getListingStatus` endpoint, flips to
  "✅ הדף באוויר" + link when set). Demo access via `?key={DEMO_SECRET}` in URL.
- **Deploy #2**: `firebase deploy --only functions:getUploadUrls,functions:demoCreateProperty,functions:getListingStatus,hosting:agent`

### D3 — n8n pipeline (the engine)
- Build **Property Page Builder** workflow (INACTIVE) exactly per master plan §3.1
  (16 nodes): fetch listing+business → area profile cache→ Opus+web_search research
  (source-or-drop) → Geocode+Distance Matrix → static map (downloaded & re-hosted;
  key never public) → Sonnet copy call → `POST createPropertyPage` → Green-API
  page link to agent → error branch to admin WhatsApp.
  - For the demo, agent data comes from the FORM (stored on the listing doc), so
    node 3 falls back to listing.agent when `businesses/{phone}` is absent.
- **WW1 edit** (approval gate): present exact node diff, then append
  `ExecuteWorkflow → Property Page Builder {listing_id, business_phone, video_url}`
  with `continueOnFail` so WW1 delivery can never break.
  - While inside WW1: confirm the output video **keeps its audio track**.
- Activate builder → `test_workflow` with pinned listing data until green.

### D4 — Lead ping (second money moment)
- `nadlan/leads.ts`: `submitPropertyLead` (validate, throttle 3/phone/hour,
  `lead_count++`, WhatsApp the agent, forward to Leads Handler webhook) — page form
  already designed for it. `trackPropertyEvent` optional; include if trivial.
- **Deploy #3**: `firebase deploy --only functions:submitPropertyLead,hosting:nadlan`

### D5 — Dry runs + demo kit
- **Three full dress rehearsals** on different days: form → buzz → page → lead buzz.
  Time each leg; target <4 min form-to-buzz.
- **Demo assets folder** (`docs/property-landing-page/demo-kit/`): 8–10 great photos
  of a real (or staged) Tel Aviv property, agent logo, pre-written property details —
  so the live demo types fast and looks premium.
- **Demo script** (1 page): choreography + talking points per minute of video-gen
  wait (area intelligence with real sources = the filler that sells expertise).
- **Fallback plan**: a pre-generated page for the same property kept live; if live
  generation hiccups mid-demo, pivot: "הנה אחד שהכנו קודם" and show the WhatsApp
  message received earlier. Also: pre-warm functions 10 min before (one seeded call),
  check Green-API + n8n health, phone charged + notifications loud.
- Optional polish if DNS is done by then: real `nadlan.call4li.com` URLs in the
  WhatsApp message (`PAGE_BASE_URL` env flip). `web.app` URLs are the fallback.

---

## Cut list (explicitly NOT in the demo)
OTP login · property list/edit dashboard · 30-day lifecycle/reminders · web signup ·
rules lockdown · leads inbox · Suno. All resume per `IMPLEMENTATION-PLAN.md` after
the demo; nothing in the slice blocks them (demoCreateProperty swaps to JWT later).

## Owner dependencies
| Item | Needed by | Blocking? |
|---|---|---|
| Approval: hosting sites creation + deploy #1 | D1 | yes |
| GOOGLE_MAPS_KEY (Geocoding+Distance Matrix+Static Maps) | D3 | yes |
| Approval: WW1 one-node diff | D3 | yes |
| Deploy approvals #2, #3 | D2/D4 | yes |
| Demo agent phone number (receives the buzzes) | D3 | yes |
| Property photos for demo-kit (or I use tasteful stock) | D5 | no |
| DNS for nadlan/agent.call4li.com | D5 polish | no |

## Risks & mitigations
- **WW1 duration variance** (Seedance): rehearse timing; building screen + narration
  absorbs up to ~5 min; fallback page beyond that.
- **Green-API hiccup**: health-check before demo; fallback = show the earlier message.
- **Area research quality** for the chosen neighborhood: pre-run it in rehearsal —
  profile gets cached, so the live demo reuses the good cached profile (faster AND safer).
- **Silent video**: verified in D3; if Seedance output is mute, demo property gets
  a licensed track muxed in the WW1 ffmpeg step (also solves the general case).
