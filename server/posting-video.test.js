/* posting-video.js — a heavy video comes back lighter; anything else comes back as it was. */
const assert = require("assert");
const fs = require("fs");
const V = require("./posting-video");

(async () => {
  const small = { name: "p.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(1000, 1) };
  assert.equal(await V.shrink(small), small, "small: untouched");
  const big = { name: "p.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(V.MIN_BYTES + 10, 7) };
  assert.equal(await V.shrink(big, { ffmpeg: "/nonexistent/ffmpeg" }), big, "no ffmpeg: the original goes up");
  assert.equal(await V.shrink(big, { env: { POSTING_VIDEO_SHRINK: "0" } }), big, "switched off");
  assert.equal(await V.shrink(big), big, "not a video ffmpeg can read: the original");
  // A real clip, when this machine has one and has ffmpeg.
  const dir = `${__dirname}/data/uploads`;
  const clip = fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => f.endsWith(".mp4")).map((f) => `${dir}/${f}`).find((f) => fs.statSync(f).size > V.MIN_BYTES);
  if (clip) {
    const file = { name: "p.mp4", mimeType: "video/mp4", buffer: fs.readFileSync(clip) };
    const out = await V.shrink(file);
    if (out !== file) {
      assert.ok(out.buffer.length < file.buffer.length / 2, `lighter: ${file.buffer.length} → ${out.buffer.length}`);
      const again = await V.shrink(file);
      assert.equal(again.buffer.length, out.buffer.length, "the second post reuses the first encode");
    }
  }
  console.log("posting-video.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
