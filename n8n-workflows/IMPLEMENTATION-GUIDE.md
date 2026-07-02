# Workflow Implementation Guide - Surgical Updates

## How to Use This Guide

Each workflow has **step-by-step node changes** you can apply directly in n8n UI. Format:
- **[Action]** Node Name: specific change
- Copy-paste code snippets where provided
- Test after each major change

---

## 1. Business Handler Agents (Fork BH2 First)

### Step 1: Fork Workflow

1. Open `Business Handler2` (`V44w39VTt691WGxK`) in n8n
2. Click **Duplicate** → rename to "Business Handler Agents"
3. Add description: "Forly business handler with walkthrough, approval, detection, memory"
4. Save workflow → note new workflow ID
5. Mark original BH2 as "FROZEN - rollback target"

### Step 2: Entry Node - Add Burst Bundle

**Find**: First node after trigger (likely a Code node or Router)

**Add BEFORE it**: New Code node "Check Burst Bundle"
```javascript
// Check for stacked images from previous messages
const trigger = $input.first().json;
const phone = trigger.senderData?.chatId?.replace('@c.us', '') || trigger.phone;
const messageType = trigger.typeMessage || trigger.type;
const imageUrl = trigger.downloadUrl || trigger.media_url;

// Get burst context (if exists from previous run)
const context = $input.first().json.burst_context || {};
const currentBurstImages = context.stacked_images || [];

// If this is an image, add to burst stack
if (messageType === 'imageMessage' && imageUrl) {
  currentBurstImages.push({
    url: imageUrl,
    timestamp: new Date().toISOString()
  });
}

return [{
  json: {
    ...trigger,
    phone,
    current_burst_images: currentBurstImages,
    burst_count: currentBurstImages.length
  }
}];
```

### Step 3: Walkthrough Trigger Logic

**Add**: New Switch node "Check Walkthrough Trigger"
- After entry processing
- Condition 1: `{{ $json.burst_count >= 4 }}` → "ask_walkthrough"
- Condition 2: Message contains keywords
  ```javascript
  {{ $json.messageData?.textMessageData?.textMessage?.match(/(סרטון|סיור|וידאו)/i) && $json.burst_count >= 1 }}
  ```
  → "ask_walkthrough"
- Fallback: continue to normal agent logic

**Add Branch "ask_walkthrough"**:

**Node 1**: HTTP Request "Persist Images"
```
URL: {{ $env.FIREBASE_FUNCTIONS_URL }}/persistMedia
Method: POST
Body: {
  "phone": "{{ $json.phone }}",
  "images": {{ JSON.stringify($json.current_burst_images) }}
}
Output: { burst_id, image_urls[] }
```

**Node 2**: HTTP Request "Create Pending Confirmation"
```
URL: https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/pending_walkthrough_confirm/{{ $json.phone }}
Method: PATCH
Auth: Google Service Account
Body: {
  "fields": {
    "burst_id": { "stringValue": "{{ $('Persist Images').first().json.burst_id }}" },
    "image_urls": {
      "arrayValue": {
        "values": {{ JSON.stringify($('Persist Images').first().json.image_urls.map(u => ({stringValue: u}))) }}
      }
    },
    "expires_at": { "stringValue": "{{ $now.plus({minutes: 10}).toISO() }}" }
  }
}
```

**Node 3**: Green-API "Send Buttons"
```
Method: sendButtons
Body: {
  "chatId": "{{ $json.phone }}@c.us",
  "message": "מצאתי {{ $json.burst_count }} תמונות 📸\nרוצה שאצור סרטון סיור?",
  "buttons": [
    { "id": "yes_walkthrough", "text": "כן, צור סרטון 🎬" },
    { "id": "no_walkthrough", "text": "לא תודה" }
  ]
}
```

### Step 4: Walkthrough Execution

**Add**: New branch for button "yes_walkthrough"

**Node 1**: Firestore GET "Get Pending Confirmation"
```
Collection: pending_walkthrough_confirm
Document ID: {{ $json.phone }}
```

**Node 2**: HTTP Request "Create Listing"
```
URL: https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/listings
Method: POST
Auth: Google Service Account
Body: {
  "fields": {
    "source": { "stringValue": "chat_burst" },
    "phone": { "stringValue": "{{ $json.phone }}" },
    "photos_urls": {
      "arrayValue": {
        "values": {{ JSON.stringify($('Get Pending Confirmation').first().json.image_urls.arrayValue.values) }}
      }
    },
    "status": { "stringValue": "active" },
    "created_at": { "stringValue": "{{ $now.toISO() }}" }
  }
}
Output: { name: "listings/UUID" }
```

**Node 3**: Execute Workflow "WW1"
```
Workflow ID: vHUj7CfmGQszcRV7
Mode: once
Wait: true
Inputs: {
  "phone": "{{ $json.phone }}",
  "listing_id": "{{ $('Create Listing').first().json.name.split('/')[1] }}",
  "image_urls": [extracted from listing],
  "trigger_source": "business_handler"
}
```

**Node 4**: Firestore DELETE "Remove Pending"
```
URL: https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/pending_walkthrough_confirm/{{ $json.phone }}
Method: DELETE
```

### Step 5: Weekly Plan Approval

**Find**: Agent response processing node

**Add After**: Switch node "Check Plan Status"
```
Get current weekly plan:
Firestore GET weekly_plans where phone={{ $json.phone }} order by created_at desc limit 1

If status == "sent":
  → route to "Plan Approval Flow"
```

**Plan Approval Flow**:

**Node 1**: Anthropic "Classify Response"
```
Model: claude-haiku-4-5-20251001
Max tokens: 100
Prompt: "User message: '{{ $json.message }}'. Classify: approve | change | reject | unrelated. Return JSON: {intent: 'approve'|'change'|'reject'|'unrelated'}"
```

**Node 2**: Switch "Route by Intent"
- Case "approve" → Update plan + generate items
- Case "change" → Ask what to change
- Case "reject" → Offer alternatives
- Default → Continue normal flow

**Approve Branch**:
```javascript
// Update plan status
Firestore PATCH weekly_plans/{{ $json.plan_id }}:
{
  "fields": {
    "status": { "stringValue": "approved" },
    "approved_at": { "stringValue": "{{ $now.toISO() }}" }
  }
}

// Generate items per §10.2 (carousel/image wrappers)
// [Implementation depends on your item generation logic]
```

### Step 6: Victory/Deal Detection

**Find**: Every inbound message processing

**Add**: Anthropic "Detect Victory/Deal"
```
Model: claude-haiku-4-5-20251001
Max tokens: 50
Run: On every message
Prompt: "Message: '{{ $json.message }}'. Classify: {is_inquiry: bool, is_deal: bool}. Inquiry keywords: פנייה/לקוח/מתעניין. Deal keywords: סגרתי/עסקה/חתמנו. JSON only."
```

**Add**: Switch "Route Victory"
- Case `is_inquiry == true`:
  ```
  1. Firestore HTTP Request:
     URL: https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/businesses/{{ $json.phone }}?updateMask.fieldPaths=total_inquiries_reported
     Method: PATCH
     Body: {
       "fields": {
         "total_inquiries_reported": {
           "integerValue": {{ $('Get Business').first().json.total_inquiries_reported + 1 }}
         }
       }
     }

  2. Create Event:
     Firestore POST to businesses/{{ $json.phone }}/events
     { type: "inquiry_reported", ts: now }

  3. Reply:
     "🏆 {{ $json.business_name }} — קיבלת פנייה מהתוכן! זה בדיוק מה שבנינו יחד ✨"
  ```

- Case `is_deal == true`:
  ```
  1. INCREMENT total_deals_closed
  2. Create Event: deal_closed
  3. Reply: "מזל טוב!! 🏠🎉 עסקה שהתחילה מתוכן."
  4. NO referral ask (per D28')
  ```

### Step 7: Smart Memory

**Find**: Node that builds agent prompt/context

**Add BEFORE**: Firestore Query "Get Recent Events"
```
URL: https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/businesses/{{ $json.phone }}/events?pageSize=3&orderBy=ts desc&structuredQuery.where.fieldFilter.field.fieldPath=type&structuredQuery.where.fieldFilter.op=EQUAL&structuredQuery.where.fieldFilter.value.stringValue=content_requested
Method: GET
Auth: Google Service Account
```

**Modify**: Agent prompt node
```javascript
const recentEvents = $('Get Recent Events').first().json.documents || [];
const eventContext = recentEvents.map(e =>
  `- ${e.fields.content_type.stringValue} on ${e.fields.ts.stringValue}`
).join('\n');

const prompt = `
[Existing prompt]

Recent content requests:
${eventContext}
`;
```

### Step 8: Field Remapping

**Find ALL nodes** that reference `businessData.*`

**Replace**:
- `businessData.full_name` → `full_name`
- `businessData.phone` → `phone`
- `businessData.city` → `city`
- `businessData.specialty` → `specialty`
- `businessData.status` → `status`
- etc.

Use n8n's global search (Ctrl+F) to find ALL instances.

### Step 9: Mark as Inactive

1. Set workflow to **INACTIVE**
2. Add note: "Ready for testing - DO NOT ACTIVATE without approval"
3. Save workflow

---

## 2. Router v3 Updates

Open `Main Router v3` (`fhyTsd1DSN6wtMGz`)

### Step 1: Replace Sheets Lookups

**Find**: 3 Google Sheets nodes:
- "Lookup Businesses"
- "Lookup Leads"
- "Lookup Chats"

**Replace** first two with Firestore:

**New Node 1**: Firestore GET "Get Business"
```
Collection: businesses
Document ID: {{ $json.phone }}
Continue on fail: true
Simple: true
```

**New Node 2**: Firestore GET "Get Lead"
```
Collection: leads
Document ID: {{ $json.phone }}
Continue on fail: true
Simple: true
```

**Keep**: "Lookup Chats" Sheets node (ephemeral debounce)

### Step 2: Update Route Targets

**Find**: Switch/Router node with business/lead/new/customer routes

**Update** targets:

**Business route**:
```
OLD: Execute Workflow → Business Handler2 (V44w39VTt691WGxK)
NEW: Execute Workflow → Business Handler Agents (NEW_WORKFLOW_ID_FROM_STEP_1)
```

**Lead route**:
```
OLD: Execute Workflow → Signup Bot2 resume
NEW: Execute Workflow → Forly Leads Handler (vkfYpJL5KONzlbJN)
```

**New route**:
```
OLD: Build lead → Signup Bot2 cold
NEW: Execute Workflow → Forly Leads Handler (vkfYpJL5KONzlbJN)
```

**Customer route**: (unchanged)
```
Execute Workflow → Customer Handler3 (yt9XbrvbLIp3x8vm)
```

### Step 3: Field Mapping

**Find ALL** references to `businessData.*` in Router v3

**Replace** with direct Firestore field access:
- Source changes from Sheets row to Firestore doc
- Fields accessed directly: `{{ $json.full_name }}` not `{{ $json.businessData.full_name }}`

### Step 4: Keep Inactive

- Workflow remains **INACTIVE**
- Test thoroughly before activation
- Keep Router v2 (`Ts6jOCWC6iYSj0V9`) as active rollback target

---

## 3. Signup Bot2 Extensions

Open `Call4li signup Bot2` (`CUt4ufMptd8xHW4D`)

⚠️ **CRITICAL**: This workflow is ACTIVE. Test all changes in staging first.

### Step 1: Impatience Detection

**Find**: After each user reply in onboarding flow

**Add**: Anthropic "Detect Impatience"
```
Model: claude-haiku-4-5-20251001
Max tokens: 50
Prompt: "User message: '{{ $json.reply }}'. Detect impatience (keywords: כמה עוד, ארוך, נמאס, מתי נגמר). JSON: {impatient: bool}"
```

**Add**: IF node "Is Impatient"
```
Condition: {{ $('Detect Impatience').first().json.impatient == true }}

True branch:
1. Calculate remaining: {{ $json.total_questions - $json.current_step }}
2. HTTP Request to signupDeepLink Function:
   POST {{ $env.FIREBASE_FUNCTIONS_URL }}/signupDeepLink
   Body: { phone: "{{ $json.phone }}", step: {{ $json.current_step }} }
   Output: { token }
3. Green-API send:
   "נשארו רק {{ remaining }} שאלות 🙂
   או שתעדיף להמשיך בטופס מהיר:
   app.call4li.com/signup?resume={{ $json.phone }}&t={{ $json.token }}"
4. Continue to next question
```

### Step 2: Web Deep-Link Trigger

**Add**: Keywords Check (after each reply)
```javascript
const message = $json.reply.toLowerCase();
const keywords = ['אתר', 'טופס', 'קישור', 'לינק'];
const wantsWebForm = keywords.some(k => message.includes(k));

if (wantsWebForm) {
  // Same as impatience → offer deep-link
  return [{ json: { ...$json, wants_web_form: true } }];
}
```

### Step 3: Replace Sheets Writes with Firestore

**Find**: Node "Write to Businesses Sheet" (at completion)

**Delete**: Sheets write node

**Add**: Firestore PATCH "Create Business"
```
URL: https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/businesses/{{ $json.phone }}
Method: PATCH
Auth: Google Service Account
Body: {
  "fields": {
    "phone": { "stringValue": "{{ $json.phone }}" },
    "full_name": { "stringValue": "{{ $json.name }}" },
    "city": { "stringValue": "{{ $json.city }}" },
    "specialty": { "stringValue": "{{ $json.specialty }}" },
    "status": { "stringValue": "active" },
    "source": { "stringValue": "signup_bot" },
    "created_at": { "stringValue": "{{ $now.toISO() }}" },
    "updated_at": { "stringValue": "{{ $now.toISO() }}" }
  }
}
```

**Add**: Firestore PATCH "Create Quota"
```
URL: https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/businesses/{{ $json.phone }}/quota/current
Method: PATCH
Body: {
  "fields": {
    "cap": { "stringValue": "unlimited" },
    "used": { "integerValue": 0 },
    "period": { "stringValue": "weekly" }
  }
}
```

### Step 4: Welcome Message

**Add AFTER**: Firestore writes

**Node**: Green-API "Send Welcome"
```
Message:
ברוכים הבאים לפורלי 🦉
מה שיקרה עכשיו:
✅ תוך שניות — תכנית שיווקית שבועית
✅ תוך 30-60 דק׳ — כל התכנים מוכנים
✅ כל יום ראשון — דוח ביצועים
יש נכסים? שלח עכשיו, אחרת נתחיל עם תוכן לפרופיל שלך.
```

### Step 5: Lead Handoff

**Add BEFORE**: Welcome message

**Node 1**: Firestore GET "Check Lead"
```
Collection: leads
Document ID: {{ $json.phone }}
Continue on fail: true
```

**Node 2**: IF "Lead Exists"
```
Condition: {{ $('Check Lead').first().json._id != null }}

True branch:
1. Copy carousel:
   - Extract: $('Check Lead').first().json.carousel
   - Store as first weekly item (implementation depends on your plan structure)

2. Firestore PATCH "Mark Converted":
   URL: .../leads/{{ $json.phone }}
   Body: {
     "fields": {
       "status": { "stringValue": "converted" },
       "converted_at": { "stringValue": "{{ $now.toISO() }}" }
     }
   }

3. Firestore POST "Create Event":
   URL: .../businesses/{{ $json.phone }}/events
   Body: {
     "fields": {
       "type": { "stringValue": "lead_converted" },
       "status": { "stringValue": "completed" },
       "ts": { "stringValue": "{{ $now.toISO() }}" }
     }
   }
```

### Step 6: Test in Staging

1. **DO NOT activate** these changes in production immediately
2. Test with test phone numbers first
3. Verify:
   - Impatience detection works
   - Deep-links generate correctly
   - Firestore writes succeed
   - Lead handoff copies carousel
   - Welcome message sends

---

## Activation Checklist

Before activating ANY workflow:

- [ ] All node changes applied
- [ ] Credentials relinked (Anthropic, Firestore, Green-API)
- [ ] Test with non-production phone numbers
- [ ] Verify Firestore permissions
- [ ] Confirm API quotas sufficient
- [ ] Router v2 + BH2 available for rollback
- [ ] Monitor logs for 1 hour after activation
- [ ] **Get explicit approval** from team

---

## Rollback Plan

If issues after activation:

### Router v3 Issues
1. Deactivate Router v3 (`fhyTsd1DSN6wtMGz`)
2. Activate Router v2 (`Ts6jOCWC6iYSj0V9`)
3. Time: <2 minutes

### Business Handler Agents Issues
1. Update Router v3 to point back to Business Handler2
2. Deactivate Business Handler Agents
3. Time: <5 minutes

### Signup Bot2 Issues
1. Revert changes (restore from backup/history)
2. Or rollback to previous version if duplicated
3. Time: <10 minutes

---

## Questions During Implementation?

Check:
1. `WORKFLOWS-SUMMARY.md` - detailed specs
2. `TESTING-GUIDE.md` - how to test each change
3. Original workflow documentation in `n8n-workflows/`

Good luck! 🚀
