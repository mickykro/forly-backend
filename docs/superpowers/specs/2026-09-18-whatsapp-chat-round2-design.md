# WhatsApp property chat — round 2 (failure cases from the live run)

Date: 2026-09-18 · Branch: claude/whatsapp-link-property-page-7wm9xh · Status: approved

Server-side changes to the property chat (`server/whatsapp-intake.js`, `property-draft.js`,
`whatsapp-replies.js`, `routes/whatsapp.js`). n8n changes are listed at the end; the owner applies them.

## A. Input normalization (before the state machine)
- **Voice (#11):** body field `audio_url` → transcribe with fal `fal-ai/wizper` (`POST https://fal.run/fal-ai/wizper`,
  `Authorization: Key $FAL_KEY`, `{ audio_url, task: "transcribe", language: "he" }` → `text`). The transcript is handled
  as a typed message; the first reply is prefixed `🎙️ שמעתי: "<transcript>"`. Failure → "לא הצלחתי לשמוע, אפשר לכתוב?".
  Plain `fetch`, no `@fal-ai/client` dependency (same pattern as `overlay.js`).
- **Documents (#9):** `message_type === "documentMessage"` with an open draft → "שלחו את התמונה כתמונה (לא כקובץ)"; nothing stored.
- **Emoji (#16):** stripped before command matching ("✅ ליצור!" = "ליצור").

## B. Corrections and smart answers (#1, #2) — `server/draft-corrections.js`
- `/<field> <value>`: field = Hebrew label (`/מחיר 2.1 מיליון`) or code
  (`c` city, `p` price, `r` rooms, `d` deal, `s` size, `f` floor, `k` parking, `n` neighborhood, `t` description, `x` design).
  Value goes through the field's parser. Bare `/` lists current values and codes. After a correction the pending question is repeated.
- Smart answer: when the reply does not parse for the asked field, or carries hints for ≥ 2 fields, run it through
  `parseListing` (daily extract cap applies). Empty fields are filled; fields with a different existing value are held in
  `draft.pending_changes` and confirmed once ("להחליף: …?" כן/לא).

## C. Flow messages
- #3 review-link message lists skipped fields with the `/field` hint.
- #4 the choose question warns that "ליצור" builds immediately without a preview.
- #5 after preview, "ליצור" replies "ממשיכים בדף" and resends the link.
- #6 photo-timer reply is one message: count + next question.
- #7 over 12 photos: "שמרתי 12 (מקסימום) — N לא נשמרו".

## D. Links (#12, #13)
- Text around a link is extracted too and wins on conflicts. With ≥ 2 links the first is used and the reply says so.
- Unreadable/blocked link: a dedicated reply suggesting to paste the listing text or send "נכס חדש".

## E. Parsing (#14, #15)
- Prices: "2 מיליון ו-350 אלף", "₪2.35M", "2.35 מ׳", "ש״ח"/"שקל".
- Price below ₪20,000 on a sale, or above ₪100,000 on a rent → one confirmation question.

## F. Paused drafts (#17)
Draft silent ≥ 2 h: the agent's next message of any kind gets the resume prompt (המשך / חדש / ביטול).
ביטול deletes the draft and the message is left to the AI (not handled).

## G. Builds (#18, #21, #22)
- Sweep every 5 min: listings with `source: whatsapp` still building after 20 min → `status: failed`; the agent gets
  "הבנייה נכשלה" and the draft returns to create-ready so "ליצור" retries.
- Page ready: only the draft that built that listing is deleted (done in 31f26fd).
- Quota refusal on create → dedicated out-of-quota reply with the plan link.

## H. Review link (#20)
Dedicated `review` token (7 days) that authorizes only `/api/whatsapp/draft` and `/properties/create`; the cookie it sets
carries the same scope. Expired → Hebrew page "כתבו ״תצוגה מקדימה״ בצ׳אט לקישור חדש".

## Out of scope
#8 deleting a photo, #19 several agents on one number.

## Testing
Conversation cases per item in `whatsapp-intake.test.js`; parser units in `property-draft.test.js`; transcription and
extraction are injected deps (no network in tests). Live WhatsApp run with the judge after.

## n8n (owner applies)
1. Main Router: connect `Call 'Business Handler v4 copy'` → `IF - Was Batch?` (clears the photo lock).
2. BH v4 copy → `Forly Property Intake` body: add
   `audio_url: $json.rawWebhook?.messageData?.typeMessage === 'audioMessage' ? ($json.rawWebhook.messageData.fileMessageData?.downloadUrl || null) : null`.
3. BH v4 copy: `Forly Photo Offer (batch)`, `HTTP Request2`, `Forly Photo Offer (single)` → live tunnel host.
