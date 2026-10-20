/*
 * routes/admin-portfolio.js — the operator edits an agent's portfolio for them.
 *
 *   GET  /api/admin/portfolio?phone=      → what /api/my-portfolio returns for that agent
 *   POST /api/admin/portfolio { phone, …} → the same save the agent's editor does
 *   POST /api/admin/portfolio/create { phone }
 *
 * public-agent/portfolio.html?agent=<phone> is the editor in this mode.
 */
const express = require("express");
const db = require("../db");
const portfolioEdit = require("../portfolio-edit");

module.exports = function createAdminPortfolioRouter({ requireAdmin, normalizeAuthPhone }) {
  const router = express.Router();
  const phoneOf = (req) => normalizeAuthPhone(String((req.body && req.body.phone) || req.query.phone || ""));
  const fail = (res, err, what) => {
    if (err.message === "slug_taken") return res.status(409).json({ error: "slug_taken" });
    console.error(`admin/${what} failed:`, err);
    res.status(500).json({ error: "internal" });
  };

  router.get("/portfolio", requireAdmin, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(400).json({ error: "invalid_input" });
    try {
      res.json({ phone, ...(await portfolioEdit.getPortfolio(phone)) });
    } catch (err) { fail(res, err, "portfolio get"); }
  });

  router.post("/portfolio", requireAdmin, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(400).json({ error: "invalid_input" });
    try {
      const out = await portfolioEdit.savePortfolio(phone, req.body || {});
      if (!out) return res.status(404).json({ error: "not_found" });
      console.log(`admin_portfolio_saved phone=${phone} by=${req.user.userId}`);
      res.json({ ok: true, ...out });
    } catch (err) { fail(res, err, "portfolio save"); }
  });

  router.post("/portfolio/create", requireAdmin, async (req, res) => {
    const phone = phoneOf(req);
    if (!phone) return res.status(400).json({ error: "invalid_input" });
    try {
      // Never mint a business doc for a typo'd phone: the agent must exist.
      if (!(await db.getBusiness(phone))) return res.status(404).json({ error: "not_found" });
      const out = await portfolioEdit.createPortfolio(phone);
      console.log(`admin_portfolio_create phone=${phone} created=${out.created} by=${req.user.userId}`);
      res.json(out);
    } catch (err) { fail(res, err, "portfolio create"); }
  });

  return router;
};
