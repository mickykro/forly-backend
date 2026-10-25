/*
 * posting-video.js — the property's video, made light enough to upload (2 Oct 2026).
 *
 * Driver bills every byte a session moves, and the walkthrough videos are
 * encoded at ~14 Mbit/s: 26 MB for 15 seconds, uploaded again on every post.
 * Facebook re-encodes whatever it gets to its own, much lower bitrate, so the
 * extra bits never reach a viewer. Re-encoded here once (same resolution,
 * H.264 CRF 23, at most 4 Mbit/s, AAC 128k) the same clip is ~5 MB, measured
 * SSIM 0.98 against the original — no visible difference.
 *
 * Kept per source file (a hash of its bytes) in a temp folder, so a property
 * posted to ten groups is encoded once. Never in the way: no ffmpeg, a failed
 * encode or a result no smaller → the original goes up, as before.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const MIN_BYTES = 6 * 1024 * 1024;              // smaller than this: left alone
const TIMEOUT_MS = 3 * 60 * 1000;
const DIR = path.join(os.tmpdir(), "forly-post-video");
const ARGS = (src, out) => ["-v", "error", "-y", "-i", src, "-c:v", "libx264", "-preset", "medium", "-crf", "23",
  "-maxrate", "4M", "-bufsize", "8M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out];
// POSTING_BURST (local): the file crosses a slow link to the remote browser, so lighter is faster. Same resolution, 1.5 Mbit/s cap.
const FAST_ARGS = (src, out) => ["-v", "error", "-y", "-i", src, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
  "-maxrate", "1500k", "-bufsize", "3M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", out];

function run(bin, args) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(bin, args, { stdio: "ignore" }); } catch { return resolve(false); }
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } resolve(false); }, TIMEOUT_MS);
    p.on("error", () => { clearTimeout(t); resolve(false); });
    p.on("exit", (code) => { clearTimeout(t); resolve(code === 0); });
  });
}

// file: { name, mimeType, buffer } → the same shape, lighter when that helps.
async function shrink(file, deps = {}) {
  const fast = require("./posting-safety").burst(deps.env || process.env);
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length < (fast ? 512 * 1024 : MIN_BYTES)) return file;
  if ((deps.env || process.env).POSTING_VIDEO_SHRINK === "0") return file;
  const key = crypto.createHash("sha256").update(file.buffer).digest("hex").slice(0, 32) + (fast ? "g" : ""); // "g": the 1.5 Mbit/s encode; the older "f" files were 360p
  const out = path.join(DIR, `${key}.mp4`);
  try {
    if (!fs.existsSync(out)) {
      await fs.promises.mkdir(DIR, { recursive: true });
      const src = path.join(DIR, `${key}.src`), tmp = path.join(DIR, `${key}.part.mp4`);
      await fs.promises.writeFile(src, file.buffer);
      const ok = await run(deps.ffmpeg || process.env.FFMPEG_PATH || "ffmpeg", (fast ? FAST_ARGS : ARGS)(src, tmp));
      await fs.promises.unlink(src).catch(() => {});
      if (!ok) { await fs.promises.unlink(tmp).catch(() => {}); return file; }
      await fs.promises.rename(tmp, out);
    }
    const buffer = await fs.promises.readFile(out);
    if (!buffer.length || buffer.length >= file.buffer.length) return file;
    return { name: "property.mp4", mimeType: "video/mp4", buffer };
  } catch { return file; }
}

module.exports = { shrink, MIN_BYTES };
