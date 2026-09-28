# Walkthrough Order + End-Frame Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Walkthrough videos open on an exterior (drone fly-in) or lounge, close on a lounge/balcony, never open/close on bedrooms or wet rooms, and end with adaptive Heebo titles over a gold swoosh.

**Architecture:** Frame choice is a pure JS function (`scripts/n8n/walkthrough-order.js`, versioned + tested here, pasted into the n8n `Curate Photos` Code node). Pinning and the drone prompt are small edits to the `Plan Clips` / `Parse Prompt` Code nodes. End-frame styling lives in `server/overlay.js`: probe the last frame's luma, pick `light`/`dark`, render ASS with Heebo + a vector swoosh.

**Tech Stack:** Node 22, ffmpeg/libass, n8n Code nodes, plain `assert` tests (`node file.test.js`).

Spec: `docs/superpowers/specs/2026-09-27-walkthrough-order-endframe-design.md`

## Global Constraints

- Colours: brown `#3B2314`, cream `#F7F3EC`, gold `#C9A45C`. ASS colours are `&HAABBGGRR`: brown `&H0014233B`, cream `&H00ECF3F7`, gold `&H005CA4C9`.
- Luma threshold: `luma > 135` → `light`; else, or probe failure → `dark`.
- Opener types OUTDOOR = exterior, garden, roof, pool, view. LOUNGE = living_room, open_plan. BALCONY = balcony. BANNED_EDGE = bedroom, master_bedroom, kids_room, bathroom, toilet, hallway, anything containing `shower`.
- Max 12 photos. Ties by `quality_score` keep upload order. Never throw over ordering.
- Room labels never overlap the final `OVERLAY_SECONDS` (3s).
- Tests: `cd server && node overlay.test.js`; full suite `cd server && npm test`.
- Deviation from spec §4: fonts are committed as static `Heebo-ExtraBold.ttf` + `Heebo-SemiBold.ttf` (libass cannot reliably pick a named instance from a variable font).

---

### Task 1: Heebo fonts reach ffmpeg

**Files:**
- Create: `server/assets/fonts/Heebo-ExtraBold.ttf`, `server/assets/fonts/Heebo-SemiBold.ttf`, `server/assets/fonts/OFL.txt`
- Modify: `server/overlay.js` (constants near line 53; `buildFfmpegArgs` lines ~580 and ~614)
- Test: `server/overlay.test.js` (lines ~140, ~155)

**Interfaces:**
- Produces: `FONTS_DIR` constant; every `ass=` filter becomes `ass=${assFile}:fontsdir=${FONTS_DIR}`. Font family names `"Heebo ExtraBold"` and `"Heebo SemiBold"` (verify in Step 2).

- [ ] **Step 1: Download fonts + licence**

```bash
mkdir -p server/assets/fonts
curl -sL -o server/assets/fonts/Heebo-ExtraBold.ttf https://github.com/OdedEzer/heebo/raw/master/fonts/ttf/Heebo-ExtraBold.ttf
curl -sL -o server/assets/fonts/Heebo-SemiBold.ttf https://github.com/OdedEzer/heebo/raw/master/fonts/ttf/Heebo-SemiBold.ttf
curl -sL -o server/assets/fonts/OFL.txt https://github.com/google/fonts/raw/main/ofl/heebo/OFL.txt
```

- [ ] **Step 2: Verify family names libass will see**

Run: `fc-scan --format '%{family} | %{style}\n' server/assets/fonts/*.ttf`
Expected: one line per file whose family list contains `Heebo ExtraBold` / `Heebo SemiBold` (or `Heebo` with style ExtraBold/SemiBold). If only `Heebo` is listed, use family `Heebo` everywhere below and select weight with the ASS Bold field `800` / `600` instead of `-1`/`0`.

- [ ] **Step 3: Update tests to expect fontsdir**

In `server/overlay.test.js` replace the two `ass=t.ass` assertions:

```js
assert.ok(plain.includes("-vf") && /^ass=t\.ass:fontsdir=.+assets[\\/]fonts$/.test(plain[plain.indexOf("-vf") + 1]));
```
```js
assert.ok(/format=yuv420p,ass=t\.ass:fontsdir=.+assets[\\/]fonts\[v\]/.test(filter), "yuv420p then ass burn with fontsdir");
```

- [ ] **Step 4: Run to see it fail**

Run: `cd server && node overlay.test.js`
Expected: AssertionError on the fontsdir assertion.

- [ ] **Step 5: Implement**

In `server/overlay.js` after `const OVERLAY_SECONDS = 3;`:

```js
// Heebo (OFL) for the end titles; handed to libass via fontsdir so the image
// needs no extra apk font package.
const FONTS_DIR = path.join(__dirname, "assets", "fonts");
```

In `buildFfmpegArgs` change `` `ass=${assFile}` `` to `` `ass=${assFile}:fontsdir=${FONTS_DIR}` `` (single-clip branch) and `` `[${last}]format=yuv420p,ass=${assFile}[v]` `` to `` `[${last}]format=yuv420p,ass=${assFile}:fontsdir=${FONTS_DIR}[v]` ``.

- [ ] **Step 6: Run tests**

Run: `cd server && node overlay.test.js`
Expected: `all overlay tests passed`

- [ ] **Step 7: Commit**

```bash
git add server/assets/fonts server/overlay.js server/overlay.test.js
git commit -m "feat(overlay): ship Heebo and point libass at it via fontsdir"
```

---

### Task 2: End-frame brightness → style

**Files:**
- Modify: `server/overlay.js` (new functions after `sampleClipFrames`; `_test` export)
- Test: `server/overlay.test.js`

**Interfaces:**
- Produces: `endStyleFor(luma: number|null) → "light"|"dark"`; `async endFrameLuma(file: string) → number|null` (mean Y of the bottom third of the file's last frame; `null` on any failure).

- [ ] **Step 1: Failing test**

Append to `server/overlay.test.js` (and add `endStyleFor` to the `_test` destructure on line 8):

```js
// ── endStyleFor: last-frame brightness picks the title palette ──
assert.equal(endStyleFor(181), "light");
assert.equal(endStyleFor(136), "light");
assert.equal(endStyleFor(135), "dark");
assert.equal(endStyleFor(99), "dark");
assert.equal(endStyleFor(null), "dark", "probe failure → cream + shadow, reads on anything");
assert.equal(endStyleFor(NaN), "dark");
```

- [ ] **Step 2: Run to see it fail**

Run: `cd server && node overlay.test.js` → `TypeError: endStyleFor is not a function`

- [ ] **Step 3: Implement**

```js
// End-title palette from how bright the bottom third of the closing frame is:
// brown text on light floors/walls, cream + shadow on dark ones.
const END_LUMA_LIGHT = 135;
function endStyleFor(luma) {
  return Number.isFinite(luma) && luma > END_LUMA_LIGHT ? "light" : "dark";
}

// Mean luma (0-255) of the bottom third of a clip's last frame, or null.
async function endFrameLuma(file) {
  try {
    const out = await run(FFMPEG, [
      "-sseof", "-0.3", "-i", file, "-frames:v", "1",
      "-vf", "crop=iw:ih/3:0:ih*2/3,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
      "-f", "null", "-",
    ], 30000);
    const m = out.match(/YAVG=([\d.]+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
```

Add `endStyleFor, endFrameLuma` to `_test` in `module.exports`.

- [ ] **Step 4: Run tests** → `all overlay tests passed`

- [ ] **Step 5: Manual luma check against the staging replay video**

```bash
cd server && node -e 'require("./overlay")._test.endFrameLuma(process.argv[1]).then(console.log)' /private/tmp/claude-502/-Users-MichaelKrotorio-development-forly-forly-backend-worktrees/e9d3d785-dd19-4fa3-b62c-b13db74abd18/scratchpad/v.mp4
```
Expected: a number (not `null`).

- [ ] **Step 6: Commit**

```bash
git add server/overlay.js server/overlay.test.js
git commit -m "feat(overlay): pick light/dark end-title palette from last-frame luma"
```

---

### Task 3: buildAss renders the new end titles

**Files:**
- Modify: `server/overlay.js` `buildAss` (~line 240) + new `swooshPath`
- Test: `server/overlay.test.js` (buildAss section ~line 86)

**Interfaces:**
- Consumes: `endStyleFor` output strings.
- Produces: `buildAss(info, lines, roomSegments = [], endStyle = "dark")`; `swooshPath(w: number) → string` (ASS `\p1` drawing commands).

- [ ] **Step 1: Failing tests**

Append after the existing buildAss tests:

```js
// ── end titles: Heebo, no black box, palette per style, gold swoosh ──
const info = { width: 720, height: 1280, duration: 10 };
const styleLine = (a, name) => a.split("\n").find((l) => l.startsWith(`Style: ${name},`)).split(",");
for (const [style, colour] of [["light", "&H0014233B"], ["dark", "&H00ECF3F7"]]) {
  const a = buildAss(info, ["נחל קדרון 11 | שכונת הפארק", "דירת 110 מ״ר", "לפרטים 054-658-2548"], [], style);
  const t = styleLine(a, "Title"), s = styleLine(a, "Sub");
  assert.equal(t[1], "Heebo ExtraBold"); assert.equal(s[1], "Heebo SemiBold");
  assert.equal(t[3], colour, `${style} title colour`); assert.equal(s[3], colour, `${style} sub colour`);
  assert.notEqual(t[15], "3", "no opaque box behind the title"); assert.notEqual(s[15], "3");
  assert.ok(/,Swoosh,.*\\p1.*m 0 /.test(a), "swoosh drawn as a vector path");
  assert.ok(a.includes("\\1c&H5CA4C9&"), "swoosh is gold");
}
assert.ok(buildAss(info, ["x"], [], "dark").includes("\\blur"), "dark titles get a soft shadow");
assert.ok(!buildAss(info, ["x"], [], "light").includes("\\blur"), "light titles stay flat");
assert.equal(buildAss(info, ["x"]), buildAss(info, ["x"], [], "dark"), "default style is dark");
// swoosh path: tapered, spans exactly w
assert.ok(swooshPath(300).startsWith("m 0 ") && swooshPath(300).includes(" 300 "));
// no room label may overlap the title window (buildAss clamps, whatever the caller passes)
const late = buildAss(info, ["x"], [{ label: "סלון", start: 0, end: 9.5 }, { label: "מטבח", start: 8, end: 10 }], "dark");
const roomLines = late.split("\n").filter((l) => l.includes(",Room,"));
assert.equal(roomLines.length, 1, "a segment starting inside the title window is dropped");
assert.equal(roomLines[0].split(",")[2], "0:00:07.00", "room label clamped to the title window start");
```

Add `swooshPath` to the `_test` destructure on line 8. Update the older assertion `"Dialogue: 0,0:00:07.00,0:00:11.00,Title,"` — it still holds (timing unchanged).

- [ ] **Step 2: Run to see it fail**

Run: `cd server && node overlay.test.js` → fails on `Heebo ExtraBold`.

- [ ] **Step 3: Implement**

Add above `buildAss`:

```js
// Tapered brush stroke, w px wide, ~7px tall at the middle, as ASS drawing
// commands (\p1). Top edge bows up more than the bottom, so the ends taper.
function swooshPath(w) {
  const r = (n) => Math.round(n);
  return `m 0 4 b ${r(w * 0.3)} -3 ${r(w * 0.7)} -3 ${w} 4 b ${r(w * 0.7)} 2 ${r(w * 0.3)} 2 0 4`;
}
```

In `buildAss` change the signature to `function buildAss({ width, height, duration }, lines, roomSegments = [], endStyle = "dark")` and replace the `fonts` const, the Title/Sub style lines and the `events` mapping:

```js
  const fonts = "Noto Sans Hebrew"; // room labels keep Noto
  const light = endStyle === "light";
  const text = light ? "&H0014233B" : "&H00ECF3F7";
  // Dark frames: thin translucent outline + blur = soft shadow; light: flat.
  const outline = light ? 0 : Math.max(2, Math.round(titleSize * 0.06));
  const shadow = light ? 0 : 2;
  const titleStyle = `Style: Title,Heebo ExtraBold,${titleSize},${text},${text},&H90000000,&HA0000000,0,0,0,0,100,100,0,0,1,${outline},${shadow},2,40,40,${titleMarginV},1`;
  const subStyle = `Style: Sub,Heebo SemiBold,${subSize},${text},${text},&H90000000,&HA0000000,0,0,0,0,100,100,0,0,1,${outline},${shadow},2,40,40,${subMarginV},1`;
```

Use `titleStyle`/`subStyle` in place of the two old `Style: Title` / `Style: Sub` lines, and add after them:

```js
    "Style: Swoosh,Heebo SemiBold,10,&H005CA4C9,&H005CA4C9,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
```

Replace the `events` mapping with:

```js
  const blur = light ? "" : "\\blur6";
  const events = lines.slice(0, MAX_LINES).map((line, i) => {
    const style = i === 0 ? "Title" : "Sub";
    const marginOverride = i <= 1 ? 0 : Math.max(20, subMarginV - (i - 1) * Math.round(subSize * 1.5));
    return `Dialogue: 0,${start},${end},${style},,0,0,${marginOverride},,{\\fad(300,0)${blur}}${sanitizeAss(line)}`;
  });
  if (lines.length) {
    // Estimated title width (Heebo ExtraBold ≈ 0.52em per char), 85% of it, capped.
    const titleChars = sanitizeAss(lines[0]).length;
    const w = Math.round(Math.min(width * 0.8, titleChars * titleSize * 0.52 * 0.85));
    const x = Math.round((width - w) / 2);
    const y = height - titleMarginV + 6;
    events.push(`Dialogue: 0,${start},${end},Swoosh,,0,0,0,,{\\fad(300,0)\\an7\\pos(${x},${y})\\1c&H5CA4C9&\\p1}${swooshPath(w)}`);
  }
```

Replace the start of the `roomEvents` mapping so the title window can never carry a room name:

```js
  const cutoff = Math.max(0, duration - OVERLAY_SECONDS);
  const roomEvents = roomSegments
    .map((s) => ({ ...s, end: Math.min(s.end, cutoff) }))
    .filter((s) => s.end - s.start >= 0.5)
    .map((s) => {
```

(close the extra `.map(` with the existing body unchanged).

Delete the now-unused comment line about `BackColour 78000000` / gold `#B98A2F`.

- [ ] **Step 4: Run tests** → `all overlay tests passed`. If an older test asserts the Sub colour `&H002F8AB9` or `BorderStyle 3`, update it to the new values (those assertions describe the retired black-box look). The existing `"Dialogue: 0,0:00:04.00,0:00:07.25,Room,"` assertion now becomes `0:00:07.00` (that segment ran 0.25s into the title window — exactly the bug the clamp fixes).

- [ ] **Step 5: Commit**

```bash
git add server/overlay.js server/overlay.test.js
git commit -m "feat(overlay): Heebo end titles, adaptive palette, gold swoosh; drop black box"
```

---

### Task 4: Wire the palette into overlayVideo + staging check

**Files:**
- Modify: `server/overlay.js` `overlayVideo` (~line 650-716)

**Interfaces:**
- Consumes: `endFrameLuma`, `endStyleFor`, `buildAss(..., endStyle)`.
- Produces: response field `end_style: "light"|"dark"`.

- [ ] **Step 1: Implement**

Replace `fs.writeFileSync(assFile, buildAss(info, lines, roomSegments), "utf8");` with:

```js
    // The titles sit on the last clip's closing frame; read its brightness there.
    const endStyle = endStyleFor(await endFrameLuma(inFiles[inFiles.length - 1]));
    fs.writeFileSync(assFile, buildAss(info, lines, roomSegments, endStyle), "utf8");
```

Add `end_style: endStyle,` to the returned object after `room_debug`.

- [ ] **Step 2: Full suite**

Run: `cd server && npm test` (symlink `server/node_modules` → `../../../forly-backend/server/node_modules` if missing; remove it after).
Expected: every suite prints its pass line.

- [ ] **Step 3: Local render smoke test**

```bash
cd server && node -e '
const { overlayVideo } = require("./overlay");
overlayVideo({ videoUrls: ["https://cdn.seevio.ai/api/videos/2026-09-27/8d9f44dd-d417-4af8-8b3c-906eb198865b.mp4","https://cdn.seevio.ai/api/videos/2026-09-27/4854e49b-cca2-4b03-ac6b-1f808c842f11.mp4"],
  lines: ["נחל קדרון 11 | שכונת הפארק","דירת 110 מ״ר | קומה 5","לפרטים 054-658-2548"], uploadDir: "/tmp/ov", baseUrl: "file://" })
 .then(r => console.log(r.end_style, r.video_url));'
```
Then grab the last frame (`ffmpeg -sseof -0.5 -i /tmp/ov/overlays/<id>.mp4 -frames:v 1 end.png`) and look at it: Heebo glyphs (not Noto), no black box, gold swoosh under the title, digits render.

- [ ] **Step 4: Commit, push, deploy staging**

```bash
git add server/overlay.js
git commit -m "feat(overlay): choose end-title palette per video, report end_style"
git push origin HEAD
git push origin HEAD:staging
```
Wait for `curl -s 'https://api.github.com/repos/mickykro/forly-backend/actions/runs?branch=staging&per_page=1'` to show this SHA `completed/success`.

- [ ] **Step 5: Replay 145395 on staging**

```bash
curl -s -m 600 -X POST https://staging.srv1173890.hstgr.cloud/api/video-overlay -H 'Content-Type: application/json' --data @<scratchpad>/replay.json
```
Expected: `has_music: true`, `end_style` present, no `חדר רחצה` segment. Send the user the final frame.

---

### Task 5: Opener/closer ordering function

**Files:**
- Create: `scripts/n8n/walkthrough-order.js`, `scripts/n8n/walkthrough-order.test.js`

**Interfaces:**
- Produces: `orderPhotos(tags: Array<{url, room_type, quality_score}>, max = 12) → { curated: tag[], opener_group: "outdoor"|"lounge"|"other" }`. The file body (minus `module.exports`) is pasted verbatim into the n8n `Curate Photos` node in Task 6.

- [ ] **Step 1: Failing tests**

`scripts/n8n/walkthrough-order.test.js`:

```js
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
```

- [ ] **Step 2: Run to see it fail**

Run: `node scripts/n8n/walkthrough-order.test.js` → `Cannot find module './walkthrough-order'`

- [ ] **Step 3: Implement** `scripts/n8n/walkthrough-order.js`:

```js
// Walkthrough frame order for the n8n "WW1 Walkthrough V2" Curate Photos node.
// Pasted verbatim into that Code node (drop module.exports); keep it
// dependency-free. Spec: docs/superpowers/specs/2026-09-27-walkthrough-order-endframe-design.md
const OUTDOOR = ["exterior", "garden", "roof", "pool", "view"];
const LOUNGE = ["living_room", "open_plan"];
const BALCONY = ["balcony"];
const BANNED = ["bedroom", "master_bedroom", "kids_room", "bathroom", "toilet", "hallway"];

const typeOf = (t) => String(t.room_type || "").toLowerCase();
const banned = (t) => BANNED.includes(typeOf(t)) || typeOf(t).includes("shower");
// Highest quality_score among photos matching `ok`; ties keep upload order.
function best(photos, ok, skip) {
  let pick = null;
  for (const t of photos) {
    if (t === skip || !ok(t)) continue;
    if (!pick || (t.quality_score || 0) > (pick.quality_score || 0)) pick = t;
  }
  return pick;
}
const inGroup = (g) => (t) => g.includes(typeOf(t));

function orderPhotos(tags, max = 12) {
  const photos = tags.slice();
  const edgeOk = (t) => !banned(t);
  let opener = best(photos, inGroup(OUTDOOR));
  let group = opener ? "outdoor" : null;
  if (!opener) { opener = best(photos, inGroup(LOUNGE)); group = opener ? "lounge" : null; }
  if (!opener) { opener = best(photos, edgeOk); group = opener ? "other" : null; }
  if (!opener) return { curated: photos.slice(0, max), opener_group: "other" };

  const order = group === "lounge" ? [BALCONY, LOUNGE] : [LOUNGE, BALCONY];
  let closer = best(photos, inGroup(order[0]), opener) || best(photos, inGroup(order[1]), opener)
    || best(photos, edgeOk, opener);

  const middle = photos.filter((t) => t !== opener && t !== closer)
    .map((t, i) => [t, i])
    .sort((a, b) => (b[0].quality_score || 0) - (a[0].quality_score || 0) || a[1] - b[1])
    .map(([t]) => t)
    .slice(0, max - (closer ? 2 : 1));
  return { curated: [opener, ...middle, ...(closer ? [closer] : [])], opener_group: group };
}

module.exports = { orderPhotos };
```

- [ ] **Step 4: Run tests** → `walkthrough-order: all tests passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/n8n
git commit -m "feat(n8n): walkthrough opener/closer ordering function + tests"
```

---

### Task 6: Staging copy of the n8n workflow

**Files:** none in repo (n8n via MCP). Uses `get_workflow_details`, `get_sdk_reference`, `validate_workflow`, `create_workflow_from_code`, `execute_workflow` / `get_execution` on the n8n MCP.

**Interfaces:**
- Consumes: `orderPhotos` source from Task 5; staging `/api/video-overlay` from Task 4.
- Produces: workflow "WW1 Walkthrough V2 – staging" (new id) — identical to `YrEYXgCgjKg8vje9` except the four nodes below. Its WhatsApp "Send file" nodes go only to the operator group `120363410405308894@g.us` — never to a customer phone.

- [ ] **Step 1: `Curate Photos` node code**

```js
// <paste scripts/n8n/walkthrough-order.js here, without module.exports>
const MIN_PHOTOS = 4;
const tags = ($input.first().json.tags || []).filter(t => t.is_real_estate !== false && t.quality_score >= 4);
const { curated, opener_group } = orderPhotos(tags, 12);
if (curated.length < MIN_PHOTOS) {
  throw new Error("Need at least " + MIN_PHOTOS + " usable photos for a 2-clip walkthrough, got " + curated.length);
}
return [{ json: { curated, count: curated.length, opener_group } }];
```

- [ ] **Step 2: `Plan Clips` node edits**

At the top add `const openerGroup = $input.first().json.opener_group;`. Replace the `segmentRole` ternary so each part names its pinned frame:

```js
  const pin = clipIndex === 0
    ? "@image1 is FIXED as the opening shot - keep it first. Order the other images freely for the best flow."
    : `@image${n} is FIXED as the final shot - keep it last. Order the other images freely for the best flow.`;
  const segmentRole = (clipIndex === 0
    ? "This is PART 1 of a two-part walkthrough that will be stitched together. Open with a strong establishing shot and build momentum. Do NOT resolve or close the story - the tour continues in part 2."
    : "This is PART 2 of a two-part walkthrough that will be stitched together. Continue a tour already in progress and finish on a calm signature shot. Do NOT re-introduce the property from scratch.") + "\n" + pin;
  const opening = clipIndex === 0 && openerGroup === "outdoor"
    ? "Aerial drone shot: start high and wide above the building, descend and glide toward it, fly in through the entrance or a window, and dissolve into the next room."
    : "a slow establishing dolly-in";
```

and change the prompt's `1. OPENING SHOT` line to:

```
1. OPENING SHOT (${per}s): @image1 - ${opening}. Clean frame - no text, logos, or graphics.
```

Add `pinned_url: clipIndex === 0 ? images[0].url : images[n - 1].url,` to the returned json.

- [ ] **Step 3: `Parse Prompt` node edit**

After `const { images, repaired } = ...` add:

```js
  // The opener/closer were chosen upstream; Sonnet may not move them.
  let pinRepaired = false;
  const pinned = plan.pinned_url;
  const at = images.findIndex(x => x.url === pinned);
  const want = (plan.clip_index ?? i) === 0 ? 0 : images.length - 1;
  if (pinned && at !== -1 && at !== want) {
    const [m] = images.splice(at, 1);
    images.splice(want, 0, m);
    pinRepaired = true;
  }
```

and add `pin_repaired: pinRepaired,` to the returned json.

- [ ] **Step 4: Stitch node + delivery**

`Stitch And Overlay Titles` URL → `https://staging.srv1173890.hstgr.cloud/api/video-overlay`. In `Send file by url` set `chatId` to `=120363410405308894@g.us`. Disable `Build Landing Page` (staging must not create customer pages).

- [ ] **Step 5: Build, validate, create**

Fetch `get_sdk_reference`, write the workflow code from the live workflow's nodes with the edits above, `validate_workflow` until valid, then `create_workflow_from_code` named "WW1 Walkthrough V2 – staging". Record the new id in the plan.

- [ ] **Step 6: One real run (ask the user first — costs 2 Seedance clips)**

Execute with the 145395 trigger input (`phone`, `image_urls`, `listing_id`, `property_details` from `Execute Trigger` of execution 145395). Check via `get_execution`: `Curate Photos.opener_group`, first/last `room_type`, `pin_repaired`, stitch `has_music: true` and `end_style`. Send the user the video URL.

---

### Task 7: Promote (only after the user approves the staging video)

- [ ] **Step 1:** Apply the Task 6 Step 1-3 node edits to live `YrEYXgCgjKg8vje9` via `update_workflow` (stitch URL stays prod, delivery unchanged). `validate_workflow` first.
- [ ] **Step 2:** Merge `staging` → `main` (prod deploy via `deploy-server.yml`), confirm the run succeeded, and that prod now reports `has_music: true` (requires `FAL_KEY` in prod `deploy.env`).
- [ ] **Step 3:** Open the GitHub issue(s) for #1 and #2 once `gh` is authenticated, linking the commits.
