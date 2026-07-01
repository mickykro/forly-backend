# Property Landing Pages — Design Doc (MVP)

**Status:** structure approved 2026-07-01 (see `template.html` — this is the level/quality bar for every generated page).
**Domain:** `nadlan.call4li.com` (Firebase Hosting custom domain).
**Tech:** plain static HTML/CSS/JS, no framework — same style as the carousel editor (`public/c/`).

## Locked decisions
- Suno song: **deferred to v2**. MVP ships without it.
- Data/render: mirror the carousel editor — Firestore compiled-payload doc + `get*` Function the page fetches; assets persisted to Storage; static page on Firebase Hosting.
- Trigger: **auto for every walkthrough** — hooks off WW1 completion in Business Handler Agents (feature 3).

## Page structure (approved template)
1. **Topbar** — agent brand (logo or styled text) + "לתיאום ביקור" CTA. Turns glassy on scroll.
2. **Hero** — dark, cinematic. Walkthrough video in gold-framed portrait card over a blurred ambient backdrop of itself; Claude hero phrase; live "סיור וידאו" badge; mute toggle; dual CTAs; scroll hint.
3. **Specs strip** — price / rooms+sqm / floor+view / parking. Serif gold numerals on dark.
4. **"למה דווקא כאן" carousel** — 4 scroll-snap cards (property USP, building amenities, why this agent, process) + agent strip (avatar/logo, name, license, CTA).
5. **Area section** — dark gold panel: neighborhood story, vertical distance-timeline ("map-line"), 4 stat tiles.
6. **CTA** — split panel: trust bullets + name/phone form (→ `/api/property-lead`) + WhatsApp button. Mock shows 🥂 success state.
7. **Footer** — brand + "נוצר אוטומטית ע"י Forly 🦉".
8. **Sticky mobile bar** — WhatsApp + תיאום ביקור, slides in after hero.

Design language: cream `#F7F3EC` / charcoal `#14110C` / gold `#B98A2F→#D9B15C`; Frank Ruhl Libre (display) + Heebo (body); IntersectionObserver reveals; subtle hero parallax; RTL Hebrew; mobile-first.

## Branding is data-driven (not baked into video)
Walkthrough videos may arrive **without** any logo/branding overlay. The page supplies all
branding and property info from the `property_pages/{id}` payload (see bind map in
`template.html` header). Never assume the video carries text.

## Agent logo
- Signup / create-property asks the agent for a logo.
- **If the agent has no logo → offer to generate one, free** (cheap for us; image-gen call).
- Store at `businesses/{phone}.logo_url`; page uses it in topbar, agent strip, footer.
- Fallback when no logo: styled serif text-mark from brand name (as in template).

## Data model — `property_pages/{pageId}`
```jsonc
{
  "page_id": "uuid", "listing_id": "uuid", "business_phone": "9725...",
  "status": "building|active|archived", "created_at": 0, "updated_at": 0,
  "agent":   { "name": "", "brand_name": "", "logo_url": "", "tagline": "", "phone": "", "license": "" },
  "property":{ "title": "", "address": "", "neighborhood": "", "city": "",
               "price": 0, "rooms": 0, "size_sqm": 0, "floor": 0, "parking": 0 },
  "hero":    { "phrase": "", "video_url": "", "poster_url": "" },
  "carousel":{ "slides": [{ "num": "01", "title": "", "body": "", "tag": "" }] },
  "area":    { "blurb": "", "stops": [{ "label": "", "minutes": "" }],
               "stats": [{ "value": "", "label": "" }] },
  "cta":     { "headline": "", "sub": "", "bullets": [""], "button_label": "" },
  "view_count": 0, "lead_count": 0
}
```
Storage: `property_pages/{id}/walkthrough.mp4` (**must keep audio track** — n8n/WW1 pipeline
must not strip it; the chat-upload test clip arrived with no audio stream), `poster.jpg`.

## Area Intelligence — automated neighborhood research

The area section is **not** filled by the agent — Forly is the expert. A research
step gathers real, sourced facts about the neighborhood from the open web.

### Key insight: cache per neighborhood, not per property
Many listings share a neighborhood. Research once, reuse for ~90 days.

- Firestore `area_profiles/{city}__{neighborhood}` (slugified, e.g. `tel-aviv__bavli`)
- Fields: `blurb`, `stats[{value,label,source_url}]`, `landmarks[]`, `sources[]`,
  `researched_at`, `expires_at (+90d)`
- Cost per profile: one Claude call with web search (~5-8 searches) — cents.
  Amortized across every listing in that neighborhood.

### Pipeline (inside n8n "Property Page Builder", or standalone "Area Intelligence" workflow)
1. **Normalize location** — Google Geocoding API on the property address →
   `{lat, lng, neighborhood, city}` (also powers the map image).
2. **Cache check** — `GET area_profiles/{slug}`; fresh → skip to step 5.
3. **Research call** — ONE Anthropic Messages API call, model `claude-opus-4-8`
   (runs once per neighborhood, so use the strong model), with the server-side
   web search tool — Claude does the searching itself, no scraping infra:
   ```jsonc
   {
     "model": "claude-opus-4-8",
     "tools": [{ "type": "web_search_20260209", "name": "web_search", "max_uses": 8 }],
     // prompt: research {neighborhood}, {city} for a real-estate landing page:
     //  - price/sqm + 5yr trend (prefer nadlan.gov.il / madlan / CBS)
     //  - schools & their reputation, parks, beach/transit access
     //  - development plans, "why people love it"
     //  - Respond in Hebrew. EVERY numeric stat must include its source URL.
   }
   ```
   Then one cheap follow-up call (or structured-output pass) to shape the answer
   into the payload schema.
4. **Source-or-drop rule (anti-hallucination)** — a stat without a `source_url`
   from an actual search result is DROPPED. Fewer real stats > invented ones.
   Store `sources[]` on the profile for auditability. Never show unsourced
   numbers to prospects (school "ratings" etc. must trace to a source).
5. **Per-property distances** — neighborhood profile is shared; distances are
   per-address: Google Distance Matrix from the geocoded point to a fixed
   landmark set (park, beach, Ayalon, nearest train/light-rail) → `area.stops[]`.
6. **Compose** — profile blurb+stats + property stops → `area` object in
   `property_pages/{id}`.

### Refresh & ops
- TTL 90d; scheduled n8n cron re-researches expired profiles (mirrors
  `cleanupExpiredDrafts` pattern).
- Manual override: `area_profiles/{slug}.locked=true` lets us hand-curate a
  profile (top neighborhoods deserve human polish) without the bot overwriting.
- Env: `ANTHROPIC_API_KEY` (existing), `GOOGLE_MAPS_KEY` (geocoding + distance
  matrix + static map — one key).


| Function | Trigger | Job |
|---|---|---|
| `createPropertyPage` | POST from n8n | persist assets → Storage, write `property_pages/{id}`, return `{page_id, page_url}` |
| `getPropertyPage` | GET `?id=` from page | return compiled payload (admin SDK) |
| `submitPropertyLead` | POST from form | create lead (`source: landing_page`, `listing_id`, `page_id`), `lead_count++`, WhatsApp agent via Green-API, hand into Forly Leads Handler (`vkfYpJL5KONzlbJN`) |
| `trackPropertyEvent` (opt.) | POST beacon | `view_count++`, scroll-depth |

Reuse: `setCors`, `uploadBuffer`, `downloadAndUpload`, `tokenedUrl`, Green-API axios pattern.

## n8n "Property Page Builder" workflow
- Trigger: ExecuteWorkflow from Business Handler Agents feature 3, right after `executeWW1Workflow`.
- Steps: Claude Sonnet structured call (hero_phrase, carousel slides, area blurb+stops+stats, cta copy)
  → `POST createPropertyPage` → WhatsApp `page_url` to agent ("🎉 דף הנכס שלך מוכן").
- Built **INACTIVE** until approved.

## firebase.json rewrites to add
```jsonc
{ "source": "/p/**",              "destination": "/p/index.html" },
{ "source": "/api/property-page", "function": { "functionId": "getPropertyPage",   "region": "europe-west1" } },
{ "source": "/api/property-lead", "function": { "functionId": "submitPropertyLead", "region": "europe-west1" } }
```

## Security ⚠️
Firestore rules are wide-open and expire 2026-03-27. The public page must never read
Firestore directly — all reads via `getPropertyPage` (admin SDK). Lock `property_pages`
to server-only before launch.

## Build order
1. Functions (`createPropertyPage`/`getPropertyPage`) + `public/p/` page bound to payload.
2. n8n Property Page Builder + auto-trigger off WW1.
3. `submitPropertyLead` + Green-API to agent + Leads Handler handoff.
4. v2: Suno song (muxed into video as soundtrack), analytics dashboard, real area data, logo generation flow.
