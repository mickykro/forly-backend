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

// ── targets ──
const space = { type: "bedroom", contains: [], off_limits: ["en-suite bathroom"] };
assert.equal(pickTarget({ shows: ["Doorway", "bathroom", "Bed!"] }, space, new Set()), "bed");
assert.equal(pickTarget({ shows: ["door"] }, space, new Set()), null);
assert.equal(pickTarget({ shows: ["entrance"] }, { type: "exterior", contains: [], off_limits: [] }, new Set()), "entrance");
assert.equal(pickTarget({ shows: ["sofa", "tv"] }, { type: "living_room", off_limits: [] }, new Set(["sofa"])), "tv");

assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2, 3], [4, 5]]);
assert.deepEqual(buildTitles({}), { title_1: "דירה", title_2: "" });
assert.equal(buildTitles({ rooms: 3.5, neighborhood: "שכונת רמות", parking: 1 }).title_1, "דירת 3.5 חדרים בשכונת רמות");

console.log("walkthrough-plan: all tests passed");
