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

const BROWSE_EVERY_MS = 20  ; // posting-tick's spacing between warm-up browses
const tail = (p) => `…${String(p || "").slice(-4)}`;

/*
 * posting: { deps (the sweeper's live deps), sweeper, guard, dwell, db, store,
 * locks } — the posting panel: why nothing is happening, and local-only
 * buttons to run a sweep now or a warm-up browse on the admin's own account.
 * Absent (Driver or posting off on this box) → the panel says so.
 */
module.exports = function createDevDriverRouter({ requireAdmin, requireStepUp, driver = require("../driver-browser"), viewer = require("../connect-viewer"), posting = null }) {
  const router = express.Router();
  const isLive = (id) => driver.liveSessions().some((s) => s.sessionId === id);
  const key = (id) => `dev|${id}`;

  // In-page view of a live session, for any admin (no browser address leaves).
  router.get("/sessions/:id/view", requireAdmin, async (req, res) => {
    const id = String(req.params.id);
    if (!isLive(id)) return res.status(404).json({ error: "not_found" });
    // A browser the server drives itself is handed over by withPage a moment
    // after it appears in the list: wait for that rather than open a second
    // connection. A login browser (forly-connect) is never adopted.
    const s = driver.liveSessions().find((x) => x.sessionId === id);
    if (s && !/-connect:/.test(String(s.note || ""))) {
      for (let i = 0; i < 40 && !(viewer._hubs && viewer._hubs.get(key(id))); i++) await new Promise((r) => setTimeout(r, 250));
    }
    let hub;
    try { hub = await viewer.attach(key(id), id); }
    catch (e) {
      const code = ["session_expired", "driver_busy"].includes(e && e.code) ? e.code : "viewer_unavailable";
      // Local and admin-only: the reason, with every browser address removed.
      return res.status(code === "session_expired" ? 409 : 503).json({ error: code, detail: (e && e.detail) || driver.redact(String((e && e.message) || "")).slice(0, 300) });
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

  // ── the posting panel ──
  const P = posting && Object.assign({
    sweeper: require("../posting-sweeper"), guard: require("../posting-guard"), db: require("../db"),
    store: require("../posting-store"), locks: require("../profile-lock"),
    dwell: (...a) => require("../social-dwell").browseSession(...a),
  }, posting);
  const reasonOf = async (phone, action) => {
    try { await P.guard.assertAllowed({ phone, platform: "facebook", action }, { db: P.db, env: (P.deps && P.deps.env) || process.env }); return null; }
    catch (e) { if (e && e.code === "posting_disabled") return e.reason || "posting_disabled"; throw e; }
  };
  router.get("/posting", requireAdmin, async (req, res) => {
    if (!P) return res.json({ enabled: false });
    const phone = req.user.userId;
    const conn = (await P.db.getConnection(phone)) || {};
    const campaigns = await P.store.listPostingCampaignsByPhone(phone);
    const st = P.sweeper.status();
    let fleet = null;
    try { await P.guard.assertFleetAllowed({ platform: "facebook" }, { db: P.db, env: (P.deps && P.deps.env) || process.env }); }
    catch (e) { if (e && e.code === "posting_disabled") fleet = e.reason || "off"; else throw e; }
    const lastBrowse = [conn.last_browse_at, conn.last_browse_attempt_at].map((v) => (v ? new Date(v).getTime() : 0)).reduce((a, b) => Math.max(a, b), 0);
    const mine = st.accounts.find((a) => a.phone === phone) || null;
    res.json({
      enabled: true,
      sweeper: { started: st.started, last: st.last },
      fleet_off: fleet,
      accounts: st.accounts.map((a) => ({ phone: tail(a.phone), at: a.at, outcome: a.outcome })),
      me: {
        phone: tail(phone), connected: !!conn.facebook_browser_connected_at,
        running: campaigns.filter((c) => c.status === "running").length, paused: campaigns.filter((c) => c.status === "paused").length,
        last_tick: mine && { at: mine.at, outcome: mine.outcome },
        last_browse_at: conn.last_browse_at || null,
        next_browse_at: lastBrowse ? new Date(lastBrowse + BROWSE_EVERY_MS).toISOString() : null,
        dwell_blocked: await reasonOf(phone, "dwell"),
      },
    });
  });
  router.post("/posting/sweep", requireAdmin, async (req, res) => {
    if (!P) return res.status(404).json({ error: "posting_unavailable" });
    const ticked = await P.sweeper.sweep(P.deps || {});
    res.json({ ticked, last: P.sweeper.status().last });
  });
  // A warm-up browse on the admin's own account, now: it shows up as a tile.
  // The guard still applies to every step inside it; the profile lock too.
  router.post("/posting/browse", requireAdmin, async (req, res) => {
    if (!P) return res.status(404).json({ error: "posting_unavailable" });
    const phone = req.user.userId;
    const conn = (await P.db.getConnection(phone)) || {};
    if (!conn.facebook_browser_connected_at) return res.status(409).json({ error: "facebook_not_connected" });
    const blocked = await reasonOf(phone, "dwell");
    if (blocked) return res.status(409).json({ error: "posting_disabled", reason: blocked });
    const release = P.locks.tryAcquire(phone, "facebook");
    if (!release) return res.status(409).json({ error: "profile_busy" });
    const { profileName } = require("../profile-name");
    Promise.resolve()
      .then(() => P.dwell({ phone, profileName: profileName("facebook", phone, conn.facebook_profile_gen || 0), note: "forly-dwell:" }, Object.assign({}, P.deps || {}, { lockHeld: true, phone, platform: "facebook", conn })))
      .catch((e) => console.error(driver.redact(`dev browse: ${(e && (e.code || e.name)) || "error"}`)))
      .finally(release);
    res.status(202).json({ started: true });
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
