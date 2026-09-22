# WhatsApp Property Chat — n8n runbook (manual)

Companion to the server plan `docs/superpowers/plans/2026-09-12-whatsapp-property-chat.md`. Every step
here is done by hand in the n8n UI by the workflow owner; no agent executes it. Do it after the server
plan is deployed, on a duplicate of Business Handler2 first if you want a dry run.

**Only Business Handler2 (`V44w39VTt691WGxK`) is edited.** Main Router is not touched. Three nodes are
added, one existing connection is re-pointed, and nothing already in the workflow is modified.

**Server contract**: `POST {BASE_URL}/api/whatsapp/intake`, header `x-forly-secret`, body
`{ phone, message, message_type, file_url }` for a message or `{ phone, event, photos }` after an
edited photo. Response `{ handled, status, reply, replied, listing_id }`. n8n continues to the bot only
when `handled` is false.

## The part of Business Handler2 this touches

```
When called by another workflow
        └─> Extract Chat History1 ─┬─> If ─> HTTP Request            (tag-image side branch, untouched)
                                   └─> fetch image library
                                          └─> Format Image Library
                                                 └─> Check Unsupported Media ─┬─ video  ─> Send Video Not Supported
                                                                              ├─ burst  ─> Send One-By-One Warning   (dead end)
                                                                              └─ ok     ─> Set Input Fields1 ─> AI Agent - Business1 ─> …
                                                                                                                  … ─> Edit Fields - Image
                                                                                                                         └─> Call Image Gen
                                                                                                                                └─> Extract Image Result
                                                                                                                                       └─> Log to Group - Image
```

The intake call goes on the `Format Image Library → Check Unsupported Media` connection. The photo
offer hangs off `Extract Image Result`.

### Fields available at the insertion point

`Format Image Library` ends with `return [{ json: { ...upstream, image_library_context } }]` where
`upstream` is `Extract Chat History1`'s output, so its item carries everything the new nodes need:

| Field | Meaning | Set by |
|---|---|---|
| `businessData.phone_number` | the agent's number | Main Router (same field `Set Input Fields1` already reads) |
| `customerMessage` | message text, or an image's caption | `Extract Chat History1` |
| `current_image_url` | Green API download URL, `''` when not an image | `Extract Chat History1` |
| `rawWebhook.messageData.typeMessage` | Green API message type | Main Router's raw payload |
| `is_image_message`, `is_video_message`, `is_multi_image_burst` | routing flags | `Extract Chat History1` |

Note the raw webhook is `rawWebhook` in this workflow (not `webhookData`).

`Extract Chat History1` builds `customerMessage` from the caption and the text fields only, so a
**button reply may arrive with `customerMessage` empty**. The body in Step B adds two fallbacks for it;
Step A confirms which one Green API actually sends.

---

### Step A: Confirm two payload details (read-only, no edits)

- [ ] **A1: An image message**

Business Handler2 → **Executions**. From a registered agent's phone send one photo to the Forly number.
Open the newest execution → node **`Format Image Library`** → Output. Confirm:

- `current_image_url` is a `https://...` Green API download URL (not empty)
- `businessData.phone_number` holds the agent's number
- `rawWebhook.messageData.typeMessage` is `imageMessage`

- [ ] **A2: A button reply**

Trigger any existing buttons message (e.g. send a photo with no caption; the bot answers with
**Send Motion Question**), then tap a button. Open the newest execution → **`Format Image Library`** →
Output and find where the tapped text landed:

- `customerMessage` already holds it → nothing to change
- otherwise look under `rawWebhook.messageData` for `buttonsResponseMessage.selectedButtonText` or
  `interactiveButtonsReply.selectedDisplayText`

- [ ] **A3: Record**

Replace the `[Unverified]` paragraph in
`docs/superpowers/specs/2026-09-12-whatsapp-property-chat-design.md` with what you saw. If the button
text sits somewhere other than the two fallbacks below, add that path to the `message` expression in
Step B1. Nothing on the server changes either way.

```bash
git add docs/superpowers/specs/2026-09-12-whatsapp-property-chat-design.md
git commit -m "docs(spec): confirm Business Handler2 payload paths"
```

---

### Step B: Add three nodes

Requires the server deployed (server plan Task 8). Positions below are cosmetic; the connections are
what matter.

- [ ] **B1: `Forly Property Intake` — HTTP Request**

Add a node, type **HTTP Request**, name it exactly `Forly Property Intake`. Suggested position
`[560, 640]`.

| Setting | Value |
|---|---|
| Method | `POST` |
| URL | `https://forly.srv1173890.hstgr.cloud/api/whatsapp/intake` |
| Authentication | Generic Credential Type → **Header Auth** → credential `Forly N8N Secret` (create it: Name `x-forly-secret`, Value = the server's `N8N_WEBHOOK_SECRET`) |
| Send Body | on |
| Body Content Type | JSON |
| Specify Body | Using JSON |
| Options → Timeout | `90000` |
| Settings → On Error | **Continue (using regular output)** |

JSON body (one expression — paste it as is, adjusting the two button fallbacks if Step A2 found a
different path):

```
={{ JSON.stringify({
  phone: String($json.businessData?.phone_number || ''),
  message: $json.customerMessage
        || $json.rawWebhook?.messageData?.buttonsResponseMessage?.selectedButtonText
        || $json.rawWebhook?.messageData?.interactiveButtonsReply?.selectedDisplayText
        || '',
  message_type: $json.rawWebhook?.messageData?.typeMessage || '',
  file_url: $json.current_image_url || null
}) }}
```

Do not paste the secret into the node body or URL — it belongs in the credential.

- [ ] **B2: `Handled by Forly?` — IF**

Add an **IF** node named exactly `Handled by Forly?`. Suggested position `[768, 640]`.

| Setting | Value |
|---|---|
| Condition | Left `={{ $json.handled }}` · Boolean · **is true** |
| Options → Convert types where required | **on** |

"Convert types" matters: when the server is unreachable the On-Error item has no `handled`, which must
read as false rather than raise.

- [ ] **B3: `Continue to Bot` — Edit Fields (Set)**

The IF passes the HTTP **response** downstream, but `Check Unsupported Media` and everything after it
read the chat-history item. This node puts the original item back.

Add an **Edit Fields (Set)** node named exactly `Continue to Bot`. Suggested position `[976, 640]`.

| Setting | Value |
|---|---|
| Mode | **JSON** |
| JSON Output | `={{ JSON.stringify($('Format Image Library').item.json) }}` |
| Include Other Input Fields | **off** |

- [ ] **B4: Wire them in**

Delete the existing connection `Format Image Library → Check Unsupported Media`, then connect:

```
Format Image Library  →  Forly Property Intake
Forly Property Intake →  Handled by Forly?
Handled by Forly?  [true]   →  (nothing — the server already replied in the chat)
Handled by Forly?  [false]  →  Continue to Bot
Continue to Bot             →  Check Unsupported Media
```

Leave `Extract Chat History1 → If → HTTP Request` (the tag-image branch) and
`Extract Chat History1 → fetch image library` exactly as they are.

- [ ] **B5: `Forly Photo Offer` — HTTP Request**

`Extract Image Result` currently feeds only `Log to Group - Image`. Add a second connection from its
output so both run on the same item.

Add an **HTTP Request** node named exactly `Forly Photo Offer`. Suggested position `[2576, 736]`.
Same URL, same Header Auth credential, Timeout `60000`, On Error **Continue (using regular output)**.

JSON body:

```
={{ JSON.stringify({
  phone: String($json.phone || ''),
  event: 'photos_edited',
  photos: [$json.result_url].filter(Boolean)
}) }}
```

Connect `Extract Image Result → Forly Photo Offer` (in addition to the existing
`Extract Image Result → Log to Group - Image`). Nothing follows `Forly Photo Offer`.

`Extract Image Result` emits `{ phone, request_message, result_type, result_url, source_image_url,
caption, extra_text }`, so `$json.phone` and `$json.result_url` are the edited image's number and URL.

- [ ] **B6: Save and activate**

Save. The workflow is already active; the new path is live on the next inbound message.

---

### Step C: Verify live

From a registered agent's phone. After each one open the newest Business Handler2 execution and read
`Forly Property Intake`'s output.

- [ ] **C1: Ordinary chat still works.** Send "היי". The AI agent answers as before, and the intake
  node shows `handled: false`.

- [ ] **C2: A link builds a page.** Send a Yad2 or Madlan listing link. Within ~30 s Forly replies
  "קראתי את המודעה…" plus the first question. Answer through to the summary, tap **כן**, get
  "אני בונה", and a few minutes later the page link from the Property Page Builder. Check the listing
  in the dashboard carries `source: whatsapp`.

- [ ] **C3: Keyword start.** Send "נכס חדש" and answer city, price, rooms; skip the rest with **דלג**;
  send 3 photos; tap **ממשיכים** then **כן**.

- [ ] **C4: Edited photos offer a page.** With no draft open, send three photos one at a time, waiting
  for each edit to come back. Nothing extra is said after the first two; after the third Forly offers
  "ערכתי 3 תמונות ✨ לבנות מהן דף נכס?". Tap **כן** and answer the questions.

- [ ] **C5: Pause.** Leave a draft mid-question for 2 h (or set its `updated_at` back in Firestore,
  collection `property_drafts`). "היי" is answered by the AI agent again; a new link asks **המשך / חדש**.

- [ ] **C6: Outage falls through.** Stop the Forly server (or point the URL at a dead host) and send
  "היי". The On-Error item has no `handled`, the IF takes the false branch, and the bot answers as
  usual. Restore the URL.

- [ ] **C7: Record.** Comment on issue #43 with the execution ids of C1-C6. Close it when all pass.

---

## Known limitation, worth a decision later

`Check Unsupported Media`'s `burst` output goes to `Send One-By-One Warning`, which has no outgoing
connection. **There is no bulk photo edit in this workflow**: photos sent less than 10 s apart get
"send them one at a time", and only single photos are edited. So the offer in B5 fires once per edited
photo, and the server holds them until the third arrives (spec: accumulate, offer once at 3).

An agent who wants a page from edited photos therefore has to edit three photos separately. If that
proves too slow in practice, the fix is on the n8n side — give the `burst` output a real batch path —
and the server already accepts several photos in one `photos_edited` call, so it needs no change.
