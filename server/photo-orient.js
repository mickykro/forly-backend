/*
 * photo-orient.js — bake a JPEG's EXIF orientation into its pixels.
 *
 * Phones often store a portrait photo as landscape pixels plus an EXIF
 * "rotate 90°" flag. Browsers honour the flag, so the photo looks right
 * everywhere we look at it; Seedance reads the raw pixels, got the room on its
 * side, and generated a walkthrough of sideways rooms rolling upright (listing
 * f9e12d18). Uploads were stored byte-for-byte, flag included.
 *
 * uprightJpeg() returns a re-encoded upright copy (no EXIF left to misread), or
 * null when the photo is already upright or is not a JPEG. Only JPEG carries
 * this flag in practice; PNG/WebP are passed through.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

// EXIF orientation → the ffmpeg filter that makes the pixels upright.
const FILTERS = {
  2: "hflip",
  3: "hflip,vflip",
  4: "vflip",
  5: "transpose=0",   // 90° counter-clockwise + vertical flip
  6: "transpose=1",   // 90° clockwise
  7: "transpose=3",   // 90° clockwise + vertical flip
  8: "transpose=2",   // 90° counter-clockwise
};

/** EXIF orientation (1-8) of a JPEG buffer; 1 when absent, unreadable or not a JPEG. */
function exifOrientation(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) return 1;
    const marker = buf[p + 1];
    if (marker === 0xda || marker === 0xd9) return 1;          // image data / end: no EXIF before it
    const len = buf.readUInt16BE(p + 2);
    if (marker === 0xe1 && buf.toString("latin1", p + 4, p + 10) === "Exif\0\0") {
      return orientationInTiff(buf, p + 10, Math.min(buf.length, p + 2 + len));
    }
    p += 2 + len;
  }
  return 1;
}

function orientationInTiff(buf, t, end) {
  if (t + 8 > end) return 1;
  const order = buf.toString("latin1", t, t + 2);
  if (order !== "II" && order !== "MM") return 1;
  const le = order === "II";
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = t + u32(t + 4);
  if (ifd + 2 > end) return 1;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return 1;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

function run(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { timeout: timeoutMs }, (err, _out, stderr) => {
      if (err) reject(new Error(`ffmpeg failed: ${String(stderr).trim().split("\n").slice(-2).join(" | ").slice(-300)}`));
      else resolve();
    });
  });
}

/**
 * Upright copy of a JPEG whose EXIF says it is rotated or flipped.
 * → { buffer, orientation } | null (already upright, not a JPEG).
 * -noautorotate: whatever ffmpeg build is installed, the only turn applied is ours.
 */
async function uprightJpeg(buf) {
  const orientation = exifOrientation(buf);
  const filter = FILTERS[orientation];
  if (!filter) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orient-"));
  try {
    const src = path.join(tmp, "src.jpg");
    const out = path.join(tmp, `${crypto.randomUUID()}.jpg`);
    fs.writeFileSync(src, buf);
    await run(["-y", "-v", "error", "-noautorotate", "-i", src, "-vf", filter, "-frames:v", "1", "-q:v", "2", out]);
    return { buffer: fs.readFileSync(out), orientation };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/*
 * The copy Seedance gets as a reference: upright, the long side at most
 * `maxSide` px (the video is 720p; more pixels only make the download heavier),
 * re-saved as a plain baseline JPEG with no metadata. Any JPEG/PNG/WebP in.
 * → { buffer, orientation }
 */
const REF_MAX_SIDE = 1280;
async function videoRef(buf, maxSide = REF_MAX_SIDE) {
  const orientation = exifOrientation(buf);
  const turn = FILTERS[orientation];
  const fit = `scale='if(gte(iw,ih),min(iw,${maxSide}),-2)':'if(gte(iw,ih),-2,min(ih,${maxSide}))'`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ref-"));
  try {
    const src = path.join(tmp, "src");
    const out = path.join(tmp, "ref.jpg");
    fs.writeFileSync(src, buf);
    await run(["-y", "-v", "error", "-noautorotate", "-i", src, "-vf", (turn ? turn + "," : "") + fit + ",format=yuvj420p",
      "-map_metadata", "-1", "-frames:v", "1", "-q:v", "3", out]);
    return { buffer: fs.readFileSync(out), orientation };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { exifOrientation, uprightJpeg, videoRef, FILTERS, REF_MAX_SIDE };
