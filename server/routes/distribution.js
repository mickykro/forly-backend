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

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const jobs = require("../distribution/jobs");
const meta = require("../distribution/meta");
const shareKit = require("../distribution/share-kit");
const config = require("../distribution/config");
const pacing = require("../distribution/pacing");
const scheduler = require("../distribution/scheduler");
const { decorateJoinedGroup } = require("../distribution/group-relevance");
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

  // ── GET /oauth/start — logged-in agent → Facebook consent ──
  router.get("/oauth/start", requireAuth(authSecret), (req, res) => {
    if (!envOk()) return res.status(503).json({ error: "distribution_not_configured" });
    const state = meta.makeState({ phone: req.user.userId }, authSecret);
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
          `הדף "${pages[0].name}" חובר. מחזירים אתכם לעמוד ההפצה…`,
          `<a href="/distribution.html?connected=1"><button>לעמוד ההפצה</button></a>`,
          "/distribution.html?connected=1"));
      }
      // Multi-page: stash the candidates, re-sign a fresh state, render picker.
      await db.setConnection(state.phone, {
        pending_pages: pages.map((p) => ({ id: p.id, name: p.name, access_token: p.access_token })),
        user_token: long.access_token,
      });
      const pickState = meta.makeState({ phone: state.phone }, authSecret);
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
    res.type("html").send(card("✅ החיבור הושלם",
      `הדף "${pick.name}" חובר. מחזירים אתכם לעמוד ההפצה…`,
      `<a href="/distribution.html?connected=1"><button>לעמוד ההפצה</button></a>`,
      "/distribution.html?connected=1"));
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
          // "unknown" is honest: group rules can't be inferred from a name —
          // only a curator's verified entry may say allowed/owner_only.
          agent_policy: g.agent_policy || "unknown",
          match: !want || !types.length || types.includes(want),
        };
      });
  }

  router.get("/group-catalog", requireAuth(authSecret), async (req, res) => {
    const want = String(req.query.listing_type || "").trim();
    const catalog = await mergedCatalog(want);
    // Fold in the groups the agent is actually a member of: catalog entries
    // get flagged `joined`, and groups we've never heard of are appended so
    // the agent can pick the ones they already belong to.
    const s = (await db.getGroupPosting(req.user.userId)) || {};
    const joined = Array.isArray(s.joined_groups) ? s.joined_groups : [];
    const known = new Set(catalog.map((g) => g.url));
    const joinedByUrl = new Map(joined.map((g) => [g.url, g]));
    for (const g of catalog) {
      const own = joinedByUrl.get(g.url);
      g.joined = joined.length ? !!own : null;
      if (own) Object.assign(g, {
        enabled: !!own.enabled,
        relevance: own.relevance || "review",
        relevance_score: Number(own.relevance_score) || 0,
        relevance_signals: Array.isArray(own.relevance_signals) ? own.relevance_signals : [],
        relevance_source: own.relevance_source || "legacy",
      });
    }
    for (const g of joined) {
      if (known.has(g.url)) continue;
      catalog.push({ name: g.name, url: g.url, city: null, members: null,
        listing_types: [], languages: [], agent_policy: "unknown",
        match: true, joined: true, own: true,
        enabled: !!g.enabled, relevance: g.relevance || "review",
        relevance_score: Number(g.relevance_score) || 0,
        relevance_signals: Array.isArray(g.relevance_signals) ? g.relevance_signals : [],
        relevance_source: g.relevance_source || "legacy" });
    }
    res.json({
      groups: catalog, listing_type: want || null,
      joined_synced_at: s.joined_synced_at || null,
      joined_count: joined.length,
      enabled_count: joined.filter((g) => g.enabled).length,
      relevant_count: joined.filter((g) => g.relevance === "relevant").length,
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
    // Non-secret target for a user-triggered external start message. The
    // extension keeps its pairing token in local Chrome storage.
    extension_id: process.env.EXTENSION_ID || null,
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

  // The selected queue is server-authoritative. It lets the paired extension
  // discover the current property even when the share page is hosted on a
  // temporary origin that Chrome is not allowed to message from directly.
  async function selectShareSession(phone, sessionId) {
    const prev = (await db.getGroupPosting(phone)) || {};
    await db.saveGroupPosting(phone, {
      ...prev,
      selected_session_id: sessionId || null,
      selected_session_at: sessionId ? new Date() : null,
    });
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
    await selectShareSession(req.user.userId, session.id);
    const extra = (session.groups || []).length ? {} : await pickerFor(session);
    res.json(publicSession(session, extra));
  });

  router.get("/share-session", async (req, res) => {
    const session = await loadSession(req);
    if (!session) return res.status(401).json({ error: "invalid_link" });
    // With no groups yet, the queue has nothing to do — so it ships the
    // picker (and any same-city reuse offer) in the same payload instead of
    // sending the agent back to the dashboard.
    const extra = (session.groups || []).length ? {} : await pickerFor(session);
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
    const byUrl = new Map((session.groups || []).map((g) => [g.url, g]));
    const next = groups.map((url) => byUrl.get(url) || {
      key: jobs.groupKey(url), url,
      token: crypto.randomBytes(6).toString("base64url"),
      state: "ready", copied_at: null, opened_at: null,
      marked_posted_at: null, skipped_at: null, skip_reason: null,
    });
    await db.updateShareSession(session.id, { groups: next, updated_at: new Date() });
    await selectShareSession(session.business_phone, session.id);
    const fresh = { ...session, groups: next };
    const extra = next.length ? {} : await pickerFor(fresh);
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

  /* ── the browser-extension bridge (assisted group posting) ──────────────
   * Facebook has no Groups API, so the only thing that can put a post into a
   * group is the agent's own logged-in browser. The extension is a typing
   * assistant for exactly that: it fills the group composer and — in the
   * default "assist" mode — stops so the agent presses Post themselves.
   *
   * Every safety rule is enforced HERE, not in the extension, so a tampered
   * or stale client cannot pace its way around them (see distribution/pacing.js).
   */
  const extSign = (body) =>
    crypto.createHmac("sha256", authSecret).update(`ext:${body}`).digest("base64url");

  function makeExtToken(phone, nonce) {
    const body = Buffer.from(JSON.stringify({ phone, nonce })).toString("base64url");
    return `${body}.${extSign(body)}`;
  }

  function readExtToken(token) {
    if (typeof token !== "string" || !token.includes(".")) return null;
    const [body, sig] = token.split(".");
    const a = Buffer.from(sig || ""), b = Buffer.from(extSign(body));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
    catch { return null; }
  }

  // The nonce lives in the agent's own state doc, so re-pairing instantly
  // invalidates any token on a device the agent no longer controls.
  async function extAuth(req) {
    const raw = String(req.get("x-forly-ext") ||
      (req.body && req.body.token) || req.query.token || "");
    const claim = readExtToken(raw);
    if (!claim || !claim.phone) return null;
    const state = await db.getGroupPosting(claim.phone);
    if (!state || !state.ext_nonce || state.ext_nonce !== claim.nonce) return null;
    return { phone: claim.phone, state };
  }

  router.post("/extension/pair", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    const biz = await db.getBusiness(phone);
    if (!config.resolve(biz, process.env).enabled) {
      return res.status(403).json({ error: "not_entitled" });
    }
    const prev = (await db.getGroupPosting(phone)) || {};
    const nonce = crypto.randomBytes(12).toString("base64url");
    await db.saveGroupPosting(phone, { ...prev, ext_nonce: nonce,
      ext_paired_at: new Date(), mode: prev.mode || "assist" });
    res.json({
      token: makeExtToken(phone, nonce),
      mode: prev.mode || "assist",
      // Set EXTENSION_ID once the unpacked/store id is known, and the
      // dashboard hands the token over with no copy/paste.
      extension_id: process.env.EXTENSION_ID || null,
    });
  });

  // A compact identity card for the persistent extension panel. The extension
  // can prove this is the Forly account that paired it, but deliberately does
  // not scrape or disclose the personal Facebook profile running in Chrome.
  router.get("/extension/context", async (req, res) => {
    const auth = await extAuth(req);
    if (!auth) return res.status(401).json({ error: "unpaired" });
    const [business, connection] = await Promise.all([
      db.getBusiness(auth.phone), db.getConnection(auth.phone),
    ]);
    const joined = Array.isArray(auth.state.joined_groups) ? auth.state.joined_groups : [];
    const active = joined.filter((g) => g.enabled && g.relevance !== "irrelevant");
    const label = (business && (business.business_name || business.full_name || business.name)) || "חשבון Forly";
    const suffix = String(auth.phone || "").slice(-4);
    return res.json({
      agent: { label, account_suffix: suffix ? `••••${suffix}` : null },
      facebook_page: {
        connected: !!(connection && connection.page_token),
        name: (connection && connection.page_name) || null,
        needs_reconnect: !!(connection && connection.needs_reconnect),
      },
      personal_facebook_profile: "not_inspected",
      groups: {
        synced_count: joined.length,
        active_count: active.length,
        synced_at: auth.state.joined_synced_at || null,
      },
      selected_session_id: auth.state.selected_session_id || null,
      mode: auth.state.mode || "assist",
    });
  });

  // Explicit user action in the extension can select the Forly public property
  // page currently open in Chrome. The server verifies ownership and resolves
  // the same property-specific Group list used everywhere else.
  router.post("/extension/select-page", async (req, res) => {
    const auth = await extAuth(req);
    if (!auth) return res.status(401).json({ error: "unpaired" });
    const pageId = String((req.body && req.body.page_id) || "").trim();
    if (!pageId || pageId.length > 160) return res.status(400).json({ error: "invalid_page" });
    const page = await db.getPage(pageId);
    if (!page || page.business_phone !== auth.phone) return res.status(404).json({ error: "not_found" });
    const business = await db.getBusiness(auth.phone);
    const existing = await db.findOpenShareSession(pageId);
    const groups = await jobs.resolveGroups(deps, page, business);
    const sameGroups = existing && Array.isArray(existing.groups) &&
      existing.groups.length === groups.length &&
      existing.groups.every((g) => groups.includes(g.url));
    const session = sameGroups ? existing
      : await jobs.createShareSession(deps, { page, business, groups });
    await selectShareSession(auth.phone, session.id);
    res.json({ ok: true, session_id: session.id, group_count: (session.groups || []).length });
  });

  // What should the extension do next? Either one group task, or an honest
  // "wait, and here's why" — never a queue the client can race through.
  router.get("/extension/next", async (req, res) => {
    const auth = await extAuth(req);
    if (!auth) return res.status(401).json({ error: "unpaired" });
    const sessionId = String(req.query.s || "");
    const session = sessionId ? await db.getShareSession(sessionId) : null;
    if (!session || session.business_phone !== auth.phone) {
      return res.status(404).json({ error: "no_session" });
    }
    const queueSummary = (session.groups || []).reduce((acc, group) => {
      acc.total += 1;
      if (group.state === "posted") acc.posted += 1;
      else if (group.state === "skipped") acc.skipped += 1;
      else acc.pending += 1;
      return acc;
    }, { total: 0, posted: 0, skipped: 0, pending: 0 });
    const pending = (session.groups || []).filter((g) => g.state !== "posted" && g.state !== "skipped");
    if (!pending.length) {
      return res.json({
        done: true,
        completion: queueSummary.posted ? "posted_complete" : (queueSummary.skipped ? "no_posts_skipped" : "no_targets"),
        summary: queueSummary,
      });
    }

    const page = await db.getPage(session.page_id).catch(() => null);
    // Membership is a hard precondition for the assisted path: we post only
    // where the agent is already a member, so without a sync there is
    // nothing we're willing to schedule.
    const joinedList = auth.state.joined_groups;
    if (!Array.isArray(joinedList) || !joinedList.length) {
      return res.json({ wait: { reason: "needs_group_sync" } });
    }
    const joinedSet = new Set(joinedList.map((g) => g.url));
    const sizeOf = new Map(GROUP_SEED.map((g) => [g.url, g.members]));

    const unavailable = [];
    for (const g of pending) {
      const throttle = await db.getGroupThrottle(g.key).catch(() => null);
      const verdict = pacing.canPost(auth.state, {
        groupUrl: g.url, pageId: session.page_id,
        groupLastPostAt: throttle && throttle.last_post_at,
        groupMembers: sizeOf.get(g.url),
        joined: joinedSet ? joinedSet.has(g.url) : undefined,
      });
      if (!verdict.ok) {
        // Per-group reasons only block that group; agent-wide reasons block
        // everything, so stop asking.
        if (["group_cooldown", "already_posted_here", "group_busy", "not_a_member"]
          .includes(verdict.reason)) {
          unavailable.push({ key: g.key, reason: verdict.reason });
          continue;
        }
        return res.json({ wait: verdict, summary: queueSummary });
      }
      const tracked = shareKit.trackedUrl(session.snapshot.page_url,
        { session: session.id, group: g.token });
      // Sharing the Facebook post keeps the forly domain out of group spam
      // heuristics entirely and shows the video inline; when there's no post
      // to share, the link goes in the first comment instead of the body.
      const hasPost = !!session.snapshot.post_url;
      const text = page
        ? shareKit.buildPostCopy(page, hasPost ? session.snapshot.post_url : tracked, {
            variantSeed: `${session.page_id}|${g.key}`,
            linkInComment: !hasPost,
          })
        : session.snapshot.copy.replace(session.snapshot.page_url, tracked);
      return res.json({
        task: {
          session_id: session.id, group_key: g.key, group_url: g.url,
          share_url: session.snapshot.post_url || tracked,
          // What the agent pastes as the first comment when the body carries
          // no link — the standard, lower-risk pattern in these groups.
          comment_url: hasPost ? null : tracked,
          text,
        },
        mode: auth.state.mode || "assist",
        gap_ms: pacing.nextGapMs(),
        remaining_today: verdict.remaining_today,
      });
    }
    res.json({
      wait: {
        reason: "no_eligible_groups",
        unavailable: unavailable.slice(0, 20),
      },
      summary: queueSummary,
    });
  });

  // The persistent extension panel shows only the active agent's selected
  // property and its chosen queue. This makes progress visible without
  // exposing a pairing token, property copy, or any other agent's data.
  router.get("/extension/session", async (req, res) => {
    const auth = await extAuth(req);
    if (!auth) return res.status(401).json({ error: "unpaired" });
    const requestedSessionId = String(req.query.s || "");
    const sessionId = requestedSessionId || String(auth.state.selected_session_id || "");
    const session = sessionId ? await db.getShareSession(sessionId) : null;
    if (!session || session.business_phone !== auth.phone) {
      return res.status(404).json({ error: "no_session" });
    }
    const groups = (session.groups || []).map((g) => ({
      key: g.key,
      name: catalogNames.get(g.url) || null,
      url: g.url,
      state: g.state || "ready",
    }));
    const progress = groups.reduce((acc, group) => {
      acc.total += 1;
      if (group.state === "posted") acc.posted += 1;
      else if (group.state === "skipped") acc.skipped += 1;
      else acc.pending += 1;
      return acc;
    }, { total: 0, posted: 0, skipped: 0, pending: 0 });
    return res.json({
      session_id: session.id,
      property: {
        title: session.snapshot.title || "נכס נבחר",
        city: session.snapshot.city || null,
        listing_type: session.snapshot.listing_type || "sale",
        page_url: session.snapshot.page_url || null,
      },
      progress,
      groups,
    });
  });

  router.post("/extension/session/clear", async (req, res) => {
    const auth = await extAuth(req);
    if (!auth) return res.status(401).json({ error: "unpaired" });
    await selectShareSession(auth.phone, null);
    res.json({ ok: true });
  });

  // The extension reports what actually happened. "posted" is the agent's
  // own confirmation (assist mode) or a verified submit (auto mode); any
  // block/checkpoint freezes this agent for 24h.
  router.post("/extension/result", async (req, res) => {
    const auth = await extAuth(req);
    if (!auth) return res.status(401).json({ error: "unpaired" });
    const body = req.body || {};
    const session = await db.getShareSession(String(body.session_id || ""));
    if (!session || session.business_phone !== auth.phone) {
      return res.status(404).json({ error: "no_session" });
    }
    const idx = (session.groups || []).findIndex((g) => g.key === String(body.group_key || ""));
    if (idx < 0) return res.status(400).json({ error: "unknown_group" });
    const group = session.groups[idx];
    const status = String(body.status || "");
    const now = new Date();

    if (status === "blocked") {
      await db.saveGroupPosting(auth.phone,
        pacing.lock(auth.state, body.detail || "reported_block"));
      return res.json({ ok: true, locked: true });
    }
    if (status !== "posted") {
      await db.updateShareSession(session.id, {
        [`groups.${idx}.state`]: "ready", updated_at: now });
      return res.json({ ok: true });
    }

    await db.saveGroupPosting(auth.phone,
      pacing.recordPost(auth.state, { groupUrl: group.url, pageId: session.page_id }));
    // Stamp the shared throttle so no OTHER agent posts into this group for
    // the next few hours.
    await db.touchGroupThrottle(group.key, group.url).catch(() => {});
    await db.updateShareSession(session.id, {
      [`groups.${idx}.state`]: "posted",
      [`groups.${idx}.marked_posted_at`]: now, updated_at: now });
    await db.addPostAction({
      business_phone: auth.phone, page_id: session.page_id,
      distribution_id: session.id, target: "facebook_group",
      action: "published", at: now, trigger: "extension",
      post_id: null, post_url: group.url,
      content: { copy: session.snapshot.copy, media_type: "none",
        media_count: 0, media_urls: [] },
      error: null,
      // Honest provenance: in assist mode a human pressed Post.
      source: (auth.state.mode || "assist") === "assist" ? "agent_confirmed" : "extension_auto",
    });
    res.json({ ok: true, gap_ms: pacing.nextGapMs() });
  });

  // The groups this agent is actually a member of, synced from their own
  // Facebook account by the extension. This is what makes "post only where
  // you're a member" a fact rather than a guess. We retain explicit agent
  // choices across re-syncs and classify only the Group NAME, never posts or
  // members. The practical cap protects Firestore documents and the browser.
  router.post("/extension/groups", async (req, res) => {
    const auth = await extAuth(req);
    if (!auth) return res.status(401).json({ error: "unpaired" });
    const raw = Array.isArray(req.body && req.body.groups) ? req.body.groups : [];
    const seen = new Map();
    for (const g of raw.slice(0, 1000)) {
      const url = shareKit.sanitizeGroups([(g && g.url) || ""])[0];
      if (url && !seen.has(url)) {
        seen.set(url, String((g && g.name) || "").slice(0, 140) || url);
      }
    }
    const catalogByUrl = new Map((await mergedCatalog()).map((g) => [g.url, g]));
    const previousByUrl = new Map(
      (Array.isArray(auth.state.joined_groups) ? auth.state.joined_groups : [])
        .map((g) => [g.url, g]),
    );
    const joined = [...seen.entries()].map(([url, name]) => decorateJoinedGroup({
      url, name, previous: previousByUrl.get(url) || null,
      catalogEntry: catalogByUrl.get(url) || null,
    }));
    const sync = req.body && req.body.sync && typeof req.body.sync === "object" ? req.body.sync : {};
    await db.saveGroupPosting(auth.phone, {
      ...auth.state,
      joined_groups: joined,
      joined_synced_at: new Date(),
      joined_sync: {
        received: raw.length, accepted: joined.length,
        complete: sync.complete === true,
        capped: sync.capped === true,
        scrolls: Number(sync.scrolls) || null,
        scanned_at: new Date(),
      },
    });
    res.json({
      ok: true, count: joined.length,
      relevant_count: joined.filter((g) => g.relevance === "relevant").length,
      enabled_count: joined.filter((g) => g.enabled).length,
      capped: raw.length > 1000 || sync.capped === true,
    });
  });

  // Full synced Group list for the My Groups settings UI. Search and visual
  // filtering happen in the client so a user can change filters instantly.
  router.get("/joined-groups", requireAuth(authSecret), async (req, res) => {
    const s = (await db.getGroupPosting(req.user.userId)) || {};
    const groups = Array.isArray(s.joined_groups) ? s.joined_groups : [];
    res.json({
      groups,
      synced_at: s.joined_synced_at || null,
      sync: s.joined_sync || null,
      summary: {
        total: groups.length,
        relevant: groups.filter((g) => g.relevance === "relevant").length,
        review: groups.filter((g) => g.relevance === "review").length,
        irrelevant: groups.filter((g) => g.relevance === "irrelevant").length,
        enabled: groups.filter((g) => g.enabled).length,
      },
    });
  });

  // One Group at a time: the agent may enable/disable it and override the
  // recommendation. `relevance: auto` clears an earlier override.
  router.post("/joined-groups/preference", requireAuth(authSecret), async (req, res) => {
    const url = shareKit.sanitizeGroups([(req.body && req.body.url) || ""])[0];
    if (!url) return res.status(400).json({ error: "invalid_group_url" });
    const s = (await db.getGroupPosting(req.user.userId)) || {};
    const groups = Array.isArray(s.joined_groups) ? s.joined_groups : [];
    const index = groups.findIndex((g) => g.url === url);
    if (index < 0) return res.status(404).json({ error: "group_not_synced" });
    const current = groups[index];
    if (typeof req.body.enabled === "boolean") current.enabled = req.body.enabled;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "relevance")) {
      const choice = String(req.body.relevance || "auto");
      if (!["auto", "relevant", "review", "irrelevant"].includes(choice)) {
        return res.status(400).json({ error: "invalid_relevance" });
      }
      current.relevance_override = choice === "auto" ? null : choice;
      current.relevance = current.relevance_override || current.automatic_relevance || "review";
      current.relevance_source = current.relevance_override ? "agent" : "heuristic";
      if (current.relevance === "irrelevant" && typeof req.body.enabled !== "boolean") {
        current.enabled = false;
      }
    }
    groups[index] = current;
    await db.saveGroupPosting(req.user.userId, { ...s, joined_groups: groups });
    res.json({ ok: true, group: current });
  });

  // Copies the agent-approved subset into the default distribution setting.
  // This is deliberate: a re-sync never silently starts posting to new Groups.
  router.post("/joined-groups/apply", requireAuth(authSecret), async (req, res) => {
    const s = (await db.getGroupPosting(req.user.userId)) || {};
    const joined = Array.isArray(s.joined_groups) ? s.joined_groups : [];
    const groups = joined
      .filter((g) => g.enabled && g.relevance !== "irrelevant")
      .map((g) => g.url);
    const business = await db.getBusiness(req.user.userId);
    await db.setBusiness(req.user.userId, {
      distribution: { ...((business && business.distribution) || {}), groups },
      updated_at: new Date(),
    });
    businessCache.invalidate(req.user.userId);
    res.json({ ok: true, groups, count: groups.length });
  });

  // Agent-facing switch + live safety state for the dashboard.
  router.post("/extension/mode", requireAuth(authSecret), async (req, res) => {
    const mode = String((req.body && req.body.mode) || "") === "auto" ? "auto" : "assist";
    const prev = (await db.getGroupPosting(req.user.userId)) || {};
    await db.saveGroupPosting(req.user.userId, { ...prev, mode });
    res.json({ ok: true, mode });
  });

  router.get("/extension/status", requireAuth(authSecret), async (req, res) => {
    const phone = req.user.userId;
    const s = (await db.getGroupPosting(phone)) || {};
    const posts = Array.isArray(s.posts) ? s.posts : [];
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const joined = Array.isArray(s.joined_groups) ? s.joined_groups : [];
    const activeJoined = joined.filter((g) => g.enabled && g.relevance !== "irrelevant");
    const dailyCap = pacing.dailyCap(s.first_post_at, Date.now());

    // An honest ETA beats a promise: with this many listings and this many
    // joined groups, a full distribution takes this long.
    const listings = (await db.listListingsByPhone(phone).catch(() => []))
      .filter((l) => l.page_id && l.status !== "archived");
    const plan = activeJoined.length && listings.length
      ? scheduler.forecast({
          propertyCount: listings.length, groupCount: activeJoined.length,
          dailyCap, groupCooldownMs: pacing.GROUP_COOLDOWN_MS })
      : null;

    res.json({
      paired: !!s.ext_nonce,
      mode: s.mode || "assist",
      locked_until: s.locked_until || null,
      lock_reason: s.lock_reason || null,
      posted_today: posts.filter((p) => new Date(p.at).getTime() > dayAgo).length,
      daily_cap: dailyCap,
      joined_count: joined.length,
      joined_relevant_count: joined.filter((g) => g.relevance === "relevant").length,
      joined_active_count: activeJoined.length,
      joined_synced_at: s.joined_synced_at || null,
      joined_sync: s.joined_sync || null,
      plan,
    });
  });

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
