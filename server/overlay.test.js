/*
 * Unit tests for overlay.js pure helpers (no ffmpeg / no network).
 * Run: node server/overlay.test.js
 */
const assert = require("assert");
const zlib = require("zlib");
const { _test, MAX_ROOMS } = require("./overlay");
const { buildAss, buildFfmpegArgs, labelsToSegments, roomLabel, modeOf, gradientPng, bandHeight } = _test;

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
assert.equal(bandHeight(1280), 282, "band height = round(1280*0.22)");
// no rooms → simple -vf ass pass, audio copied
const plain = buildFfmpegArgs("in.mp4", "t.ass", "out.mp4", info, [], null);
assert.ok(plain.includes("-vf") && plain[plain.indexOf("-vf") + 1] === "ass=t.ass");
assert.ok(!plain.includes("-filter_complex"), "no filter_complex without rooms");

// rooms → gradient PNG overlay + ass, enable windows, escaped commas
const fc = buildFfmpegArgs("in.mp4", "t.ass", "out.mp4", info, rs, "grad.png");
const li = fc.indexOf("-filter_complex");
assert.ok(li > 0, "filter_complex present with rooms");
const filter = fc[li + 1];
assert.ok(fc.includes("grad.png"), "gradient PNG is a second input");
assert.ok(!fc.join(" ").includes("geq") && !fc.join(" ").includes("lavfi"), "no geq/lavfi gradient tricks");
assert.ok(filter.startsWith("[0:v][1:v]overlay=x=0:y=998:"), "gradient overlaid at bottom (1280-282)");
assert.ok(filter.includes("between(t\\,0.00\\,4.00)+between(t\\,4.00\\,7.25)"), "per-segment enable, escaped commas");
assert.ok(filter.includes("format=yuv420p,ass=t.ass"), "yuv420p then ass burn");
assert.ok(fc.includes("0:a?"), "audio mapped optionally");

// ── gradientPng: valid RGBA PNG with a vertical alpha ramp ──
const png = gradientPng(4, 10, [0xF7, 0xF3, 0xEC], 242);
assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], "PNG signature");
// IHDR chunk starts at byte 8: [len(4)][type(4)][w(4)][h(4)][bitdepth][colortype]...
assert.equal(png.readUInt32BE(16), 4, "IHDR width");
assert.equal(png.readUInt32BE(20), 10, "IHDR height");
assert.equal(png[24], 8, "bit depth 8");
assert.equal(png[25], 6, "colour type RGBA");
// Decode IDAT and check the alpha ramp: top row transparent, bottom row peak.
const idatStart = png.indexOf(Buffer.from("IDAT", "ascii")) + 4;
const idatLen = png.readUInt32BE(png.indexOf(Buffer.from("IDAT", "ascii")) - 4);
const raw = zlib.inflateSync(png.slice(idatStart, idatStart + idatLen));
const rowLen = 1 + 4 * 4;
assert.equal(raw.length, rowLen * 10, "raw scanlines size");
assert.equal(raw[0], 0, "row filter byte 0");
assert.equal(raw[1 + 3], 0, "top row alpha = 0 (transparent)");
assert.equal(raw[9 * rowLen + 1 + 3], 242, "bottom row alpha = peak");
assert.equal(raw[1], 0xF7, "cream R"); assert.equal(raw[2], 0xF3, "cream G"); assert.equal(raw[3], 0xEC, "cream B");

assert.equal(MAX_ROOMS, 12);
console.log("all overlay tests passed");
