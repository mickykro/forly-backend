/*
 * routes/quota.js — quota endpoints.
 *
 *   POST /api/quota/consume  { phone, kind, amount?, request? }   n8n (secret)
 *   GET  /api/quota/status?phone=                                 n8n (secret)
 *   GET  /api/quota/me                                            logged-in agent
 *
 * The n8n WhatsApp chatbot calls /consume once before an expensive step (an
 * image edit) — it is an atomic check-and-reserve, so two concurrent requests
 * can't both slip under the cap. When blocked it answers 402 with the friendly
 * Hebrew message + payment link for n8n to forward to the client verbatim, and
 * the attempt is recorded + the operator WhatsApped (see server/quota.js).
 *
 * Secret: x-forly-secret header, compared in constant time to
 * N8N_WEBHOOK_SECRET. Missing secret config ⇒ these routes are closed.
 */

const express = require("express");
const { constantTimeEqual } = require("../security");
const { isKind } = require("../quota");
const db = require("../db");

module.exports = function createQuotaRouter({ quota, requireAuth, authSecret, n8nSecret, normalizeAuthPhone }) {
  const router = express.Router();

  function requireN8n(req, res, next) {
    if (!n8nSecret) return res.status(503).json({ error: "n8n_secret_not_configured" });
    if (!constantTimeEqual(req.get("x-forly-secret"), n8nSecret)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  }

  router.post("/consume", requireN8n, async (req, res) => {
    const body = req.body || {};
    const phone = normalizeAuthPhone(body.phone || "");
    const kind = String(body.kind || "");
    if (!phone || !isKind(kind)) return res.status(400).json({ error: "invalid_input" });
    try {
      const business = await db.getBusiness(phone).catch(() => null);
      const r = await quota.consume(phone, kind, body.amount, {
        request: body.request, source: "n8n", business,
      });
      if (!r.ok) return res.status(402).json(r);
      res.json(r);
    } catch (err) {
      console.error("quota/consume failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  router.get("/status", requireN8n, async (req, res) => {
    const phone = normalizeAuthPhone(String(req.query.phone || ""));
    if (!phone) return res.status(400).json({ error: "invalid_input" });
    try {
      res.json({ phone, ...(await quota.getQuota(phone)) });
    } catch (err) {
      console.error("quota/status failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  // The agent's own allowance, for the dashboard / create form.
  router.get("/me", requireAuth(authSecret), async (req, res) => {
    try {
      res.json(await quota.getQuota(req.user.userId));
    } catch (err) {
      console.error("quota/me failed:", err);
      res.status(500).json({ error: "internal" });
    }
  });

  return router;
};
