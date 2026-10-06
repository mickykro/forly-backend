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
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { videoRef, REF_MAX_SIDE } = require("../photo-orient");
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
 * Seedance gets its own copy of every photo: upright (it ignores EXIF rotation,
 * which made rooms come out sideways), the long side at most 1280 px, a plain
 * JPEG. The page gallery keeps the originals. The copy's name is derived from
 * the source URL, so a re-plan reuses it instead of making it again; a photo
 * that cannot be fetched or converted is sent as it is.
 * → { refs, uprighted }. store(buf, fname) hosts a copy and returns its URL;
 * existing(fname) returns the URL of an already-made copy, or null.
 */
const refName = (url) => {
  const h = crypto.createHash("sha1").update(`${url}|${REF_MAX_SIDE}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}.jpg`;
};

async function shrinkPhotos(tags, { store, existing = () => null, get = fetchBytes }) {
  let refs = 0, uprighted = 0;
  const one = async (t) => {
    try {
      const fname = refName(t.url);
      const have = existing(fname);
      if (have) { t.url = have; refs++; return; }
      const { buf } = await get(t.url, false);
      const ref = await videoRef(buf);
      t.url = await store(ref.buffer, fname);
      refs++;
      if (ref.orientation !== 1) uprighted++;
    } catch (err) {
      console.warn("walkthrough: video copy failed, photo used as is:", err.message);
    }
  };
  for (let i = 0; i < tags.length; i += 6) await Promise.all(tags.slice(i, i + 6).map(one));
  return { refs, uprighted };
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

  // Where the Seedance copies live: this server's /files (relayed to the shared
  // store when one is configured, like every upload).
  const publicBase = (storeOpts.remoteUploadBase && storeOpts.uploadPublicBase) || baseUrl;
  const refStore = {
    store: (buf, fname) => storeBuffer(buf, "jpg", uploadDir, baseUrl, { ...storeOpts, fname }).then((r) => r.url),
    existing: (fname) => (fs.existsSync(path.join(uploadDir, fname)) ? `${publicBase}/files/${fname}` : null),
  };

  // ── POST /refs: Seedance copies for a workflow that plans its own clips (V2) ──
  // { image_urls: [...] } → { image_urls: [...] }, same order; a photo that
  // cannot be converted comes back unchanged.
  router.post("/refs", requireN8n, async (req, res) => {
    const urls = (Array.isArray(req.body && req.body.image_urls) ? req.body.image_urls : [])
      .map((u) => String(u || "").trim()).filter((u) => /^https?:\/\//.test(u)).slice(0, MAX_PHOTOS);
    if (!urls.length) return res.status(400).json({ error: "image_urls required" });
    if (!uploadDir) return res.json({ image_urls: urls, ref_photos: 0 });
    const tags = urls.map((url) => ({ url }));
    const shrunk = await shrinkPhotos(tags, refStore);
    res.json({ image_urls: tags.map((t) => t.url), ref_photos: shrunk.refs, uprighted_photos: shrunk.uprighted });
  });

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

    const shrunk = uploadDir ? await shrinkPhotos(tags, refStore) : { refs: 0, uprighted: 0 };
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
    res.json({ ...plan, space_map: map, map_debug: debug, ref_photos: shrunk.refs, uprighted_photos: shrunk.uprighted });
  });

  return router;
};
module.exports.shrinkPhotos = shrinkPhotos;
module.exports.refName = refName;
