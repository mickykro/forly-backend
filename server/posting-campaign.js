/*
 * posting-campaign.js — one property, its groups, over days.
 *
 * A campaign is the agent's recorded consent plus a record of what was done
 * with it. Two shapes:
 *   per_post  — every post is shown to the agent (exact copy, exact group,
 *               proposed time) and reserved only after a one-tap approval;
 *   standing  — one approval covers one pass over the groups (repeat: false)
 *               or repeated passes until expires_at (repeat: true), and STOP
 *               works at any moment.
 *
 * One campaign per (phone, page): the id is posting-store.campaignId() and
 * create() is create-if-absent, so a retried activation never makes two.
 * The scheduling decision is never made here: planAccount() asks
 * posting-safety. Nothing here opens a browser — posting-sweeper.js reserves
 * a durable attempt (R1) and runs it. Account-level facts (halts, penalty,
 * the disabled flag) live on the connection doc; the posting ledger is
 * derived from attempts, never written.
 */
const crypto = require("crypto");
const safety = require("./posting-safety");
const shareKit = require("./distribution/share-kit");
const { redact } = require("./driver-browser");
const A = require("./posting-account");

const { iso, fail, ms, ctxOf, nowOf, configOf, mutate, say, MS_DAY, OPEN_POST, ACTIVE_PAGE } = A;
const ENDED = new Set(["stopped", "completed"]);
const ENROLL_RESTARTABLE = new Set(["page_gone", "expired"]);
const ACCOUNT_REASONS = new Set(["disabled", "penalty", "browse_only", "day_skipped", "daily_cap", "weekly_cap"]);
const IMPORT_SOURCES = new Set(["yad2", "madlan", "import", "imported", "listing_sweep"]);
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 32);

function normalizeGroups(groups, ctx) {
  const out = [];
  const seen = new Set();
  for (const g of (Array.isArray(groups) ? groups : []).slice(0, shareKit.MAX_GROUPS)) {
    const url = shareKit.sanitizeGroups([g && g.url])[0];
    if (!url) continue;
    const m = A.memberOf(ctx.conn, { group_id: g.group_id, url });
    const group_id = String(g.group_id || (m && m.group_id) || A.groupIdFromUrl(url));
    if (seen.has(group_id) || /[/|]/.test(group_id)) continue;
    seen.add(group_id);
    const cat = A.catalogEntriesFor(ctx.catalog, { group_id, url }, ctx.conn)[0] || null;
    const base = {
      group_id, url, name: String(g.name || (m && m.name) || (cat && cat.name) || "").slice(0, 120),
      agent_policy: g.agent_policy || (cat && cat.agent_policy) || "unknown",
    };
    out.push(Object.assign(base, A.eligibility(base, ctx)));
  }
  return out;
}

// opts.restartWhen(cur) → bool: which ended campaigns this call may restart.
// Default (Task 19's route, an explicit agent create): any stopped/completed
// one. enrollNewPage passes a narrower rule (see there). Evaluated inside the
// campaign transaction, so a STOP landing meanwhile is never overridden.
async function create({ phone, page, groups, mode, days, repeat, consent, targets } = {}, deps = {}, opts = {}) {
  const x = ctxOf(deps);
  if (!consent || !consent.at) throw fail("consent_required", "consent required");
  if (!page || !page.page_id || !phone) throw fail("invalid_input", "phone and page required");
  const now = nowOf(deps, x);
  phone = String(phone);
  const conn = (await x.db.getConnection(phone)) || {};
  const ctx = { conn, catalog: await A.catalogIndex(x.db), listingType: (page.property || {}).listing_type || null, now };
  const c = {
    phone, page_id: String(page.page_id),
    mode: mode === "per_post" ? "per_post" : "standing",
    repeat: repeat === true,
    expires_at: iso(now.getTime() + Math.min(Math.max(Number(days) || 14, 1), 30) * MS_DAY),
    consent_at: iso(consent.at), consent_version: consent.version || null,
    groups: normalizeGroups(groups, ctx),
    targets: A.targetsFor(conn, targets),
    status: "running", pause_reason: null, wait_reason: null,
    posts: [], consecutive_failures: 0, tick_errors: 0, selector_failures: 0,
    created_at: iso(now), updated_at: iso(now),
  };
  const { created, campaign } = await x.store.createPostingCampaignIfAbsent(c);
  const may = (cur) => ENDED.has(cur.status) && (!opts.restartWhen || opts.restartWhen(cur));
  if (created || !may(campaign)) return campaign; // running/paused (or not restartable here): unchanged
  // Restart: a stopped or completed campaign takes the new consent and terms.
  // Its posts stay as history; restarted_at marks where the new pass begins,
  // so only future posts are planned (the cooldowns and the expiring dedup
  // still see the old ones through their attempts).
  const fresh = {
    status: "running", pause_reason: null, wait_reason: null, restarted_at: c.created_at,
    mode: c.mode, repeat: c.repeat, expires_at: c.expires_at, consent_at: c.consent_at, consent_version: c.consent_version,
    groups: c.groups, targets: c.targets, consecutive_failures: 0, tick_errors: 0, selector_failures: 0,
  };
  return mutate(x, campaign.id, (cur) => (may(cur) ? fresh : null));
}

// A page whose listing was imported from Yad2/Madlan and NOT turned into a
// page by the agent. Today every draft becomes a page only through the
// agent's "יצירת דף" (create.html?draft=<id> stamps listing.listing_draft_id),
// so this is defensive: it refuses any page marked imported without that stamp.
async function importedNotAgentCreated(page, db) {
  const listing = page.listing_id && typeof db.getListing === "function" ? await db.getListing(page.listing_id) : null;
  const imported = page.imported === true || IMPORT_SOURCES.has(page.source) || !!(listing && (listing.imported === true || IMPORT_SOURCES.has(listing.source)));
  const agentCreated = !!(page.created_from_draft_id || (listing && listing.listing_draft_id));
  return imported && !agentCreated;
}

// routes/pages.js calls this, fire-and-forget, when a page becomes active.
// Never throws: a failure is stored as posting_enroll_error on the page.
async function enrollNewPage(page, deps = {}) {
  const x = ctxOf(deps);
  if (!page || !page.page_id || !page.business_phone || !ACTIVE_PAGE.has(page.status || "active")) return null;
  try {
    const phone = String(page.business_phone);
    const conn = (await x.db.getConnection(phone)) || {};
    const perm = conn.posting_permission || {};
    if (perm.enabled !== true || !perm.granted_at || !(perm.platforms || []).includes("facebook") || !conn.facebook_browser_connected_at) return null;
    if (await importedNotAgentCreated(page, x.db)) return null;
    const member = new Map((conn.facebook_groups_member || []).filter((g) => g && g.membership_state === "member").map((g) => [g.group_id, g]));
    // The account's pool (default_group_ids), narrowed to the groups that
    // suit THIS property: its city, its kind of deal (A.fitsProperty).
    const catalog = await A.catalogIndex(x.db);
    const fits = (id) => {
      const m = member.get(id);
      return A.fitsProperty(m, A.catalogEntriesFor(catalog, { group_id: id, aliases: m.aliases, url: m.canonical_url || m.url }, conn), page.property);
    };
    const groups = (perm.default_group_ids || []).map(String).filter((id) => member.has(id) && fits(id))
      .map((id) => ({ group_id: id, url: member.get(id).canonical_url || member.get(id).url, name: member.get(id).name || "" }));
    const targets = A.targetsFor(conn, perm.targets);
    if (!groups.length && !targets.includes("page")) return null;
    // Creates only when no campaign exists; reactivates only one that ended by
    // itself (page_gone, expired) — never one the agent, a revoked permission
    // or an operator stopped, and never a finished pass.
    const c = await create({
      phone, page, groups, mode: perm.auto_mode === "per_post" ? "per_post" : "standing", days: 14, repeat: false,
      targets: perm.targets, consent: { at: perm.granted_at, version: perm.consent_version },
    }, deps, { restartWhen: (cur) => ENROLL_RESTARTABLE.has(cur.pause_reason) });
    if (page.posting_enroll_error && typeof x.db.updatePage === "function") await x.db.updatePage(page.page_id, { posting_enroll_error: null });
    return c;
  } catch (e) {
    console.error(redact(`posting enroll failed: ${(e && e.code) || "error"}`));
    if (typeof x.db.updatePage === "function") {
      await x.db.updatePage(page.page_id, { posting_enroll_error: { code: String((e && e.code) || "error").slice(0, 60), at: iso(x.clock()) } }).catch(() => null);
    }
    return null;
  }
}

async function pause(id, reason, deps = {}) {
  const x = ctxOf(deps);
  return mutate(x, id, (c) => (c.status === "running" ? { status: "paused", pause_reason: reason || "agent" } : null));
}

// The agent cannot lift an operator-level stop (R5): a disabled account, an
// owner review, or a reconnect that has not happened yet.
function accountBlocked(conn) {
  if (conn.posting_disabled_until_admin === true || conn.posting_owner_review_required === true) return true;
  return conn.facebook_needs_reconnect === true && !(ms(conn.facebook_browser_connected_at) > ms(conn.facebook_needs_reconnect_at));
}

async function resume(id, deps = {}) {
  const x = ctxOf(deps);
  const c = await x.store.getPostingCampaign(id);
  if (!c || c.status !== "paused") return c;
  const conn = (await x.db.getConnection(c.phone)) || {};
  if (accountBlocked(conn)) return c;
  return mutate(x, id, (cur) => (cur.status === "paused" ? { status: "running", pause_reason: null, consecutive_failures: 0, tick_errors: 0, selector_failures: 0 } : null));
}

// STOP commits first, in the campaign transaction — so a tick about to move a
// post to `posting` sees `stopped` and cancels its own reservation. Then it
// cancels every attempt that has not reached the Post click: those of the
// committed doc's `posting` posts, and any pre-submit attempt for this
// campaign found in the attempts store (one reserved a moment before the
// campaign doc recorded it). An in-flight attempt is left for reconciliation
// (R1). Cancelled posts are mirrored to `skipped`.
// Signature matches routes/connections-browser.js: stop(id, { db }).
async function stop(id, deps = {}, reason = "agent") {
  const x = ctxOf(deps);
  let was = null;
  const out = await mutate(x, id, (cur) => {
    was = cur.status; // the committed run's view (the last run wins)
    return {
      // A campaign already stopped keeps its reason — unless that reason is one
      // enrollment may undo (page_gone, expired): the agent's STOP then wins.
      status: "stopped", pause_reason: cur.status === "stopped" && !ENROLL_RESTARTABLE.has(cur.pause_reason) ? cur.pause_reason : reason,
      posts: cur.posts.map((p) => (["scheduled", "pending_approval"].includes(p.status) ? { ...p, status: "skipped", error_code: "stopped", copy: undefined } : p)),
    };
  });
  if (!out) return null;
  const keys = new Set(out.posts.filter((p) => p.status === "posting" && p.attempt_key).map((p) => p.attempt_key));
  let failed = 0;
  // A failed listing is a cancel failure, not an abort: the committed doc's
  // attempts are still cancelled, the posts mirrored and the agent told.
  try { for (const a of await x.store.listOpenAttemptsByCampaign(id)) keys.add(a.key); }
  catch { failed++; }
  for (const k of keys) {
    try { await x.store.transition(k, "cancelled", { error_code: "stopped" }, x.clock()); }
    catch (e) { if (!e || !["illegal_transition", "not_found"].includes(e.code)) failed++; }
  }
  if (failed) {
    A.noteCancelFailure(failed);
    console.error(redact(`posting stop …${String(id).slice(-6)}: ${failed} attempt cancel(s) failed`));
  }
  const cancelled = new Set();
  for (const k of keys) { const a = await x.store.getAttempt(k); if (a && a.state === "cancelled") cancelled.add(k); }
  const final = cancelled.size
    ? await mutate(x, id, (cur) => {
      const posts = cur.posts.map((p) => (p.status === "posting" && cancelled.has(p.attempt_key) ? { ...p, status: "skipped", error_code: "stopped", copy: undefined } : p));
      return posts.some((p, i) => p !== cur.posts[i]) ? { posts } : null;
    })
    : out;
  if (was !== "stopped") await say(deps, out.phone, "stopped", "הפרסום נעצר. מה שכבר פורסם נשאר.", final);
  return final;
}

// Approval is also a re-timing: the agent may tap at 23:40, and the slot the
// post was proposed for is long gone. Ask posting-safety again.
async function approvePost(id, postId, deps = {}) {
  const x = ctxOf(deps);
  const now = nowOf(deps, x);
  const c = await x.store.getPostingCampaign(id);
  if (!c) return null;
  const post = c.posts.find((p) => p.id === postId && p.status === "pending_approval");
  if (!post) return c;
  const config = await configOf(deps, x);
  const conn = (await x.db.getConnection(c.phone)) || {};
  const account = await A.accountView(c.phone, conn, deps, now, { exclude: post.id });
  const cand = { group_id: post.group_id, url: post.group_url };
  const slot = safety.nextSlot({ now, account, candidates: [{ ...cand, aliases: A.groupIdsOf(cand, conn).slice(1) }], pageId: c.page_id, config, rand: x.rand });
  const at = slot.at || A.nextDayStart(now, config, x.rand);
  return mutate(x, id, (cur) => ({
    posts: cur.posts.map((p) => (p.id === postId && p.status === "pending_approval" ? { ...p, status: "scheduled", scheduled_at: iso(at), approved_at: iso(now) } : p)),
  }));
}

async function skipPost(id, postId, deps = {}) {
  const x = ctxOf(deps);
  return mutate(x, id, (c) => ({
    posts: c.posts.map((p) => (p.id === postId && ["pending_approval", "scheduled"].includes(p.status) ? { ...p, status: "skipped", error_code: "agent", copy: undefined } : p)),
  }));
}

// posting_permission.enabled → false (routes/posting.js, Task 19): cancel what
// has not reached the Post click, let submit_started+ reconcile, and take
// the phone's campaigns out of planning.
async function revokePermission(phone, deps = {}) {
  const x = ctxOf(deps);
  let cancelled = 0;
  try { cancelled = await x.store.cancelOpenAttempts(String(phone), "facebook", x.clock()); }
  catch (e) {
    if (!e || e.code !== "cancel_incomplete") throw e;
    cancelled = e.cancelled || 0;
    A.noteCancelFailure((e.failures || []).length || 1);
    console.error(redact(`posting revoke ${A.tail(phone)}: ${(e.failures || []).length || 1} attempt cancel(s) failed`));
  }
  let paused = 0;
  for (const c of await x.store.listPostingCampaignsByPhone(String(phone))) {
    if (c.status === "running" && (await pause(c.id, "permission", deps))) paused++;
  }
  return { cancelled, paused };
}

// ── the account planner ──
function scoreOf(c, page, now) {
  const prop = page.property || {};
  const created = ms(page.created_at) || ms(c.created_at);
  const fresh = Number.isFinite(created) && now.getTime() - created < 7 * MS_DAY;
  const dropped = (prop.price_history || []).some((h) => h && now.getTime() - ms(h.at) < 14 * MS_DAY && Number(h.price) > Number(prop.price));
  const posted = (c.posts || []).some((p) => p.status === "posted" || p.status === "pending_group_approval");
  return (dropped ? 4 : 0) + (fresh ? 3 : 0) + (page.boost ? 2 : 0) + (posted ? 0 : 1);
}

// Targets this campaign may still post to: the Page first, then every eligible
// group it has not already used. A single pass uses each target once. A
// repeating campaign may return to a group once nothing is open there — the
// property→group cooldown (nextSlot) and the expiring dedup (R1) set when —
// and to the Page after 30 days.
function candidatesFor(c, ctx) {
  const posts = A.currentPosts(c);
  const recentPage = (p) => p.target === "page" && p.status !== "skipped" && ctx.now.getTime() - ms(p.scheduled_at) < 30 * MS_DAY;
  const used = new Set(posts.filter((p) => !c.repeat || OPEN_POST.has(p.status) || recentPage(p)).map((p) => p.group_id));
  const targets = c.targets || ["groups"];
  const out = [];
  const pt = targets.includes("page") ? A.pageTarget(ctx.conn) : null;
  if (pt && !used.has(pt.group_id)) out.push(pt);
  if (targets.includes("groups")) {
    for (const g of c.groups || []) {
      if (used.has(g.group_id)) continue;
      const e = A.eligibility(g, ctx);
      // Every other id of this group (a resolved slug, Task 18) rides along,
      // so cooldowns and group buckets recorded under it still apply.
      if (A.isEligible(e)) out.push({ ...g, ...e, target: "group", aliases: A.groupIdsOf(g, ctx.conn).slice(1) });
    }
  }
  return out;
}

/*
 * One phone, several running campaigns, one next slot: which property should
 * take it, and where? A price drop first, then a fresh listing, then one the
 * agent boosted, then one never posted; among equals the least recently
 * posted. Campaigns with an open post are not candidates.
 * → { campaignId, groupUrl, group_id, target, at } — a slot;
 *   { campaignId: null, reason } — nothing now (posting-safety's reason);
 *   null — no running campaign without an open post.
 */
async function planAccount(phone, deps = {}, now, pre = {}) {
  const x = ctxOf(deps);
  now = now || nowOf(deps, x);
  const config = pre.config || (await configOf(deps, x));
  const conn = pre.conn || (await x.db.getConnection(phone)) || {};
  const campaigns = pre.campaigns || (await x.store.listPostingCampaignsByPhone(phone));
  const ready = campaigns.filter((c) => c.status === "running" && !(c.posts || []).some((p) => OPEN_POST.has(p.status)));
  if (!ready.length) return null;
  const account = await A.accountView(phone, conn, deps, now, { campaigns });
  const catalog = await A.catalogIndex(x.db);
  const scored = [];
  for (const c of ready) {
    const page = await x.db.getPage(c.page_id);
    if (!page || !ACTIVE_PAGE.has(page.status || "active")) continue;
    const last = Math.max(0, ...(c.posts || []).map((p) => ms(p.posted_at)).filter(Number.isFinite));
    scored.push({ c, page, score: scoreOf(c, page, now), last, created: ms(c.created_at) || 0 });
  }
  scored.sort((a, b) => b.score - a.score || a.last - b.last || a.created - b.created);
  let wait = null;
  for (const s of scored) {
    const ctx = { conn, catalog, listingType: (s.page.property || {}).listing_type || null, now };
    const cands = candidatesFor(s.c, ctx);
    const groupCands = cands.filter((g) => g.target === "group");
    const groupIds = groupCands.map((g) => g.group_id);
    const aliases = Object.fromEntries(groupCands.map((g) => [g.group_id, g.aliases || []]));
    const groupActivity = groupIds.length ? await x.store.getGroupActivityFor(groupIds, now, undefined, aliases) : {};
    const fp = safety.fingerprint(s.page.property || {});
    for (const set of [cands.filter((g) => g.target === "page"), cands.filter((g) => g.target === "group")]) {
      if (!set.length) continue;
      const slot = safety.nextSlot({ now, account, candidates: set, pageId: s.c.page_id, fingerprint: fp, groupActivity, config, rand: x.rand });
      if (slot.at) {
        const g = set.find((q) => q.group_id === slot.group_id);
        return { campaignId: s.c.id, groupUrl: g.url, group_id: g.group_id, target: g.target, at: slot.at, duplicate_review: slot.duplicate_review || null };
      }
      if (ACCOUNT_REASONS.has(slot.reason)) return { campaignId: null, reason: slot.reason };
      wait = wait || { campaignId: null, reason: slot.reason };
    }
  }
  return wait || { campaignId: null, reason: "no_eligible_group" };
}

// Copy is built from the page AS IT IS NOW — a price cut yesterday must not
// be advertised at the old price today. The link goes in the first comment,
// with a per-attempt click id (R4) issued at reservation.
function buildCopy(page, c, target) {
  // linkInComment: the body never carries a URL, so no page URL is passed.
  return shareKit.buildPostCopy({ property: page.property || {}, agent: page.agent || {} }, "", { variantSeed: c.page_id + target.url, linkInComment: true });
}

// Appends the planned post to its campaign (scheduled, or pending_approval in
// per_post mode — the agent then sees the exact copy).
async function schedulePost(decision, deps = {}, now) {
  const x = ctxOf(deps);
  const c = await x.store.getPostingCampaign(decision.campaignId);
  if (!c || c.status !== "running") return c;
  const page = await x.db.getPage(c.page_id);
  if (!page) return c;
  const conn = (await x.db.getConnection(c.phone)) || {};
  const target = decision.target === "page" ? A.pageTarget(conn) : c.groups.find((g) => g.group_id === decision.group_id);
  if (!target) return c;
  const copy = buildCopy(page, c, target);
  const base = {
    id: crypto.randomUUID(), target: decision.target === "page" ? "page" : "group",
    group_id: target.group_id, group_url: target.url, group_name: target.name || "",
    scheduled_at: iso(decision.at), created_at: iso(now), approved_at: null, posting_started_at: null, posted_at: null,
    post_url: null, error_code: null, attempt_key: null, retries: 0, copy, copy_hash: sha(copy),
  };
  // Appended only while the campaign is still running (a STOP may have landed
  // since the read above); the mode is the committed one.
  const next = await mutate(x, c.id, (cur) => (cur.status !== "running" ? null : {
    posts: cur.posts.concat([{ ...base, status: cur.mode === "per_post" ? "pending_approval" : "scheduled" }]),
    wait_reason: null, duplicate_review: decision.duplicate_review || null,
  }));
  const post = next && next.posts.find((p) => p.id === base.id);
  if (post && post.status === "pending_approval") {
    await say(deps, c.phone, "approve", `📣 פוסט מוכן לאישור ל${post.target === "page" ? "דף העסקי" : `קבוצה "${post.group_name || post.group_url}"`}:\n──────────\n${copy}\n──────────`, next, post);
  }
  return next;
}

module.exports = {
  create, enrollNewPage, pause, resume, stop, approvePost, skipPost, revokePermission, planAccount, schedulePost, buildCopy,
  sha, // the copy_hash function — posting-driver.js (Task 18) checks the typed text against it
  // The sweeper half (posting-sweeper.js), re-exported lazily — no load cycle.
  tick: (...a) => require("./posting-sweeper").tick(...a),
  sweep: (...a) => require("./posting-sweeper").sweep(...a),
  startSweeper: (...a) => require("./posting-sweeper").startSweeper(...a),
  liveDeps: (...a) => require("./posting-sweeper").liveDeps(...a),
  haltAccount: (...a) => require("./posting-halts").haltAccount(...a),
  _test: { mutate, say, buildCopy, scoreOf, candidatesFor, accountBlocked, importedNotAgentCreated, sha },
};
