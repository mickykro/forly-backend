/*
 * routes/portal.js — public buyer-facing catalog endpoints for call4li.com
 * Handles: /api/portal/listings, /api/portal/stream
 *
 * No auth: this feeds the public property portal. Card payloads expose only
 * fields already visible on the public property page (see portal-stream.js).
 */

const express = require("express");
const db = require("../db");
const portalStream = require("../portal-stream");

const CACHE_TTL_MS = 60 * 1000;

module.exports = function createPortalRouter(ctx) {
  const { pageBaseUrl } = ctx;
  const router = express.Router();

  // Cache is keyed on the stream version too, so any broadcast (add/update/
  // remove) invalidates it immediately instead of waiting out the TTL.
  let cache = { at: 0, version: -1, body: null };

  router.get("/api/portal/listings", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "public, max-age=30");
    try {
      const v = portalStream.getVersion();
      if (!cache.body || cache.version !== v || Date.now() - cache.at > CACHE_TTL_MS) {
        const pages = await db.listPublicPages(200);
        const listings = pages.map((p) => portalStream.toCard(p, pageBaseUrl));
        cache = {
          at: Date.now(),
          version: v,
          body: {
            listings,
            count: listings.length,
            agencies: [...new Set(listings.map((l) => l.agent.brand_name).filter(Boolean))],
            cities: [...new Set(listings.map((l) => l.city).filter(Boolean))],
            generated_at: new Date().toISOString(),
          },
        };
      }
      res.json(cache.body);
    } catch (err) {
      console.error("portal listings failed:", err.message);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── realtime: listing_added / listing_updated / listing_removed ──
  router.get("/api/portal/stream", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write(":connected\n\n");
    portalStream.addClient(res);
  });

  return router;
};
