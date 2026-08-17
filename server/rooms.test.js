/* rooms.js — the Vision-Tagger → Hebrew vocabulary shared by the burned-in
   video labels and the landing page's photo captions. */
const assert = require("assert");
const { roomLabel } = require("./rooms");

// ── exact types ──
assert.equal(roomLabel("living_room"), "סלון");
assert.equal(roomLabel("Master-Bedroom"), "חדר שינה ראשי");
assert.equal(roomLabel({ room_type: "kitchen" }), "מטבח");
assert.equal(roomLabel({ label: "balcony" }), "מרפסת");

// ── compound types the tagger invents fall back on a keyword ──
assert.equal(roomLabel("open_plan_apartment"), "חלל פתוח");
assert.equal(roomLabel("guest_bedroom"), "חדר שינה");
assert.equal(roomLabel("second_balcony"), "מרפסת");

// ── already Hebrew passes through; unknown English is dropped rather than
//    printed raw under a photo ──
assert.equal(roomLabel("סלון"), "סלון");
assert.equal(roomLabel("weird_type"), "");
assert.equal(roomLabel(""), "");
assert.equal(roomLabel(null), "");
assert.equal(roomLabel(undefined), "");

// ── the resolution the page builder applies per photo: an explicit caption
//    wins, then the tagger's type on the photo, then a parallel rooms[] entry.
//    Mirrors captionFor() in routes/pages.js. ──
function captionFor(photos, rooms, i) {
  const p = photos[i] || {};
  const explicit = String(p.caption || "").trim();
  if (explicit) return explicit.slice(0, 60);
  return roomLabel(p.room_type || p.room || p.label || rooms[i] || "").slice(0, 60);
}

const photos = [
  { caption: "הסלון שלנו" },              // agent wrote one — untouched
  { room_type: "kitchen" },               // tagger on the photo
  {},                                     // tagger in a parallel array
  {},                                     // nothing anywhere
  { caption: "   ", room_type: "toilet" },// blank caption is not a caption
];
const rooms = [null, null, "master_bedroom", null, null];

assert.equal(captionFor(photos, rooms, 0), "הסלון שלנו");
assert.equal(captionFor(photos, rooms, 1), "מטבח");
assert.equal(captionFor(photos, rooms, 2), "חדר שינה ראשי");
assert.equal(captionFor(photos, rooms, 3), "");
assert.equal(captionFor(photos, rooms, 4), "שירותים");

// a caption longer than the column allows is cut, not wrapped into the payload
assert.equal(captionFor([{ caption: "א".repeat(90) }], [], 0).length, 60);

// an unknown tagger type must not leak the raw English onto the page
assert.equal(captionFor([{ room_type: "sauna_deck" }], [], 0), "");

console.log("rooms: all tests passed");
