/*
 * routes/walkthrough.js — POST /api/walkthrough/plan, called by the n8n
 * walkthrough workflow right after the quota check.
 *
 * Takes the listing photos (image_urls), maps them into spaces (one vision
 * call) and returns the Seedance clips — prompt, reference images and duration
 * per clip — plus the end titles. n8n-only (x-forly-secret): it spends a vision
 * call per request.
 */

const express = require("express");
const db = require("../db");
const { constantTimeEqual } = require("../security");
const { mapSpaces, MAX_PHOTOS } = require("../space-map");
const { planWalkthrough } = require("../walkthrough-plan");
const { exifOrientation, uprightJpeg } = require("../photo-orient");
const { assertPublicHttpUrl, storeBuffer } = require("../utils");

const HEAD_BYTES = 128 * 1024; // EXIF sits at the start of a JPEG
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

async function fetchBytes(url, range) {
  const safe = await assertPublicHttpUrl(url);
  const resp = await fetch(safe, { signal: AbortSignal.timeout(30000), redirect: "error",
    headers: range ? { Range: `bytes=0-${HEAD_BYTES - 1}` } : {} });
  if (!resp.ok) throw new Error(`photo fetch ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_PHOTO_BYTES) throw new Error("photo too large");
  return { buf, partial: resp.status === 206 };
}

/*
 * Seedance reads raw pixels and ignores a JPEG's EXIF rotation, so a phone
 * photo stored sideways-plus-flag became a sideways room in the video. Photos
 * uploaded since the fix are already upright (PUT /upload); this covers older
 * ones and outside URLs. A photo that cannot be checked is used as it is.
 * → number of photos replaced. `store(buf)` hosts the copy and returns its URL.
 */
async function uprightPhotos(tags, store, get = fetchBytes) {
  let fixed = 0;
  const one = async (t) => {
    try {
      let { buf, partial } = await get(t.url, true);
      if (exifOrientation(buf) === 1) return;
      if (partial) buf = (await get(t.url, false)).buf;
      const up = await uprightJpeg(buf);
      if (!up) return;
      t.url = await store(up.buffer);
      fixed++;
    } catch (err) {
      console.warn("walkthrough: upright check failed, photo used as is:", err.message);
    }
  };
  for (let i = 0; i < tags.length; i += 6) await Promise.all(tags.slice(i, i + 6).map(one));
  return fixed;
}

module.exports = function createWalkthroughRouter({ n8nSecret, uploadDir, baseUrl, storeOpts = {} }) {
  const router = express.Router();

  function requireN8n(req, res, next) {
    if (!n8nSecret) return res.status(503).json({ error: "n8n_secret_not_configured" });
    if (!constantTimeEqual(req.get("x-forly-secret"), n8nSecret)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  }

  router.post("/plan", requireN8n, async (req, res) => {
    const body = req.body || {};
    // image_urls: plain strings, {url} or Firestore {stringValue}. `tags` (the
    // old Vision Tagger output) is still accepted; its scores are used only
    // where the space map gives none.
    const urlOf = (u) => (typeof u === "string" ? u : u && (u.url || u.stringValue)) || "";
    const raw = Array.isArray(body.tags) && body.tags.length ? body.tags : (Array.isArray(body.image_urls) ? body.image_urls : []);
    const tags = raw
      .map((t) => ({ t: t && typeof t === "object" ? t : {}, url: String(urlOf(t)).trim() }))
      .filter(({ url }) => /^https?:\/\//.test(url))
      .slice(0, MAX_PHOTOS)
      .map(({ t, url }) => ({
        url,
        room_type: typeof t.room_type === "string" ? t.room_type.slice(0, 40) : "",
        quality_score: typeof t.quality_score === "number" && Number.isFinite(t.quality_score) ? t.quality_score : null,
        is_real_estate: t.is_real_estate !== false,
      }));
    if (!tags.length) return res.status(400).json({ error: "image_urls (or tags with url) required" });
    const details = body.property_details && typeof body.property_details === "object" ? body.property_details : {};
    const listingId = typeof body.listing_id === "string" ? body.listing_id.slice(0, 100) : "";

    const uprighted = uploadDir
      ? await uprightPhotos(tags, (buf) => storeBuffer(buf, "jpg", uploadDir, baseUrl, storeOpts).then((r) => r.url))
      : 0;
    const { map, debug } = await mapSpaces(tags);
    let plan;
    try {
      plan = planWalkthrough(map, tags, details);
    } catch (err) {
      if (err.code === "too_few_photos") return res.status(422).json({ error: err.message, map_debug: debug });
      console.error("walkthrough plan failed:", err.message);
      return res.status(500).json({ error: "plan_failed" });
    }
    // Kept with the listing so an odd video can be traced back to its map.
    if (listingId) {
      try {
        if (await db.getListing(listingId)) {
          await db.updateListing(listingId, { space_map: { ...map, debug, planned_at: new Date() } });
        }
      } catch (err) {
        console.warn("walkthrough: saving space map failed:", err.message);
      }
    }
    res.json({ ...plan, space_map: map, map_debug: debug, uprighted_photos: uprighted });
  });

  return router;
};
module.exports.uprightPhotos = uprightPhotos;
