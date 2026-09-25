/*
 * routes/connections-browser.js — "connect my account", with a real browser.
 *
 * Yad2 and Madlan are readable logged-out; a Facebook group post is not. Rather
 * than ask an agent for their password (which we would then have to hold), we
 * start a browser with a PERSISTED PROFILE and show it to them inside Forly.
 * They log in themselves, 2FA and all. The cookies live in the Driver profile;
 * Forly stores a session id and a timestamp, and never a credential.
 *
 * The cdpUrl is the one secret here: anyone holding it drives that browser. It
 * is returned once, to the authenticated owner, and never stored or logged.
 */
const express = require("express");
const driverLive = require("../driver-browser");
const dbLive = require("../db");
const { isLoginWall } = require("../listing-driver")._test;

const SESSION_SECONDS = 1500; // SMS 2FA on a phone that is also showing the modal takes a while
const CONSENT_VERSION = "2026-09-24";
const { profileName } = require("../profile-name");

// Facebook only: it is the one platform a feature posts to. Add a platform
// here when a feature needs it, not before.
const PLATFORMS = {
  facebook: { loginUrl: "https://www.facebook.com/login", checkUrl: "https://www.facebook.com/me" },
};

module.exports = function createConnectionsBrowserRouter(ctx) {
  const { requireAuth, authSecret } = ctx;
  const driver = ctx.driver || driverLive;
  const db = ctx.db || dbLive;
  const router = express.Router();

  const viewUrl = (cdpUrl) => `https://viewer.driver.dev?ws=${encodeURIComponent(cdpUrl)}`;

  router.post("/start", requireAuth(authSecret), async (req, res) => {
    const platform = String((req.body && req.body.platform) || "");
    const spec = PLATFORMS[platform];
    if (!spec) return res.status(400).json({ error: "invalid_input" });
    if (!(req.body && req.body.consent === true)) return res.status(400).json({ error: "consent_required" });
    const phone = req.user.userId;

    let session;
    try {
      session = await driver.createSession({
        duration: SESSION_SECONDS,
        url: spec.loginUrl,
        profile: { name: profileName(platform, phone), persist: true },
        note: `forly-connect:${platform}`, // never the phone
      });
    } catch (e) {
      return res.status(503).json({ error: "extract_unavailable" });
    }

    // Top-level keys, not a nested map: setConnection is a merge write, and a
    // merge cannot delete a nested key — finish/disconnect need to clear this.
    await db.setConnection(phone, {
      [`browser_session_${platform}`]: { session_id: session.sessionId, started_at: new Date().toISOString() },
      browser_consent_at: new Date().toISOString(),
      browser_consent_version: CONSENT_VERSION,
    });

    // view_url carries the cdpUrl: response only, never a log line, never Firestore.
    return res.json({
      platform,
      session_id: session.sessionId,
      view_url: viewUrl(session.cdpUrl),
      expires_in: SESSION_SECONDS,
    });
  });

  router.get("/:platform/status", requireAuth(authSecret), async (req, res) => {
    const platform = String(req.params.platform);
    if (!PLATFORMS[platform]) return res.status(400).json({ error: "invalid_input" });
    const conn = (await db.getConnection(req.user.userId)) || {};
    const connectedAt = conn[`${platform}_browser_connected_at`] || null;
    if (connectedAt) return res.json({ state: "connected", connected_at: connectedAt });
    const open = conn[`browser_session_${platform}`];
    return res.json({ state: open ? "open" : "none" });
  });

  router.post("/:platform/finish", requireAuth(authSecret), async (req, res) => {
    const platform = String(req.params.platform);
    const spec = PLATFORMS[platform];
    if (!spec) return res.status(400).json({ error: "invalid_input" });
    const phone = req.user.userId;
    const conn = (await db.getConnection(phone)) || {};
    const open = conn[`browser_session_${platform}`];
    if (!open || !open.session_id) return res.status(409).json({ error: "no_open_session" });

    let loggedIn = false, label = null, pages = [];
    try {
      ({ loggedIn, label, pages } = await driver.attachPage(open.session_id, async (page) => {
        await page.goto(spec.checkUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        const text = await page.innerText("body");
        if (isLoginWall(page.url(), text)) return { loggedIn: false, label: null };
        // The profile's display name, so the campaign card can say "posting as …"
        // and an agent with two accounts can see which one they connected.
        // try/catch, not page.title().catch(): a page fake without .title at
        // all (as in this file's own test) throws synchronously, not a rejection.
        let title = "";
        try { title = await page.title(); } catch (e) { /* label stays null */ }
        const label = String(title || "").split("|")[0].trim().slice(0, 60) || null;
        // The Pages this account manages — the browser publisher (Phase 3) posts
        // to the first one; the agent can pick another on the campaign card.
        let pages = [];
        try {
          await page.goto(process.env.FB_PAGES_PAGE || "https://www.facebook.com/pages/?category=your_pages", { waitUntil: "domcontentloaded", timeout: 30000 });
          pages = await page.$$eval('a[href*="facebook.com/"][role="link"]', (els) => els.map((a) => ({ url: a.href.split("?")[0], name: (a.textContent || "").trim() })).filter((x) => x.name && /facebook\.com\/[^/]+\/?$/.test(x.url)).slice(0, 10));
        } catch (e) { pages = []; }
        return { loggedIn: true, label, pages };
      }));
    } catch (e) {
      // A session that already ended reads as expired, not as "not logged in".
      return res.status(409).json({ error: "session_expired" });
    }

    // Not logged in yet: KEEP the session. The agent is most likely waiting for
    // an SMS code; stopping here forces a second login from a second IP.
    if (!loggedIn) return res.status(409).json({ error: "not_logged_in" });

    await driver.stopSession(open.session_id);
    const first = conn[`${platform}_browser_first_connected_at`] || new Date().toISOString();
    await db.setConnection(phone, {
      [`${platform}_browser_connected_at`]: new Date().toISOString(),
      [`${platform}_browser_first_connected_at`]: first, // warm-up counts from here, not from every reconnect
      [`${platform}_identity_label`]: label,
      [`${platform}_pages`]: pages,
      [`browser_session_${platform}`]: null,
    });
    return res.json({ state: "connected", identity_label: label, pages });
  });

  // The way out. Stops what is running, forgets the login, deletes the profile
  // at Driver. Required by the privacy law the plan's intro names, and by
  // common decency: the agent must be able to take back what they handed over.
  router.delete("/:platform", requireAuth(authSecret), async (req, res) => {
    const platform = String(req.params.platform);
    if (!PLATFORMS[platform]) return res.status(400).json({ error: "invalid_input" });
    const phone = req.user.userId;
    const conn = (await db.getConnection(phone)) || {};
    // ponytail: campaign-stop loop skipped — posting-campaign.js is Phase 3, out of scope. Add when Phase 3 lands.
    const open = conn[`browser_session_${platform}`];
    if (open && open.session_id) await driver.stopSession(open.session_id);
    await driver.deleteProfile(profileName(platform, phone));
    await db.setConnection(phone, {
      [`${platform}_browser_connected_at`]: null,
      [`${platform}_browser_disconnected_at`]: new Date().toISOString(),
      [`${platform}_identity_label`]: null,
      [`browser_session_${platform}`]: null,
    });
    return res.json({ state: "none" });
  });

  return router;
};

module.exports.PLATFORMS = PLATFORMS;
