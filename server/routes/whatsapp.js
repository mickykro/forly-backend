/*
 * routes/whatsapp.js — the WhatsApp chat as a property-page intake.
 *
 *   POST /api/whatsapp/intake   { phone, message }        n8n (x-forly-secret)
 *     → 200 { ok:true, status, reply, replied, listing_id? }
 *       status: building | no_link | missing_fields | few_photos | quota_blocked |
 *               page_unreadable | facebook_not_connected | extract_unavailable | create_failed
 *     → 404 { error:"unknown_agent" }   sender has no businesses/{phone} doc (nothing sent)
 *     → 403 / 503                        bad or unconfigured N8N_WEBHOOK_SECRET
 *
 * The n8n WhatsApp bot forwards an agent's inbound message here when it
 * contains a link (or always — a message without a link answers `no_link`).
 * The server sends the reply itself over Green API and reports `replied`; when
 * Green API is not configured (`replied:false`) n8n should forward `reply`.
 * The "page is live" message comes later from the n8n Property Page Builder
 * (it already WhatsApps every page's agent) — the pipeline takes minutes.
 *
 * n8n hook (Business Handler2, before the AI agent): IF customerMessage
 * matches /https?:\/\// → HTTP Request POST {BASE_URL}/api/whatsapp/intake,
 * header x-forly-secret, body { phone, message: customerMessage } → stop.
 */
const express = require("express");
const { constantTimeEqual } = require("../security");
const db = require("../db");
const { intake } = require("../whatsapp-intake");
const { resolve } = require("../listing-sources");
const { parseListing } = require("../listing-extract");
const { createListing } = require("../listing-create");
const { importImage, DailyLimit } = require("./extract");
const { storeBuffer } = require("../upload-store");

const DAILY_CAP = 20; // links per agent per day — bounds Firecrawl + LLM spend

module.exports = function createWhatsappRouter(ctx) {
  const { n8nSecret, normalizeAuthPhone, signSession, authSecret, quota, sendWhatsApp,
    uploadDir, uploadPublicBase, remoteUploadBase, baseUrl, pipelineDeps } = ctx;
  const router = express.Router();
  const limit = new DailyLimit(DAILY_CAP);

  function requireN8n(req, res, next) {
    if (!n8nSecret) return res.status(503).json({ error: "n8n_secret_not_configured" });
    if (!constantTimeEqual(req.get("x-forly-secret"), n8nSecret)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  }

  // Photos are re-hosted on Forly's store. The remote-store relay re-authorizes
  // with the caller's session; there is no browser here, so mint the agent's
  // own session for the hop (same trust as the agent uploading from the form).
  function importPhotoFor(phone) {
    const req = { headers: { cookie: `forly_session=${signSession(authSecret, phone)}` } };
    return async (url) => {
      const img = await importImage(url);
      await storeBuffer(img, { uploadDir, remoteUploadBase, req });
      return `${uploadPublicBase}/files/${img.fname}`;
    };
  }

  router.post("/intake", requireN8n, async (req, res) => {
    const body = req.body || {};
    const phone = normalizeAuthPhone(body.phone || "");
    const text = String(body.message || body.text || body.url || "").slice(0, 4000);
    if (!phone || !text.trim()) return res.status(400).json({ error: "invalid_input" });
    if (!limit.take(phone)) return res.status(429).json({ error: "extract_limit" });
    try {
      const out = await intake({ phone, text }, {
        getBusiness: db.getBusiness, resolve, parseListing, quota,
        importPhoto: importPhotoFor(phone),
        createListing: (p, listing) => createListing(p, listing, null, { ...pipelineDeps, source: "whatsapp" }),
        createUrl: `${baseUrl}/create.html`,
      });
      if (out.status === "unknown_agent") return res.status(404).json({ error: "unknown_agent" });
      let replied = false;
      if (out.reply && sendWhatsApp) {
        try { await sendWhatsApp(phone, out.reply); replied = true; }
        catch (err) { console.warn("[whatsapp-intake] reply failed:", err.message); }
      }
      console.log(`[whatsapp-intake] ${phone} → ${out.status}${out.listing_id ? ` ${out.listing_id}` : ""}`);
      res.json({ ok: true, status: out.status, reply: out.reply, replied, listing_id: out.listing_id || null });
    } catch (err) {
      console.error("[whatsapp-intake] failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  return router;
};
