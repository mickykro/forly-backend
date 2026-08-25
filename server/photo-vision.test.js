/* photo-vision.js — the parts that decide what reaches a page. The vision call
   itself is not exercised here; what matters is that nothing malformed, over-
   long or invented can get past parseReply, and that the prompt keeps asking
   for only what is visible. */
const assert = require("assert");
const { _test, CAPTION_MAX, DESC_MAX } = require("./photo-vision");
const { buildPrompt, parseReply, clean } = _test;

// ── clean ──
assert.equal(clean("  מטבח  ", 40), "מטבח");
assert.equal(clean("שורה\nשנייה", 40), "שורה שנייה");   // newlines would break the card
assert.equal(clean(null, 40), "");
assert.equal(clean(undefined, 40), "");
assert.equal(clean("א".repeat(80), 40).length, 40);

// ── parseReply: always exactly `count` entries, whatever comes back ──
const good = '[{"caption":"המטבח","desc":"אי מרכזי ונגרות עד התקרה."},' +
             '{"caption":"המרפסת","desc":"מרפסת מקורה עם נוף לירוק."}]';
assert.deepEqual(parseReply(good, 2), [
  { caption: "המטבח", desc: "אי מרכזי ונגרות עד התקרה." },
  { caption: "המרפסת", desc: "מרפסת מקורה עם נוף לירוק." },
]);

// a short reply is padded rather than leaving the caller to index past the end
assert.deepEqual(parseReply('[{"caption":"המטבח","desc":"אי מרכזי."}]', 3), [
  { caption: "המטבח", desc: "אי מרכזי." },
  { caption: "", desc: "" },
  { caption: "", desc: "" },
]);

// a long reply is cut to the photos we actually have
assert.equal(parseReply(good, 1).length, 1);

// prose around the JSON is tolerated; anything else is an error, not a guess
assert.equal(parseReply('בבקשה:\n' + good + '\nבהצלחה', 2)[0].caption, "המטבח");
assert.throws(() => parseReply("no json here", 2), /no JSON array/);

// wrong-shaped entries become empty, never "[object Object]" under a photo
assert.deepEqual(parseReply('["המטבח", null, 42]', 3),
  [{ caption: "", desc: "" }, { caption: "", desc: "" }, { caption: "", desc: "" }]);

// over-long values are cut at the documented limits
const long = parseReply(JSON.stringify([{ caption: "א".repeat(90), desc: "ב".repeat(300) }]), 1)[0];
assert.equal(long.caption.length, CAPTION_MAX);
assert.equal(long.desc.length, DESC_MAX);

// ── the prompt has to keep its promises ──
const prompt = buildPrompt(4, ["סלון", "מטבח"]);
assert.ok(prompt.includes("4 תמונות"), "states how many photos it is looking at");
assert.ok(prompt.includes("בדיוק 4"), "asks for exactly that many objects back");
assert.ok(prompt.includes("סלון, מטבח"), "passes the tagger's vocabulary as a hint");
assert.ok(/אל תמציא/.test(prompt), "forbids inventing what is not in the photo");
assert.ok(/סופרלטיבים/.test(prompt), "rules out the superlatives the copy generator also bans");
assert.ok(/מחרוזות ריקות/.test(prompt), "prefers an empty string to a guess");

// no tagger vocabulary → no dangling hint line
assert.ok(!buildPrompt(2, []).includes("סוגי החללים"));

console.log("photo-vision: all tests passed");
