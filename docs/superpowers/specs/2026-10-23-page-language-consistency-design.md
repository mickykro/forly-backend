# Page language consistency — design

Date: 2026-10-23 · Status: approved in brainstorming, pending spec review

## Problem

Customers report that a page set to one language (e.g. French) still shows text in
another language, and that English typed into the form shows up untranslated in
the walkthrough video. The page language is chosen once on create
(`listing.language` / `page.language`, one of he/en/ar/ru/es/fr).

What already works: `server/page-translate.js` translates every visible page field
into the page language right before the page is first saved
(`server/routes/pages.js:354`), and template chrome is translated by
`public-nadlan/templates/i18n.js`.

Leaks found:

1. **Video end titles** — `buildTitles` (`server/walkthrough-plan.js:225`) is
   hard-coded Hebrew plus neighborhood/city as typed. A French page gets Hebrew
   titles; a Hebrew page with English input gets mixed titles.
2. **Edits are never translated** — the edit page (`server/edit.js`
   `buildEditPatch`) and the WhatsApp update (`server/page-update.js`, incl. the
   Hebrew `autoTitle`) save text as typed.
3. **Silent translation failure** — >80 fields, a timeout or a refusal leaves the
   page in the input language with no record.
4. **Untagged chrome** — some fixed Hebrew strings in the templates and
   `runtime.js` (e.g. `aria-label="סיור וידאו"`, `"הצצה"`, lightbox labels) have no
   `data-i18n`.

## Scope

In: new pages are fully in the page language (text + video titles); edits stay in
the page language; translation status is visible and re-runnable from the admin
panel for chosen pages.

Out (separate projects): picking the page language from the visitor's device;
WhatsApp property flyer. Also out: re-burning video titles on existing pages
(the untitled cut is not stored — decided not to start storing it), manual
translation editing, glossary, global on/off switch.

## Design

### Shared translator

Extract from `page-translate.js`:

```
translateFields(lang, { key: text }, deps) → { key: text } | null
```

One Claude call, same request/validation as today (`buildRequest`, `readReply`),
fail-open (returns `null`). `translatePage` becomes `collect` → `translateFields`
→ `setPath`. All callers below use `translateFields`; no second translation path.

### A. Video titles

`POST /api/walkthrough/plan` (`server/routes/walkthrough.js`) already receives
`listing_id`. Look up the listing, take `sanitizeLang(listing.language)`
(missing → `he`, today's behavior). Build titles as today, then pass
`{ title_1, title_2 }` through `translateFields` into that language. Skip the call
for `he` when the titles contain no foreign script (reuse `alreadyIn`). On any
failure keep the Hebrew titles — the video is never blocked.

### B. Edits

Before saving, translate only the changed text values into `page.language`:

- Edit page: the dot-path patch from `buildEditPatch` — translate its string
  values and the text members of array values (slides, stops, stats, captions,
  bullets). Agent name / brand name are not translated (people's and company
  names), consistent with the current prompt.
- WhatsApp update: the `pagePatch` passed to `updatePageData`
  (`server/routes/whatsapp.js:140`); covers the Hebrew `autoTitle` and place
  names (place names go to `place_i18n`, as on create).

Fail-open: on failure the patch is saved as typed and the status (D) is marked
`failed`.

Known effect: text the agent deliberately writes in another language is
translated to the page language.

### C. Template chrome

Tag every remaining fixed string (text and `aria-label`) in the 10 HTML templates and
`runtime.js` with `data-i18n` / an i18n key, with values in all 6 languages in
`i18n.js`. Bound placeholders (`data-bind`) are not touched — they are replaced
at runtime.

### D. Status record

`translatePage` and the edit paths write `page.translation =
{ status: "ok" | "failed" | "skipped", reason, at }`. Raise the 80-field cap by
splitting large pages into two calls instead of skipping.

### E. Admin panel

Extend the existing properties table (`GET /api/admin/properties`,
`public-agent/admin.js`):

- columns: page language, translation status;
- a **Re-translate** button on rows that are non-Hebrew or not `ok`, calling new
  `POST /api/admin/page/retranslate` (`requireAdmin`), which loads the page,
  runs `translatePage`, saves, and returns the new status.

Text only. Wrong titles in an existing page's video are fixed with the existing
Retry action (full Seedance cost).

## Testing

- `translateFields`: unit tests with the stubbed client, as in
  `page-translate.test.js` (ok, refusal, bad reply, split for >80 fields).
- Walkthrough titles: French listing → French titles; Hebrew listing with English
  place names → Hebrew; translation failure → Hebrew titles, plan still returned.
- Edit paths: only changed fields sent; names untouched; failure saves as typed.
- Templates: a test renders each template with a French fixture and fails on any
  Hebrew letter outside bound fields.
- Admin route: non-admin → 403; re-translate updates `translation.status`.

## Open item to verify during planning

`edit.js` writes gallery `caption`, while `collect` translates gallery
`description`. Check which field the templates render and translate that one.
