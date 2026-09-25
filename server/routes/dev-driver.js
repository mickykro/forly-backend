/*
 * routes/dev-driver.js — dev-only: watch the browsers the server opens.
 *
 * Mounted at /api/dev/driver only when DRIVER_DEV_VIEW=1 under FORLY_ENV=local
 * (index.js refuses to boot with the flag anywhere else). The list carries no
 * cdpUrl: watching a session takes a viewer grant — minted by an admin who
 * logged in with an OTP in the last 10 minutes (step-up), spent once, by that
 * same admin, as a redirect. That redirect is the only response in the whole
 * server that carries a browser-control URL.
 */
const express = require("express");

module.exports = function createDevDriverRouter({ requireAdmin, requireStepUp, driver = require("../driver-browser") }) {
  const router = express.Router();

  router.get("/sessions", requireAdmin, (req, res) => {
    res.json({ sessions: driver.liveSessions() });
  });

  router.post("/sessions/:id/grant", requireAdmin, requireStepUp, (req, res) => {
    res.set("Cache-Control", "no-store");
    const grant = driver.mintViewerGrant(String(req.params.id), { operator: req.user.userId });
    if (!grant) return res.status(404).json({ error: "not_found" });
    res.json({ open_url: `/api/dev/driver/view/${grant.id}`, expires_in: 300 });
  });

  router.get("/view/:grant", requireAdmin, (req, res) => {
    const url = driver.consumeViewerGrant(String(req.params.grant), req.user.userId);
    if (!url) return res.status(410).type("text/plain").send("expired");
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.redirect(302, url);
  });

  return router;
};
