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
 * Empty (unfurnished) rooms look alike and give Seedance little to show, so
 * the middle ones share a clip (one shot each, up to MAX_SHOTS per clip)
 * instead of spending a clip apiece; an empty lounge loses its own clip too.
 *
 * Prompts are written here, not by a model: every camera target comes from the
 * map's "shows" list for that exact photo, with doors, corridors and anything
 * the map marked off-limits filtered out.
 *
 * Ordering follows scripts/n8n/walkthrough-order.js: outdoor (else the lounge)
 * opens, a lounge or balcony closes, bedrooms and bathrooms never at the edges.
 *
 * Presenter mode (opts.presenter, 6 Oct 2026): one fixed character — the same
 * woman in every listing — walks the rooms and presents them. Her reference
 * photos go last in every clip (they take reference slots from the rooms), she
 * welcomes in the opener, points out each shot's target and invites in the
 * closer. She never speaks: Seedance's speech is gibberish, not Hebrew. Shots
 * are longer so she has time to move. Without opts.presenter nothing changes.
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
const SECONDS_PER_PRESENTER_SHOT = 3;
const SECONDS_PER_PACKED_PRESENTER_SHOT = 4;
const PRESENTER_EDGE_SECONDS = 2; // her entrance (opener) and invitation (closer)
const PRESENTER_DESCRIPTION = "a woman in her early thirties with long straight dark hair, a black blazer over a black top, " +
  "cream wide-leg trousers and black heels";

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
const PRESENTER_TAIL = " Cut on movement between shots, no morphing or blending. The rooms stay exactly as in the photos: " +
  "nothing is added, removed, moved or restyled. The presenter is the only person in the video: no other people, " +
  "no hands or shadows of the camera operator. Clean frame with no text, logos or watermarks.";

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
 * Attach the photos to the map: each space's photos sorted best-first,
 * low-quality and non-property photos removed, empty spaces dropped.
 */
function buildSpaces(map, tags) {
  // Quality: the map's score, else the tag's (Vision Tagger callers), else unknown — kept.
  const qualityOf = (p, t) => (Number.isFinite(p.quality) ? p.quality : Number.isFinite(t.quality_score) ? t.quality_score : null);
  const usable = (p, t) => t && t.is_real_estate !== false && (qualityOf(p, t) ?? MIN_QUALITY) >= MIN_QUALITY;
  const unassigned = new Set(map.unassigned || []);
  const spaces = [];
  for (const s of map.spaces) {
    const photos = s.photos
      .filter((p) => !unassigned.has(p.n) && usable(p, tags[p.n - 1]))
      .map((p) => ({ ...p, url: tags[p.n - 1].url, quality: qualityOf(p, tags[p.n - 1]) ?? MIN_QUALITY }))
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
  const main = fixed.some((s) => is(s, LOUNGE)) ? null : best(spaces, (s) => is(s, LOUNGE) && !s.empty, fixed);
  if (main) fixed.push(main);

  const ranked = spaces.filter((s) => !fixed.includes(s))
    .map((s, i) => [s, i])
    .sort((a, b) => rank(a[0]) - rank(b[0]) || b[0].photos.length - a[0].photos.length || b[0].score - a[0].score || a[1] - b[1])
    .map(([s]) => s);
  let slots = Math.max(1, maxClips - fixed.length);
  let dropped = [];
  // Two or more empty rooms: as few shared clips as hold them; the furnished
  // rooms then get the slots that are left, exactly as before.
  const empties = ranked.filter((s) => s.empty);
  let middle = ranked;
  let emptyGroups = [];
  if (empties.length > 1) {
    middle = ranked.filter((s) => !s.empty);
    const room = middle.length ? Math.max(1, slots - 1) : slots;
    const n = Math.min(Math.ceil(empties.length / MAX_SHOTS), room);
    dropped = empties.slice(n * MAX_SHOTS).map((s) => s.id);
    emptyGroups = chunk(linkOrder(empties.slice(0, n * MAX_SHOTS), sees), n);
    slots = Math.max(1, slots - emptyGroups.length);
  }
  let middleGroups = [];
  if (middle.length && middle.length <= slots) {
    middleGroups = middle.map((s) => [s]);
  } else if (middle.length) {
    dropped = dropped.concat(middle.slice(slots * MAX_SHOTS).map((s) => s.id));
    middle = linkOrder(middle.slice(0, slots * MAX_SHOTS), sees);
    middleGroups = chunk(middle, slots);
  }
  // Each group sits where its first room ranks.
  middleGroups = middleGroups.concat(emptyGroups).sort((a, b) => ranked.indexOf(a[0]) - ranked.indexOf(b[0]));
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

/**
 * Build one clip from a group of spaces. `index` is its position in the video.
 * opts: { presenter: { image_urls, description? }, last } — see presenter mode above.
 */
function buildClip(group, index, openerGroup, opts = {}) {
  const presenter = opts.presenter || null;
  const presenterRefs = presenter ? presenter.image_urls : [];
  const roomRefs = MAX_REFS - presenterRefs.length;
  const packed = group.length > 1;
  const perSpace = packed ? Math.max(1, Math.floor(roomRefs / group.length)) : roomRefs;
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
  const first = index === 0;
  const last = !!opts.last;
  const seconds = presenter
    ? shots.length * (packed ? SECONDS_PER_PACKED_PRESENTER_SHOT : SECONDS_PER_PRESENTER_SHOT) + (first ? PRESENTER_EDGE_SECONDS : 0) + (last ? PRESENTER_EDGE_SECONDS : 0)
    : shots.length * (packed ? SECONDS_PER_PACKED_SHOT : SECONDS_PER_SOLO_SHOT);
  const duration = fit(seconds);
  const per = (duration / shots.length).toFixed(1);
  const used = new Set();
  const lines = shots.map((s, k) => {
    const target = pickTarget(s.photo, s.space, used);
    if (target) used.add(target);
    const line = `Shot ${k + 1} (${per}s): @image${s.idx}, the camera ${MOVES[k % MOVES.length]} toward the ${target || "center of the frame"}.`;
    return presenter ? `${line} ${presenterAction(k, shots.length, first, last, target)}` : line;
  });
  const presenterIdx = presenterRefs.map((_, i) => image_urls.length + 1 + i);
  presenterRefs.forEach((u) => image_urls.push(u));
  const head = index === 0 && openerGroup === "outdoor"
    ? "A smooth, stabilized cinematic walkthrough of a property for sale, starting outside and moving toward the house."
    : "A smooth, stabilized cinematic walkthrough of a property for sale, inside the room shown in @image1.";
  const scope = packed
    ? "Each shot is in a different room and opens directly inside it: never show a door frame, doorway or passage between shots."
    : "Every shot stays inside this one room.";
  // Seedance rolled the camera in interiors (walls and windows leaning 15-25°,
  // tilting as it moved) when only turns and pans were ruled out: say level.
  const camera = "The camera is at eye height, moves slowly forward, never turns or pans, and stops well before its target. " +
    "It stays perfectly level the whole time, as on a gimbal: the horizon is flat and walls, door frames and windows stay " +
    "vertical, with no roll, tilt, rotation or dutch angle, even if a reference photo was taken at an angle.";
  const cast = presenter ? [presenterIntro(presenter, presenterIdx)] : [];
  const prompt = [head, scope, camera, ...cast, ...lines, ...extras].join(" ") + (presenter ? PRESENTER_TAIL : TAIL);
  return {
    clip_index: index,
    duration,
    packed,
    spaces: group.map((s) => s.id),
    image_urls,
    prompt,
    ...(presenter ? { presenter: true } : {}),
  };
}

// Who she is and how she behaves, once per clip.
function presenterIntro(presenter, idx) {
  const refs = idx.map((i) => `@image${i}`);
  const which = refs.length > 1 ? `${refs.slice(0, -1).join(", ")} and ${refs[refs.length - 1]} show` : `${refs[0]} shows`;
  return `A real-estate presenter appears in the video: ${presenter.description || PRESENTER_DESCRIPTION}. ` +
    `${which} her from the front and the side; use ${refs.length > 1 ? "them" : "it"} only for her face, hair, body and ` +
    "clothes, never for the room or background, and keep her exactly like that in every shot. She moves naturally and " +
    "calmly, smiles, and is a guide, not the subject: she stays to one side and never covers more than a third of the " +
    "frame or blocks the thing she presents. She never speaks and her lips do not move: no dialogue, voice or narration, " +
    "only soft ambient sound.";
}

// What she does in one shot: welcome first, present the target, invite last.
function presenterAction(k, count, first, last, target) {
  const thing = target ? `the ${target}` : "the room";
  if (first && k === 0) return `The presenter walks into the frame from the side, turns to the camera with a warm smile and a welcoming open-hand gesture, then gestures toward ${thing}.`;
  if (last && k === count - 1) return `The presenter stands beside ${thing}, turns to the camera, smiles and opens her hand toward the room in an inviting gesture.`;
  return `The presenter walks a few steps ahead of the camera to one side and gestures with an open hand toward ${thing}.`;
}

const MAX_PRESENTER_REFS = 2;
const PRESENTER_FILES = ["presenter/front.jpg", "presenter/side.jpg"]; // public-agent/presenter

/**
 * The presenter a /plan request asks for, or null: `presenter_image_urls`
 * (https, at most two) win; else `presenter: true` uses our own files under `baseUrl`.
 */
function presenterFrom(body = {}, baseUrl = "") {
  const given = Array.isArray(body.presenter_image_urls)
    ? body.presenter_image_urls.map((u) => String(u || "").trim()).filter((u) => /^https:\/\/\S+$/.test(u)).slice(0, MAX_PRESENTER_REFS)
    : [];
  if (given.length) return { image_urls: given };
  if (body.presenter !== true || !baseUrl) return null;
  return { image_urls: PRESENTER_FILES.map((f) => `${String(baseUrl).replace(/\/+$/, "")}/${f}`) };
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
 * The whole plan: `map` from space-map.js, `tags` the photos ([{url,
 * room_type?, quality_score?, is_real_estate?}]) in the order sent for mapping.
 */
function planWalkthrough(map, tags, details, maxClips = MAX_CLIPS, opts = {}) {
  const spaces = buildSpaces(map, tags);
  const photoCount = spaces.reduce((n, s) => n + s.photos.length, 0);
  if (photoCount < MIN_PHOTOS) {
    const err = new Error(`Need at least ${MIN_PHOTOS} usable photos for a walkthrough, got ${photoCount}`);
    err.code = "too_few_photos";
    throw err;
  }
  const { groups, opener_group, dropped } = groupSpaces(spaces, map.sees || [], maxClips);
  const presenter = opts.presenter && opts.presenter.image_urls && opts.presenter.image_urls.length ? opts.presenter : null;
  const clips = groups.map((g, i) => buildClip(g, i, opener_group, { presenter, last: i === groups.length - 1 }));
  return { clips, clip_count: clips.length, opener_group, dropped, ...buildTitles(details), ...(presenter ? { presenter: true } : {}) };
}

module.exports = {
  planWalkthrough, buildSpaces, groupSpaces, buildClip, buildTitles, pickTarget, chunk, presenterFrom,
  MAX_CLIPS, MAX_REFS, MIN_PHOTOS, MAX_PRESENTER_REFS,
};
