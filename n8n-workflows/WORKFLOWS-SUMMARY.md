# Forly MVP v5 - Workflow Implementation Summary

## Status: Ready for Manual Implementation

Due to n8n SDK complexity and token efficiency, providing **actionable specs** for manual workflow building in n8n UI.

---

## 1. ✅ Forly Leads Handler (NEW)

**URL**: Create new workflow
**Triggers**:
- Webhook: `/webhook/lead-trigger` (POST)
- ExecuteWorkflowTrigger with inputs: phone, name, city, specialty, source

**Flow**:

1. **Normalize Input** (Code node)
   - Extract phone, name, city, specialty, source from webhook body or executeWorkflow inputs
   - Validate phone: 10-15 digits
   - Output: `{ phone, name, city, specialty, source }`

2. **Check Existing Lead** (Firestore GET)
   - Collection: `leads`
   - Document ID: `{{ $json.phone }}`
   - Continue on fail: true
   - Output: lead document or error

3. **Route By Status** (Switch node, rules mode)
   - Case 1: `$json.status == 'converted'` → output: "already_converted"
   - Case 2: `$json.status in ['carousel_sent', 'nudged']` → output: "continue_funnel"
   - Fallback: "new_lead"

4a. **Already Converted** branch:
   - Green-API sendMessage: "כבר יצרנו לך חשבון! 🦉\nשלח 'הצטרפות' לשירות המלא"
   - END

4b. **Continue Funnel** branch:
   - Skip to Follow-up #2 (60m mark)

4c. **New Lead** branch:

   5. **Prepare Lead Document** (Code node)
      - Build Firestore document with fields: phone, name, city, specialty, status='new', source, created_at, updated_at, funnel_step=0
      - Convert to Firestore format: `{ fields: { field_name: { stringValue: "..." } } }`

   6. **Create Lead** (HTTP Request PATCH)
      - URL: `https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/leads/{{ $json.phone }}`
      - Body: `{ fields: ... }`
      - Auth: Google Service Account

   7. **WhatsApp Ack** (Green-API sendMessage)
      - Message: `היי {{ name || 'מתווך' }}! 🦉\nמכינה לך קרוסלה — תוך כמה דקות 📲`

   8. **Synthesize Topic** (Anthropic text.message)
      - Model: claude-haiku-4-5-20251001
      - Max tokens: 150
      - Prompt: "Real-estate agent specialty: {specialty}, city: {city}. Generate: topic (Hebrew carousel hook) and business_desc (Hebrew sentence). Return JSON: {\"topic\": \"...\", \"business_desc\": \"...\"}"

   9. **Parse Topic** (Code node)
      - Parse Haiku JSON response
      - Output: `{ phone, business_name, business_desc, topic }`

   10. **Generate Carousel** (Execute Workflow)
       - Workflow ID: `Oksvt7PPwDCZXDep` (Carousel Tagged Wrapper)
       - Inputs: `{ phone, business_name, business_desc, topic }`
       - Wait for completion: true

   11. **Prepare Lead Update** (Code node)
       - Update status='carousel_sent', funnel_step=1, add carousel object
       - Convert to Firestore format

   12. **Update Lead Carousel Sent** (HTTP Request PATCH)
       - Update fields: status, funnel_step, updated_at, carousel

   13. **Follow-up #1** (Green-API)
       - Message: `✅ הקרוסלה מוכנה!\nלערוך (24ש): {{ editor_url }}\n💡 העלה 18:00–20:00`

   14. **Wait 60 Minutes** (Wait node)

   15. **Prepare Funnel Step 2** (Code node)
       - Update funnel_step=2

   16. **Update Funnel Step 2** (HTTP Request PATCH)

   17. **Follow-up #2** (Green-API)
       - Message: "העלית? ספר איך הגיבו 🦉\nרוצה שירות מלא? כתוב 'כן'"

   18. **Wait 24 Hours** (Wait node)

   19. **Prepare Funnel Step 3** (Code node)
       - Update funnel_step=3

   20. **Update Funnel Step 3** (HTTP Request PATCH)

   21. **Follow-up #3** (Green-API)
       - Message: "פורלי כל שבוע: תכנית·קרוסלות·דוחות.\nרוצה להצטרף? כתוב 'הצטרפות'"

**Credentials Needed**:
- Google Service Account (Firestore)
- Green-API instance + token (env vars: GREENAPI_INSTANCE, GREENAPI_TOKEN)
- Anthropic API key

---

## 2. ⚠️ Router v3 Updates (`fhyTsd1DSN6wtMGz`)

**Action**: EDIT existing workflow (currently inactive)

**Changes**:

### A. Replace Sheets Lookups with Firestore (3 parallel GET nodes)

**Old**: Google Sheets → `Businesses`, `leads`, `Chats`
**New**:
1. Firestore GET `businesses/{phone}`
2. Firestore GET `leads/{phone}`
3. Keep Sheets lookup for `pending_messages` (ephemeral debounce)

### B. Update Route Logic (Switch node)

**Current routes**:
- business → Business Handler2 (`V44w39VTt691WGxK`)
- lead → Signup Bot2 resume
- new → build lead → Signup Bot2 cold
- customer → Customer Handler3 (unchanged)

**New routes**:
- business → **Business Handler Agents** (new workflow ID - after creating fork)
- lead → **Forly Leads Handler** (new workflow ID)
- new → **Forly Leads Handler** (new workflow ID)
- customer → Customer Handler3 (unchanged)

### C. Field Mapping

Replace ALL references:
- `businessData.full_name` → `full_name`
- `businessData.phone` → `phone`
- `businessData.*` → `*` (use Firestore doc fields directly)

**Test Before Activating**: Use test phone numbers to verify routing

---

## 3. ⚠️ Signup Bot2 Extensions (`CUt4ufMptd8xHW4D`)

**Action**: EXTEND existing workflow (ACTIVE in production)

**Changes**:

### A. Add Impatience Detection (after each user reply)

1. **Haiku Classify Sentiment** (Anthropic)
   - Prompt: "User message: '{message}'. Classify: impatient (כמה עוד/ארוך/נמאס) or patient. JSON: {impatient: bool}"

2. **If Impatient** (If node):
   - True branch:
     - Calculate remaining questions: `total_questions - current_step`
     - Generate JWT token via Function `signupDeepLink` (2h expiry)
     - Green-API send: `נשארו רק {X} שאלות 🙂\nאו בטופס: app.call4li.com/signup?resume={phone}&t={jwt}`

### B. Add Web Deep-Link Trigger

On keywords `["אתר", "טופס", "קישור"]` in any reply:
- Same as impatience → offer deep-link

### C. Replace Sheets Writes with Firestore

**Current**: Writes to Sheets `Businesses` row on completion

**New**:
1. Remove Sheets `Businesses` write
2. Add Firestore PATCH `businesses/{phone}` with full schema (see Part 5 in docs)
3. Add Firestore PATCH `businesses/{phone}/quota/current` subcollection

### D. Add Welcome Message (after Firestore write)

Green-API send:
```
ברוכים הבאים לפורלי 🦉
מה שיקרה עכשיו:
✅ תוך שניות — תכנית שיווקית
✅ תוך 30-60 דק׳ — כל התכנים
✅ כל ראשון — דוח ביצועים
יש נכסים? שלח עכשיו
```

### E. Add Lead → Business Handoff (before welcome)

1. Firestore GET `leads/{phone}`
2. If exists:
   - Copy `leads/{phone}.carousel` as bonus weekly item
   - Firestore PATCH `leads/{phone}`: `status='converted', converted_at=now`
   - Firestore CREATE event: `lead_converted (completed)`

---

## 4. ⚠️ Business Handler Agents (NEW - Fork of `V44w39VTt691WGxK`)

**Action**:
1. FORK Business Handler2 → new workflow "Business Handler Agents"
2. Set BH2 to **frozen** (comment: "rollback target")
3. EDIT fork with changes below

**Changes**:

### A. Field Remap (ALL nodes)

Replace: `businessData.*` → Firestore GET `businesses/{phone}` field names

### B. Add Burst Bundle Consumption (entry node)

```js
const current_burst_images = $input.stacked_images || [];
```

### C. Add Walkthrough Trigger Logic

**New node: Ask Walkthrough**
- Trigger: ≥4 images OR keywords `["סרטון", "סיור", "וידאו"]`
- Flow:
  1. Persist images via Function `persistMedia` → `raw/{phone}/{burst_id}/{seq}.jpg`
  2. Firestore CREATE `pending_walkthrough_confirm/{phone}`:
     ```json
     { burst_id, image_urls[], expires_at: +10m }
     ```
  3. Green-API send buttons: `["כן, צור סרטון 🎬", "לא תודה"]`
  4. Sheets write `pending_state`

**New node: Walkthrough**
- Trigger: pending + button "כן"
- Flow:
  1. Firestore CREATE `listings/{uuid}`:
     ```json
     { source: "chat_burst", photos_urls: image_urls, status: "active", ...stub }
     ```
  2. Execute Workflow: WW1 (wait for completion)
  3. Firestore DELETE `pending_walkthrough_confirm/{phone}`

### D. Add Weekly-Plan Approval

**Trigger**: message when `weekly_plans/{id}.status == "sent"`

Flow:
1. Haiku classify: approve | change | reject | unrelated
2. If approve:
   - Firestore PATCH plan: `status='approved', approved_at=now`
   - Generate items per §10.2 (carousel/image wrappers)

### E. Add Victory/Deal Detection (every inbound message)

1. **Haiku classify**: `{is_inquiry: bool, is_deal: bool}`

2. **If inquiry**:
   - Firestore INCREMENT `businesses/{phone}.total_inquiries_reported`
   - Firestore CREATE event: `inquiry_reported`
   - Reply: `🏆 {name} — קיבלת פנייה מהתוכן! ✨`

3. **If deal**:
   - Firestore INCREMENT `businesses/{phone}.total_deals_closed`
   - Firestore CREATE event: `deal_closed`
   - Reply: `מזל טוב!! 🏠🎉 עסקה שהתחילה מתוכן.`
   - **No referral ask** (D28')

### F. Add Smart Memory (before agent logic)

1. Firestore GET `businesses/{phone}/events` WHERE `type == "content_requested"` ORDER BY `ts desc` LIMIT 3
2. Pass as context to agent

---

## Activation Sequence (Production-Gated)

Per `EXISTING-WORKFLOW-EDITS.md:179-187`:

1. ✅ Deploy Functions (rules + persistMedia + auth + data)
2. ✅ Build new workflows as **inactive**:
   - Forly Leads Handler ✓
   - Business Handler Agents (fork BH2 first)
3. ⚠️ Extend Signup Bot2 → **test in staging**
4. ⚠️ Update Router v3 → keep **inactive**
5. 🔐 **Explicit approval** → activate Router v3
6. 📊 Monitor 24h → rollback to Router v2 + BH2 if issues

---

## Testing Guide

See `TESTING-GUIDE.md` (next file)

---

## Credentials to Relink After Updates

n8n forgets inline credentials after `update_workflow`. Relink:
- **Anthropic**: Header Auth (`x-api-key`)
- **Green-API**: Instance/Token in URL params or env vars
- **Firebase SA**: OAuth2 Service Account JSON
- **Seedance**: Header Auth (`Authorization: Bearer`)

---

## Notes

- **Leads Handler**: Frictionless (D31) — no menu, just generate + deliver
- **Lead carousel**: Free, not charged to quota
- **Limited access (D24')**: Leads don't get walkthrough/library until conversion
- **Router v3**: Must remain inactive until explicit approval
- **Signup Bot2**: Active in production — test changes carefully
- **BH2 fork**: Original BH2 becomes rollback target, frozen

---

**Implementation Approach**:
Manual workflow building in n8n UI using these specs. Each workflow is detailed enough to build node-by-node.
