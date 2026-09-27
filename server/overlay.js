/*
 * Video stitch + title overlay — joins the Seedance clips a walkthrough was
 * generated from and burns property titles onto the LAST 3 seconds of the
 * result, regardless of what the footage shows or how it moves.
 *
 * Seedance caps a single generation at 15s, so anything longer arrives as
 * several clips. `videoUrls` (ordered) are crossfaded together with `xfade`
 * inside the SAME filtergraph that burns the titles, so the whole thing costs
 * one encode rather than concat-then-overlay. A single clip still takes the
 * original fast path. Stitched duration is `sum(durations) - (n-1) * 0.5`.
 *
 * Audio: clips are generated silent (generate_audio: false) and one music bed
 * is laid over the whole finished video — generated per video on fal.ai at the
 * stitched length (FAL_KEY + MUSIC_MODEL), with a static track and then plain
 * silence as fallbacks. Per-clip audio is deliberately NOT carried across a
 * join, because independent AI-generated soundtracks butted together sound
 * worse than nothing.
 *
 * Implementation: ffmpeg + a generated ASS subtitle track (libass), which
 * handles Hebrew RTL/BiDi shaping correctly — no generative model touches
 * the text, so it can never come out as gibberish. The end titles are a
 * semi-transparent band with a white title line and a gold sub-line, fading
 * in at (duration - 3s) and holding to the end.
 *
 * Room labels (optional): when the caller passes `rooms` (the Vision-Tagger
 * room types of the photos the video was generated from) and
 * ANTHROPIC_API_KEY is set, frames are sampled from the SOURCE clips (with
 * their timestamps mapped onto the stitched timeline, so no extra encode is
 * needed) and classified in one Claude vision call against that label list —
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
const { roomLabel, UNLABELLED_ROOMS } = require("./rooms");
const { assertPublicHttpUrl } = require("./utils");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const OVERLAY_SECONDS = 3;
// Heebo (OFL) for the end titles; handed to libass via fontsdir so the image
// needs no extra apk font package.
const FONTS_DIR = path.join(__dirname, "assets", "fonts");
const MAX_LINES = 3;
const MAX_LINE_CHARS = 60;
const MAX_ROOMS = 12;
const VISION_MODEL = process.env.OVERLAY_VISION_MODEL || "claude-haiku-4-5-20251001";

// Stitching. XFADE_SECONDS is spent twice — once at the tail of the outgoing
// clip and once at the head of the incoming one — so each join shortens the
// total by exactly that much.
const XFADE_SECONDS = 0.5;
const MAX_CLIPS = 4;

// Music bed laid over the finished video. Resolved in this order:
//   1. an explicit `musicUrl` from the caller
//   2. generated on fal.ai when FAL_KEY is set (the normal path)
//   3. a static fallback track at MUSIC_PATH, if one is present
//   4. nothing — the video ships silent
// The bed is requested at the stitched length, which is only known after the
// clips are probed, so generation happens here rather than upstream in n8n.
const MUSIC_PATH = process.env.OVERLAY_MUSIC_PATH ||
  path.join(__dirname, "assets", "music", "default.m4a");
const MUSIC_FADE_SECONDS = 2;
// Model id is case-sensitive in the URL path — "CassetteAI", not "cassetteai".
const MUSIC_MODEL = process.env.OVERLAY_MUSIC_MODEL || "CassetteAI/music-generator";
const MUSIC_PROMPT = process.env.OVERLAY_MUSIC_PROMPT ||
  "Cinematic ambient background music for a luxury real estate tour. Warm minimal " +
  "piano with soft sustained strings and a gentle low pulse. Elegant, calm, " +
  "understated and uplifting. No drums, no vocals. Key: C Major, Tempo: 80 BPM.";
// fal documents this model on the queue endpoint only, so submit → poll →
// fetch rather than a single blocking call. CassetteAI renders 30s of audio in
// a couple of seconds, so this usually settles on the first or second poll.
const MUSIC_QUEUE_BASE = process.env.OVERLAY_MUSIC_QUEUE_BASE || "https://queue.fal.run";
const MUSIC_POLL_MS = 1000;
const MUSIC_TIMEOUT_MS = 120000;

// Vision sampling. ~1.5 frames/sec keeps a 30s video inside one Claude call
// while still resolving the ~2.5s each room is on screen.
const SAMPLES_PER_SECOND = 1.5;
const MAX_VISION_FRAMES = 48;

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

// "30/1" / "24000/1001" → 30 / 23.976. Falls back to 30 for the odd stream
// that reports 0/0, which only matters as an xfade normalization target.
function parseFps(r) {
  const m = String(r || "").match(/^(\d+)\/(\d+)$/);
  if (!m) return 30;
  const fps = Number(m[1]) / Number(m[2]);
  return isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : 30;
}

async function probe(file) {
  const out = await run(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate:format=duration",
    "-of", "json", file,
  ], 30000);
  const j = JSON.parse(out);
  const s = (j.streams && j.streams[0]) || {};
  const duration = Number(j.format && j.format.duration);
  if (!s.width || !s.height || !isFinite(duration) || duration <= 0) {
    throw new Error("could not probe video dimensions/duration");
  }
  return { width: s.width, height: s.height, duration, fps: parseFps(s.r_frame_rate) };
}

// Where each clip starts on the stitched timeline, and how long the result is.
// Clip k begins where the previous one starts its crossfade, so every join
// costs XFADE_SECONDS of total running time.
function stitchTimeline(durations) {
  let offset = 0;
  const offsets = durations.map((d, i) => {
    if (i === 0) return 0;
    offset += durations[i - 1] - XFADE_SECONDS;
    return offset;
  });
  const duration = durations.reduce((a, b) => a + b, 0) - XFADE_SECONDS * (durations.length - 1);
  return { offsets, duration };
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
function sanitizeAss(text, max = MAX_LINE_CHARS) {
  const clean = String(text).replace(/[{}\\\r\n\t]/g, " ").trim().slice(0, max);
  return /[֐-׿]/.test(clean) ? "‏" + clean : clean;
}

// Tapered brush stroke w px wide as ASS drawing commands (\p1): both edges
// meet at the ends; the top bows up and the bottom sags, so it is ~1.1*h
// thick in the middle and arcs like a brush swipe.
function swooshPath(w, h = 7) {
  const r = (n) => Math.round(n);
  return `m 0 ${h} b ${r(w * 0.3)} ${r(-h * 0.6)} ${r(w * 0.7)} ${r(-h * 0.6)} ${w} ${h} ` +
    `b ${r(w * 0.7)} ${r(h * 0.9)} ${r(w * 0.3)} ${r(h * 0.9)} 0 ${h}`;
}

// Rendered width in px of `text` at ASS font size `size` in Heebo. libass sizes
// by line height (ascent+descent = 1.469em for Heebo), so 1em = size/1.469.
// Advances measured from the font; wide letters rounded up so rows never
// overflow. Titles are wrapped by us, not libass, so we know where each row
// lands and can stack title, swoosh and details without overlap.
const HEEBO_EM_PER_SIZE = 1 / 1.469;
function charEm(c) {
  if (c === " ") return 0.25;
  if (/[֐-׿]/.test(c)) return /[שמםטצץ]/.test(c) ? 0.85 : 0.6;
  if (/[0-9]/.test(c)) return 0.58;
  if (/[A-Za-z]/.test(c)) return /[MWmw]/.test(c) ? 0.88 : 0.6;
  return 0.45;
}
function textWidth(text, size) {
  let em = 0;
  for (const c of String(text)) em += charEm(c);
  return em * size * HEEBO_EM_PER_SIZE;
}
// Wrap into rows no wider than maxW, breaking at " | " separators first (so
// "שיכון ותיקים" stays whole) and inside a segment only when it alone is too
// wide. A break drops the separator. A single word wider than maxW gets its
// own row (the caller shrinks the font until it fits).
function wrapWords(text, size, maxW) {
  const rows = [];
  let row = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = row ? `${row} ${word}` : word;
    if (row && textWidth(next, size) > maxW) { rows.push(row); row = word; } else row = next;
  }
  if (row) rows.push(row);
  return rows;
}
function wrapText(text, size, maxW) {
  const rows = [];
  let row = "";
  for (const seg of String(text).split(/\s*\|\s*/).filter(Boolean)) {
    const next = row ? `${row} | ${seg}` : seg;
    if (textWidth(next, size) <= maxW) { row = next; continue; }
    if (row) rows.push(row);
    if (textWidth(seg, size) <= maxW) { row = seg; continue; }
    const parts = wrapWords(seg, size, maxW);
    row = parts.pop();
    rows.push(...parts);
  }
  if (row) rows.push(row);
  return rows;
}

// Fit a line into at most `maxRows` rows, shrinking the font (down to 60%)
// rather than cutting any text.
function fitLine(text, size, maxW, maxRows = 2) {
  let sz = size;
  let rows = wrapText(text, sz, maxW);
  while ((rows.length > maxRows || rows.some((r) => textWidth(r, sz) > maxW)) && sz > size * 0.6) {
    sz = Math.max(Math.round(size * 0.6), Math.floor(sz * 0.92));
    rows = wrapText(text, sz, maxW);
    if (sz === Math.round(size * 0.6)) break;
  }
  return { rows, size: sz };
}

function buildAss({ width, height, duration }, lines, roomSegments = [], endStyle = "dark") {
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
  const fonts = "Noto Sans Hebrew"; // room labels keep Noto
  // Colors are &HAABBGGRR. End titles: brown #3B2314 on light closing frames,
  // cream #F7F3EC with a soft shadow on dark ones; gold #C9A45C swoosh.
  const light = endStyle === "light";
  const text = light ? "&H0014233B" : "&H00ECF3F7";
  // Dark frames: thin translucent outline + blur = soft shadow; light: flat.
  const outline = light ? 0 : Math.max(2, Math.round(titleSize * 0.06));
  const shadow = light ? 0 : 2;
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
    `Style: Title,Heebo ExtraBold,${titleSize},${text},${text},&H90000000,&HA0000000,0,0,0,0,100,100,0,0,1,${outline},${shadow},2,40,40,${titleMarginV},1`,
    `Style: Sub,Heebo SemiBold,${subSize},${text},${text},&H90000000,&HA0000000,0,0,0,0,100,100,0,0,1,${outline},${shadow},2,40,40,${subMarginV},1`,
    "Style: Swoosh,Heebo SemiBold,10,&H005CA4C9,&H005CA4C9,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    // Room label: bottom-right (Alignment 3), outline style (BorderStyle 1) —
    // white fill, black outline — because the cream band is drawn by ffmpeg,
    // not by an ASS box. MarginR/V lift it off the corner.
    `Style: Room,${fonts},${roomNameSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${roomOutline},0,3,0,${roomMarginR},${roomMarginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const blur = light ? "" : "\\blur6";
  // Lay the end titles out bottom-up with explicit positions: details rows
  // (each input line wraps to <=2 rows), then the swoosh, then the title rows.
  const maxW = width * 0.86;
  const cx = Math.round(width / 2);
  const fitted = lines.slice(0, MAX_LINES).map((line, i) =>
    fitLine(sanitizeAss(line, 200).replace(/^‏/, ""), i === 0 ? titleSize : subSize, maxW));
  const rowEvent = (style, y, sz, base, row) => {
    const fs = sz !== base ? `\\fs${sz}` : "";
    return `Dialogue: 0,${start},${end},${style},,0,0,0,,{\\fad(300,0)\\an2\\pos(${cx},${y})${fs}${blur}}${sanitizeAss(row, 200)}`;
  };
  const subEvents = [];
  let y = height - Math.round(height * 0.054);
  for (let i = fitted.length - 1; i >= 1; i--) {
    const { rows, size } = fitted[i];
    for (let r = rows.length - 1; r >= 0; r--) {
      subEvents.unshift(rowEvent("Sub", y, size, subSize, rows[r]));
      y -= Math.round(size * 1.5);
    }
  }
  const events = [];
  if (fitted.length) {
    const { rows, size } = fitted[0];
    // Title bottom sits a swoosh-height above the top details row.
    let ty = fitted.length > 1 ? y + Math.round(subSize * 1.5) - Math.round(subSize * 1.6) : y;
    const titleEvents = [];
    const swooshY = ty + 6;
    for (let r = rows.length - 1; r >= 0; r--) {
      titleEvents.unshift(rowEvent("Title", ty, size, titleSize, rows[r]));
      ty -= Math.round(size * 1.2);
    }
    events.push(...titleEvents);
    // Swoosh: 85% of the widest title row.
    const w = Math.round(Math.min(maxW, Math.max(...rows.map((r) => textWidth(r, size)))) * 0.85);
    const x = Math.round((width - w) / 2);
    const path = swooshPath(w, Math.max(4, Math.round(height * 0.0055)));
    events.push(...subEvents);
    events.push(`Dialogue: 0,${start},${end},Swoosh,,0,0,0,,{\\fad(300,0)\\an7\\pos(${x},${swooshY})\\1c&H5CA4C9&\\p1}${path}`);
  }
  // The title window never carries a room name, whatever the caller passes.
  const cutoff = Math.max(0, duration - OVERLAY_SECONDS);
  const roomEvents = roomSegments
    .map((s) => ({ ...s, end: Math.min(s.end, cutoff) }))
    .filter((s) => s.end - s.start >= 0.5)
    .map((s) => {
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
// shorter than MIN_RUN samples are dropped as noise. UNLABELLED_ROOMS runs
// still count as runs (so they don't bleed into neighbours) but emit nothing.
//
// Segment edges sit ON the confirming samples, not midway between them. The
// midpoint is a guess at where the cut fell and lands early half the time,
// which shows the label before its room arrives — far more noticeable than
// the reverse. Anchoring to a frame the room was verifiably on screen means
// a label can only ever trail the cut, by at most one sampling interval.
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
      if (label && !UNLABELLED_ROOMS.has(label) && i - runStart >= MIN_RUN) {
        segs.push({
          label,
          // First frame that actually showed this room (or 0 — the opening
          // shot is on screen from the very start).
          start: runStart === 0 ? 0 : times[runStart],
          // Last frame that still showed it, so the label does not bleed
          // into the room that follows.
          end: i === filled.length ? duration : times[i - 1],
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
      `- label: the allowed label matching the room/space shown, or null.\n` +
      `  Return null whenever the frame is mid-transition — a dissolve, a blend, ` +
      `or two spaces visible at once — even if you can tell which room is ` +
      `emerging. Do NOT guess the incoming room: a frame that is only partly ` +
      `the new room is not yet that room. Also return null for a frame ` +
      `matching no label.\n` +
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
    body: JSON.stringify({ model: VISION_MODEL, max_tokens: 3000, temperature: 0, messages: [{ role: "user", content }] }),
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

// Frames are sampled from the SOURCE clips, but during a crossfade the output
// shows both clips at once — a frame taken 0.1s into clip N is already fully
// its opening room while the stitched picture is still mostly clip N-1. A
// label starting in that window is therefore guaranteed to lead the picture,
// so hold it until the join finishes.
function afterJoin(t, clips) {
  for (let i = 1; i < clips.length; i++) {
    const joinStart = clips[i].offset;
    if (t >= joinStart && t < joinStart + XFADE_SECONDS) return joinStart + XFADE_SECONDS;
  }
  return t;
}

// Sample one clip at `count` frames, downscaled to 384px height to keep vision
// tokens cheap. Returned timestamps are already shifted onto the stitched
// timeline by `offset`, so callers never deal with per-clip time.
async function sampleClipFrames(file, framesDir, prefix, duration, count, offset) {
  await run(FFMPEG, [
    "-y", "-i", file,
    "-vf", `fps=${count / duration},scale=-2:384`,
    "-q:v", "5",
    path.join(framesDir, `${prefix}_%03d.jpg`),
  ], 60000);
  const files = fs.readdirSync(framesDir)
    .filter((f) => f.startsWith(`${prefix}_`) && f.endsWith(".jpg")).sort();
  return files.map((f, i) => ({
    file: path.join(framesDir, f),
    t: offset + ((i + 0.5) * duration) / files.length,
  }));
}

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

// Sample every clip, classify the lot in one call, smooth into segments, and
// attach a descriptor. Frames come from the SOURCE clips rather than the
// stitched output so no throwaway encode is needed; the few frames that land
// inside a crossfade show a blend and get smoothed out as noise. Segments are
// clipped to end before the title window so the closing shot stays clean.
async function detectRoomSegments(clips, tmp, info, rooms) {
  const allowed = [...new Set(rooms.map(roomLabel).filter(Boolean))];
  if (!allowed.length) return [];
  const framesDir = path.join(tmp, "frames");
  fs.mkdirSync(framesDir);
  const budget = Math.min(MAX_VISION_FRAMES, Math.max(8, Math.round(info.duration * SAMPLES_PER_SECOND)));
  const totalClipSeconds = clips.reduce((s, c) => s + c.duration, 0);
  const frames = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const share = Math.max(2, Math.round((budget * c.duration) / totalClipSeconds));
    frames.push(...await sampleClipFrames(c.file, framesDir, `c${i}`, c.duration, share, c.offset));
  }
  frames.sort((a, b) => a.t - b.t);
  if (!frames.length) return [];
  const items = await classifyFrames(frames, allowed, process.env.ANTHROPIC_API_KEY);
  const times = frames.map((f) => f.t);
  const segs = labelsToSegments(items.map((x) => x.label), times, info.duration);
  const cutoff = Math.max(0, info.duration - OVERLAY_SECONDS);
  return segs
    .map((s) => ({ ...s, start: afterJoin(s.start, clips), end: Math.min(s.end, cutoff) }))
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
  // SSRF guard: client-supplied clip/music URLs must resolve to public
  // addresses (blocks 169.254.169.254 & internal hosts). Fixed trusted hosts
  // (fal, etc.) are public and pass unchanged.
  const safeUrl = await assertPublicHttpUrl(url);
  const resp = await fetch(safeUrl, { signal: AbortSignal.timeout(120000), redirect: "error" });
  if (!resp.ok) throw new Error(`fetch video ${resp.status}`);
  fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
}

// This model returns `audio_file: { url, file_name, content_type, file_size }`.
// The sibling keys are accepted too: fal names the output field per model, so a
// swap of OVERLAY_MUSIC_MODEL should not need a code change to keep working.
function pickAudioUrl(body) {
  if (!body || typeof body !== "object") return null;
  const candidates = [
    body.audio_file, body.audio, body.audio_url, body.output, body.file, body.url,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) return c;
    if (c && typeof c === "object" && typeof c.url === "string" && /^https?:\/\//.test(c.url)) {
      return c.url;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function falJson(url, key, init = {}, timeoutMs = 30000) {
  const resp = await fetch(url, {
    ...init,
    headers: { authorization: `Key ${key}`, "content-type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`fal ${resp.status} ${url.split("/").pop()}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

/**
 * Generate a music bed of roughly `seconds` on fal.ai and return its URL.
 * Submits to the queue, polls until COMPLETED, then fetches the result.
 * Length does not need to be exact — the filtergraph loops and trims whatever
 * comes back to the stitched duration.
 */
async function generateMusic(seconds, prompt) {
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY not set");
  const submit = await falJson(`${MUSIC_QUEUE_BASE}/${MUSIC_MODEL}`, key, {
    method: "POST",
    body: JSON.stringify({ prompt: prompt || MUSIC_PROMPT, duration: Math.ceil(seconds) }),
  });
  const requestId = submit.request_id;
  if (!requestId) throw new Error(`fal submit returned no request_id: ${JSON.stringify(submit).slice(0, 200)}`);
  // fal hands back absolute status/response URLs; prefer them over rebuilding
  // the path ourselves, and fall back if a future reply omits them.
  const base = `${MUSIC_QUEUE_BASE}/${MUSIC_MODEL}/requests/${requestId}`;
  const statusUrl = submit.status_url || `${base}/status`;
  const resultUrl = submit.response_url || base;

  const deadline = Date.now() + MUSIC_TIMEOUT_MS;
  let status = submit.status;
  while (status !== "COMPLETED") {
    if (Date.now() > deadline) throw new Error(`fal request ${requestId} still ${status} after ${MUSIC_TIMEOUT_MS}ms`);
    await sleep(MUSIC_POLL_MS);
    status = (await falJson(statusUrl, key)).status;
    if (status === "FAILED" || status === "ERROR" || status === "CANCELLED") {
      throw new Error(`fal request ${requestId} ${status}`);
    }
  }
  const body = await falJson(resultUrl, key);
  const url = pickAudioUrl(body);
  if (!url) throw new Error(`fal reply had no audio url: ${JSON.stringify(body).slice(0, 300)}`);
  return url;
}

/**
 * Settle on a music bed for a video of `duration` seconds, writing any remote
 * track into `tmp`. Never throws — a bed is a nice-to-have, and losing it must
 * not cost the caller the whole video. Returns { file, debug }.
 */
async function resolveMusic({ duration, musicUrl, musicPrompt, tmp }) {
  const dest = path.join(tmp, "bed.audio");
  if (musicUrl) {
    try {
      await download(musicUrl, dest);
      return { file: dest, debug: "caller_url" };
    } catch (err) {
      console.warn("video-overlay: music_url download failed:", err.message);
      return { file: null, debug: "error: caller_url " + err.message.slice(0, 160) };
    }
  }
  if (process.env.FAL_KEY) {
    try {
      const url = await generateMusic(duration, musicPrompt);
      await download(url, dest);
      return { file: dest, debug: `generated:${MUSIC_MODEL}` };
    } catch (err) {
      console.warn("video-overlay: music generation failed, falling back:", err.message);
      if (fs.existsSync(MUSIC_PATH)) return { file: MUSIC_PATH, debug: "fallback_static_after_error" };
      return { file: null, debug: "error: " + err.message.slice(0, 200) };
    }
  }
  if (fs.existsSync(MUSIC_PATH)) return { file: MUSIC_PATH, debug: "static" };
  return { file: null, debug: "no_fal_key_and_no_static_track" };
}

// Build the ffmpeg args. One encode does everything: crossfade the clips
// together, overlay a pre-rendered cream gradient PNG (enabled only while a
// room label shows), burn the ASS track over that, and lay down the music bed.
// A single clip with no rooms and no music keeps the original cheap `-vf ass`
// path, audio copied through. execFile passes args verbatim (no shell), so
// commas inside the enable expression are escaped with \, for ffmpeg's
// filtergraph parser.
//
// xfade needs its inputs to agree on size, SAR, frame rate and pixel format,
// so every clip is normalized to the first one's geometry before joining.
// Agent logo on the titled video: a still looped for the whole video, 16% of
// the width, ~80% opaque so the room shows through, inset 4% from top-left.
const LOGO_WIDTH_FRAC = 0.16;
const LOGO_INSET_FRAC = 0.04;
const LOGO_OPACITY = 0.8;

// One encode, up to two outputs: `outFile` (titles, room labels, logo) and,
// when `cleanFile` is given, the same stitch + music with no overlay at all.
function buildFfmpegArgs({ inFiles, assFile, outFile, info, durations, roomSegments, gradFile, musicFile, cleanFile = null, logoFile = null }) {
  const n = inFiles.length;
  const useGradient = Boolean(gradFile && roomSegments.length);

  if (n === 1 && !useGradient && !musicFile && !cleanFile && !logoFile) {
    return [
      "-y", "-i", inFiles[0],
      "-vf", `ass=${assFile}:fontsdir=${FONTS_DIR}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "copy",
      "-movflags", "+faststart",
      outFile,
    ];
  }

  const parts = [];
  const norm = `scale=${info.width}:${info.height},setsar=1,fps=${info.fps},format=yuv420p`;
  if (n === 1) {
    parts.push(`[0:v]${norm}[vcat]`);
  } else {
    for (let i = 0; i < n; i++) parts.push(`[${i}:v]${norm}[v${i}]`);
    let prev = "v0";
    let joined = durations[0];
    for (let i = 1; i < n; i++) {
      const label = i === n - 1 ? "vcat" : `x${i}`;
      const offset = (joined - XFADE_SECONDS).toFixed(3);
      parts.push(`[${prev}][v${i}]xfade=transition=fade:duration=${XFADE_SECONDS}:offset=${offset}[${label}]`);
      prev = label;
      joined += durations[i] - XFADE_SECONDS;
    }
  }

  let last = "vcat";
  if (cleanFile) {
    parts.push("[vcat]split=2[vmain][vclean]");
    last = "vmain";
  }
  if (useGradient) {
    const y = info.height - bandHeight(info.height);
    const enable = roomSegments
      .map((s) => `between(t\\,${s.start.toFixed(2)}\\,${s.end.toFixed(2)})`)
      .join("+");
    parts.push(`[${last}][${n}:v]overlay=x=0:y=${y}:enable=${enable}[bg]`);
    last = "bg";
  }
  const logoIdx = n + (useGradient ? 1 : 0);
  if (logoFile) {
    const w = Math.round(info.width * LOGO_WIDTH_FRAC);
    const inset = Math.round(info.width * LOGO_INSET_FRAC);
    parts.push(`[${logoIdx}:v]scale=${w}:-1,format=rgba,colorchannelmixer=aa=${LOGO_OPACITY},fade=in:st=0:d=0.5:alpha=1[lg]`);
    parts.push(`[${last}][lg]overlay=x=${inset}:y=${inset}[lgo]`);
    last = "lgo";
  }
  parts.push(`[${last}]format=yuv420p,ass=${assFile}:fontsdir=${FONTS_DIR}[v]`);

  if (musicFile) {
    const idx = logoIdx + (logoFile ? 1 : 0);
    const fadeAt = Math.max(0, info.duration - MUSIC_FADE_SECONDS).toFixed(3);
    parts.push(
      `[${idx}:a]atrim=0:${info.duration.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `afade=t=out:st=${fadeAt}:d=${MUSIC_FADE_SECONDS}` + (cleanFile ? ",asplit=2[a][aclean]" : "[a]")
    );
  }

  const args = ["-y"];
  for (const f of inFiles) args.push("-i", f);
  if (useGradient) args.push("-i", gradFile);
  if (logoFile) args.push("-loop", "1", "-t", info.duration.toFixed(3), "-i", logoFile);
  // -stream_loop applies to the input that follows it, so a bed shorter than
  // the video repeats instead of cutting out; atrim above bounds it again.
  if (musicFile) args.push("-stream_loop", "-1", "-i", musicFile);
  args.push("-filter_complex", parts.join(";"), "-map", "[v]");
  if (musicFile) args.push("-map", "[a]", "-c:a", "aac", "-b:a", "128k");
  else if (n === 1) args.push("-map", "0:a?", "-c:a", "copy");
  const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart"];
  args.push(...enc, outFile);
  if (cleanFile) {
    args.push("-map", "[vclean]");
    if (musicFile) args.push("-map", "[aclean]", "-c:a", "aac", "-b:a", "128k");
    else if (n === 1) args.push("-map", "0:a?", "-c:a", "copy");
    args.push(...enc, cleanFile);
  }
  return args;
}

/**
 * Stitch the clips at `videoUrls` (ordered; `videoUrl` is accepted as a
 * single-clip shorthand), overlay `lines` on the last 3 seconds of the
 * result, and — when `rooms` is provided and ANTHROPIC_API_KEY is set —
 * vision-detected room-name labels (with a short descriptor, over a cream
 * gradient) on the segments where each room is on screen.
 * Writes the result under `uploadDir`/overlays and returns its public URL.
 */
// The clean render sits next to the titled one as <id>.clean.mp4. Given the
// clean URL (what the property page stores), return its titled sibling (what
// gets published), or null for any other URL.
function promoVideoUrl(url) {
  const m = /^(.*\/files\/overlays\/[\w-]+)\.clean\.mp4$/.exec(String(url || ""));
  return m ? `${m[1]}.mp4` : null;
}

async function overlayVideo({ videoUrl, videoUrls, lines, rooms, musicUrl, musicPrompt, logoUrl, uploadDir, baseUrl }) {
  const urls = (Array.isArray(videoUrls) && videoUrls.length ? videoUrls : [videoUrl])
    .filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
  if (!urls.length) throw new Error("no video url given");
  if (urls.length > MAX_CLIPS) throw new Error(`at most ${MAX_CLIPS} clips can be stitched`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-"));
  try {
    const assFile = path.join(tmp, "titles.ass");
    const outFile = path.join(tmp, "out.mp4");
    const cleanFile = path.join(tmp, "clean.mp4");
    const inFiles = [];
    const probes = [];
    for (let i = 0; i < urls.length; i++) {
      const f = path.join(tmp, `in${i}.mp4`);
      await download(urls[i], f);
      inFiles.push(f);
      probes.push(await probe(f));
    }
    const durations = probes.map((p) => p.duration);
    const { offsets, duration } = stitchTimeline(durations);
    // Geometry comes from the first clip; the rest are scaled to match it.
    const info = { width: probes[0].width, height: probes[0].height, fps: probes[0].fps, duration };
    const clips = inFiles.map((file, i) => ({ file, duration: durations[i], offset: offsets[i] }));
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
          roomSegments = await detectRoomSegments(clips, tmp, info, rooms.slice(0, MAX_ROOMS));
          roomDebug = roomSegments.length ? "ok" : "no_segments_detected";
        } catch (err) {
          roomDebug = "error: " + err.message.slice(0, 200);
          console.warn("video-overlay: room detection failed, continuing without:", err.message);
        }
      }
    }
    // The titles sit on the last clip's closing frame; read its brightness there.
    const endStyle = endStyleFor(await endFrameLuma(inFiles[inFiles.length - 1]));
    fs.writeFileSync(assFile, buildAss(info, lines, roomSegments, endStyle), "utf8");
    let gradFile = null;
    if (roomSegments.length) {
      gradFile = path.join(tmp, "grad.png");
      fs.writeFileSync(gradFile, gradientPng(info.width, bandHeight(info.height), CREAM_RGB, GRADIENT_PEAK_ALPHA));
    }
    const music = await resolveMusic({ duration, musicUrl, musicPrompt, tmp });
    const musicFile = music.file;
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
    const args = buildFfmpegArgs({ inFiles, assFile, outFile, info, durations, roomSegments, gradFile, musicFile, cleanFile, logoFile });
    await run(FFMPEG, args, 240000);
    const id = crypto.randomUUID();
    const rel = `overlays/${id}.mp4`;
    const relClean = `overlays/${id}.clean.mp4`;
    fs.mkdirSync(path.join(uploadDir, "overlays"), { recursive: true });
    fs.copyFileSync(outFile, path.join(uploadDir, rel));
    fs.copyFileSync(cleanFile, path.join(uploadDir, relClean));
    return {
      video_url: `${baseUrl}/files/${rel}`,
      clean_video_url: `${baseUrl}/files/${relClean}`,
      duration: info.duration,
      clip_count: inFiles.length,
      clip_durations: durations,
      has_music: Boolean(musicFile),
      music_debug: music.debug,
      room_segments: roomSegments,
      room_debug: roomDebug,
      end_style: endStyle,
      logo_debug: logoDebug,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = {
  overlayVideo, promoVideoUrl, MAX_LINES, MAX_LINE_CHARS, MAX_ROOMS, MAX_CLIPS, XFADE_SECONDS,
  _test: {
    buildAss, buildFfmpegArgs, labelsToSegments, roomLabel, sanitizeAss, assTime,
    modeOf, gradientPng, bandHeight, stitchTimeline, parseFps, pickAudioUrl, afterJoin,
    endStyleFor, endFrameLuma, swooshPath, wrapText, textWidth,
  },
};
