# Nearby amenities — walking-first, client-relevant categories

Applies to the n8n workflows **Forly — Property Page Builder** (`csEnTziNFrNNHaE9`),
**… dev** (`xJeoWbjNS5E2Wt4X`) and **… private** (`Hke9ZUeb5Pb8V1pG`). Apply by
hand in the n8n editor — the MCP update path rewrites the whole workflow and
drops node credentials.

## Client feedback (נופר הרוש, 11.10)
"זה אף פעם לא נכון · הכל מרחק הליכה · יש אזורי עניין אחרים רלוונטים — מרכז
מסחרי, בתי כנסת, קופות חולים".

## What was wrong
1. **Wrong categories.** Only park / transit_station / supermarket / school /
   beach. No commercial centre, synagogue or health-fund clinic.
2. **Drive-time fallback for neighbourhood amenities.** Anything over 1300 m on
   foot was shown as "X דק׳ נסיעה". For a city neighbourhood that reads as wrong:
   buyers judge it on what is walkable.
3. **Types too narrow.** `supermarket` alone misses grocery-typed local stores and
   `transit_station` picks up arbitrary stations, so the "nearest" hit was often
   not the real nearest relevant place, which then got a drive time.
4. `Distance Walking` carries an empty header row (`sendHeaders: true`, `[{}]`).
   Remove it. [Unverified] whether it ever broke the request.

## New behaviour
| Category | Lookup | Shown when |
|---|---|---|
| סופרמרקט | Nearby `supermarket`,`grocery_store` | walk ≤ 1300 m |
| מרכז מסחרי | Text "מרכז מסחרי", name must match מרכז מסחרי/קניון/… or type `shopping_mall` | walk ≤ 1300 m |
| בית כנסת | Nearby `synagogue` | walk ≤ 1300 m |
| קופת חולים | Text "קופת חולים", name must match כללית/מכבי/מאוחדת/לאומית/קופת חולים | walk ≤ 1300 m |
| בית ספר | Nearby `school`,`primary_school`,`secondary_school` | walk ≤ 1300 m |
| פארק / גינה | Nearby `park`,`playground` | walk ≤ 1300 m |
| רכבת | Nearby `train_station`,`light_rail_station`,`subway_station` | walk, else drive ≤ 12 min |
| חוף הים | Nearby `beach` | walk, else drive ≤ 15 min |

Stops are sorted walkable-first, then by minutes, capped at 6 on the page. The
copywriter still receives every measured amenity in `proximity`.

Known limit: text-search targets always request Hebrew names (needed for the
name filter), so non-Hebrew pages show Hebrew names for those two categories.

## Changes

### 1. `Build Amenity Targets` — replace code
```js
const ctx = $('Check Geocode').first().json;
const LANG = ctx.language || 'he';

const LOC = {
  he: { market:'סופרמרקט', commerce:'מרכז מסחרי', synagogue:'בית כנסת', clinic:'קופת חולים', school:'בית ספר', park:'פארק / גינה', transit:'רכבת', beach:'חוף הים' },
  en: { market:'Supermarket', commerce:'Shopping center', synagogue:'Synagogue', clinic:'Health clinic', school:'School', park:'Park', transit:'Train', beach:'Beach' },
  ar: { market:'سوبرماركت', commerce:'مركز تجاري', synagogue:'كنيس', clinic:'صندوق المرضى', school:'مدرسة', park:'حديقة', transit:'قطار', beach:'الشاطئ' },
  ru: { market:'Супермаркет', commerce:'Торговый центр', synagogue:'Синагога', clinic:'Поликлиника', school:'Школа', park:'Парк', transit:'Поезд', beach:'Пляж' },
  es: { market:'Supermercado', commerce:'Centro comercial', synagogue:'Sinagoga', clinic:'Clínica', school:'Colegio', park:'Parque', transit:'Tren', beach:'Playa' },
  fr: { market:'Supermarché', commerce:'Centre commercial', synagogue:'Synagogue', clinic:'Dispensaire', school:'École', park:'Parc', transit:'Train', beach:'Plage' },
};
const L = LOC[LANG] || LOC.he;

// Neighbourhood amenities are walking-only (drive:false) — a buyer judges a
// neighbourhood by what is on foot. Only rail and beach may fall back to a
// short drive. `text` targets use Text Search because Google has no
// reliable place type for a קופת חולים or a neighbourhood מרכז מסחרי;
// `nameRe` then rejects off-topic hits (e.g. a pharmacy for "קופת חולים").
const targets = [
  { key:'market',    types:['supermarket','grocery_store'],                           radius:1500 },
  { key:'commerce',  text:'מרכז מסחרי', nameRe:'מרכז מסחרי|מרכז קניות|קניון|שופינג', alsoTypes:['shopping_mall'], radius:1500 },
  { key:'synagogue', types:['synagogue'],                                             radius:1500 },
  { key:'clinic',    text:'קופת חולים', nameRe:'קופת חולים|קופ"ח|כללית|מכבי|מאוחדת|לאומית', radius:1500 },
  { key:'school',    types:['school','primary_school','secondary_school'],            radius:1500 },
  { key:'park',      types:['park','playground'],                                     radius:1500 },
  { key:'transit',   types:['train_station','light_rail_station','subway_station'],   radius:5000, drive:true, maxMins:12 },
  { key:'beach',     types:['beach'],                                                 radius:8000, drive:true, maxMins:15 },
];

if (!ctx.geocoded) {
  return [{ json: {
    key: '', category: '', skip: true, language: LANG, lat: 0, lng: 0,
    drive: false, maxMins: 0, nameRe: '', alsoTypes: [],
    endpoint: 'https://places.googleapis.com/v1/places:searchNearby',
    body: { includedTypes: ['park'], maxResultCount: 1, locationRestriction: { circle: { center: { latitude: 0, longitude: 0 }, radius: 1 } } },
  } }];
}

const circle = (r) => ({ circle: { center: { latitude: ctx.lat, longitude: ctx.lng }, radius: r } });

return targets.map(function (t) {
  const body = t.text
    // Hebrew query + Hebrew names so nameRe can match; 5 candidates to filter.
    ? { textQuery: t.text, languageCode: 'he', rankPreference: 'DISTANCE', pageSize: 5, locationBias: circle(t.radius) }
    : { includedTypes: t.types, languageCode: LANG, rankPreference: 'DISTANCE', maxResultCount: 1, locationRestriction: circle(t.radius) };
  return { json: {
    key: t.key,
    category: L[t.key],
    language: LANG,
    lat: ctx.lat,
    lng: ctx.lng,
    drive: !!t.drive,
    maxMins: t.maxMins || 0,
    nameRe: t.nameRe || '',
    alsoTypes: t.alsoTypes || [],
    endpoint: 'https://places.googleapis.com/v1/places:' + (t.text ? 'searchText' : 'searchNearby'),
    body: body,
    skip: false,
  } };
});
```

### 2. `Places Nearby` — edit node
- **URL:** `={{ $json.endpoint }}`
- **Header `X-Goog-FieldMask`:** `places.displayName,places.location,places.types`
- **JSON body:** `={{ JSON.stringify($json.body) }}`

Method, credential, `neverError` and timeout stay as they are. Both
`places:searchNearby` and `places:searchText` accept the same API-key header.

### 3. `Pick Place` — replace code
```js
const targets = $('Build Amenity Targets').all().map(function (i) { return i.json; });
const resps = $input.all().map(function (i) { return i.json; });

function matches(t, p) {
  if (!t.nameRe) return true;
  const name = (p.displayName && p.displayName.text) || '';
  if (new RegExp(t.nameRe).test(name)) return true;
  return (p.types || []).some(function (x) { return t.alsoTypes.indexOf(x) !== -1; });
}

return targets.map(function (t, i) {
  const r = resps[i] || {};
  const p = ((r && r.places) || []).filter(function (x) { return x && x.location && matches(t, x); })[0];
  const name = (p && p.displayName && p.displayName.text) || '';
  const found = !t.skip && !!name;
  return { json: {
    key: t.key || '',
    category: t.category || '',
    drive: !!t.drive,
    maxMins: t.maxMins || 0,
    language: t.language || 'he',
    origin_lat: t.lat,
    origin_lng: t.lng,
    found: found,
    name: name,
    plat: found ? p.location.latitude : t.lat,
    plng: found ? p.location.longitude : t.lng,
  } };
});
```

### 4. `Distance Walking` — delete the empty header row (or turn off *Send Headers*).

### 5. `Assemble Stops` — replace code
```js
const ctx = $('Check Geocode').first().json;
const LANG = ctx.language || 'he';

const LOC = {
  he: { walk:'דק׳ הליכה', drive:'דק׳ נסיעה' },
  en: { walk:'min walk', drive:'min drive' },
  ar: { walk:'دقيقة سيرًا', drive:'دقيقة بالسيارة' },
  ru: { walk:'мин пешком', drive:'мин на машине' },
  es: { walk:'min a pie', drive:'min en coche' },
  fr: { walk:'min à pied', drive:'min en voiture' },
};
const L = LOC[LANG] || LOC.he;

const WALK_MAX_M = 1300;   // ~15 min on foot; above this never "הליכה"
const MAX_STOPS = 6;

const places = $('Pick Place').all().map(function (i) { return i.json; });
const walks = $('Distance Walking').all().map(function (i) { return i.json; });
const drives = $('Distance Driving').all().map(function (i) { return i.json; });

function leg(resp) {
  const e = resp && resp.rows && resp.rows[0] && resp.rows[0].elements && resp.rows[0].elements[0];
  if (!e || e.status !== 'OK' || !e.distance || !e.duration) return null;
  return { meters: e.distance.value, mins: Math.max(1, Math.round(e.duration.value / 60)) };
}

const found = [];
places.forEach(function (p, i) {
  if (!p.found) return;
  const w = leg(walks[i]);
  const d = leg(drives[i]);
  if (w && w.meters <= WALK_MAX_M) {
    found.push({ p: p, walkable: true, mins: w.mins, walk_m: w.meters, drive_min: null });
  } else if (p.drive && d && d.mins <= p.maxMins) {
    found.push({ p: p, walkable: false, mins: d.mins, walk_m: w ? w.meters : null, drive_min: d.mins });
  }
  // Anything else (a neighbourhood amenity beyond walking range) is dropped.
});

found.sort(function (a, b) {
  if (a.walkable !== b.walkable) return a.walkable ? -1 : 1;
  return a.mins - b.mins;
});

const stops = [];
const proximity = [];
found.forEach(function (f, i) {
  if (i < MAX_STOPS) {
    stops.push({
      label: f.p.name,
      minutes: f.mins + ' ' + (f.walkable ? L.walk : L.drive),
      walkable: f.walkable,
    });
  }
  // The copywriter sees every measured amenity, not just the displayed ones.
  proximity.push({
    category: f.p.category,
    name: f.p.name,
    walk_m: f.walk_m,
    drive_min: f.drive_min,
    walkable: f.walkable,
  });
});

return [{ json: Object.assign({}, ctx, { stops: stops, proximity: proximity }) }];
```

### 6. Delete the orphan `Prepare Distance Query` node
It is not connected, and it has a hard-coded Maps key as an
`$env.GOOGLE_MAPS_KEY ||` fallback. If that key is live, rotate it: it is
stored in the workflow JSON.

## Cost
8 Places calls (was 5) and 16 Distance Matrix elements (was 10) per page build.
Places Text Search is the more expensive SKU; field mask kept to
name/location/types.

## Verify
Run on a known Israeli address (e.g. a residential street in Petah Tikva) and
check `Assemble Stops` output: expect a synagogue, a supermarket and a clinic
under "דק׳ הליכה", and no drive times except rail and beach.
