# WhatsApp Property Chat — n8n runbook (manual)

Companion to the server plan `docs/superpowers/plans/2026-09-12-whatsapp-property-chat.md`. Everything here is done by hand in the n8n UI by the workflow owner; no agent executes it. Do it after the server plan is deployed, on a dev copy of Business Handler2 first if one exists.

**Only Business Handler2 (`V44w39VTt691WGxK`) is edited.** Main Router is not touched: it already hands Business Handler2 the whole Green API payload as `webhookData` (its `fullData` field is the raw webhook body), so every path below is read off Business Handler2's own input.

**Server contract** (spec §n8n contract): `POST {BASE_URL}/api/whatsapp/intake`, header `x-forly-secret`, body `{ phone, message, message_type, file_url }` for a message, or `{ phone, event: "photos_edited", photos: [...] }` after a bulk edit. Response `{ handled, status, reply, replied, listing_id }`. n8n stops when `handled` is true.

---

### Step A: Confirm the Green API payload shape n8n will forward

The server never sees Green API's raw webhook; n8n maps it. This task pins the two field names the mapping depends on so the node expressions in Step B are not guesswork.

**Files:** none in the repo (record findings in the spec's "[Unverified]" paragraph).

- [ ] **Step 1: Capture an image message**

In n8n open **Business Handler2** → Executions. Send a photo from a registered agent's phone to the Forly number. Open the newest execution → node `When called by another workflow` → output → `webhookData`. Note `webhookData.fullData.messageData.typeMessage` and the key holding the download URL (expected `webhookData.fullData.messageData.fileMessageData.downloadUrl`).

- [ ] **Step 2: Capture a button reply**

From any Green API node in Business Handler2 (e.g. **Send Motion Question**) send yourself an interactive-buttons message, tap a button, and open the resulting Business Handler2 execution. Note `typeMessage` (expected `buttonsResponseMessage`) and the key holding the tapped text (expected `webhookData.fullData.messageData.buttonsResponseMessage.selectedButtonText`).

- [ ] **Step 3: Record**

Replace the `[Unverified]` paragraph in `docs/superpowers/specs/2026-09-12-whatsapp-property-chat-design.md` with the confirmed paths. If they differ from the expectations, adjust the expressions in Step B accordingly (nothing in the server changes).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-12-whatsapp-property-chat-design.md
git commit -m "docs(spec): confirm Green API image and button payload paths"
```

---

### Step B: n8n — forward every agent message and the edited-photo batch

Production workflow change. Requires the server plan deployed (its Task 8, the route).

**Files:** none in the repo. Workflow **Business Handler2** (`V44w39VTt691WGxK`).

- [ ] **Step 1: Add the intake call at the top**

Between `Extract Chat History1` and `Check Unsupported Media`, insert an **HTTP Request** node named `Forly Property Intake`:

- Method `POST`, URL `https://forly.srv1173890.hstgr.cloud/api/whatsapp/intake` (the same host `Create Property Page` in the Page Builder posts to)
- Header `x-forly-secret` = the value of `N8N_WEBHOOK_SECRET` on the server (store it as an n8n credential of type Header Auth; do not paste it into the node)
- Body (JSON):
  ```
  {
    "phone": "={{ $json.phone }}",
    "message": "={{ $json.customerMessage || $json.webhookData.fullData.messageData.buttonsResponseMessage?.selectedButtonText || '' }}",
    "message_type": "={{ $json.webhookData.messageType }}",
    "file_url": "={{ $json.webhookData.fullData.messageData.fileMessageData?.downloadUrl || null }}"
  }
  ```
  (use the paths confirmed in Step A)
- Options: timeout `90000`, "Continue on fail" ON so a Forly outage never blocks the rest of the bot.

- [ ] **Step 2: Branch on handled**

Add an **IF** node `Handled by Forly?` with condition `{{ $json.handled }}` is true. True branch → nothing (end). False branch → `Check Unsupported Media` (the node that used to follow `Extract Chat History1`). Because "Continue on fail" returns an error item without `handled`, an outage falls to the false branch and the bot behaves as before.

- [ ] **Step 3: Offer after a bulk edit**

Find the node that ends the multi-image batch path (after `Call Image Gen` / `Extract Image Result` for the `burst` output of `Check Unsupported Media`). After the last edited image is sent, add an **HTTP Request** `Forly Photo Offer`, same URL and header, body:

```
{ "phone": "={{ $('Set Input Fields1').first().json.phone }}",
  "event": "photos_edited",
  "photos": {{ JSON.stringify($input.all().map(i => i.json.result_url)) }} }
```

Replace `result_url` with the field the image-gen result actually carries (read it off `Extract Image Result`'s output in a recent execution).

- [ ] **Step 4: Verify live**

From a registered agent's phone:

1. "היי" → the AI agent answers as before (n8n execution shows `handled:false`).
2. A Yad2 link → within ~30 s: "קראתי את המודעה…" and the first question. Answer through to the summary, tap כן, get "אני בונה", and a few minutes later the Page Builder's page link. Confirm the listing shows in the dashboard with `source: whatsapp`.
3. Three photos → they are edited as before, then the offer appears; tap כן and answer the questions.
4. Wait 2 h (or set `updated_at` back in Firestore) → "היי" is answered by the AI agent again; a new link asks המשך / חדש.

- [ ] **Step 5: Record**

Comment on issue #43 with what was applied and the execution ids of the four checks. Close the issue when all four pass.

