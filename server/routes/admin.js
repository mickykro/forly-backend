/*
 * routes/admin.js — operator admin panel (mounted at /api/admin)
 *
 * Unlike the agent dashboard (which is scoped to the logged-in phone), these
 * endpoints span EVERY agent's listings and pages. Access is gated by an
 * allowlist of admin phone numbers (ADMIN_PHONES env), checked on top of the
 * normal WhatsApp-OTP session. A logged-in agent who is not on the allowlist
 * gets 403 — never a silent pass.
 *
 *   GET  /api/admin/me                 → { is_admin, phone }
 *   GET  /api/admin/properties         → every property + agent + page stats
 *   POST /api/admin/page/extend        → extend ANY page by 30 days
 *   POST /api/admin/properties/delete  → archive/delete ANY listing
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const db = require("../db");

const PAGE_LIFESPAN_DAYS = 30;
const asDate = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);
const asMillis = (v) => { const d = asDate(v); return d ? d.getTime() : 0; };

module.exports = function createAdminRouter(ctx) {
  const { verifySession, readToken, authSecret, normalizeAuthPhone, pageBaseUrl,
          uploadDir, adminPhones } = ctx;

  const router = express.Router();

  // Normalize the allowlist once so "050-…", "+972…" and "972…" all match the
  // session's canonical phone form.
  const allow = new Set(
    (adminPhones || [])
      .map((p) => normalizeAuthPhone(p))
      .filter(Boolean)
  );

  // ── requireAdmin: valid session AND phone on the allowlist ──
  function requireAdmin(req, res, next) {
    const session = verifySession(authSecret, readToken(req));
    if (!session) return res.status(401).json({ error: "unauthenticated" });
    if (!allow.has(session.userId)) return res.status(403).json({ error: "not_admin" });
    req.user = session;
    next();
  }

  // ── who am I / gate check for the frontend ──
  router.get("/me", (req, res) => {
    const session = verifySession(authSecret, readToken(req));
    if (!session) return res.status(401).json({ error: "unauthenticated" });
    const isAdmin = allow.has(session.userId);
    if (!isAdmin) return res.status(403).json({ error: "not_admin" });
    res.json({ ok: true, is_admin: true, phone: session.userId });
  });

  // ── every property across every agent, joined with page stats + agent name ──
  router.get("/properties", requireAdmin, async (req, res) => {
    try {
      const [listings, pages, businesses] = await Promise.all([
        db.listAllListings(),
        db.listAllPages(),
        db.listAllBusinesses(),
      ]);

      const pageById = new Map(pages.map((p) => [p.page_id, p]));
      const bizByPhone = new Map(businesses.map((b) => [b.phone, b]));

      const properties = [];
      let totalViews = 0;
      let totalLeads = 0;
      let activePages = 0;

      for (const l of listings) {
        if (l.status === "deleted") continue;
        const page = l.page_id ? pageById.get(l.page_id) : null;
        const biz = bizByPhone.get(l.business_phone);
        const expires = page ? asDate(page.expires_at) : null;
        const views = (page && page.view_count) || 0;
        const leads = (page && page.lead_count) || 0;
        const pageStatus = page ? page.status : "building";
        totalViews += views;
        totalLeads += leads;
        if (pageStatus === "active" || pageStatus === "expiring") activePages += 1;

        properties.push({
          listing_id: l.listing_id,
          business_phone: l.business_phone,
          agent_name: (biz && (biz.business_name || biz.full_name)) ||
            (l.agent && (l.agent.brand_name || l.agent.name)) || "—",
          title: `${l.rooms || ""} חד׳ ב${l.neighborhood || l.city || ""}`.trim(),
          address: [l.address, l.city].filter(Boolean).join(", "),
          city: l.city || "",
          price: l.price || 0,
          thumb_url: (l.photos_urls && l.photos_urls[0]) || null,
          listing_status: l.status || "active",
          page_id: l.page_id || null,
          page_url: l.page_id ? `${pageBaseUrl}/p/${l.page_id}` : null,
          page_status: pageStatus,
          days_left: expires ? Math.max(0, Math.ceil((expires.getTime() - Date.now()) / 86400000)) : null,
          view_count: views,
          lead_count: leads,
          created_at: asMillis(l.created_at) || null,
        });
      }

      properties.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

      res.json({
        properties,
        stats: {
          total_properties: properties.length,
          total_agents: businesses.length,
          active_pages: activePages,
          total_views: totalViews,
          total_leads: totalLeads,
        },
      });
    } catch (err) {
      console.error("admin/properties failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── extend ANY page by 30 days (no owner check — admin scope) ──
  router.post("/page/extend", requireAdmin, async (req, res) => {
    const pageId = String((req.body && req.body.page_id) || "");
    if (!pageId) return res.status(400).json({ error: "page_id required" });
    const page = await db.getPage(pageId);
    if (!page) return res.status(404).json({ error: "not found" });
    try {
      const from = Math.max(Date.now(), asMillis(page.expires_at));
      const expiresAt = new Date(from + PAGE_LIFESPAN_DAYS * 86400000);
      await db.updatePage(pageId, {
        expires_at: expiresAt, status: "active",
        extension_count: (page.extension_count || 0) + 1,
        reminder_sent_at: null, updated_at: new Date(),
      });
      res.json({ ok: true, expires_at: expiresAt.toISOString() });
    } catch (err) {
      console.error("admin/page/extend failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── archive / delete ANY listing (no owner check — admin scope) ──
  // "archive" hides the page from the public; "delete" also drops page assets.
  router.post("/properties/delete", requireAdmin, async (req, res) => {
    const { listing_id: listingId, mode } = req.body || {};
    if (!listingId || (mode !== "archive" && mode !== "delete")) {
      return res.status(400).json({ error: "listing_id and mode(archive|delete) required" });
    }
    const listing = await db.getListing(listingId);
    if (!listing) return res.status(404).json({ error: "not found" });
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
      console.error("admin/properties/delete failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  return router;
};
