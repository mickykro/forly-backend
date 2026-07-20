/*
 * Unit tests for overlay.js pure helpers (no ffmpeg / no network).
 * Run: node server/overlay.test.js
 */
const assert = require("assert");
const { _test, MAX_ROOMS } = require("./overlay");
const { buildAss, buildFfmpegArgs, labelsToSegments, roomLabel, modeOf } = _test;

// ── roomLabel mapping ──
assert.equal(roomLabel("living room"), "סלון");
assert.equal(roomLabel("Master-Bedroom"), "חדר שינה ראשי");
assert.equal(roomLabel({ room_type: "kitchen" }), "מטבח");
assert.equal(roomLabel("סלון"), "סלון");            // already Hebrew → pass-through
assert.equal(roomLabel("weird_type"), "weird_type"); // unknown → as-is
assert.equal(roomLabel(""), "");
assert.equal(roomLabel(null), "");

// ── modeOf ──
assert.equal(modeOf([]), null);
assert.equal(modeOf(["a", "b", "a"]), "a");
assert.equal(modeOf(["x"]), "x");
assert.equal(modeOf(["a", "b"]), "a"); // first-seen wins tie

// ── labelsToSegments ──
const times = Array.from({ length: 20 }, (_, i) => (i + 0.5) * 0.5);
let segs = labelsToSegments(
  "a a a a a a a a b b b b b b c c c c c c".split(" ").map((x) => ({ a: "סלון", b: "מטבח", c: "חדר שינה" }[x])),
  times, 10);
assert.equal(segs.length, 3);
assert.equal(segs[0].start, 0);
assert.equal(segs[2].end, 10);
assert.ok(Math.abs(segs[0].end - 4.0) < 1e-9);
assert.ok(Math.abs(segs[1].start - 4.0) < 1e-9);

// single-blip healing
segs = labelsToSegments(["a", "a", "b", "a", "a", null, null, null, null, null], times.slice(0, 10), 5);
assert.equal(segs.length, 1);
assert.equal(segs[0].label, "a");

// short runs dropped
segs = labelsToSegments(["a", "b", "c", "d", "e", "f"], times.slice(0, 6), 3);
assert.equal(segs.length, 0);

// ── buildAss with cornered room segments (name + descriptor) ──
const rs = [
  { label: "סלון", desc: "מרווח ומואר", start: 0, end: 4 },
  { label: "מטבח", desc: null, start: 4, end: 7.25 },
];
const ass = buildAss({ width: 720, height: 1280, duration: 10 }, ["דירת 180 מ״ר | קומה 41"], rs);
// Room style: outline mode (BorderStyle 1), bottom-right (Alignment 3), size 1280*0.040=51
const roomStyle = ass.split("\n").find((l) => l.startsWith("Style: Room,")).split(",");
assert.equal(roomStyle[2], "51", "room name font = round(1280*0.040)");
assert.equal(roomStyle[15], "1", "BorderStyle 1 (outline, not box)");
assert.equal(roomStyle[18], "3", "Alignment 3 (bottom-right)");
// Room events
assert.ok(ass.includes("Dialogue: 0,0:00:00.00,0:00:04.00,Room,"), "first room event timing");
assert.ok(ass.includes("Dialogue: 0,0:00:04.00,0:00:07.25,Room,"), "second room event timing");
// descriptor stacks under the name via \N + \fs override (1280*0.028=36); RLM on both lines
assert.ok(ass.includes("{\\fad(150,150)}‏סלון\\N{\\fs36}‏מרווח ומואר"), "name + descriptor line");
// no-descriptor segment is a single line
assert.ok(ass.includes("{\\fad(150,150)}‏מטבח\n"), "single-line room when no descriptor");
// end titles unchanged
assert.ok(ass.includes("Dialogue: 0,0:00:07.00,0:00:11.00,Title,"), "title event unchanged");

// no rooms → no room events
const ass2 = buildAss({ width: 720, height: 1280, duration: 10 }, ["שורה"]);
assert.ok(!ass2.includes(",Room,,"), "no room events without segments");

// ── buildFfmpegArgs ──
const info = { width: 720, height: 1280, duration: 10 };
// no rooms → simple -vf ass pass, audio copied
const plain = buildFfmpegArgs("in.mp4", "t.ass", "out.mp4", info, []);
assert.ok(plain.includes("-vf") && plain[plain.indexOf("-vf") + 1] === "ass=t.ass");
assert.ok(!plain.includes("-filter_complex"), "no filter_complex without rooms");

// rooms → gradient overlay + ass, cream lavfi input, enable windows, escaped commas
const fc = buildFfmpegArgs("in.mp4", "t.ass", "out.mp4", info, rs);
const li = fc.indexOf("-filter_complex");
assert.ok(li > 0, "filter_complex present with rooms");
const filter = fc[li + 1];
assert.ok(fc.join(" ").includes("color=c=0xF7F3EC:s=720x282"), "cream lavfi band = round(1280*0.22)=282");
assert.ok(filter.includes("overlay=x=0:y=998"), "gradient overlaid at bottom (1280-282)");
assert.ok(filter.includes("between(t\\,0.00\\,4.00)+between(t\\,4.00\\,7.25)"), "per-segment enable, escaped commas");
assert.ok(filter.includes("pow(clip(Y/(H-1)\\,0\\,1)\\,1.2)"), "vertical alpha ramp");
assert.ok(fc.includes("0:a?"), "audio mapped optionally");

assert.equal(MAX_ROOMS, 12);
console.log("all overlay tests passed");
