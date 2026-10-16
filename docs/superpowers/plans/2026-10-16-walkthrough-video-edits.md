# Walkthrough Video Edits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep each walkthrough's clips and music bed after the first stitch, so an agent can edit the video over WhatsApp: regenerate one clip (2 free per video), change the end titles, or get a new music bed. Stop paying for clip audio that the stitch throws away.

**Architecture:** `overlayVideo` already downloads every clip before it stitches. With `keep`, it copies the clips and the music bed to `uploads/clips/<id>/`, and the listing stores a `video` record: the clip files, the planned prompt/refs/rooms per clip, titles, logo, phone and regeneration count. Edits enter through the WhatsApp "update a page" flow that already exists (`page-update.js`). Title and music edits re-render on the server. A clip regeneration asks a new n8n workflow to run Seedance for that one clip; n8n reports back to `POST /api/walkthrough/clip`, and the server swaps the clip, re-renders, updates the property page and sends the new video. Clip folders older than 30 days are deleted by a daily sweep.

**Tech Stack:** Node 20 + Express (server/), ffmpeg/ffprobe + libass, Firestore via `server/db.js` (in-memory fallback), n8n (Seedance via api.seevio.ai), Green API WhatsApp sends via `server/utils.js`.

## Global Constraints

- Tests are plain `node <file>.test.js` scripts using `assert`. Each new test file is appended to the `"test"` script in `server/package.json`. Run everything with `cd server && npm test`.
- No new npm dependencies.
- Every endpoint n8n calls is protected by the `x-forly-secret` header (`requireN8n`, the pattern already in `routes/walkthrough.js`).
- New files stay under 500 lines. `server/overlay.js` is already 976 lines: only extract and export from it, don't add features to it.
- Agent-facing WhatsApp text is Hebrew and written in the bot's feminine first person ("יוצרת", "מעדכנת").
- `FREE_REGENS = 2` clip regenerations per video. `CLIP_TTL_DAYS = 30`.
- Music is generated once for the whole stitched video. Clips carry no audio (`generate_audio: false`). A "new music" edit generates one new bed for the full length. Title-only and clip edits reuse the stored bed (ffmpeg's `-stream_loop -1` covers a longer video).
- Only a listing-backed video (the overlay call carries `listing_id`) keeps clips. Without `listing_id`, behaviour is unchanged.
- Commits follow CLAUDE.md: no `Co-Authored-By` trailer (`.claude/settings.json` has no `attribution.commit`).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `server/walkthrough-plan.js` | modify | each planned clip also lists its room types (`rooms`) |
| `server/routes/walkthrough.js` | modify | `/plan` stores `walkthrough_clips` on the listing; new `POST /clip` callback |
| `server/overlay.js` | modify | split `renderStitched` out of `overlayVideo`; `keep` option copies the sources; export helpers |
| `server/video-edit.js` | **create** | video record, clip picking, re-render, clip swap, page publish, regen request, sweep, clip sheet |
| `server/video-edit-intent.js` | **create** | one LLM call: what video edit does this WhatsApp message ask for |
| `server/utils.js` | modify | `sendWhatsAppFile` (Green API `sendFileByUrl`) |
| `server/routes/pages.js` | modify | `/api/video-overlay` accepts `listing_id`, keeps clips, saves the record |
| `server/page-update.js` | modify | video-edit branch of the WhatsApp page update + the follow-up turn |
| `server/whatsapp-replies.js` | modify | the Hebrew replies |
| `server/routes/whatsapp.js` | modify | deps for the video-edit flow |
| `server/index.js` | modify | build the shared video-edit context, wire routers, daily sweep |
| `server/video-edit.test.js`, `server/video-edit-intent.test.js` | **create** | tests |
| n8n `WW1 Walkthrough V3` (prod `HScWoZXiVjXoRQLt`, dev `KGO7oyf63EBD47pb`) | modify | `generate_audio: false`; overlay body gains `listing_id` |
| n8n `Forly Clip Regen` (+ dev) | **create** | one Seedance clip → `POST /api/walkthrough/clip` |

---

### Task 1: Planned clips carry their rooms; `/plan` stores them on the listing

**Files:**
- Modify: `server/walkthrough-plan.js` (`buildClip` return, ~line 212)
- Modify: `server/routes/walkthrough.js` (`/plan` handler, the `db.updateListing` call ~line 133)
- Test: `server/walkthrough-plan.test.js`

**Interfaces:**
- Produces: each `plan.clips[i]` gains `rooms: string[]` (space types such as `"kitchen"`, in shot order). The listing gains `walkthrough_clips: plan.clips` (array of `{ clip_index, duration, packed, spaces, rooms, image_urls, prompt }`).

- [ ] **Step 1: Write the failing test** — append to `server/walkthrough-plan.test.js`:

```js
// ── clips name their rooms (video edits pick a clip by room) ──
{
  const { buildClip } = require("./walkthrough-plan");
  const space = (id, type) => ({ id, type, photos: [{ n: 1, url: `https://x/${id}.jpg`, shows: [], quality: 8 }] });
  const solo = buildClip([space("S1", "kitchen")], 0, null);
  assert.deepStrictEqual(solo.rooms, ["kitchen"]);
  const packed = buildClip([space("S2", "bedroom"), space("S3", "bathroom")], 1, null);
  assert.deepStrictEqual(packed.rooms, ["bedroom", "bathroom"]);
  console.log("ok clip rooms");
}
```

- [ ] **Step 2: Run it and check that it fails**

Run: `cd server && node walkthrough-plan.test.js`
Expected: FAIL, `AssertionError` (`undefined` vs `['kitchen']`).

- [ ] **Step 3: Implement.** In `buildClip`'s return object in `server/walkthrough-plan.js`, add `rooms` after `spaces`:

```js
    spaces: group.map((s) => s.id),
    rooms: group.map((s) => s.type),
```

In `server/routes/walkthrough.js`, in `/plan`, change the listing update so the plan is saved with the space map:

```js
          await db.updateListing(listingId, { space_map: { ...map, debug, planned_at: new Date() }, walkthrough_clips: plan.clips });
```

- [ ] **Step 4: Run it and check that it passes**

Run: `cd server && node walkthrough-plan.test.js`
Expected: ends with `ok clip rooms`, no assertion errors.

- [ ] **Step 5: Commit**

```bash
git add server/walkthrough-plan.js server/routes/walkthrough.js server/walkthrough-plan.test.js
git commit -m "feat(walkthrough): planned clips name their rooms and are kept on the listing"
```

---

### Task 2: `overlay.js` — split `renderStitched` out and keep the sources

**Files:**
- Modify: `server/overlay.js` (`overlayVideo` ~lines 890–960, `module.exports` ~line 966)
- Test: `server/overlay.test.js`

**Interfaces:**
- Produces (new exports from `./overlay`):
  - `renderStitched({ tmp, inFiles, probes?, lines, musicFile, logoFile, uploadDir, baseUrl }) → Promise<{ id, video_url, clean_video_url, duration, clip_durations, end_style }>`. `inFiles` are local paths; it writes `overlays/<id>.mp4` and `overlays/<id>.clean.mp4` under `uploadDir`.
  - `keepSources(uploadDir, id, inFiles, musicFile) → { dir: "clips/<id>", clips: ["clips/<id>/clip0.mp4", …], music: "clips/<id>/music<ext>" | null }` (paths relative to `uploadDir`).
  - `overlayVideo({ …existing, keep = false })`: its result additionally has `kept` (the `keepSources` result) when `keep` is true.
  - Also exported: `resolveMusic`, `download`, `stitchTimeline`, `run`, `FONTS_DIR`.

- [ ] **Step 1: Write the failing test** — append to `server/overlay.test.js`:

```js
// ── keepSources: clips and music copied under uploads/clips/<id>/ ──
{
  const fs = require("fs"), os = require("os"), path = require("path");
  const { keepSources } = require("./overlay");
  const up = fs.mkdtempSync(path.join(os.tmpdir(), "keep-up-"));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "keep-src-"));
  const a = path.join(src, "in0.mp4"), b = path.join(src, "in1.mp4"), m = path.join(src, "bed.audio");
  fs.writeFileSync(a, "A"); fs.writeFileSync(b, "B"); fs.writeFileSync(m, "M");
  const kept = keepSources(up, "abc", [a, b], m);
  assert.deepStrictEqual(kept, { dir: "clips/abc", clips: ["clips/abc/clip0.mp4", "clips/abc/clip1.mp4"], music: "clips/abc/music.audio" });
  assert.equal(fs.readFileSync(path.join(up, "clips/abc/clip1.mp4"), "utf8"), "B");
  assert.equal(keepSources(up, "nomusic", [a], null).music, null);
  console.log("ok keepSources");
}
```

- [ ] **Step 2: Run it and check that it fails**

Run: `cd server && node overlay.test.js`
Expected: FAIL, `TypeError: keepSources is not a function`.

- [ ] **Step 3: Implement.** In `server/overlay.js`, add above `overlayVideo`:

```js
// One encode from local clip files to the two public renders (titled + clean).
// Shared by the first stitch (overlayVideo) and WhatsApp edits (video-edit.js).
async function renderStitched({ tmp, inFiles, probes = null, lines, musicFile, logoFile, uploadDir, baseUrl }) {
  if (!probes) { probes = []; for (const f of inFiles) probes.push(await probe(f)); }
  const durations = probes.map((p) => p.duration);
  const { duration } = stitchTimeline(durations);
  // Geometry comes from the first clip; the rest are scaled (aspect kept) and cropped to match it.
  const info = { width: probes[0].width, height: probes[0].height, fps: probes[0].fps, duration };
  const assFile = path.join(tmp, "titles.ass");
  const outFile = path.join(tmp, "out.mp4");
  const cleanFile = path.join(tmp, "clean.mp4");
  // Room-name labels are disabled: they appeared before their room was on screen.
  const roomSegments = [];
  // The titles sit on the last clip's closing frame; read its brightness there.
  const endStyle = endStyleFor(await endFrameLuma(inFiles[inFiles.length - 1]));
  fs.writeFileSync(assFile, buildAss(info, lines, roomSegments, endStyle), "utf8");
  const args = buildFfmpegArgs({ inFiles, assFile, outFile, info, durations, roomSegments, gradFile: null, musicFile, cleanFile, logoFile });
  await run(FFMPEG, args, 240000);
  const id = crypto.randomUUID();
  const rel = `overlays/${id}.mp4`;
  const relClean = `overlays/${id}.clean.mp4`;
  fs.mkdirSync(path.join(uploadDir, "overlays"), { recursive: true });
  fs.copyFileSync(outFile, path.join(uploadDir, rel));
  fs.copyFileSync(cleanFile, path.join(uploadDir, relClean));
  return { id, video_url: `${baseUrl}/files/${rel}`, clean_video_url: `${baseUrl}/files/${relClean}`,
    duration, clip_durations: durations, end_style: endStyle };
}

// The sources of a render, kept for WhatsApp edits (video-edit.js): the clips
// and the music bed under uploads/clips/<id>/. Paths returned are relative to
// uploadDir. Served under /files like the renders: the UUID is the only guard.
function keepSources(uploadDir, id, inFiles, musicFile) {
  const dir = `clips/${id}`;
  fs.mkdirSync(path.join(uploadDir, dir), { recursive: true });
  const clips = inFiles.map((f, i) => {
    const rel = `${dir}/clip${i}.mp4`;
    fs.copyFileSync(f, path.join(uploadDir, rel));
    return rel;
  });
  let music = null;
  if (musicFile) {
    music = `${dir}/music${path.extname(musicFile) || ".audio"}`;
    fs.copyFileSync(musicFile, path.join(uploadDir, music));
  }
  return { dir, clips, music };
}
```

Replace `overlayVideo` with the version below. It keeps the validation, downloads, music and logo handling exactly as they are now; the encode moves to `renderStitched`.

```js
async function overlayVideo({ videoUrl, videoUrls, lines, musicUrl, musicPrompt, logoUrl, uploadDir, baseUrl, keep = false }) {
  const urls = (Array.isArray(videoUrls) && videoUrls.length ? videoUrls : [videoUrl])
    .filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
  if (!urls.length) throw new Error("no video url given");
  if (urls.length > MAX_CLIPS) throw new Error(`at most ${MAX_CLIPS} clips can be stitched`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-"));
  try {
    const inFiles = [];
    const probes = [];
    for (let i = 0; i < urls.length; i++) {
      const f = path.join(tmp, `in${i}.mp4`);
      await download(urls[i], f);
      inFiles.push(f);
      probes.push(await probe(f));
    }
    const { duration } = stitchTimeline(probes.map((p) => p.duration));
    const music = await resolveMusic({ duration, musicUrl, musicPrompt, tmp });
    // The agent's logo is best-effort, like music: a bad URL ships the video without it.
    let logoFile = null;
    let logoDebug = "no_logo";
    if (logoUrl) {
      try {
        const ext = (/\.(png|jpe?g|webp)(\?|$)/i.exec(logoUrl) || [, "png"])[1].toLowerCase();
        logoFile = path.join(tmp, `logo.${ext}`);
        await download(logoUrl, logoFile);
        logoDebug = "ok";
      } catch (err) {
        logoFile = null;
        logoDebug = "error: " + err.message.slice(0, 200);
        console.warn("video-overlay: logo download failed, continuing without:", err.message);
      }
    }
    const r = await renderStitched({ tmp, inFiles, probes, lines, musicFile: music.file, logoFile, uploadDir, baseUrl });
    const out = {
      video_url: r.video_url,
      clean_video_url: r.clean_video_url,
      duration: r.duration,
      clip_count: inFiles.length,
      clip_durations: r.clip_durations,
      has_music: Boolean(music.file),
      music_debug: music.debug,
      room_segments: [],
      room_debug: "disabled",
      end_style: r.end_style,
      logo_debug: logoDebug,
    };
    if (keep) out.kept = keepSources(uploadDir, r.id, inFiles, music.file);
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
```

Extend `module.exports` (keep the existing names):

```js
module.exports = {
  overlayVideo, renderStitched, keepSources, resolveMusic, download, stitchTimeline, run, FONTS_DIR,
  promoVideoUrl, needsConversion, conversionArgs, ensurePlayableVideo, MAX_LINES, MAX_LINE_CHARS, MAX_ROOMS, MAX_CLIPS, XFADE_SECONDS,
  _test: { /* unchanged */ },
};
```

Keep the existing `_test` object as it is. `gradientPng`/`bandHeight` stay exported for their tests even though no render uses them now.

- [ ] **Step 4: Run the overlay tests and an end-to-end render**

Run: `cd server && node overlay.test.js`
Expected: ends with `ok keepSources`, no failures.

Run a real two-clip stitch locally (ffmpeg is on PATH):

```bash
cd server && D=$(mktemp -d) && for i in 0 1; do ffmpeg -loglevel error -f lavfi -i testsrc=size=360x640:rate=24:duration=4 -pix_fmt yuv420p $D/c$i.mp4; done && node -e '
const o=require("./overlay"),fs=require("fs"),path=require("path");
(async()=>{const tmp=fs.mkdtempSync("/tmp/r-");const r=await o.renderStitched({tmp,inFiles:[process.argv[1]+"/c0.mp4",process.argv[1]+"/c1.mp4"],lines:["כותרת"],musicFile:null,logoFile:null,uploadDir:process.argv[1],baseUrl:"http://x"});
console.log(r.duration.toFixed(1), fs.existsSync(path.join(process.argv[1],"overlays",r.id+".clean.mp4")));})()' $D
```
Expected: `7.5 true`

- [ ] **Step 5: Commit**

```bash
git add server/overlay.js server/overlay.test.js
git commit -m "refactor(overlay): renderStitched from local files; keep clips and music on request"
```

---

### Task 3: `video-edit.js` — the record and clip picking (pure)

**Files:**
- Create: `server/video-edit.js`
- Create: `server/video-edit.test.js`
- Modify: `server/package.json` (`"test"` script: append `&& node video-edit.test.js`)

**Interfaces:**
- Consumes: `stitchTimeline`, `XFADE_SECONDS` from `./overlay`; `roomLabel` from `./rooms`.
- Produces:
  - `FREE_REGENS = 2`, `CLIP_TTL_DAYS = 30`
  - `newRecord({ result, plan, lines, logoUrl, phone, now }) → VideoRecord`. `result` is an `overlayVideo` result with `kept`.
  - `VideoRecord = { id, dir, clips: [{ file, duration, rooms, prompt, image_urls, planned_duration }], music, lines, logo_url, phone, regens_used, regen_pending, video_url, clean_video_url, created_at }`
  - `pickClip(rec, { index?, seconds?, room? }) → number | null` (0-based; `index` is 1-based)
  - `pickFromAnswer(rec, text) → number | null`
  - `clipLabel(rec, i) → string` (Hebrew room names joined with " + ")
  - `clipMenu(rec) → string` (`"1. סלון (0:00–0:08)\n2. …"`)
  - `sweepClips(uploadDir, now = Date.now()) → number` (folders removed)

- [ ] **Step 1: Write the failing test** — create `server/video-edit.test.js`:

```js
/*
 * video-edit.js tests. Pure helpers first; the ffmpeg render test runs only
 * where ffmpeg is on PATH. Run: node server/video-edit.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const VE = require("./video-edit");

const rec = (over = {}) => ({
  id: "v1", dir: "clips/v1", music: null, lines: ["כותרת"], logo_url: null, phone: "972500000000",
  regens_used: 0, regen_pending: null, video_url: "u", clean_video_url: "c",
  clips: [
    { file: "clips/v1/clip0.mp4", duration: 8, rooms: ["living_room"], prompt: "p0", image_urls: ["https://i/0.jpg"], planned_duration: 8 },
    { file: "clips/v1/clip1.mp4", duration: 6, rooms: ["kitchen"], prompt: "p1", image_urls: ["https://i/1.jpg"], planned_duration: 6 },
    { file: "clips/v1/clip2.mp4", duration: 5, rooms: ["bedroom", "master_bedroom"], prompt: "p2", image_urls: ["https://i/2.jpg"], planned_duration: 5 },
  ],
  ...over,
});

// ── newRecord ──
{
  const result = { video_url: "V", clean_video_url: "C", clip_durations: [8.04, 6.0],
    kept: { dir: "clips/abc", clips: ["clips/abc/clip0.mp4", "clips/abc/clip1.mp4"], music: "clips/abc/music.audio" } };
  const plan = [{ rooms: ["kitchen"], prompt: "P", image_urls: ["https://i/a.jpg"], duration: 8 }, { rooms: [], prompt: "Q", image_urls: [], duration: 6 }];
  const r = VE.newRecord({ result, plan, lines: ["a"], logoUrl: null, phone: "972", now: new Date(0) });
  assert.equal(r.id, "abc");
  assert.equal(r.clips[0].prompt, "P");
  assert.equal(r.clips[0].planned_duration, 8);
  assert.equal(r.clips[1].duration, 6.0);
  assert.equal(r.music, "clips/abc/music.audio");
  assert.equal(r.regens_used, 0);
  // no plan (count mismatch upstream): clips kept, but nothing to regenerate from
  const bare = VE.newRecord({ result, plan: [], lines: ["a"], phone: null, now: new Date(0) });
  assert.deepStrictEqual(bare.clips[1], { file: "clips/abc/clip1.mp4", duration: 6.0, rooms: [], prompt: "", image_urls: [], planned_duration: null });
}

// ── pickClip ──
{
  const r = rec();
  assert.equal(VE.pickClip(r, { index: 2 }), 1);
  assert.equal(VE.pickClip(r, { index: 4 }), null);
  assert.equal(VE.pickClip(r, { index: 0 }), null);
  // offsets: 0, 7.5, 13 (0.5s crossfades); total 18
  assert.equal(VE.pickClip(r, { seconds: 0 }), 0);
  assert.equal(VE.pickClip(r, { seconds: 7.4 }), 0);
  assert.equal(VE.pickClip(r, { seconds: 7.5 }), 1);
  assert.equal(VE.pickClip(r, { seconds: 17 }), 2);
  assert.equal(VE.pickClip(r, { seconds: 30 }), null);
  assert.equal(VE.pickClip(r, { room: "kitchen" }), 1);
  assert.equal(VE.pickClip(r, { room: "מטבח" }), 1);
  assert.equal(VE.pickClip(r, { room: "חדר שינה ראשי" }), 2);
  assert.equal(VE.pickClip(r, { room: "bathroom" }), null);
  assert.equal(VE.pickClip(r, { index: null, seconds: null, room: null }), null);
  // two clips with the same room: ambiguous → null (the agent is asked)
  const twin = rec({ clips: [rec().clips[1], { ...rec().clips[1], file: "x" }] });
  assert.equal(VE.pickClip(twin, { room: "kitchen" }), null);
}

// ── pickFromAnswer ──
{
  const r = rec();
  assert.equal(VE.pickFromAnswer(r, "2"), 1);
  assert.equal(VE.pickFromAnswer(r, " 3 "), 2);
  assert.equal(VE.pickFromAnswer(r, "בדקה 0:14"), 2);
  assert.equal(VE.pickFromAnswer(r, "המטבח"), 1);
  assert.equal(VE.pickFromAnswer(r, "הסלון בבקשה"), 0);
  assert.equal(VE.pickFromAnswer(r, "משהו אחר"), null);
}

// ── clipMenu / clipLabel ──
{
  const r = rec();
  assert.equal(VE.clipLabel(r, 1), "מטבח");
  assert.equal(VE.clipMenu(r), "1. סלון (0:00–0:08)\n2. מטבח (0:07–0:13)\n3. חדר שינה + חדר שינה ראשי (0:13–0:18)");
}

// ── sweepClips ──
{
  const up = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
  fs.mkdirSync(path.join(up, "clips", "old"), { recursive: true });
  fs.mkdirSync(path.join(up, "clips", "new"), { recursive: true });
  const old = Date.now() / 1000 - 31 * 86400;
  fs.utimesSync(path.join(up, "clips", "old"), old, old);
  assert.equal(VE.sweepClips(up), 1);
  assert.ok(!fs.existsSync(path.join(up, "clips", "old")));
  assert.ok(fs.existsSync(path.join(up, "clips", "new")));
  assert.equal(VE.sweepClips(path.join(up, "missing")), 0);
}

console.log("ok video-edit pure");
```

- [ ] **Step 2: Run it and check that it fails**

Run: `cd server && node video-edit.test.js`
Expected: FAIL, `Cannot find module './video-edit'`.

- [ ] **Step 3: Implement** — create `server/video-edit.js`:

```js
/*
 * video-edit.js — WhatsApp edits of a finished walkthrough video.
 *
 * The first stitch keeps its clips and music bed (overlay.js keepSources)
 * under uploads/clips/<id>/ and the listing records them as `video`. An edit
 * re-renders from those files: new end titles, one new music bed for the whole
 * video, or one clip regenerated by n8n's Clip Regen workflow (FREE_REGENS per
 * video). Clip folders untouched for CLIP_TTL_DAYS are deleted (sweepClips);
 * an edit after that answers "expired".
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stitchTimeline } = require("./overlay");
const { roomLabel } = require("./rooms");

const FREE_REGENS = 2;
const CLIP_TTL_DAYS = 30;
const DAY_MS = 86400000;

// `plan` is the listing's walkthrough_clips, used only when it lines up 1:1
// with the stitched clips (the caller checks the count).
function newRecord({ result, plan = [], lines, logoUrl = null, phone = null, now }) {
  return {
    id: path.basename(result.kept.dir),
    dir: result.kept.dir,
    clips: result.kept.clips.map((file, i) => {
      const p = plan[i] || {};
      return { file, duration: result.clip_durations[i], rooms: p.rooms || [], prompt: p.prompt || "",
        image_urls: p.image_urls || [], planned_duration: p.duration || null };
    }),
    music: result.kept.music,
    lines,
    logo_url: logoUrl,
    phone,
    regens_used: 0,
    regen_pending: null,
    video_url: result.video_url,
    clean_video_url: result.clean_video_url,
    created_at: now,
  };
}

const offsetsOf = (rec) => stitchTimeline(rec.clips.map((c) => c.duration));

// The clip whose Hebrew room name is the longest one found in `text`; null
// when none or several clips tie ("חדר שינה ראשי" beats "חדר שינה").
function byRoomText(rec, text) {
  const t = String(text || "");
  const scores = rec.clips.map((c) => Math.max(0, ...c.rooms.map(roomLabel).filter((l) => l && t.includes(l)).map((l) => l.length)));
  const best = Math.max(...scores);
  const hits = scores.flatMap((s, i) => (s && s === best ? [i] : []));
  return hits.length === 1 ? hits[0] : null;
}

/** 0-based clip index for { index (1-based) | seconds | room }, or null. */
function pickClip(rec, sel = {}) {
  const n = rec.clips.length;
  if (Number.isInteger(sel.index)) return sel.index >= 1 && sel.index <= n ? sel.index - 1 : null;
  if (Number.isFinite(sel.seconds) && sel.seconds >= 0) {
    const { offsets, duration } = offsetsOf(rec);
    if (sel.seconds > duration) return null;
    let i = 0;
    while (i + 1 < n && offsets[i + 1] <= sel.seconds) i++;
    return i;
  }
  if (sel.room) return byRoomText(rec, roomLabel(sel.room) || sel.room);
  return null;
}

/** The agent's answer to "which clip?": a number, a time (0:12) or a room name. */
function pickFromAnswer(rec, text) {
  const t = String(text || "").trim();
  let m = /^(\d{1,2})$/.exec(t);
  if (m) return pickClip(rec, { index: Number(m[1]) });
  m = /(\d{1,2}):(\d{2})/.exec(t);
  if (m) return pickClip(rec, { seconds: Number(m[1]) * 60 + Number(m[2]) });
  return byRoomText(rec, t);
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const clipLabel = (rec, i) => rec.clips[i].rooms.map(roomLabel).filter(Boolean).join(" + ");

function clipMenu(rec) {
  const { offsets } = offsetsOf(rec);
  return rec.clips.map((c, i) => `${i + 1}. ${clipLabel(rec, i) || "קטע"} (${clock(offsets[i])}–${clock(offsets[i] + c.duration)})`).join("\n");
}

// Deletes clip folders not written to for CLIP_TTL_DAYS. A replaced clip
// writes into its folder, so the 30 days count from the last edit.
function sweepClips(uploadDir, now = Date.now()) {
  const root = path.join(uploadDir, "clips");
  let names = [];
  try { names = fs.readdirSync(root); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      if (now - fs.statSync(dir).mtimeMs > CLIP_TTL_DAYS * DAY_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch { /* removed meanwhile */ }
  }
  return removed;
}

module.exports = { FREE_REGENS, CLIP_TTL_DAYS, newRecord, pickClip, pickFromAnswer, clipLabel, clipMenu, sweepClips };
```

Note for the implementer: `os` is used from Task 4 on; keep the require.

In `server/package.json`, append ` && node video-edit.test.js` to the end of the `"test"` script string.

- [ ] **Step 4: Run it and check that it passes**

Run: `cd server && node video-edit.test.js`
Expected: `ok video-edit pure`

- [ ] **Step 5: Commit**

```bash
git add server/video-edit.js server/video-edit.test.js server/package.json
git commit -m "feat(video-edit): video record, clip picking by number/time/room, 30-day sweep"
```

---

### Task 4: `video-edit.js` — re-render, clip swap, publish, regen request, run

**Files:**
- Modify: `server/video-edit.js`
- Modify: `server/utils.js` (add `sendWhatsAppFile` next to `sendWhatsApp`, export it)
- Modify: `server/whatsapp-replies.js` (add the replies listed below, export them)
- Test: `server/video-edit.test.js`

**Interfaces:**
- Consumes: `renderStitched`, `resolveMusic`, `download`, `stitchTimeline` from `./overlay`; `rehost`, `sendWhatsApp`, `sendWhatsAppFile` from `./utils`.
- Produces:
  - `makeCtx({ uploadDir, baseUrl, storeOpts, n8nSecret, regenWebhook, greenInstance, greenToken, db? }) → Ctx`
  - `Ctx = { uploadDir, baseUrl, db, n8nSecret, regenWebhook, fetch, rehost(url) → Promise<{url}>, sendText(phone, reply), sendFile(phone, url, reply) }`
  - `restitch(rec, { lines?, newMusic?, musicPrompt? }, ctx) → Promise<VideoRecord>` (throws `code: "expired"` when clip files are gone, `code: "music_failed"` when a new bed could not be generated)
  - `replaceClip(rec, index, url, ctx) → Promise<VideoRecord>`
  - `publish(listingId, rec, ctx) → Promise<pageId | null>`
  - `requestRegen(listingId, rec, index, ctx) → Promise<{ ok: true, left } | { ok: false, reason: "busy"|"limit"|"no_plan"|"not_configured"|"webhook_failed" }>`
  - `runEdit(listingId, edit, ctx) → Promise<{ ok, reason?, video_url? }>`. `edit` is `{ action: "titles", lines } | { action: "music", music_prompt } | { action: "clip_done", index, url } | { action: "clip_failed", index }`.
  - `startEdit(pending, ctx) → Promise<{ ok, reason? }>`. `pending` is `{ listing_id, action: "titles"|"music"|"clip", lines?, music_prompt?, index? }`.
  - `utils.sendWhatsAppFile(phone, urlFile, fileName, caption, instance, token) → Promise<boolean|undefined>`
  - Replies: `R.confirmTitles(lines)`, `R.confirmMusic()`, `R.whichClip(menu)`, `R.confirmRegen(n, label, left)`, `R.regenLimit()`, `R.videoEditStarted(action)`, `R.videoEditRefused(reason)`, `R.videoEditDone()`, `R.videoEditFailed()`, `R.videoExpired()`. Each returns `{ text }`.

- [ ] **Step 1: Write the failing tests** — append to `server/video-edit.test.js` (above the final `console.log`, wrapped so async work finishes before it):

```js
// ── io: requestRegen / runEdit / publish with fakes ──
(async () => {
  const memDb = (listing) => {
    const store = { L1: listing };
    return {
      store,
      getListing: async (id) => store[id] || null,
      updateListing: async (id, patch) => { store[id] = { ...(store[id] || {}), ...patch }; },
      findActivePageByListing: async () => ({ page_id: "P1" }),
      updatePage: async (id, patch) => { store.page = { id, patch }; },
    };
  };
  const sent = [];
  const ctxWith = (db, over = {}) => ({
    uploadDir: "/nonexistent", baseUrl: "http://x", db, n8nSecret: "s", regenWebhook: "https://n8n/clip-regen",
    fetch: async (url, init) => { sent.push({ url, body: JSON.parse(init.body), secret: init.headers["x-forly-secret"] }); return { ok: true }; },
    rehost: async (url) => ({ url: url + "#rehosted" }),
    sendText: async (phone, r) => sent.push({ phone, text: r.text }),
    sendFile: async (phone, url, r) => sent.push({ phone, url, text: r.text }),
    ...over,
  });

  // requestRegen: counts, marks pending, sends the clip's plan
  {
    const db = memDb({ video: rec() });
    const out = await VE.requestRegen("L1", rec(), 1, ctxWith(db));
    assert.deepStrictEqual(out, { ok: true, left: 1 });
    assert.equal(db.store.L1.video.regens_used, 1);
    assert.equal(db.store.L1.video.regen_pending, 1);
    const call = sent.pop();
    assert.equal(call.secret, "s");
    assert.deepStrictEqual(call.body, { listing_id: "L1", clip_index: 1, prompt: "p1", image_urls: ["https://i/1.jpg"], duration: 6 });
  }
  assert.equal((await VE.requestRegen("L1", rec({ regens_used: 2 }), 1, ctxWith(memDb({})))).reason, "limit");
  assert.equal((await VE.requestRegen("L1", rec({ regen_pending: 0 }), 1, ctxWith(memDb({})))).reason, "busy");
  assert.equal((await VE.requestRegen("L1", rec(), 1, ctxWith(memDb({}), { regenWebhook: "" }))).reason, "not_configured");
  {
    const r = rec(); r.clips[1].prompt = "";
    assert.equal((await VE.requestRegen("L1", r, 1, ctxWith(memDb({})))).reason, "no_plan");
  }
  // webhook down: the regen is given back
  {
    const db = memDb({ video: rec() });
    const out = await VE.requestRegen("L1", rec(), 1, ctxWith(db, { fetch: async () => ({ ok: false, status: 502 }) }));
    assert.equal(out.reason, "webhook_failed");
    assert.equal(db.store.L1.video.regens_used, 0);
    assert.equal(db.store.L1.video.regen_pending, null);
  }

  // runEdit clip_failed: refund + tell the agent
  {
    const db = memDb({ video: rec({ regens_used: 1, regen_pending: 1 }) });
    const out = await VE.runEdit("L1", { action: "clip_failed", index: 1 }, ctxWith(db));
    assert.equal(out.reason, "regen_failed");
    assert.equal(db.store.L1.video.regens_used, 0);
    assert.equal(db.store.L1.video.regen_pending, null);
    assert.equal(sent.pop().phone, "972500000000");
  }
  // runEdit clip_done for a clip that is not pending: ignored
  {
    const db = memDb({ video: rec() });
    assert.equal((await VE.runEdit("L1", { action: "clip_done", index: 1, url: "https://v" }, ctxWith(db))).reason, "not_pending");
  }
  // runEdit with missing clip files: "expired" to the agent
  {
    const db = memDb({ video: rec() });
    const out = await VE.runEdit("L1", { action: "titles", lines: ["x"] }, ctxWith(db));
    assert.equal(out.reason, "expired");
    assert.match(sent.pop().text, /30/);
  }

  // publish: listing record + page hero
  {
    const db = memDb({});
    const pid = await VE.publish("L1", rec({ video_url: "https://t.mp4", clean_video_url: "https://c.mp4" }), ctxWith(db));
    assert.equal(pid, "P1");
    assert.equal(db.store.L1.video.clean_video_url, "https://c.mp4");
    assert.equal(db.store.page.patch["hero.video_url"], "https://c.mp4#rehosted");
    assert.equal(db.store.page.patch["hero.promo_video_url"], "https://t.mp4#rehosted");
  }

  // restitch end to end (ffmpeg only): new titles, then a swapped clip
  const hasFfmpeg = require("child_process").spawnSync("ffmpeg", ["-version"]).status === 0;
  if (hasFfmpeg) {
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "edit-up-"));
    fs.mkdirSync(path.join(up, "clips/v1"), { recursive: true });
    const mk = (rel, secs) => require("child_process").execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i",
      `testsrc=size=360x640:rate=24:duration=${secs}`, "-pix_fmt", "yuv420p", path.join(up, rel)]);
    mk("clips/v1/clip0.mp4", 4); mk("clips/v1/clip1.mp4", 4); mk("clips/v1/clip2.mp4", 4);
    const ctx = ctxWith(memDb({}), { uploadDir: up });
    const r1 = await VE.restitch(rec(), { lines: ["כותרת חדשה"] }, ctx);
    assert.deepStrictEqual(r1.lines, ["כותרת חדשה"]);
    assert.ok(fs.existsSync(path.join(up, "overlays", path.basename(r1.clean_video_url))));
    assert.ok(Math.abs(r1.clips[0].duration - 4) < 0.2);
    console.log("ok restitch (ffmpeg)");
  } else {
    console.log("skip restitch: no ffmpeg");
  }
  console.log("ok video-edit io");
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run them and check that they fail**

Run: `cd server && node video-edit.test.js`
Expected: FAIL, `TypeError: VE.requestRegen is not a function`.

- [ ] **Step 3a: Add `sendWhatsAppFile` to `server/utils.js`**, right after `sendWhatsApp`, and add it to `module.exports`:

```js
// A file by URL (video, image) with a caption. Same contract as sendWhatsApp.
async function sendWhatsAppFile(phone, urlFile, fileName, caption, instance, token) {
  if (!instance || !token) return;
  const r = await fetch(`${greenApiBase(instance)}/sendFileByUrl/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: `${phone}@c.us`, urlFile, fileName, caption: caption || "" }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error(`Green API sendFileByUrl refused (${r.status}): ${body.slice(0, 200)}`);
  }
  return r.ok;
}
```

- [ ] **Step 3b: Add the replies to `server/whatsapp-replies.js`**, above `module.exports`, and append their names to the exported object:

```js
// ── walkthrough video edits (video-edit.js, page-update.js) ──
function confirmTitles(lines) { return { text: `לשנות את הכותרות בסוף הסרטון ל:\n${lines.join("\n")}\n\nלאשר? (כן / לא)` }; }
function confirmMusic() { return { text: "ליצור מוזיקה חדשה לכל הסרטון? (כן / לא)" }; }
function whichClip(menu) { return { text: `איזה קטע לעשות מחדש? אפשר לשלוח מספר, שם של חדר, זמן בסרטון (למשל 0:12) או תמונה של החדר:\n${menu}` }; }
function confirmRegen(n, label, left) { return { text: `ליצור מחדש את קטע ${n}${label ? ` (${label})` : ""}? נשארו ${left} יצירות חוזרות בחינם לסרטון הזה. (כן / לא)` }; }
function regenLimit() { return { text: "ניצלת את היצירות החוזרות בחינם לסרטון הזה. אפשר עדיין לשנות את הכותרות ואת המוזיקה." }; }
function videoEditStarted(action) {
  return { text: action === "clip" ? "יוצרת את הקטע מחדש 🎬 אשלח את הסרטון המעודכן כשיהיה מוכן (כמה דקות)." : "מעדכנת את הסרטון 🎬 אשלח אותו כשיהיה מוכן." };
}
function videoEditRefused(reason) {
  if (reason === "limit") return regenLimit();
  if (reason === "busy") return { text: "קטע אחר כבר בעבודה. אפשר לבקש שוב כשהוא יסתיים." };
  if (reason === "no_plan") return { text: "את הקטע הזה אי אפשר ליצור מחדש. אפשר לשנות כותרות או מוזיקה." };
  return { text: "לא הצלחתי להתחיל את העריכה. כדאי לנסות שוב מאוחר יותר." };
}
function videoEditDone() { return { text: "הסרטון המעודכן מוכן ✅ גם דף הנכס עודכן." }; }
function videoEditFailed() { return { text: "העריכה של הסרטון נכשלה 😕 הסרטון הקודם נשאר. אפשר לנסות שוב." }; }
function videoExpired() { return { text: "עברו יותר מ-30 יום, והקטעים של הסרטון הזה כבר לא שמורים לעריכה." }; }
```

- [ ] **Step 3c: Implement the io functions in `server/video-edit.js`.** Change the overlay import and add:

```js
const { stitchTimeline, renderStitched, resolveMusic, download } = require("./overlay");
const R = require("./whatsapp-replies");

const LOGO_EXT = (url) => (/\.(png|jpe?g|webp)(\?|$)/i.exec(url) || [, "png"])[1].toLowerCase();
const fail = (code, msg) => Object.assign(new Error(msg || code), { code });

// Everything the edits need from the server, built once in index.js.
function makeCtx({ uploadDir, baseUrl, storeOpts = {}, n8nSecret, regenWebhook, greenInstance, greenToken, db = require("./db") }) {
  const { rehost, sendWhatsApp, sendWhatsAppFile } = require("./utils");
  return {
    uploadDir, baseUrl, db, n8nSecret, regenWebhook, fetch,
    rehost: (url) => rehost(url, "video.mp4", uploadDir, baseUrl, storeOpts),
    sendText: (phone, r) => (phone ? sendWhatsApp(phone, r.text, greenInstance, greenToken) : Promise.resolve()),
    sendFile: (phone, url, r) => (phone ? sendWhatsAppFile(phone, url, "video.mp4", r.text, greenInstance, greenToken) : Promise.resolve()),
  };
}

/** Re-render from the kept clips. newMusic: one new bed for the whole video. */
async function restitch(rec, { lines = null, newMusic = false, musicPrompt = null } = {}, ctx) {
  const abs = (rel) => path.join(ctx.uploadDir, rel);
  const files = rec.clips.map((c) => abs(c.file));
  if (!files.every((f) => fs.existsSync(f))) throw fail("expired", "clips expired");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edit-"));
  try {
    let music = rec.music && fs.existsSync(abs(rec.music)) ? rec.music : null;
    if (newMusic) {
      const { duration } = stitchTimeline(rec.clips.map((c) => c.duration));
      const got = await resolveMusic({ duration, musicPrompt, tmp });
      // Only a freshly generated bed counts; the static fallback is not "new music".
      if (!got.file || !String(got.debug).startsWith("generated")) throw fail("music_failed", `music: ${got.debug}`);
      const next = `${rec.dir}/music-${Date.now()}${path.extname(got.file) || ".audio"}`;
      fs.copyFileSync(got.file, abs(next));
      if (music) fs.rmSync(abs(music), { force: true });
      music = next;
    }
    let logoFile = null;
    if (rec.logo_url) {
      logoFile = path.join(tmp, `logo.${LOGO_EXT(rec.logo_url)}`);
      try { await download(rec.logo_url, logoFile); } catch (err) { logoFile = null; }
    }
    const nextLines = lines || rec.lines;
    const out = await renderStitched({ tmp, inFiles: files, lines: nextLines, musicFile: music ? abs(music) : null,
      logoFile, uploadDir: ctx.uploadDir, baseUrl: ctx.baseUrl });
    return { ...rec, lines: nextLines, music, clips: rec.clips.map((c, i) => ({ ...c, duration: out.clip_durations[i] })),
      video_url: out.video_url, clean_video_url: out.clean_video_url, updated_at: new Date() };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Swap clip `index` for the one at `url`, then re-render with the same bed. */
async function replaceClip(rec, index, url, ctx) {
  const rel = `${rec.dir}/clip${index}-${Date.now()}.mp4`;
  await download(url, path.join(ctx.uploadDir, rel));
  const old = rec.clips[index].file;
  const done = await restitch({ ...rec, clips: rec.clips.map((c, i) => (i === index ? { ...c, file: rel } : c)) }, {}, ctx);
  fs.rmSync(path.join(ctx.uploadDir, old), { force: true });
  return done;
}

/** Save the record and point the live property page at the new renders. */
async function publish(listingId, rec, ctx) {
  await ctx.db.updateListing(listingId, { video: rec });
  const page = await ctx.db.findActivePageByListing(listingId);
  if (!page) return null;
  const [clean, promo] = await Promise.all([ctx.rehost(rec.clean_video_url), ctx.rehost(rec.video_url).catch(() => null)]);
  await ctx.db.updatePage(page.page_id, { "hero.video_url": clean.url, "hero.promo_video_url": promo ? promo.url : null, updated_at: new Date() });
  return page.page_id;
}

/** Ask n8n's Clip Regen workflow for clip `index`. Counted up front, given back on failure. */
async function requestRegen(listingId, rec, index, ctx) {
  if (rec.regen_pending != null) return { ok: false, reason: "busy" };
  if (rec.regens_used >= FREE_REGENS) return { ok: false, reason: "limit" };
  const c = rec.clips[index];
  if (!c || !c.prompt || !c.image_urls.length) return { ok: false, reason: "no_plan" };
  if (!ctx.regenWebhook) return { ok: false, reason: "not_configured" };
  await ctx.db.updateListing(listingId, { video: { ...rec, regens_used: rec.regens_used + 1, regen_pending: index } });
  try {
    const r = await ctx.fetch(ctx.regenWebhook, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forly-secret": ctx.n8nSecret },
      body: JSON.stringify({ listing_id: listingId, clip_index: index, prompt: c.prompt, image_urls: c.image_urls, duration: c.planned_duration }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`clip regen webhook ${r.status}`);
  } catch (err) {
    console.error("video-edit: regen request failed:", err.message);
    await ctx.db.updateListing(listingId, { video: rec });
    return { ok: false, reason: "webhook_failed" };
  }
  return { ok: true, left: FREE_REGENS - rec.regens_used - 1 };
}

/** Do one edit to the end: render, publish, send the agent the new video. */
async function runEdit(listingId, edit, ctx) {
  const listing = await ctx.db.getListing(listingId);
  const rec = listing && listing.video;
  if (!rec) return { ok: false, reason: "no_video" };
  const isClip = edit.action === "clip_done" || edit.action === "clip_failed";
  if (isClip && rec.regen_pending !== edit.index) return { ok: false, reason: "not_pending" };
  if (edit.action === "clip_failed") {
    await ctx.db.updateListing(listingId, { video: { ...rec, regen_pending: null, regens_used: Math.max(0, rec.regens_used - 1) } });
    await ctx.sendText(rec.phone, R.videoEditFailed());
    return { ok: false, reason: "regen_failed" };
  }
  try {
    let next;
    if (edit.action === "titles") next = await restitch(rec, { lines: edit.lines }, ctx);
    else if (edit.action === "music") next = await restitch(rec, { newMusic: true, musicPrompt: edit.music_prompt }, ctx);
    else if (edit.action === "clip_done") next = { ...(await replaceClip(rec, edit.index, edit.url, ctx)), regen_pending: null };
    else return { ok: false, reason: "bad_action" };
    await publish(listingId, next, ctx);
    await ctx.sendFile(rec.phone, next.video_url, R.videoEditDone());
    return { ok: true, video_url: next.video_url };
  } catch (err) {
    console.error("video-edit failed:", err.message);
    if (isClip) await ctx.db.updateListing(listingId, { video: { ...rec, regen_pending: null } }).catch(() => {});
    await ctx.sendText(rec.phone, err.code === "expired" ? R.videoExpired() : R.videoEditFailed()).catch(() => {});
    return { ok: false, reason: err.code || "failed" };
  }
}

/** The agent said "כן" to a proposed edit (page-update.js). */
async function startEdit(pending, ctx) {
  const listing = await ctx.db.getListing(pending.listing_id);
  const rec = listing && listing.video;
  if (!rec) return { ok: false, reason: "no_video" };
  if (pending.action === "clip") return requestRegen(pending.listing_id, rec, pending.index, ctx);
  runEdit(pending.listing_id, pending, ctx).catch((err) => console.error("video-edit:", err.message));
  return { ok: true };
}
```

Extend `module.exports` with `makeCtx, restitch, replaceClip, publish, requestRegen, runEdit, startEdit`.

- [ ] **Step 4: Run them and check that they pass**

Run: `cd server && node video-edit.test.js && node whatsapp-flows.test.js && node utils.test.js`
Expected: `ok video-edit pure`, `ok restitch (ffmpeg)`, `ok video-edit io`; the other two pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/video-edit.js server/video-edit.test.js server/utils.js server/whatsapp-replies.js
git commit -m "feat(video-edit): re-render from kept clips, swap a clip, publish to page, request a regen"
```

---

### Task 5: `/api/video-overlay` keeps clips for a listing; `POST /api/walkthrough/clip`; wiring and sweep

**Files:**
- Modify: `server/routes/pages.js` (`/api/video-overlay`, ~line 693)
- Modify: `server/routes/walkthrough.js` (router factory params + new route)
- Modify: `server/index.js` (build `videoEdit` ctx before the walkthrough router ~line 214; pass it to the walkthrough, pages and whatsapp routers; daily sweep)
- Test: `server/video-edit.test.js` (route test with supertest-free express call)

**Interfaces:**
- Consumes: `overlayVideo({ …, keep })` (Task 2); `VE.newRecord`, `VE.runEdit`, `VE.makeCtx`, `VE.sweepClips` (Tasks 3–4).
- Produces:
  - `POST /api/video-overlay` accepts optional `listing_id`. When the listing exists, the clips are kept and `listing.video` is written. The response is unchanged (`kept` is not returned).
  - `POST /api/walkthrough/clip` (x-forly-secret): body `{ listing_id, clip_index, video_url }` or `{ listing_id, clip_index, failed: true }`. Answers 202 at once; the edit runs in the background.
  - Env: `N8N_CLIP_REGEN_WEBHOOK_URL` (the n8n Clip Regen webhook).

- [ ] **Step 1: Write the failing test** — append to `server/video-edit.test.js` (inside its own async block, before the final log):

```js
// ── POST /api/walkthrough/clip ──
(async () => {
  const express = require("express");
  const http = require("http");
  const createWalkthroughRouter = require("./routes/walkthrough");
  const runs = [];
  const app = express();
  app.use(express.json());
  app.use("/api/walkthrough", createWalkthroughRouter({ n8nSecret: "s", uploadDir: null, baseUrl: "http://x",
    videoEdit: { runEdit: async (id, edit) => { runs.push({ id, edit }); return { ok: true }; } } }));
  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const post = (body, secret = "s") => fetch(`http://127.0.0.1:${port}/api/walkthrough/clip`, {
    method: "POST", headers: { "content-type": "application/json", "x-forly-secret": secret }, body: JSON.stringify(body) });
  assert.equal((await post({ listing_id: "L1", clip_index: 1, video_url: "https://v.mp4" }, "bad")).status, 403);
  assert.equal((await post({ listing_id: "L1", clip_index: -1, video_url: "https://v.mp4" })).status, 400);
  assert.equal((await post({ listing_id: "L1", clip_index: 1 })).status, 400);
  assert.equal((await post({ listing_id: "L1", clip_index: 1, video_url: "https://v.mp4" })).status, 202);
  assert.equal((await post({ listing_id: "L1", clip_index: 2, failed: true })).status, 202);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(runs, [
    { id: "L1", edit: { action: "clip_done", index: 1, url: "https://v.mp4" } },
    { id: "L1", edit: { action: "clip_failed", index: 2 } },
  ]);
  server.close();
  console.log("ok clip route");
})().catch((err) => { console.error(err); process.exit(1); });
```

The route receives `videoEdit` as an object with a `runEdit(listingId, edit)` method, so tests can fake it. In production, index.js passes `{ runEdit: (id, e) => VE.runEdit(id, e, ctx) }`.

- [ ] **Step 2: Run it and check that it fails**

Run: `cd server && node video-edit.test.js`
Expected: FAIL, `AssertionError` (404 instead of 403).

- [ ] **Step 3a: Add the route to `server/routes/walkthrough.js`.** Change the factory signature to `({ n8nSecret, uploadDir, baseUrl, storeOpts = {}, videoEdit = null })` and add, after `/plan`:

```js
  // ── POST /clip: n8n's Clip Regen workflow hands back one regenerated clip ──
  // { listing_id, clip_index, video_url } or { listing_id, clip_index, failed: true }.
  // Answered at once; the re-render, page update and WhatsApp send run after.
  router.post("/clip", requireN8n, (req, res) => {
    const b = req.body || {};
    const listingId = typeof b.listing_id === "string" ? b.listing_id.slice(0, 100) : "";
    const index = Number(b.clip_index);
    const url = typeof b.video_url === "string" && /^https:\/\//.test(b.video_url) ? b.video_url : null;
    if (!listingId || !Number.isInteger(index) || index < 0 || (!url && b.failed !== true)) {
      return res.status(400).json({ error: "listing_id, clip_index and video_url (or failed: true) required" });
    }
    if (!videoEdit) return res.status(503).json({ error: "video_edit_not_configured" });
    res.status(202).json({ ok: true });
    videoEdit.runEdit(listingId, url ? { action: "clip_done", index, url } : { action: "clip_failed", index })
      .catch((err) => console.error("walkthrough/clip: edit failed:", err.message));
  });
```

- [ ] **Step 3b: Keep clips in `/api/video-overlay` (`server/routes/pages.js`).** At the top of the overlay section, next to the `require("../overlay")` line, add `const VE = require("../video-edit");`. Replace the `try { const result = await overlayVideo(...) ... }` block with:

```js
    // A listing's video keeps its clips and music bed for WhatsApp edits (video-edit.js).
    const listingId = typeof body.listing_id === "string" ? body.listing_id.trim().slice(0, 100) : "";
    const listing = listingId ? await db.getListing(listingId).catch(() => null) : null;
    try {
      const result = await overlayVideo({ videoUrls, lines, musicUrl, musicPrompt, logoUrl, uploadDir, baseUrl, keep: Boolean(listing) });
      const { kept, ...out } = result;
      if (listing && kept) {
        // The plan describes these clips only when nothing was dropped between plan and stitch.
        const plan = Array.isArray(listing.walkthrough_clips) && listing.walkthrough_clips.length === result.clip_count ? listing.walkthrough_clips : [];
        await db.updateListing(listingId, { video: VE.newRecord({ result, plan, lines, logoUrl, phone, now: new Date() }) })
          .catch((err) => console.warn("video-overlay: saving the video record failed:", err.message));
      }
      res.json(out);
    } catch (err) {
      console.error("video-overlay failed:", err.message);
      res.status(500).json({ error: "overlay_failed" });
    }
```

- [ ] **Step 3c: Wire it in `server/index.js`.** Right before `const createWalkthroughRouter = require("./routes/walkthrough");` add:

```js
// ── walkthrough video edits over WhatsApp (video-edit.js) ──
const VE = require("./video-edit");
const videoEditCtx = VE.makeCtx({
  uploadDir: UPLOAD_DIR, baseUrl: BASE_URL, n8nSecret: N8N_WEBHOOK_SECRET,
  regenWebhook: (process.env.N8N_CLIP_REGEN_WEBHOOK_URL || "").trim(),
  greenInstance: GREENAPI_INSTANCE, greenToken: GREENAPI_TOKEN,
  storeOpts: {
    uploadPublicBase: UPLOAD_PUBLIC_BASE, remoteUploadBase: REMOTE_UPLOAD_BASE,
    signUpload: (fname) => signActionToken(uploadTokenParts(fname), AUTH_SECRET),
  },
});
const videoEdit = {
  ctx: videoEditCtx,
  runEdit: (id, edit) => VE.runEdit(id, edit, videoEditCtx),
  startEdit: (pending) => VE.startEdit(pending, videoEditCtx),
};
// Clip folders live 30 days after their last edit; checked at boot and daily.
const sweepClips = () => { try { const n = VE.sweepClips(UPLOAD_DIR); if (n) console.log(`video-edit: swept ${n} clip folders`); } catch (err) { console.warn("video-edit: sweep failed:", err.message); } };
sweepClips();
setInterval(sweepClips, 24 * 60 * 60 * 1000).unref();
```

Add `videoEdit,` to the `createWalkthroughRouter({...})` and `createWhatsappRouter({...})` option objects. Before editing, check that `GREENAPI_TOKEN`, `UPLOAD_PUBLIC_BASE`, `signActionToken` and `uploadTokenParts` are declared above this point (`grep -n "const GREENAPI_TOKEN\|const UPLOAD_PUBLIC_BASE\|uploadTokenParts\b.*require\|signActionToken\b.*require" server/index.js`). Where one is declared later, move the block below it but above `app.use("/api/walkthrough", …)`.

- [ ] **Step 4: Run it and check that it passes, plus the full suite**

Run: `cd server && node video-edit.test.js && npm test`
Expected: `ok clip route`; `npm test` exits 0.

Manual smoke test with no Firestore (in-memory db):

```bash
cd server && N8N_WEBHOOK_SECRET=s npm run local &
sleep 3; curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8787/api/walkthrough/clip -H 'content-type: application/json' -H 'x-forly-secret: s' -d '{"listing_id":"L1","clip_index":0,"failed":true}'; kill %1
```
Expected: `202` (the log then shows nothing to do, because L1 has no video).

- [ ] **Step 5: Commit**

```bash
git add server/routes/pages.js server/routes/walkthrough.js server/index.js server/video-edit.test.js
git commit -m "feat(video-edit): keep clips for listing videos, clip regen callback, daily sweep"
```

---

### Task 6: `video-edit-intent.js` — what does the message ask for

**Files:**
- Create: `server/video-edit-intent.js`
- Create: `server/video-edit-intent.test.js`
- Modify: `server/package.json` (append `&& node video-edit-intent.test.js`)

**Interfaces:**
- Consumes: `ask` from `./chat-provider` (`ask(model, system, messages, keys, opts) → { text }`); `MAX_LINES`, `MAX_LINE_CHARS` from `./overlay`.
- Produces:
  - `VIDEO_WORDS: RegExp`
  - `parseVideoEdit(text, { currentLines, askFn?, keys? }) → Promise<null | { action: "clip", clip: { index, seconds, room } } | { action: "titles", lines } | { action: "music", music_prompt }>`

- [ ] **Step 1: Write the failing test** — create `server/video-edit-intent.test.js`:

```js
const assert = require("assert");
const { parseVideoEdit, VIDEO_WORDS } = require("./video-edit-intent");

const fake = (text) => async () => ({ text });
(async () => {
  assert.ok(VIDEO_WORDS.test("תחליף את המוזיקה בסרטון"));
  assert.ok(!VIDEO_WORDS.test("תוריד את המחיר"));
  // gate: no LLM call without a video word
  let called = false;
  assert.equal(await parseVideoEdit("תוריד את המחיר", { askFn: async () => { called = true; return { text: "{}" }; } }), null);
  assert.equal(called, false);

  assert.deepStrictEqual(await parseVideoEdit("תעשי מחדש את המטבח בסרטון", { askFn: fake('{"action":"clip","clip":{"index":null,"seconds":null,"room":"kitchen"}}') }),
    { action: "clip", clip: { index: null, seconds: null, room: "kitchen" } });
  assert.deepStrictEqual(await parseVideoEdit("קטע 3 בסרטון יצא עקום", { askFn: fake('```json\n{"action":"clip","clip":{"index":3}}\n```') }),
    { action: "clip", clip: { index: 3, seconds: null, room: null } });
  assert.deepStrictEqual(await parseVideoEdit("תשני את הכותרת", { currentLines: ["a", "b"], askFn: fake('{"action":"titles","lines":["חדש"," b ",""]}') }),
    { action: "titles", lines: ["חדש", "b"] });
  assert.deepStrictEqual(await parseVideoEdit("מוזיקה אחרת לסרטון, משהו שמח", { askFn: fake('{"action":"music","music_prompt":"upbeat"}') }),
    { action: "music", music_prompt: "upbeat" });
  assert.equal(await parseVideoEdit("סרטון חדש לגמרי", { askFn: fake('{"action":null}') }), null);
  assert.equal(await parseVideoEdit("סרטון", { askFn: fake("not json") }), null);
  assert.equal(await parseVideoEdit("סרטון", { askFn: async () => { throw new Error("down"); } }), null);
  // titles are capped like the overlay route
  const long = await parseVideoEdit("כותרת", { askFn: fake(JSON.stringify({ action: "titles", lines: ["x".repeat(99), "2", "3", "4"] })) });
  assert.equal(long.lines.length, 3);
  assert.equal(long.lines[0].length, 60);
  console.log("ok video-edit-intent");
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it and check that it fails**

Run: `cd server && node video-edit-intent.test.js`
Expected: FAIL, `Cannot find module './video-edit-intent'`.

- [ ] **Step 3: Implement** — create `server/video-edit-intent.js`:

```js
/*
 * video-edit-intent.js — which edit of a page's walkthrough video a WhatsApp
 * message asks for: one clip redone, new end titles, or new music. One short
 * LLM call (property-intent.js style); any failure is "not a video edit", and
 * the message keeps its old path (the page edit link).
 */
const { ask } = require("./chat-provider");
const { MAX_LINES, MAX_LINE_CHARS } = require("./overlay");

const MODEL = process.env.VIDEO_EDIT_MODEL || "claude-haiku-4-5-20251001";
// Only these messages are worth the call.
const VIDEO_WORDS = /סרטון|וידאו|וידיאו|קליפ|קטע|כותרת|כיתוב|מוזיקה|מוסיקה|שיר|פסקול|סאונד/;

const SYSTEM = `A real-estate agent wants to change the walkthrough video of one of their property pages.
The video is several clips, one per room, joined together, with end titles and one music track.
Reply with JSON only:
{"action": "clip" | "titles" | "music" | null,
 "clip": {"index": number|null, "seconds": number|null, "room": string|null},
 "lines": [string]|null,
 "music_prompt": string|null}
- "clip": redo / regenerate / fix one part of the video. index: the 1-based clip number if they name one. seconds: if they name a time ("0:12" → 12, "בשנייה 20" → 20). room: the room in English snake_case (kitchen, living_room, bedroom, master_bedroom, bathroom, balcony, dining_room, kids_room, exterior, garden, pool...) if they name one.
- "titles": change the end titles. lines: the full new list of title lines — start from the current lines and change only what they asked.
- "music": new music / sound for the video. music_prompt: a short English description of the style they asked for, or null.
- null: anything else, including a whole new video or new photos.`;

function normalize(raw) {
  let j;
  try { j = JSON.parse(String(raw || "").match(/\{[\s\S]*\}/)[0]); } catch { return null; }
  if (j.action === "clip") {
    const c = j.clip || {};
    return { action: "clip", clip: {
      index: Number.isInteger(c.index) ? c.index : null,
      seconds: Number.isFinite(c.seconds) ? c.seconds : null,
      room: typeof c.room === "string" && c.room.trim() ? c.room.trim().slice(0, 40) : null,
    } };
  }
  if (j.action === "titles") {
    const lines = (Array.isArray(j.lines) ? j.lines : []).map((l) => String(l || "").trim().slice(0, MAX_LINE_CHARS)).filter(Boolean).slice(0, MAX_LINES);
    return lines.length ? { action: "titles", lines } : null;
  }
  if (j.action === "music") return { action: "music", music_prompt: typeof j.music_prompt === "string" && j.music_prompt.trim() ? j.music_prompt.trim().slice(0, 300) : null };
  return null;
}

async function parseVideoEdit(text, { currentLines = [], askFn = ask, keys = process.env } = {}) {
  const t = String(text || "").trim();
  if (!t || t.length > 400 || !VIDEO_WORDS.test(t)) return null;
  const content = `Current end titles:\n${currentLines.map((l, i) => `${i + 1}. ${l}`).join("\n") || "(none)"}\n\nMessage: ${t}`;
  try {
    const reply = await askFn(MODEL, SYSTEM, [{ role: "user", content }], keys, { schema: null, maxOut: 400 });
    return normalize(reply && reply.text);
  } catch (err) {
    return null;
  }
}

module.exports = { parseVideoEdit, VIDEO_WORDS, SYSTEM };
```

In `server/package.json`, append ` && node video-edit-intent.test.js` to the `"test"` script.

- [ ] **Step 4: Run it and check that it passes**

Run: `cd server && node video-edit-intent.test.js`
Expected: `ok video-edit-intent`

- [ ] **Step 5: Commit**

```bash
git add server/video-edit-intent.js server/video-edit-intent.test.js server/package.json
git commit -m "feat(video-edit): parse WhatsApp video edit requests"
```

---

### Task 7: Numbered clip sheet (thumbnails)

**Files:**
- Modify: `server/video-edit.js` (add `clipSheetArgs`, `clipSheet`)
- Test: `server/video-edit.test.js`

**Interfaces:**
- Consumes: `run`, `FONTS_DIR`, `stitchTimeline` from `./overlay`.
- Produces: `clipSheetArgs({ files, mids, out, font }) → string[]` (ffmpeg args, pure) and `clipSheet(rec, ctx) → Promise<string>` (public URL of `uploads/<rec.dir>/sheet.jpg`).

- [ ] **Step 1: Write the failing test** — append inside the io async block of `server/video-edit.test.js`, in the `if (hasFfmpeg)` branch after the restitch assertions:

```js
    const args = VE.clipSheetArgs({ files: ["a.mp4", "b.mp4"], mids: [1, 2.5], out: "s.jpg", font: "/f.ttf" });
    assert.deepStrictEqual(args.slice(0, 8), ["-y", "-ss", "1", "-i", "a.mp4", "-ss", "2.5", "-i"]);
    assert.ok(args.join(" ").includes("hstack=inputs=2"));
    const sheetUrl = await VE.clipSheet(rec(), ctx);
    assert.equal(sheetUrl, "http://x/files/clips/v1/sheet.jpg");
    assert.ok(fs.statSync(path.join(up, "clips/v1/sheet.jpg")).size > 1000);
    console.log("ok clip sheet");
```

- [ ] **Step 2: Run it and check that it fails**

Run: `cd server && node video-edit.test.js`
Expected: FAIL, `VE.clipSheetArgs is not a function`.

- [ ] **Step 3: Implement** — in `server/video-edit.js`, extend the overlay import with `run, FONTS_DIR` and add:

```js
const SHEET_W = 240; // per thumbnail; 6 clips → 1440px wide

// One frame from the middle of each clip, side by side, each with its number.
function clipSheetArgs({ files, mids, out, font }) {
  const args = ["-y"];
  files.forEach((f, i) => args.push("-ss", String(mids[i]), "-i", f));
  const ff = font.replace(/\\/g, "/").replace(/:/g, "\\:");
  const parts = files.map((_, i) =>
    `[${i}:v]scale=${SHEET_W}:-2,drawtext=fontfile='${ff}':text='${i + 1}':fontsize=64:fontcolor=white:borderw=4:bordercolor=black:x=16:y=12[t${i}]`);
  const stack = files.length > 1 ? `;${files.map((_, i) => `[t${i}]`).join("")}hstack=inputs=${files.length}[s]` : "";
  args.push("-filter_complex", parts.join(";") + stack, "-map", files.length > 1 ? "[s]" : "[t0]", "-frames:v", "1", "-q:v", "4", out);
  return args;
}

/** Numbered thumbnails of the clips, for "which clip?" (sent with whichClip). */
async function clipSheet(rec, ctx) {
  const files = rec.clips.map((c) => path.join(ctx.uploadDir, c.file));
  if (!files.every((f) => fs.existsSync(f))) throw fail("expired", "clips expired");
  const font = path.join(FONTS_DIR, fs.readdirSync(FONTS_DIR).find((f) => /\.ttf$/i.test(f)));
  const rel = `${rec.dir}/sheet.jpg`;
  const mids = rec.clips.map((c) => (c.duration / 2).toFixed(2));
  await run(process.env.FFMPEG_PATH || "ffmpeg", clipSheetArgs({ files, mids, out: path.join(ctx.uploadDir, rel), font }), 60000);
  return `${ctx.baseUrl}/files/${rel}`;
}
```

Add `clipSheetArgs, clipSheet` to `module.exports`. Before running, confirm `run`'s signature in overlay.js is `run(bin, args, timeoutMs)` (`grep -n "^function run\|^async function run" server/overlay.js`).

- [ ] **Step 4: Run it and check that it passes**

Run: `cd server && node video-edit.test.js`
Expected: includes `ok clip sheet`.

- [ ] **Step 5: Commit**

```bash
git add server/video-edit.js server/video-edit.test.js
git commit -m "feat(video-edit): numbered clip thumbnails for picking a clip"
```

---

### Task 8: WhatsApp flow — propose, pick, confirm, start

**Files:**
- Modify: `server/page-update.js` (`updatePage`, `updatingTurn`, new `proposeVideoEdit` / `clipStep` / `videoTurn`)
- Modify: `server/routes/whatsapp.js` (`depsFor`)
- Test: `server/whatsapp-flows.test.js`

**Interfaces:**
- Consumes: `VE.pickClip`, `VE.pickFromAnswer`, `VE.clipMenu`, `VE.clipLabel`, `VE.FREE_REGENS`, `VE.clipSheet`; `parseVideoEdit`; the replies from Task 4; `mapSpaces` from `./space-map` (it never throws; `map.spaces[0].type` is the room).
- Deps added to `depsFor` (all optional; when missing, the flow is skipped):
  - `getListing(id) → Promise<listing|null>`
  - `parseVideoEdit(text, currentLines) → Promise<intent|null>`
  - `roomOfPhoto(url) → Promise<string|null>`
  - `sendClipSheet(rec) → Promise<void>`
  - `startVideoEdit(pending) → Promise<{ ok, reason? }>`
- Draft state: `draft.pending_video = { listing_id, action: "titles"|"music"|"clip", lines?, music_prompt?, index: number|null }`.

- [ ] **Step 1: Write the failing tests** — append to `server/whatsapp-flows.test.js`, before its final log line. Reuse that file's `deps()`, `handleTurn`, `PHONE`, `T0`. Check its existing helpers first (`grep -n "^const turn\|^async function turn\|clone" server/whatsapp-flows.test.js`) and use the same call shape the page-update tests at ~line 91 use:

```js
// ── walkthrough video edits ──
{
  const video = {
    id: "v1", dir: "clips/v1", music: null, lines: ["דירת 4 חדרים"], phone: PHONE, regens_used: 0, regen_pending: null,
    clips: [
      { file: "a", duration: 8, rooms: ["living_room"], prompt: "p", image_urls: ["https://i/a.jpg"], planned_duration: 8 },
      { file: "b", duration: 6, rooms: ["kitchen"], prompt: "q", image_urls: ["https://i/b.jpg"], planned_duration: 6 },
    ],
  };
  const live = { page_id: "P9", listing_id: "L9", status: "active", property: { title: "דליות 35", address: "נחל דליות 35", city: "", neighborhood: "" }, gallery: { images: [] } };
  const started = [];
  const vdeps = (intent, over = {}) => deps({
    classifyIntent: async () => "update", listPages: async () => [live], editUrl: (id) => `https://agent/edit.html?id=${id}`,
    getListing: async () => ({ video }), parseVideoEdit: async () => intent,
    roomOfPhoto: async () => "kitchen", sendClipSheet: async () => {},
    startVideoEdit: async (pv) => { started.push(pv); return { ok: true }; },
    ...over,
  }).d;

  // room named → confirm with the clip → "כן" starts the regen
  let t = await handleTurn({ phone: PHONE, text: "תעשי מחדש את המטבח בסרטון של דליות 35" }, vdeps({ action: "clip", clip: { index: null, seconds: null, room: "kitchen" } }));
  assert.equal(t.status, "video_edit_proposed");
  assert.match(t.replies[0].text, /קטע 2 \(מטבח\)/);
  t = await handleTurn({ phone: PHONE, text: "כן", draft: t.draft }, vdeps(null));
  assert.equal(t.status, "video_edit_started");
  assert.deepStrictEqual(started.pop(), { listing_id: "L9", action: "clip", index: 1 });

  // no clip named → menu → a photo picks the room
  t = await handleTurn({ phone: PHONE, text: "קטע בסרטון של דליות 35 יצא לא טוב" }, vdeps({ action: "clip", clip: { index: null, seconds: null, room: null } }));
  assert.match(t.replies[0].text, /1\. סלון/);
  t = await handleTurn({ phone: PHONE, fileUrl: "https://wa/photo.jpg", draft: t.draft }, vdeps(null));
  assert.equal(t.status, "video_clip_picked");
  assert.match(t.replies[0].text, /קטע 2/);

  // titles → confirm → started with the new lines
  t = await handleTurn({ phone: PHONE, text: "תשני את הכותרת בסרטון של דליות 35" }, vdeps({ action: "titles", lines: ["פנטהאוז"] }));
  assert.match(t.replies[0].text, /פנטהאוז/);
  t = await handleTurn({ phone: PHONE, text: "כן", draft: t.draft }, vdeps(null));
  assert.deepStrictEqual(started.pop(), { listing_id: "L9", action: "titles", lines: ["פנטהאוז"] });

  // limit reached: told so, nothing pending
  video.regens_used = 2;
  t = await handleTurn({ phone: PHONE, text: "תעשי מחדש את המטבח בסרטון של דליות 35" }, vdeps({ action: "clip", clip: { index: 2, seconds: null, room: null } }));
  assert.equal(t.status, "video_edit_limit");
  assert.equal(t.draft.pending_video, null);
  video.regens_used = 0;

  // page without a stored video: the old edit link
  t = await handleTurn({ phone: PHONE, text: "תיצור סרטון חדש לנכס בדליות 35" }, vdeps({ action: "clip", clip: {} }, { getListing: async () => ({}) }));
  assert.equal(t.status, "update_link");
  console.log("ok video edit flow");
}
```

Wrap this block in the file's existing async style. If the file's top level is not async, put it inside an `(async () => { … })()` like the other blocks there.

- [ ] **Step 2: Run them and check that they fail**

Run: `cd server && node whatsapp-flows.test.js`
Expected: FAIL at the first `video_edit_proposed` assertion (status is `update_link`).

- [ ] **Step 3a: Implement in `server/page-update.js`.** Add near the top:

```js
const VE = require("./video-edit");

/*
 * "תעשי מחדש את המטבח בסרטון של דליות 35" / "מוזיקה אחרת": an edit of the
 * page's stored walkthrough (video-edit.js). null when the page has no stored
 * clips or the message is not a video edit; it then gets the edit link as before.
 */
async function proposeVideoEdit(page, text, deps) {
  if (!page.listing_id || !deps.getListing || !deps.parseVideoEdit) return null;
  const listing = await deps.getListing(page.listing_id).catch(() => null);
  const rec = listing && listing.video;
  if (!rec || !Array.isArray(rec.clips) || !rec.clips.length) return null;
  const intent = await deps.parseVideoEdit(text, rec.lines || []);
  if (!intent) return null;
  const base = { listing_id: page.listing_id };
  if (intent.action === "titles") return { pending: { ...base, action: "titles", lines: intent.lines }, replies: [R.confirmTitles(intent.lines)] };
  if (intent.action === "music") return { pending: { ...base, action: "music", music_prompt: intent.music_prompt }, replies: [R.confirmMusic()] };
  return clipStep(rec, VE.pickClip(rec, intent.clip || {}), base, deps);
}

// A clip edit: out of free regens → said so; clip unknown → the menu (and the
// numbered thumbnails); clip known → confirm it.
function clipStep(rec, index, base, deps) {
  const left = VE.FREE_REGENS - (rec.regens_used || 0);
  if (left <= 0) return { pending: null, replies: [R.regenLimit()] };
  if (index == null) {
    if (deps.sendClipSheet) deps.sendClipSheet(rec).catch((err) => console.warn("clip sheet failed:", err.message));
    return { pending: { ...base, action: "clip", index: null }, replies: [R.whichClip(VE.clipMenu(rec))] };
  }
  return { pending: { ...base, action: "clip", index }, replies: [R.confirmRegen(index + 1, VE.clipLabel(rec, index), left)] };
}

// The turn after a proposal: the clip answer (number / time / room / photo),
// then "כן" / "לא". null: the message is about something else.
async function videoTurn(input, deps, draft) {
  const pv = draft.pending_video;
  const listing = await deps.getListing(pv.listing_id).catch(() => null);
  const rec = listing && listing.video;
  if (!rec) { draft.pending_video = null; return null; }
  if (pv.action === "clip" && pv.index == null) {
    const photo = (input.fileUrls && input.fileUrls[0]) || input.fileUrl || null;
    let index = null;
    if (photo && deps.roomOfPhoto) {
      const room = await deps.roomOfPhoto(photo).catch(() => null);
      index = room ? VE.pickClip(rec, { room }) : null;
    } else if (input.text) {
      index = VE.pickFromAnswer(rec, input.text);
    }
    if (index == null) {
      // A short reply or a photo is an answer we could not place: ask again. Anything else moves on.
      if (photo || String(input.text || "").trim().length <= 25) {
        return { handled: true, status: "video_clip_unclear", draft, replies: [R.whichClip(VE.clipMenu(rec))] };
      }
      draft.pending_video = null;
      return null;
    }
    const step = clipStep(rec, index, { listing_id: pv.listing_id }, deps);
    draft.pending_video = step.pending;
    return { handled: true, status: "video_clip_picked", draft, replies: step.replies };
  }
  const cmd = D.command(input.text);
  draft.pending_video = null;
  if (cmd === "no") return { handled: true, status: "video_kept", draft, replies: [R.kept()] };
  if (cmd !== "yes") return null;
  const started = deps.startVideoEdit ? await deps.startVideoEdit(pv) : { ok: false, reason: "not_configured" };
  return { handled: true, status: started.ok ? "video_edit_started" : `video_edit_refused:${started.reason}`, draft,
    replies: [started.ok ? R.videoEditStarted(pv.action) : R.videoEditRefused(started.reason)] };
}
```

In `updatePage`, right after `if (page) draft.page = { … };`, add:

```js
  const video = page ? await proposeVideoEdit(page, String(text || ""), deps) : null;
  if (video) {
    draft.pending_video = video.pending;
    return { handled: true, status: video.pending ? "video_edit_proposed" : "video_edit_limit", draft, replies: video.replies };
  }
```

In `updatingTurn`, right after the line `if (input.event) return { handled: false, status: "not_ours", replies: [] };`, add:

```js
  // A video edit waiting for its clip or its "כן" comes before the held-photos logic:
  // a photo here picks the clip, it does not go to the gallery.
  if (draft.pending_video && deps.getListing) {
    const v = await videoTurn(input, deps, draft);
    if (v) return v;
  }
```

`updatePage`'s confirmation and the pending clip menu use the same `updating` draft, so `D.isExpiredPrompt` already ends a forgotten proposal.

- [ ] **Step 3b: Add the deps in `server/routes/whatsapp.js` `depsFor`.** At the top of the file:

```js
const VE = require("../video-edit");
const { parseVideoEdit } = require("../video-edit-intent");
const { mapSpaces } = require("../space-map");
```

Add `videoEdit` to the destructured `ctx` names in `createWhatsappRouter`. In `depsFor`, add next to `updatePageData`:

```js
      // Walkthrough video edits (video-edit.js): skipped entirely when index.js gave no videoEdit.
      getListing: (id) => db.getListing(id),
      parseVideoEdit: (t, lines) => parseVideoEdit(t, { currentLines: lines }),
      // The Vision Tagger's room for a photo the agent sends to pick a clip.
      roomOfPhoto: async (url) => { const { map } = await mapSpaces([{ url }]); return (map.spaces[0] || {}).type || null; },
      sendClipSheet: videoEdit ? async (rec) => {
        const url = await VE.clipSheet(rec, videoEdit.ctx);
        await videoEdit.ctx.sendFile(phone, url, { text: "" });
      } : null,
      startVideoEdit: videoEdit ? (pending) => videoEdit.startEdit(pending) : null,
```

`videoEdit.ctx.sendFile` names the file `video.mp4`. For the sheet, call `require("../utils").sendWhatsAppFile(phone, url, "clips.jpg", "", greenInstance, greenToken)` if the router has those creds. Otherwise add `sendImage(phone, url)` to `makeCtx` (same body as `sendFile`, file name `clips.jpg`) and use that. Pick whichever the router already has (`grep -n "greenInstance\|GREENAPI" server/routes/whatsapp.js`).

- [ ] **Step 4: Run them and check that they pass, plus the full suite**

Run: `cd server && node whatsapp-flows.test.js && npm test`
Expected: `ok video edit flow`; `npm test` exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/page-update.js server/routes/whatsapp.js server/whatsapp-flows.test.js
git commit -m "feat(whatsapp): edit a property's walkthrough video from the chat"
```

---

### Task 9: n8n — silent clips, `listing_id` to the overlay, Clip Regen workflow

Deploy the server (Tasks 1–8) **first**. Every change below assumes the new endpoints exist, and the extra `listing_id` field is harmless to the old server.

**Workflows:**
- Modify: `WW1 Walkthrough V3 dev` (`KGO7oyf63EBD47pb`), then prod `WW1 Walkthrough V3` (`HScWoZXiVjXoRQLt`)
- Create: `Forly Clip Regen dev` (calls `staging.srv1173890.hstgr.cloud`), then `Forly Clip Regen` (calls `forly.srv1173890.hstgr.cloud`)

**Tooling:** n8n MCP. Use `get_workflow_details` to read, `get_sdk_reference` and `get_node_types` before writing code, `validate_workflow` before `update_workflow` / `create_workflow_from_code`. Never update prod before dev has produced a good video.

- [ ] **Step 1: Dev V3 — clips without audio.** In node `Submit Seedance`, change `"generate_audio": true` to `"generate_audio": false`. Leave everything else in the body as it is (`model: "seedance-2-0-mini"`, `resolution: "720p"`, `aspect_ratio: "9:16"`, `generation_type: "reference-to-video"`, `duration: $json.duration`). Prod also has a `reSubmit Seedance` node for retries: change it the same way there.

- [ ] **Step 2: Dev V3 — overlay gets `listing_id`.** In node `Stitch And Overlay Titles`, add `listing_id: $('Execute Trigger').first().json.listing_id` to the JSON body, next to `video_urls`, `lines`, `phone`.

- [ ] **Step 3: Run dev V3 end to end** on a real listing through `Forly — Dashboard Intake (WW1 Gateway) dev`. Check:
  - the WhatsApp group gets the video and the music plays;
  - in Firestore `listings/<id>`, `walkthrough_clips` has one entry per clip, each with `rooms`;
  - `listings/<id>.video.clips.length` equals the clip count and every `prompt` is non-empty;
  - on the staging host, `uploads/clips/<video.id>/` holds `clip0.mp4 …` and `music.audio`.

- [ ] **Step 4: Create `Forly Clip Regen dev`.** Nodes:
  1. **Webhook**: `POST /clip-regen`, Header Auth credential checking `x-forly-secret` = `N8N_WEBHOOK_SECRET`, respond immediately (200).
  2. **Submit Seedance**: copy V3's `Submit Seedance` node (same seevio credential). Body: `{ model: "seedance-2-0-mini", input: { prompt: $json.body.prompt, image_urls: $json.body.image_urls, generation_type: "reference-to-video", aspect_ratio: "9:16", resolution: "720p", duration: $json.body.duration, generate_audio: false } }`.
  3. **Poll loop**: copy V3's `Prepare Polling` → `Poll Loop` → `Wait 15 Seconds` → `Poll Seedance Status` for a single task id (drop the fan-out/aggregate nodes), up to 40 polls.
  4. **Done**: when the status is completed, extract the clip URL **with the same expression V3's `Collect Clip URLs` uses** (copy it verbatim; don't guess the response shape). Then `POST https://staging.srv1173890.hstgr.cloud/api/walkthrough/clip` with header `x-forly-secret` and body `{ listing_id, clip_index, video_url }`, taking `listing_id` and `clip_index` from the Webhook node.
  5. **Failed / timed out**: on a failed status or after the poll limit, `POST` the same URL with `{ listing_id, clip_index, failed: true }`.

- [ ] **Step 5: Point staging at it.** Set `N8N_CLIP_REGEN_WEBHOOK_URL=<the dev webhook production URL>` on the staging server and restart it.

- [ ] **Step 6: Test the whole edit loop on staging** from a test WhatsApp number, against the listing from Step 3:
  - "תעשי מחדש את המטבח בסרטון של <address>" → confirm → "כן" → within a few minutes a new video arrives and the page hero shows it; `video.regens_used` = 1.
  - "קטע בסרטון של <address> יצא לא טוב" → the menu and the numbered thumbnails arrive → reply "1" → confirm.
  - "תשני את הכותרת בסרטון של <address> ל..." → "כן" → new titles, same music.
  - "מוזיקה אחרת לסרטון של <address>" → "כן" → new music over the whole video.
  - A third clip regeneration is refused with the limit message.
  - Force a failure (send a bad `image_urls` through the webhook by hand): the agent gets the failure message and `regens_used` goes back down.

- [ ] **Step 7: Promote to prod.** Apply Steps 1–2 to `HScWoZXiVjXoRQLt` (both Seedance nodes). Create `Forly Clip Regen` with `forly.srv1173890.hstgr.cloud`. Set `N8N_CLIP_REGEN_WEBHOOK_URL` on the prod server and restart it. Watch the first prod video: the music plays and `listings/<id>.video` is written.

- [ ] **Step 8: Commit** any repo-side n8n notes the team keeps in `docs/n8n/`, if that folder documents workflows (`ls docs/n8n`). Otherwise nothing to commit.

---

## Out of scope (deliberately)

- **Switching the video model or provider (fal.ai).** That's a separate project: compare quality and price on 3–5 real listings, then swap the `Submit Seedance` nodes. This plan makes that cheaper to try, because one clip can now be regenerated on its own.
- Reordering or removing clips, and trimming. Not requested.
- Paid regenerations past the 2 free ones. The agent is told the limit and nothing more.
- Regenerating the whole video from WhatsApp. That keeps going to the page edit link, as today.
