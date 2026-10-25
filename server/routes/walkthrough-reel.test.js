// /api/walkthrough/reel/* input guards and the page-media patch, with db stubbed.
const assert = require("assert");
const path = require("path");
const express = require("express");

const patches = [];
const dbPath = require.resolve("../db");
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  getPage: async (id) => (id === "p1" ? { page_id: "p1", hero: {} } : null),
  updatePage: async (id, patch) => { patches.push([id, patch]); },
  getListing: async () => null,
} };
const createRouter = require("./walkthrough");

const BASE = "https://forly.example";
const app = express();
app.use(express.json());
app.use("/api/walkthrough", createRouter({ n8nSecret: "s3cret", uploadDir: path.join(__dirname, "..", "tmp-test-uploads"), baseUrl: BASE, storeOpts: {} }));

const own = (n) => `${BASE}/files/0000000${n}-aaaa-bbbb-cccc-dddddddddddd.mp4`;

(async () => {
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/walkthrough`;
  const post = (p, body, secret = "s3cret") => fetch(url + p, { method: "POST",
    headers: { "content-type": "application/json", "x-forly-secret": secret }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/reel/clips", { clips: [] }, "wrong")).status, 403, "n8n secret required");
    assert.equal((await post("/reel/clips", { clips: [] })).status, 400);
    assert.equal((await post("/reel/clips", { clips: [{ prompt: "x", duration: 4, image_urls: ["https://a/1.jpg"] }] })).status, 400, "H3 needs 5-15 s");
    assert.equal((await post("/reel/clips", { clips: [{ prompt: "x", duration: 5, image_urls: ["http://169.254.169.254/x"] }] })).status, 400, "https photos only");
    assert.equal((await post("/reel/status", { requests: [] })).status, 400);
    assert.equal((await post("/reel/render", { clips: [{ prompt: "x", duration: 5, image_urls: ["https://a/1.jpg"] }], clip_urls: [], script: { lines: [] } })).status, 400);

    const media = { page_id: "p1", video_url: own(1), narration_url: own(2), music_url: own(3) };
    assert.equal((await post("/reel/page-media", { ...media, music_url: "https://evil.example/files/00000003-aaaa-bbbb-cccc-dddddddddddd.mp4" })).status, 400, "foreign files refused");
    assert.equal((await post("/reel/page-media", { ...media, page_id: "nope" })).status, 404);
    assert.equal(patches.length, 0);
    const r = await post("/reel/page-media", { ...media, post_video_url: own(4) });
    assert.equal(r.status, 200);
    assert.equal(patches.length, 1);
    const [id, patch] = patches[0];
    assert.equal(id, "p1");
    assert.deepEqual(Object.keys(patch).sort(), ["hero.music_url", "hero.narration_url", "hero.promo_video_url", "hero.video_url", "updated_at"]);
    assert.equal(patch["hero.narration_url"], own(2));
    assert.equal(patch["hero.promo_video_url"], own(4));

    assert.equal((await post("/plan", { page_id: "nope" })).status, 404, "unknown page");
    console.log("walkthrough-reel routes: all tests passed");
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
