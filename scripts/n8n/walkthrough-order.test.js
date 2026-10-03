const assert = require("assert");
const { orderPhotos } = require("./walkthrough-order");
const p = (room_type, quality_score, i) => ({ url: `u${i}`, room_type, quality_score });
const types = (r) => r.curated.map((t) => t.room_type);

// 145395: no exterior, no balcony → open on best lounge, close on next lounge
let r = orderPhotos([p("master_bedroom", 8, 0), p("open_plan", 9, 1), p("open_plan", 7, 2), p("kids_room", 7, 3),
  p("kitchen", 8, 4), p("bathroom", 8, 5), p("office", 7, 6), p("open_plan", 8, 7)]);
assert.equal(r.opener_group, "lounge");
assert.equal(r.curated[0].url, "u1", "best lounge opens");
assert.equal(r.curated.at(-1).url, "u7", "next-best lounge closes");
assert.equal(r.curated.length, 8);

// exterior present → exterior opens, lounge closes, bedrooms/bath never at edges
r = orderPhotos([p("bedroom", 10, 0), p("exterior", 6, 1), p("living_room", 7, 2), p("balcony", 9, 3), p("toilet", 9, 4)]);
assert.equal(r.opener_group, "outdoor");
assert.deepEqual([types(r)[0], types(r).at(-1)], ["exterior", "living_room"]);

// lounge opener → balcony closes
r = orderPhotos([p("living_room", 8, 0), p("balcony", 6, 1), p("kitchen", 9, 2)]);
assert.deepEqual([types(r)[0], types(r).at(-1)], ["living_room", "balcony"]);

// best-of-type wins; ties keep upload order
r = orderPhotos([p("exterior", 7, 0), p("exterior", 9, 1), p("exterior", 9, 2), p("open_plan", 5, 3)]);
assert.equal(r.curated[0].url, "u1");

// no outdoor/lounge → best non-banned opens and closes
r = orderPhotos([p("bedroom", 9, 0), p("kitchen", 6, 1), p("dining_room", 8, 2), p("bathroom", 9, 3)]);
assert.equal(r.opener_group, "other");
assert.deepEqual([types(r)[0], types(r).at(-1)], ["dining_room", "kitchen"]);

// all banned → upload order, never throws
r = orderPhotos([p("bedroom", 5, 0), p("walk_in_shower", 9, 1), p("hallway", 7, 2)]);
assert.deepEqual(r.curated.map((t) => t.url), ["u0", "u1", "u2"]);

// cap at 12, opener and closer survive the cap
const many = Array.from({ length: 20 }, (_, i) => p("kitchen", 9, i + 2));
r = orderPhotos([p("exterior", 4, 0), p("open_plan", 4, 1), ...many]);
assert.equal(r.curated.length, 12);
assert.deepEqual([r.curated[0].url, r.curated.at(-1).url], ["u0", "u1"]);

console.log("walkthrough-order: all tests passed");
