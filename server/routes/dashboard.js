/*
 * routes/dashboard.js — agent dashboard endpoints
 * Handles: /api/properties (list), /api/profile, /signup redirect
 */

const express = require("express");
const path = require("path");
const db = require("../db");

const asDate = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);

module.exports = function createDashboardRouter(ctx) {
  const { requireAuth, verifySession, readToken, authSecret, pageBaseUrl, webSignupBase } = ctx;

  const router = express.Router();

  // ── properties list ──
  router.get("/properties", requireAuth(authSecret), async (req, res) => {
    const listings = await db.listListingsByPhone(req.user.userId);
    listings.sort((a, b) => (asDate(b.created_at) || 0) - (asDate(a.created_at) || 0));
    const properties = [];
    for (const l of listings) {
      if (l.status === "archived") continue;
      const page = l.page_id ? await db.getPage(l.page_id).catch(() => null) : null;
      const expires = page ? asDate(page.expires_at) : null;
      properties.push({
        listing_id: l.listing_id,
        title: `${l.rooms || ""} חד׳ ב${l.neighborhood || l.city || ""}`.trim(),
        address: [l.address, l.city].filter(Boolean).join(", "),
        thumb_url: (l.photos_urls && l.photos_urls[0]) || null,
        page_id: l.page_id || null,
        page_url: l.page_id ? `${pageBaseUrl}/p/${l.page_id}` : null,
        page_status: page ? page.status : "building",
        days_left: expires ? Math.max(0, Math.ceil((expires.getTime() - Date.now()) / 86400000)) : null,
        view_count: (page && page.view_count) || 0,
        lead_count: (page && page.lead_count) || 0,
      });
    }
    res.json({ properties });
  });

  // ── profile (for completion check) ──
  router.get("/profile", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    if (!db.db) return res.json({ profile: null, needs_completion: false });
    try {
      const d = await db.getBusiness(phone);
      if (!d) return res.json({ profile: null, needs_completion: true });
      const state = String(d.onboarding_state || "");
      res.json({
        profile: {
          phone,
          full_name: d.full_name || "",
          business_name: d.business_name || "",
          logo_url: d.logo_url || null,
          onboarding_state: state,
          onboarding_pct: d.onboarding_pct || 0,
        },
        needs_completion: state !== "complete",
      });
    } catch (err) {
      console.error("get profile failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── signup redirect (logged-in → web form with phone) ──
  router.get("/signup", (req, res) => {
    const session = verifySession(authSecret, readToken(req));
    if (session && session.userId) {
      return res.redirect(`${webSignupBase}?phone=${encodeURIComponent(session.userId)}`);
    }
    res.sendFile(path.join(__dirname, "..", "..", "public-agent", "signup.html"));
  });

  return router;
};
