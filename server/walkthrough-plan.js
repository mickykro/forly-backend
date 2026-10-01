/*
 * walkthrough-plan.js — turns a space map (space-map.js) into Seedance clips.
 *
 * One clip per space wherever possible, so Seedance never has to "walk" from
 * one room into another (that is where it invented doorways). The opener, the
 * closer and the main living space always get a clip of their own; when a
 * listing has more spaces than clips, the rest share clips as separate shots —
 * linked spaces (one photo shows the other) together first — and those clips
 * carry an explicit no-passage rule.
 *
 * Prompts are written here, not by a model: every camera target comes from the
 * map's "shows" list for that exact photo, with doors, corridors and anything
 * the map marked off-limits filtered out.
 *
 * Ordering follows scripts/n8n/walkthrough-order.js: outdoor (else the lounge)
 * opens, a lounge or balcony closes, bedrooms and bathrooms never at the edges.
 */

const SUPPORTED = [4, 5, 6, 8, 10, 12, 15]; // seedance durations, seconds
const fit = (s) => SUPPORTED.find((d) => d >= s) || 15;
const MAX_CLIPS = 6;
const MAX_REFS = 9; // seedance reference images per clip
const MAX_SHOTS = 4; // per clip
const SECONDS_PER_SOLO_SHOT = 2;
const SECONDS_PER_PACKED_SHOT = 3.5;
const MIN_PHOTOS = 4;
const MIN_QUALITY = 4;

const OUTDOOR = ["exterior", "garden", "roof", "pool", "view", "yard", "facade", "building"];
const LOUNGE = ["living_room", "open_plan", "lounge", "salon", "living_dining"];
const BALCONY = ["balcony", "terrace"];
const MINOR = ["bath", "toilet", "shower", "hallway", "corridor", "laundry", "storage", "parking", "entrance", "entry"];
const BEDROOM = ["bedroom", "kids", "children", "nursery"];

const BANNED_TARGET = /\b(doors?|doorways?|hallways?|corridors?|passages?|stairs?|staircases?|openings?|entrances?)\b/i;
const MOVES = ["glides slowly forward", "pushes in slowly", "moves gently forward"];
const TAIL = " Cut on movement between shots, no morphing or blending. Everything stays exactly as in the photos: " +
  "nothing is added, removed, moved or restyled. No people, hands or shadows of the camera operator. " +
  "Clean frame with no text, logos or watermarks.";

const kinds = (s) => [s.type, ...(s.contains || [])];
const is = (s, list) => kinds(s).some((k) => list.some((l) => k.includes(l)));
const edgeOk = (s) => !is(s, MINOR) && !is(s, BEDROOM);

function rank(s) {
  if (is(s, ["kitchen", "dining"])) return 1;
  if (is(s, OUTDOOR) || is(s, BALCONY)) return 2;
  if (is(s, ["master"])) return 3;
  if (is(s, BEDROOM)) return 4;
  if (is(s, MINOR)) return 6;
  return 5;
}

// Highest score, then most photos; ties keep map order.
function best(spaces, ok, skip = []) {
  let pick = null;
  for (const s of spaces) {
    if (skip.includes(s) || !ok(s)) continue;
    if (!pick || s.score > pick.score || (s.score === pick.score && s.photos.length > pick.photos.length)) pick = s;
  }
  return pick;
}

/**
 * Attach the tagger's photos to the map: each space's photos sorted best-first,
 * low-quality and non-property photos removed, empty spaces dropped.
 */
function buildSpaces(map, tags) {
  const usable = (t) => t && t.is_real_estate !== false && (t.quality_score ?? MIN_QUALITY) >= MIN_QUALITY;
  const unassigned = new Set(map.unassigned || []);
  const spaces = [];
  for (const s of map.spaces) {
    const photos = s.photos
      .filter((p) => !unassigned.has(p.n) && usable(tags[p.n - 1]))
      .map((p) => ({ ...p, url: tags[p.n - 1].url, quality: tags[p.n - 1].quality_score || 0 }))
      .sort((a, b) => b.quality - a.quality);
    if (photos.length) spaces.push({ ...s, photos, score: photos[0].quality });
  }
  return spaces;
}

// Order the spaces that share clips so that linked ones (a photo of one shows
// the other) sit next to each other; otherwise keep priority order.
function linkOrder(spaces, sees) {
  const spaceOf = new Map();
  spaces.forEach((s) => s.photos.forEach((p) => spaceOf.set(p.n, s)));
  const linked = (a, b) => sees.some((l) =>
    (spaceOf.get(l.from) === a && spaceOf.get(l.to) === b) || (spaceOf.get(l.from) === b && spaceOf.get(l.to) === a));
  const out = [];
  for (const s of spaces) {
    if (out.includes(s)) continue;
    out.push(s);
    for (const t of spaces) if (!out.includes(t) && linked(s, t)) out.push(t);
  }
  return out;
}

// Split `items` into `n` contiguous groups, sizes as even as possible.
function chunk(items, n) {
  const groups = [];
  let i = 0;
  for (let g = 0; g < n && i < items.length; g++) {
    const size = Math.ceil((items.length - i) / (n - g));
    groups.push(items.slice(i, i + size));
    i += size;
  }
  return groups;
}

/** Choose and order spaces into clip groups. Returns { groups, opener_group, dropped }. */
function groupSpaces(spaces, sees, maxClips = MAX_CLIPS) {
  let opener = best(spaces, (s) => is(s, OUTDOOR));
  let openerGroup = opener ? "outdoor" : null;
  if (!opener) { opener = best(spaces, (s) => is(s, LOUNGE)); openerGroup = opener ? "lounge" : null; }
  if (!opener) { opener = best(spaces, edgeOk); openerGroup = opener ? "other" : null; }
  if (!opener) { opener = best(spaces, () => true); openerGroup = "other"; }
  if (!opener) return { groups: [], opener_group: "other", dropped: [] };

  const order = openerGroup === "lounge" ? [BALCONY, LOUNGE] : [LOUNGE, BALCONY];
  const closer = best(spaces, (s) => is(s, order[0]), [opener]) || best(spaces, (s) => is(s, order[1]), [opener])
    || best(spaces, edgeOk, [opener]);
  const fixed = [opener, closer].filter(Boolean);
  const main = fixed.some((s) => is(s, LOUNGE)) ? null : best(spaces, (s) => is(s, LOUNGE), fixed);
  if (main) fixed.push(main);

  let middle = spaces.filter((s) => !fixed.includes(s))
    .map((s, i) => [s, i])
    .sort((a, b) => rank(a[0]) - rank(b[0]) || b[0].photos.length - a[0].photos.length || b[0].score - a[0].score || a[1] - b[1])
    .map(([s]) => s);
  const slots = Math.max(1, maxClips - fixed.length);
  let dropped = [];
  let middleGroups;
  if (middle.length <= slots) {
    middleGroups = middle.map((s) => [s]);
  } else {
    dropped = middle.slice(slots * MAX_SHOTS).map((s) => s.id);
    middle = linkOrder(middle.slice(0, slots * MAX_SHOTS), sees);
    middleGroups = chunk(middle, slots);
  }
  const groups = [[opener], ...(main ? [[main]] : []), ...middleGroups, ...(closer ? [[closer]] : [])];
  return { groups, opener_group: openerGroup, dropped };
}

const targetText = (t) => String(t || "").toLowerCase().replace(/[^a-z\s-]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);

// First listed thing in this photo that is a safe camera target, preferring one
// not already used in the clip.
function pickTarget(photo, space, used) {
  const off = (space.off_limits || []).map((o) => o.toLowerCase());
  const ok = (photo.shows || []).map(targetText).filter((t) =>
    t && !(BANNED_TARGET.test(t) && !(is(space, OUTDOOR) && /entrance/.test(t))) && !off.some((o) => o.includes(t)));
  return ok.find((t) => !used.has(t)) || ok[0] || null;
}

/** Build one clip from a group of spaces. `index` is its position in the video. */
function buildClip(group, index, openerGroup) {
  const packed = group.length > 1;
  const perSpace = packed ? Math.max(1, Math.floor(MAX_REFS / group.length)) : MAX_REFS;
  const image_urls = [];
  const shots = [];
  const extras = [];
  for (const space of group) {
    const refs = space.photos.slice(0, perSpace);
    const first = image_urls.length + 1;
    refs.forEach((p) => image_urls.push(p.url));
    const shotCount = packed ? 1 : Math.min(refs.length, MAX_SHOTS);
    for (let i = 0; i < shotCount; i++) shots.push({ space, photo: refs[i], idx: first + i });
    const spare = refs.slice(shotCount).map((_, i) => `@image${first + shotCount + i}`);
    if (spare.length) extras.push(`${spare.join(", ")} ${spare.length > 1 ? "show" : "shows"} the same room as @image${first} from another angle: use ${spare.length > 1 ? "them" : "it"} only to keep that room exactly as it is.`);
  }
  const duration = packed ? fit(shots.length * SECONDS_PER_PACKED_SHOT) : fit(shots.length * SECONDS_PER_SOLO_SHOT);
  const per = (duration / shots.length).toFixed(1);
  const used = new Set();
  const lines = shots.map((s, k) => {
    const target = pickTarget(s.photo, s.space, used);
    if (target) used.add(target);
    return `Shot ${k + 1} (${per}s): @image${s.idx}, the camera ${MOVES[k % MOVES.length]} toward the ${target || "center of the frame"}.`;
  });
  const head = index === 0 && openerGroup === "outdoor"
    ? "A smooth, stabilized cinematic walkthrough of a property for sale, starting outside and moving toward the house."
    : "A smooth, stabilized cinematic walkthrough of a property for sale, inside the room shown in @image1.";
  const scope = packed
    ? "Each shot is in a different room and opens directly inside it: never show a door frame, doorway or passage between shots."
    : "Every shot stays inside this one room.";
  const camera = "The camera is at eye height, moves slowly forward, never turns or pans, and stops well before its target.";
  const prompt = [head, scope, camera, ...lines, ...extras].join(" ") + TAIL;
  return {
    clip_index: index,
    duration,
    packed,
    spaces: group.map((s) => s.id),
    image_urls,
    prompt,
  };
}

const num = (v) => Number(v) || 0;

/** Hebrew end titles from property_details, e.g. "דירת 6 חדרים בשכונת הפארק | באר שבע". */
function buildTitles(d = {}) {
  const rooms = num(d.rooms);
  const nb = String(d.neighborhood || "").trim();
  const city = String(d.city || "").trim();
  const place = nb ? ` ב${nb.startsWith("שכונת") ? nb : `שכונת ${nb}`}` : "";
  const t1 = [(rooms ? `דירת ${rooms} חדרים` : "דירה") + place, city].filter(Boolean).join(" | ");
  const parking = num(d.parking);
  const t2 = [
    num(d.size_sqm) ? `${num(d.size_sqm)} מ״ר` : "",
    num(d.floor) ? `קומה ${num(d.floor)}` : "",
    parking === 1 ? "חניה" : parking > 1 ? `${parking} חניות` : "",
    !parking && d.elevator ? "מעלית" : "",
    num(d.size_balcony) ? "מרפסת" : "",
  ].filter(Boolean).slice(0, 3).join(" | ");
  return { title_1: t1, title_2: t2 };
}

/**
 * The whole plan: `map` from space-map.js, `tags` the Vision Tagger output in
 * the same order as the photos sent for mapping.
 */
function planWalkthrough(map, tags, details, maxClips = MAX_CLIPS) {
  const spaces = buildSpaces(map, tags);
  const photoCount = spaces.reduce((n, s) => n + s.photos.length, 0);
  if (photoCount < MIN_PHOTOS) {
    const err = new Error(`Need at least ${MIN_PHOTOS} usable photos for a walkthrough, got ${photoCount}`);
    err.code = "too_few_photos";
    throw err;
  }
  const { groups, opener_group, dropped } = groupSpaces(spaces, map.sees || [], maxClips);
  const clips = groups.map((g, i) => buildClip(g, i, opener_group));
  return { clips, clip_count: clips.length, opener_group, dropped, ...buildTitles(details) };
}

module.exports = {
  planWalkthrough, buildSpaces, groupSpaces, buildClip, buildTitles, pickTarget, chunk,
  MAX_CLIPS, MAX_REFS, MIN_PHOTOS,
};
