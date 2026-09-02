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
const readiness = require("../chatbot-readiness");
const chatbotConfig = require("../chatbot-config");
const businessCache = require("../business-cache");
const { deliverAgentMessage, MAX_RECIPIENTS } = require("../admin-messages");

const PAGE_LIFESPAN_DAYS = 30;
const asDate = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);
const asMillis = (v) => { const d = asDate(v); return d ? d.getTime() : 0; };

module.exports = function createAdminRouter(ctx) {
  const { verifySession, readToken, authSecret, normalizeAuthPhone, pageBaseUrl,
          uploadDir, adminPhones, sendWhatsApp, quota } = ctx;

  const router = express.Router();

  // Normalize the allowlist once so "050-…", "+972…" and "972…" all match the
  // session's canonical phone form.
  const allow = new Set(
    (adminPhones || [])
      .map((p) => normalizeAuthPhone(p))
      .filter(Boolean)
  );

  // The allowlist above is normalized, so the session side must be too —
  // comparing a raw userId against it only happens to work because the OTP
  // flow signs an already-canonical phone. Normalizing is idempotent, so this
  // costs nothing and stops a differently-signed session silently losing admin.
  const isAdmin = (session) =>
    !!session && allow.has(normalizeAuthPhone(session.userId) || "");

  // ── requireAdmin: valid session AND phone on the allowlist ──
  function requireAdmin(req, res, next) {
    const session = verifySession(authSecret, readToken(req));
    if (!session) return res.status(401).json({ error: "unauthenticated" });
    if (!isAdmin(session)) return res.status(403).json({ error: "not_admin" });
    req.user = session;
    next();
  }

  // ── who am I / gate check for the frontend ──
  router.get("/me", (req, res) => {
    const session = verifySession(authSecret, readToken(req));
    if (!session) return res.status(401).json({ error: "unauthenticated" });
    if (!isAdmin(session)) return res.status(403).json({ error: "not_admin" });
    res.json({ ok: true, is_admin: true, phone: session.userId });
  });

  // ── agent WhatsApp messaging ──
  router.post("/messages", requireAdmin, async (req, res) => {
    const body = req.body || {};
    const audience = body.audience === "all" ? "all" : body.audience === "selected" ? "selected" : "";
    if (!audience || (audience === "selected" && !Array.isArray(body.phones))) {
      return res.status(400).json({ error: "invalid_input" });
    }
    try {
      const agents = (await db.listAllBusinesses()).filter((agent) => agent.phone);
      const phones = audience === "all" ? agents.map((agent) => agent.phone) : body.phones;
      const result = await deliverAgentMessage({
        agents,
        recipientPhones: phones,
        message: body.message,
        send: sendWhatsApp,
        record: db.addAdminMessage,
        sentBy: req.user.userId,
      });
      console.log(`admin_agent_message recipients=${result.recipientCount} by=${req.user.userId}`);
      res.json({ ok: true, recipient_count: result.recipientCount });
    } catch (err) {
      const error = err && err.message;
      if (["message_required", "message_too_long", "no_recipients", "too_many_recipients"].includes(error)) {
        return res.status(400).json({ error, max_recipients: MAX_RECIPIENTS });
      }
      console.error("admin/messages failed:", err);
      res.status(502).json({ error: "delivery_failed" });
    }
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
      const agentPhones = new Set();   // agents = businesses that actually have listings
      let totalViews = 0;
      let totalLeads = 0;
      let activePages = 0;

      for (const l of listings) {
        if (l.status === "deleted") continue;
        if (l.business_phone) agentPhones.add(l.business_phone);
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
          // {page: true|false|null(inherit), effective, reason} — drives the
          // per-page selector. No extra read: page and biz are already loaded.
          chatbot: page ? chatbotConfig.adminState(page, biz, process.env) : null,
        });
      }

      properties.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

      res.json({
        properties,
        stats: {
          total_properties: properties.length,
          total_agents: agentPhones.size,
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

  // ── agent directory: one row per agent, with their premium feature flags ──
  // The property table is one row per listing, so a per-property toggle would
  // show an agent with six listings six switches that all set the same flag.
  // Features belong to the agent, so they get their own view.
  router.get("/agents", requireAdmin, async (req, res) => {
    try {
      const [businesses, pages, listings] = await Promise.all([
        db.listAllBusinesses(),
        db.listAllPages(),
        db.listAllListings(),
      ]);
      const listingById = new Map(listings.map((l) => [l.listing_id, l]));

      // Roll each agent's pages up, so the toggle sits next to the evidence for
      // whether flipping it is a good idea (see chatbot-readiness.js).
      const byPhone = new Map();
      for (const b of businesses) {
        byPhone.set(b.phone, {
          phone: b.phone,
          name: b.business_name || b.full_name || "—",
          plan: b.plan || "",
          onboarding_state: b.onboarding_state || "",
          is_demo: b.source === "demo" || b.onboarding_state === "demo_partial",
          chatbot_enabled: !!(b.features && b.features.chatbot),
          distribution_enabled: !!(b.features && b.features.distribution),
          portfolio_status: b.portfolio?.status || null,
          portfolio_url: b.portfolio?.status === "open" ? `${pageBaseUrl}/${b.portfolio.slug}` : null,
          pages: 0, active_pages: 0, views: 0, leads: 0,
          readiness: { rich: 0, ok: 0, thin: 0 },
        });
      }
      for (const p of pages) {
        const row = byPhone.get(p.business_phone);
        if (!row || p.status === "archived") continue;
        row.pages++;
        if (p.status === "active" || p.status === "expiring") row.active_pages++;
        row.views += p.view_count || 0;
        row.leads += p.lead_count || 0;
        const { verdict } = readiness.scorePage(
          p, p.listing_id ? listingById.get(p.listing_id) || null : null
        );
        row.readiness[verdict]++;
      }

      // Quota ledger per agent (what they paid for vs. used). One read each;
      // best-effort so a ledger hiccup never hides the directory.
      if (quota) {
        await Promise.all([...byPhone.values()].map(async (row) => {
          row.quota = await quota.getQuota(row.phone).catch(() => null);
        }));
      }

      const agents = [...byPhone.values()]
        .sort((a, b) => (b.active_pages - a.active_pages) || a.name.localeCompare(b.name, "he"));
      res.json({
        agents,
        stats: {
          total_agents: agents.length,
          chatbot_agents: agents.filter((a) => a.chatbot_enabled).length,
          chatbot_pages: agents.reduce((n, a) => n + (a.chatbot_enabled ? a.active_pages : 0), 0),
        },
      });
    } catch (err) {
      console.error("admin/agents failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── grant/revoke a premium feature for one agent ──
  // Flipping this on turns the bot on for every page that agent owns, old ones
  // included: entitlement is resolved live from the business, never stamped
  // onto the page. Revoking is immediate in the same way.
  // Flipping "distribution" arms the page-ready hook for every future page
  // that agent creates (resolved live, like chatbot). Off by default —
  // pilots first (spec §2 "Rollout").
  const FEATURES = new Set(["chatbot", "distribution"]);

  router.post("/business/features", requireAdmin, async (req, res) => {
    const body = req.body || {};
    const phone = normalizeAuthPhone(body.phone || "");
    const feature = String(body.feature || "");
    // Whitelisted so an admin session can never write an arbitrary key onto a
    // business document just by renaming the field in the request.
    if (!phone || !FEATURES.has(feature) || typeof body.enabled !== "boolean") {
      return res.status(400).json({ error: "invalid_input" });
    }
    try {
      const biz = await db.getBusiness(phone);
      if (!biz) return res.status(404).json({ error: "unknown_agent" });
      const features = Object.assign({}, biz.features || {}, { [feature]: body.enabled });
      await db.setBusiness(phone, { features, updated_at: new Date() });
      // Pages resolve the entitlement through a 60s cache; drop it so the
      // change is visible on the next request instead of up to a minute later.
      businessCache.invalidate(phone);
      console.log(`admin_feature_set feature=${feature} enabled=${body.enabled} ` +
        `agent=${phone} by=${req.user.userId}`);
      res.json({ ok: true, phone, feature, enabled: body.enabled });
    } catch (err) {
      console.error("admin/business/features failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── quotas: what this client paid for ──
  // GET  /business/quota?phone=          → ledger + recent blocked attempts + history
  // POST /business/quota { phone, caps:{kind:n|null}, reset_used:[kind], plan, notes }
  // Kinds are whitelisted inside quota.js; every change lands in quota_history.
  router.get("/business/quota", requireAdmin, async (req, res) => {
    const phone = normalizeAuthPhone(String(req.query.phone || ""));
    if (!phone || !quota) return res.status(400).json({ error: "invalid_input" });
    try {
      const [ledger, events, history] = await Promise.all([
        quota.getQuota(phone), quota.events(phone, 10), quota.history(phone, 30),
      ]);
      res.json({ phone, quota: ledger, events, history });
    } catch (err) {
      console.error("admin/business/quota get failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  router.post("/business/quota", requireAdmin, async (req, res) => {
    const body = req.body || {};
    const phone = normalizeAuthPhone(body.phone || "");
    if (!phone || !quota) return res.status(400).json({ error: "invalid_input" });
    try {
      const biz = await db.getBusiness(phone);
      if (!biz) return res.status(404).json({ error: "unknown_agent" });
      const r = await quota.setCaps(phone, {
        caps: body.caps && typeof body.caps === "object" ? body.caps : {},
        reset_used: Array.isArray(body.reset_used) ? body.reset_used.map(String) : [],
        plan: typeof body.plan === "string" ? body.plan : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
      }, req.user.userId);
      console.log(`admin_quota_set agent=${phone} by=${req.user.userId} changes=${JSON.stringify(r.changes)}`);
      res.json({ ok: true, phone, changes: r.changes, quota: r.quota });
    } catch (err) {
      console.error("admin/business/quota set failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── per-page chat-bot override ──
  // enabled:true forces the bot on for one page even when the agent is off;
  // false forces it off even when the agent is on; null clears back to
  // inheriting the agent's entitlement (see chatbot-config.js).
  router.post("/page/chatbot", requireAdmin, async (req, res) => {
    const body = req.body || {};
    const pageId = String(body.page_id || "");
    const enabled = body.enabled;
    if (!pageId || !(enabled === true || enabled === false || enabled === null)) {
      return res.status(400).json({ error: "invalid_input" });
    }
    try {
      const page = await db.getPage(pageId);
      if (!page) return res.status(404).json({ error: "not_found" });
      await db.updatePage(pageId, { "chatbot.enabled": enabled, updated_at: new Date() });
      const biz = await businessCache.get(page.business_phone);
      const state = chatbotConfig.adminState(
        Object.assign({}, page, { chatbot: Object.assign({}, page.chatbot, { enabled }) }),
        biz, process.env
      );
      console.log(`admin_page_chatbot page=${pageId} enabled=${enabled} ` +
        `effective=${state.effective} by=${req.user.userId}`);
      res.json({ ok: true, page_id: pageId, chatbot: state });
    } catch (err) {
      console.error("admin/page/chatbot failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // ── chatbot readiness: what would the bot actually know, page by page? ──
  // Read-only. Run this before granting an agent the chatbot so you can see
  // which of their existing pages carry enough data to hold a conversation —
  // older pages predate the area/carousel work and can be very thin.
  //   ?verdict=thin   only pages that would hand off almost immediately
  //   ?phone=…        one agent's back catalogue
  router.get("/chatbot-readiness", requireAdmin, async (req, res) => {
    try {
      const [pages, listings, businesses] = await Promise.all([
        db.listAllPages(),
        db.listAllListings(),
        db.listAllBusinesses(),
      ]);
      // Map once rather than a getListing() per page — this scans everything.
      const listingById = new Map(listings.map((l) => [l.listing_id, l]));
      const bizByPhone = new Map(businesses.map((b) => [b.phone, b]));

      const wantPhone = normalizeAuthPhone(req.query.phone || "") || null;
      const wantVerdict = String(req.query.verdict || "").trim() || null;

      const reports = [];
      for (const p of pages) {
        if (p.status === "archived") continue;
        const phone = p.business_phone || "";
        if (wantPhone && normalizeAuthPhone(phone) !== wantPhone) continue;

        const biz = bizByPhone.get(phone);
        const { verdict, signals, gaps } = readiness.scorePage(
          p, p.listing_id ? listingById.get(p.listing_id) || null : null
        );
        if (wantVerdict && verdict !== wantVerdict) continue;

        reports.push({
          page_id: p.page_id,
          page_url: `${pageBaseUrl}/p/${p.page_id}`,
          page_status: p.status || "",
          title: (p.property && p.property.title) || "—",
          business_phone: phone,
          agent_name: (biz && (biz.business_name || biz.full_name)) ||
            (p.agent && (p.agent.brand_name || p.agent.name)) || "—",
          // Entitlement as it stands today. Flipping this on the business turns
          // the bot on for every page that agent owns, this one included.
          chatbot_enabled: !!(biz && biz.features && biz.features.chatbot),
          verdict,
          signals,
          gaps,
        });
      }

      const order = { thin: 0, ok: 1, rich: 2 };
      reports.sort((a, b) => (order[a.verdict] - order[b.verdict]) ||
        (a.signals.description_chars - b.signals.description_chars));

      res.json({ summary: readiness.summarize(reports), pages: reports });
    } catch (err) {
      console.error("admin/chatbot-readiness failed:", err);
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

  // ── portfolio status (admin-only open/close) ──
  router.post("/portfolio-status", requireAdmin, async (req, res) => {
    const body = req.body || {};
    const phone = normalizeAuthPhone(body.business_phone || "");
    const status = String(body.status || "");
    if (!phone || (status !== "open" && status !== "closed")) {
      return res.status(400).json({ error: "business_phone and status(open|closed) required" });
    }
    try {
      const biz = await db.getBusiness(phone);
      if (!biz || !biz.portfolio) return res.status(404).json({ error: "portfolio_not_found" });
      await db.setBusiness(phone, {
        "portfolio.status": status,
        "portfolio.updated_at": new Date(),
      }, true);
      console.log(`admin_portfolio_status phone=${phone} status=${status} by=${req.user.userId}`);
      res.json({
        ok: true,
        status,
        portfolio_url: status === "open" ? `${pageBaseUrl}/${biz.portfolio.slug}` : null,
      });
    } catch (err) {
      console.error("admin/portfolio-status failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  return router;
};
