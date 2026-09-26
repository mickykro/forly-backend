/*
 * posting-account.js — the account as the campaign state machine sees it.
 *
 * Shared by posting-campaign.js (create, planner) and posting-sweeper.js
 * (reserve, run, settle): dependency defaults, the group eligibility rules,
 * the curated catalog, the Page target, and `accountView()` — the account
 * object posting-safety.nextSlot() paces against, built from durable
 * attempts (R1), the agent's manual share-kit posts and every open campaign
 * post on the phone. Writes go through mutate() (campaigns) only; the
 * notification helpers log a redacted line when a send fails.
 */
const safety = require("./posting-safety");
const shareKit = require("./distribution/share-kit");
const { redact } = require("./driver-browser");

const MS_MIN = 60000, MS_HOUR = 3600000, MS_DAY = 86400000;
const LOOKBACK_DAYS = 30;
const MEMBERSHIP_FRESH_MS = 48 * MS_HOUR; // older → the driver re-confirms membership (review §21)
const ACTIVE_PAGE = new Set(["active", "expiring"]);
const OPEN_POST = new Set(["pending_approval", "scheduled", "posting"]);
// Attempt state → campaign post status (the post mirrors its attempt).
const POST_STATUS_OF = {
  verified_posted: "posted", submitted_for_approval: "pending_group_approval",
  verified_failed: "failed", outcome_unknown: "unknown", cancelled: "skipped",
};
const ELIGIBILITY = ["is_member", "catalog_policy", "listing_type_allowed", "posting_currently_available"];
const DISALLOWED_POLICY = new Set(["forbidden", "disallowed", "not_allowed", "no_agents"]);

const iso = (d) => new Date(d).toISOString();
const tail = (s) => `…${String(s || "").slice(-4)}`;
const fail = (code, msg) => Object.assign(new Error(msg || code), { code });
// A Firestore Timestamp, a Date, an ISO string or epoch ms → ms (NaN if none).
const ms = (v) => (v && typeof v.toDate === "function" ? v.toDate().getTime() : v === undefined || v === null ? NaN : new Date(v).getTime());

// One place for every default, so tests inject fakes and production gets the
// real modules. `deps.db` is db.js (connections, pages, settings); `deps.store`
// is posting-store.js (campaigns, attempts).
function ctxOf(deps = {}) {
  return {
    db: deps.db || require("./db"),
    store: deps.store || require("./posting-store"),
    guard: deps.guard || require("./posting-guard"),
    locks: deps.locks || require("./profile-lock"),
    clock: typeof deps.clock === "function" ? deps.clock : () => new Date(),
    rand: typeof deps.rand === "function" ? deps.rand : Math.random,
  };
}
const nowOf = (deps, x) => (deps && deps.now instanceof Date ? deps.now : x.clock());
const guardDeps = (deps, x) => ({ db: x.db, env: deps.env || process.env });

async function configOf(deps, x) {
  if (deps.config) return deps.config;
  return safety.configFrom(await x.db.getSetting("posting"));
}

// facebook.com/groups/<slug> → the Task 14 group_id: the numeric id, or
// "slug:<slug>" until the driver resolves it.
function groupIdFromUrl(url) {
  const slug = (String(url || "").match(/\/groups\/([^/?#]+)/) || [])[1];
  if (!slug) return null;
  return /^\d+$/.test(slug) ? slug : `slug:${slug}`;
}

// The curated catalog as routes/distribution.js mergedCatalog() builds it:
// the bundled seed, Firestore entries merged on top by canonical URL. Kept
// raw (active flag included) so an operator-disabled group reads as disallowed.
let SEED = null;
async function catalogIndex(db) {
  if (!SEED) SEED = require("./distribution/group-seed.json").map((g) => ({ ...g, url: shareKit.sanitizeGroups([g.url])[0] })).filter((g) => g.url);
  const byUrl = new Map(SEED.map((g) => [g.url, { ...g }]));
  const extra = typeof db.listGroupCatalog === "function" ? await db.listGroupCatalog(500) : [];
  for (const g of extra || []) {
    const url = g && g.url && shareKit.sanitizeGroups([g.url])[0];
    if (url) byUrl.set(url, { ...(byUrl.get(url) || {}), ...g, url });
  }
  return byUrl;
}

// A group's id and its aliases (Task 18: a vanity "slug:…" id resolved to
// its numeric id stays an alias on the campaign group and on the membership
// entry) are one group everywhere: membership, penalties, cooldowns, the
// group bucket and the property→group dedup.
const aliasesOf = (e) => (e && Array.isArray(e.aliases) ? e.aliases.map(String) : []);
const sameEntry = (m, g) => !!(m && g && g.group_id && (safety.sameGroup(m.group_id, g.group_id, aliasesOf(g)) || aliasesOf(m).includes(String(g.group_id))));
function memberOf(conn, g) {
  const list = Array.isArray(conn && conn.facebook_groups_member) ? conn.facebook_groups_member : [];
  return list.find((m) => m && (sameEntry(m, g) || (g.url && (m.canonical_url === g.url || m.url === g.url)))) || null;
}
// Every id `g` is known by: its own, its aliases, and those of its
// membership entry. → [group_id, ...aliases], group_id first.
function groupIdsOf(g, conn) {
  const ids = new Set([g.group_id, ...aliasesOf(g)].filter(Boolean).map(String));
  const m = g.group_id ? memberOf(conn, g) : null;
  if (m && sameEntry(m, g)) for (const id of [m.group_id, ...aliasesOf(m)]) if (id) ids.add(String(id));
  return [...ids];
}

// Every catalog entry that describes group `g`: looked up by each id the
// group is known by (its own, its aliases, its membership entry's — a vanity
// slug resolved to a numeric id, Task 18), then by URL (g.url and the
// membership's canonical URL). The catalog may list a group under either
// URL, so a URL-only lookup could miss a disallowed or rent-only entry.
// `catalog` is catalogIndex()'s Map or routes/distribution.mergedCatalog()'s
// array; routes/posting-shared.js uses the same helper.
const CATALOG_IX = new WeakMap();
function catalogIx(catalog) {
  let ix = catalog && typeof catalog === "object" ? CATALOG_IX.get(catalog) : null;
  if (ix) return ix;
  ix = { byUrl: new Map(), byId: new Map() };
  const entries = catalog instanceof Map ? [...catalog.values()] : Array.isArray(catalog) ? catalog : [];
  for (const e of entries) {
    if (!e || !e.url) continue;
    ix.byUrl.set(e.url, e);
    const id = groupIdFromUrl(e.url);
    if (id && !ix.byId.has(id)) ix.byId.set(id, e);
  }
  if (catalog && typeof catalog === "object") CATALOG_IX.set(catalog, ix);
  return ix;
}
function catalogEntriesFor(catalog, g, conn) {
  const ix = catalogIx(catalog);
  const out = [];
  const add = (e) => { if (e && !out.includes(e)) out.push(e); };
  for (const id of g.group_id ? groupIdsOf(g, conn) : []) add(ix.byId.get(String(id)));
  const m = g.group_id || g.url ? memberOf(conn, g) : null;
  for (const u of [g.url, m && m.canonical_url, m && m.url]) if (u) add(ix.byUrl.get(u));
  return out;
}
const policyDisallowed = (e) => !!e && (e.active === false || DISALLOWED_POLICY.has(e.agent_policy));
const typeExcluded = (e, listingType) => !!listingType && Array.isArray(e.listing_types) && e.listing_types.length > 0 && !e.listing_types.includes(listingType);

// Groups the agent removed from their list (facebook_groups_hidden, Task 19):
// never members here, whatever the membership list says.
function isHidden(conn, g) {
  const hidden = require("./facebook-groups-sync").hiddenIds(conn);
  return hidden.size > 0 && groupIdsOf(g, conn).some((id) => hidden.has(String(id)));
}

// The four booleans a group needs, all true, to be planned (adapt notes):
// a member (state "member", not stale/left, not hidden); no matching catalog
// entry disallows it; every matching entry's listing types admit this page's
// type; and no live confirmed_removed penalty on the group. A result the
// driver reported on this campaign's own group (not_member / group_blocked)
// keeps it off. Catalog entries are matched by id and alias, then URL.
function eligibility(g, { conn, catalog, listingType, now }) {
  if (g.target === "page") return { is_member: true, catalog_policy: true, listing_type_allowed: true, posting_currently_available: true };
  const m = memberOf(conn, g);
  const cats = catalogEntriesFor(catalog, g, conn);
  const pens = (conn && conn.posting_group_penalties) || {};
  const pen = groupIdsOf(g, conn).map((id) => pens[id]).filter(Boolean).sort((a, b) => ms(b.until) - ms(a.until))[0];
  return {
    is_member: !!m && m.membership_state === "member" && g.blocked_code !== "not_member" && !isHidden(conn, g),
    catalog_policy: !cats.some(policyDisallowed) && !DISALLOWED_POLICY.has(g.agent_policy),
    listing_type_allowed: !cats.some((e) => typeExcluded(e, listingType)),
    posting_currently_available: !(pen && ms(pen.until) > now.getTime()) && g.blocked_code !== "group_blocked",
  };
}
const isEligible = (g) => ELIGIBILITY.every((k) => g[k] === true);

function needsMembershipCheck(conn, g, now) {
  if (g.target === "page") return false;
  const m = memberOf(conn, g);
  const at = m ? ms(m.last_confirmed_at) : NaN;
  return !Number.isFinite(at) || now.getTime() - at > MEMBERSHIP_FRESH_MS;
}

// The agent's own Page, when the browser may post to it: the one the agent
// confirmed (posting_permission.page_id), or the only one discovered (R3).
// Only with the Page's numeric id, read from its own metadata at connect
// (I4): R3 proves the destination against that id, so a Page without one
// could never pass — it is not a target at all.
const numericPageId = (p) => !!p && /^\d+$/.test(String(p.id || ""));
function pageTarget(conn) {
  if (!conn || (conn.page_publisher || "browser") !== "browser") return null;
  const pages = Array.isArray(conn.facebook_pages) ? conn.facebook_pages.filter((p) => p && p.url) : [];
  const chosen = (conn.posting_permission || {}).page_id;
  // Never picked automatically, even when only one was discovered: the scrape can
  // mistake the agent's own (or a friend's) profile for a Page, and that would
  // pass R3 on a personal timeline. The agent's explicit choice is the proof.
  const p = chosen ? pages.find((x) => x.id === chosen || x.url === chosen) : null;
  if (!numericPageId(p)) return null;
  const target_id = String(p.id);
  return { target: "page", target_id, group_id: `page:${target_id}`, url: p.url, name: p.name || "" };
}
// Could the card offer a Page at all: the browser publishes Pages, and at
// least one discovered Page has its numeric id.
const pageTargetAvailable = (conn) => !!conn && (conn.page_publisher || "browser") === "browser"
  && Array.isArray(conn.facebook_pages) && conn.facebook_pages.some((p) => p && p.url && numericPageId(p));

function targetsFor(conn, requested) {
  const want = Array.isArray(requested) && requested.length ? requested : ["groups"]; // the Page is opt-in
  const hasPage = !!pageTarget(conn);
  return ["page", "groups"].filter((t) => want.includes(t) && (t === "groups" || hasPage));
}

/*
 * The account posting-safety paces against. `posts` is every attempt in a
 * counting state (ok: null until terminal), the agent's manual share-kit
 * posts (post_url is the group URL), and every open campaign post that has
 * no attempt yet (its scheduled_at is a reservation of the slot). `exclude`
 * drops one campaign post — the one being re-timed or re-checked.
 */
async function accountView(phone, conn, deps, now, opts = {}) {
  const x = ctxOf(deps);
  const since = now.getTime() - LOOKBACK_DAYS * MS_DAY;
  const attempts = (await x.store.listAttemptsByPhone(phone, since)).filter((a) => x.store.isCounting(a));
  const keys = new Set(attempts.map((a) => a.key));
  const posts = attempts.map((a) => ({
    at: a.reserved_at, group_id: a.target_type === "page" ? `page:${a.target_id}` : a.target_id, group_url: a.target_url || null,
    page_id: a.page_id, ok: a.state === "verified_posted" || a.state === "submitted_for_approval" ? true : a.state === "verified_failed" ? false : null,
    attempt_key: a.key, post_id: a.post_id || null,
  })).filter((p) => !opts.exclude || p.post_id !== opts.exclude);
  for (const a of await x.store.listPostActionsByPhone(phone, since)) {
    if (a.target !== "facebook_group" || a.source === "campaign" || !a.post_url || !a.at) continue;
    const url = shareKit.sanitizeGroups([a.post_url])[0] || a.post_url;
    posts.push({ at: a.at, group_id: groupIdFromUrl(url), group_url: url, page_id: a.page_id || null, ok: true });
  }
  const campaigns = opts.campaigns || (await x.store.listPostingCampaignsByPhone(phone));
  for (const c of campaigns) {
    if (c.status !== "running") continue;
    for (const p of c.posts || []) {
      if (!OPEN_POST.has(p.status) || p.id === opts.exclude || (p.attempt_key && keys.has(p.attempt_key)) || !p.scheduled_at) continue;
      posts.push({ at: p.scheduled_at, group_id: p.group_id, group_url: p.group_url, page_id: c.page_id, ok: null });
    }
  }
  return {
    first_connected_at: conn.facebook_browser_first_connected_at || conn.facebook_browser_connected_at || null,
    halts: conn.posting_halts || [],
    disabled_until_admin: conn.posting_disabled_until_admin === true || conn.posting_owner_review_required === true,
    penalty_until: conn.posting_penalty_until || null,
    account_aged: conn.posting_account_aged === undefined ? null : conn.posting_account_aged,
    posted_manually: conn.posting_posted_manually === undefined ? null : conn.posting_posted_manually,
    plan_seed: safety.planSeed(phone),
    posts,
  };
}

// The posts of the campaign's current pass: after a restart (create on a
// stopped/completed campaign) older posts are history, not "used" targets.
function currentPosts(c) {
  const since = ms(c.restarted_at);
  const posts = c.posts || [];
  return Number.isFinite(since) ? posts.filter((p) => OPEN_POST.has(p.status) || ms(p.created_at) >= since) : posts;
}

// The reservation's hard ceilings for the landing day (16a: required), and
// how long the property→target dedup holds: the property→group cooldown for
// a group, 30 days for the Page.
const PAGE_DEDUP_DAYS = 30;
function limitsFor(account, at, config, targetType = "group") {
  return {
    daily_cap: safety.dailyCapFor(account, at, config), group_global_daily_cap: config.group_global_daily_cap,
    dedup_days: targetType === "page" ? PAGE_DEDUP_DAYS : config.property_group_cooldown_days,
  };
}

// The start of the next Jerusalem calendar day's active window, with the
// day's own start jitter — a post pushed to "tomorrow" never lands at 09:00:00 sharp.
function nextDayStart(now, config, rand) {
  const today = safety.jerusalemDate(now);
  let t = new Date(now.getTime());
  for (let i = 0; i < 4 * 30 && safety.jerusalemDate(t) === today; i++) t = new Date(t.getTime() + 15 * MS_MIN);
  const first = safety.nextActiveTime(t, config);
  return safety.nextActiveTime(new Date(first.getTime() + Math.floor(rand() * (config.day_start_jitter_min || 0)) * MS_MIN), config);
}

// Every read-modify-write of a campaign: one store transaction
// (mutatePostingCampaign), so concurrent writers never lose each other's
// change to `posts`. `fn` must be pure — it may run more than once.
// Retention (Task 21), in this one place: a campaign that BECOMES stopped or
// completed gets expire_at = updated_at + 30 days (a Date, so Firestore's TTL
// policy on expire_at deletes it); any other status (a restart) clears it.
const ENDED = new Set(["stopped", "completed"]);
const CAMPAIGN_RETENTION_DAYS = 30;
async function mutate(x, id, fn) {
  const now = x.clock();
  const at = iso(now);
  return x.store.mutatePostingCampaign(id, (cur) => {
    const patch = fn(cur);
    if (!patch) return null;
    const out = Object.assign({}, patch, { updated_at: at });
    if (typeof patch.status === "string") {
      if (!ENDED.has(patch.status)) out.expire_at = null;
      else if (!ENDED.has(cur.status) || !cur.expire_at) out.expire_at = new Date(now.getTime() + CAMPAIGN_RETENTION_DAYS * MS_DAY);
    }
    return out;
  });
}

// deps.messages (Task 20) supplies the signed-link texts; until then these
// Hebrew fallbacks go out. A failed notification never changes state.
async function say(deps, phone, kind, fallback, ...args) {
  if (typeof deps.notify !== "function") return;
  const text = deps.messages && typeof deps.messages[kind] === "function" ? deps.messages[kind](...args) : fallback;
  if (!text) return;
  try { await deps.notify(phone, text); } catch (e) { console.error(redact(`posting notify ${kind} ${tail(phone)} failed: ${(e && e.code) || "error"}`)); }
}

// The operator's channel (POSTING_OPERATOR_PHONE); never throws.
async function tellOperator(deps, text) {
  if (typeof deps.notifyOperator !== "function") return;
  try { await deps.notifyOperator(text); } catch (e) { console.error(redact(`posting operator notify failed: ${(e && e.code) || "error"}`)); }
}

// What the driver saw first-hand on a group's own page (Task 18): "Join
// group" showing (membership "left"), or a vanity slug's real numeric id.
// The connection's membership list and the campaign's group follow it; the
// old slug id stays an alias of the numeric one on both. Never throws.
async function applyFindings(result, { c, post }, x, now) {
  const gid = post && post.group_id;
  if (!result || typeof result !== "object" || post.target === "page" || !gid) return;
  const rid = String(result.resolved_group_id || "");
  const numeric = /^slug:/.test(gid) && /^\d+$/.test(rid) ? rid : null;
  const left = result.membership === "left";
  if (!left && !numeric) return;
  const id = numeric || gid;
  const note = (what, e) => console.error(redact(`posting ${what} ${tail(c.phone)}: ${(e && (e.code || e.name)) || "error"}`));
  try {
    const { resolveGroupId } = require("./facebook-groups-sync");
    await x.store.mutateConnection(c.phone, (conn) => {
      let list = Array.isArray(conn.facebook_groups_member) ? conn.facebook_groups_member : [];
      if (numeric) list = resolveGroupId({ facebook_groups_member: list }, gid, numeric);
      if (left) list = list.map((e) => (e && (e.group_id === id || aliasesOf(e).includes(id)) ? { ...e, membership_state: "left", observed_at: iso(now) } : e));
      return { facebook_groups_member: list };
    });
  } catch (e) { note("membership update", e); }
  // Right after the resolving write: the registry every account's caps read.
  if (numeric && typeof x.store.recordGroupAlias === "function") {
    try { await x.store.recordGroupAlias(gid, numeric, now); } catch (e) { note("group alias", e); }
  }
  try {
    await mutate(x, c.id, (cur) => {
      const seen = new Set();
      const groups = (cur.groups || []).map((g) => {
        if (g.group_id !== gid && !(numeric && g.group_id === id)) return g;
        const aliases = [...new Set([...aliasesOf(g), ...(numeric ? [gid] : [])])].filter((a) => a !== id);
        return { ...g, group_id: id, ...(aliases.length ? { aliases } : {}), ...(left ? { is_member: false } : {}) };
      }).filter((g) => !seen.has(g.group_id) && seen.add(g.group_id));
      return numeric ? { groups, posts: cur.posts.map((p) => (p.group_id === gid ? { ...p, group_id: id } : p)) } : { groups };
    });
  } catch (e) { note("campaign group update", e); }
}

// Cancels that could not be written (cancel_incomplete, a failed transition)
// are counted here and drained by the sweep into settings/posting_health.
let cancelFailures = 0;
const noteCancelFailure = (n = 1) => { cancelFailures += n; };
const drainCancelFailures = () => { const n = cancelFailures; cancelFailures = 0; return n; };

module.exports = {
  noteCancelFailure, drainCancelFailures, mutate, say, tellOperator,
  MS_MIN, MS_HOUR, MS_DAY, ACTIVE_PAGE, OPEN_POST, POST_STATUS_OF, ELIGIBILITY,
  iso, tail, fail, ms, ctxOf, nowOf, guardDeps, configOf,
  groupIdFromUrl, catalogIndex, catalogEntriesFor, policyDisallowed, typeExcluded, isHidden, DISALLOWED_POLICY,
  memberOf, groupIdsOf, applyFindings, eligibility, isEligible, needsMembershipCheck,
  pageTarget, pageTargetAvailable, numericPageId, targetsFor, accountView, currentPosts, limitsFor, nextDayStart,
};
