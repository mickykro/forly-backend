/*
 * routes/posting-settings.js — the account half of /api/posting (mounted by
 * routes/posting.js): the standing permission for new listings, the groups
 * this account is a member of, and what the card shows about both.
 *
 *   GET    /settings            permission, member/suggested groups, Pages, halt state
 *   PUT    /settings            the structured posting_permission; enabled:false revokes
 *   POST   /groups/resync       re-read "Your groups" (at most once per 10 minutes)
 *   DELETE /groups/:group_id    forget one membership entry, and keep it forgotten
 *   POST   /groups/:group_id/unhide   the agent selects a removed group again
 *   GET    /properties          every active property: its campaign, and the member groups that suit it
 *
 * PUT with enabled:false always works — it is how an agent switches off.
 */
const A = require("../posting-account");
const safety = require("../posting-safety");
const { sameArea } = require("../distribution/city-normalize");
const { isRealEstateGroup } = require("../facebook-groups-sync");
const { DriverError } = require("../driver-browser");
const { SIGNAL_PENALISES } = require("../posting-signals");
const S_ = require("./posting-shared");

const { CONSENT_VERSION, wrap, allowed } = S_;
const RESYNC_MIN_MS = 10 * 60 * 1000;
const MAX_SUGGESTED = 10;
const PERMISSION_CURED = ["no_permission", "permission_scope"]; // an enabling PUT grants it
// The classes behind the halt flags, as posting-halts.js records them — so
// the card (Task 23) can say what the agent must do. Codes only, never
// Facebook's own text; a value outside these sets is shown as null.
const DISABLE_CLASSES = new Set(["captcha", "checkpoint", "restricted", "suspected_compromise"]);
const PENALTY_CLASSES = new Set(["rate_limited", "feature_blocked", "confirmed_removed"]);

module.exports = function mountPostingSettings(router, S, auth) {
  const { db, store, campaigns, deps } = S;

  const hiddenList = (conn) => (Array.isArray(conn.facebook_groups_hidden) ? conn.facebook_groups_hidden : [])
    .filter((h) => h && Array.isArray(h.ids) && h.ids.length);

  async function publicMembers(conn, lookup) {
    const defaults = new Set(((conn.posting_permission || {}).default_group_ids || []).map(String));
    const find = lookup || S_.catalogLookup(await S.catalog(null));
    // Real-estate groups only, and only with a real name — never "קבוצה פרטית".
    return S_.memberList(conn).filter((m) => isRealEstateGroup(m, find.all ? find.all(m) : [find(m)]))
      .map((m) => S_.publicMember(m, find(m), defaults)).filter((g) => !g.private);
  }

  // When the next post would go out: the planner's answer for the running
  // campaigns (read-only), else — no campaign yet — posting-safety's next
  // slot for a first group post. null when nothing would go out now.
  async function firstPost(phone, conn, now) {
    try {
      const plan = await campaigns.planAccount(phone, deps, now);
      if (plan) return { at: plan.at ? A.iso(plan.at) : null, reason: plan.at ? null : plan.reason || null };
      const config = deps.config || safety.configFrom(await db.getSetting("posting"));
      const account = await A.accountView(phone, conn, deps, now);
      const slot = safety.nextSlot({ now, account, candidates: [{ group_id: "first-post-estimate", url: null }], pageId: null, config, rand: deps.rand || Math.random });
      return { at: slot.at ? A.iso(slot.at) : null, reason: slot.at ? null : slot.reason || null };
    } catch (e) {
      return { at: null, reason: "unavailable" };
    }
  }

  // haltState plus: the in-force disable's class (the strongest, as
  // posting-halts keeps it), the penalty's class, whether the penalty stops
  // posts right now (posting-guard: only while its newest penalising halt is
  // under 24 h old), and the fleet switch's reason when posting is off for all.
  async function haltView(conn, now) {
    const h = S_.haltState(conn, now);
    h.disabled_class = h.disabled_until_admin && DISABLE_CLASSES.has(conn.posting_disabled_class) ? conn.posting_disabled_class : null;
    h.penalty_class = h.penalty_until && PENALTY_CLASSES.has(conn.posting_penalty_class) ? conn.posting_penalty_class : null;
    const lastPenalising = Math.max(0, ...(conn.posting_halts || []).filter((x) => x && SIGNAL_PENALISES.has(x.code)).map((x) => A.ms(x.at)).filter(Number.isFinite));
    h.penalty_blocks_posts = !!h.penalty_until && now.getTime() - lastPenalising < A.MS_DAY;
    h.posting_off = null;
    if (typeof S.guard.assertFleetAllowed === "function") {
      try { await S.guard.assertFleetAllowed({ platform: "facebook" }, { db, env: deps.env || process.env }); }
      catch (e) { if (!e || e.code !== "posting_disabled") throw e; h.posting_off = e.reason || "global_off"; }
    }
    return h;
  }

  router.get("/settings", auth, wrap("settings.get", async (req, res) => {
    const phone = req.user.userId;
    const now = S.clock();
    const conn = (await db.getConnection(phone)) || {};
    const biz = (await db.getBusiness(phone)) || {};
    const all = await S.catalog(null);
    const lookup = S_.catalogLookup(all);
    const members = S_.memberList(conn);

    // "Groups in your area" the agent is not in: the business's activity
    // areas and, with ?page_id=, that property's city. Joining is the agent's act.
    const areas = (Array.isArray(biz.activity_areas) ? biz.activity_areas : []).filter((a) => typeof a === "string" && a.trim());
    if (typeof req.query.page_id === "string" && S_.ID_RE.test(req.query.page_id)) {
      const page = await db.getPage(req.query.page_id);
      const city = page && page.business_phone === phone && page.property && page.property.city;
      if (city) areas.push(String(city));
    }
    const memberCats = new Set(members.filter((m) => m.membership_state !== "left").map(lookup).filter(Boolean));
    const hidden = S_.hiddenIds(conn);
    const suggested = areas.length ? all
      .filter((g) => g && g.url && g.city && !memberCats.has(g) && !hidden.has(A.groupIdFromUrl(g.url)) && areas.some((a) => sameArea(a, g.city)))
      .sort((a, b) => (b.members || 0) - (a.members || 0)).slice(0, MAX_SUGGESTED)
      .map((g) => ({ group_id: A.groupIdFromUrl(g.url), url: g.url, name: g.name || null, city: g.city, members: g.members || null, agent_policy: g.agent_policy || "unknown" }))
      : [];

    const est = await firstPost(phone, conn, now);
    return res.json({
      consent_version: CONSENT_VERSION,
      permission: S_.publicPermission(conn),
      member_groups: await publicMembers(conn, lookup),
      hidden_group_ids: hiddenList(conn).map((h) => h.ids[0]),
      suggested_groups: suggested,
      // available: this Page's numeric id is known, so it can be a campaign target (I4).
      pages: S_.pagesOf(conn).map((p) => ({ id: S_.pageKey(p), name: p.name || "דף ללא שם", available: A.numericPageId(p) })),
      page_target_available: A.pageTargetAvailable(conn),
      page_publisher: conn.page_publisher || "browser",
      first_post_estimate: est.at, first_post_wait_reason: est.reason,
      groups_synced_at: conn.facebook_groups_synced_at || null,
      connected: !!conn.facebook_browser_connected_at,
      halt_state: await haltView(conn, now),
    });
  }));

  // The publishing page's list, in one call: each active property of this
  // agent, its latest campaign (public view), and which member groups suit
  // it (A.fitsProperty — its city, its kind of deal). Group ids only.
  router.get("/properties", auth, wrap("properties", async (req, res) => {
    const phone = req.user.userId;
    const conn = (await db.getConnection(phone)) || {};
    const lookup = S_.catalogLookup(await S.catalog(null));
    const members = S_.memberList(conn).filter((m) => m.membership_state === "member" && isRealEstateGroup(m, lookup.all(m)) && (m.name || (lookup(m) || {}).name));
    const listings = typeof db.listListingsByPhone === "function" ? await db.listListingsByPhone(phone) : [];
    const camps = await store.listPostingCampaignsByPhone(phone);
    const latest = (pageId) => camps.filter((c) => c.page_id === pageId)
      .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))[0] || null;
    const out = [];
    for (const l of listings) {
      if (!l || l.status === "archived" || !l.page_id) continue;
      const page = await db.getPage(l.page_id).catch(() => null);
      if (!page || page.business_phone !== phone || !A.ACTIVE_PAGE.has(page.status || "active")) continue;
      const property = Object.assign({ city: l.city, listing_type: l.listing_type || "sale" }, page.property || {});
      out.push({
        page_id: page.page_id,
        title: `${property.rooms || l.rooms || ""} חד׳ ב${property.neighborhood || l.neighborhood || property.city || ""}`.trim(),
        city: property.city || null,
        listing_type: property.listing_type || "sale",
        thumb_url: (l.photos_urls && l.photos_urls[0]) || null,
        campaign: S_.publicView(latest(page.page_id)),
        fit_group_ids: members.filter((m) => A.fitsProperty(m, lookup.all(m), property)).map((m) => m.group_id),
      });
    }
    return res.json({ properties: out, max_active: S_.MAX_ACTIVE_CAMPAIGNS });
  }));

  router.put("/settings", auth, wrap("settings.put", async (req, res) => {
    const phone = req.user.userId;
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const now = S.clock();

    // Switching off: no consent, no switch check, nothing else read. The
    // revocation (R2) runs before the response: pre-submit attempts are
    // cancelled and running campaigns leave planning.
    if (b.enabled === false) {
      await store.mutateConnection(phone, () => ({ posting_permission: { enabled: false, revoked_at: A.iso(now) } }));
      const revoked = await campaigns.revokePermission(phone, deps);
      const conn = (await db.getConnection(phone)) || {};
      return res.json({ ok: true, permission: S_.publicPermission(conn), revoked });
    }

    if (b.enabled !== true) return res.status(400).json({ error: "invalid_input" });
    if (b.consent !== true) return res.status(400).json({ error: "consent_required" });
    const g = S_.parseGroupIds(b.default_group_ids);
    const t = S_.parseTargets(b.targets);
    const badMode = b.auto_mode !== undefined && !["per_post", "standing"].includes(b.auto_mode);
    const badVis = b.allows_visible_interactions !== undefined && typeof b.allows_visible_interactions !== "boolean";
    const badPage = b.page_id !== undefined && b.page_id !== null && (typeof b.page_id !== "string" || b.page_id.length > 64);
    if (g.error || t.error || badMode || badVis || badPage) return res.status(400).json({ error: "invalid_input" });
    if (b.consent_version !== CONSENT_VERSION) return res.status(409).json({ error: "consent_outdated", consent_version: CONSENT_VERSION });
    if (!(await allowed(S, phone, res, PERMISSION_CURED))) return;

    const conn = (await db.getConnection(phone)) || {};
    const gate = S_.memberGate(conn, g.ids);
    if (gate.notMember) return res.status(422).json({ error: "not_member", group_ids: gate.notMember });
    const prev = conn.posting_permission || {};
    let pageId = prev.page_id || null;
    if (typeof b.page_id === "string") {
      const p = S_.pageByKey(conn, b.page_id);
      if (!p) return res.status(422).json({ error: "unknown_page" });
      pageId = S_.storedPageId(p);
    }
    const targets = t.targets || (Array.isArray(prev.targets) && prev.targets.length ? prev.targets : S_.DEFAULT_TARGETS);
    if (targets.includes("page") && !S_.pageConfirmed(conn, pageId)) return res.status(409).json({ error: "page_not_confirmed" });
    // A Page asked for by name must be one the browser can prove (its numeric id, I4).
    if (t.targets && t.targets.includes("page") && !A.pageTarget(Object.assign({}, conn, { posting_permission: Object.assign({}, prev, { page_id: pageId }) }))) {
      return res.status(409).json({ error: "page_target_unavailable" });
    }

    // granted_at is when THIS consent (this text version) was given.
    const renewed = prev.enabled === true && prev.consent_version === CONSENT_VERSION && prev.granted_at;
    const perm = {
      enabled: true, consent_version: CONSENT_VERSION, granted_at: renewed ? prev.granted_at : A.iso(now),
      platforms: ["facebook"], targets, default_group_ids: gate.entries.map((m) => m.group_id), page_id: pageId,
      auto_mode: b.auto_mode || (prev.auto_mode === "per_post" ? "per_post" : "standing"),
      allows_dwell: true,
      allows_visible_interactions: typeof b.allows_visible_interactions === "boolean" ? b.allows_visible_interactions : prev.allows_visible_interactions === true,
      revoked_at: null,
    };
    const saved = await store.mutateConnection(phone, () => ({ posting_permission: perm }));
    return res.json({ ok: true, permission: S_.publicPermission(saved || { posting_permission: perm }) });
  }));

  router.post("/groups/resync", auth, wrap("groups.resync", async (req, res) => {
    const phone = req.user.userId;
    const now = S.clock();
    const conn = (await db.getConnection(phone)) || {};
    if (!conn.facebook_browser_connected_at) return res.status(409).json({ error: "facebook_not_connected" });
    // runSync asks the guard itself (action "session"); asked here first so
    // a refusal does not use up the agent's 10 minutes.
    try {
      await S.guard.assertAllowed({ phone, platform: "facebook", action: "session" }, { db, env: deps.env || process.env });
    } catch (e) {
      if (!e || e.code !== "posting_disabled") throw e;
      return res.status(409).json({ error: "posting_disabled", reason: e.reason });
    }

    // Check-and-stamp in one transaction: two taps never start two syncs.
    const stamp = A.iso(now);
    let prevAt = null, wait = 0;
    await store.mutateConnection(phone, (cur) => {
      prevAt = cur.facebook_groups_resync_at || null;
      const since = now.getTime() - A.ms(prevAt);
      wait = process.env.FORLY_ENV === "local" ? 0 : since >= 0 && since < RESYNC_MIN_MS ? RESYNC_MIN_MS - since : 0;
      return wait ? null : { facebook_groups_resync_at: stamp };
    });
    if (wait) return res.status(429).json({ error: "too_soon", retry_after_s: Math.ceil(wait / 1000) });
    // Nothing ran (the profile or the browser budget was busy, or a switch
    // flipped): give the agent their 10 minutes back.
    const unstamp = () => store.mutateConnection(phone, (cur) => (cur.facebook_groups_resync_at === stamp ? { facebook_groups_resync_at: prevAt } : null));

    try {
      await S.groupsSync.runSync({ phone }, deps);
    } catch (e) {
      if (e && e.code === "profile_busy") { await unstamp(); return res.status(409).json({ error: "profile_busy" }); }
      if (e instanceof DriverError && e.status === 429) { await unstamp(); return res.status(503).json({ error: "driver_busy", retry: true }); }
      if (e && e.code === "posting_disabled") { await unstamp(); return res.status(409).json({ error: "posting_disabled", reason: e.reason }); }
      const { redact } = require("../driver-browser");
      console.error(redact(`posting groups resync failed: ${(e && (e.code || e.name)) || "error"}`));
      return res.status(503).json({ error: "sync_failed" });
    }
    const after = (await db.getConnection(phone)) || {};
    return res.json({ member_groups: await publicMembers(after), groups_synced_at: after.facebook_groups_synced_at || null });
  }));

  // Forgets one membership entry (every id it is known by), drops it from the
  // default groups, and records its ids in facebook_groups_hidden (ids only,
  // never a name) so no sync — this route's or the weekly sweep's — brings it
  // back. A campaign's copy of the group stops being planned: its is_member is
  // re-derived from the member list at every plan.
  router.delete("/groups/:group_id", auth, wrap("groups.delete", async (req, res) => {
    const phone = req.user.userId;
    const id = String(req.params.group_id || "");
    if (!S_.GROUP_ID_RE.test(id)) return res.status(400).json({ error: "invalid_input" });
    const at = A.iso(S.clock());
    let removed = false;
    const saved = await store.mutateConnection(phone, (cur) => {
      const m = S_.findMember(cur, id);
      removed = !!m;
      if (!m) return null;
      const ids = new Set([id, ...S_.idsOf(m)]);
      const same = (e) => S_.idsOf(e).some((x) => ids.has(x));
      const list = Array.isArray(cur.facebook_groups_member) ? cur.facebook_groups_member.filter((e) => e && e.group_id) : [];
      for (const e of list) if (same(e)) for (const x of S_.idsOf(e)) ids.add(x);
      const hidden = hiddenList(cur).filter((h) => !h.ids.some((x) => ids.has(String(x))));
      const patch = {
        facebook_groups_member: list.filter((e) => !same(e)),
        facebook_groups_hidden: hidden.concat([{ ids: [m.group_id, ...[...ids].filter((x) => x !== m.group_id)], hidden_at: at }]),
      };
      const perm = cur.posting_permission;
      if (perm && Array.isArray(perm.default_group_ids)) {
        patch.posting_permission = { default_group_ids: perm.default_group_ids.map(String).filter((x) => !ids.has(x)) };
      }
      return patch;
    });
    if (!removed) return res.status(404).json({ error: "not_found" });
    return res.json({ removed: true, member_groups: await publicMembers(saved || {}), hidden_group_ids: hiddenList(saved || {}).map((h) => h.ids[0]) });
  }));

  // Guard exception (accepted): unhide leads to no post by itself — the group
  // must still be synced as a member and chosen for a campaign, both gated.
  // The only way back: the agent picks the removed group again on the card.
  // It reappears at the next sync (if the account is still a member).
  router.post("/groups/:group_id/unhide", auth, wrap("groups.unhide", async (req, res) => {
    const phone = req.user.userId;
    const id = String(req.params.group_id || "");
    if (!S_.GROUP_ID_RE.test(id)) return res.status(400).json({ error: "invalid_input" });
    let found = false;
    const saved = await store.mutateConnection(phone, (cur) => {
      const list = hiddenList(cur);
      const keep = list.filter((h) => !h.ids.map(String).includes(id));
      found = keep.length !== list.length;
      return found ? { facebook_groups_hidden: keep } : null;
    });
    if (!found) return res.status(404).json({ error: "not_found" });
    return res.json({ unhidden: true, hidden_group_ids: hiddenList(saved || {}).map((h) => h.ids[0]) });
  }));
};
