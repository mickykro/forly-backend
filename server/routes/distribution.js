/*
 * routes/distribution.js — /api/distribution: Meta OAuth, one-tap confirm,
 * publish, groups, status.
 *
 * Identity rules:
 *  - oauth/callback + oauth/select: HMAC state token ONLY (10-min TTL) — the
 *    agent arrives from WhatsApp without a session cookie.
 *  - confirm: signed action token bound to the distribution id.
 *  - publish/groups/status: session auth + owner check.
 * Tokens/snapshots never leave the server; vendor error text never reaches
 * the browser (spec §7).
 */

const crypto = require("node:crypto");
const express = require("express");
const db = require("../db");
const jobs = require("../distribution/jobs");
const meta = require("../distribution/meta");
const shareKit = require("../distribution/share-kit");
const config = require("../distribution/config");
const businessCache = require("../business-cache");

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Same card shell as routes/pages.js confirmHtml — Hebrew, RTL, self-contained.
// `redirectTo` auto-forwards after 2s (used to land back on the dashboard
// once a connect completes) while the card gives visible confirmation.
const card = (title, sub, extraHtml = "", redirectTo = null) =>
  `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8">` +
  (redirectTo ? `<meta http-equiv="refresh" content="2;url=${esc(redirectTo)}">` : "") +
  `<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>` +
  `<style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#F7F3EC;color:#17140F;` +
  `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}` +
  `.card{background:#FFFDF9;border:1px solid rgba(185,138,47,.3);border-radius:22px;padding:48px 36px;` +
  `max-width:360px;box-shadow:0 20px 60px rgba(23,20,15,.08)}h1{font-size:1.4rem;margin:0 0 10px}` +
  `p{color:#5A5348;margin:0 0 8px}button{background:#B98A2F;color:#fff;border:0;border-radius:12px;` +
  `padding:12px 18px;font-size:1rem;width:100%;margin-top:10px;cursor:pointer}</style></head>` +
  `<body><div class="card"><h1>${esc(title)}</h1><p>${esc(sub)}</p>${extraHtml}</div></body></html>`;

module.exports = function createDistributionRouter(ctx) {
  const { requireAuth, verifyActionToken, verifySession, readToken,
          authSecret, pageBaseUrl, greenInstance, greenToken } = ctx;
  const deps = jobs.liveDeps({ greenInstance, greenToken, pageBaseUrl, authSecret });
  const router = express.Router();
  // The page-picker posts a plain HTML form (no session, no JS required).
  router.use(express.urlencoded({ extended: false }));

  const envOk = () => !!(process.env.META_APP_ID && process.env.META_APP_SECRET &&
    process.env.META_REDIRECT_URL);
  const gv = () => process.env.META_GRAPH_VERSION || meta.DEFAULT_VERSION;
  // META_SCOPES (comma-separated) narrows the OAuth request while some
  // permissions aren't yet enabled on the Meta app; absent ⇒ full SCOPES.
  const activeScopes = () => {
    const raw = String(process.env.META_SCOPES || "").trim();
    const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    return list.length ? list : meta.SCOPES;
  };

  // OAuth state is signed, but never accept an arbitrary return URL from the
  // initial request. A property workspace is the only supported direct return.
  const publishWorkspacePath = (pageId) => {
    const id = String(pageId || "").trim();
    return id && id.length <= 160 ? `/publish.html?page=${encodeURIComponent(id)}&connected=1` : null;
  };
  const oauthReturnPath = (state) =>
    String((state && state.return_to) || "").startsWith("/publish.html?")
      ? state.return_to
      : "/distribution.html?connected=1";

  // ── GET /oauth/start — logged-in agent → Facebook consent ──
  router.get("/oauth/start", requireAuth(authSecret), (req, res) => {
    if (!envOk()) return res.status(503).json({ error: "distribution_not_configured" });
    const state = meta.makeState({
      phone: req.user.userId,
      return_to: publishWorkspacePath(req.query.page_id),
    }, authSecret);
    res.redirect(meta.oauthStartUrl({
      appId: process.env.META_APP_ID,
      redirectUrl: process.env.META_REDIRECT_URL,
      state, graphVersion: gv(), scopes: activeScopes(),
    }));
  });

  // Store the chosen page as the connection. pending_pages is transient and
  // cleared on selection; tokens are data, never logged.
  async function storeConnection(phone, userToken, page) {
    let igBusinessId = null;
    try {
      const r = await meta.graphCall(`/${page.id}`, { graphVersion: gv(),
        token: page.access_token, params: { fields: "instagram_business_account" } });
      igBusinessId = (r.instagram_business_account && r.instagram_business_account.id) || null;
    } catch (e) { /* IG link is optional — page connect must not fail on it */ }
    await db.setConnection(phone, {
      user_token: userToken, page_id: page.id, page_name: page.name,
      page_token: page.access_token, ig_business_id: igBusinessId,
      scopes: activeScopes(), connected_at: new Date(),
      needs_reconnect: false, pending_pages: null,
    });
  }

  // ── GET /oauth/callback — identity from the HMAC state only ──
  router.get("/oauth/callback", async (req, res) => {
    const state = meta.readState(String(req.query.state || ""), authSecret);
    if (!state || !state.phone) {
      return res.status(401).type("html").send(card("הקישור פג תוקף",
        "התחילו שוב את החיבור מעמוד ההפצה בדשבורד."));
    }
    if (req.query.error || !req.query.code) {
      return res.type("html").send(card("החיבור בוטל",
        "לא ניתנה הרשאה. אפשר לנסות שוב מעמוד ההפצה בדשבורד."));
    }
    try {
      const returnTo = oauthReturnPath(state);
      const returnLabel = returnTo.startsWith("/publish.html?") ? "לעמוד הפרסום" : "לעמוד ההפצה";
      const short = await meta.exchangeCode({ code: String(req.query.code),
        appId: process.env.META_APP_ID, appSecret: process.env.META_APP_SECRET,
        redirectUrl: process.env.META_REDIRECT_URL, graphVersion: gv() });
      const long = await meta.longLivedToken({ token: short.access_token,
        appId: process.env.META_APP_ID, appSecret: process.env.META_APP_SECRET,
        graphVersion: gv() });
      const pages = await meta.listPages({ userToken: long.access_token, graphVersion: gv() });
      if (!pages.length) {
        return res.type("html").send(card("לא נמצא דף פייסבוק",
          "לחשבון שחובר אין דף עסקי. צרו דף פייסבוק לעסק ונסו שוב."));
      }
      if (pages.length === 1) {
        await storeConnection(state.phone, long.access_token, pages[0]);
        return res.type("html").send(card("✅ החיבור הושלם",
          `הדף "${pages[0].name}" חובר. מחזירים אתכם לעמוד הפרסום…`,
          `<a href="${esc(returnTo)}"><button>${returnLabel}</button></a>`,
          returnTo));
      }
      // Multi-page: stash the candidates, re-sign a fresh state, render picker.
      await db.setConnection(state.phone, {
        pending_pages: pages.map((p) => ({ id: p.id, name: p.name, access_token: p.access_token })),
        user_token: long.access_token,
      });
      const pickState = meta.makeState({ phone: state.phone, return_to: returnTo }, authSecret);
      const buttons = pages.map((p) =>
        `<form method="POST" action="/api/distribution/oauth/select">` +
        `<input type="hidden" name="state" value="${esc(pickState)}">` +
        `<input type="hidden" name="page_id" value="${esc(p.id)}">` +
        `<button type="submit">${esc(p.name)}</button></form>`).join("");
      return res.type("html").send(card("באיזה דף לפרסם?",
        "נמצאו כמה דפים בחשבון — בחרו אחד:", buttons));
    } catch (err) {
      console.error("oauth/callback failed:", err && err.message);
      return res.status(502).type("html").send(card("החיבור נכשל",
        "משהו השתבש מול פייסבוק. נסו שוב בעוד רגע."));
    }
  });

  // ── POST /oauth/select — the picker submit (form-encoded, state-authed) ──
  router.post("/oauth/select", async (req, res) => {
    const state = meta.readState(String((req.body && req.body.state) || ""), authSecret);
    if (!state || !state.phone) {
      return res.status(401).type("html").send(card("הקישור פג תוקף",
        "התחילו שוב את החיבור מעמוד ההפצה בדשבורד."));
    }
    const conn = await db.getConnection(state.phone);
    const pick = conn && Array.isArray(conn.pending_pages) &&
      conn.pending_pages.find((p) => p.id === String(req.body.page_id || ""));
    if (!pick) {
      return res.status(400).type("html").send(card("בחירה לא תקינה",
        "התחילו שוב את החיבור מעמוד ההפצה בדשבורד."));
    }
    await storeConnection(state.phone, conn.user_token, pick);
    const returnTo = oauthReturnPath(state);
    const returnLabel = returnTo.startsWith("/publish.html?") ? "לעמוד הפרסום" : "לעמוד ההפצה";
    res.type("html").send(card("✅ החיבור הושלם",
      `הדף "${pick.name}" חובר. מחזירים אתכם לעמוד הפרסום…`,
      `<a href="${esc(returnTo)}"><button>${returnLabel}</button></a>`,
      returnTo));
  });

  // ── GET /confirm?d=&t= — the one-tap WhatsApp link ──
  router.get("/confirm", async (req, res) => {
    const id = String(req.query.d || "");
    const t = String(req.query.t || "");
    if (!id || !verifyActionToken([id, "confirm"], t, authSecret)) {
      return res.status(401).type("html").send(card("הקישור אינו תקף",
        "אפשר לפרסם דרך עמוד ההפצה בדשבורד."));
    }
    const dist = await db.getDistribution(id);
    if (!dist) return res.status(404).type("html").send(card("הקישור אינו תקף",
      "אפשר לפרסם דרך עמוד ההפצה בדשבורד."));
    // Replay / stale link handling: honest cards, no accidental repost.
    const sibs = await db.listDistributionsByPage(dist.page_id);
    const posted = sibs.find((s) => jobs.hasLivePost([s]));
    if (posted) {
      const postUrl = posted.targets.facebook_page.post_url;
      return res.type("html").send(card("הנכס כבר פורסם",
        "כדי לפרסם שוב בכוונה — עמוד ההפצה בדשבורד.",
        (postUrl ? `<a href="${esc(postUrl)}"><button>לצפייה בפוסט</button></a>` : "") +
        `<a href="/distribution.html"><button>לעמוד ההפצה</button></a>`));
    }
    if (dist.status !== "awaiting_confirm") {
      return res.type("html").send(card("הפרסום כבר בתהליך",
        "נשלח עדכון בוואטסאפ כשהפוסט יעלה."));
    }
    try {
      await jobs.enqueueFromConfirm(deps, dist, "confirm_link");
      return res.type("html").send(card("✅ אושר!",
        "הנכס בדרך לדף הפייסבוק שלכם. עדכון ישלח בוואטסאפ בדקות הקרובות.",
        `<a href="${esc(`${pageBaseUrl}/p/${dist.page_id}`)}"><button>לצפייה בדף הנכס</button></a>`));
    } catch (err) {
      console.error("confirm enqueue failed:", err && err.message);
      return res.status(500).type("html").send(card("משהו השתבש",
        "נסו שוב, או פרסמו מעמוד ההפצה בדשבורד."));
    }
  });

  // ── POST /publish — dashboard button ──
  router.post("/publish", requireAuth(authSecret), async (req, res) => {
    const pageId = String((req.body && req.body.page_id) || "");
    const force = (req.body && req.body.force) === true;
    if (!pageId) return res.status(400).json({ error: "page_id required" });
    const page = await db.getPage(pageId);
    if (!page) return res.status(404).json({ error: "not_found" });
    if (page.business_phone !== req.user.userId) {
      return res.status(403).json({ error: "not_owner" });
    }
    const biz = await db.getBusiness(req.user.userId);
    if (!config.resolve(biz, process.env).enabled) {
      return res.status(403).json({ error: "not_entitled" });
    }
    const sibs = await db.listDistributionsByPage(pageId);
    if (sibs.some((d) => d.status === "queued" || d.status === "running")) {
      return res.status(409).json({ error: "already_in_flight" });
    }
    if (jobs.hasLivePost(sibs) && !force) {
      return res.status(409).json({ error: "already_published" });
    }
    // A dashboard publish supersedes any stale confirm offer for this page.
    for (const d of sibs) {
      if (d.status === "awaiting_confirm") {
        await db.updateDistribution(d.id, { status: "superseded", updated_at: new Date() });
      }
    }
    const dist = await jobs.createQueued(deps, { page, business: biz,
      trigger: "dashboard", force });
    res.json({ ok: true, distribution_id: dist.id });
  });

  // ── GET /group-catalog — curated groups for the dashboard picker ──
  // The bundled seed (Manus research, 50 groups — see
  // docs/distribution/GROUP-CATALOG.md) is the always-present default;
  // Firestore entries merge ON TOP by URL, so the operator can add groups,
  // override names/cities, or disable a seed entry with active:false —
  // all without a deploy. URLs normalized so checkbox state matches the
  // agent's saved (sanitized) list.
  const GROUP_SEED = require("../distribution/group-seed.json")
    .map((g) => ({ ...g, url: shareKit.sanitizeGroups([g.url])[0] }))
    .filter((g) => g.url);
  // listing_type=sale|rent marks which groups actually accept that kind of
  // listing, so a sale isn't pushed at rental-only groups. Nothing is
  // hidden — mismatches are flagged and sorted last, the agent decides.
  async function mergedCatalog(want) {
    const byUrl = new Map();
    for (const g of GROUP_SEED) byUrl.set(g.url, { ...g, active: true });
    for (const g of await db.listGroupCatalog()) {
      const url = g.url && shareKit.sanitizeGroups([g.url])[0];
      if (url) byUrl.set(url, { ...(byUrl.get(url) || {}), ...g, url });
    }
    return [...byUrl.values()]
      .filter((g) => g.active !== false)
      .map((g) => {
        const types = Array.isArray(g.listing_types) ? g.listing_types : [];
        return {
          name: g.name || g.url, url: g.url,
          city: g.city || null, members: Number(g.members) || null,
          listing_types: types,
          languages: Array.isArray(g.languages) ? g.languages : [],
          // "unknown" is honest: group rules cannot be inferred from a name.
          // The curated 2026-08 set may use explicitly_allowed only when its
          // stored public evidence names a broker/agent/professional listing rule.
          agent_policy: g.agent_policy || "unknown",
          policy_evidence: g.policy_evidence || null,
          source_url: g.source_url || null,
          curated_at: g.curated_at || null,
          match: !want || !types.length || types.includes(want),
        };
      });
  }

  router.get("/group-catalog", requireAuth(authSecret), async (req, res) => {
    const want = String(req.query.listing_type || "").trim();
    const catalog = await mergedCatalog(want);
    const business = await db.getBusiness(req.user.userId);
    const selected = shareKit.sanitizeGroups(
      (business && business.distribution && business.distribution.groups) || []);
    res.json({
      groups: catalog,
      listing_type: want || null,
      selected_groups: selected,
      selected_count: selected.length,
    });
  });

  // ── POST /group-catalog/suggest — agent offers a group ──
  // Immediately usable by the suggesting agent (merged into their own list);
  // lands in the catalog as active:false until the operator curates it.
  router.post("/group-catalog/suggest", requireAuth(authSecret), async (req, res) => {
    const url = shareKit.sanitizeGroups([(req.body && req.body.url) || ""])[0];
    if (!url) return res.status(400).json({ error: "invalid_group_url" });
    const name = String((req.body && req.body.name) || "").slice(0, 80);
    await db.addGroupCatalogEntry({ url, name, active: false,
      suggested_by: req.user.userId });
    const biz = await db.getBusiness(req.user.userId);
    const groups = shareKit.sanitizeGroups(
      [...((biz && biz.distribution && biz.distribution.groups) || []), url]);
    await db.setBusiness(req.user.userId, {
      distribution: { groups }, updated_at: new Date() });
    businessCache.invalidate(req.user.userId);
    res.json({ ok: true, url, groups });
  });

  // ── POST /group-catalog/import — bulk import from research automations ──
  // Secret-gated (same pattern as /api/admin/backfill-tags): the n8n → Manus
  // group-research workflow posts { groups: [{name,url,city,members}] } here
  // with the x-admin-secret header. Dedupes by URL; entries land active:true.
  router.post("/group-catalog/import", async (req, res) => {
    if (authSecret === "change-me-in-env" || req.get("x-admin-secret") !== authSecret) {
      return res.status(403).json({ error: "forbidden" });
    }
    const items = Array.isArray(req.body && req.body.groups) ? req.body.groups : [];
    const existing = new Set((await db.listGroupCatalog(500)).map((g) => g.url));
    let added = 0, skipped = 0;
    for (const item of items.slice(0, 200)) {
      const url = shareKit.sanitizeGroups([(item && item.url) || ""])[0];
      if (!url || existing.has(url)) { skipped++; continue; }
      existing.add(url);
      await db.addGroupCatalogEntry({
        url,
        name: String((item && item.name) || "").slice(0, 80) || url,
        city: item && item.city ? String(item.city).slice(0, 40) : null,
        members: Number(item && item.members) || null,
        active: true, source: "import",
      });
      added++;
    }
    res.json({ ok: true, added, skipped, received: items.length });
  });

  // ── POST /groups — save the agent's group list ──
  router.post("/groups", requireAuth(authSecret), async (req, res) => {
    const groups = shareKit.sanitizeGroups((req.body && req.body.groups) || []);
    await db.setBusiness(req.user.userId, {
      distribution: { groups }, updated_at: new Date() });
    businessCache.invalidate(req.user.userId);
    res.json({ ok: true, groups, min_recommended: 5 });
  });

  // ── GET /share-kit?page_id= — the share kit for the dashboard dialog ──
  // Same content the WhatsApp kit carries, as JSON: post copy (for the
  // copy-to-clipboard button), the quote-prefilled quick-share link, and the
  // agent's group links. Built live from the current page + groups.
  router.get("/share-kit", requireAuth(authSecret), async (req, res) => {
    const pageId = String(req.query.page_id || "");
    if (!pageId) return res.status(400).json({ error: "page_id required" });
    const page = await db.getPage(pageId);
    if (!page || page.business_phone !== req.user.userId) {
      return res.status(404).json({ error: "not_found" });
    }
    const biz = await db.getBusiness(req.user.userId);
    const pageUrl = `${pageBaseUrl}/p/${pageId}`;
    const copy = shareKit.buildPostCopy(page, pageUrl);
    res.json({
      copy,
      page_url: pageUrl,
      quick_share: shareKit.sharerLink(pageUrl,
        { quote: copy, appId: process.env.META_APP_ID || null }),
      groups: shareKit.sanitizeGroups(
        (biz && biz.distribution && biz.distribution.groups) || []),
    });
  });

  // ── the group sharing queue ──
  // Auth is EITHER the owner's session OR the signed link from WhatsApp, so
  // the agent goes from the message to the queue in one tap on mobile.
  async function loadSession(req) {
    const id = String(req.query.s || (req.body && req.body.s) || "");
    if (!id) return null;
    const session = await db.getShareSession(id);
    if (!session) return null;
    const token = String(req.query.t || (req.body && req.body.t) || "");
    if (token && verifyActionToken([id, "share"], token, authSecret)) return session;
    const sess = verifySession && readToken && verifySession(authSecret, readToken(req));
    if (sess && sess.userId === session.business_phone) return session;
    return null;
  }

  const publicSession = (s, extra = {}) => ({
    id: s.id, page_id: s.page_id,
    title: s.snapshot.title, page_url: s.snapshot.page_url,
    post_url: s.snapshot.post_url || null,
    copy: s.snapshot.copy,
    city: s.snapshot.city || null,
    listing_type: s.snapshot.listing_type || "sale",
    quick_share: shareKit.sharerLink(s.snapshot.page_url,
      { quote: s.snapshot.copy, appId: process.env.META_APP_ID || null }),
    groups: (s.groups || []).map((g) => ({
      key: g.key, url: g.url, state: g.state,
      name: (catalogNames.get(g.url) || null),
      // Per-group copy: identical facts, tracked link (review §3 + §5).
      copy: s.snapshot.copy.replace(s.snapshot.page_url,
        shareKit.trackedUrl(s.snapshot.page_url, { session: s.id, group: g.token })),
    })),
    ...extra,
  });

  // Name lookup for group URLs, so the queue shows "דירות להשכרה בחיפה"
  // rather than a raw slug. Built once from the bundled seed.
  const catalogNames = new Map(GROUP_SEED.map((g) => [g.url, g.name]));

  // Everything the queue needs to pick groups on the spot: the matched
  // catalog, plus — the point of the feature — an offer to reuse the groups
  // already chosen for another property in the SAME city.
  async function pickerFor(session) {
    const catalog = await mergedCatalog(session.snapshot.listing_type || "sale");
    // Reuse offer: the same city is the best match, but "the groups I picked
    // last time" is worth offering in ANY city — most agents work one area
    // and re-tick the same list otherwise.
    const city = session.snapshot.city;
    const mine = (await db.listPropertyGroupsByPhone(session.business_phone)
      .catch(() => []))
      .filter((d) => d.page_id !== session.page_id &&
        Array.isArray(d.groups) && d.groups.length)
      .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
    const src = (city && mine.find((d) => d.city === city)) || mine[0] || null;
    const suggestion = src ? {
      city: src.city || null, same_city: !!(city && src.city === city),
      from_page_id: src.page_id, title: src.title || "", groups: src.groups,
    } : null;
    return { catalog, suggestion };
  }

  // Use one implementation whenever a queue's target URLs change. A retained
  // queue must keep its existing progress for URLs that remain selected, while
  // a newly added URL receives a fresh tracking key/token. This prevents the
  // dashboard and property picker from disagreeing about targets.
  function queueEntriesForGroups(session, urls) {
    const byUrl = new Map((session.groups || []).map((g) => [g.url, g]));
    return urls.map((url) => byUrl.get(url) || {
      key: jobs.groupKey(url), url,
      token: crypto.randomBytes(6).toString("base64url"),
      state: "ready", copied_at: null, opened_at: null,
      marked_posted_at: null, skipped_at: null, skip_reason: null,
    });
  }

  async function replaceShareSessionGroups(session, urls) {
    const groups = queueEntriesForGroups(session, urls);
    await db.updateShareSession(session.id, { groups, updated_at: new Date() });
    return { ...session, groups };
  }

  // Create (or reopen) a queue for one property — the dashboard button.
  router.post("/share-session", requireAuth(authSecret), async (req, res) => {
    const pageId = String((req.body && req.body.page_id) || "");
    const page = await db.getPage(pageId);
    if (!page || page.business_phone !== req.user.userId) {
      return res.status(404).json({ error: "not_found" });
    }
    const existing = await db.findOpenShareSession(pageId);
    const biz = await db.getBusiness(req.user.userId);
    // This property's own groups win; the agent's default list is a fallback.
    const currentGroups = await jobs.resolveGroups(deps, page, biz);
    // Reuse an existing queue unless the agent's group list changed since —
    // progress is worth more than a perfectly fresh snapshot.
    const sameGroups = existing &&
      existing.groups.length === currentGroups.length &&
      existing.groups.every((g) => currentGroups.includes(g.url));
    const session = sameGroups ? existing
      : await jobs.createShareSession(deps, { page, business: biz });
    // The property workspace always receives the catalog so its targets can be
    // reviewed and changed after defaults have populated the queue.
    const extra = await pickerFor(session);
    res.json(publicSession(session, extra));
  });

  router.get("/share-session", async (req, res) => {
    const session = await loadSession(req);
    if (!session) return res.status(401).json({ error: "invalid_link" });
    // Always ship the picker and same-city reuse offer. A session can start
    // with defaults and still need an explicit property-specific override.
    const extra = await pickerFor(session);
    res.json(publicSession(session, extra));
  });

  // Set THIS property's groups from inside the queue. Saved per property
  // (property_groups/{page_id}) — not on the agent's default list, and not
  // on the page doc, which n8n overwrites on every rebuild.
  router.post("/share-session/groups", async (req, res) => {
    const session = await loadSession(req);
    if (!session) return res.status(401).json({ error: "invalid_link" });
    const groups = shareKit.sanitizeGroups((req.body && req.body.groups) || []);
    await db.savePropertyGroups({
      page_id: session.page_id, business_phone: session.business_phone,
      city: session.snapshot.city || null, title: session.snapshot.title || "",
      groups,
    });
    // Rebuild the queue's entries, preserving progress on groups that stay.
    const fresh = await replaceShareSessionGroups(session, groups);
    const extra = await pickerFor(fresh);
    res.json(publicSession(fresh, extra));
  });

  // Record what the agent actually did. Nothing here claims Forly posted:
  // copied/opened are preparation, posted/skipped are agent-confirmed.
  const ACTIONS = { copied: "copied", opened: "opened", posted: "posted", skipped: "skipped" };
  router.post("/share-session/mark", async (req, res) => {
    const session = await loadSession(req);
    if (!session) return res.status(401).json({ error: "invalid_link" });
    const key = String((req.body && req.body.group) || "");
    const action = ACTIONS[String((req.body && req.body.action) || "")];
    const idx = (session.groups || []).findIndex((g) => g.key === key);
    if (!action || idx < 0) return res.status(400).json({ error: "invalid_input" });
    const now = new Date();
    // Firestore has no array indexing in field paths: `groups.0.state` would
    // REPLACE the array with a map {"0": …} and every later read of the
    // session would blow up. Rewrite the whole array instead.
    // ponytail: last-write-wins across two open tabs; a transaction if that
    // ever actually bites.
    const groups = [...session.groups];
    const g = { ...groups[idx], state: action };
    if (action === "copied") g.copied_at = now;
    if (action === "opened") g.opened_at = now;
    if (action === "posted") g.marked_posted_at = now;
    if (action === "skipped") {
      g.skipped_at = now;
      g.skip_reason = String((req.body && req.body.reason) || "").slice(0, 60) || null;
    }
    groups[idx] = g;
    await db.updateShareSession(session.id, { groups, updated_at: now });
    // Only an agent-confirmed publish enters the audit log.
    if (action === "posted") {
      await db.addPostAction({
        business_phone: session.business_phone, page_id: session.page_id,
        distribution_id: session.id, target: "facebook_group",
        action: "published", at: now, trigger: "share_queue",
        post_id: null, post_url: session.groups[idx].url,
        content: { copy: session.snapshot.copy, media_type: "none",
          media_count: 0, media_urls: [] },
        error: null, source: "agent_confirmed",
      });
    }
    res.json({ ok: true, state: action });
  });

  // Group targets are curated and managed directly in Forly.

  // ── GET /status — connection + per-listing state; never tokens ──
  router.get("/status", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    const [biz, conn] = await Promise.all([db.getBusiness(phone), db.getConnection(phone)]);
    const out = {
      entitled: config.resolve(biz, process.env).enabled,
      connection: {
        connected: !!(conn && conn.page_token),
        page_name: (conn && conn.page_name) || null,
        needs_reconnect: !!(conn && conn.needs_reconnect),
        instagram_linked: !!(conn && conn.ig_business_id),
      },
      groups: (biz && biz.distribution && biz.distribution.groups) || [],
    };
    // full=1: distribution state for ALL the agent's pages in one call —
    // the main dashboard uses this to put a live control on every card.
    if (req.query.full === "1") {
      const listings = {};
      const mine = (await db.listListingsByPhone(phone)).filter((l) => l.page_id);
      await Promise.all(mine.map(async (l) => {
        const dists = await db.listDistributionsByPage(l.page_id);
        const posted = dists.find((d) => jobs.hasLivePost([d]));
        listings[l.page_id] = {
          posted: !!posted,
          post_url: posted ? posted.targets.facebook_page.post_url : null,
          in_flight: dists.some((d) => d.status === "queued" || d.status === "running"),
        };
      }));
      out.listings = listings;
    }
    const pageId = typeof req.query.page_id === "string" ? req.query.page_id : "";
    if (pageId) {
      const page = await db.getPage(pageId);
      if (!page || page.business_phone !== phone) {
        return res.status(404).json({ error: "not_found" });
      }
      const dists = await db.listDistributionsByPage(pageId);
      const posted = dists.find((d) => jobs.hasLivePost([d]));
      out.listing = {
        page_id: pageId,
        posted: !!posted,
        post_url: posted ? posted.targets.facebook_page.post_url : null,
        posted_at: posted ? (posted.updated_at || posted.confirmed_at || null) : null,
        // Only queued/running block the publish button: an awaiting_confirm
        // offer is deliberately supersedable by POST /publish, so it must not
        // freeze the dashboard.
        in_flight: dists.some((d) => d.status === "queued" || d.status === "running"),
        last_status: dists.length
          ? dists.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0].status
          : null,
      };
    }
    res.json(out);
  });

  return router;
};
