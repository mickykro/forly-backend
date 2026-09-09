# Property intake: free text, links, and Facebook posts

**Date:** 2026-09-08
**Branch:** claude/property-form-streamline-8909d7
**Status:** implemented on claude/property-form-streamline-8909d7

## Problem

Agents say the property creation wizard (`public-agent/create.html`) is too long.
Most of the information already exists somewhere: a WhatsApp message, a Yad2 or
Madlan listing, a post on the agency's Facebook Page. Forly should take that
source, extract what it can, and ask only for what is still missing.

## Decisions made

| Question | Decision |
|---|---|
| Interaction model | Hybrid: extract, pre-fill the existing form, show one "Forly needs a few more details" card with only the empty fields. Full form stays reachable. |
| Placement | Step 1 opens with the free-text / link input. "Fill the form manually" reveals the current fields. |
| What counts as missing | address, city, price, rooms, size_sqm, floor, deal (sale/rent), parking, neighborhood. Plus agent name and phone in demo mode. |
| Description | The raw pasted text (or scraped description) is copied into the description field as-is. No rewrite. |
| Extraction | New server endpoint using the existing `ask()` in `server/chat-provider.js`. |
| Yad2 / Madlan / other URLs | Firecrawl scrape API behind a small adapter. Any public URL, not a site whitelist. |
| Facebook URLs | Graph API through the agent's already-connected Page token (`server/distribution/meta.js`). Personal profiles and groups are not supported. |
| Photos found in a source | Shown as pre-selected thumbnails the agent can untick. Imported server-side only on Continue. |
| Out of scope | Bulk crawl of a whole site (future phase). Posting to Facebook Groups (dead end, Meta does not grant the permission). |

## User flow

1. Step 1 shows one large input: "Paste the listing text or a link". Button: "Let Forly fill it in". Below: a link "Fill the form manually" that reveals the existing fields.
2. On click the client detects whether the input is a URL or text and POSTs to `/api/properties/extract`. Button shows a spinner. Existing fields are hidden until the response arrives.
3. On success:
   - Every returned field populates the matching input. Only empty inputs are written; a hand-typed value is never overwritten, so re-running the parse on edited text is safe.
   - The description input receives the raw text (text source) or the scraped description (URL sources).
   - A card "Forly needs a few more details" lists the still-empty inputs from the missing set. These are the real inputs moved into view, not copies, so existing validation on Continue is unchanged. A "Show all details" link expands the rest of the form.
   - If nothing is missing the card reads "All set" and Continue receives focus.
   - If the response carries photos, a "Photos found" strip shows them as pre-selected thumbnails. They ride into step 2 next to manual uploads.
4. On failure the form falls back to manual entry with a one-line notice. Creation is never blocked by the extract feature.

## Server components

All new files live in `server/`. Each stays under 500 lines and has a plain `node:test` file next to it, like the rest of the directory.

### `server/listing-extract.js`

LLM extraction. Exports `parseListing(text, {ask, model}) -> {fields, missing}`.

- Model from `PROPERTY_PARSE_MODEL`, default `claude-haiku-4-5-20251001`. Routed through `ask()` so Gemini or OpenAI work by changing the id.
- System prompt: extract only what is explicitly stated, never guess, `null` when absent, numbers as numbers, price in ILS with "M" / "מיליון" / "אלף" expanded, Hebrew and English input.
- Output schema: `address, city, neighborhood, deal, price, rooms, size_sqm, sqm_built, sqm_balcony, sqm_garden, floor, parking, elevator, shabbat_elevator, storage`. `deal` is `"sale"` or `"rent"` and maps to the existing `#pType` select. Types match the form inputs.
- The reply is parsed as JSON. Each field is coerced to its schema type or dropped. Unknown keys are dropped.
- `missing` is computed by the server from the decided list, never taken from the model.
- Input capped at 4000 characters before the call.

### `server/listing-sources.js`

Turns an input into `{text, description, photos: [{url, source}], source}`. Exports `resolve({text, url}, deps)`.

- **Router**: `text` present → `plain`. `url` host matches `facebook.com` / `fb.com` / `fb.watch` → `facebook`. Any other URL → `firecrawl`.
- **SSRF guard**: reject URLs whose host resolves to loopback, link-local, private ranges, or the metadata endpoint. Reject non-http(s) schemes.
- **plain**: returns the text, no photos.
- **facebook**: parse the post id from the common URL shapes (`/posts/<id>`, `/<page>/posts/<id>`, `story_fbid=`, `/photo?fbid=`, `pfbid…` slugs). Look up the agent's connected Page token via the existing token vault. Call Graph `/<post-id>?fields=message,attachments{media,subattachments{media}}`. Text is `message`; photos are every image URL in attachments. No connected Page → error `facebook_not_connected`. Graph auth error → reuse the existing reconnect signal.
- **firecrawl**: `POST https://api.firecrawl.dev/v1/scrape` with `{url, formats: ["markdown"]}` and `FIRECRAWL_API_KEY`. Text is the markdown. Photos are image URLs from the markdown, filtered to plausible listing images (skip icons, logos, tracking pixels by size hints or path). Empty markdown or a challenge page → error `page_unreadable`. Adapter is one function so ScraperAPI can replace it later.
- Every external call has a 10 second timeout.

### Route `POST /api/properties/extract`

New router `server/routes/extract.js` mounted like the others in `server/index.js`. Not added to `server/routes/intake.js` (already 298 lines, and "intake" there means uploads). Auth like the upload routes: an `x-demo-key` header passes (demo wizard), otherwise `requireAuth`. Facebook source needs a logged-in agent, so demo callers get `facebook_not_connected`.

Request: `{text}` or `{url}`, exactly one.

Response 200:

```json
{
  "source": "text" | "facebook" | "scrape",
  "fields": { "address": "Dizengoff 40", "city": "Tel Aviv", "price": 2900000, "rooms": 3, "size_sqm": null, "floor": 4, "deal": "sale", "parking": 1, "neighborhood": null, "elevator": true, "storage": null, "sqm_balcony": null, "sqm_garden": null },
  "missing": ["size_sqm", "neighborhood"],
  "description": "…raw text or scraped description…",
  "photos": [{ "url": "https://…", "source": "facebook" }]
}
```

Errors: `400 invalid_input`, `409 facebook_not_connected`, `422 page_unreadable`, `429 extract_limit`, `503 extract_unavailable` (no LLM key or provider failure).

Budget: per-account daily cap of 30 extract calls, kept in an in-process `Map` keyed by account and UTC date. Approximate across Cloud Run instances, which is fine for a bill guard; move to a Firestore counter only if abuse shows up.

### Photo import on Continue

Uploads today go through signed URLs (`/api/upload-urls` in `server/routes/intake.js`). For found photos the client calls a new `POST /api/photos/import-url` (same router as extract) with `{url}` per ticked thumbnail; the server fetches the image with the SSRF guard, enforces the same size and content-type limits as an upload, stores it, and returns the same `{url}` shape the client already stores for uploaded photos. Nothing is stored at extract time.

## Form changes (`public-agent/create.html`, `public-agent/form-i18n.js`)

- New step 1 block: textarea, "Let Forly fill it in" button, "Fill the form manually" link, missing-details card, photos-found strip. Hebrew and English strings added to `form-i18n.js`.
- A `fillFields(fields)` helper that writes only into empty inputs.
- A `showMissing(missing)` helper that moves the listed inputs into the card and shows "All set" when empty.
- URL detection client-side (`/^https?:\/\//`) decides between `{text}` and `{url}`.
- Photos-found thumbnails are pre-checked; unticked ones are dropped before Continue.
- `create.html` is already 1344 lines. The new extract logic goes in a new `public-agent/extract.js` rather than inline, and `create-wizard.test.js` covers the helpers.

## Error handling

| Case | Behaviour |
|---|---|
| No LLM key, provider error, unparseable JSON | 503, form shows "Forly couldn't read that, fill in manually" and reveals the fields. |
| Firecrawl blocked / empty page | 422, "Couldn't read that page, paste the listing text instead", textarea focused. |
| Facebook Page not connected | 409, card with the existing "Connect Facebook" button and a paste-text alternative. |
| Facebook token dead | Existing reconnect flow. |
| Daily cap hit | 429, manual form. |
| Photo import failure for one URL | That photo is skipped with a notice; the rest continue. |

## Testing

Plain `node --test`, stubbed network, no live keys:

- `listing-extract.test.js`: coercion of every field type, dropped unknown keys, `missing` computation, Hebrew price forms ("2.9 מיליון", "890 אלף"), 4000-char cap, malformed JSON → throws `extract_unavailable`.
- `listing-sources.test.js`: router by host, SSRF rejections, Facebook post id parsing for each URL shape, Graph response → text and photos, `facebook_not_connected`, Firecrawl adapter happy path and `page_unreadable`, image filtering.
- Route test: request validation, error codes, daily cap.
- `create-wizard.test.js`: `fillFields` writes only empty inputs, `showMissing` moves the right inputs, "All set" state, URL detection.

## Cost notes

- LLM: one Haiku call per extract, under a cent.
- Firecrawl: 1 credit per plain page, 5 with stealth proxy (likely needed for Yad2). Free tier is a one-time bucket, so production needs the Hobby plan (about $16/month for 3,000 credits at the time of writing; confirm on firecrawl.dev/pricing).
- Facebook: free, official API.

## Future work (not in this spec)

- **Bulk import from a site**: Firecrawl `/crawl` over an agency site, returning many listings, with a review screen before creating them. Needs its own design.
- Facebook Groups distribution was investigated and dropped: Meta does not grant `publish_to_groups` to new apps.
