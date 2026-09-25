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
const locksLive = require("../profile-lock");
const guardLive = require("../posting-guard");
const lifecycleLive = require("../profile-lifecycle");
const groupsSync = require("../facebook-groups-sync");

// SMS 2FA on a phone that is also showing the modal takes a while. While a
// login browser this young is recorded, posting, re-check, reconcile and the
// groups sync leave the profile alone (profile-lock.loginOpen).
const SESSION_SECONDS = locksLive.LOGIN_SESSION_S;
const CONSENT_VERSION = "2026-09-24";
// Disabling halt classes R5 resolves with a reconnect (see startFlow).
const RECONNECT_CLASSES = new Set(["captcha", "checkpoint", "suspected_compromise"]);
const { profileName } = require("../profile-name");

// Facebook posts; Yad2 and Madlan are read-only (Phase 4: connect, dwell,
// read — see listing-sweep.js). Add a platform here when a feature needs it.
const PLATFORMS = {
  facebook: { loginUrl: "https://www.facebook.com/login", checkUrl: "https://www.facebook.com/me" },
  yad2: { loginUrl: process.env.YAD2_LOGIN || "https://www.yad2.co.il/auth/login", checkUrl: process.env.YAD2_MY_ADS || "https://www.yad2.co.il/my-ads" },
  madlan: { loginUrl: process.env.MADLAN_LOGIN || "https://www.madlan.co.il/login", checkUrl: process.env.MADLAN_MY_LISTINGS || "https://www.madlan.co.il/my" },
};

// ── /finish helpers (Facebook) ──
// The navigation links Facebook's "your Pages" screen also carries — never a Page.
const NAV_SEGMENTS = new Set(["marketplace", "watch", "groups", "gaming", "games", "events", "friends", "pages", "bookmarks", "messages",
  "notifications", "reel", "reels", "stories", "saved", "memories", "fundraisers", "ads", "adsmanager", "business", "help", "settings",
  "privacy", "policies", "policy", "login", "logout", "home.php", "me", "search", "hashtag", "photo", "photo.php", "photos", "permalink.php",
  "story.php", "jobs", "live", "news", "feeds", "onthisday", "offers", "weather", "lite", "dating", "videos", "people", "places",
  "latest", "find-friends", "your_pages", "business_help", "legal", "terms", "careers", "about", "l.php", "sharer", "sharer.php", "profile.php"]);
const SEG = /^[A-Za-z0-9._-]{2,80}$/;
// Scraped links → the agent's Pages: { url, name, id? }, at most 10, one per
// Page. profile.php?id=<n> keeps its query (it IS the Page's address) and
// that n is the numeric id; a one-segment vanity URL has none yet.
function pageLinks(links) {
  const out = new Map();
  for (const l of Array.isArray(links) ? links : []) {
    let u;
    try { u = new URL(String(l && l.href)); } catch { continue; }
    const name = String((l && l.name) || "").trim().slice(0, 120);
    if (!name || u.protocol !== "https:" || !/^(www\.|m\.|web\.)?facebook\.com$/i.test(u.hostname)) continue;
    const parts = u.pathname.split("/").filter(Boolean);
    const pid = u.searchParams.get("id");
    let page = null;
    if (parts.length === 1 && parts[0] === "profile.php" && /^\d{5,25}$/.test(pid || "")) page = { url: `https://www.facebook.com/profile.php?id=${pid}`, name, id: pid };
    else if (parts.length === 1 && SEG.test(parts[0]) && !NAV_SEGMENTS.has(parts[0].toLowerCase())) page = { url: `https://www.facebook.com/${parts[0]}`, name };
    if (page && !out.has(page.url)) out.set(page.url, page);
  }
  return [...out.values()].slice(0, 10);
}
// Each Page's numeric id from its own metadata (posting-driver-proof.readTargetId,
// the same read R3 makes before a Page post). [Unverified] selector. A Page whose
// page does not say is kept without an id — shown, never a campaign target.
async function withPageIds(page, pages) {
  const P = require("../posting-driver-proof");
  const out = [];
  for (const p of pages) {
    if (p.id) { out.push(p); continue; }
    let id = null;
    try {
      await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      id = await P.readTargetId(page, "page");
    } catch (e) { id = null; }
    out.push(/^\d{5,25}$/.test(String(id || "")) ? Object.assign({}, p, { id: String(id) }) : p);
  }
  return out;
}
// The tab title without an unread counter "(3) " and the " | Facebook" suffix, normalised.
async function titleLabel(page) {
  let title = "";
  // try/catch, not page.title().catch(): a page fake without .title throws synchronously.
  try { title = await page.title(); } catch (e) { /* no title */ }
  const P = require("../posting-driver-proof");
  return P.norm(String(title || "").replace(/^\(\d+\+?\)\s*/, "").split("|")[0]).slice(0, 120) || null;
}
// The banner identity marker R3 compares against, else the title.
async function identityLabel(page) {
  const P = require("../posting-driver-proof");
  let header = "";
  try { header = await P.textOf(page, P.SELECTORS.identity); } catch (e) { header = ""; }
  return (header && header.length <= 120 ? header : null) || (await titleLabel(page));
}

module.exports = function createConnectionsBrowserRouter(ctx) {
  const { requireAuth, authSecret } = ctx;
  const driver = ctx.driver || driverLive;
  const db = ctx.db || dbLive;
  const locks = ctx.locks || locksLive;
  const guard = ctx.guard || guardLive;
  const lifecycle = ctx.lifecycle || lifecycleLive;
  const router = express.Router();

  const viewUrl = (cdpUrl) => `https://viewer.driver.dev?ws=${encodeURIComponent(cdpUrl)}`;
  // Express 4 does not catch a rejected handler (I11): a Firestore error would
  // crash the process. Answer 500 with a code; log no data (as posting-shared.wrap).
  const wrap = (name, fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error(driverLive.redact(`connections-browser ${name}: ${(e && (e.code || e.name)) || "error"}`));
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  });

  // The request body of /start, past validation and lock acquisition. Never
  // touches `res` — returns {status, body} so the route can release the
  // profile lock and session budget BEFORE the response goes out.
  async function startFlow(phone, platform, spec) {
    try {
      await guard.assertAllowed({ phone, platform, action: "session" }, { db });
    } catch (e) {
      if (e.code !== "posting_disabled") throw e;
      // Reconnecting is how a revoked profile is replaced — let it through;
      // every other reason (global/platform off, account disabled/penalized) refuses.
      // A disabled account may reconnect too when R5 resolves its halt that
      // way: a captcha/checkpoint (the agent completes the check in the
      // embedded browser) or a suspected compromise (a new profile), and
      // only while its profile is quarantined or revoked. `restricted` needs
      // an owner review, not a reconnect. The disable stays until the
      // operator or owner lifts it (routes/admin-posting.js); until then it
      // still stops every post, like, story and dwell.
      let reconnectable = false;
      if (e.reason === "account_disabled" && platform === "facebook") {
        const c = (await db.getConnection(phone)) || {};
        reconnectable = RECONNECT_CLASSES.has(c.posting_disabled_class) && ["revoked", "quarantined"].includes(c.facebook_profile_state);
      }
      if (e.reason !== "profile_revoked" && !reconnectable) return { status: 409, body: { error: "posting_disabled", reason: e.reason } };
    }

    const conn = (await db.getConnection(phone)) || {};
    const state = conn[`${platform}_profile_state`];
    let gen = conn[`${platform}_profile_gen`] || 0;
    const statePatch = {};
    if (state === "revoked" || state === "quarantined") {
      gen += 1;
      statePatch[`${platform}_profile_gen`] = gen;
      statePatch[`${platform}_profile_state`] = "active";
      // The old generation's delete/revoke/quarantine bookkeeping belongs to
      // a profile this connection no longer points at. Left in place, a
      // stale `_profile_deleted_at` would make retryDeletes() (which reads
      // the CURRENT connection) believe a still-pending delete already
      // succeeded — profile-lifecycle.js's attemptDelete() is the one place
      // that still cares about it once it's gen-tracked on the pending row.
      statePatch[`${platform}_profile_deleted_at`] = null;
      statePatch[`${platform}_profile_delete_error`] = null;
      statePatch[`${platform}_profile_revoked_at`] = null;
      statePatch[`${platform}_profile_revoke_reason`] = null;
      statePatch[`${platform}_profile_quarantined_at`] = null;
      statePatch[`${platform}_profile_quarantine_class`] = null;
    }

    // Never open a second login browser on this profile while one is recorded.
    const existing = conn[`browser_session_${platform}`];
    if (existing && existing.session_id) await driver.stopSession(existing.session_id);

    let session;
    try {
      session = await driver.createSession({
        duration: SESSION_SECONDS,
        url: spec.loginUrl,
        profile: { name: profileName(platform, phone, gen), persist: true },
        note: `forly-connect:${platform}`, // never the phone
      });
    } catch (e) {
      return { status: 503, body: { error: "extract_unavailable" } };
    }

    // Top-level keys, not a nested map: setConnection is a merge write, and a
    // merge cannot delete a nested key — finish/disconnect need to clear this.
    await db.setConnection(phone, Object.assign({
      [`browser_session_${platform}`]: { session_id: session.sessionId, started_at: new Date().toISOString() },
      browser_consent_at: new Date().toISOString(),
      browser_consent_version: CONSENT_VERSION,
    }, statePatch));

    // view_url carries the cdpUrl: response only, never a log line, never Firestore.
    return {
      status: 200,
      body: { platform, session_id: session.sessionId, view_url: viewUrl(session.cdpUrl), expires_in: SESSION_SECONDS },
    };
  }

  router.post("/start", requireAuth(authSecret), wrap("start", async (req, res) => {
    const platform = String((req.body && req.body.platform) || "");
    const spec = PLATFORMS[platform];
    if (!spec) return res.status(400).json({ error: "invalid_input" });
    if (!(req.body && req.body.consent === true)) return res.status(400).json({ error: "consent_required" });
    const phone = req.user.userId;

    // Held only for the duration of this request: the embedded login session
    // itself is long-lived, but its purpose here is to refuse to open a login
    // browser while a post/extract/sweep is using the profile right now.
    const releaseProfile = locks.tryAcquire(phone, platform);
    if (!releaseProfile) return res.status(409).json({ error: "profile_busy" });
    const releaseSession = locks.trySession();
    if (!releaseSession) { releaseProfile(); return res.status(503).json({ error: "driver_busy", retry: true }); }

    let result;
    try {
      result = await startFlow(phone, platform, spec);
    } finally {
      releaseSession();
      releaseProfile();
    }
    return res.status(result.status).json(result.body);
  }));

  router.get("/:platform/status", requireAuth(authSecret), wrap("status", async (req, res) => {
    const platform = String(req.params.platform);
    if (!PLATFORMS[platform]) return res.status(400).json({ error: "invalid_input" });
    const conn = (await db.getConnection(req.user.userId)) || {};
    const connectedAt = conn[`${platform}_browser_connected_at`] || null;
    if (connectedAt) {
      return res.json({ state: "connected", connected_at: connectedAt, identity_label: conn[`${platform}_identity_label`] || null });
    }
    const open = conn[`browser_session_${platform}`];
    return res.json({ state: open ? "open" : "none" });
  }));

  router.post("/:platform/finish", requireAuth(authSecret), wrap("finish", async (req, res) => {
    const platform = String(req.params.platform);
    const spec = PLATFORMS[platform];
    if (!spec) return res.status(400).json({ error: "invalid_input" });
    const phone = req.user.userId;
    const conn = (await db.getConnection(phone)) || {};
    const open = conn[`browser_session_${platform}`];
    if (!open || !open.session_id) return res.status(409).json({ error: "no_open_session" });

    let loggedIn = false, label = null, pages = [], groups = {};
    try {
      ({ loggedIn, label, pages, groups } = await driver.attachPage(open.session_id, async (page) => {
        await page.goto(spec.checkUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        const text = await page.innerText("body");
        if (isLoginWall(page.url(), text)) return { loggedIn: false, label: null };
        // The profile's display name, so the campaign card can say "posting as …"
        // — and the identity R3 proves before every post (I8): read from the
        // same banner marker the driver's proof reads, normalised the same way,
        // so the two can match exactly. Fallback: the tab title, without a
        // "(3) " unread counter and the " | Facebook" suffix.
        const label = platform === "facebook" ? await identityLabel(page) : await titleLabel(page);
        // The Pages this account manages, each with its numeric id when its own
        // page says it (I4) — R3 proves a Page post against that id, so a Page
        // without one is never a target. Yad2/Madlan have no equivalent.
        let pages = [];
        let groups = {};
        if (platform === "facebook") {
          try {
            await page.goto(process.env.FB_PAGES_PAGE || "https://www.facebook.com/pages/?category=your_pages", { waitUntil: "domcontentloaded", timeout: 30000 });
            const links = await page.$$eval('a[href*="facebook.com/"][role="link"]', (els) => els.map((a) => ({ href: a.href, name: (a.textContent || "").trim() })));
            pages = await withPageIds(page, pageLinks(links));
          } catch (e) { pages = []; }
          // Which groups this account is actually a member of (Task 14): the
          // campaign gate later posts only there. A scrape failure must not
          // fail the connect — store nothing for groups and move on.
          try {
            // An empty or collapsed scrape (a slow render, a login wall) is
            // never trusted (I3): the stored list stays as it is.
            const scraped = await groupsSync.syncMembership(page);
            const anomaly = groupsSync.scrapeAnomaly(conn.facebook_groups_member, scraped);
            if (anomaly) console.error(`connections-browser: facebook group sync not trusted: ${anomaly}`);
            else {
              const merged = groupsSync.mergeMembership(conn.facebook_groups_member || [], scraped, {
                now: new Date(), catalog: await db.listGroupCatalog(500), selected: [], hidden: groupsSync.hiddenIds(conn),
              });
              groups = { facebook_groups_member: merged, facebook_groups_synced_at: new Date().toISOString() };
            }
          } catch (e) {
            // Never e.message here: a scrape failure could in principle throw
            // with scraped text (a group name/URL) inside it. Only a fixed
            // string plus the error's code/name — never data — is safe to log.
            console.error(driverLive.redact(`connections-browser: facebook group sync failed: ${e.code || e.name}`));
          }
        }
        return { loggedIn: true, label, pages, groups };
      }));
    } catch (e) {
      // Our own browser budget is full (driver-browser claim()): the agent's
      // login browser is fine, so say "busy, retry" — "expired" would send
      // them to open a second browser on the same profile.
      if (e instanceof driverLive.DriverError && e.status === 429) {
        return res.status(503).json({ error: "driver_busy", retry: true });
      }
      // A session that already ended reads as expired, not as "not logged in".
      return res.status(409).json({ error: "session_expired" });
    }

    // Not logged in yet: KEEP the session. The agent is most likely waiting for
    // an SMS code; stopping here forces a second login from a second IP.
    if (!loggedIn) return res.status(409).json({ error: "not_logged_in" });

    await driver.stopSession(open.session_id);
    const first = conn[`${platform}_browser_first_connected_at`] || new Date().toISOString();
    await db.setConnection(phone, Object.assign({
      [`${platform}_browser_connected_at`]: new Date().toISOString(),
      [`${platform}_browser_first_connected_at`]: first, // warm-up counts from here, not from every reconnect
      [`${platform}_identity_label`]: label,
      [`${platform}_pages`]: pages,
      [`browser_session_${platform}`]: null,
    }, groups));
    return res.json({ state: "connected", identity_label: label, pages });
  }));

  // The way out. Stops what is running, forgets the login, deletes the profile
  // at Driver. Required by the privacy law the plan's intro names, and by
  // common decency: the agent must be able to take back what they handed over.
  router.delete("/:platform", requireAuth(authSecret), wrap("delete", async (req, res) => {
    const platform = String(req.params.platform);
    if (!PLATFORMS[platform]) return res.status(400).json({ error: "invalid_input" });
    const phone = req.user.userId;

    // revoke() stops the open session, cancels open posting attempts, deletes
    // the Driver profile, and clears pages/groups/posting_permission.
    const { advice } = await lifecycle.revoke({ phone, platform, reason: "agent" }, { db, driver });

    // ctx.campaigns is provided by Task 16 (posting-campaign.js); until then
    // this is a no-op, and db.listPostingCampaignsByPhone may not exist yet.
    if (ctx.campaigns && typeof db.listPostingCampaignsByPhone === "function") {
      const campaigns = (await db.listPostingCampaignsByPhone(phone)) || [];
      for (const c of campaigns) {
        if (c.status === "running" || c.status === "paused") await ctx.campaigns.stop(c.id, { db });
      }
    }

    return res.json({ state: "none", advice });
  }));

  return router;
};

module.exports.PLATFORMS = PLATFORMS;
module.exports._test = { pageLinks, withPageIds, titleLabel, identityLabel };
