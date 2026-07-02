# Forly MVP v5 - Comprehensive Testing Guide

## Pre-Testing Setup

### 1. Test Phone Numbers

Use dedicated test numbers that won't affect production data:
- Lead test: `972501111111`
- Business test: `972502222222`
- Converted lead test: `972503333333`

### 2. Environment Setup

Ensure these env vars are set in n8n:
```bash
GREENAPI_INSTANCE=<your_instance>
GREENAPI_TOKEN=<your_token>
```

### 3. Firestore Test Data

Seed test data:
```bash
# Lead that's already converted
curl -X PATCH \
  'https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/leads/972503333333' \
  -H 'Authorization: Bearer $(gcloud auth print-access-token)' \
  -d '{
    "fields": {
      "phone": {"stringValue": "972503333333"},
      "status": {"stringValue": "converted"},
      "name": {"stringValue": "Test Converted"}
    }
  }'
```

---

## Individual Workflow Tests

### ✅ Test 1: Vision Tagger (`lJqU7cBKw8x7b3YR`)

**Tested**: Via curl ✓

**Retest**:
```bash
curl -X POST 'https://n8n.srv1173890.hstgr.cloud/webhook/vision-tagger' \
  -H 'Content-Type: application/json' \
  -d '{
    "image_urls": [
      "https://example.com/living-room.jpg",
      "https://example.com/kitchen.jpg",
      "https://example.com/bedroom.jpg"
    ]
  }'
```

**Expected Output**:
```json
{
  "tags": [
    {
      "url": "https://example.com/living-room.jpg",
      "is_real_estate": true,
      "category": "interior",
      "room_type": "living_room",
      "quality_score": 8.5,
      "lighting": "natural",
      "description": "...",
      "noted_features": ["..."]
    },
    ...
  ]
}
```

**Verify**:
- All URLs preserved
- Each tag has all required fields
- quality_score is numeric
- room_type correctly identified

---

### ✅ Test 2: WW1 Walkthrough (`vHUj7CfmGQszcRV7`)

**Tested**: Via curl ✓

**Retest**:
```bash
curl -X POST 'https://n8n.srv1173890.hstgr.cloud/webhook/ww1-walkthrough' \
  -H 'Content-Type: application/json' \
  -d '{
    "phone": "972501111111",
    "image_urls": [
      "https://example.com/img1.jpg",
      "https://example.com/img2.jpg",
      "https://example.com/img3.jpg",
      "https://example.com/img4.jpg"
    ],
    "listing_id": "test-listing-001",
    "trigger_source": "test",
    "property_details": {
      "address": "רחוב הרצל 1, תל אביב",
      "rooms": 4,
      "sqm": 120,
      "price": 2500000,
      "floor": 3
    }
  }'
```

**Expected Flow**:
1. Validate quota → pass
2. Vision Tagger tags images
3. Haiku curates 4-9 best shots
4. Sonnet generates detailed prompt (300+ words)
5. Seedance API creates video job
6. Polling loop (40 attempts × 15s)
7. WhatsApp delivery when ready

**Verify**:
- Hebrew titles RTL correct: "דירת 120 מ״ר | קומה 3"
- All images shown in video (check timing: 8s ÷ image_count)
- Watermarks/logos preserved
- Video URL delivered to test phone

---

### 🆕 Test 3: Forly Leads Handler (NEW)

#### 3A. New Lead Flow (Web Trigger)

```bash
curl -X POST 'https://n8n.srv1173890.hstgr.cloud/webhook/lead-trigger' \
  -H 'Content-Type: application/json' \
  -d '{
    "phone": "972501111111",
    "name": "Test Lead",
    "city": "תל אביב",
    "specialty": "apartments",
    "source": "web_new_user"
  }'
```

**Expected Flow**:
1. Normalize input → validate phone
2. Check Firestore leads/972501111111 → not found
3. Route: new_lead
4. Create lead doc in Firestore
5. WhatsApp ack: "היי Test Lead! 🦉..."
6. Haiku synthesizes topic
7. Execute Carousel Tagged Wrapper
8. Update lead: status='carousel_sent', funnel_step=1
9. Follow-up #1: "✅ הקרוסלה מוכנה..."
10. Wait 60m
11. Follow-up #2: "העלית? ספר איך הגיבו..."
12. Wait 24h
13. Follow-up #3: "רוצה להצטרף?"

**Verify**:
- Lead doc created in Firestore with correct fields
- WhatsApp messages arrive at correct intervals
- Carousel generated and URL in follow-up #1
- funnel_step increments: 0 → 1 → 2 → 3

#### 3B. Already Converted Lead

```bash
curl -X POST 'https://n8n.srv1173890.hstgr.cloud/webhook/lead-trigger' \
  -H 'Content-Type: application/json' \
  -d '{
    "phone": "972503333333",
    "source": "web_new_user"
  }'
```

**Expected**:
- Route: already_converted
- WhatsApp: "כבר יצרנו לך חשבון! 🦉"
- END (no carousel generation)

#### 3C. Existing Lead (Continue Funnel)

```bash
# First, seed a lead with status='carousel_sent'
curl -X PATCH \
  'https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/leads/972504444444' \
  -H 'Authorization: Bearer $(gcloud auth print-access-token)' \
  -d '{
    "fields": {
      "phone": {"stringValue": "972504444444"},
      "status": {"stringValue": "carousel_sent"},
      "funnel_step": {"integerValue": 1}
    }
  }'

# Then trigger
curl -X POST 'https://n8n.srv1173890.hstgr.cloud/webhook/lead-trigger' \
  -H 'Content-Type: application/json' \
  -d '{
    "phone": "972504444444",
    "source": "whatsapp"
  }'
```

**Expected**:
- Route: continue_funnel
- Skip carousel generation
- Jump to Follow-up #2 (60m mark)

---

### ⚠️ Test 4: Router v3 (`fhyTsd1DSN6wtMGz`)

**Status**: Inactive until approval

**When Testing** (after updates):

#### 4A. Business Route

```bash
# Seed business doc
curl -X PATCH \
  'https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/businesses/972502222222' \
  -H 'Authorization: Bearer $(gcloud auth print-access-token)' \
  -d '{
    "fields": {
      "phone": {"stringValue": "972502222222"},
      "full_name": {"stringValue": "Test Business"},
      "status": {"stringValue": "active"}
    }
  }'

# Send WhatsApp message to router
# (Trigger via Green-API webhook or manual execution)
```

**Expected**:
- Firestore GET businesses/972502222222 → found
- Route → Business Handler Agents
- NOT Business Handler2 (old)

#### 4B. Lead Route

```bash
# Seed lead doc (not converted)
curl -X PATCH \
  'https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/leads/972501111111' \
  -H 'Authorization: Bearer $(gcloud auth print-access-token)' \
  -d '{
    "fields": {
      "phone": {"stringValue": "972501111111"},
      "status": {"stringValue": "carousel_sent"}
    }
  }'

# Trigger router with this phone
```

**Expected**:
- Firestore GET leads/972501111111 → found, not converted
- Route → Forly Leads Handler
- NOT Signup Bot2 (old)

#### 4C. New/Cold Route

```bash
# No existing business or lead doc
# Trigger router with phone 972505555555
```

**Expected**:
- Firestore GET businesses/972505555555 → not found
- Firestore GET leads/972505555555 → not found
- Route → Forly Leads Handler
- Creates new lead

**Verify**:
- NO references to `businessData.*` (should use Firestore fields directly)
- Sheets lookup only for `pending_messages` (ephemeral)

---

### ⚠️ Test 5: Signup Bot2 Extensions (`CUt4ufMptd8xHW4D`)

**Status**: Active in production - TEST CAREFULLY

#### 5A. Impatience Detection

**Setup**: Start onboarding flow, reply with impatient message

User sends: "כמה עוד שאלות יש? נמאס לי"

**Expected**:
- Haiku classifies: `{impatient: true}`
- Calculate remaining questions
- Generate JWT token (2h expiry) via `signupDeepLink` Function
- Reply: "נשארו רק X שאלות 🙂\nאו בטופס: app.call4li.com/signup?resume={phone}&t={jwt}"

**Verify**:
- JWT token valid and contains phone
- Deep-link URL works
- Resume flow from correct step

#### 5B. Web Deep-Link Trigger

User sends: "יש אתר?" or "תשלח לי טופס"

**Expected**:
- Same as impatience → offer deep-link

#### 5C. Firestore Writes (Completion)

Complete signup flow fully.

**Expected**:
1. NO Sheets write to `Businesses`
2. Firestore PATCH `businesses/{phone}` with full schema
3. Firestore PATCH `businesses/{phone}/quota/current`
4. Welcome message sent
5. Lead handoff checked

**Verify**:
- Check Firestore console for new business doc
- Sheets `Businesses` NOT updated
- Welcome message includes all 3 bullets

#### 5D. Lead Handoff

**Setup**: Seed a lead doc before starting signup

```bash
curl -X PATCH \
  'https://firestore.googleapis.com/v1/projects/call4li/databases/(default)/documents/leads/972506666666' \
  -H 'Authorization: Bearer $(gcloud auth print-access-token)' \
  -d '{
    "fields": {
      "phone": {"stringValue": "972506666666"},
      "status": {"stringValue": "carousel_sent"},
      "carousel": {
        "mapValue": {
          "fields": {
            "slide_urls": {
              "arrayValue": {
                "values": [
                  {"stringValue": "https://example.com/slide1.jpg"}
                ]
              }
            }
          }
        }
      }
    }
  }'
```

Complete signup with this phone.

**Expected**:
1. Firestore GET leads/972506666666 → found
2. Copy carousel as bonus weekly item
3. Firestore PATCH leads/972506666666: `status='converted', converted_at=now`
4. Firestore CREATE event: `lead_converted (completed)`

**Verify**:
- Lead doc status updated to 'converted'
- Business doc has carousel as first weekly item
- Event created in events subcollection

---

### 🆕 Test 6: Business Handler Agents (NEW Fork)

**Status**: Not yet created - test after forking BH2

#### 6A. Burst Bundle (≥4 images)

Send 4 images in quick succession.

**Expected**:
- Entry node reads `stacked_images`
- Ask Walkthrough node triggers
- Persist images via `persistMedia` Function
- Firestore CREATE `pending_walkthrough_confirm/{phone}`
- Green-API buttons: ["כן, צור סרטון 🎬", "לא תודה"]
- Sheets write `pending_state`

#### 6B. Walkthrough Confirmation

User clicks "כן, צור סרטון 🎬"

**Expected**:
1. Firestore CREATE `listings/{uuid}`
2. Execute WW1 (wait for completion)
3. Firestore DELETE `pending_walkthrough_confirm/{phone}`
4. Video delivered via WhatsApp

**Verify**:
- Listing doc created with source='chat_burst'
- WW1 receives correct image_urls
- Pending confirmation deleted after

#### 6C. Walkthrough via Keywords

User sends: "תעשה לי סרטון" (with 4+ images in context)

**Expected**: Same as 6A

#### 6D. Weekly Plan Approval

**Setup**: Firestore CREATE `weekly_plans/{id}` with `status='sent'`

User replies: "אישור" or "מאשר"

**Expected**:
1. Haiku classifies: approve
2. Firestore PATCH plan: `status='approved', approved_at=now`
3. Generate items per §10.2

**Verify**:
- Plan status updated in Firestore
- Items generated and queued

#### 6E. Victory Detection

User sends: "קיבלתי פנייה מהפוסט!"

**Expected**:
1. Haiku: `{is_inquiry: true, is_deal: false}`
2. Firestore INCREMENT `businesses/{phone}.total_inquiries_reported`
3. Firestore CREATE event: `inquiry_reported`
4. Reply: "🏆 {name} — קיבלת פנייה מהתוכן! ✨"

**Verify**:
- Counter incremented in Firestore
- Event created
- NO referral ask (D28')

#### 6F. Deal Detection

User sends: "סגרתי עסקה בזכות התוכן שלכם!"

**Expected**:
1. Haiku: `{is_inquiry: false, is_deal: true}`
2. Firestore INCREMENT `businesses/{phone}.total_deals_closed`
3. Firestore CREATE event: `deal_closed`
4. Reply: "מזל טוב!! 🏠🎉 עסקה שהתחילה מתוכן."

#### 6G. Smart Memory

**Setup**: Create 3+ content_requested events

Before agent logic triggers, verify:
- Firestore GET fetches last 3 events
- Events passed as context to agent
- Agent responses reference recent context

**Verify**: Field remapping
- NO `businessData.*` references
- Uses Firestore doc fields directly

---

## End-to-End Integration Tests

### E2E Test 1: New Lead → Carousel → Conversion

1. **Webhook trigger** Forly Leads Handler with new phone
2. **Verify** carousel generated and delivered
3. **Wait 60m** or advance workflow manually
4. **Verify** Follow-up #2 sent
5. **User replies** "כן" or "הצטרפות"
6. **Router v3** routes to Signup Bot2
7. **Complete signup**
8. **Verify** lead status='converted', business doc created

**Total time**: ~24h (with waits) or ~30 min (manual advance)

### E2E Test 2: Business → Walkthrough → Video

1. **Router v3** routes business message to Business Handler Agents
2. **User sends 4 images**
3. **Verify** walkthrough confirmation prompt
4. **User clicks** "כן, צור סרטון"
5. **WW1** generates video
6. **Verify** video delivered via WhatsApp
7. **Check Firestore** for listing doc

**Total time**: ~5-10 min (Seedance processing)

### E2E Test 3: Existing Lead → Continue Funnel

1. **Seed lead** with status='carousel_sent', funnel_step=1
2. **Webhook trigger** Forly Leads Handler with this phone
3. **Verify** skips carousel generation
4. **Verify** jumps to Follow-up #2 (60m mark)
5. **User converts** via Signup Bot2
6. **Verify** lead handoff copies carousel

---

## Rollback Testing

### Scenario: Router v3 Issues After Activation

1. **Detect issue** (wrong routing, errors, etc.)
2. **Deactivate Router v3** immediately
3. **Reactivate Router v2** (backup)
4. **Verify** routing returns to normal
5. **Test with business/lead/new phones**
6. **Confirm** Business Handler2 (not Agents) handles business routes

**Rollback Time**: <5 minutes

---

## Performance Benchmarks

Expected processing times:

| Workflow | Operation | Time |
|----------|-----------|------|
| Vision Tagger | Tag 5 images | ~15-30s |
| WW1 Walkthrough | Generate video | ~3-8 min |
| Forly Leads Handler | New lead + carousel | ~2-5 min |
| Router v3 | Route decision | <2s |
| Signup Bot2 | Full onboarding | 3-10 min (user dependent) |
| Business Handler Agents | Process message | <5s |

If any operation exceeds 2× expected time, investigate:
- API rate limits (Anthropic, Seedance, Green-API)
- Firestore query performance
- n8n workflow bottlenecks

---

## Monitoring Checklist

After activation, monitor for 24h:

### Key Metrics
- [ ] Router v3 routing accuracy (business/lead/new)
- [ ] Forly Leads Handler completion rate
- [ ] Carousel generation success rate
- [ ] WW1 video delivery rate
- [ ] Signup Bot2 conversion rate
- [ ] Business Handler Agents response time

### Error Monitoring
- [ ] Check n8n execution logs hourly
- [ ] Watch for Firestore permission errors
- [ ] Monitor API quota (Anthropic, Green-API, Seedance)
- [ ] Track failed WhatsApp deliveries

### Data Integrity
- [ ] Verify leads created in Firestore (not just Sheets)
- [ ] Check businesses updated correctly
- [ ] Confirm events tracked properly
- [ ] Validate quota consumption

---

## Troubleshooting Common Issues

### Issue: Carousel not generated

**Check**:
1. Carousel Tagged Wrapper workflow active?
2. Haiku API quota remaining?
3. Phone number format correct (10-15 digits)?
4. Firestore permissions granted?

**Fix**: Check n8n logs for specific error

### Issue: WhatsApp not delivered

**Check**:
1. Green-API instance active?
2. Phone number format: `{phone}@c.us`
3. GREENAPI_INSTANCE and GREENAPI_TOKEN env vars set?
4. Green-API quota remaining?

**Fix**: Test Green-API directly via their console

### Issue: Firestore write fails

**Check**:
1. Service Account has Firestore permissions?
2. Field format correct: `{stringValue: "..."}` not plain strings?
3. Document path format: `projects/call4li/databases/(default)/documents/collection/doc_id`

**Fix**: Test Firestore API directly via curl

### Issue: Workflow timeout (Wait nodes)

**Check**:
1. Wait nodes configured correctly (unit: minutes/hours)?
2. Workflow execution not manually stopped?
3. n8n worker process running?

**Fix**: Check n8n server logs

---

## Test Report Template

After completing tests, fill out:

```markdown
# Test Report - [Date]

## Workflows Tested
- [ ] Vision Tagger
- [ ] WW1 Walkthrough
- [ ] Forly Leads Handler
- [ ] Router v3
- [ ] Signup Bot2 Extensions
- [ ] Business Handler Agents

## Results Summary

| Workflow | Status | Issues Found | Resolution |
|----------|--------|--------------|------------|
| Vision Tagger | ✅ Pass | None | - |
| WW1 | ✅ Pass | None | - |
| Forly Leads Handler | ⚠️ Partial | Follow-up #2 timing | Fixed wait duration |
| ... | ... | ... | ... |

## E2E Tests
- [ ] New Lead → Conversion: PASS / FAIL
- [ ] Business → Walkthrough: PASS / FAIL
- [ ] Existing Lead → Continue: PASS / FAIL

## Performance
- Vision Tagger avg: Xs
- WW1 avg: Xmin
- Leads Handler avg: Xmin

## Recommendations
- [ ] Ready for production
- [ ] Needs fixes before activation
- [ ] Rollback recommended

## Notes
[Any additional observations]
```

---

## Final Checklist Before Production

- [ ] All workflows validated and tested individually
- [ ] E2E tests passed
- [ ] Credentials relinked in n8n
- [ ] Firestore permissions verified
- [ ] API quotas checked (Anthropic, Green-API, Seedance)
- [ ] Rollback plan documented
- [ ] Team notified of activation schedule
- [ ] Monitoring dashboard ready
- [ ] Router v2 + BH2 available for rollback
- [ ] **Explicit approval received** for Router v3 activation

Do NOT activate Router v3 without explicit approval.
