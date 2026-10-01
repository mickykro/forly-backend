const assert = require("assert");
const { normalizeMap, fallbackMap, parseReply, buildPrompt, mapSpaces } = require("./space-map");

// photos the model claims twice, invents, or forgets never reach the plan
let m = normalizeMap({
  spaces: [
    { type: "Open Plan", contains: ["kitchen", "living room"], photos: [{ n: 1, shows: ["kitchen island", "", "sofa"] }, { n: 3 }, { n: 99 }], off_limits: ["front door"] },
    { type: "bedroom", photos: [{ n: 3 }, { n: 2, shows: ["bed"] }] },
    { type: "ghost", photos: [{ n: 0 }] },
  ],
  sees: [{ from: 3, to: 1, what: "kitchen island" }, { from: 2, to: 2 }, { from: 7, to: 1 }],
  unassigned: [4, 4, 1],
}, 5, ["kitchen", "bedroom", "dining_room", "", "balcony"]);
assert.deepEqual(m.spaces.map((s) => s.id), ["S1", "S2", "S3"]);
assert.equal(m.spaces[0].type, "open_plan");
assert.deepEqual(m.spaces[0].contains, ["kitchen", "living_room"]);
assert.deepEqual(m.spaces[0].photos, [{ n: 1, shows: ["kitchen island", "sofa"] }, { n: 3, shows: [] }]);
assert.deepEqual(m.spaces[1].photos.map((p) => p.n), [2], "photo 3 already claimed by S1");
assert.deepEqual(m.unassigned, [4], "duplicates and already-placed photos are not unassigned");
assert.deepEqual(m.spaces[2], { id: "S3", type: "balcony", contains: [], photos: [{ n: 5, shows: [] }], off_limits: [] }, "forgotten photo 5 gets its own space with the tagger's type");
assert.equal(m.forgotten, 1);
assert.deepEqual(m.sees, [{ from: 3, to: 1, what: "kitchen island" }]);

// quality 1-10 is kept per photo; anything else is dropped
const q = normalizeMap({ spaces: [{ type: "kitchen", photos: [{ n: 1, quality: 8.4 }, { n: 2, quality: 0 }, { n: 3, quality: "x" }] }] }, 3);
assert.deepEqual(q.spaces[0].photos, [{ n: 1, shows: [], quality: 8 }, { n: 2, shows: [] }, { n: 3, shows: [] }]);
assert.ok(/"quality": 1-10 per photo/.test(buildPrompt(2, [])));
assert.ok(/type: exactly one of living_room, open_plan/.test(buildPrompt(2, [])));

// fallback = one space per photo (the old one-shot-per-photo plan)
const f = fallbackMap(3, ["kitchen", "living_room"]);
assert.deepEqual(f.spaces.map((s) => [s.type, s.photos[0].n]), [["kitchen", 1], ["living_room", 2], ["room", 3]]);
assert.deepEqual(fallbackMap(0).spaces, []);

assert.deepEqual(parseReply('Here:\n{"spaces":[],"sees":[]}\nthanks').spaces, []);
assert.throws(() => parseReply("no json"), /no JSON/);

const p = buildPrompt(3, ["kitchen", "", "bedroom"]);
assert.ok(p.includes("Photo 1 to Photo 3"));
assert.ok(p.includes("Photo 3: tagged bedroom") && !p.includes("Photo 2: tagged"));
assert.ok(/same room type is NOT enough/.test(p), "two bedrooms are not merged by type");
assert.ok(/Never list a door, doorway, hallway or corridor/.test(p));

(async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const r = await mapSpaces([{ url: "https://x/1.jpg", room_type: "kitchen" }, { url: "https://x/2.jpg" }]);
  assert.equal(r.debug, "no_api_key");
  assert.equal(r.map.spaces.length, 2);
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  console.log("space-map: all tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
