# WhatsApp property chat: link, text, photos or keyword → property page

**Date:** 2026-09-12
**Branch:** claude/whatsapp-link-property-page-7wm9xh
**Issue:** #43
**Status:** approved design, not yet implemented (the branch holds a link-only first cut this design replaces)

## Problem

Agents live in WhatsApp. The create form (`public-agent/create.html`) is a context switch. An agent
should be able to drop a listing link, paste a listing, send photos, or just say "נכס חדש" in the
Forly WhatsApp chat and end up with a property page, with Forly asking only for what is missing.

## Decisions

| Question | Decision |
|---|---|
| Where the conversation logic lives | Forly server. n8n forwards every registered-agent message to one endpoint and stops when the server says it handled it. The server keeps a per-agent draft in Firestore and sends every reply itself over Green API. |
| Entry points | (1) a listing link, (2) free text that looks like a listing, (3) the keyword נכס חדש / דף נכס, (4) after a bulk photo edit in n8n, an offer to build a page from the edited photos. |
| Questions | Ask every missing field of the extractor's set (city, price, rooms required; sale/rent, size, floor, parking, neighborhood, description optional) one at a time; דלג skips an optional one. |
| Photos | Collected until 3+. After photos stop for ~20 s (or any text arrives) the bot says how many it has and offers ממשיכים. |
| Confirmation | Summary + לבנות? with buttons כן / ביטול before a walkthrough unit is consumed. |
| Draft life | One draft per agent. 2 h without a message → paused: chat routing returns to normal, data kept. A new opener while a paused draft exists asks: המשך / חדש. ביטול deletes at any time. |
| Ready notification | Unchanged: the n8n Property Page Builder WhatsApps the page link. |
| Language | Hebrew only. |
| Out of scope | Editing an existing page from chat. Video upload from chat. Non-Hebrew copy. |

## n8n contract

Business Handler2 (`V44w39VTt691WGxK`), before `AI Agent - Business1`:

```
HTTP Request  POST {BASE_URL}/api/whatsapp/intake   header x-forly-secret: {N8N_WEBHOOK_SECRET}   timeout 90 s
body {
  "phone":        "<digits>",
  "message":      "<text or selected button text or ''>",
  "message_type": "<Green API typeMessage>",
  "file_url":     "<messageData.fileMessageData.downloadUrl or null>"
}
IF {{ $json.handled }} is true → end.  Else → AI Agent as today.
```

After the bulk image edit finishes (the batch path), one more call:

```
POST /api/whatsapp/intake  { "phone": "<digits>", "event": "photos_edited", "photos": ["<url>", ...] }
```

Response in both cases: `{ handled, status, reply, replied, listing_id }`. `replied:false` means Green
API is not configured on the server; n8n should then send `reply` itself.

[Unverified] Green API field names for image messages (`fileMessageData.downloadUrl`) and button replies
(`buttonsResponseMessage.selectedButtonText`) are taken from Green API docs, not from a captured
payload. Task 1 of the plan confirms them on a real message before anything depends on them.

## Server design

### Draft document `property_drafts/{phone}`

```
{
  phone, status: "offered" | "active" | "resume_prompt" | "building",
  source: "link" | "text" | "keyword" | "photos",
  fields: { address, city, neighborhood, deal, price, rooms, size_sqm, sqm_built, sqm_balcony,
            sqm_garden, floor, parking, elevator, shabbat_elevator, storage, description },
  skipped: ["floor", ...],          // optional fields the agent skipped
  photos: ["https://.../files/<uuid>.jpg", ...],   // Forly-hosted only
  pending_opener: null | { message, file_url, photos },   // held while asking המשך / חדש
  listing_id: null | string,
  created_at, updated_at
}
```

"Paused" is derived, not stored: `status === "active"` and `updated_at` older than 2 h. An `offered`
or `resume_prompt` draft older than 2 h is dropped on read.

### Claim rules (server decides `handled`)

| Draft state | Message | Result |
|---|---|---|
| none | link / listing-like text / keyword | open draft, extract, ask first question → handled |
| none | photo, other text | handled:false |
| none | `photos_edited` event | draft `offered` with the photos, send offer (כן / לא) → handled |
| offered | כן | activate, next question → handled |
| offered | לא | delete → handled |
| offered | anything else | handled:false (draft stays until 2 h) |
| active | any text, photo, button | handled (see turn order) |
| paused | opener or `photos_edited` | `resume_prompt`, ask המשך / חדש → handled |
| paused | anything else | handled:false |
| resume_prompt | המשך | back to active, replay nothing, ask next question |
| resume_prompt | חדש | delete, open a fresh draft from `pending_opener` |
| building | opener | replace with a new draft; other messages handled:false |

Listing-like text: 40+ characters and at least two of: חדרים, חד׳, מ״ר, מ"ר, קומה, למכירה, להשכרה,
₪, מחיר, שכירות. Keyword: the whole message is one of נכס חדש, דף נכס, דף חדש.

### Turn order inside an active draft

1. Opener with link or text: resolve (Firecrawl / Graph) → `parseListing` → fields; source photos
   imported to Forly storage; description from the source. One extraction per opener, capped at 20
   per agent per day.
2. Commands win over answers: ביטול, דלג, ממשיכים, כן, לא.
3. `nextStep(draft)`:
   - `ask <field>` for the first field in order that is empty and not skipped:
     city, price, rooms, deal, size_sqm, floor, parking, neighborhood, description.
   - `photos` while fewer than 3 photos.
   - `confirm` otherwise.
4. Answers are parsed per field without the LLM: price accepts `2,900,000`, `2.9M`, `2.9 מיליון`,
   `890 אלף`; rooms accepts fractions; size/floor/parking integers; deal by keyword (למכירה, מכירה →
   sale; להשכרה, שכירות → rent); city, neighborhood, description as text (caps 60 / 60 / 2000).
   An unparseable answer re-asks with a hint. דלג on a required field re-asks ("חובה").
5. Photos step: each photo is imported immediately and stored silently. The route arms a 20 s
   timer per phone; when it fires (or when any non-command text arrives), the bot sends
   "יש לי N תמונות" with a ממשיכים button (only when N ≥ 3; otherwise it asks for more).
6. Confirm step: summary of fields + photo count, buttons כן / ביטול. כן → quota consume
   (`walkthroughs`, source `whatsapp`) → `createListing` → status `building`, reply "אני בונה".
   Quota blocked → the ledger's message, draft stays at confirm.
7. The page builder deletes the draft when it sets the listing's `page_id` (routes/pages.js).

### Replies

All copy lives in `server/whatsapp-replies.js` and returns `{ text, buttons? }`. Buttons go through
`sendWhatsAppButtons`; on failure the same text is sent plain. Button texts equal the command words so
a button tap and a typed word are handled identically.

### Errors

- Unreadable link / Facebook not connected / extractor down: reply with the reason; the draft stays
  open and empty so the agent can paste text or send photos instead.
- A photo that fails import is skipped and not counted.
- Green API down: replies are still returned in the HTTP response for n8n to send.
- Unknown sender: handled:false, nothing sent, nothing stored.

## Code layout

| File | Responsibility |
|---|---|
| `server/property-draft.js` (new) | Pure: field order, answer parsers, opener detection, `nextStep`, `applyAnswer`, `isPaused`, summary data. |
| `server/whatsapp-replies.js` (new) | Pure: every Hebrew message as a function returning `{ text, buttons? }`. |
| `server/whatsapp-intake.js` (rewrite) | `handleTurn(input, deps)`: the claim rules and turn order; no I/O except through `deps`. |
| `server/routes/whatsapp.js` (rewrite) | The endpoint: auth, load business + draft, call `handleTurn`, persist, send replies, photo timer. |
| `server/db.js` | `getDraft`, `saveDraft`, `deleteDraft` (Firestore + in-memory). |
| `server/routes/pages.js` | Delete the draft when the page is created. |
| `server/listing-create.js` | Unchanged (from the first cut). |

## Testing

Plain node tests like the rest of `server/*.test.js`:

- `property-draft.test.js`: parsers (each accepted price form, fractions, deal keywords, garbage →
  null), opener detection, `nextStep` order with filled and skipped fields, `isPaused`.
- `whatsapp-intake.test.js`: full turns with fake deps: link → questions → photos → confirm → build;
  keyword start; photos_edited offer accepted / declined; pause and resume / new; ביטול; quota
  blocked and retried; unknown sender; photo with no draft is not handled.
- `routes/whatsapp` is exercised in-process once (403 / 400 / handled:false / one happy turn).
