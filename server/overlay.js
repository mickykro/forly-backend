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

function buildAss({ width, height, duration }, lines) {
  const start = assTime(Math.max(0, duration - OVERLAY_SECONDS));
  const end = assTime(duration + 1); // past EOF is fine; clamps to last frame
  // Font sizes/margins scale with video height so 720p and 1080p both look right.
  const titleSize = Math.round(height * 0.045);
  const subSize = Math.round(height * 0.034);
  const titleMarginV = Math.round(height * 0.16);
  const subMarginV = Math.round(height * 0.105);
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
  return header.concat(events).join("\n") + "\n";
}

async function download(url, dest) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!resp.ok) throw new Error(`fetch video ${resp.status}`);
  fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
}

/**
 * Overlay `lines` on the last 3 seconds of the video at `videoUrl`.
 * Writes the result under `uploadDir`/overlays and returns its public URL.
 */
async function overlayVideo({ videoUrl, lines, uploadDir, baseUrl }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-"));
  try {
    const inFile = path.join(tmp, "in.mp4");
    const assFile = path.join(tmp, "titles.ass");
    const outFile = path.join(tmp, "out.mp4");
    await download(videoUrl, inFile);
    const info = await probe(inFile);
    fs.writeFileSync(assFile, buildAss(info, lines), "utf8");
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
    return { video_url: `${baseUrl}/files/${rel}`, duration: info.duration };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { overlayVideo, MAX_LINES, MAX_LINE_CHARS };
