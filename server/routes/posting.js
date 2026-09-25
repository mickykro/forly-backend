/*
 * routes/posting.js — /api/posting: an agent's recorded permission to post,
 * and the campaigns run under it (the campaign card, Task 23).
 *
 * Gates on create, all server-side: consent (and a structured
 * posting_permission, created from this consent when the account has none);
 * the kill switch (R2); a connected browser profile; the page is theirs; a
 * confirmed Page when several were discovered (R3); every group_id is a
 * group this account is a member of now (the hard gate, aliases included);
 * a member group outside the curated catalog needs include_unknown: true.
 *
 * STOP, pause and skip always work — a switch must never keep an agent from
 * stopping. Everything else that can lead to a post re-checks the guard.
 * Settings, resync and group removal: routes/posting-settings.js.
 */
const express = require("express");
const A = require("../posting-account");
const S_ = require("./posting-shared");

const { CONSENT_VERSION, publicView, wrap, allowed, card } = S_;
const MAX_ACTIVE_CAMPAIGNS = 3;
const MODES = new Set(["per_post", "standing"]);
const LIVE = new Set(["running", "paused"]);
const ENDED = new Set(["stopped", "completed"]);
const PERMISSION_CURED = ["no_permission", "permission_scope"]; // this request's consent grants it

// Everything a route needs, resolved once. Tests pass fakes through ctx.deps
// (db, store, guard, groupsSync, clock …) exactly as posting-campaign takes them.
function contextOf(ctx) {
  const deps = Object.assign({}, ctx.deps || {});
  deps.db = deps.db || ctx.db || require("../db");
  deps.store = deps.store || require("../posting-store");
  if (deps.pageBaseUrl === undefined) deps.pageBaseUrl = ctx.pageBaseUrl;
  const db = deps.db;
  return {
    deps, db, store: deps.store,
    guard: deps.guard || require("../posting-guard"),
    campaigns: ctx.campaigns || require("../posting-campaign"),
    groupsSync: deps.groupsSync || require("../facebook-groups-sync"),
    catalog: ctx.catalog || ((want) => require("./distribution").mergedCatalog(db, want)),
    clock: typeof deps.clock === "function" ? deps.clock : () => new Date(),
    authSecret: ctx.authSecret, pageBaseUrl: ctx.pageBaseUrl,
  };
}

// A permission created by a campaign's own consent covers campaign posting
// only: no default groups and groups-only targets, so it never auto-enrolls
// new listings (posting-campaign.enrollNewPage) — that is PUT /settings' job.
function campaignPermission(prev, now) {
  return {
    enabled: true, consent_version: CONSENT_VERSION, granted_at: A.iso(now), platforms: ["facebook"],
    targets: ["groups"], default_group_ids: [], page_id: (prev && prev.page_id) || null,
    auto_mode: "standing", allows_dwell: true, allows_visible_interactions: false, revoked_at: null,
  };
}
const permActive = (p) => !!p && p.enabled === true && Array.isArray(p.platforms) && p.platforms.includes("facebook");

function validCreate(b) {
  if (typeof b.page_id !== "string" || !S_.ID_RE.test(b.page_id) || !MODES.has(b.mode)) return null;
  const g = S_.parseGroupIds(b.group_ids, { required: true });
  const t = S_.parseTargets(b.targets);
  if (g.error || t.error) return null;
  if (b.days !== undefined && !(Number.isFinite(b.days) && b.days >= 1 && b.days <= 30)) return null;
  for (const k of ["repeat", "include_unknown", "account_aged", "posted_manually"]) if (b[k] !== undefined && typeof b[k] !== "boolean") return null;
  return { ids: g.ids, targets: t.targets };
}

module.exports = function createPostingRouter(ctx) {
  const S = contextOf(ctx);
  const { db, store, campaigns, deps, authSecret } = S;
  const auth = ctx.requireAuth(authSecret);
  const router = express.Router();

  async function owned(req, res) {
    const id = String(req.params.id || "");
    const c = S_.ID_RE.test(id) ? await store.getPostingCampaign(id) : null;
    if (!c || c.phone !== req.user.userId) { res.status(404).json({ error: "not_found" }); return null; }
    return c;
  }

  router.post("/campaigns", auth, wrap("create", async (req, res) => {
    const phone = req.user.userId;
    const b = req.body && typeof req.body === "object" ? req.body : {};
    if (b.consent !== true) return res.status(400).json({ error: "consent_required" });
    const v = validCreate(b);
    if (!v) return res.status(400).json({ error: "invalid_input" });
    if (b.consent_version !== undefined && b.consent_version !== CONSENT_VERSION) return res.status(409).json({ error: "consent_outdated", consent_version: CONSENT_VERSION });
    if (!(await allowed(S, phone, res, PERMISSION_CURED))) return;

    const conn = (await db.getConnection(phone)) || {};
    if (!conn.facebook_browser_connected_at) return res.status(409).json({ error: "facebook_not_connected" });
    const page = await db.getPage(b.page_id);
    if (!page || page.business_phone !== phone) return res.status(404).json({ error: "not_found" });
    const others = (await store.listPostingCampaignsByPhone(phone)).filter((c) => LIVE.has(c.status) && c.page_id !== page.page_id);
    if (others.length >= MAX_ACTIVE_CAMPAIGNS) return res.status(409).json({ error: "too_many_campaigns" });
    const wanted = v.targets || S_.TARGETS;
    if (wanted.includes("page") && !S_.pageConfirmed(conn)) return res.status(409).json({ error: "page_not_confirmed" });

    // The hard gate: only groups this account belongs to. The catalog adds
    // names and policy; membership comes from the account (Task 14).
    const gate = S_.memberGate(conn, v.ids);
    if (gate.notMember) return res.status(422).json({ error: "not_member", group_ids: gate.notMember });
    const listingType = (page.property || {}).listing_type || null;
    const lookup = S_.catalogLookup(await S.catalog(listingType || "sale"));
    const unknown = gate.entries.filter((m) => !lookup(m)).map((m) => m.group_id);
    if (unknown.length && b.include_unknown !== true) return res.status(422).json({ error: "unknown_group", group_ids: unknown });
    // posting-campaign.create() derives the four eligibility booleans itself
    // (is_member, catalog_policy, listing_type_allowed,
    // posting_currently_available) from these fields, the connection and the raw catalog.
    const groups = gate.entries.map((m) => {
      const cat = lookup(m);
      return { group_id: m.group_id, url: S_.memberUrl(m), name: m.name || (cat && cat.name) || "", agent_policy: (cat && cat.agent_policy) || "unknown" };
    });
    if (!groups.length && !(wanted.includes("page") && A.pageTarget(conn))) return res.status(400).json({ error: "invalid_input" });

    // The consent is recorded before the campaign exists: the account's two
    // answers the pacer's warm-up reads, and the permission the guard's
    // "reserve" requires (created only when the account has none in force).
    const now = S.clock();
    await store.mutateConnection(phone, (cur) => {
      const patch = {};
      if (typeof b.account_aged === "boolean") patch.posting_account_aged = b.account_aged;
      if (typeof b.posted_manually === "boolean") patch.posting_posted_manually = b.posted_manually;
      if (!permActive(cur.posting_permission)) patch.posting_permission = campaignPermission(cur.posting_permission, now);
      return Object.keys(patch).length ? patch : null;
    });
    if (!(await allowed(S, phone, res))) return;

    const before = await store.getPostingCampaign(store.campaignId(phone, page.page_id));
    const c = await campaigns.create({
      phone, page, groups, mode: b.mode, days: b.days, repeat: b.repeat === true, targets: v.targets || undefined,
      consent: { at: A.iso(now), version: CONSENT_VERSION },
    }, deps);
    const existing = !!before && !ENDED.has(before.status);
    return res.status(existing ? 200 : 201).json({ campaign: publicView(c), existing });
  }));

  router.get("/campaigns", auth, wrap("list", async (req, res) => {
    const pageId = typeof req.query.page_id === "string" ? req.query.page_id : null;
    const all = await store.listPostingCampaignsByPhone(req.user.userId);
    return res.json({ campaigns: all.filter((c) => !pageId || c.page_id === pageId).map(publicView) });
  }));

  router.get("/campaigns/:id", auth, wrap("get", async (req, res) => {
    const c = await owned(req, res);
    if (c) return res.json({ campaign: publicView(c) });
  }));

  // Always allowed, whatever the switches say.
  router.post("/campaigns/:id/pause", auth, wrap("pause", async (req, res) => {
    const c = await owned(req, res);
    if (!c) return;
    return res.json({ campaign: publicView(await campaigns.pause(c.id, "agent", deps)) });
  }));
  router.post("/campaigns/:id/stop", auth, wrap("stop", async (req, res) => {
    const c = await owned(req, res);
    if (!c) return;
    return res.json({ campaign: publicView(await campaigns.stop(c.id, deps)) });
  }));

  router.post("/campaigns/:id/resume", auth, wrap("resume", async (req, res) => {
    const c = await owned(req, res);
    if (!c) return;
    if (!(await allowed(S, c.phone, res))) return;
    if (c.status === "running") return res.json({ campaign: publicView(c) });
    if (c.status !== "paused") return res.status(409).json({ error: "not_paused", status: c.status });
    // posting-campaign.resume() leaves a campaign paused while the account
    // waits for a reconnect (a login_required halt) or an operator.
    if (S_.needsReconnect((await db.getConnection(c.phone)) || {})) return res.status(409).json({ error: "needs_reconnect" });
    const out = await campaigns.resume(c.id, deps);
    if (!out || out.status !== "running") {
      const conn = (await db.getConnection(c.phone)) || {};
      return res.status(409).json({ error: S_.needsReconnect(conn) ? "needs_reconnect" : "not_resumable" });
    }
    return res.json({ campaign: publicView(out) });
  }));

  router.post("/campaigns/:id/posts/:post_id/approve", auth, wrap("approve", async (req, res) => {
    const c = await owned(req, res);
    if (!c) return;
    const postId = String(req.params.post_id);
    if (!(c.posts || []).some((p) => p && p.id === postId)) return res.status(404).json({ error: "post_not_found" });
    if (!(await allowed(S, c.phone, res))) return;
    return res.json({ campaign: publicView(await campaigns.approvePost(c.id, postId, deps)) });
  }));

  // Always allowed, whatever the switches say.
  router.post("/campaigns/:id/posts/:post_id/skip", auth, wrap("skip", async (req, res) => {
    const c = await owned(req, res);
    if (!c) return;
    const postId = String(req.params.post_id);
    if (!(c.posts || []).some((p) => p && p.id === postId)) return res.status(404).json({ error: "post_not_found" });
    return res.json({ campaign: publicView(await campaigns.skipPost(c.id, postId, deps)) });
  }));

  // The WhatsApp one-tap, like routes/distribution.js /confirm: no login, the
  // signed token over [campaign, post, action, expiry] is the proof. The phone
  // is the campaign's own, never read from the link. A small Hebrew page back.
  router.get("/act", wrap("act", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const send = (status, title, body) => res.status(status).type("html").send(card(title, body));
    const link = S_.readActionLink(req.query || {}, authSecret, S.clock().getTime());
    if (link.error === "expired") return send(403, "פג תוקף הקישור", "אפשר לאשר, לדלג או לעצור מכרטיס הפרסום בדשבורד.");
    if (link.error) return send(403, "הקישור אינו תקף", "אפשר לאשר, לדלג או לעצור מכרטיס הפרסום בדשבורד.");
    const camp = await store.getPostingCampaign(link.c);
    if (!camp) return send(404, "לא נמצא", "הקמפיין הזה כבר לא קיים.");
    if (link.a === "stop") {
      await campaigns.stop(camp.id, deps);
      return send(200, "✋ הפרסום נעצר", "מה שכבר פורסם נשאר בקבוצות. אפשר להתחיל שוב מתי שתרצו, מעמוד הנכס.");
    }
    const post = (camp.posts || []).find((p) => p && p.id === link.p);
    if (!post) return send(404, "לא נמצא", "הפוסט הזה כבר לא קיים בקמפיין.");
    if (link.a === "skip") {
      if (!["pending_approval", "scheduled"].includes(post.status)) return send(200, "הפוסט כבר לא ממתין", "אין מה לדלג עליו.");
      await campaigns.skipPost(camp.id, post.id, deps);
      return send(200, "⏭ דילגנו על הפוסט הזה", "נמשיך ליעד הבא בתור.");
    }
    if (post.status !== "pending_approval") return send(200, "הפוסט כבר לא ממתין לאישור", "אפשר לראות את מצב הפרסום בדשבורד.");
    try {
      await S.guard.assertAllowed({ phone: camp.phone, platform: "facebook", action: "reserve" }, { db, env: deps.env || process.env });
    } catch (e) {
      if (!e || e.code !== "posting_disabled") throw e;
      return send(409, "הפרסום כבוי כרגע", "לא אישרנו את הפוסט. אפשר לנסות שוב מכרטיס הפרסום בדשבורד.");
    }
    const out = await campaigns.approvePost(camp.id, post.id, deps);
    const p = ((out && out.posts) || []).find((x) => x && x.id === post.id) || {};
    const when = p.scheduled_at ? new Date(p.scheduled_at).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    const where = p.target === "page" ? "לדף העסקי" : `לקבוצה "${p.group_name || S_.PRIVATE_NAME}"`;
    return send(200, "✅ אושר!", `הפוסט יעלה ${where}${when ? ` ב-${when}` : ""}. נעדכן בוואטסאפ כשזה קורה.`);
  }));

  require("./posting-settings")(router, S, auth);
  return router;
};

module.exports.publicView = publicView;
module.exports.actionLink = S_.actionLink;
module.exports.CONSENT_VERSION = CONSENT_VERSION;
module.exports.MAX_ACTIVE_CAMPAIGNS = MAX_ACTIVE_CAMPAIGNS;
