/*
 * Video title overlay — burns property titles onto the LAST 3 seconds of a
 * walkthrough video, regardless of what the footage shows or how it moves.
 *
 * Implementation: ffmpeg + a generated ASS subtitle track (libass), which
 * handles Hebrew RTL/BiDi shaping correctly — no generative model touches
 * the text, so it can never come out as gibberish. The end titles are a
 * semi-transparent band with a white title line and a gold sub-line, fading
 * in at (duration - 3s) and holding to the end.
 *
 * Room labels (optional): when the caller passes `rooms` (the Vision-Tagger
 * room types of the photos the video was generated from) and
 * ANTHROPIC_API_KEY is set, frames are sampled from the FINISHED video and
 * classified in one Claude vision call against that closed label list —
 * Seedance doesn't guarantee shot order/timing, so we look at what actually
 * rendered. The same call returns a short 1–2 word Hebrew descriptor per
 * frame ("מרווח ומואר"). Per-frame labels are smoothed into segments and
 * burned bottom-right (room name + descriptor beneath it, white text with a
 * black outline) over a vertical cream→transparent gradient composited by
 * ffmpeg. Room labels stop before the end-title window so the closing shot
 * stays clean. Vision failure is non-fatal: the video ships with titles only.
 *
 * Requires ffmpeg + ffprobe with libass on PATH (see Dockerfile), and a
 * Hebrew-capable font (Noto Sans Hebrew / DejaVu Sans).
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFile } = require("child_process");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const OVERLAY_SECONDS = 3;
const MAX_LINES = 3;
const MAX_LINE_CHARS = 60;
const MAX_ROOMS = 12;
const VISION_MODEL = process.env.OVERLAY_VISION_MODEL || "claude-haiku-4-5-20251001";

// Cream (#F7F3EC) matches the landing-page theme; the room label sits on a
// vertical gradient that fades from transparent (top) to this cream (bottom).
const CREAM_RGB = [0xF7, 0xF3, 0xEC];
const GRADIENT_HEIGHT_FRAC = 0.22; // band height as a fraction of video height
const GRADIENT_PEAK_ALPHA = 242; // ~95% opaque at the very bottom

const bandHeight = (videoHeight) => Math.round(videoHeight * GRADIENT_HEIGHT_FRAC);

// ── minimal RGBA PNG encoder (no deps) ──
// A vertical cream gradient is built in-process and handed to ffmpeg as a
// normal image input, so the filtergraph only needs `overlay` + `ass` — no
// geq/lavfi tricks that vary across ffmpeg builds.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
// Solid `rgb` fading from alpha 0 at the top to `peakAlpha` at the bottom.
function gradientPng(width, height, rgb, peakAlpha) {
  const [r, g, b] = rgb;
  const rowLen = 1 + width * 4; // 1 filter byte + RGBA per pixel
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    const a = Math.round(peakAlpha * Math.pow(height > 1 ? y / (height - 1) : 1, 1.2));
    let off = y * rowLen;
    raw[off++] = 0; // row filter: none
    for (let x = 0; x < width; x++) {
      raw[off++] = r; raw[off++] = g; raw[off++] = b; raw[off++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // bytes 10-12 (compression, filter, interlace) stay 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Vision-Tagger room types → Hebrew display labels. Unknown types (or values
// that are already Hebrew) pass through as-is.
const ROOM_HE = {
  living_room: "סלון", livingroom: "סלון", salon: "סלון", lounge: "סלון",
  open_plan_living_dining_kitchen: "חלל פתוח", open_plan: "חלל פתוח",
  living_dining_kitchen: "חלל פתוח", living_dining: "סלון ופינת אוכל",
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

// Most frequent value in an array (first-seen wins ties); null if empty.
function modeOf(arr) {
  const counts = new Map();
  let best = null, bestN = 0;
  for (const v of arr) {
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > bestN) { bestN = n; best = v; }
  }
  return best;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Surface the tail of stderr (where ffmpeg/ffprobe print the real
        // reason) rather than the giant command echo execFile prepends.
        const tail = String(stderr).trim().split("\n").slice(-6).join(" | ").slice(-500);
        reject(new Error(`${path.basename(cmd)} failed (code ${err.code ?? err.signal ?? "?"}): ${tail}`));
      } else {
        resolve(String(stdout));
      }
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
  const roomNameSize = Math.round(height * 0.040);
  const roomDescSize = Math.round(height * 0.028);
  const roomOutline = Math.max(2, Math.round(height * 0.003));
  const roomMarginR = Math.round(width * 0.045);
  const roomMarginV = Math.round(height * 0.030);
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
    // Room label: bottom-right (Alignment 3), outline style (BorderStyle 1) —
    // white fill, black outline — because the cream band is drawn by ffmpeg,
    // not by an ASS box. MarginR/V lift it off the corner.
    `Style: Room,${fonts},${roomNameSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${roomOutline},0,3,0,${roomMarginR},${roomMarginV},1`,
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
  const roomEvents = roomSegments.map((s) => {
    const name = sanitizeAss(s.label);
    // Descriptor stacks under the name (smaller) via an inline \fs override.
    const body = s.desc
      ? `${name}\\N{\\fs${roomDescSize}}${sanitizeAss(s.desc)}`
      : name;
    return `Dialogue: 0,${assTime(s.start)},${assTime(s.end)},Room,,0,0,0,,{\\fad(150,150)}${body}`;
  });
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
// Returns one {label, desc} per frame; label outside the list → null.
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
      `Allowed room labels:\n${allowed.map((l) => `- ${l}`).join("\n")}\n` +
      `For each frame return an object {"label": ..., "desc": ...}:\n` +
      `- label: the allowed label matching the room/space shown, or null for a ` +
      `transition/blend between rooms or a frame matching no label.\n` +
      `- desc: a SHORT 1-2 word Hebrew descriptor of a notable, clearly VISIBLE ` +
      `quality of that space (e.g. "מרווח ומואר", "מטבח מודרני", "נוף פתוח"), or ` +
      `null if nothing notable is visible. Keep it factual — describe only what ` +
      `the frame shows.\n` +
      `Reply with ONLY a JSON array of exactly ${frames.length} objects, where ` +
      `entry i corresponds to frame i.`,
  });
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: VISION_MODEL, max_tokens: 1500, temperature: 0, messages: [{ role: "user", content }] }),
    signal: AbortSignal.timeout(90000),
  });
  if (!resp.ok) throw new Error(`vision api ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("vision reply had no JSON array");
  const arr = JSON.parse(m[0]);
  const set = new Set(allowed);
  return frames.map((_, i) => {
    const e = arr[i];
    if (e && typeof e === "object") {
      return {
        label: set.has(e.label) ? e.label : null,
        desc: typeof e.desc === "string" && e.desc.trim() ? e.desc.trim().slice(0, 40) : null,
      };
    }
    // Tolerate a model that returned a bare label string instead of an object.
    return { label: set.has(e) ? e : null, desc: null };
  });
}

// Sample ~2 fps (8–24 frames), downscaled to 384px height to keep vision
// tokens cheap, classify, smooth into segments, and attach a descriptor.
// Segments are clipped to end before the title window so the closing shot
// stays clean.
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
  const items = await classifyFrames(frames, allowed, process.env.ANTHROPIC_API_KEY);
  const times = frames.map((f) => f.t);
  const segs = labelsToSegments(items.map((x) => x.label), times, info.duration);
  const cutoff = Math.max(0, info.duration - OVERLAY_SECONDS);
  return segs
    .map((s) => ({ ...s, end: Math.min(s.end, cutoff) }))
    .filter((s) => s.end - s.start >= 0.5) // too short after clipping → drop
    .map((s) => {
      const descs = frames
        .map((f, i) => ({ t: f.t, desc: items[i].desc }))
        .filter((x) => x.t >= s.start && x.t <= s.end && x.desc)
        .map((x) => x.desc);
      return { ...s, desc: modeOf(descs) };
    });
}

async function download(url, dest) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!resp.ok) throw new Error(`fetch video ${resp.status}`);
  fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
}

// Build the ffmpeg args. With room segments we overlay a pre-rendered cream
// gradient PNG (enabled only while a room label shows) and burn the ASS track
// over it; without, a plain ASS pass. execFile passes args verbatim (no
// shell), so commas inside the enable expression are escaped with \, for
// ffmpeg's filtergraph parser.
function buildFfmpegArgs(inFile, assFile, outFile, info, roomSegments, gradFile) {
  if (!roomSegments.length) {
    return [
      "-y", "-i", inFile,
      "-vf", `ass=${assFile}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "copy",
      "-movflags", "+faststart",
      outFile,
    ];
  }
  const y = info.height - bandHeight(info.height);
  const enable = roomSegments
    .map((s) => `between(t\\,${s.start.toFixed(2)}\\,${s.end.toFixed(2)})`)
    .join("+");
  const filter =
    `[0:v][1:v]overlay=x=0:y=${y}:enable=${enable}[bg];` +
    `[bg]format=yuv420p,ass=${assFile}[v]`;
  return [
    "-y", "-i", inFile,
    "-i", gradFile,
    "-filter_complex", filter,
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outFile,
  ];
}

/**
 * Overlay `lines` on the last 3 seconds of the video at `videoUrl`, and —
 * when `rooms` is provided and ANTHROPIC_API_KEY is set — vision-detected
 * room-name labels (with a short descriptor, over a cream gradient) on the
 * segments where each room is on screen.
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
    // room_debug surfaces WHY labels are/aren't present, right in the API
    // response (visible in the n8n execution) instead of only in server logs.
    let roomDebug = "no_rooms_requested";
    if (Array.isArray(rooms) && rooms.length) {
      if (!process.env.ANTHROPIC_API_KEY) {
        roomDebug = "no_api_key";
        console.warn("video-overlay: rooms given but ANTHROPIC_API_KEY unset; skipping room labels");
      } else {
        // Room labels are best-effort — a vision failure must not sink the video.
        try {
          roomSegments = await detectRoomSegments(inFile, tmp, info, rooms.slice(0, MAX_ROOMS));
          roomDebug = roomSegments.length ? "ok" : "no_segments_detected";
        } catch (err) {
          roomDebug = "error: " + err.message.slice(0, 200);
          console.warn("video-overlay: room detection failed, continuing without:", err.message);
        }
      }
    }
    fs.writeFileSync(assFile, buildAss(info, lines, roomSegments), "utf8");
    let gradFile = null;
    if (roomSegments.length) {
      gradFile = path.join(tmp, "grad.png");
      fs.writeFileSync(gradFile, gradientPng(info.width, bandHeight(info.height), CREAM_RGB, GRADIENT_PEAK_ALPHA));
    }
    await run(FFMPEG, buildFfmpegArgs(inFile, assFile, outFile, info, roomSegments, gradFile), 240000);
    const rel = `overlays/${crypto.randomUUID()}.mp4`;
    const finalPath = path.join(uploadDir, rel);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.copyFileSync(outFile, finalPath);
    return { video_url: `${baseUrl}/files/${rel}`, duration: info.duration, room_segments: roomSegments, room_debug: roomDebug };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = {
  overlayVideo, MAX_LINES, MAX_LINE_CHARS, MAX_ROOMS,
  _test: { buildAss, buildFfmpegArgs, labelsToSegments, roomLabel, sanitizeAss, assTime, modeOf, gradientPng, bandHeight },
};
