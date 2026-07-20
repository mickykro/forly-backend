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

---

## C. Distances — measure a real walk, and only use the word the number allows

**The bug (observed):** copy said a park was "מרחק הליכה" when it is ~3–4 km
away. Root cause: the workflow only measured **driving** time to a **generic**
`"פארק, {city}"` (Google can resolve that to any park in the city), and the
copywriter was free to write "מרחק הליכה" with no distance to back it. Nothing
ever measured a walk.

Definition we enforce: **walkable = ≤ 1300 m (~15 min on foot).** Anything
beyond that may never be called "הליכה / קרוב / צמוד".

### C1. REPLACE `Prepare Distance Query` + `Distance Matrix` with one Code node `Nearby Amenities + Real Distances`
Finds the **nearest actual** amenity of each type (`rankby=distance`), measures
the **real walking** distance, and labels truthfully. (The `nearest()` call uses
the Places API — enable "Places API" on the same Google key. If Places is off,
delete `nearest()` and pass the amenity text query to Distance Matrix in
`walking` mode instead — the wording gate below still fixes the false claims.)

```js
const base = $('Check Profile Freshness').first().json;
const ctx  = base.profile_fresh ? base : $('Carry Fresh Profile').first().json;
const geo  = $('Geocode Address').first().json;
let lat = null, lng = null;
if (geo && geo.status === 'OK' && geo.results && geo.results[0]) {
  lat = geo.results[0].geometry.location.lat;
  lng = geo.results[0].geometry.location.lng;
}
const helpers = this.helpers;
const KEY = $env.GOOGLE_MAPS_KEY;
const WALK_MAX_M = 1300;                 // ~15 min walk; above this: never "הליכה"

const targets = [
  { cat: 'פארק',           q: 'type=park' },
  { cat: 'תחבורה ציבורית', q: 'type=transit_station' },
  { cat: 'סופרמרקט',       q: 'type=supermarket' },
  { cat: 'בית ספר',        q: 'type=school' },
  { cat: 'חוף הים',        q: 'keyword=' + encodeURIComponent('חוף ים') },
];

async function nearest(q) {
  const url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=' +
    lat + ',' + lng + '&rankby=distance&language=he&key=' + KEY + '&' + q;
  const r = await helpers.httpRequest({ url, json: true });
  const p = (r.results || [])[0];
  return p ? { name: p.name, plat: p.geometry.location.lat, plng: p.geometry.location.lng } : null;
}
async function measure(plat, plng, mode) {
  const url = 'https://maps.googleapis.com/maps/api/distancematrix/json?origins=' +
    lat + ',' + lng + '&destinations=' + plat + ',' + plng +
    '&mode=' + mode + '&language=he&key=' + KEY;
  const r = await helpers.httpRequest({ url, json: true });
  const el = r && r.rows && r.rows[0] && r.rows[0].elements && r.rows[0].elements[0];
  if (!el || el.status !== 'OK') return null;
  return { meters: el.distance.value, mins: Math.max(1, Math.round(el.duration.value / 60)) };
}

const stops = [], proximity = [];
if (lat && lng && KEY) {
  await Promise.all(targets.map(async (t) => {
    let p; try { p = await nearest(t.q); } catch (e) { p = null; }
    if (!p) return;
    const w = await measure(p.plat, p.plng, 'walking');
    let minutes, walkable = false, meters = w ? w.meters : null;
    if (w && w.meters <= WALK_MAX_M) {
      minutes = w.mins + ' דק׳ הליכה'; walkable = true;
    } else {
      const d = await measure(p.plat, p.plng, 'driving');
      if (!d) return;
      minutes = d.mins + ' דק׳ נסיעה';
    }
    stops.push({ label: p.name || t.cat, minutes, walkable });
    proximity.push({ category: t.cat, name: p.name, walk_m: meters, walkable });
  }));
}
stops.sort((a, b) => (b.walkable ? 1 : 0) - (a.walkable ? 1 : 0));   // walkable first

const city = ctx.listing.city || '';
return [{ json: Object.assign({}, ctx, {
  lat, lng, stops, proximity,
  // static map still needs a center point:
  map_center: (lat && lng) ? (lat + ',' + lng) : null,
}) }];
```

### C2. `Assemble Page Payload` — use the measured stops
Replace the old Distance-Matrix parsing block with:
```js
const stops = $('Nearby Amenities + Real Distances').first().json.stops || [];
```
(and drop the `dm`/`ctx.landmarks` loop entirely.)

### C3. Hard rule for the copywriter (add to `Build Copy Input`, §A1)
Pass the proximity table in and forbid ungrounded proximity words:
```js
const prox = (ctx.proximity || []);
// …append to the prompt string:
'\n\nקרבה (מדודה בפועל):\n' + JSON.stringify(prox) +
'\nכלל מרחקים: מותר לומר "מרחק הליכה"/"קרוב"/"צמוד" רק לפריט עם walkable=true. ' +
'לכל השאר — לשון של נסיעה בלבד. אל תמציא מרחקים ואל תמציא מקומות שאינם ברשימה.'
```

---

## D. Add the high-value facts: renovations & future plans (sourced-or-hidden)

Buyers care most about **what's changing** — urban renewal and future transit —
and these are the **highest hallucination risk** (claims about the future), so
the rule is strict: **a future claim with no real source link is not shown.**

### D1. Extend `Research Area (Claude)` to hunt these, with sources
Add to the research prompt:
```
' חקור גם, עם מקור לכל טענה: (1) התחדשות עירונית ברחוב/בשכונה — תמ"א 38, ' +
'פינוי-בינוי, תב"ע חדשה (מקור: mavat.iplan.gov.il או אתר העירייה); ' +
'(2) תחבורה עתידית — מטרו / רכבת קלה / תחנות מתוכננות (מקור: nta.co.il, gov.il); ' +
'(3) פרויקטים עירוניים מתוכננים — פארקים, מבני ציבור, מסחר (מקור: העירייה / מבא"ת). '
```
Return these as `stats` (each with `source_url`) and/or dated lines in `blurb`.
The existing **source-or-drop** filter then guarantees only sourced future
claims survive.

### D2. (Optional, for prominence) a dedicated `area.plans[]` section
If you want future plans shown as their own block rather than mixed into stats,
add `area.plans[] = { title, detail, horizon, source_url }` — a small schema
addition in `pages.ts` (`AreaInfo`), passed through `getPropertyPage`, and one
new rendered section in the templates. Same source-or-drop rule applies. This is
a repo change (deploy-gated), separate from the n8n edits above.

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
