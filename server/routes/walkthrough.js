/*
 * routes/walkthrough.js — POST /api/walkthrough/plan, called by the n8n
 * walkthrough workflow right after its Vision Tagger.
 *
 * Takes the tagger's per-photo tags, maps the photos into spaces (one vision
 * call) and returns the Seedance clips — prompt, reference images and duration
 * per clip — plus the end titles. n8n-only (x-forly-secret): it spends a vision
 * call per request.
 */

const express = require("express");
const db = require("../db");
const { constantTimeEqual } = require("../security");
const { mapSpaces, MAX_PHOTOS } = require("../space-map");
const { planWalkthrough } = require("../walkthrough-plan");

module.exports = function createWalkthroughRouter({ n8nSecret }) {
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
    const tags = (Array.isArray(body.tags) ? body.tags : [])
      .filter((t) => t && typeof t.url === "string" && /^https?:\/\//.test(t.url))
      .slice(0, MAX_PHOTOS)
      .map((t) => ({
        url: t.url,
        room_type: typeof t.room_type === "string" ? t.room_type.slice(0, 40) : "",
        quality_score: Number(t.quality_score) || 0,
        is_real_estate: t.is_real_estate !== false,
      }));
    if (!tags.length) return res.status(400).json({ error: "tags (array of {url, room_type, quality_score}) required" });
    const details = body.property_details && typeof body.property_details === "object" ? body.property_details : {};
    const listingId = typeof body.listing_id === "string" ? body.listing_id.slice(0, 100) : "";

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
    res.json({ ...plan, space_map: map, map_debug: debug });
  });

  return router;
};
