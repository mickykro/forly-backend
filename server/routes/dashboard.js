/*
 * routes/dashboard.js — agent dashboard endpoints
 * Handles: /api/properties (list), /api/profile, /signup redirect
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const db = require("../db");
const { sendWhatsApp } = require("../utils");

const asDate = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);

module.exports = function createDashboardRouter(ctx) {
  const { requireAuth, verifySession, readToken, authSecret, pageBaseUrl, webSignupBase,
          uploadDir, greenInstance, greenToken } = ctx;

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

  // ── archive / delete a property (owner only) ──
  // "archive" hides it from the dashboard; "delete" also drops the page assets.
  router.post("/properties/delete", requireAuth(authSecret), async (req, res) => {
    const { listing_id: listingId, mode } = req.body || {};
    if (!listingId || (mode !== "archive" && mode !== "delete")) {
      return res.status(400).json({ error: "listing_id and mode(archive|delete) required" });
    }
    const listing = await db.getListing(listingId);
    if (!listing) return res.status(404).json({ error: "not found" });
    if (listing.business_phone !== req.user.userId) return res.status(403).json({ error: "not_owner" });
    try {
      await db.updateListing(listingId, { status: mode === "archive" ? "archived" : "deleted" });
      if (listing.page_id) {
        await db.updatePage(listing.page_id, { status: "archived" });
        if (mode === "delete") {
          fs.rm(path.join(uploadDir, "pages", listing.page_id), { recursive: true, force: true }, () => {});
        }
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("deleteProperty failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── complete web signup (session from signup-mode OTP) ──
  router.post("/signup", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    const body = req.body || {};
    const fullName = String(body.full_name || "").trim().slice(0, 60);
    const businessName = String(body.business_name || "").trim().slice(0, 60);
    if (fullName.length < 2 || businessName.length < 2) {
      return res.status(400).json({ error: "full_name and business_name required" });
    }
    const existing = await db.getBusiness(phone);
    if (existing && existing.signup_completed_at) return res.status(409).json({ error: "already_registered" });
    try {
      await db.setBusiness(phone, {
        phone, full_name: fullName, business_name: businessName,
        city: String(body.city || "").slice(0, 60),
        niche: String(body.niche || "nadlan").slice(0, 40),
        logo_url: body.logo_url || null,
        logo_requested: body.wants_generated_logo === true && !body.logo_url,
        source: "web_signup", signup_completed_at: new Date(),
        total_inquiries_reported: 0, total_deals_closed: 0,
        created_at: existing ? existing.created_at : new Date(),
      }, true);
      // Welcome message is best-effort — a WhatsApp outage must not fail signup.
      try {
        await sendWhatsApp(phone,
          `ברוכים הבאים לפורלי 🦉\n${fullName}, החשבון של ${businessName} מוכן!\n\n` +
          `מה עכשיו? נכנסים ל-agent.call4li.com, פותחים נכס ראשון — ` +
          `ותוך דקות יש לו דף נחיתה עם וידאו, גלריה ומידע על השכונה.`,
          greenInstance, greenToken);
      } catch (err) { console.error("welcome send failed (signup still ok):", err.message); }
      res.json({ ok: true });
    } catch (err) {
      console.error("submitWebSignup failed:", err);
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
