/*
 * routes/dashboard.js — agent dashboard endpoints
 * Handles: /api/properties (list), /api/profile, /api/signup (registration)
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const db = require("../db");
const portalStream = require("../portal-stream");
const { sendWhatsApp } = require("../utils");
const { portfolioSlug, normalizePortfolio, visiblePortfolioPages, nextPortfolioStatus } = require("../portfolio");

const asDate = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);

module.exports = function createDashboardRouter(ctx) {
  const { requireAuth, authSecret, pageBaseUrl, uploadDir, greenInstance, greenToken } = ctx;

  const router = express.Router();

  // ── properties list ──
  router.get("/properties", requireAuth(authSecret), async (req, res) => {
    const listings = await db.listListingsByPhone(req.user.userId);
    listings.sort((a, b) => (asDate(b.created_at) || 0) - (asDate(a.created_at) || 0));
    const properties = [];
    for (const l of listings) {
      if (l.status === "archived") continue;
      const page = l.page_id ? await db.getPage(l.page_id).catch(() => null) : null;
      properties.push({
        listing_id: l.listing_id,
        title: `${l.rooms || ""} חד׳ ב${l.neighborhood || l.city || ""}`.trim(),
        address: [l.address, l.city].filter(Boolean).join(", "),
        thumb_url: (l.photos_urls && l.photos_urls[0]) || null,
        page_id: l.page_id || null,
        page_url: l.page_id ? `${pageBaseUrl}/p/${l.page_id}` : null,
        page_status: page ? page.status : "building",
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
          portfolio_enabled: !!(d.features && d.features.portfolio),
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
      await db.updateListing(listingId, { status: mode === "archive" ? "archived" : "deleted" });
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

  // ── portfolio management ──
  // Entitlement lives on the business doc (businesses/{phone}.features.portfolio)
  // and is flipped from the admin panel, same shape as features.chatbot.
  const portfolioEnabled = (business) => !!(business && business.features && business.features.portfolio);

  router.get("/my-portfolio", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    try {
      const business = await db.getBusiness(phone);
      if (!portfolioEnabled(business)) return res.status(403).json({ error: "feature_disabled" });
      if (!business) return res.json({ profile: { business_name: "", full_name: "", city: "", license_number: "", logo_url: null }, portfolio: null, pages: [] });
      const pages = await db.listPagesByPhone(phone, 100);
      const portfolio = business.portfolio || null;
      res.json({
        profile: {
          business_name: business.business_name || "",
          full_name: business.full_name || "",
          city: business.city || "",
          license_number: business.license_number || "",
          logo_url: business.logo_url || null,
        },
        portfolio: portfolio ? {
          ...portfolio,
          url: `/${portfolio.slug}`,
        } : null,
        pages: pages.map((p) => ({
          page_id: p.page_id,
          title: p.property?.title || "",
          address: p.property?.address || "",
          status: p.status,
          public_slug: p.public_slug,
          portfolio_visible: p.portfolio_visible ?? true,
          portfolio_rank: p.portfolio_rank ?? null,
        })),
      });
    } catch (err) {
      console.error("GET /api/my-portfolio failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  router.post("/my-portfolio", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    const body = req.body || {};
    try {
      const business = await db.getBusiness(phone);
      if (!business) return res.status(404).json({ error: "not_found" });
      if (!portfolioEnabled(business)) return res.status(403).json({ error: "feature_disabled" });
      const existing = business.portfolio || {};

      // Handle business name change → slug reservation
      const newBizName = body.business_name?.trim() || business.business_name;
      let newSlug = existing.slug;
      if (newBizName !== business.business_name && existing.slug) {
        newSlug = portfolioSlug(newBizName);
        await db.reservePortfolioSlug(phone, newSlug, existing.slug);
      }

      // Normalize portfolio config
      const portfolioInput = body.portfolio || {};
      const normalized = normalizePortfolio(portfolioInput, existing);
      normalized.slug = newSlug || existing.slug;
      normalized.status = existing.status || "draft";

      // Update business doc
      await db.setBusiness(phone, {
        business_name: newBizName,
        full_name: body.full_name?.trim() || business.full_name,
        city: body.city?.trim() || business.city,
        license_number: body.license_number?.trim() || business.license_number,
        logo_url: body.logo_url ?? business.logo_url,
        portfolio: normalized,
      }, true);

      // Update page visibility/rank if provided
      if (Array.isArray(body.portfolio?.properties)) {
        const pages = await db.listPagesByPhone(phone, 100);
        const pageMap = new Map(pages.map((p) => [p.page_id, p]));
        for (const prop of body.portfolio.properties) {
          if (!prop.page_id || !pageMap.has(prop.page_id)) continue;
          await db.updatePage(prop.page_id, {
            portfolio_visible: prop.portfolio_visible ?? true,
            portfolio_rank: prop.portfolio_rank ?? null,
          });
        }
      }

      res.json({
        ok: true,
        portfolio_url: `/${normalized.slug}`,
      });
    } catch (err) {
      if (err.message === "slug_taken") {
        return res.status(409).json({ error: "slug_taken" });
      }
      console.error("POST /api/my-portfolio failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  router.post("/my-portfolio/create", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    try {
      let business = await db.getBusiness(phone);
      if (!portfolioEnabled(business)) return res.status(403).json({ error: "feature_disabled" });
      // Create minimal business record if none exists
      if (!business) {
        const now = new Date();
        await db.setBusiness(phone, { phone, created_at: now }, true);
        business = { phone };
      }
      if (business.portfolio?.slug) {
        return res.json({
          created: false,
          portfolio_url: `/${business.portfolio.slug}`,
        });
      }
      // Create new portfolio
      const slug = portfolioSlug(business.business_name || business.full_name || phone);
      await db.reservePortfolioSlug(phone, slug);
      const now = new Date();
      await db.setBusiness(phone, {
        portfolio: {
          slug,
          status: "open",
          hero: { headline: "", intro: "", portrait_url: null },
          about: { body: "" },
          area: { headline: "", body: "", locations: [] },
          testimonials: [],
          theme: { primary: null, accent: null, font_url: null },
          created_at: now,
          updated_at: now,
        },
      }, true);
      res.json({
        created: true,
        portfolio_url: `/${slug}`,
      });
    } catch (err) {
      if (err.message === "slug_taken") {
        return res.status(409).json({ error: "slug_taken" });
      }
      console.error("POST /api/my-portfolio/create failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  return router;
};
