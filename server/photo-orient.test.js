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
  // The parser needs no ffmpeg: a bare SOI + EOI "JPEG" is enough to carry the flag.
  const bare = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(exifOrientation(bare), 1);
  assert.equal(exifOrientation(withOrientation(bare, 6)), 6);
  assert.equal(exifOrientation(withOrientation(bare, 3, false)), 3, "big-endian TIFF");
  assert.equal(exifOrientation(Buffer.from("not a jpeg")), 1);
  // Re-encoding does: the production image ships ffmpeg, a bare CI runner may not.
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
  catch { console.log("photo-orient.test.js ok (ffmpeg not installed: pixel checks skipped)"); return; }

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
    // Seedance copies: every photo gets an upright, ≤1280px plain JPEG; a copy
    // already made is reused without fetching; an unreachable photo is sent as is.
    const { videoRef, REF_MAX_SIDE } = require("./photo-orient");
    const { shrinkPhotos, refName } = require("./routes/walkthrough");
    const big = path.join(tmp, "big.jpg");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=green:s=3000x2000", "-frames:v", "1", big]);
    const bigRef = await videoRef(withOrientation(fs.readFileSync(big), 6));
    fs.writeFileSync(out, bigRef.buffer);
    assert.equal(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]).toString().trim(),
      `${2 * Math.round(2000 * REF_MAX_SIDE / 3000 / 2)},${REF_MAX_SIDE}`, "turned upright, then the long side capped");
    assert.equal(exifOrientation(bigRef.buffer), 1);
    const small = await videoRef(plain);
    fs.writeFileSync(out, small.buffer);
    assert.equal(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]).toString().trim(), "400,200", "never enlarged");

    const flagged = withOrientation(plain, 6);
    const fetched = [], stored = [];
    const get = async (url) => { fetched.push(url); if (url === "https://x/broken.jpg") throw new Error("404"); return { buf: url === "https://x/side.jpg" ? flagged : plain }; };
    const done = { [refName("https://x/done.jpg")]: "https://forly/files/done-ref.jpg" };
    const tags = [{ url: "https://x/side.jpg" }, { url: "https://x/up.jpg" }, { url: "https://x/broken.jpg" }, { url: "https://x/done.jpg" }];
    const res = await shrinkPhotos(tags, {
      get, existing: (f) => done[f] || null,
      store: async (buf, fname) => { stored.push([fname, buf]); return "https://forly/files/" + fname; },
    });
    assert.deepEqual(res, { refs: 3, uprighted: 1 });
    assert.deepEqual(tags.map((t) => t.url), ["https://forly/files/" + refName("https://x/side.jpg"), "https://forly/files/" + refName("https://x/up.jpg"),
      "https://x/broken.jpg", "https://forly/files/done-ref.jpg"]);
    assert.ok(!fetched.includes("https://x/done.jpg"), "an existing copy is reused without fetching");
    assert.match(refName("https://x/up.jpg"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/, "the shape PUT /upload accepts");
    assert.equal(refName("https://x/up.jpg"), refName("https://x/up.jpg"), "same photo, same name");
    assert.equal(exifOrientation(stored[0][1]), 1);

    // POST /api/walkthrough/refs (V2's hook): n8n secret, same order, existing copies reused.
    {
      const express = require("express");
      const app = express(); app.use(express.json());
      app.use("/api/walkthrough", require("./routes/walkthrough")({ n8nSecret: "sec", uploadDir: tmp, baseUrl: "https://srv" }));
      const server = app.listen(0);
      const u = `http://127.0.0.1:${server.address().port}/api/walkthrough/refs`;
      const call = (body, secret = "sec") => fetch(u, { method: "POST", headers: { "Content-Type": "application/json", "x-forly-secret": secret }, body: JSON.stringify(body) });
      fs.writeFileSync(path.join(tmp, refName("https://x/made.jpg")), "x");
      assert.equal((await call({ image_urls: ["https://x/made.jpg"] }, "nope")).status, 403);
      assert.equal((await call({ image_urls: [] })).status, 400);
      const d = await (await call({ image_urls: ["https://x/made.jpg", "http://127.0.0.1/private.jpg"] })).json();
      server.close();
      assert.deepEqual(d.image_urls, ["https://srv/files/" + refName("https://x/made.jpg"), "http://127.0.0.1/private.jpg"],
        "made copy reused; a photo it may not fetch comes back unchanged");
    }

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
