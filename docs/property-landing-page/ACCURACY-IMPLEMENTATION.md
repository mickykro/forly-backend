# Accuracy implementation — grounded + verified copy (steps 1–4)

Target: the n8n **"Forly — Property Page Builder"** workflow (`csEnTziNFrNNHaE9`).
Nothing in the page schema or Cloud Functions changes — only the two Claude
steps and one new verify step. Everything downstream (`Assemble Page Payload`
→ `createPropertyPage`) stays identical.

Principle (from the user): **don't drop doubtful claims — fetch the right data
and verify.** The apartment's "right data" is the agent's form + the photos;
the neighbourhood's "right data" is authoritative web sources + Google Maps.

---

## A. Carousel / hero / CTA — ground in a FACT SHEET + the photos, then verify

### A1. NEW Code node `Build Copy Input` (before `Generate Copy (Claude)`)
Assembles the fact sheet from the agent's form and attaches the photos as
vision input (ground truth). Caps photos to keep the call cheap.

```js
const ctx = $('Prepare Distance Query').first().json;
const l = ctx.listing || {};

// ── FACT SHEET: only facts we actually know, from the agent's form ──
const facts = [];
facts.push('סוג עסקה: ' + (l.listing_type === 'rent' ? 'להשכרה' : 'למכירה'));
if (l.address)       facts.push('כתובת: ' + l.address);
if (l.neighborhood)  facts.push('שכונה: ' + l.neighborhood);
if (l.city)          facts.push('עיר: ' + l.city);
if (l.price)         facts.push('מחיר: ' + Number(l.price).toLocaleString('he-IL') + ' ₪');
if (l.rooms)         facts.push('חדרים: ' + l.rooms);
if (l.size_sqm)      facts.push('שטח: ' + l.size_sqm + ' מ"ר');
if (l.floor)         facts.push('קומה: ' + l.floor);
if (l.parking)       facts.push('חניות: ' + l.parking);
const factSheet = facts.join('\n');
const desc = String(l.description || '').trim();

// ── PHOTOS = ground truth for anything visual (Claude vision) ──
const imgs = (l.photos_urls || []).slice(0, 8).map(u => ({
  type: 'image', source: { type: 'url', url: u },
}));

const prompt =
'אתה קופירייטר נדל"ן יוקרתי, אך מדויק לחלוטין. מותר לכתוב אך ורק על מה שאפשר לאמת:\n' +
'(1) "גיליון העובדות" למטה (מה שהמתווך מילא), (2) מה שנראה בבירור בתמונות המצורפות, ' +
'(3) מה שכתוב ב"תיאור המתווך".\n' +
'אסור להמציא פרטים שאינם באחד מהשלושה: נוף, כיוון אוויר, שנת/רמת שיפוץ, מרפסת, ' +
'ממ"ד, מעלית, מיזוג, מחסן, וכן סופרלטיבים כמו "נדיר"/"פעם בעשור". ' +
'אם פרט מסוים אינו מאומת — כתוב במקומו פרט אחר שכן מאומת. עדיף קונקרטי ואמיתי על פני מרשים ומומצא.\n\n' +
'גיליון עובדות:\n' + factSheet + '\n\n' +
'תיאור המתווך: ' + (desc || '(לא סופק)') + '\n' +
'רקע שכונה (כללי — לא מאפיין של הדירה): ' + (ctx.area_profile ? ctx.area_profile.blurb : '(אין)') + '\n\n' +
'החזר JSON בלבד: {"hero_phrase":"משפט קצר, מותר \\\\n","carousel_slides":' +
'[{"num":"01","title":"","body":"","tag":""}] (בדיוק 4: הדירה עצמה, הסביבה/הבניין, ' +
'למה המתווך הזה, תהליך הרכישה),"cta":{"headline":"","sub":"","bullets":["",""],"button_label":""}}';

return [{ json: Object.assign({}, ctx, {
  copy_prompt_content: [{ type: 'text', text: prompt }].concat(imgs),
  fact_sheet: factSheet,
  photo_blocks: imgs,
}) }];
```

### A2. REPLACE the body of `Generate Copy (Claude)`
Vision + fact sheet, lower temperature (facts over flair):

```
={{ JSON.stringify({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1500,
  temperature: 0.4,
  messages: [{ role: 'user', content: $('Build Copy Input').first().json.copy_prompt_content }],
}) }}
```

### A3. NEW node `Verify Copy (Claude)` (between `Generate Copy` and `Assemble`)
The "checker": re-reads every sentence against the facts + photos and **rewrites**
anything unsupported into something true. Corrects, never invents.

```
={{ JSON.stringify({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1500,
  temperature: 0,
  messages: [{ role: 'user', content: [{ type: 'text', text:
    'לפניך טיוטת תוכן לדף נכס. תפקידך: לוודא שכל משפט נתמך על ידי גיליון העובדות או התמונות המצורפות. ' +
    'כל טענה שאינה נתמכת — נסח מחדש כך שתהיה מדויקת ונתמכת (אל תמחק שדות, אל תמציא פרטים חדשים). ' +
    'החזר JSON באותו מבנה בדיוק.\n\n' +
    'גיליון עובדות:\n' + $('Build Copy Input').first().json.fact_sheet + '\n\n' +
    'טיוטה:\n' + ((($('Generate Copy (Claude)').first().json.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join('\n')).match(/\{[\s\S]*\}/) || ['{}'])[0]
  }].concat($('Build Copy Input').first().json.photo_blocks) }],
}) }}
```

### A4. `Assemble Page Payload` — read from the verifier
Change the copy source from `Generate Copy (Claude)` to `Verify Copy (Claude)`:

```js
const copyResp = $('Verify Copy (Claude)').first().json;   // was: $('Generate Copy (Claude)')
```
(everything else in that node stays the same.)

---

## B. Neighbourhood — fetch the real number + verify, drop only as last resort

### B1. Strengthen `Research Area (Claude)` prompt
- Require a real `source_url` for **every** stat (already asked).
- Ground the **blurb** too: only claims found in search results; no invented
  development plans.
- Prefer authoritative sources (nadlan.gov.il / madlan / CBS / municipality).
- Ask it to double-check each number against its source before returning.

Add to the prompt string:
```
' חוק ברזל: כל נתון מספרי חייב source_url אמיתי מתוצאות החיפוש. ' +
'גם ה-blurb חייב להישען רק על מה שמצאת — אל תמציא תוכניות פיתוח, בתי ספר או מגמות. ' +
'העדף מקורות רשמיים (nadlan.gov.il, madlan, למ"ס, אתר העירייה). ' +
'לפני שאתה מחזיר — ודא שכל value באמת מופיע במקור שציינת. עד 4 stats. '
```

### B2. NEW node `Backfill Missing Stats (Claude)` (after `Filter Sourced Stats`, before `Save Area Profile`)
Only runs when fewer than 2 sourced stats survived. Does one more targeted
search to **find** a sourced value (fetch, don't drop):

```
={{ JSON.stringify({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 2000,
  tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
  messages: [{ role: 'user', content:
    'מצא עד 3 נתונים אמיתיים ומדויקים על שכונת ' +
    ($('Check Profile Freshness').first().json.listing.neighborhood ||
     $('Check Profile Freshness').first().json.listing.city) +
    ' (מחיר למ"ר, מגמת מחירים, קרבה לתחבורה/חינוך). ' +
    'החזר JSON בלבד: {"stats":[{"value":"","label":"","source_url":""}]}. ' +
    'כל נתון חייב source_url אמיתי מתוצאות החיפוש. אם אין — החזר מערך ריק. אל תמציא.' }],
}) }}
```
Then the existing source-or-drop filter merges these in and remains the final
safety net: **a number without a real source is still never shown to a buyer.**

> Distances in `area.stops` already come from Google Maps Distance Matrix on the
> geocoded address — those are real and need no change.

---

## What stays the same / safety
- Page schema, `createPropertyPage`, templates, agent edit flow: unchanged.
- Vision-by-URL uses the same Anthropic credential already configured in n8n;
  photos are the public Storage URLs already on the listing.
- Cost/latency: +1 short verify call on the copy, +1 conditional neighbourhood
  search. The neighbourhood profile is cached 90 days, so its extra call is rare.

## Going live = a change to the LIVE Property Page Builder
This edits the workflow that builds real customer pages, so per project rules it
needs an explicit go-ahead before publishing. Recommended validation after
publish: run it once on a throwaway test listing and eyeball the carousel +
neighbourhood before real traffic hits it.
