/* createPropertyPage without a video (build-fallback.js): the page is built, the first photo is the hero. */
const assert = require("assert");
const express = require("express");
const utils = require("./utils");
// No network: rehost just names where the file would land.
utils.rehost = async (url, dest) => ({ url: `https://forly/files/${dest}`, fname: dest, localPath: null });
const db = require("./db");
const createPagesRouter = require("./routes/pages");

(async () => {
  const app = express();
  app.use(express.json());
  app.use(createPagesRouter({ uploadDir: "/tmp", baseUrl: "https://srv", pageBaseUrl: "https://pg", authSecret: "s",
    verifySession: () => null, readToken: () => null, normalizeAuthPhone: (p) => p, adminPhones: [],
    requireAuth: () => (req, res, next) => next() }));
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/createPropertyPage`;
  await db.saveListing({ listing_id: "NV1", business_phone: "972500000009", status: "failed", page_id: null, city: "פתח תקווה", rooms: 5 });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    listing_id: "NV1", business_phone: "972500000009", video_url: null,
    photos: [{ url: "https://f/1.jpg" }, { url: "https://f/2.jpg" }], property: { city: "פתח תקווה", rooms: 5 } }) });
  const out = await r.json();
  server.close();
  assert.equal(r.status, 200, JSON.stringify(out));
  const page = await db.getPage(out.page_id);
  assert.equal(page.hero.video_url, null, "no video");
  assert.equal(page.hero.promo_video_url, null);
  assert.match(page.hero.poster_url, /poster\.jpg$/, "the first photo stands in as the hero");
  assert.equal((await db.getListing("NV1")).page_id, out.page_id, "the listing has its page");
  console.log("pages-novideo.test.js ok");
})().catch((err) => { console.error(err); process.exit(1); });
