/*
 * routes/listing-drafts.js — "נכסים שמצאנו ביד2 / מדלן": review, create a page, or dismiss.
 * Handles: GET /api/listing-drafts, GET /api/listing-drafts/:id,
 *          POST /api/listing-drafts/sweep, POST /api/listing-drafts/:id/dismiss
 *
 * Nothing here ever becomes a page without the agent pressing "יצירת דף" —
 * a sweep only ever writes drafts (see listing-sweep.js).
 */
const express = require("express");
const listingSweep = require("../listing-sweep");

module.exports = function createListingDraftsRouter(ctx) {
  const { requireAuth, authSecret } = ctx;
  const db = ctx.db || require("../db");
  const sweep = ctx.sweep || listingSweep.sweep;
  const sweepDeps = ctx.sweepDeps || {};
  const platforms = ctx.platforms || require("./connections-browser").PLATFORMS;
  const router = express.Router();

  router.get("/listing-drafts", requireAuth(authSecret), async (req, res) => {
    const all = await db.listListingDraftsByPhone(req.user.userId, 100);
    const open = all.filter((d) => !d.dismissed_at && d.status !== "created");
    res.json({ drafts: open });
  });

  // Ownership mirrors extract job polling: a draft that belongs to someone
  // else answers exactly like one that does not exist.
  router.get("/listing-drafts/:id", requireAuth(authSecret), async (req, res) => {
    const d = await db.getListingDraft(String(req.params.id));
    if (!d || d.phone !== req.user.userId) return res.status(404).json({ error: "not_found" });
    res.json(d);
  });

  router.post("/listing-drafts/sweep", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    const conn = (await db.getConnection(phone)) || {};
    const targets = Object.keys(platforms).filter((p) => conn[`${p}_browser_connected_at`]);
    let found = 0, queued = 0, skipped = 0;
    for (const platform of targets) {
      try {
        const r = await sweep({ platform, phone }, Object.assign({ db }, sweepDeps));
        found += r.found; queued += r.queued; skipped += r.skipped;
      } catch (e) { console.warn(`listing-sweep ${platform} failed: ${e.message}`); }
    }
    res.json({ found, queued, skipped });
  });

  router.post("/listing-drafts/:id/dismiss", requireAuth(authSecret), async (req, res) => {
    const d = await db.getListingDraft(String(req.params.id));
    if (!d || d.phone !== req.user.userId) return res.status(404).json({ error: "not_found" });
    await db.updateListingDraft(d.id, { status: "dismissed", dismissed_at: new Date().toISOString() });
    res.json({ status: "dismissed" });
  });

  return router;
};
