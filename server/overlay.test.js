/*
 * Unit tests for overlay.js pure helpers (no ffmpeg / no network).
 * Run: node server/overlay.test.js
 */
const assert = require("assert");
const zlib = require("zlib");
const { _test, MAX_ROOMS, MAX_CLIPS, XFADE_SECONDS } = require("./overlay");
const { buildAss, buildFfmpegArgs, labelsToSegments, roomLabel, modeOf, gradientPng,
        bandHeight, stitchTimeline, parseFps, pickAudioUrl, afterJoin, endStyleFor, swooshPath, wrapText, textWidth } = _test;
const { promoVideoUrl, needsConversion, conversionArgs } = require("./overlay");

// ── roomLabel mapping ──
assert.equal(roomLabel("living room"), "סלון");
assert.equal(roomLabel("Master-Bedroom"), "חדר שינה ראשי");
assert.equal(roomLabel({ room_type: "kitchen" }), "מטבח");
assert.equal(roomLabel("סלון"), "סלון");             // already Hebrew → pass-through
// compound/unseen types → keyword fallback (never raw English)
assert.equal(roomLabel("open_plan_apartment"), "חלל פתוח");
assert.equal(roomLabel("guest_bedroom"), "חדר שינה");
assert.equal(roomLabel("second_balcony"), "מרפסת");
assert.equal(roomLabel("weird_type"), "");           // unknown → dropped, not shown
assert.equal(roomLabel("utility_closet"), "");
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
// Edges sit ON the confirming samples, never midway between them: sample 7
// (t=3.75) is the last that showed room a, sample 8 (t=4.25) the first that
// showed b. The old midpoint (4.0) opened b's label a quarter-second before b
// was ever seen on screen.
assert.ok(Math.abs(segs[0].end - 3.75) < 1e-9, "closes on the last confirming sample");
assert.ok(Math.abs(segs[1].start - 4.25) < 1e-9, "opens on the first confirming sample");
// The invariant that matters: a label never opens before the previous room's
// last confirmed sighting — it can only ever trail the cut.
for (let i = 1; i < segs.length; i++) {
  assert.ok(segs[i].start > segs[i - 1].end, `segment ${i} opens after the previous closes`);
}
// And every edge is a real sample time, so it's always backed by a frame.
const sampleTimes = new Set(times);
assert.ok(sampleTimes.has(segs[1].start) && sampleTimes.has(segs[0].end));

// single-blip healing
segs = labelsToSegments(["a", "a", "b", "a", "a", null, null, null, null, null], times.slice(0, 10), 5);
assert.equal(segs.length, 1);
assert.equal(segs[0].label, "a");

// short runs dropped
segs = labelsToSegments(["a", "b", "c", "d", "e", "f"], times.slice(0, 6), 3);
assert.equal(segs.length, 0);

// bathrooms/toilets/showers/hallways are classified but never labelled
segs = labelsToSegments(["סלון", "סלון", "חדר רחצה", "חדר רחצה", "מסדרון", "מסדרון", "שירותים", "שירותים", "מקלחת", "מקלחת", "מטבח", "מטבח"],
  times.slice(0, 12), 6);
assert.deepEqual(segs.map((s) => s.label), ["סלון", "מטבח"]);
assert.ok(Math.abs(segs[0].end - times[1]) < 1e-9, "the bathroom run still closes the lounge label");

// ── afterJoin: a label may not open inside a crossfade ──
// Two 15s clips -> clip 1 starts at 14.5, crossfade runs 14.5..15.0. Frames in
// that window come from clip 1's source (fully its opening room) while the
// output is still mostly clip 0.
const twoClips = [{ offset: 0 }, { offset: 14.5 }];
assert.equal(afterJoin(14.6, twoClips), 15.0, "start inside the join is held to the join end");
assert.equal(afterJoin(14.5, twoClips), 15.0, "start exactly at the join is held");
assert.equal(afterJoin(15.0, twoClips), 15.0, "join end itself is already clear");
assert.equal(afterJoin(14.4, twoClips), 14.4, "before the join is untouched");
assert.equal(afterJoin(20.0, twoClips), 20.0, "well clear is untouched");
assert.equal(afterJoin(3.0, [{ offset: 0 }]), 3.0, "single clip has no joins");
// Three clips: 10 + 8 + 5 -> offsets 0, 9.5, 17
const threeClips = [{ offset: 0 }, { offset: 9.5 }, { offset: 17 }];
assert.equal(afterJoin(9.7, threeClips), 10.0, "held at the first join");
assert.equal(afterJoin(17.2, threeClips), 17.5, "held at the second join");
assert.equal(afterJoin(12.0, threeClips), 12.0, "between joins is untouched");

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
assert.ok(ass.includes("Dialogue: 0,0:00:04.00,0:00:07.00,Room,"), "second room event clamped to the title window");
// room name only — the descriptor is never rendered, even when vision returned one
assert.ok(ass.includes("{\\fad(150,150)}‏סלון\n"), "name only, no descriptor line");
assert.ok(!ass.includes("מרווח ומואר"), "descriptor dropped");
assert.ok(ass.includes("{\\fad(150,150)}‏מטבח\n"), "single-line room");
// end titles unchanged
assert.ok(ass.includes("Dialogue: 0,0:00:07.00,0:00:11.00,Title,"), "title event unchanged");

// no rooms → no room events
const ass2 = buildAss({ width: 720, height: 1280, duration: 10 }, ["שורה"]);
assert.ok(!ass2.includes(",Room,,"), "no room events without segments");

// ── end titles: Heebo, no black box, palette per style, gold swoosh ──
const endInfo = { width: 720, height: 1280, duration: 10 };
const styleLine = (a, name) => a.split("\n").find((l) => l.startsWith(`Style: ${name},`)).split(",");
for (const [style, colour] of [["light", "&H0014233B"], ["dark", "&H00ECF3F7"]]) {
  const a = buildAss(endInfo, ["נחל קדרון 11 | שכונת הפארק", "דירת 110 מ״ר", "לפרטים 054-658-2548"], [], style);
  const t = styleLine(a, "Title"), s = styleLine(a, "Sub");
  assert.equal(t[1], "Heebo ExtraBold"); assert.equal(s[1], "Heebo SemiBold");
  assert.equal(t[3], colour, `${style} title colour`); assert.equal(s[3], colour, `${style} sub colour`);
  assert.notEqual(t[15], "3", "no opaque box behind the title"); assert.notEqual(s[15], "3");
  assert.ok(/,Swoosh,.*\\p1.*m 0 /.test(a), "swoosh drawn as a vector path");
  assert.ok(a.includes("\\1c&H5CA4C9&"), "swoosh is gold");
}
assert.ok(buildAss(endInfo, ["x"], [], "dark").includes("\\blur"), "dark titles get a soft shadow");
assert.ok(!buildAss(endInfo, ["x"], [], "light").includes("\\blur"), "light titles stay flat");
assert.equal(buildAss(endInfo, ["x"]), buildAss(endInfo, ["x"], [], "dark"), "default style is dark");
assert.ok(swooshPath(300).startsWith("m 0 ") && swooshPath(300).includes(" 300 "));
// no room label may overlap the title window (buildAss clamps, whatever the caller passes)
const late = buildAss(endInfo, ["x"], [{ label: "סלון", start: 0, end: 9.5 }, { label: "מטבח", start: 8, end: 10 }], "dark");
const roomLines = late.split("\n").filter((l) => l.includes(",Room,"));
assert.equal(roomLines.length, 1, "a segment starting inside the title window is dropped");
assert.equal(roomLines[0].split(",")[2], "0:00:07.00", "room label clamped to the title window start");

// ── parseFps ──
assert.equal(parseFps("30/1"), 30);
assert.equal(parseFps("24000/1001"), 23.976);
assert.equal(parseFps("0/0"), 30, "degenerate rate falls back to 30");
assert.equal(parseFps(undefined), 30);

// ── stitchTimeline: each join costs XFADE_SECONDS of running time ──
assert.equal(XFADE_SECONDS, 0.5);
const one = stitchTimeline([15]);
assert.deepEqual(one.offsets, [0]);
assert.equal(one.duration, 15, "single clip is untouched");
const two = stitchTimeline([15, 15]);
assert.deepEqual(two.offsets, [0, 14.5]);
assert.equal(two.duration, 29.5, "2x15s with one 0.5s crossfade");
const uneven = stitchTimeline([15, 12]);
assert.deepEqual(uneven.offsets, [0, 14.5]);
assert.equal(uneven.duration, 26.5, "11 photos → 6+5 → 15s+12s");
const three = stitchTimeline([10, 8, 5]);
assert.deepEqual(three.offsets, [0, 9.5, 17]);
assert.equal(three.duration, 22, "23 - 2 joins");

// ── buildFfmpegArgs ──
const info = { width: 720, height: 1280, duration: 10, fps: 30 };
assert.equal(bandHeight(1280), 282, "band height = round(1280*0.22)");
// single clip, no rooms, no music → cheap -vf ass pass, audio copied
const plain = buildFfmpegArgs({
  inFiles: ["in.mp4"], assFile: "t.ass", outFile: "out.mp4", info,
  durations: [10], roomSegments: [], gradFile: null, musicFile: null,
});
assert.ok(plain.includes("-vf") && /^ass=t\.ass:fontsdir=.+assets[\\/]fonts$/.test(plain[plain.indexOf("-vf") + 1]));
assert.ok(!plain.includes("-filter_complex"), "no filter_complex without rooms");

// rooms → gradient PNG overlay + ass, enable windows, escaped commas
const fc = buildFfmpegArgs({
  inFiles: ["in.mp4"], assFile: "t.ass", outFile: "out.mp4", info,
  durations: [10], roomSegments: rs, gradFile: "grad.png", musicFile: null,
});
const li = fc.indexOf("-filter_complex");
assert.ok(li > 0, "filter_complex present with rooms");
const filter = fc[li + 1];
assert.ok(fc.includes("grad.png"), "gradient PNG is a second input");
assert.ok(!fc.join(" ").includes("geq") && !fc.join(" ").includes("lavfi"), "no geq/lavfi gradient tricks");
assert.ok(filter.includes("[vcat][1:v]overlay=x=0:y=998+282*("), "gradient rests at the bottom (1280-282), offset by a slide");
assert.ok(filter.includes(":eval=frame:"), "y re-evaluated every frame");
// slide: fully down (offset 1) at the segment start, up by +0.3s, down again by the end
assert.ok(filter.includes("between(t\\,0.00\\,4.00)*max(clip(1-(t-0.00)/0.3\\,0\\,1)\\,clip((t-4.00+0.3)/0.3\\,0\\,1))"), "per-segment slide in/out");
assert.ok(filter.includes("between(t\\,0.00\\,4.00)+between(t\\,4.00\\,7.25)"), "per-segment enable, escaped commas");
assert.ok(/format=yuv420p,ass=t\.ass:fontsdir=.+assets[\\/]fonts\[v\]/.test(filter), "yuv420p then ass burn with fontsdir");
assert.ok(fc.includes("0:a?"), "audio mapped optionally");

// ── two clips: xfade chain, offsets from stitchTimeline ──
const stitchInfo = { width: 720, height: 1280, duration: 29.5, fps: 30 };
const two2 = buildFfmpegArgs({
  inFiles: ["a.mp4", "b.mp4"], assFile: "t.ass", outFile: "out.mp4", info: stitchInfo,
  durations: [15, 15], roomSegments: [], gradFile: null, musicFile: null,
});
const twoFilter = two2[two2.indexOf("-filter_complex") + 1];
assert.equal(two2.filter((a) => a === "-i").length, 2, "one -i per clip");
assert.ok(twoFilter.includes("[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=30,format=yuv420p[v0]"), "clip 0 normalized");
// probe reports the displayed size: a 90°-rotated 1280x720 stream is portrait
{
  const { probeResult } = require("./overlay")._test;
  const base = { format: { duration: "5" } };
  assert.deepEqual([probeResult({ ...base, streams: [{ width: 1280, height: 720, side_data_list: [{ rotation: -90 }] }] })].map((p) => [p.width, p.height]), [[720, 1280]]);
  assert.deepEqual([probeResult({ ...base, streams: [{ width: 1280, height: 720, tags: { rotate: "270" } }] })].map((p) => [p.width, p.height]), [[720, 1280]]);
  assert.deepEqual([probeResult({ ...base, streams: [{ width: 720, height: 1280, side_data_list: [{ rotation: 180 }] }] })].map((p) => [p.width, p.height]), [[720, 1280]]);
}
assert.ok(twoFilter.includes("[1:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=30,format=yuv420p[v1]"), "clip 1 normalized");
assert.ok(twoFilter.includes("[v0][v1]xfade=transition=fade:duration=0.5:offset=14.500[vcat]"), "join at 14.5s");
assert.ok(!two2.includes("0:a?"), "no per-clip audio carried across a join");

// three clips chain through intermediate labels
const three3 = buildFfmpegArgs({
  inFiles: ["a.mp4", "b.mp4", "c.mp4"], assFile: "t.ass", outFile: "out.mp4",
  info: { width: 720, height: 1280, duration: 22, fps: 30 },
  durations: [10, 8, 5], roomSegments: [], gradFile: null, musicFile: null,
});
const threeFilter = three3[three3.indexOf("-filter_complex") + 1];
assert.ok(threeFilter.includes("[v0][v1]xfade=transition=fade:duration=0.5:offset=9.500[x1]"), "first join");
assert.ok(threeFilter.includes("[x1][v2]xfade=transition=fade:duration=0.5:offset=17.000[vcat]"), "second join");

// ── music bed: looped input, trimmed to the stitched length, faded out ──
const withMusic = buildFfmpegArgs({
  inFiles: ["a.mp4", "b.mp4"], assFile: "t.ass", outFile: "out.mp4", info: stitchInfo,
  durations: [15, 15], roomSegments: rs, gradFile: "grad.png", musicFile: "bed.m4a",
});
const musicFilter = withMusic[withMusic.indexOf("-filter_complex") + 1];
// inputs: 0,1 = clips, 2 = gradient, 3 = music
assert.ok(musicFilter.includes("[vcat][2:v]overlay="), "gradient is input 2 behind two clips");
assert.ok(musicFilter.includes("[3:a]atrim=0:29.500"), "music trimmed to stitched duration");
assert.ok(musicFilter.includes("afade=t=out:st=27.500:d=2[a]"), "2s fade out at the end");
const loopAt = withMusic.indexOf("-stream_loop");
assert.equal(withMusic[loopAt + 1], "-1", "music loops");
assert.equal(withMusic[loopAt + 3], "bed.m4a", "-stream_loop applies to the music input");
assert.ok(withMusic.includes("[a]"), "music mapped as the audio track");

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

// ── pickAudioUrl: fal wraps generated files under a per-model key ──
// The documented CassetteAI/music-generator output, verbatim from its API page.
assert.equal(pickAudioUrl({
  audio_file: {
    url: "https://v3.fal.media/files/panda/T-GP6cbpo1lgL8ll4oKGj_generated.wav",
    file_name: null, content_type: null, file_size: null,
  },
}), "https://v3.fal.media/files/panda/T-GP6cbpo1lgL8ll4oKGj_generated.wav");
assert.equal(pickAudioUrl({ audio: { url: "https://fal.media/x.wav" } }), "https://fal.media/x.wav");
assert.equal(pickAudioUrl({ audio_file: { url: "https://fal.media/y.wav" } }), "https://fal.media/y.wav");
assert.equal(pickAudioUrl({ audio_url: "https://fal.media/z.wav" }), "https://fal.media/z.wav");
assert.equal(pickAudioUrl({ output: { url: "https://fal.media/o.wav" } }), "https://fal.media/o.wav");
assert.equal(pickAudioUrl({ url: "https://fal.media/t.wav" }), "https://fal.media/t.wav");
// anything that is not a usable http url is rejected rather than passed to ffmpeg
assert.equal(pickAudioUrl({ audio: { url: "/tmp/local.wav" } }), null, "non-http url rejected");
assert.equal(pickAudioUrl({ detail: "validation error" }), null, "error body yields no url");
assert.equal(pickAudioUrl({}), null);
assert.equal(pickAudioUrl(null), null);
assert.equal(pickAudioUrl("nope"), null);

assert.equal(MAX_ROOMS, 12);
assert.equal(MAX_CLIPS, 6);
// ── endStyleFor: last-frame brightness picks the title palette ──
assert.equal(endStyleFor(181), "light");
assert.equal(endStyleFor(136), "light");
assert.equal(endStyleFor(135), "dark");
assert.equal(endStyleFor(99), "dark");
assert.equal(endStyleFor(null), "dark", "probe failure → cream + shadow, reads on anything");
assert.equal(endStyleFor(NaN), "dark");

// ── end titles never cut: wrap at words, shrink past 2 rows ──
{
  const W = 720, H = 1280;
  const long = "דירת יוקרה מודרנית | שיכון ותיקים, כפר סבא | 5 חדרים עם מרפסת שמש ענקית";
  const rows = wrapText(long, 58, W * 0.86);
  assert.ok(rows.length >= 2, "long title wraps");
  const words = (x) => x.replace(/\|/g, " ").split(/\s+/).filter(Boolean);
  assert.deepEqual(words(rows.join(" ")), words(long), "every word kept, in order");
  assert.ok(rows.some((r) => r.includes("שיכון ותיקים")), "breaks at | before splitting a segment");
  assert.ok(rows.every((r) => !/^\s*\||\|\s*$/.test(r)), "no dangling separator at a break");
  for (const r of rows) assert.ok(textWidth(r, 58) <= W * 0.86, "each row fits the frame");
  assert.deepEqual(wrapText("קצר", 58, W * 0.86), ["קצר"]);
  // a line too long for 2 rows shrinks instead of being cut
  const huge = Array(5).fill("מילה ארוכה מאוד").join(" ");
  const a = buildAss({ width: W, height: H, duration: 10 }, [huge, "דירת 110 מ״ר | קומה 5 | 4 חדרים | מרפסת | חניה | מחסן | מעלית"], [], "dark");
  const titleRows = a.split("\n").filter((l) => l.includes(",Title,"));
  assert.ok(titleRows.length <= 2 && titleRows.length >= 1);
  const shown = titleRows.map((l) => l.replace(/^.*\}‏?/, "")).join(" ");
  assert.equal(shown, huge, "no word of the title is dropped");
  assert.ok(/\\fs\d+/.test(titleRows[0]), "shrunk via \\fs override");
  assert.ok(!a.includes("WrapStyle: 2") || titleRows.every((l) => l.includes("\\pos(")), "rows are placed explicitly");
  // rows never overlap: every event's y is distinct and title rows sit above sub rows
  const ys = a.split("\n").filter((l) => /,(Title|Sub),/.test(l)).map((l) => Number(/\\pos\(\d+,(\d+)\)/.exec(l)[1]));
  assert.equal(new Set(ys).size, ys.length, "one row per y");
  assert.ok(Math.max(...ys.slice(0, titleRows.length)) < Math.min(...ys.slice(titleRows.length)), "title above details");
  // absurd length: min font, more rows, still every word
  const absurd = Array(12).fill("מילה ארוכה מאוד").join(" ");
  const c = buildAss({ width: W, height: H, duration: 10 }, [absurd], [], "dark");
  assert.equal(c.split("\n").filter((l) => l.includes(",Title,")).map((l) => l.replace(/^.*\}‏?/, "")).join(" "), absurd);
  // lines longer than the old 60-char cap survive intact
  const b = buildAss({ width: W, height: H, duration: 10 }, ["x".repeat(5), "א ".repeat(45).trim()], [], "light");
  assert.equal(b.split("\n").filter((l) => l.includes(",Sub,")).map((l) => l.replace(/^.*\}‏?/, "")).join(" "), "א ".repeat(45).trim());
}

// ── dual output: clean (music only) + titled (titles, labels, logo) ──
{
  const base = { inFiles: ["a.mp4", "b.mp4"], assFile: "t.ass", outFile: "out.mp4", info: { width: 720, height: 1280, fps: 24, duration: 19.5 },
    durations: [10, 10], roomSegments: [], gradFile: null, musicFile: "m.m4a" };
  const dual = buildFfmpegArgs({ ...base, cleanFile: "clean.mp4", logoFile: "logo.png" });
  const fc = dual[dual.indexOf("-filter_complex") + 1];
  assert.ok(fc.includes("split=2[vmain][vclean]"), "stitched video split once for both outputs");
  assert.ok(fc.includes("asplit=2[a][aclean]"), "music shared by both outputs");
  assert.equal(dual.filter((x) => x === "out.mp4" || x === "clean.mp4").length, 2, "two output files");
  assert.ok(dual.indexOf("out.mp4") < dual.indexOf("clean.mp4"));
  const cleanArgs = dual.slice(dual.indexOf("out.mp4") + 1);
  assert.deepEqual(cleanArgs.filter((x) => x.startsWith("[")), ["[vclean]", "[aclean]"], "clean output maps the untouched video + music");
  // logo: looped still, scaled to 16% width, ~80% opacity, top-left inset, titled output only
  const li = dual.indexOf("logo.png");
  assert.deepEqual(dual.slice(li - 5, li), ["-loop", "1", "-t", "19.500", "-i"], "logo looped for the video length");
  assert.ok(/\[2:v\]scale=115:-1,format=rgba,colorchannelmixer=aa=0\.8,fade=in:st=0:d=0\.5:alpha=1\[lg\]/.test(fc), "logo scaled + blended");
  assert.ok(fc.includes("overlay=x=29:y=29[lgo]"), "top-left, 4% inset");
  assert.ok(/\[lgo\]format=yuv420p,ass=/.test(fc), "titles drawn over the logo layer");
  assert.ok(!/\[vclean\][^;]*(ass=|overlay)/.test(fc), "clean output gets no titles or logo");
  // music input index accounts for the logo input
  assert.ok(fc.includes("[3:a]atrim"), "music is input 3 (2 clips + logo)");
  // unchanged single-output call keeps working
  const single = buildFfmpegArgs(base);
  assert.ok(!single.includes("clean.mp4") && !single.join(" ").includes("split=2"));
}

// ── promoVideoUrl: a clean overlay URL points at its titled sibling ──
assert.equal(promoVideoUrl("https://x/files/overlays/ab-1.clean.mp4"), "https://x/files/overlays/ab-1.mp4");
assert.equal(promoVideoUrl("https://x/files/overlays/ab-1.mp4"), null, "titled URL has no promo sibling");
assert.equal(promoVideoUrl("https://cdn/other.clean.mp4"), null, "only our overlays folder");
assert.equal(promoVideoUrl(null), null);

// ── uploaded page videos: convert anything browsers may not play ──
assert.equal(needsConversion({ codec_name: "h264", pix_fmt: "yuv420p" }), false, "plain H.264 plays everywhere");
assert.equal(needsConversion({ codec_name: "hevc", pix_fmt: "yuv420p10le" }), true, "iPhone HEVC");
assert.equal(needsConversion({ codec_name: "h264", pix_fmt: "yuv422p" }), true, "odd pixel format");
assert.equal(needsConversion({ codec_name: "h264", pix_fmt: "yuv420p", width: 3840, height: 2160 }), true, "4K is shrunk");
assert.equal(needsConversion(null), true, "unprobeable → convert");
{
  const a = conversionArgs("in.mov", "out.mp4");
  const j = a.join(" ");
  assert.ok(j.includes("-c:v libx264") && j.includes("-pix_fmt yuv420p") && j.includes("-c:a aac"));
  assert.ok(j.includes("-movflags +faststart"), "streams before fully downloaded");
  assert.ok(a.includes("0:a:0?"), "audio optional");
  assert.ok(/scale=.*1920/.test(j), "long side capped at 1920");
  assert.equal(a.at(-1), "out.mp4");
}

console.log("all overlay tests passed");
