"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { _test } = require("./overlay");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "watermark-test-"));
try {
  const input = path.join(tmp, "in.mp4"),
    output = path.join(tmp, "out.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=black:s=320x240:d=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    input,
  ]);
  execFileSync(
    "ffmpeg",
    _test.watermarkArgs(input, output, { width: 320, height: 240 }),
    { stdio: "pipe" },
  );
  const metadata = JSON.parse(
    execFileSync("ffprobe", [
      "-v",
      "quiet",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      output,
    ]),
  );
  assert.equal(metadata.streams[0].codec_name, "h264");
  assert.equal(metadata.streams[0].pix_fmt, "yuv420p");
  assert.ok(Number(metadata.format.duration) >= 1.9);
  for (const t of ["0.1", "1", "1.8"]) {
    const pixels = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-ss",
      t,
      "-i",
      output,
      "-frames:v",
      "1",
      "-vf",
      "crop=160:100:80:70",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "pipe:1",
    ]);
    assert.ok(
      pixels.filter((x) => x > 50).length > 300,
      "visible central watermark at " + t,
    );
  }
  const bytes = fs.readFileSync(output);
  assert.ok(
    bytes.indexOf(Buffer.from("moov")) < bytes.indexOf(Buffer.from("mdat")),
    "faststart",
  );
  console.log("outreach real ffmpeg watermark tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
