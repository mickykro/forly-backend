/* photo-orient.js — EXIF orientation is read and baked into the pixels. */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { exifOrientation, uprightJpeg } = require("./photo-orient");

// A minimal APP1 Exif segment holding only the orientation tag.
function withOrientation(jpeg, value, le = true) {
  const tiff = Buffer.alloc(26);
  const w16 = (v, o) => (le ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
  const w32 = (v, o) => (le ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
  tiff.write(le ? "II" : "MM", 0, "latin1"); w16(42, 2); w32(8, 4);
  w16(1, 8);                                   // one IFD entry
  w16(0x0112, 10); w16(3, 12); w32(1, 14); w16(value, 18);
  w32(0, 22);                                  // no next IFD
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, body, jpeg.subarray(2)]);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orient-test-"));
  try {
    // 400x200, left half red, right half blue: stored "landscape".
    const src = path.join(tmp, "src.jpg");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=200x200", "-f", "lavfi", "-i", "color=blue:s=200x200",
      "-filter_complex", "hstack", "-frames:v", "1", src]);
    const plain = fs.readFileSync(src);

    assert.equal(exifOrientation(plain), 1, "no EXIF → upright");
    assert.equal(exifOrientation(Buffer.from("not a jpeg")), 1);
    assert.equal(exifOrientation(withOrientation(plain, 6)), 6);
    assert.equal(exifOrientation(withOrientation(plain, 8, false)), 8, "big-endian TIFF");
    assert.equal(await uprightJpeg(plain), null, "already upright → untouched");
    assert.equal(await uprightJpeg(withOrientation(plain, 1)), null);

    // Orientation 6 = shown turned 90° clockwise: stored-left (red) ends up on top.
    const up = await uprightJpeg(withOrientation(plain, 6));
    assert.equal(up.orientation, 6);
    const out = path.join(tmp, "out.jpg");
    fs.writeFileSync(out, up.buffer);
    const dims = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]).toString().trim();
    assert.equal(dims, "200,400", "portrait after the turn");
    const px = (y) => [...execFileSync("ffmpeg", ["-v", "error", "-i", out, "-vf", `format=rgb24,crop=2:2:100:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])];
    const [r1, , b1] = px(50), [r2, , b2] = px(350);
    assert.ok(r1 > 200 && b1 < 60, "top is red");
    assert.ok(b2 > 200 && r2 < 60, "bottom is blue");
    assert.equal(exifOrientation(up.buffer), 1, "no orientation flag left to misread");

    // Orientation 8 (90° counter-clockwise): red ends up at the bottom.
    fs.writeFileSync(out, (await uprightJpeg(withOrientation(plain, 8))).buffer);
    const [r3] = px(350);
    assert.ok(r3 > 200, "orientation 8: bottom is red");
    // The walkthrough planner swaps a flagged photo for a hosted upright copy;
    // an upright one and an unreachable one are used as they are.
    const { uprightPhotos } = require("./routes/walkthrough");
    const flagged = withOrientation(plain, 6);
    const calls = [];
    const get = async (url, range) => {
      calls.push([url, range]);
      if (url === "https://x/broken.jpg") throw new Error("404");
      const full = url === "https://x/side.jpg" ? flagged : plain;
      return range ? { buf: full.subarray(0, 64), partial: true } : { buf: full, partial: false };
    };
    const stored = [];
    const tags = [{ url: "https://x/side.jpg" }, { url: "https://x/up.jpg" }, { url: "https://x/broken.jpg" }];
    const n = await uprightPhotos(tags, async (buf) => { stored.push(buf); return "https://forly/files/fixed.jpg"; }, get);
    assert.equal(n, 1);
    assert.deepEqual(tags.map((t) => t.url), ["https://forly/files/fixed.jpg", "https://x/up.jpg", "https://x/broken.jpg"]);
    assert.equal(exifOrientation(stored[0]), 1);
    assert.deepEqual(calls.filter(([, r]) => !r).map(([u]) => u), ["https://x/side.jpg"], "only the flagged photo is fetched in full");
    // PUT /api/upload stores the upright copy.
    const express = require("express");
    const createIntakeRouter = require("./routes/intake");
    const app = express();
    app.use("/api", createIntakeRouter({ requireAuth: () => (req, res, next) => { req.user = { userId: "P1" }; next(); },
      authSecret: "s", uploadDir: tmp }));
    const server = app.listen(0);
    const fname = "0b6f3a0e-1111-4222-8333-944455556666.jpg";
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/upload/${fname}`, { method: "PUT", body: flagged, headers: { "Content-Type": "image/jpeg" } });
    server.close();
    assert.equal(r.status, 200);
    fs.writeFileSync(out, fs.readFileSync(path.join(tmp, fname)));
    assert.equal(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]).toString().trim(), "200,400", "uploaded photo stored upright");
    console.log("photo-orient.test.js ok");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
