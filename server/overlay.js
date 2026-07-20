/*
 * Video title overlay — burns property titles onto the LAST 3 seconds of a
 * walkthrough video, regardless of what the footage shows or how it moves.
 *
 * Implementation: ffmpeg + a generated ASS subtitle track (libass), which
 * handles Hebrew RTL/BiDi shaping correctly — no generative model touches
 * the text, so it can never come out as gibberish. The overlay is a
 * semi-transparent band with a white title line and a gold sub-line,
 * fading in at (duration - 3s) and holding to the end.
 *
 * Room labels (optional): when the caller passes `rooms` (the Vision-Tagger
 * room types of the photos the video was generated from) and
 * ANTHROPIC_API_KEY is set, frames are sampled from the FINISHED video and
 * classified in one Claude vision call against that closed label list —
 * Seedance doesn't guarantee shot order/timing, so we look at what actually
 * rendered. The per-frame labels are smoothed into segments and burned as a
 * top-center pill in the same ffmpeg pass as the titles. Vision failure is
 * non-fatal: the video still ships with titles only.
 *
 * Requires ffmpeg + ffprobe with libass on PATH (see Dockerfile), and a
 * Hebrew-capable font (Noto Sans Hebrew / DejaVu Sans).
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const OVERLAY_SECONDS = 3;
const MAX_LINES = 3;
const MAX_LINE_CHARS = 60;
const MAX_ROOMS = 12;
const VISION_MODEL = process.env.OVERLAY_VISION_MODEL || "claude-haiku-4-5-20251001";

// Vision-Tagger room types → Hebrew display labels. Unknown types (or values
// that are already Hebrew) pass through as-is.
const ROOM_HE = {
  living_room: "סלון", livingroom: "סלון", salon: "סלון", lounge: "סלון",
  kitchen: "מטבח", kitchenette: "מטבחון",
  bedroom: "חדר שינה", master_bedroom: "חדר שינה ראשי",
  kids_room: "חדר ילדים", children_room: "חדר ילדים", nursery: "חדר ילדים",
  bathroom: "חדר רחצה", toilet: "שירותים", shower: "מקלחת",
  balcony: "מרפסת", terrace: "מרפסת", sun_balcony: "מרפסת שמש",
  dining_room: "פינת אוכל", dining_area: "פינת אוכל",
  office: "חדר עבודה", study: "חדר עבודה",
  entrance: "כניסה", entry: "כניסה", hallway: "מסדרון", corridor: "מסדרון",
  mamad: "ממ״ד", safe_room: "ממ״ד",
  garden: "גינה", yard: "חצר",
  roof: "גג", rooftop: "גג",
  parking: "חניה", storage: "מחסן", laundry: "חדר כביסה",
  building: "הבניין", exterior: "חזית הבניין", facade: "חזית הבניין",
  view: "נוף", lobby: "לובי", pool: "בריכה", gym: "חדר כושר",
};

function roomLabel(r) {
  const raw = typeof r === "string" ? r : (r && (r.room_type || r.label)) || "";
  const s = String(raw).trim();
  if (!s) return "";
  return ROOM_HE[s.toLowerCase().replace(/[\s-]+/g, "_")] || s.slice(0, 30);
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${err.message}\n${String(stderr).slice(-800)}`));
      else resolve(String(stdout));
    });
  });
}

async function probe(file) {
  const out = await run(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json", file,
  ], 30000);
  const j = JSON.parse(out);
  const s = (j.streams && j.streams[0]) || {};
  const duration = Number(j.format && j.format.duration);
  if (!s.width || !s.height || !isFinite(duration) || duration <= 0) {
    throw new Error("could not probe video dimensions/duration");
  }
  return { width: s.width, height: s.height, duration };
}

// ASS timestamps are h:mm:ss.cc (centiseconds)
function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const whole = Math.floor(rem);
  const cs = Math.floor((rem - whole) * 100);
  const p = (n) => String(n).padStart(2, "0");
  return `${h}:${p(m)}:${p(whole)}.${p(cs)}`;
}

// ASS text field: strip control chars and the {}\ specials libass interprets.
// Lines containing Hebrew get an RLM (U+200F) prefix to force RTL paragraph
// direction — otherwise lines starting with ₪/digits get mis-ordered by BiDi.
function sanitizeAss(text) {
  const clean = String(text).replace(/[{}\\\r\n\t]/g, " ").trim().slice(0, MAX_LINE_CHARS);
  return /[֐-׿]/.test(clean) ? "‏" + clean : clean;
}

function buildAss({ width, height, duration }, lines, roomSegments = []) {
  const start = assTime(Math.max(0, duration - OVERLAY_SECONDS));
  const end = assTime(duration + 1); // past EOF is fine; clamps to last frame
  // Font sizes/margins scale with video height so 720p and 1080p both look right.
  const titleSize = Math.round(height * 0.045);
  const subSize = Math.round(height * 0.034);
  const titleMarginV = Math.round(height * 0.16);
  const subMarginV = Math.round(height * 0.105);
  const roomSize = Math.round(height * 0.032);
  const roomMarginV = Math.round(height * 0.05);
  const fonts = "Noto Sans Hebrew";
  // Colors are &HAABBGGRR. BackColour 78000000 = ~47% black band (BorderStyle 3).
  // Gold #B98A2F -> BGR 2F8AB9.
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Title,${fonts},${titleSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,3,${Math.round(titleSize * 0.28)},0,2,40,40,${titleMarginV},1`,
    `Style: Sub,${fonts},${subSize},&H002F8AB9,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,3,${Math.round(subSize * 0.28)},0,2,40,40,${subMarginV},1`,
    // Room pill: top-center (Alignment 8), same translucent band treatment.
    `Style: Room,${fonts},${roomSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,3,${Math.round(roomSize * 0.34)},0,8,40,40,${roomMarginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = lines.slice(0, MAX_LINES).map((line, i) => {
    const style = i === 0 ? "Title" : "Sub";
    // Stack extra sub-lines below each other by shrinking MarginV per line.
    const marginOverride = i <= 1 ? 0 : Math.max(20, subMarginV - (i - 1) * Math.round(subSize * 1.5));
    return `Dialogue: 0,${start},${end},${style},,0,0,${marginOverride},,{\\fad(300,0)}${sanitizeAss(line)}`;
  });
  const roomEvents = roomSegments.map((s) =>
    `Dialogue: 0,${assTime(s.start)},${assTime(s.end)},Room,,0,0,0,,{\\fad(150,150)}${sanitizeAss(s.label)}`);
  return header.concat(events, roomEvents).join("\n") + "\n";
}

// Collapse per-frame labels into display segments. A lone mislabeled/null
// frame between two identical neighbors is treated as its neighbors; runs
// shorter than MIN_RUN samples (~1s at 2 fps — Seedance shots run ~1s each)
// are dropped as noise. Segment edges land midway between samples.
function labelsToSegments(labels, times, duration) {
  const MIN_RUN = 2;
  const filled = labels.slice();
  for (let i = 1; i + 1 < filled.length; i++) {
    if (filled[i] !== filled[i - 1] && filled[i - 1] && filled[i - 1] === filled[i + 1]) {
      filled[i] = filled[i - 1];
    }
  }
  const segs = [];
  let runStart = 0;
  for (let i = 1; i <= filled.length; i++) {
    if (i === filled.length || filled[i] !== filled[runStart]) {
      const label = filled[runStart];
      if (label && i - runStart >= MIN_RUN) {
        segs.push({
          label,
          start: runStart === 0 ? 0 : (times[runStart - 1] + times[runStart]) / 2,
          end: i === filled.length ? duration : (times[i - 1] + times[i]) / 2,
        });
      }
      runStart = i;
    }
  }
  return segs;
}

// One Claude vision call: all sampled frames in order, closed label list.
// Returns one label (or null) per frame; anything outside the list → null.
async function classifyFrames(frames, allowed, apiKey) {
  const content = [];
  frames.forEach((f, i) => {
    content.push({ type: "text", text: `Frame ${i} (t≈${f.t.toFixed(1)}s):` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(f.file).toString("base64") },
    });
  });
  content.push({
    type: "text",
    text:
      `These ${frames.length} frames are sampled in order from one real-estate walkthrough video.\n` +
      `Allowed labels:\n${allowed.map((l) => `- ${l}`).join("\n")}\n` +
      `For each frame pick the allowed label that matches the room/space shown, ` +
      `or null if the frame is a transition/blend between rooms or clearly matches no label. ` +
      `Reply with ONLY a JSON array of exactly ${frames.length} entries (strings or null), ` +
      `where entry i is the label for frame i.`,
  });
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: VISION_MODEL, max_tokens: 1000, temperature: 0, messages: [{ role: "user", content }] }),
    signal: AbortSignal.timeout(90000),
  });
  if (!resp.ok) throw new Error(`vision api ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("vision reply had no JSON array");
  const arr = JSON.parse(m[0]);
  const set = new Set(allowed);
  return frames.map((_, i) => (set.has(arr[i]) ? arr[i] : null));
}

// Sample ~2 fps (8–24 frames), downscaled to 384px height to keep vision
// tokens cheap, classify, and smooth into segments.
async function detectRoomSegments(inFile, tmp, info, rooms) {
  const allowed = [...new Set(rooms.map(roomLabel).filter(Boolean))];
  if (!allowed.length) return [];
  const framesDir = path.join(tmp, "frames");
  fs.mkdirSync(framesDir);
  const count = Math.min(24, Math.max(8, Math.round(info.duration * 2)));
  await run(FFMPEG, [
    "-y", "-i", inFile,
    "-vf", `fps=${count / info.duration},scale=-2:384`,
    "-q:v", "5",
    path.join(framesDir, "f_%03d.jpg"),
  ], 60000);
  const files = fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).sort();
  const frames = files.map((f, i) => ({
    file: path.join(framesDir, f),
    t: ((i + 0.5) * info.duration) / files.length,
  }));
  if (!frames.length) return [];
  const labels = await classifyFrames(frames, allowed, process.env.ANTHROPIC_API_KEY);
  return labelsToSegments(labels, frames.map((f) => f.t), info.duration);
}

async function download(url, dest) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!resp.ok) throw new Error(`fetch video ${resp.status}`);
  fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
}

/**
 * Overlay `lines` on the last 3 seconds of the video at `videoUrl`, and —
 * when `rooms` is provided and ANTHROPIC_API_KEY is set — vision-detected
 * room-name pills on the segments where each room is on screen.
 * Writes the result under `uploadDir`/overlays and returns its public URL.
 */
async function overlayVideo({ videoUrl, lines, rooms, uploadDir, baseUrl }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-"));
  try {
    const inFile = path.join(tmp, "in.mp4");
    const assFile = path.join(tmp, "titles.ass");
    const outFile = path.join(tmp, "out.mp4");
    await download(videoUrl, inFile);
    const info = await probe(inFile);
    let roomSegments = [];
    if (Array.isArray(rooms) && rooms.length) {
      if (!process.env.ANTHROPIC_API_KEY) {
        console.warn("video-overlay: rooms given but ANTHROPIC_API_KEY unset; skipping room labels");
      } else {
        // Room labels are best-effort — a vision failure must not sink the video.
        try {
          roomSegments = await detectRoomSegments(inFile, tmp, info, rooms.slice(0, MAX_ROOMS));
        } catch (err) {
          console.warn("video-overlay: room detection failed, continuing without:", err.message);
        }
      }
    }
    fs.writeFileSync(assFile, buildAss(info, lines, roomSegments), "utf8");
    await run(FFMPEG, [
      "-y", "-i", inFile,
      "-vf", `ass=${assFile}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "copy",
      "-movflags", "+faststart",
      outFile,
    ], 240000);
    const rel = `overlays/${crypto.randomUUID()}.mp4`;
    const finalPath = path.join(uploadDir, rel);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.copyFileSync(outFile, finalPath);
    return { video_url: `${baseUrl}/files/${rel}`, duration: info.duration, room_segments: roomSegments };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = {
  overlayVideo, MAX_LINES, MAX_LINE_CHARS, MAX_ROOMS,
  _test: { buildAss, labelsToSegments, roomLabel, sanitizeAss, assTime },
};
