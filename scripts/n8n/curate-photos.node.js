// n8n "Curate Photos" node (WW1 Walkthrough V2). Generated: walkthrough-order.js
// without module.exports + this wrapper. Regenerate after editing walkthrough-order.js:
//   (sed "/^module.exports/d" walkthrough-order.js; sed -n "/^const MIN_PHOTOS/,\$p" curate-photos.node.js) 

// Walkthrough frame order for the n8n "WW1 Walkthrough V2" Curate Photos node.
// Pasted verbatim into that Code node (drop module.exports); keep it
// dependency-free. Spec: docs/superpowers/specs/2026-09-27-walkthrough-order-endframe-design.md
const OUTDOOR = ["exterior", "garden", "roof", "pool", "view"];
const LOUNGE = ["living_room", "open_plan"];
const BALCONY = ["balcony"];
const BANNED = ["bedroom", "master_bedroom", "kids_room", "bathroom", "toilet", "hallway"];

const typeOf = (t) => String(t.room_type || "").toLowerCase();
const banned = (t) => BANNED.includes(typeOf(t)) || typeOf(t).includes("shower");
// Highest quality_score among photos matching `ok`; ties keep upload order.
function best(photos, ok, skip) {
  let pick = null;
  for (const t of photos) {
    if (t === skip || !ok(t)) continue;
    if (!pick || (t.quality_score || 0) > (pick.quality_score || 0)) pick = t;
  }
  return pick;
}
const inGroup = (g) => (t) => g.includes(typeOf(t));

function orderPhotos(tags, max = 12) {
  const photos = tags.slice();
  const edgeOk = (t) => !banned(t);
  let opener = best(photos, inGroup(OUTDOOR));
  let group = opener ? "outdoor" : null;
  if (!opener) { opener = best(photos, inGroup(LOUNGE)); group = opener ? "lounge" : null; }
  if (!opener) { opener = best(photos, edgeOk); group = opener ? "other" : null; }
  if (!opener) return { curated: photos.slice(0, max), opener_group: "other" };

  const order = group === "lounge" ? [BALCONY, LOUNGE] : [LOUNGE, BALCONY];
  let closer = best(photos, inGroup(order[0]), opener) || best(photos, inGroup(order[1]), opener)
    || best(photos, edgeOk, opener);

  const middle = photos.filter((t) => t !== opener && t !== closer)
    .map((t, i) => [t, i])
    .sort((a, b) => (b[0].quality_score || 0) - (a[0].quality_score || 0) || a[1] - b[1])
    .map(([t]) => t)
    .slice(0, max - (closer ? 2 : 1));
  return { curated: [opener, ...middle, ...(closer ? [closer] : [])], opener_group: group };
}


const MIN_PHOTOS = 4;
const tags = ($input.first().json.tags || []).filter(t => t.is_real_estate !== false && t.quality_score >= 4);
const { curated, opener_group } = orderPhotos(tags, 12);
if (curated.length < MIN_PHOTOS) {
  throw new Error("Need at least " + MIN_PHOTOS + " usable photos for a 2-clip walkthrough, got " + curated.length);
}
return [{ json: { curated, count: curated.length, opener_group } }];
