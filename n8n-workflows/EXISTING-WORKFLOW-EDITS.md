# Edits Needed for Existing n8n Workflows

## ⚠️ Request Permission Before Making These Changes

These workflows are ACTIVE in production. Get explicit approval before editing.

---

## 1. Main Router v3 (`fhyTsd1DSN6wtMGz`)

**Status**: Currently inactive
**Action**: Repoint + activate (gated)

### Changes:

#### Identity lookups (replace 3 Sheets lookups → Firestore)
**Current**: 3 parallel Google Sheets lookups:
- `Businesses` sheet
- `leads` sheet
- `Chats` sheet

**New**: 3 parallel Firestore GETs:
- `businesses/{phone}` (full doc)
- `leads/{phone}` (full doc)
- `pending_messages` sheet (**keep** — ephemeral debounce)

#### Route logic (update targets)
**Current**:
- `business` → Business Handler2 (`V44w39VTt691WGxK`)
- `lead` (status≠converted) → Signup Bot2 resume
- `new/cold` → build lead → Signup Bot2 cold
- `customer` → Customer Handler3 (unchanged)

**New**:
- `business` → **Business Handler Agents** (new fork)
- `lead` → **Forly Leads Handler** (new)
- `new` → **Forly Leads Handler** (new)
- `customer` → Customer Handler3 (unchanged)

#### Field mapping
Replace all `businessData.*` references with Firestore field names:
- `businessData.full_name` → `full_name`
- `businessData.phone` → `phone`
- etc. (see Part 5 schema)

---

## 2. Signup Bot2 (`CUt4ufMptd8xHW4D`)

**Status**: Active
**Action**: Extend (D39 impatience, D37 web deep-link, D17' Firestore writes)

### Changes:

#### Add impatience detection (D39)
After each user reply in onboarding:
1. **Haiku classify** sentiment:
   - Prompt: `"User message: '{message}'. Classify sentiment: impatient (keywords: כמה עוד, ארוך, נמאס) or patient. JSON: {impatient: bool}"`
2. **If impatient**:
   - Count remaining questions: `total_questions - current_step`
   - Reply: `"נשארו רק {X} שאלות 🙂 או שתעדיף להמשיך בטופס מהיר: app.call4li.com/signup?resume={phone}&t={jwt_token}"`
   - JWT token: 2h signed token from `signupDeepLink` Function (to build)

#### Add web deep-link trigger
On keywords `"אתר"/"טופס"/"קישור"` in any reply:
- Same as impatience → offer deep-link

#### Firestore writes (replace Sheets dual-write, D17')
**Current**: writes to Sheets `Businesses` row on completion

**New**:
- **Remove** Sheets `Businesses` write
- **Add** Firestore write via HTTP Request:
  - `POST https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/businesses/{phone}`
  - OAuth2: Google SA cred
  - Body: full `businesses/{phone}` schema (Part 5)
- **Add** Firestore write `quota/current` subcollection

#### Welcome message (consultant milestone 2)
On signup completion (after Firestore write):
```
ברוכים הבאים לפורלי 🦉
מה שיקרה עכשיו:
✅ תוך שניות — תכנית שיווקית שבועית
✅ תוך 30-60 דק׳ — כל התכנים מוכנים
✅ כל יום ראשון — דוח ביצועים
יש נכסים? שלח עכשיו, אחרת נתחיל עם תוכן לפרופיל שלך.
```

#### Lead → business handoff
Before welcome message:
1. **Firestore GET** `leads/{phone}`
2. **If exists**:
   - Copy `leads/{phone}.carousel` as bonus first weekly item
   - **Firestore PATCH** `leads/{phone}`: `{status: "converted", converted_at: now}`
   - **Firestore CREATE** event: `lead_converted (completed)`

---

## 3. Business Handler2 (`V44w39VTt691WGxK`)

**Status**: Active (freeze as rollback)
**Action**: **Fork** → "Business Handler Agents" (new workflow)

### Fork process:
1. Duplicate BH2 → new workflow "Business Handler Agents"
2. Set BH2 to **frozen** (comment: "rollback target, do not edit")
3. Edit new fork per below

### Changes in fork:

#### Field remap (Sheets → Firestore)
Replace ALL `businessData.*` references:
- Source: Firestore GET `businesses/{phone}` (not Sheets row)
- Field names per Part 5 schema

#### Add burst bundle consumption
Entry node:
```js
const current_burst_images = $input.stacked_images || [];
```

#### Add walkthrough trigger logic
**New node**: `ask_walkthrough`
**Trigger**: ≥4 images OR keyword `סרטון/סיור/וידאו`
**Flow**:
1. Persist each image via `persistMedia` Function → `raw/{phone}/{burst_id}/{seq}.jpg`
2. Firestore CREATE `pending_walkthrough_confirm/{phone}`: `{burst_id, image_urls[], expires_at: +10m}`
3. Green API send buttons: `["כן, צור סרטון 🎬", "לא תודה"]`
4. Sheets write `pending_state` (existing pattern)

**New node**: `walkthrough`
**Trigger**: pending + button "כן"
**Flow**:
1. Firestore CREATE `listings/{uuid}`: `{source: "chat_burst", photos_urls: image_urls, status: "active", ...stub}`
2. **Execute Workflow**: WW1 (await)
3. Firestore DELETE `pending_walkthrough_confirm/{phone}`

#### Add weekly-plan approval
**Trigger**: message when `weekly_plans/{id}.status == "sent"`
**Flow**:
1. Haiku classify: approve | change | reject | unrelated
2. **If approve**:
   - Firestore PATCH plan: `{status: "approved", approved_at: now}`
   - Generate items per §10.2 (carousel/image wrappers)

#### Add victory/deal detection (D28' — no referral)
**On every inbound message**:
1. Haiku classify: `{is_inquiry: bool, is_deal: bool}`
2. **If inquiry**:
   - Firestore INCREMENT `businesses/{phone}.total_inquiries_reported`
   - Firestore CREATE event: `inquiry_reported`
   - Reply: `"🏆 {name} — קיבלת פנייה מהתוכן! זה בדיוק מה שבנינו יחד ✨"`
3. **If deal**:
   - Firestore INCREMENT `businesses/{phone}.total_deals_closed`
   - Firestore CREATE event: `deal_closed`
   - Reply: `"מזל טוב!! 🏠🎉 עסקה שהתחילה מתוכן."`
   - **No referral ask** (D28')

#### Add smart memory
Before agent logic:
1. Firestore GET `businesses/{phone}/events` where `type == "content_requested"` order by `ts desc` limit 3
2. Pass as context to agent

---

## 4. Credentials to relink

After any `update_workflow`, n8n forgets inline creds. Relink:
- **Anthropic**: Header Auth (`x-api-key`)
- **Green API**: Instance/Token in URL params
- **Seedance**: Header Auth (`Authorization: Bearer`)
- **Firebase SA OAuth2**: Service Account JSON
- **Manus**: existing
- **fal.ai**: existing

---

## Activation sequence (production-gated)

1. ✅ Deploy Functions (rules + persistMedia + auth + data)
2. Build new workflows (Vision Tagger, WW1, Leads Handler) as **inactive**
3. Fork BH2 → BHA, edit per above, keep **inactive**
4. Extend Signup Bot2 per above, **test in staging**
5. Repoint Router v3 per above, keep **inactive**
6. **Explicit approval** → activate Router v3
7. Monitor for 24h, rollback to Router v2 + BH2 if issues

---

## Testing (before activation)

- Vision Tagger: executeWorkflow with 3 test image URLs → verify JSON tags
- WW1: executeWorkflow with test listing (≤9 photos) → verify video delivery
- Leads Handler: fire `/webhook/lead-trigger` with test phone → verify carousel delivery + funnel
- Signup Bot2 changes: test in isolated chat (non-prod phone)
- Router v3: test with non-prod phone → verify correct route (business/lead/new)
