/*
 * routes/dev-driver.js — dev-only: watch the browsers the server opens.
 *
 * Mounted at /api/dev/driver only on a local box (driver-browser.devViewOn:
 * FORLY_ENV=local, not production). Every browser this server opens is listed,
 * and shown in the page through connect-viewer.js (GET /sessions/:id/view,
 * POST /sessions/:id/view/input) — the cdpUrl stays on the server. Opening one
 * externally, in Driver's own viewer, takes a viewer grant — minted by an
 * admin who logged in with an OTP in the last 10 minutes (step-up), spent
 * once, by that same admin, as a redirect. That redirect is the only response
 * in the whole server that carries a browser-control URL.
 */
const express = require("express");

module.exports = function createDevDriverRouter({ requireAdmin, requireStepUp, driver = require("../driver-browser"), viewer = require("../connect-viewer") }) {
  const router = express.Router();
  const isLive = (id) => driver.liveSessions().some((s) => s.sessionId === id);
  const key = (id) => `dev|${id}`;

  // In-page view of a live session, for any admin (no browser address leaves).
  router.get("/sessions/:id/view", requireAdmin, async (req, res) => {
    const id = String(req.params.id);
    if (!isLive(id)) return res.status(404).json({ error: "not_found" });
    let hub;
    try { hub = await viewer.attach(key(id), id); }
    catch (e) {
      const code = ["session_expired", "driver_busy"].includes(e && e.code) ? e.code : "viewer_unavailable";
      return res.status(code === "session_expired" ? 409 : 503).json({ error: code });
    }
    viewer.pipe(req, res, hub);
  });

  router.post("/sessions/:id/view/input", requireAdmin, async (req, res) => {
    try { res.json(await viewer.input(key(String(req.params.id)), req.body)); }
    catch (e) {
      const code = e && e.code;
      const status = { no_viewer: 409, invalid_input: 400, slow_down: 429 }[code] || 502;
      res.status(status).json({ error: status === 502 ? "input_failed" : code });
    }
  });

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
