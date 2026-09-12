# Chatbot lead qualification and budget-based recommendations

**Date:** 2026-09-12
**Branch:** claude/chatbot-budget-financing-questions-5en12g
**Issue:** #42
**Status:** approved design, not yet implemented

## Problem

The landing-page chatbot answers from page facts and hands off to a name+phone
form when it cannot answer. The agent gets a WhatsApp with the unanswered
questions and nothing else. Agents want three more things on every chat lead:
budget, timeline and financing. And when the visitor's budget does not match
the page, the bot should point them at other listings of the same agent that do.

## Decisions made

| Question | Decision |
|---|---|
| Where the three questions are asked | In the lead form only. The model prompt is not changed to ask anything. |
| When the form is offered | As today, when the bot cannot answer. Additionally, once per conversation after N answered turns (`limits.offer_form_after_msgs`, default 3) if no form was shown yet. |
| Field format | Budget: number in ₪, monthly on rent pages. Timeline: select. Financing: select. |
| Required | Budget is required. Timeline and financing are optional. Name and phone stay required. |
| Match rule | Same agent (`business_phone`), same `listing_type`, page status `active` or `expiring`, `portfolio_visible !== false`, price within ±15% of budget, current page excluded, at most 3, sorted by distance from budget. |
| Who sees the matches | The visitor, as link cards in the chat after the form submits. The agent, as a list in the WhatsApp lead message. |
| How matches are produced | Deterministic server code, no model call. The model never sees or writes recommendations. |
| No match | The chat shows only the existing "thanks, passed to the agent" line. No apology bubble. |
| Dashboard | Out of scope. There is no agent-facing leads list today; WhatsApp is the agent's channel. |
| Agency mirror pages (#38) | Out of scope. Matching uses `listPagesByPhone` only. |

## Enumerations

Timeline: `now`, `1_3m`, `3_6m`, `6m_plus`, `looking`.
Financing: `mortgage`, `pre_approved`, `cash`, `selling_first`, `unsure`.

Hebrew labels, used in the form and the WhatsApp message:

| Key | Label |
|---|---|
| now | מיידי |
| 1_3m | 1-3 חודשים |
| 3_6m | 3-6 חודשים |
| 6m_plus | מעל חצי שנה |
| looking | רק מתעניין/ת |
| mortgage | צריך/ה משכנתא |
| pre_approved | יש אישור עקרוני |
| cash | הון עצמי מלא |
| selling_first | מוכר/ת נכס קודם |
| unsure | עדיין לא ברור |

## Data flow

1. `POST /api/chat` replies as today. When `convo.message_count` reaches
   `offer_form_after_msgs`, the reply was answered, no lead is captured and no
   form was offered, the response carries `offer_lead: true` and the
   conversation records `form_offered: true`. The `state: "handoff"` path is
   unchanged and also counts as the form having been offered.
2. The widget renders the form (existing name + phone, plus budget, timeline,
   financing). The intro line differs: handoff keeps `lead_intro`; the
   proactive offer uses `lead_intro_offer`.
3. `POST /api/chat/handoff` accepts `budget`, `timeline`, `financing`.
   Budget must be a positive integer up to 1,000,000,000 or the request is
   rejected with `400 invalid_budget`. Unknown timeline or financing values are
   stored as `null`, never rejected.
4. The server loads the agent's pages with `db.listPagesByPhone`, runs the
   matcher, and calls `submitLead` with `qualification` and
   `recommended_page_ids`. Both lead docs carry them.
5. The WhatsApp to the agent adds 💰 budget, 🗓 timeline, 🏦 financing lines and
   a "נכסים נוספים שהוצעו" list with title, city, price and URL per match.
6. The response is `{ ok: true, recommendations: [{ page_id, title, city,
   neighborhood, rooms, price, url }] }`. The widget collapses the form to the
   thanks line and, when the array is non-empty, appends a bot bubble with the
   `rec_intro` line and one link card per match.

## Components

New files in `server/`, each under 200 lines with a `node:assert` test next to
it, added to the `test` script in `server/package.json`.

- `server/chat-qualify.js` — pure. `parseQualification(body)` validates and
  normalizes the three fields. `shouldOfferForm(convo, limits, answered)`
  decides the proactive offer. `qualificationLines(q, listingType)` renders the
  Hebrew WhatsApp lines. Exposes `TIMELINE_LABELS`, `FINANCING_LABELS`.
- `server/chat-recommend.js` — pure. `matchByBudget(pages, opts)` returns the
  shortlist. `recommendationLines(matches)` renders the WhatsApp list.
  Reuses `visiblePortfolioPages` from `server/portfolio.js` for the
  published-and-visible filter.

Modified:

- `server/chatbot-config.js` — `limits.offer_form_after_msgs: 3`.
- `server/leads.js` — `submitLead` accepts `qualification` and
  `recommended_page_ids`.
- `server/routes/chat.js` — proactive offer flag on `/api/chat`; qualification,
  matching, WhatsApp lines and `recommendations` on `/api/chat/handoff`.
- `server/index.js` — pass `pageBaseUrl` into `createChatRouter`.
- `public-nadlan/templates/chat.js`, `chat.css` — form fields, proactive
  offer, recommendation cards, he/en strings.

## Error handling

- Matching failures (Firestore read error) never fail the lead: the page list
  falls back to `[]`, the lead is saved, the response carries
  `recommendations: []`.
- Budget validation runs before any write, alongside name and phone.
- A page with `price` 0 or missing is never matched (0 means unknown).

## Testing

- `chat-qualify.test.js`: budget bounds and coercion, enum normalization,
  offer decision on each guard, WhatsApp line rendering for sale and rent.
- `chat-recommend.test.js`: band edges, listing type filter, status and
  visibility filter, self exclusion, cap and sort, zero price skipped, URL
  built from base.
- `leads.test.js`: qualification and recommended ids persisted on both docs,
  absent fields stored as null.
- `chatbot-config.test.js`: new default and override.
- Widget: manual check on a page with a rent and a sale listing, both
  languages, both triggers.
