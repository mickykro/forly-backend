# WhatsApp provider switch: Green API → Whapi.Cloud

Status: plan. Backend and Functions code are ready (branch `ccr-17540db3-lqumw2`); n8n is not.

## 1. Where Green API is used

| Layer | Coupling | State |
|---|---|---|
| Server (`server/`) | All sends and chat reads go through `server/whatsapp/` | **Done.** Switch with `WHATSAPP_PROVIDER=whapi` |
| Firebase Functions (`functions/src/`) | All sends go through `shared.ts` | **Done.** Same env var |
| n8n | 37 of the 54 inspected active workflows; 13 more not inspected (see §5) | **To do.** This is most of the work |
| `scripts/whatsapp-daily-review.local.js` | Green API only (operator tool) | Port later, or retire |

Provider-neutral message shape used on the server:
`{ id, fromMe, type: "text"|"image"|"other", text, mediaUrl, timestamp }`.

## 2. Known differences that change behaviour

| Topic | Green API | Whapi | Impact |
|---|---|---|---|
| Personal chat id | `972…@c.us` | `972…@s.whatsapp.net` (`@c.us` rejected) | Every n8n send node, and every `@c.us` string in n8n code |
| Auth | Token in the URL path | `Authorization: Bearer <token>` | n8n credentials |
| Link / copy buttons | `sendInteractiveButtons` | Only quick-reply buttons are documented | Server sends link buttons as text with each link written out. n8n's 18 `sendInteractiveButtons` nodes need the same treatment, or verify a URL-button type in Whapi's docs first |
| Media links | `downloadUrl` is always present | `image.link` etc. present **only with media auto-download on** | Turn on auto-download in the Whapi channel settings, or the photo flows break |
| Incoming webhook | One message per call (`typeWebhook`, `senderData`, `messageData`) | `{ messages: [ … ] }`, possibly several per call | Every router's parse step; batches must be split |
| Message ids | `idMessage` | `id` | `quoted_id` sent to `/api/whatsapp/intake` becomes a Whapi id. Works automatically once both sides are on Whapi; mixed ids across the cut-over won't resolve |

Field map for incoming messages. [Unverified] = not confirmed in the Whapi references I could read; check one real webhook before relying on it.

| Green (what n8n reads now) | Whapi |
|---|---|
| `typeWebhook == incomingMessageReceived` | `messages[i].from_me == false` |
| `senderData.chatId` / `.sender` | `messages[i].chat_id` / `.from` |
| `senderData.senderName` | `messages[i].from_name` |
| `textMessageData.textMessage`, `extendedTextMessageData.text` | `messages[i].text.body` |
| `messageData.typeMessage` (imageMessage / audioMessage / videoMessage) | `messages[i].type` (image / voice or audio / video) |
| `fileMessageData.downloadUrl`, `.caption` | `messages[i].image.link`, `.image.caption` (likewise `video`, `voice`, `document`) |
| `quotedMessage.stanzaId` / `.typeMessage` / `.downloadUrl` | `messages[i].context.quoted_id` / `.quoted_type` / quoted content [Unverified] |
| `buttonsResponseMessage.selectedButtonText`, `interactiveButtonsReply.selectedDisplayText` | reply-type message carrying the button title [Unverified] |
| `idMessage`, `timestamp` | `id`, `timestamp` |

## 3. The design that makes the next switch cheap

Provider-specific code should exist in exactly two places: the server adapter and a single n8n normalizer.

1. **Outbound from n8n goes through the backend.** Add `POST /api/whatsapp/send` (n8n secret, like `/intake`) with `{ to, text }`, `{ to, file_url, file_name, caption }` and `{ to, buttons }`, plus `GET /api/whatsapp/history`. It calls `server/whatsapp/`. The 100+ provider nodes in n8n become one HTTP-node pattern with no provider in it. The next switch then needs no n8n change at all.
2. **Inbound goes through one normalizer workflow.** A new "WhatsApp Inbound" workflow is the only thing the provider's webhook points to. It converts the payload to a neutral event, `{ phone, chat_id, name, id, type, text, media_url, quoted: { id, type, media_url }, button_reply, timestamp }`, splits batches, drops `from_me`, and calls Main Router with that event. Routers and handlers read only the neutral event. The next switch then changes one Code node.

Phase B below is where this gets built. It is extra work now, and it's what makes the next switch an env change plus one node.

## 4. Steps

### Phase A: prepare (no customer impact)
1. Create the Whapi channel and connect a number. Decide first: the **same** number (unlink Green API, scan the QR in Whapi; the switch is then all-or-nothing) or a **new** number (both run side by side, but agents must be told the new number).
2. In the Whapi channel settings, turn on media auto-download.
3. Add the secret `WHAPI_TOKEN` to Secret Manager (Functions) and to the server env. **Required before the next Functions deploy, even with a placeholder**, because every function that sends WhatsApp now declares it.
4. Deploy this branch with `WHATSAPP_PROVIDER` unset (still Green API). Check that login codes and notifications still work.
5. Send one test message to Whapi and save its raw webhook. Use it to settle the [Unverified] rows in §2.

### Phase B: n8n (the bulk)
6. Build `/api/whatsapp/send` and `/api/whatsapp/history` (§3.1). Small, reuses `server/whatsapp/`.
7. Build the "WhatsApp Inbound" normalizer (§3.2).
8. Rework the routers to read the neutral event. Live path: Green → `avisa-reply-v2` → Main Router v3 → Business Handler v6 / Lead Chat. Also the legacy `avisa-reply` router and the `carousel-trigger` entry in the Carousel workflow.
9. Replace Green API nodes with the backend send/history calls, in order of traffic:
   - Business Handler v6, Main Router v3, Lead Chat, Customer Handler3, Payment Intent Handler
   - Signup Bot v5.5 and Signup Bot2, Log to Group (group id `…@g.us` stays the same)
   - The media and walkthrough workflows: carousel, video, image, WW1 V1–V3 and their dev copies, Property Page Builder ×3
10. Replace hardcoded `@c.us` strings. Phones only; the backend adds the suffix.
11. Business Handler v6 → `/intake`: fill `message_type`, `file_url`, `audio_url`, `quoted_*` from the neutral event.

### Phase C: cut-over
12. Point the Whapi webhook at the normalizer.
13. Set `WHATSAPP_PROVIDER=whapi` on the server and in Functions (`functions/.env`), then redeploy both.
14. Smoke test:
   - a login code
   - a text from an agent → bot reply
   - a photo → edit
   - a quoted-image reply
   - a page-ready notification (link buttons arrive as text)
   - a lead notification
   - Log to Group
15. Watch the logs for `Whapi messages/text refused` for 24 h.

### Rollback
Set `WHATSAPP_PROVIDER=greenapi`, point Green's webhook back at the old router, and redeploy. That works while the Green API instance is still paid for and linked. If the same number was moved to Whapi, rolling back means re-scanning the QR in Green API.

## 5. Open items found during the audit (not part of the switch)
- **13 active workflows could not be read** through the n8n API ("not available in MCP"). Some routers call them. They need a manual look:
  - Hairdresser Bot - Core Flow, Call4li signup Bot copy, GS Setup Task V3, GS Setup Task V4
  - New Submittion Lead, Business Handler new v1, Customer Handler, Business Handler (sYkXg76AnRWaLRqs)
  - Customer Handler2, [Helper] Firestore Gateway, 4Li - Follow me validation, Onboarding, Call4li signup Bot
- **Secrets hardcoded in n8n node parameters:** a Supabase service_role JWT (Cardcom Credits Create Link) and a fal.ai key (Image Gen v4, 4 nodes). Move them to n8n credentials and rotate them.
- **Production workflows calling staging:** Business Handler v6 "Check Stop" → `forly-intake-staging`, and WW1 V3 → `staging.srv1173890.hstgr.cloud`.
- **Main Router v2's "Is test numbers" check never matches.** It compares against a string containing an invisible U+2069 character.
- **Likely unused:** Business Handler v3/v4/v4-staging/v5 and Signup Bot v5.5 are active, but no inspected workflow calls them.
