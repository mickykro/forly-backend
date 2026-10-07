/*
 * routes/dashboard.js — agent dashboard endpoints
 * Handles: /api/properties (list), /api/profile, /api/signup (registration)
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const db = require("../db");
const { REVIEW_SCOPES } = require("../auth");
const portalStream = require("../portal-stream");
const { sendWhatsAppRich, PUBLIC_BASE_URL, inPlace } = require("../utils");
const businessCache = require("../business-cache");
const portfolioEdit = require("../portfolio-edit");
const { buildFailed, retryBlocked } = require("../listing-create");

const asDate = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);

module.exports = function createDashboardRouter(ctx) {
  const { requireAuth, authSecret, pageBaseUrl, uploadDir, greenInstance, greenToken } = ctx;

  const router = express.Router();

  // ── properties list ──
  // Archived listings come back separately: the dashboard shows them under an
  // archive tab (with restore), never in the main list. Deleted ones are gone.
  router.get("/properties", requireAuth(authSecret), async (req, res) => {
    const listings = await db.listListingsByPhone(req.user.userId);
    listings.sort((a, b) => (asDate(b.created_at) || 0) - (asDate(a.created_at) || 0));
    const properties = [], archived = [];
    for (const l of listings) {
      if (l.status === "deleted") continue;
      const isArchived = l.status === "archived";
      const page = l.page_id ? await db.getPage(l.page_id).catch(() => null) : null;
      (isArchived ? archived : properties).push({
        listing_id: l.listing_id,
        title: `${l.rooms || ""} חד׳ ${inPlace(l.neighborhood || l.city)}`.trim(),
        address: [l.address, l.city].filter(Boolean).join(", "),
        thumb_url: (l.photos_urls && l.photos_urls[0]) || null,
        page_id: l.page_id || null,
        page_url: l.page_id ? `${pageBaseUrl}/p/${l.page_id}` : null,
        // A build that never produced a page reads "failed" (the card offers a
        // retry) instead of "building" forever.
        page_status: isArchived ? "archived" : page ? page.status : buildFailed(l) ? "failed" : "building",
        can_retry: !isArchived && !page && !retryBlocked(l),
        // Drives group matching on the distribution page: a sale listing must
        // not be pushed at rental-only groups.
        listing_type: (page && page.property && page.property.listing_type) ||
          l.listing_type || "sale",
        // Pages no longer expire — null hides the countdown bar in the UI.
        days_left: null,
        view_count: (page && page.view_count) || 0,
        lead_count: (page && page.lead_count) || 0,
      });
    }
    res.json({ properties, archived });
  });

  // ── profile (for completion check) ──
  // create.html probes this on load; the WhatsApp review link must pass it.
  router.get("/profile", requireAuth(authSecret, REVIEW_SCOPES), async (req, res) => {
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
          extra_phones: Array.isArray(d.extra_phones) ? d.extra_phones : [],
          onboarding_state: state,
          onboarding_pct: d.onboarding_pct || 0,
          portfolio_url: d.portfolio?.status === "open" ? `/${d.portfolio.slug}` : null,
          portfolio_status: d.portfolio?.status || null,
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
      // archived_from: restore puts a failed build back as failed, not active.
      await db.updateListing(listingId, mode === "archive"
        ? { status: "archived", archived_from: listing.status === "archived" ? (listing.archived_from || "active") : listing.status, archived_at: new Date() }
        : { status: "deleted" });
      if (listing.page_id) {
        await db.updatePage(listing.page_id, { status: "archived" });
        // Realtime: pull the card off the public portal immediately.
        portalStream.broadcast("listing_removed", { page_id: listing.page_id });
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

  // ── restore an archived property (owner only) ──
  // The page goes live again: dashboard, public page, portal and portfolio.
  router.post("/properties/restore", requireAuth(authSecret), async (req, res) => {
    const listingId = String((req.body && req.body.listing_id) || "");
    if (!listingId) return res.status(400).json({ error: "listing_id required" });
    const listing = await db.getListing(listingId);
    if (!listing) return res.status(404).json({ error: "not found" });
    if (listing.business_phone !== req.user.userId) return res.status(403).json({ error: "not_owner" });
    if (listing.status !== "archived") return res.status(409).json({ error: "not_archived" });
    try {
      const back = listing.archived_from === "failed" ? "failed" : "active";
      await db.updateListing(listingId, { status: back, archived_from: null, archived_at: null });
      if (listing.page_id) {
        await db.updatePage(listing.page_id, { status: "active", updated_at: new Date() });
        const fresh = await db.getPage(listing.page_id).catch(() => null);
        if (fresh) portalStream.broadcast("listing_added", portalStream.toCard(fresh, pageBaseUrl));
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("restoreProperty failed:", err);
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
      // ponytail: the page render path reads this doc through business-cache;
      // without this the agent's own pages lag their edit by up to the TTL.
      businessCache.invalidate(phone);
      // Welcome message is best-effort — a WhatsApp outage must not fail signup.
      try {
        await sendWhatsAppRich(phone, {
          header: "ברוכים הבאים לפורלי 🦉",
          body: `${fullName}, החשבון של ${businessName} מוכן!\n\n` +
            `מה עכשיו? נכנסים לפורלי, פותחים נכס ראשון — ` +
            `ותוך דקות יש לו דף נחיתה עם וידאו, גלריה ומידע על השכונה.`,
          footer: "",
          buttons: [{ type: "url", buttonText: "לכניסה לפורלי", url: PUBLIC_BASE_URL }],
        }, greenInstance, greenToken);
      } catch (err) { console.error("welcome send failed (signup still ok):", err.message); }
      res.json({ ok: true });
    } catch (err) {
      console.error("submitWebSignup failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── portfolio management (shared with the admin editor, see portfolio-edit.js) ──
  const sendPortfolioError = (res, err, what) => {
    if (err.message === "slug_taken") return res.status(409).json({ error: "slug_taken" });
    console.error(`${what} failed:`, err);
    res.status(500).json({ error: "internal" });
  };

  router.get("/my-portfolio", requireAuth(authSecret), async (req, res) => {
    try {
      res.json(await portfolioEdit.getPortfolio(req.user.userId));
    } catch (err) { sendPortfolioError(res, err, "GET /api/my-portfolio"); }
  });

  router.post("/my-portfolio", requireAuth(authSecret), async (req, res) => {
    try {
      const out = await portfolioEdit.savePortfolio(req.user.userId, req.body || {});
      if (!out) return res.status(404).json({ error: "not_found" });
      res.json({ ok: true, ...out });
    } catch (err) { sendPortfolioError(res, err, "POST /api/my-portfolio"); }
  });

  router.post("/my-portfolio/create", requireAuth(authSecret), async (req, res) => {
    try {
      res.json(await portfolioEdit.createPortfolio(req.user.userId));
    } catch (err) { sendPortfolioError(res, err, "POST /api/my-portfolio/create"); }
  });

  return router;
};
