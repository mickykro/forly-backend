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
const { escapeHtml: esc, publicUrl } = require("../utils");
const { postingEnvAllowed } = require("../posting-guard");
const PC = require("./posting-create");
const { validCreate, campaignPermission, permActive } = PC;

const { CONSENT_VERSION, publicView, wrap, allowed, card } = S_;
const { MAX_ACTIVE_CAMPAIGNS } = S_;
const LIVE = new Set(["running", "paused"]);
const ENDED = new Set(["stopped", "completed"]);
const PERMISSION_CURED = ["no_permission", "permission_scope"]; // this request's consent grants it
const PLAN_WAIT_MS = 8000;
const WHY_GROUPS = new Set(["no_eligible_group", "duplicate"]);
const BUSY = new Set(["profile_busy", "login_open"]); // a tick that could not look: the card says why

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

module.exports = function createPostingRouter(ctx) {
  const S = contextOf(ctx);
  const { db, store, campaigns, deps, authSecret } = S;
  const auth = ctx.requireAuth(authSecret);
  const router = express.Router();
  // C1: staging shares production's Firestore — nothing here changes a
  // campaign, a permission or a membership outside prod (or a local box with
  // POSTING_SWEEPER=1). Read-only GETs stay.
  router.use((req, res, next) => (req.method === "GET" || req.method === "HEAD" || postingEnvAllowed(ctx.env || deps.env || process.env) ? next()
    : res.status(503).json({ error: "posting_unavailable_in_env" })));

  // A running campaign always shows its next post or why it waits: plan now
  // rather than at the next sweep (up to a minute, or never while the sweep
  // is blocked). Plan only — a due post and warm-up browsing stay the
  // sweeper's — and capped, so the reply never hangs. → the campaign as it is now.
  // opts.throttle (the card's polling GET): at most once a minute per campaign.
  const planned = new Map();
  async function planNow(c, opts = {}) {
    if (require("../posting-manual").enabled(ctx.env || deps.env || process.env)) return c; // manual posting: nothing is planned
    if (!c || c.status !== "running" || (c.posts || []).some((p) => A.OPEN_POST.has(p.status))) return c;
    if (c.wait_reason && !BUSY.has(c.wait_reason)) return c; // the planner already said why
    if (!postingEnvAllowed(ctx.env || deps.env || process.env)) return c;
    const t = S.clock().getTime();
    if (opts.throttle && t - (planned.get(c.id) || 0) < 60000) return c;
    planned.set(c.id, t);
    if (planned.size > 1000) planned.delete(planned.keys().next().value);
    const plan = ctx.planNow || ((phone) => require("../posting-tick").tickAccount(phone, deps, undefined, { planOnly: true }));
    let timer;
    const out = await Promise.race([
      Promise.resolve().then(() => plan(c.phone)).catch(() => "error"),
      new Promise((ok) => { timer = setTimeout(ok, PLAN_WAIT_MS, "slow"); }),
    ]).finally(() => clearTimeout(timer));
    if (BUSY.has(out)) {
      await A.mutate(A.ctxOf(deps), c.id, (cur) => (cur.status === "running" && (!cur.wait_reason || BUSY.has(cur.wait_reason)) && !(cur.posts || []).some((p) => A.OPEN_POST.has(p.status)) ? { wait_reason: out } : null)).catch(() => null);
    }
    return (await store.getPostingCampaign(c.id)) || c;
  }

  // Manual posting: an admin publishes by hand, so the automatic posting switch does not apply.
  const manualOn = () => require("../posting-manual").enabled(deps.env || process.env);

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
    // The consent is to the text the card showed: it must be this version.
    if (b.consent_version !== CONSENT_VERSION) return res.status(409).json({ error: "consent_outdated", consent_version: CONSENT_VERSION });
    const manual = manualOn();
    // Manual posting publishes groups once, by hand: no Page post, no second pass (as routes/admin-campaigns.js).
    if (manual && ((v.targets && v.targets.includes("page")) || b.repeat === true || Number(b.repeat_days) > 0)) return res.status(400).json({ error: "manual_unsupported" });
    if (!manual && !(await allowed(S, phone, res, PERMISSION_CURED))) return;

    const conn = (await db.getConnection(phone)) || {};
    if (!conn.facebook_browser_connected_at) return res.status(409).json({ error: "facebook_not_connected" });
    const page = await db.getPage(b.page_id);
    if (!page || page.business_phone !== phone) return res.status(404).json({ error: "not_found" });
    // No cap on live campaigns per agent for now (MAX_ACTIVE_CAMPAIGNS is not enforced).
    const wanted = v.targets || S_.DEFAULT_TARGETS;
    if (wanted.includes("page") && !S_.pageConfirmed(conn)) return res.status(409).json({ error: "page_not_confirmed" });
    // Until connect has read the Page's numeric id, R3 could never prove it: refused (I4).
    if (v.targets && v.targets.includes("page") && !A.pageTarget(conn)) return res.status(409).json({ error: "page_target_unavailable" });

    const vet = await PC.vetGroups(S.catalog, conn, page, v.ids, b.include_unknown === true);
    if (vet.error) return res.status(422).json(vet);
    const groups = vet.groups;
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
    if (!manual && !(await allowed(S, phone, res))) return;

    const before = await store.getPostingCampaign(store.campaignId(phone, page.page_id));
    const c = await campaigns.create({
      phone, page, groups, mode: b.mode, days: b.days, repeat: b.repeat === true, repeatDays: b.repeat_days || null, targets: v.targets || undefined,
      consent: { at: A.iso(now), version: CONSENT_VERSION }, copies: b.copies || null,
    }, deps);
    const existing = !!before && !ENDED.has(before.status);
    return res.status(existing ? 200 : 201).json({ campaign: publicView(await planNow(c)), existing });
  }));

  router.get("/campaigns", auth, wrap("list", async (req, res) => {
    const pageId = typeof req.query.page_id === "string" ? req.query.page_id : null;
    const all = await store.listPostingCampaignsByPhone(req.user.userId);
    return res.json({ campaigns: all.filter((c) => !pageId || c.page_id === pageId).map(publicView) });
  }));

  router.get("/campaigns/:id", auth, wrap("get", async (req, res) => {
    const c = await planNow(await owned(req, res), { throttle: true });
    if (!c) return;
    // Task 22: per-post metrics; a failed read leaves the card without them, never without the campaign.
    const metrics = await require("../posting-metrics").forCampaign(c, deps).catch(() => null);
    // "No group available": which group, why, and until when — never a bare line.
    const idle = c.status === "running" && !(c.posts || []).some((p) => A.OPEN_POST.has(p.status));
    const blocked = idle && WHY_GROUPS.has(c.wait_reason) && campaigns.explainGroups
      ? await campaigns.explainGroups(c, deps).catch(() => null) : null;
    return res.json({ campaign: publicView(c, { metrics, blocked_groups: blocked }) });
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
    if (!manualOn() && !(await allowed(S, c.phone, res))) return;
    if (c.status === "running") return res.json({ campaign: publicView(c) });
    if (c.status !== "paused") return res.status(409).json({ error: "not_paused", status: c.status });
    // R5: an internal pause (selector failures, tick errors) is lifted by the
    // team once it is fixed (the admin overview), never by the agent.
    if (c.pause_reason === "internal") return res.status(409).json({ error: "needs_developer" });
    // posting-campaign.resume() leaves a campaign paused while the account
    // waits for a reconnect (a login_required halt) or an operator.
    if (S_.needsReconnect((await db.getConnection(c.phone)) || {})) return res.status(409).json({ error: "needs_reconnect" });
    const out = await campaigns.resume(c.id, deps);
    if (!out || out.status !== "running") {
      const conn = (await db.getConnection(c.phone)) || {};
      return res.status(409).json({ error: S_.needsReconnect(conn) ? "needs_reconnect" : "not_resumable" });
    }
    return res.json({ campaign: publicView(await planNow(out)) });
  }));

  // More groups for a live campaign (the card's "no group available" way out):
  // the same gate as create; the consent given at create covers them.
  router.post("/campaigns/:id/groups", auth, wrap("add_groups", async (req, res) => {
    const c = await owned(req, res);
    if (!c) return;
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const g = S_.parseGroupIds(b.group_ids, { required: true });
    if (g.error || !g.ids.length || (b.include_unknown !== undefined && typeof b.include_unknown !== "boolean")) return res.status(400).json({ error: "invalid_input" });
    if (!LIVE.has(c.status)) return res.status(409).json({ error: "not_live", status: c.status });
    if (!manualOn() && !(await allowed(S, c.phone, res))) return;
    const page = await db.getPage(c.page_id);
    if (!page || page.business_phone !== c.phone) return res.status(404).json({ error: "not_found" });
    const vet = await PC.vetGroups(S.catalog, (await db.getConnection(c.phone)) || {}, page, g.ids, b.include_unknown === true);
    if (vet.error) return res.status(422).json(vet);
    const out = await campaigns.addGroups(c.id, vet.groups, deps);
    if (!out) return res.status(404).json({ error: "not_found" });
    return res.json({ campaign: publicView(await planNow(out)) });
  }));

  router.post("/campaigns/:id/posts/:post_id/approve", auth, wrap("approve", async (req, res) => {
    const c = await owned(req, res);
    if (!c) return;
    const postId = String(req.params.post_id);
    if (!(c.posts || []).some((p) => p && p.id === postId)) return res.status(404).json({ error: "post_not_found" });
    if (!(await allowed(S, c.phone, res))) return;
    // The agent's own text and time, both optional: the text as edited on the
    // card, and "not before" for when it goes out (now … 30 days ahead).
    const b = req.body || {}, opts = {};
    if (b.copy !== undefined && b.copy !== null) {
      opts.copy = campaigns.cleanCopy(b.copy);
      if (!opts.copy) return res.status(400).json({ error: "invalid_input", field: "copy" });
    }
    if (b.scheduled_at !== undefined && b.scheduled_at !== null && b.scheduled_at !== "") {
      const t = new Date(String(b.scheduled_at)).getTime(), now = S.clock().getTime();
      if (!Number.isFinite(t) || t > now + 30 * 86400000) return res.status(400).json({ error: "invalid_input", field: "scheduled_at" });
      opts.at = new Date(Math.max(t, now));
    }
    return res.json({ campaign: publicView(await campaigns.approvePost(c.id, postId, deps, opts)) });
  }));

  // Always allowed, whatever the switches say.
  router.post("/campaigns/:id/posts/:post_id/skip", auth, wrap("skip", async (req, res) => {
    const c = await owned(req, res);
    if (!c) return;
    const postId = String(req.params.post_id);
    if (!(c.posts || []).some((p) => p && p.id === postId)) return res.status(404).json({ error: "post_not_found" });
    return res.json({ campaign: publicView(await campaigns.skipPost(c.id, postId, deps)) });
  }));

  // The WhatsApp one-tap. No login: the signed token over [campaign, post,
  // action, expiry] is the proof, and the phone is the campaign's own, never
  // the link's. A GET only verifies and asks — link previews and scanners
  // fetch URLs — and the page's one button POSTs to the same URL, which
  // verifies again and acts. Small Hebrew pages, never cached or indexed.
  const ASK = {
    approve: ["לאשר את הפרסום?", "אישור"],
    skip: ["לדלג על הפוסט?", "דילוג"],
    stop: ["לעצור את הקמפיין?", "עצירה"],
  };
  const qs = (link) => new URLSearchParams({ c: link.c, p: link.p, a: link.a, e: link.e, t: link.t }).toString();
  const where = (p) => (p.target === "page" ? "לדף העסקי" : `לקבוצה "${p.group_name || S_.PRIVATE_NAME}"`);

  // → { link, camp, post, send } after the checks both methods share, or null when answered.
  async function readAct(req, res) {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" });
    const send = (status, title, body, extra) => res.status(status).type("html").send(card(title, body, extra));
    const link = S_.readActionLink(req.query || {}, authSecret, S.clock().getTime());
    if (link.error === "expired") { send(403, "פג תוקף הקישור", "אפשר לאשר, לדלג או לעצור מכרטיס הפרסום בדשבורד."); return null; }
    if (link.error) { send(403, "הקישור אינו תקף", "אפשר לאשר, לדלג או לעצור מכרטיס הפרסום בדשבורד."); return null; }
    const camp = await store.getPostingCampaign(link.c);
    if (!camp) { send(404, "לא נמצא", "הקמפיין הזה כבר לא קיים."); return null; }
    const post = link.a === "stop" ? null : (camp.posts || []).find((p) => p && p.id === link.p);
    if (link.a !== "stop" && !post) { send(404, "לא נמצא", "הפוסט הזה כבר לא קיים בקמפיין."); return null; }
    return { link, camp, post, send };
  }

  router.get("/act", wrap("act.ask", async (req, res) => {
    const r = await readAct(req, res);
    if (!r) return;
    const [question, button] = ASK[r.link.a];
    const action = `${req.baseUrl}/act?${qs(r.link)}`;
    const form = `<form id="act" method="post" action="${esc(action)}"><button type="submit" style="background:#B98A2F;color:#fff;border:0;` +
      `border-radius:12px;padding:12px 18px;font-size:1rem;width:100%;cursor:pointer">${esc(button)}</button></form>`;
    const body = r.post ? `פוסט ${where(r.post)}.` : "מה שכבר פורסם יישאר בקבוצות.";
    // Approving a post still waiting: its text is editable, and goes with the form.
    const editable = r.link.a === "approve" && r.post && r.post.status === "pending_approval";
    return r.send(200, question, body, (await postCard(r.camp, r.post, editable)) + form);
  }));

  // The post as it will look: the property's video, the copy as its
  // description, the link as the first comment. Nothing when the text is gone.
  // editable: the text is a textarea in the approve form (name="copy").
  async function postCard(camp, post, editable = false) {
    if (!post || typeof post.copy !== "string" || !post.copy) return "";
    const page = post.video_url === undefined ? await db.getPage(camp.page_id).catch(() => null) : null;
    const C = require("../posting-campaign");
    const v = C.videoView(post.video_url === undefined ? C.videoOf(page) : { video_url: post.video_url, poster_url: post.poster_url || null });
    const conn = (await db.getConnection(camp.phone).catch(() => null)) || {};
    const who = esc(conn.facebook_identity_label || "החשבון שלכם");
    const link = publicUrl(`${deps.pageBaseUrl || ""}/p/${camp.page_id}`);
    const video = v.video_url
      ? `<video controls playsinline preload="metadata" src="${esc(v.video_url)}"${v.poster_url ? ` poster="${esc(v.poster_url)}"` : ""} style="width:100%;max-height:70vh;background:#000;display:block"></video>`
      : `<p style="margin:0 12px 10px;color:#8A8276;font-size:.85rem">לנכס הזה אין סרטון — הפוסט יעלה כטקסט בלבד.</p>`;
    return `<div style="background:#fff;border:1px solid #E6DFD3;border-radius:12px;text-align:right;margin:0 0 16px;overflow:hidden">` +
      `<div style="padding:12px;font-size:.9rem"><b>${who}</b> ◂ ${esc(post.target === "page" ? "הדף העסקי" : post.group_name || S_.PRIVATE_NAME)}</div>` +
      (editable
        ? `<div style="padding:0 12px 12px"><label for="copy" style="display:block;color:#8A6A1E;font-size:.8rem;margin-bottom:4px">✏️ אפשר לערוך את הטקסט לפני האישור</label>` +
          `<textarea id="copy" name="copy" form="act" dir="auto" maxlength="${campaigns.MAX_COPY || 3000}" rows="${Math.min(18, post.copy.split("\n").length + 2)}" ` +
          `style="width:100%;box-sizing:border-box;font:inherit;line-height:1.6;border:1px solid #D9CFBF;border-radius:8px;padding:8px;resize:vertical;background:#FFFDF9">${esc(post.copy)}</textarea></div>`
        : `<div style="padding:0 12px 12px;white-space:pre-wrap;line-height:1.6">${esc(post.copy)}</div>`) + video +
      `<div style="padding:10px 12px;border-top:1px solid #EFE9DF;font-size:.85rem"><b>${who}</b> <span dir="ltr">${esc(link)}</span>` +
      `<div style="color:#8A8276;font-size:.75rem">תגובה ראשונה — הקישור לדף הנכס</div></div></div>`;
  }

  router.post("/act", express.urlencoded({ extended: false, limit: "32kb" }), wrap("act", async (req, res) => {
    const r = await readAct(req, res);
    if (!r) return;
    const { link, camp, post, send } = r;
    if (link.a === "stop") {
      await campaigns.stop(camp.id, deps);
      return send(200, "✋ הפרסום נעצר", "מה שכבר פורסם נשאר בקבוצות. אפשר להתחיל שוב מתי שתרצו, מעמוד הנכס.");
    }
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
    // The text as the agent left it on the page (unchanged, or edited).
    const sent = req.body && req.body.copy !== undefined ? req.body.copy : undefined;
    const copy = sent === undefined ? undefined : campaigns.cleanCopy(sent);
    if (sent !== undefined && !copy) return send(400, "הטקסט ריק או ארוך מדי", `לא אישרנו. חזרו לקישור ונסו שוב (עד ${campaigns.MAX_COPY || 3000} תווים).`);
    const out = await campaigns.approvePost(camp.id, post.id, deps, copy === undefined ? {} : { copy });
    const p = ((out && out.posts) || []).find((x) => x && x.id === post.id) || {};
    const when = p.scheduled_at ? new Date(p.scheduled_at).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    const mine = copy !== undefined && copy !== post.copy ? " עם הטקסט שערכתם" : "";
    return send(200, "✅ אושר!", `הפוסט יעלה ${where(p)}${mine}${when ? ` ב-${when}` : ""}. נעדכן בוואטסאפ כשזה קורה.`);
  }));

  require("./posting-settings")(router, S, auth);
  require("./posting-listing-groups")(router, S, ctx);
  return router;
};

module.exports.publicView = publicView;
module.exports.actionLink = S_.actionLink;
module.exports.CONSENT_VERSION = CONSENT_VERSION;
module.exports.MAX_ACTIVE_CAMPAIGNS = MAX_ACTIVE_CAMPAIGNS;
