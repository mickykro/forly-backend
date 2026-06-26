# Forly Leads Handler — n8n Workflow

**Type:** Main workflow
**Status:** New (inactive draft)
**Triggers:** executeWorkflowTrigger (from Router v3) + webhook `/webhook/lead-trigger`

## Flow (Part 7, D31 frictionless)

### 1. Triggers
- **executeWorkflowTrigger**: from Router v3 `new`/`lead` route
- **Webhook**: `/webhook/lead-trigger` (from `leadRequest` Function, web form)

### 2. Normalize input
- **Code node**: extract `{phone, name?, city?, specialty?, source}`
  - `source`: "whatsapp" | "web_new_user"
  - Validate phone: `^\d{10,15}$`

### 3. Check existing lead
- **Firestore GET**: `leads/{phone}`
- **Switch**:
  - **status == "converted"**: → WhatsApp "כבר יצרנו לך! שלח 'הצטרפות' לשירות המלא" → END
  - **status == "carousel_sent" | "nudged"**: → skip to step 7 (continue funnel), **no regen**
  - **Else (new)**: → continue to step 4

### 4. Write lead
- **Firestore SET** `leads/{phone}`:
  ```json
  {
    phone, name: name || null, city, specialty,
    status: "new", source,
    created_at: now, updated_at: now, funnel_step: 0
  }
  ```

### 5. WhatsApp ack
- **Green API sendMessage**:
  `"היי {name || 'מתווך'}! 🦉 מכינה לך עכשיו קרוסלה ממוקדת לשוק שלך — תוך כמה דקות כאן 📲"`

### 6. Synthesize topic (Haiku)
- **HTTP Request** Anthropic:
  - Model: `claude-haiku-4-5-20251001`, max_tokens: 150
  - User: `"Real-estate agent specialty: {specialty || 'general'}, city: {city || 'Israel'}. Generate: topic (Hebrew, one line carousel hook) and business_desc (Hebrew, one sentence)."`
  - Parse JSON:
    ```json
    {
      "topic": "{specialty || 'נדל\"ן'} ב{city || 'ישראל'} — פוסט שמושך פניות",
      "business_desc": "מתווך/ת, מתמחה ב{specialty}, פעיל/ה ב{city}"
    }
    ```

### 7. Generate carousel
- **Execute Workflow**: Carousel Tagged Wrapper (`Oksvt7PPwDCZXDep`, sync)
- **Input**:
  ```json
  {
    "phone": phone,
    "business_name": name || "מתווך נדל\"ן",
    "business_desc": business_desc,
    "topic": topic
  }
  ```
- **Output**: `{caption, editor_url, slide_urls[], first_slide_url}`
  - Carousel gen delivers slides to WhatsApp itself

### 8. Update lead
- **Firestore PATCH** `leads/{phone}`:
  ```json
  {
    status: "carousel_sent",
    carousel: {slide_urls, caption, editor_url, first_slide_url, sent_at: now},
    funnel_step: 1,
    updated_at: now
  }
  ```

### 9. Follow-up #1 (immediate)
- **Green API sendMessage**:
  ```
  ✅ הקרוסלה שלך מוכנה! לערוך (24ש): {editor_url}
  💡 העלה היום 18:00–20:00 — שעות שיא לנדל"ן.
  ```

### 10. Wait 60 minutes
- **Wait** node: 60m

### 11. Follow-up #2
- **Firestore PATCH** `leads/{phone}`: `funnel_step: 2`
- **Green API sendMessage**:
  ```
  העלית? ספר לי איך הגיבו 🦉 — וזו רק דוגמה אחת ממה שפורלי עושה לך כל שבוע אוטומטית.
  רוצה את השירות המלא? כתוב 'כן'
  ```

### 12. Wait 24 hours
- **Wait** node: 24h

### 13. Follow-up #3 (conversion)
- **Firestore PATCH** `leads/{phone}`: `funnel_step: 3`
- **Green API sendMessage**:
  ```
  פורלי כל שבוע: תכנית שיווקית · קרוסלות+תמונות+סרטוני דירה · דוח ביצועים.
  הכל בוואטסאפ, בלי לדעת מה לפרסם. רוצה להצטרף? כתוב 'הצטרפות'
  ```

## Conversion routing (on reply)

Handled via Router v3 → Leads Handler on `lead` route:
- **Haiku classify** intent: "כן"/"הצטרפות"/"רוצה" → `signup_intent`
- **If signup intent**:
  - Firestore PATCH `leads/{phone}`: `status: "signup_intent"`
  - Firestore CREATE event: `lead_converted (intent)`
  - **Execute Workflow**: Signup Bot2 with `forced_signup: true`
- **Else**:
  - Haiku: question → FAQ answer
  - Ignore irrelevant

## Credentials

- Firestore: Google SA OAuth2
- Green API: Instance/Token
- Anthropic: Header Auth
- Carousel Tagged Wrapper: executeWorkflow (same n8n instance)

## Notes

- **Frictionless (D31)**: no menu, just generate + deliver
- **Lead carousel = free**: not charged to quota
- **Limited access (D24')**: no walkthrough/library
- Topic synthesis uses whatever data we have (city/specialty optional)
