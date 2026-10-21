# WhatsApp Conversation Review — 2026-09-28

Daily review of real agent conversations with the Forly WhatsApp bot, pulled
directly from Green API (`getChats` / `getChatHistory` /
`lastIncomingMessages` / `lastOutgoingMessages`) for the account behind
`waInstance7105422200`. Goal: find concrete, low-risk fixes that reduce
wasted generations, improve the bot's understanding of free-text replies,
and surface requests the bot currently can't satisfy.

**Scope:** 9 conversations with activity on 2026-09-28 (Asia/Jerusalem),
145 messages total, out of 1,394 chats on the instance (most are dormant).
Agent names and phone numbers are anonymized below (`Agent A`, `Agent B`,
…) — this file intentionally contains no PII.

## How this maps to the codebase

The property-intake WhatsApp bot (`server/routes/whatsapp.js` +
`server/whatsapp-intake.js`) is mostly a **deterministic state machine**,
not an LLM chatbot: field answers, buttons, and commands are handled by
regex/command parsing with no model call. LLM calls only happen at two
points — parsing a pasted listing (`listing-extract.js` →
`chat-provider.ask`) and `smartAnswer` for messages that look like a
correction. There is **no caching/dedup** on either path and **no
persisted conversation transcript** in Firestore (only the live draft is
stored), which is why this review had to be built directly from Green
API's own history rather than internal logs. Findings below are anchored
in yesterday's real transcripts; the last section ties them back to
specific code paths.

## Findings

### 1. Paraphrased confirmations aren't recognized, so the bot silently repeats itself

**Agent A**, after uploading photos, was asked once:

> כל הפרטים והתמונות אצלי ✅
> לראות תצוגה מקדימה ולערוך לפני היצירה, או ליצור את הדף עכשיו?

They replied `תראה תצוגה מקדימה` ("show me the preview") — a natural
paraphrase of "תצוגה מקדימה". The bot didn't recognize it and **sent the
exact same prompt back verbatim**, with no acknowledgement that anything
was received. From the agent's side, this is indistinguishable from the
message not going through at all. Only after retyping the literal keyword
`תצוגה מקדימה` did the bot produce the review link.

This is the highest-value fix: the free-text branch points where the bot
accepts open text (skip/description, preview/create, design-template
choice) currently require close-to-exact keyword matches. A single
cheap LLM classification call (or even a small synonym/keyword table) on
just these few confirmation points — not a general NLU rewrite — would
remove a very visible "the bot is ignoring me" moment, without adding a
generation to every turn.

### 2. The bot contradicted itself about a real capability

Same agent, later, asked for a new video for a second property:

> אני רוצה שתיצרי סרטון חדש לנכס בנחל דליות 35

First reply: **"כרגע פורלי לא יוצרת סרטונים. אפשר ליצור תמונה, או לערוך
אחרת"** ("Forly doesn't currently create videos"). 11 seconds later, a
second, unprompted message: **"יוצרת לך סרטון... 🎬"** — and it did
generate one, successfully, moments later. The bot has generated four
videos for this same agent earlier in the same conversation, so telling
them the feature doesn't exist is a direct, checkable false statement
about the product's own capabilities — worse for trust than a slow
answer. This smells like two independent handlers reacting to the same
message (one canned/stale "we don't do video" response, one the real
deterministic video trigger) racing rather than one owning the intent.
Worth auditing the video-request branch in `whatsapp-intake.js` for a
duplicate/dead code path that still asserts the old capability set.

### 3. Video generation is slow and unpredictable, and failure recovery re-runs the whole pipeline

Render times observed yesterday ranged from ~3 minutes up to **18
minutes** (14:23 request → 15:18 completion, `getChatHistory` for Agent
E) with no progress update in between beyond the initial "⚙️ יוצרת
סרטון...". One agent explicitly complained the result didn't look good
("הסרטון לא נראה טוב מה עושים?"); the bot's own answer acknowledged the
external animation service is sometimes inaccurate, and offered a full
redo as the only recovery path — another multi-minute render, paid for
again, with no cheaper "preview frame" option first. Two concrete asks
here: (a) set expectations up front ("this can take up to ~15 min") so a
long silence doesn't read as broken, and (b) generate a cheap
first-frame/thumbnail preview before committing to the full render, so
a bad take can be caught (and retried) far cheaper than after a full
video generation.

### 4. Facebook auto-publish fails on media timing, and the recovery advice is expensive

**Agent D** hit: **"⚠️ '4 חד׳ בותיקים' לא פורסם — קובצי המדיה של הנכס
אינם זמינים לפייסבוק. בנו את דף הנכס מחדש ונסו שוב."** ("media files
aren't available to Facebook — rebuild the page and try again"). Telling
an agent to rebuild an entire property page (which re-triggers photo
processing and video generation) just to fix what looks like a CDN/media
propagation race with Facebook's scraper is a disproportionately costly
fix for what is likely a timing issue, not a real media problem. A
retry-with-backoff (or an explicit "media ready" check before attempting
the Facebook post) would avoid both the failure and the unnecessary full
rebuild it currently prescribes.

### 5. Identical boilerplate repeated turn-over-turn on back-to-back similar requests

**Agent C** sent four separate "make this look renovated" image-edit
requests in a row; the bot replied with the **same acknowledgement
sentence verbatim** each time ("עובדת על זה — מכינה גרסה משופצת עם
רהיטים מעוצבים..."). Functionally fine (each is a distinct image), but
it reads as robotic on a fast back-to-back exchange, and it's a small
example of the same root cause as the intake-parsing gap below: nothing
recognizes "this is the same kind of request as the last one" and varies
or shortcuts the response accordingly.

## Structural gaps behind these symptoms (from code review)

- **No caching/dedup on LLM calls.** Neither `listing-extract.js`'s
  listing parser nor `whatsapp-intake.js`'s `smartAnswer` hash or compare
  incoming text against the last request, so a resent or near-duplicate
  message always triggers a fresh paid generation.
- **No persisted WhatsApp transcript.** `db.js` only stores the live
  `property_drafts/{phone}` document, overwritten on every turn — there's
  no message log to query. Building this report required pulling raw
  Green API history rather than an internal query. Worth mirroring the
  web-chat bot's existing `property_pages/{id}/chats/{cid}` pattern
  (`server/routes/chat.js`) for the WhatsApp bot, so this kind of review
  doesn't require a one-off Green API pull each time.
- **No retry on transient provider failures** in `chat-provider.js` — a
  single failed call surfaces as an error rather than one retry.
- **Web chat (the separate on-page Q&A bot) resends up to 20 prior turns
  on every message** with no summarization, so generation cost scales
  with conversation length even when the actual new question is short.
- The team's own `chat-eval.js` already flags, in its own comments, the
  two most common real failure modes: "answering a different question
  than the one asked" and "inventing a persona" — consistent with the
  paraphrase-matching gap seen in finding #1.

## Recommendations, prioritized

1. Add lightweight fuzzy/LLM-assisted matching on the handful of
   open free-text confirmation points (preview/create, skip/description,
   design choice) so paraphrases resolve on the first try. (Finding 1)
2. Audit the video-request branch in `whatsapp-intake.js` for the
   conflicting "Forly doesn't make videos" response and remove/gate it
   so it can't fire once video generation is enabled. (Finding 2)
3. Set expectations on video render time in the initial "⚙️ יוצרת
   סרטון..." message, and evaluate a cheap first-frame preview before a
   full render to cut wasted re-renders. (Finding 3)
4. Replace the Facebook "rebuild the whole page" failure message with a
   readiness check/backoff before the FB publish call. (Finding 4)
5. Add request-hash based short-term caching to `listing-extract.js` and
   `smartAnswer` to avoid re-billing identical/duplicate input. (Structural)
6. Persist WhatsApp conversation turns (mirroring the web-chat
   `chats/{cid}` pattern) so future reviews use first-party data instead
   of a manual Green API pull. (Structural)
7. Trim/summarize older turns in the web-chat context window instead of
   resending the full history up to the 20-turn cap. (Structural)

## Methodology

- Data pulled via `getChats`, `lastIncomingMessages`, and
  `lastOutgoingMessages` (48h window) on `waInstance7105422200`, filtered
  to messages timestamped 2026-09-28 in Asia/Jerusalem.
- 9 of 1,394 chats had activity in the window; all 145 messages across
  those 9 chats were reviewed manually.
- No raw phone numbers, names, or message content beyond what's needed to
  illustrate each finding are included in this file.
