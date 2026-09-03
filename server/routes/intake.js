/*
 * routes/intake.js — demo form uploads + property creation
 * Handles: /api/upload-urls, /api/upload/:fname, /api/properties/demo-create,
 *          /api/properties/create, /api/demo-save-agent, /api/listing-status
 */

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const db = require("../db");
const pageEdit = require("../edit");
const { sanitizeTheme, sanitizeLang, sniffMatchesExt } = require("../utils");
const { sanitizeTags } = require("../tags");
const { makeAdminGuard } = require("../admin-auth");

const MAX_UPLOAD_FILES = 12;
const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const VIDEO_TYPES = { "video/mp4": "mp4", "video/quicktime": "mp4" };
const FONT_TYPES = { "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf" };
const FONT_EXTS = { woff2: "woff2", woff: "woff", ttf: "ttf", otf: "otf" };
const MAX_IMAGE_MB = 10;
const MAX_VIDEO_MB = 120;
const MAX_FONT_MB = 5;

module.exports = function createIntakeRouter(ctx) {
  const { requireAuth, normalizeAuthPhone, signSession, uploadDir, uploadPublicBase, remoteUploadBase,
    n8nWw1Webhook, n8nPipelineWebhook, authSecret, sessionTtl, pageBaseUrl, isDevRun, isDevPipelineRun,
    baseUrl, verifySession, readToken, adminPhones, quota } = ctx;

  const router = express.Router();

  // The demo flow mints a session for a client-supplied phone, so it is gated
  // to logged-in operator admins (ADMIN_PHONES) rather than the mere presence
  // of an x-demo-key header, which anyone could send.
  const { requireAdmin } = makeAdminGuard({ verifySession, readToken, authSecret, adminPhones });

  // Inter-instance relay secret: when this server fronts a remote file store
  // (REMOTE_UPLOAD_BASE), it forwards the caller's own session so the remote —
  // running this same code — re-authorizes the write. No new secret needed.
  const relayHeaders = (req) => {
    const h = {};
    if (req.headers.cookie) h.cookie = req.headers.cookie;
    if (req.headers.authorization) h.authorization = req.headers.authorization;
    return h;
  };

  // ── upload-urls ──
  // Any authenticated user (agent or admin) may request upload slots; the
  // header bypass is gone.
  const uploadAuth = requireAuth(authSecret);

  router.post("/upload-urls", uploadAuth, (req, res) => {
    const files = req.body && req.body.files;
    if (!Array.isArray(files) || files.length < 1 || files.length > MAX_UPLOAD_FILES) {
      return res.status(400).json({ error: `1-${MAX_UPLOAD_FILES} files` });
    }
    const slots = [];
    for (const f of files) {
      const ct = String((f && f.contentType) || "");
      const nameExt = String((f && f.name) || "").split(".").pop().toLowerCase();
      const ext = IMAGE_TYPES[ct] || VIDEO_TYPES[ct] || FONT_TYPES[ct] || FONT_EXTS[nameExt];
      if (!ext) return res.status(400).json({ error: `unsupported type: ${ct}` });
      const isVideo = ext === "mp4";
      const isFont = ext in FONT_EXTS;
      const fname = `${crypto.randomUUID()}.${ext}`;
      slots.push({
        name: (f && f.name) || fname,
        upload_url: `/api/upload/${fname}`,
        method: "PUT",
        content_type: ct,
        public_url: `${uploadPublicBase}/files/${fname}`,
        max_mb: isVideo ? MAX_VIDEO_MB : isFont ? MAX_FONT_MB : MAX_IMAGE_MB,
      });
    }
    res.json({ files: slots });
  });

  // ── upload binary ──
  // Authenticated (agent or admin); the remote-store relay forwards the same
  // session so the remote instance re-authorizes rather than trusting the hop.
  const rawBody = express.raw({ type: () => true, limit: `${MAX_VIDEO_MB}mb` });
  router.put("/upload/:fname", uploadAuth, rawBody, async (req, res) => {
    const fname = req.params.fname;
    const m = /^[0-9a-f-]{36}\.(jpg|png|webp|mp4|woff2|woff|ttf|otf)$/.exec(fname);
    if (!m) {
      return res.status(400).json({ error: "bad filename" });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "empty body" });
    }
    const ext = m[1];
    const isVideo = ext === "mp4";
    const isFont = /^(woff2|woff|ttf|otf)$/.test(ext);
    const maxMb = isVideo ? MAX_VIDEO_MB : isFont ? MAX_FONT_MB : MAX_IMAGE_MB;
    if (req.body.length > maxMb * 1024 * 1024) {
      return res.status(413).json({ error: "too large" });
    }
    // Content must match the claimed extension — a ".png" that is really
    // HTML/JS is rejected before it can be served from the public /files store.
    if (!sniffMatchesExt(req.body, ext)) {
      return res.status(400).json({ error: "content does not match file type" });
    }
    if (remoteUploadBase) {
      try {
        const r = await fetch(`${remoteUploadBase}/api/upload/${fname}`, {
          method: "PUT",
          headers: {
            ...relayHeaders(req),
            "Content-Type": req.headers["content-type"] || "application/octet-stream",
          },
          body: req.body,
          signal: AbortSignal.timeout(120000),
        });
        if (!r.ok) return res.status(502).json({ error: `remote upload failed: ${r.status}` });
        return res.json({ ok: true, remote: true });
      } catch (err) {
        return res.status(502).json({ error: `remote upload failed: ${err.message}` });
      }
    }
    fs.writeFileSync(path.join(uploadDir, fname), req.body);
    res.json({ ok: true });
  });

  // Remove an uploaded file (the form deletes photos the user takes back out).
  router.delete("/upload/:fname", uploadAuth, async (req, res) => {
    const fname = req.params.fname;
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp|mp4|woff2|woff|ttf|otf)$/.test(fname)) {
      return res.status(400).json({ error: "bad filename" });
    }
    if (remoteUploadBase) {
      try {
        await fetch(`${remoteUploadBase}/api/upload/${fname}`, {
          method: "DELETE",
          headers: relayHeaders(req),
          signal: AbortSignal.timeout(20000),
        });
      } catch { /* best-effort */ }
      return res.json({ ok: true });
    }
    try { fs.unlinkSync(path.join(uploadDir, fname)); } catch { /* already gone */ }
    res.json({ ok: true });
  });

  // ── shared listing creation ──
  // Validation is separate so the quota is only consumed for a request that
  // would actually create something (a 400 must not burn a paid creation).
  function validateListing(body) {
    if (!body.address || !body.city || !body.price || !body.rooms) {
      return { error: "address, city, price, rooms are required", code: 400 };
    }
    if (!Array.isArray(body.photos_urls) || body.photos_urls.length < 3) {
      return { error: "at least 3 photos required", code: 400 };
    }
    return null;
  }

  async function createListing(phone, body, agentOverride) {
    const invalid = validateListing(body);
    if (invalid) return invalid;
    const listingId = crypto.randomUUID();
    const listing = {
      listing_id: listingId, business_phone: phone, source: "dashboard",
      address: String(body.address).slice(0, 120),
      neighborhood: String(body.neighborhood || "").slice(0, 60),
      city: String(body.city).slice(0, 60),
      listing_type: body.listing_type === "rent" ? "rent" : "sale",
      price: Number(body.price) || 0, rooms: Number(body.rooms) || 0,
      size_sqm: Number(body.size_sqm) || 0, floor: Number(body.floor) || 0,
      size_built: Number(body.size_built) || 0,
      size_balcony: Number(body.size_balcony) || 0,
      size_garden: Number(body.size_garden) || 0,
      parking: Number(body.parking) || 0,
      storage: !!body.storage,
      elevator: !!body.elevator || !!body.shabbat_elevator,
      shabbat_elevator: !!body.shabbat_elevator,
      tags: sanitizeTags(body.tags),
      description: String(body.description || "").slice(0, 2000),
      photos_urls: body.photos_urls.slice(0, MAX_UPLOAD_FILES),
      own_video_url: body.own_video_url || null,
      status: "active", page_id: null,
      agent: agentOverride ? {
        name: String(agentOverride.name || ""),
        brand_name: String(agentOverride.brand_name || agentOverride.name || ""),
        logo_url: agentOverride.logo_url || null,
        tagline: String(agentOverride.tagline || ""),
        phone: String(agentOverride.phone || phone),
        phone2: agentOverride.phone2
          ? String(agentOverride.phone2).replace(/\D/g, "").slice(0, 15) || null
          : null,
        license: String(agentOverride.license || ""),
      } : null,
      agent2: body.agent2 && body.agent2.name && body.agent2.phone ? {
        name: String(body.agent2.name).slice(0, 60),
        phone: String(body.agent2.phone).replace(/\D/g, "").slice(0, 15),
      } : null,
      theme: sanitizeTheme(body.theme),
      language: sanitizeLang(body.language),
      created_at: new Date(),
    };
    await db.saveListing(listing);

    const webhook = listing.own_video_url ? n8nPipelineWebhook : n8nWw1Webhook;
    const payload = listing.own_video_url ? {
      listing_id: listingId, business_phone: phone, video_url: listing.own_video_url,
      language: listing.language, dev: !!isDevPipelineRun, base_url: baseUrl,
    } : {
      phone, image_urls: listing.photos_urls, listing_id: listingId, trigger_source: "dashboard",
      language: listing.language, dev: !!isDevRun, base_url: baseUrl,
      property_details: {
        listing_type: listing.listing_type,
        address: listing.address, neighborhood: listing.neighborhood, city: listing.city,
        price: listing.price, rooms: listing.rooms, size_sqm: listing.size_sqm,
        size_built: listing.size_built, size_balcony: listing.size_balcony,
        size_garden: listing.size_garden,
        floor: listing.floor, parking: listing.parking,
        storage: listing.storage, elevator: listing.elevator,
        shabbat_elevator: listing.shabbat_elevator,
        description: listing.description,
      },
    };
    if (webhook) {
      fetch(webhook, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
      }).then((r) => console.log(`pipeline webhook → ${r.status}`))
        .catch((err) => console.error("pipeline webhook failed:", err.message));
    }
    return { listing_id: listingId };
  }

  // ── demo-create (sets session cookie) ──
  // Admin-only: this signs a session for a client-supplied agent phone, so only
  // a trusted operator on the ADMIN_PHONES allowlist may call it.
  router.post("/properties/demo-create", requireAdmin, async (req, res) => {
    const body = req.body || {};
    const agentPhone = normalizeAuthPhone(body.agent && body.agent.phone);
    if (!agentPhone) return res.status(400).json({ error: "valid agent.phone required" });

    const result = await createListing(agentPhone, body, { ...(body.agent || {}), phone: agentPhone });
    if (result.error) return res.status(result.code).json({ error: result.error });

    // ensure partial business exists
    const existing = await db.getBusiness(agentPhone);
    if (!existing || existing.onboarding_state !== "complete") {
      const now = new Date();
      await db.setBusiness(agentPhone, {
        phone: agentPhone,
        full_name: String((body.agent && body.agent.name) || ""),
        business_name: String((body.agent && (body.agent.brand_name || body.agent.name)) || ""),
        logo_url: String((body.agent && body.agent.logo_url) || ""),
        license_number: String((body.agent && body.agent.license) || ""),
        plan: "trial", paid: false,
        onboarding_state: "demo_partial",
        onboarding_pct: 30,
        source: "demo",
        // Demos get the chat bot on by default — it's the feature worth
        // showing off, and cost is bounded by DEMO_MONTHLY_CAP (chatbot-config.js).
        features: { chatbot: true },
        created_at: now, updated_at: now,
      });
    }

    // auto-login
    const token = signSession(authSecret, agentPhone);
    res.cookie("forly_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: sessionTtl * 1000,
    });
    res.json({ ...result, status: "building", logged_in: true });
  });

  // ── demo-save-agent (autosave on blur) ──
  // Admin-only: writes to an arbitrary agent's business doc during a demo.
  router.post("/demo-save-agent", requireAdmin, async (req, res) => {
    const body = req.body || {};
    const phone = normalizeAuthPhone(body.phone);
    const field = String(body.field || "");
    const value = body.value;
    if (!phone || !field) return res.status(400).json({ error: "phone and field required" });
    const allowed = ["full_name", "business_name", "license_number", "logo_url"];
    if (!allowed.includes(field)) return res.status(400).json({ error: "invalid field" });
    if (!db.db) return res.json({ ok: true });
    try {
      await db.setBusiness(phone, { [field]: value ?? "", onboarding_state: "demo_partial", updated_at: new Date() });
      res.json({ ok: true });
    } catch (err) {
      console.error("demo-save-agent failed:", err);
      res.status(500).json({ error: "save failed" });
    }
  });

  // ── create (authenticated) ──
  // Paid bundle: one creation consumes one `walkthroughs` unit, atomically, and
  // only after the body validates. Demos (admin-driven) don't consume.
  router.post("/properties/create", requireAuth(authSecret), async (req, res) => {
    const body = req.body || {};
    const phone = req.user.userId;
    const invalid = validateListing(body);
    if (invalid) return res.status(invalid.code).json({ error: invalid.error });
    if (quota) {
      const business = await db.getBusiness(phone).catch(() => null);
      const q = await quota.consume(phone, "walkthroughs", 1, {
        source: "dashboard", business,
        request: { address: body.address, city: body.city, price: body.price, rooms: body.rooms,
          photos: Array.isArray(body.photos_urls) ? body.photos_urls.length : 0 },
      });
      if (!q.ok) return res.status(402).json(q);
    }
    const result = await createListing(phone, body, null);
    if (result.error) return res.status(result.code).json({ error: result.error });
    res.json({ ...result, status: "building" });
  });

  // ── listing-status ──
  router.get("/listing-status", async (req, res) => {
    const id = typeof req.query.id === "string" ? req.query.id : "";
    if (!id) return res.status(400).json({ error: "missing id" });
    const listing = await db.getListing(id);
    if (!listing) return res.status(404).json({ error: "not found" });
    // Agent-only edit link (this endpoint backs the agent-facing create flow).
    // Pages created before edit tokens existed get one lazily here.
    let editUrl = null;
    if (listing.page_id) {
      const page = await db.getPage(listing.page_id);
      if (page) {
        if (!page.edit_token) {
          page.edit_token = pageEdit.newEditToken();
          await db.updatePage(listing.page_id, { edit_token: page.edit_token });
        }
        editUrl = `${pageBaseUrl}/p/${listing.page_id}#edit=${page.edit_token}`;
      }
    }
    res.json({
      listing_id: id,
      page_id: listing.page_id || null,
      page_url: listing.page_id ? `${pageBaseUrl}/p/${listing.page_id}` : null,
      edit_url: editUrl,
      status: listing.page_id ? "ready" : (listing.status === "failed" ? "failed" : "building"),
    });
  });

  return router;
};
