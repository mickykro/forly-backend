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
const { sniffMatchesExt } = require("../utils");
const { validateListing, createListing: createListingShared, MAX_PHOTOS: MAX_UPLOAD_FILES } = require("../listing-create");
const { makeAdminGuard } = require("../admin-auth");

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

  // Inter-instance relay: when this server fronts a remote file store
  // (REMOTE_UPLOAD_BASE), it forwards the caller's own session so the remote —
  // running this same code — re-authorizes the write. index.js only enables
  // the relay when a real shared NADLAN_JWT_SECRET exists (see upload-relay.js).
  const { relayHeaders, relayUpload } = require("../upload-relay");

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
      const out = await relayUpload({
        fetch, base: remoteUploadBase, fname, req, body: req.body,
        contentType: req.headers["content-type"],
      });
      if (out.status !== 200) console.error("upload relay:", out.body.error);
      return res.status(out.status).json(out.body);
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

  // ── shared listing creation (listing-create.js) ──
  const pipelineDeps = { n8nWw1Webhook, n8nPipelineWebhook, isDevRun, isDevPipelineRun, baseUrl };
  const createListing = (phone, body, agentOverride, extraDeps) =>
    createListingShared(phone, body, agentOverride, { ...pipelineDeps, ...extraDeps });

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
    // create.html?whatsapp=1 flags a build from the chat draft. Stamp the
    // source and clear the draft: otherwise the agent's next message would
    // keep re-sending the review link for a page that already exists.
    const fromDraft = body.whatsapp_draft === true;
    const result = await createListing(phone, body, null, fromDraft ? { source: "whatsapp" } : null);
    if (result.error) return res.status(result.code).json({ error: result.error });
    if (fromDraft) await db.deleteDraft(phone).catch((err) => console.warn("whatsapp draft cleanup failed:", err.message));
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
