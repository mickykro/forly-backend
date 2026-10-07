/*
 * routes/admin-manual.js — the admin "פרסום ידני" tab (posting-manual).
 *
 * The queue of group posts the agents approved, a tick per group, and one
 * live browser per agent on that agent's own saved Facebook profile, shown
 * through connect-viewer (the cdpUrl never leaves the server). The admin
 * drives it; helpers only do the tedious parts on request: open a group,
 * type the approved text, and put the property's video into Facebook's file
 * chooser the moment the admin opens it. The admin clicks Post themselves.
 *
 * Agents are addressed by an opaque ref (posting-manual.refOf), never a phone.
 */
const express = require("express");
const M = require("../posting-manual");
const A = require("../posting-account");
const L = require("../posting-limits");

const SESSION_S = 3600;      // Driver's limit
const CHOOSER_FRESH_MS = 60000;
// The admin flips between the list and the browser: keep the viewer connected
// that long rather than reconnecting (CDP + checks) after 20s without a watcher.
const VIEW_IDLE_MS = 10 * 60000;
const GROUP_URL = /^https:\/\/(www\.|m\.|web\.)?facebook\.com\/groups\/[^/?#\s]+\/?$/i;

module.exports = function createAdminManualRouter({
  requireAdmin, deps = {},
  driver = require("../driver-browser"), viewer = require("../connect-viewer"),
  media = require("../posting-media"), locks = require("../profile-lock"),
}) {
  const router = express.Router();
  const x = A.ctxOf(deps);
  const open = new Map(); // phone → { sessionId, release, timer, pageId, chooser }
  const hooked = new WeakSet(); // pages whose file chooser we listen for
  const key = (phone) => `manual|${phone}`;
  const redact = (s) => (driver.redact ? driver.redact(s) : s);
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error(redact(`admin manual: ${(e && (e.code || e.name)) || "error"}`));
    if (!res.headersSent) res.status(500).json({ error: "internal" });
  });

  // Every phone the tab may name: connected agents and those with campaigns.
  async function phones() {
    const connected = await x.store.listConnectedPhones("facebook").catch(() => []);
    const running = (await x.store.listPostingCampaignsByStatus("running", 500)).map((c) => c.phone);
    return [...new Set(connected.concat(running).map(String))];
  }
  async function phoneOf(ref) {
    // An open browser answers from memory: /state polls every 1.5s.
    for (const p of open.keys()) if (M.refOf(p) === String(ref)) return p;
    return (await phones()).find((p) => M.refOf(p) === String(ref)) || null;
  }
  const attachView = (phone, sessionId) => viewer.attach(key(phone), sessionId, { idleMs: VIEW_IDLE_MS });
  async function cardOf(phone, pageId) {
    const page = await x.db.getPage(String(pageId));
    return page && page.business_phone === phone ? M.propertyCard(page, deps.pageBaseUrl) : null;
  }
  const hubPage = (phone) => { const h = viewer._hubs && viewer._hubs.get(key(phone)); return (h && !h.closed && h.page) || null; };

  // Listen for Facebook's file chooser on every page of the agent's browser:
  // with a listener on, Playwright intercepts it (no native dialog) and the
  // tab can light up "העלאת הסרטון".
  function hookChooser(phone) {
    const h = viewer._hubs && viewer._hubs.get(key(phone));
    if (!h || h.closed || !h.context) return;
    const s = open.get(phone);
    const hook = (p) => {
      if (!p || hooked.has(p) || typeof p.on !== "function") return;
      hooked.add(p);
      p.on("filechooser", (fc) => { const cur = open.get(phone); if (cur) cur.chooser = { fc, at: Date.now() }; });
    };
    (h.context.pages ? h.context.pages() : []).forEach(hook);
    if (!hooked.has(h.context)) { hooked.add(h.context); h.context.on("page", hook); }
    if (s) s.hooked = true;
  }

  async function closeFor(phone, reason) {
    const s = open.get(phone);
    if (!s) return;
    open.delete(phone);
    clearTimeout(s.timer);
    await viewer.close(key(phone), reason).catch(() => {});
    await driver.stopSession(s.sessionId).catch(() => {});
    s.release();
  }

  // ── the work list ──
  // The checklist (every running campaign, all its groups) and, from it, the
  // groups still owed.
  router.get("/queue", requireAdmin, wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const campaigns = await M.checklist(deps);
    res.json({ campaigns, items: M.queueOf(campaigns) });
  }));

  router.post("/campaigns/:id/groups/:gid/done", requireAdmin, wrap(async (req, res) => {
    const status = req.body && req.body.status;
    if (!["posted", "skipped"].includes(status)) return res.status(400).json({ error: "invalid_input" });
    const override = req.body && typeof req.body.override_reason === "string" ? req.body.override_reason.trim() : null;
    if (override !== null && (override.length < 3 || override.length > 200)) return res.status(400).json({ error: "invalid_input" });
    if (status === "posted") {
      const cur = await x.store.getPostingCampaign(String(req.params.id));
      if (cur && M.owed(cur).some((g) => String(g.group_id) === String(req.params.gid))) {
        const config = await A.configOf(deps, x);
        const lim = L.limitsFor(cur, await x.store.listPostingCampaignsByPhone(cur.phone), x.clock(), config)[String(req.params.gid)];
        if (lim && lim.block && !override) return res.status(409).json({ error: "group_limit", why: lim.block.why, until: lim.block.until });
        if (lim && lim.block) {
          // store-facing tails are digits only (A.tail's "…" prefix is display-only). Fail closed: no audit, no override.
          const dtail = (p) => String(p || "").replace(/\D/g, "").slice(-4);
          const audited = await x.store.addAuditEvent({ operator_tail: dtail(req.user && req.user.userId), action: "manual_limit_override", target_phone_tail: dtail(cur.phone),
            reason: override, detail: { why: lim.block.why, campaign_tail: String(cur.id).slice(-6) } }, x.clock()).then(() => true, () => false);
          if (!audited) return res.status(500).json({ error: "internal" });
        }
      }
    }
    const c = await M.markDone(String(req.params.id), String(req.params.gid), status, deps);
    if (!c) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, completed: c.status === "completed" });
  }));

  // ── agents and their properties ──
  router.get("/agents", requireAdmin, wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const [q, all] = await Promise.all([M.queue(deps), phones()]);
    const rows = await Promise.all(all.map(async (phone) => {
      const conn = (await x.db.getConnection(phone)) || {};
      if (!conn.facebook_browser_connected_at) return null;
      const biz = (await x.db.getBusiness(phone).catch(() => null)) || {};
      const ref = M.refOf(phone);
      return { ref, phone_tail: A.tail(phone), name: conn.facebook_identity_label || biz.name || biz.business_name || "", owed: q.filter((i) => i.ref === ref).length, open: open.has(phone) };
    }));
    const out = rows.filter(Boolean);
    out.sort((a, b) => b.owed - a.owed || String(a.name).localeCompare(String(b.name)));
    res.json({ agents: out });
  }));

  // ── agents who started a Facebook login but are not marked connected ──
  // (logged in, then closed the window instead of pressing done). One read
  // per agent, only when the admin opens this list.
  async function unconnected() {
    const out = [];
    for (const b of await x.db.listAllBusinesses().catch(() => [])) {
      if (!b || !b.phone) continue;
      const conn = (await x.db.getConnection(String(b.phone)).catch(() => null)) || {};
      if (!conn.browser_consent_at || conn.facebook_browser_connected_at) continue;
      if (["revoked", "quarantined"].includes(conn.facebook_profile_state)) continue;
      out.push({ phone: String(b.phone), name: b.full_name || b.business_name || "", started_at: conn.browser_consent_at });
    }
    return out;
  }
  router.get("/unconnected", requireAdmin, wrap(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const list = await unconnected();
    res.json({ agents: list.map((a) => ({ ref: M.refOf(a.phone), phone_tail: A.tail(a.phone), name: a.name, started_at: a.started_at })) });
  }));
  // Opens the agent's saved profile, checks the login, and marks the agent
  // connected only when it is logged in (login-verify.js).
  router.post("/unconnected/:ref/verify", requireAdmin, wrap(async (req, res) => {
    const hit = (await unconnected()).find((a) => M.refOf(a.phone) === String(req.params.ref));
    if (!hit) return res.status(404).json({ error: "not_found" });
    const r = await (deps.verifySaved || require("../login-verify").verifySaved)(hit.phone, "facebook", { db: x.db, driver });
    if (r.error) return res.status(r.error === "profile_busy" || r.error === "driver_busy" ? 409 : 502).json({ error: r.error });
    res.json(r);
  }));

  router.get("/agents/:ref/properties", requireAdmin, wrap(async (req, res) => {
    const phone = await phoneOf(req.params.ref);
    if (!phone) return res.status(404).json({ error: "not_found" });
    // Only properties with a running campaign: nothing else is to be posted.
    const cards = [];
    for (const c of await x.store.listPostingCampaignsByStatus("running", 500)) {
      if (String(c.phone) !== phone) continue;
      const card = await cardOf(phone, c.page_id).catch(() => null);
      if (card) cards.push(card);
    }
    res.json({ properties: cards });
  }));

  // One property in full: every version of its text, and the groups the agent
  // picked for it with where each stands (its campaign, when there is one).
  router.get("/agents/:ref/properties/:pageId", requireAdmin, wrap(async (req, res) => {
    const phone = await phoneOf(req.params.ref);
    const page = phone && (await x.db.getPage(String(req.params.pageId)));
    if (!page || page.business_phone !== phone) return res.status(404).json({ error: "not_found" });
    const c = await x.store.getPostingCampaign(x.store.campaignId(phone, page.page_id)).catch(() => null);
    res.set("Cache-Control", "no-store");
    res.json({
      property: M.propertyCard(page, deps.pageBaseUrl), versions: M.versions(page, deps.pageBaseUrl),
      campaign: c ? { id: c.id, status: c.status } : null, groups: M.groupsOf(c),
    });
  }));

  // ── the agent's browser ──
  // group_url (optional): the browser starts on that group instead of the
  // home feed — at_group says it did (an already open browser does not move).
  router.post("/agents/:ref/browser", requireAdmin, wrap(async (req, res) => {
    const phone = await phoneOf(req.params.ref);
    if (!phone) return res.status(404).json({ error: "not_found" });
    const groupUrl = String((req.body && req.body.group_url) || "");
    if (groupUrl && !GROUP_URL.test(groupUrl)) return res.status(400).json({ error: "invalid_input" });
    if (open.has(phone)) return res.json({ open: true, at_group: false });
    const conn = (await x.db.getConnection(phone)) || {};
    if (!conn.facebook_browser_connected_at) return res.status(409).json({ error: "facebook_not_connected" });
    const release = locks.tryAcquire(phone, "facebook");
    if (!release) return res.status(409).json({ error: "profile_busy" });
    try {
      const { profileName } = require("../profile-name");
      const s = await driver.createSession({
        duration: SESSION_S, url: groupUrl || "https://www.facebook.com/",
        profile: { name: profileName("facebook", phone, conn.facebook_profile_gen || 0), persist: true },
        note: "forly-manual:facebook", // never the phone
      }, { phone });
      const timer = setTimeout(() => closeFor(phone, "expired"), SESSION_S * 1000);
      if (timer.unref) timer.unref();
      open.set(phone, { sessionId: s.sessionId, release, timer, pageId: null, chooser: null });
      res.json({ open: true, at_group: !!groupUrl });
      // Connect the viewer now, while the admin's screen mounts: the first
      // frame no longer waits for Driver + CDP after the view is asked for.
      attachView(phone, s.sessionId).then(() => hookChooser(phone)).catch(() => {});
    } catch (e) {
      release();
      console.error(redact(`admin manual browser ${A.tail(phone)}: ${(e && (e.code || e.name)) || "error"}`));
      res.status(503).json({ error: "browser_unavailable" });
    }
  }));

  // The routes below act on the agent's open browser.
  const withBrowser = (fn) => wrap(async (req, res) => {
    const phone = await phoneOf(req.params.ref);
    if (!phone) return res.status(404).json({ error: "not_found" });
    const s = open.get(phone);
    if (!s) return res.status(409).json({ error: "no_open_browser" });
    return fn(req, res, phone, s);
  });

  router.get("/agents/:ref/browser/view", requireAdmin, withBrowser(async (req, res, phone, s) => {
    let hub;
    try { hub = await attachView(phone, s.sessionId); }
    catch (e) {
      const code = (e && e.code) || "viewer_unavailable";
      if (code === "session_expired") await closeFor(phone, "expired");
      return res.status(code === "session_expired" ? 409 : 503).json({ error: code });
    }
    hookChooser(phone);
    viewer.pipe(req, res, hub);
  }));

  router.post("/agents/:ref/browser/view/input", requireAdmin, withBrowser(async (req, res, phone) => {
    try { res.json(await viewer.input(key(phone), req.body)); }
    catch (e) { res.status({ no_viewer: 409, invalid_input: 400, slow_down: 429 }[e && e.code] || 502).json({ error: (e && e.code) || "input_failed" }); }
  }));

  // The property this session is sharing: one of this agent's own.
  router.post("/agents/:ref/browser/property", requireAdmin, withBrowser(async (req, res, phone, s) => {
    const card = await cardOf(phone, (req.body && req.body.page_id) || "");
    if (!card) return res.status(404).json({ error: "not_found" });
    s.pageId = card.page_id;
    prefetchVideo(s);
    res.json({ property: card });
  }));

  router.get("/agents/:ref/browser/state", requireAdmin, withBrowser(async (req, res, phone, s) => {
    res.set("Cache-Control", "no-store");
    hookChooser(phone);
    const page = hubPage(phone);
    let path = null;
    try { path = page ? new URL(page.url()).pathname : null; } catch { path = null; }
    res.json({
      open: true, property: s.pageId ? await cardOf(phone, s.pageId) : null,
      chooser_open: !!(s.chooser && Date.now() - s.chooser.at < CHOOSER_FRESH_MS), url_path: path,
    });
  }));

  router.post("/agents/:ref/browser/goto", requireAdmin, withBrowser(async (req, res, phone) => {
    const url = String((req.body && req.body.group_url) || "");
    if (!GROUP_URL.test(url)) return res.status(400).json({ error: "invalid_input" });
    const page = hubPage(phone);
    if (!page) return res.status(409).json({ error: "no_viewer" });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    res.json({ ok: true });
  }));

  // Types the text where the cursor is (the admin clicks the composer first):
  // each line as text, Enter between lines — what the posting driver does.
  router.post("/agents/:ref/browser/type", requireAdmin, withBrowser(async (req, res, phone) => {
    const text = req.body && req.body.text;
    if (typeof text !== "string" || !text.trim() || text.length > 5000) return res.status(400).json({ error: "invalid_input" });
    const page = hubPage(phone);
    if (!page) return res.status(409).json({ error: "no_viewer" });
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await page.keyboard.press("Enter");
      if (lines[i]) await page.keyboard.insertText(lines[i]);
    }
    res.json({ ok: true });
  }));

  // The property's video, downloaded (and shrunk) as soon as the property is
  // picked, so "העלאת הסרטון" only hands Facebook the bytes. A failed fetch is
  // retried on the click.
  function videoFor(s, page) {
    const url = page && require("../posting-campaign").videoOf(page).video_url;
    if (!url) return null;
    if (!s.video || s.video.url !== url) {
      const promise = media.fetchVideo(url, deps);
      s.video = { url, promise };
      promise.catch(() => { if (s.video && s.video.promise === promise) s.video = null; });
    }
    return s.video.promise;
  }
  function prefetchVideo(s) {
    const pageId = s.pageId;
    x.db.getPage(pageId).then((page) => { if (s.pageId === pageId) { const p = videoFor(s, page); if (p) p.catch(() => {}); } }).catch(() => {});
  }

  // The session property's video into Facebook: the file chooser the admin
  // just opened ("תמונה/סרטון"), else the composer's own file input.
  router.post("/agents/:ref/browser/video", requireAdmin, withBrowser(async (req, res, phone, s) => {
    if (!s.pageId) return res.status(409).json({ error: "no_property" });
    const page = await x.db.getPage(s.pageId);
    if (!(page && require("../posting-campaign").videoOf(page).video_url)) return res.status(409).json({ error: "no_video" });
    const chooser = s.chooser && Date.now() - s.chooser.at < CHOOSER_FRESH_MS ? s.chooser.fc : null;
    const hp = hubPage(phone);
    let input = null;
    if (!chooser && hp) {
      const { SELECTORS: S } = require("../posting-driver-proof");
      const loc = hp.locator(S.mediaInput).first();
      if ((await loc.count().catch(() => 0)) > 0) input = loc;
    }
    if (!chooser && !input) return res.status(409).json({ error: "chooser_not_open" });
    let file;
    try { file = await videoFor(s, page); }
    catch (e) { return res.status(502).json({ error: (e && e.code) || "media_unavailable" }); }
    if (chooser) { await chooser.setFiles(file); s.chooser = null; }
    else await input.setInputFiles(file);
    res.json({ ok: true });
  }));

  router.delete("/agents/:ref/browser", requireAdmin, wrap(async (req, res) => {
    const phone = await phoneOf(req.params.ref);
    if (!phone) return res.status(404).json({ error: "not_found" });
    await closeFor(phone, "closed");
    res.json({ ok: true });
  }));

  return router;
};
