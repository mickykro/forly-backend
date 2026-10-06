const assert = require("assert");
const { planWalkthrough, pickTarget, chunk, buildTitles, MAX_CLIPS, MAX_REFS } = require("./walkthrough-plan");
const { normalizeMap } = require("./space-map");

const SUPPORTED = [4, 5, 6, 8, 10, 12, 15];
const tag = (room_type, quality_score = 8, i = 0) => ({ url: `https://f/${room_type}-${i}.jpg`, room_type, quality_score });

// ── the Be'er Sheva listing: open-plan kitchen/dining/living (4 photos) + bedroom ──
const tags = [tag("kitchen", 8, 1), tag("living_room", 9, 2), tag("dining_room", 7, 3), tag("bedroom", 8, 4), tag("living_room", 8, 5)];
const map = normalizeMap({
  spaces: [
    { type: "open_plan", contains: ["kitchen", "dining_room", "living_room"], photos: [
      { n: 1, shows: ["window", "fridge"] }, { n: 2, shows: ["sofa", "curtains"] },
      { n: 3, shows: ["kitchen island", "dining table"] }, { n: 5, shows: ["tv", "sofa"] }], off_limits: ["front door"] },
    { type: "bedroom", photos: [{ n: 4, shows: ["bathroom door", "bed", "curtains"] }], off_limits: ["en-suite bathroom"] },
  ],
  sees: [{ from: 3, to: 1, what: "kitchen island" }],
}, 5, tags.map((t) => t.room_type));
let plan = planWalkthrough(map, tags, { rooms: 6, neighborhood: "הפארק", city: "באר שבע", size_sqm: 150, floor: 2, parking: 2 });
assert.ok(plan.clips.every((c) => /perfectly level/.test(c.prompt) && /no roll, tilt, rotation or dutch angle/.test(c.prompt)), "every clip asks for a level camera");
assert.equal(plan.clip_count, 2, "one clip per space");
assert.equal(plan.opener_group, "lounge");
const [open, bed] = plan.clips;
assert.deepEqual(open.spaces, ["S1"]);
assert.equal(open.image_urls.length, 4, "every photo of the open space is a reference");
assert.equal(open.image_urls[0], "https://f/living_room-2.jpg", "best photo first");
assert.equal(open.packed, false);
assert.ok(SUPPORTED.includes(open.duration) && SUPPORTED.includes(bed.duration));
assert.ok(open.prompt.includes("Every shot stays inside this one room."));
assert.ok(open.prompt.includes("inside the room shown in @image1"), "no outdoor opening without an outdoor photo");
assert.ok(!/starting outside/.test(open.prompt));
assert.equal(bed.image_urls.length, 1);
assert.ok(/toward the bed\./.test(bed.prompt), "the bathroom door is never a target");
assert.ok(!/toward the (bathroom|door)/.test(plan.clips.map((c) => c.prompt).join(" ")));
assert.ok(plan.clips.every((c) => c.prompt.length < 5000));
assert.equal(plan.title_1, "דירת 6 חדרים בשכונת הפארק | באר שבע");
assert.equal(plan.title_2, "150 מ״ר | קומה 2 | 2 חניות");

// ── outdoor opener → lounge closes (walkthrough-order.js rules) ──
const t2 = [tag("exterior", 7, 1), tag("living_room", 9, 2), tag("bedroom", 8, 3), tag("balcony", 8, 4)];
plan = planWalkthrough(normalizeMap({}, 4, t2.map((t) => t.room_type)), t2, {});
assert.equal(plan.opener_group, "outdoor");
assert.ok(/starting outside and moving toward the house/.test(plan.clips[0].prompt));
assert.deepEqual(plan.clips.map((c) => c.image_urls[0]), ["https://f/exterior-1.jpg", "https://f/balcony-4.jpg", "https://f/bedroom-3.jpg", "https://f/living_room-2.jpg"]);

// ── many spaces: capped at 6 clips, the rest packed, nothing dropped ──
const many = ["living_room", "exterior", "balcony", "kitchen", "bedroom", "bedroom", "bedroom", "bathroom", "office", "storage"]
  .map((r, i) => tag(r, 8, i + 1));
const manyMap = normalizeMap({ sees: [{ from: 5, to: 3 }] }, many.length, many.map((t) => t.room_type));
plan = planWalkthrough(manyMap, many, {});
assert.equal(plan.clip_count, MAX_CLIPS);
assert.deepEqual(plan.dropped, []);
assert.equal(plan.clips.reduce((n, c) => n + c.spaces.length, 0), 10, "every space appears once");
assert.ok(plan.clips.some((c) => c.packed));
for (const c of plan.clips) {
  assert.ok(c.image_urls.length <= MAX_REFS);
  if (c.packed) assert.ok(c.prompt.includes("never show a door frame, doorway or passage between shots"));
}
assert.ok(!plan.clips[0].packed && !plan.clips[plan.clips.length - 1].packed, "opener and closer stay solo");
assert.ok(!plan.clips.find((c) => c.spaces.includes("S1")).packed, "the lounge stays solo");

// ── a big open space keeps up to 9 references ──
const big = Array.from({ length: 12 }, (_, i) => tag("living_room", 5 + (i % 4), i + 1));
plan = planWalkthrough(normalizeMap({ spaces: [{ type: "open_plan", photos: big.map((_, i) => ({ n: i + 1 })) }] }, 12), big, {});
assert.equal(plan.clips.length, 1);
assert.equal(plan.clips[0].image_urls.length, 9);
assert.ok(/from another angle/.test(plan.clips[0].prompt), "spare references are named as other angles");

// ── low-quality and non-property photos are left out; too few photos is an error ──
const weak = [tag("kitchen", 3, 1), tag("living_room", 9, 2), { ...tag("bedroom", 9, 3), is_real_estate: false }, tag("bedroom", 8, 4)];
assert.throws(() => planWalkthrough(normalizeMap({}, 4, weak.map((t) => t.room_type)), weak, {}), (e) => e.code === "too_few_photos");

// ── image_urls only (no Vision Tagger): the map's quality filters and orders ──
const bare = [1, 2, 3, 4, 5].map((i) => ({ url: `https://f/${i}.jpg`, room_type: "", quality_score: null }));
const bareMap = normalizeMap({ spaces: [
  { type: "open_plan", photos: [{ n: 1, quality: 6 }, { n: 2, quality: 9 }, { n: 3, quality: 2 }] },
  { type: "bedroom", photos: [{ n: 4, quality: 7 }, { n: 5 }] },
] }, 5);
plan = planWalkthrough(bareMap, bare, {});
assert.deepEqual(plan.clips.map((c) => c.image_urls), [["https://f/2.jpg", "https://f/1.jpg"], ["https://f/4.jpg", "https://f/5.jpg"]],
  "quality 2 dropped, best first, unscored photo kept");

// ── targets ──
const space = { type: "bedroom", contains: [], off_limits: ["en-suite bathroom"] };
assert.equal(pickTarget({ shows: ["Doorway", "bathroom", "Bed!"] }, space, new Set()), "bed");
assert.equal(pickTarget({ shows: ["door"] }, space, new Set()), null);
assert.equal(pickTarget({ shows: ["entrance"] }, { type: "exterior", contains: [], off_limits: [] }, new Set()), "entrance");
assert.equal(pickTarget({ shows: ["sofa", "tv"] }, { type: "living_room", off_limits: [] }, new Set(["sofa"])), "tv");

assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2, 3], [4, 5]]);
assert.deepEqual(buildTitles({}), { title_1: "דירה", title_2: "" });
assert.equal(buildTitles({ rooms: 3.5, neighborhood: "שכונת רמות", parking: 1 }).title_1, "דירת 3.5 חדרים בשכונת רמות");

// ── an unfurnished apartment: the empty middle rooms share one clip ──
{
  const types = ["living_room", "bedroom", "bedroom", "bedroom", "bathroom", "kitchen", "balcony"];
  const et = types.map((t, i) => tag(t, 8, i + 1));
  const emap = normalizeMap({ spaces: types.map((t, i) => ({ type: t, empty: t !== "kitchen", photos: [{ n: i + 1, shows: ["window"] }] })) }, types.length, types);
  const ep = planWalkthrough(emap, et, {});
  const shared = ep.clips.filter((c) => c.packed);
  assert.equal(shared.length, 1, "one clip for the empty rooms");
  assert.equal(shared[0].spaces.length, 4, "bedrooms + bathroom (+ the empty lounge) up to MAX_SHOTS shots");
  assert.ok(ep.clips.some((c) => !c.packed && c.spaces.length === 1 && emap.spaces.find((x) => x.id === c.spaces[0]).type === "kitchen"),
    "the furnished kitchen keeps its own clip");
  assert.ok(ep.clip_count < types.length, "fewer Seedance calls than rooms");
  assert.ok(/Each shot is in a different room/.test(shared[0].prompt));
  // the same rooms furnished: one clip each, as before
  const fmap = normalizeMap({ spaces: types.map((t, i) => ({ type: t, empty: false, photos: [{ n: i + 1, shows: ["window"] }] })) }, types.length, types);
  assert.ok(planWalkthrough(fmap, et, {}).clips.filter((c) => c.packed).every((c) => c.spaces.length <= 2), "furnished rooms are not packed to fit");
  // a single empty room has nothing to join
  const one = normalizeMap({ spaces: types.slice(0, 5).map((t, i) => ({ type: t, empty: i === 1, photos: [{ n: i + 1, shows: ["window"] }] })) }, 5, types.slice(0, 5));
  assert.ok(planWalkthrough(one, et.slice(0, 5), {}).clips.every((c) => !c.packed));
}

// ── presenter mode: her refs last in every clip, welcome / present / invite, silent ──
{
  const presenter = { image_urls: ["https://s/presenter/sheet.jpg"] };
  const plain = planWalkthrough(manyMap, many, {});
  const pres = planWalkthrough(manyMap, many, {}, MAX_CLIPS, { presenter });
  assert.equal(pres.presenter, true);
  assert.equal(plain.presenter, undefined, "no presenter unless asked");
  assert.ok(plain.clips.every((c) => /No people/.test(c.prompt) && !/presenter/i.test(c.prompt)), "plain prompts unchanged");
  assert.equal(pres.clip_count, plain.clip_count, "same clips");
  for (const c of pres.clips) {
    const n = c.image_urls.length;
    assert.ok(n <= MAX_REFS, "presenter refs fit the reference limit");
    assert.equal(c.image_urls[n - 1], presenter.image_urls[0], "her sheet goes last");
    assert.ok(c.prompt.includes(`@image${n} shows her as a character sheet`), "her sheet is named by its slot");
    assert.ok(/one single woman/.test(c.prompt) && /never show text or more than one of her/.test(c.prompt));
    assert.ok(/never speaks/.test(c.prompt) && /only person/.test(c.prompt) && !/No people/.test(c.prompt));
    assert.ok(SUPPORTED.includes(c.duration));
    assert.ok(c.prompt.length < 5000);
  }
  assert.ok(/walks into the frame/.test(pres.clips[0].prompt), "she enters in the opener");
  assert.ok(/inviting gesture/.test(pres.clips[pres.clips.length - 1].prompt), "she invites in the closer");
  assert.ok(pres.clips.reduce((n, c) => n + c.duration, 0) >= plain.clips.reduce((n, c) => n + c.duration, 0), "she gets time");
  // a solo room keeps 8 of its photos (1 slot goes to her)
  const big = Array.from({ length: 9 }, (_, i) => tag("living_room", 8, i + 1));
  const bigMap = normalizeMap({ spaces: [{ type: "living_room", photos: big.map((_, i) => ({ n: i + 1, shows: ["sofa"] })) }] }, 9, big.map((t) => t.room_type));
  const solo = planWalkthrough(bigMap, big, {}, MAX_CLIPS, { presenter }).clips[0];
  assert.equal(solo.image_urls.length, MAX_REFS);
  assert.equal(solo.image_urls.filter((u) => u.startsWith("https://f/")).length, MAX_REFS - 1);
  // empty presenter → plain plan
  assert.equal(planWalkthrough(manyMap, many, {}, MAX_CLIPS, { presenter: { image_urls: [] } }).presenter, undefined);
}

// ── route: which presenter a request gets ──
{
  const { presenterFrom } = require("./walkthrough-plan");
  assert.equal(presenterFrom({}, ""), null, "no base URL, no files to point at");
  assert.deepEqual(presenterFrom({}, "https://x.com/").image_urls,
    ["https://x.com/presenter/sheet.jpg"]);
  assert.deepEqual(presenterFrom({ presenter_image_urls: ["https://a/1.jpg", "http://b/2.jpg", "https://c/3.jpg", "https://d/4.jpg"] }, "").image_urls,
    ["https://a/1.jpg", "https://c/3.jpg"], "https only, at most two");
}

console.log("walkthrough-plan: all tests passed");
