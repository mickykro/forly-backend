/*
 * routes/posting-shared.js — what routes/posting.js and routes/posting-settings.js
 * share: the consent version, the public view of a campaign, the signed
 * one-tap link, the kill-switch check, and the membership / Page helpers.
 *
 * Nothing here logs. Nothing here returns a member group's URL, a cdpUrl, a
 * viewer URL or a profile name; a group name leaves the server only when
 * Task 14 kept it in the clear (otherwise "קבוצה פרטית").
 */
const crypto = require("crypto");
const { signActionToken, verifyActionToken } = require("../auth");
const A = require("../posting-account");
const { escapeHtml: esc } = require("../utils");

// The version of the consent text the card (Task 23) shows. Stored on the
// permission and on every campaign; bump it when the text changes.
const CONSENT_VERSION = "2026-09-v1";
const PRIVATE_NAME = "קבוצה פרטית";
const PAGE_NAME = "הדף העסקי";
const ACTIONS = new Set(["approve", "skip", "stop"]);
const ACT_TTL_S = 72 * 3600; // a one-tap link works for 72 hours
const TARGETS = ["page", "groups"];
const MAX_GROUP_IDS = 20; // share-kit MAX_GROUPS: a campaign keeps at most 20 groups
// A Task 14 group id: numeric, or "slug:<vanity>" until the driver resolves it.
const GROUP_ID_RE = /^(?:\d{1,30}|slug:[^\s/|?#:]{1,120})$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SECRET_RE = /wss?:\/\/|viewer\.driver\.dev/i;

// ── the public view of a campaign ──
const CAMPAIGN_FIELDS = ["id", "page_id", "mode", "repeat", "status", "pause_reason", "wait_reason", "expires_at",
  "consent_at", "consent_version", "targets", "restarted_at", "created_at", "updated_at"];
const GROUP_FIELDS = ["group_id", "agent_policy", "is_member", "catalog_policy", "listing_type_allowed", "posting_currently_available"];
const POST_FIELDS = ["id", "target", "group_id", "status", "scheduled_at", "approved_at", "posted_at", "error_code"];

// Task 22: per-post metrics (posting-metrics.forCampaign) — counts, a
// visibility state and a time; never an attempt key, a click id or a person.
const METRIC_FIELDS = ["visits", "leads", "reactions", "comments", "visibility", "checked_at"];

const pick = (o, keys) => { const out = {}; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; };

// Drops every string that could carry a live browser: a cdpUrl or a viewer URL.
function scrub(v) {
  if (typeof v === "string") return SECRET_RE.test(v) ? null : v;
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") { const out = {}; for (const [k, x] of Object.entries(v)) out[k] = scrub(x); return out; }
  return v;
}

// A whitelist, not a blacklist: page_snapshot, copy_hash, attempt_key, click
// ids and anything else the store carries never reach the card.
// opts.metrics: forCampaign's map, kept only for this campaign's own posts.
function publicView(c, opts) {
  if (!c || typeof c !== "object") return null;
  const out = pick(c, CAMPAIGN_FIELDS);
  out.groups = (Array.isArray(c.groups) ? c.groups : []).filter(Boolean)
    .map((g) => Object.assign(pick(g, GROUP_FIELDS), { name: g.name || PRIVATE_NAME, private: !g.name }));
  out.posts = (Array.isArray(c.posts) ? c.posts : []).filter(Boolean).map((p) => {
    const q = pick(p, POST_FIELDS);
    q.group_name = p.group_name || (p.target === "page" ? PAGE_NAME : PRIVATE_NAME);
    if (p.status === "posted" && p.post_url) q.post_url = p.post_url;
    // per_post: the agent approves the exact text, so it is shown while pending.
    if (p.status === "pending_approval" && typeof p.copy === "string") q.copy = p.copy;
    return q;
  });
  const metrics = opts && typeof opts === "object" && opts.metrics && typeof opts.metrics === "object" ? opts.metrics : null;
  if (metrics) {
    out.metrics = {};
    for (const p of out.posts) if (p.id && metrics[p.id] && typeof metrics[p.id] === "object") out.metrics[p.id] = pick(metrics[p.id], METRIC_FIELDS);
  }
  return scrub(out);
}

// ── the signed one-tap link (Task 20 sends it, GET /act handles it) ──
// auth.signActionToken has no expiry of its own: the expiry is one of the
// signed parts, so it cannot be changed without breaking the signature.
function actionLink({ campaignId, postId, action, now } = {}, { authSecret, pageBaseUrl } = {}) {
  if (!ACTIONS.has(action)) throw Object.assign(new Error("unknown action"), { code: "invalid_input" });
  if (!authSecret) throw Object.assign(new Error("authSecret required"), { code: "invalid_input" });
  const c = String(campaignId || ""), p = postId ? String(postId) : "";
  if (!ID_RE.test(c) || (p && !ID_RE.test(p))) throw Object.assign(new Error("bad id"), { code: "invalid_input" });
  const t0 = now === undefined ? Date.now() : A.ms(now);
  const e = String(Math.floor(t0 / 1000) + ACT_TTL_S);
  const t = signActionToken([c, p, action, e], authSecret);
  const q = new URLSearchParams({ c, p, a: action, e, t });
  return `${String(pageBaseUrl || "").replace(/\/+$/, "")}/api/posting/act?${q}`;
}

// → { c, p, a } when the link is genuine and unexpired; { error: "invalid" | "expired" } otherwise.
function readActionLink(q, authSecret, nowMs) {
  const s = (k) => (typeof q[k] === "string" ? q[k] : "");
  const c = s("c"), p = s("p"), a = s("a"), e = s("e"), t = s("t");
  if (!ID_RE.test(c) || (p && !ID_RE.test(p)) || !ACTIONS.has(a) || !/^\d{1,12}$/.test(e) || !t || t.length > 128) return { error: "invalid" };
  if (!authSecret || !verifyActionToken([c, p, a, e], t, authSecret)) return { error: "invalid" };
  if (Number(e) * 1000 <= nowMs) return { error: "expired" };
  return { c, p, a };
}

const card = (title, body, extraHtml = "") => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
  `<title>${esc(title)}</title></head><body style="font-family:Heebo,-apple-system,'Segoe UI',sans-serif;` +
  `background:#F7F3EC;color:#17140F;padding:24px;max-width:480px;margin:auto;text-align:center">` +
  `<h2>${esc(title)}</h2><p style="line-height:1.7;color:#5A5348">${esc(body)}</p>${extraHtml}</body></html>`;

// ── the kill switch (R2) ──
// → true when allowed; otherwise answers 409 and → false. `tolerate` lists
// the denial reasons this call itself cures (granting the permission).
async function allowed(S, phone, res, tolerate = []) {
  try {
    await S.guard.assertAllowed({ phone, platform: "facebook", action: "reserve" }, { db: S.db, env: S.deps.env || process.env });
    return true;
  } catch (e) {
    if (!e || e.code !== "posting_disabled") throw e;
    if (tolerate.includes(e.reason)) return true;
    res.status(409).json({ error: "posting_disabled", reason: e.reason });
    return false;
  }
}

// ── membership (Task 14 entries, keyed by group_id with aliases) ──
// A group the agent removed (facebook_groups_hidden) is never a member here,
// whatever a sync or an older write left in the list.
const hiddenIds = (conn) => require("../facebook-groups-sync").hiddenIds(conn);
const idsOf = (m) => [m.group_id, ...(Array.isArray(m.aliases) ? m.aliases : [])].map(String);
function memberList(conn) {
  const hidden = hiddenIds(conn);
  const list = Array.isArray(conn && conn.facebook_groups_member) ? conn.facebook_groups_member : [];
  return list.filter((m) => m && m.group_id && !idsOf(m).some((id) => hidden.has(id)));
}
const findMember = (conn, id) => A.memberOf(conn, { group_id: String(id) });
const isMember = (m) => !!m && m.membership_state === "member";
const memberUrl = (m) => m.canonical_url || m.url || `https://www.facebook.com/groups/${String(m.group_id).replace(/^slug:/, "")}`;

// A list of ids from a request body → { ids } (validated strings) or { error }.
function parseGroupIds(v, { required = false } = {}) {
  if (v === undefined || v === null) return required ? { error: "invalid_input" } : { ids: [] };
  if (!Array.isArray(v) || v.length > MAX_GROUP_IDS) return { error: "invalid_input" };
  const ids = v.map((x) => (typeof x === "number" && Number.isSafeInteger(x) ? String(x) : x));
  if (!ids.every((x) => typeof x === "string" && GROUP_ID_RE.test(x))) return { error: "invalid_input" };
  return { ids };
}

// The member gate: every id must be a group this account is a member of now.
// → { entries } (canonical entries, one per group) or { notMember: [ids as sent] }.
function memberGate(conn, ids) {
  const entries = [], notMember = [], seen = new Set();
  const hidden = hiddenIds(conn);
  for (const id of ids) {
    const m = findMember(conn, id);
    if (!isMember(m) || hidden.has(id) || idsOf(m).some((x) => hidden.has(x))) { notMember.push(id); continue; }
    if (seen.has(m.group_id)) continue;
    seen.add(m.group_id);
    entries.push(m);
  }
  return notMember.length ? { notMember } : { entries };
}

// The catalog entries for a membership entry — posting-account's helper, so
// the route and the planner match a group to the catalog the same way: by
// every id and alias (numeric, or the "slug:" id a vanity catalog URL maps
// to), then by canonical URL. lookup(m) → the first entry or null;
// lookup.all(m) → every matching entry.
function catalogLookup(list) {
  const all = (m) => A.catalogEntriesFor(list, { group_id: m.group_id, aliases: m.aliases, url: m.canonical_url || m.url }, null);
  const lookup = (m) => all(m)[0] || null;
  lookup.all = all;
  return lookup;
}

// What the card may show of a membership entry: never its URL; its name only
// when Task 14 kept it.
function publicMember(m, cat, defaults) {
  return {
    group_id: m.group_id, name: m.name || PRIVATE_NAME, private: !m.name, membership_state: m.membership_state || null,
    in_catalog: !!cat, agent_policy: (cat && cat.agent_policy) || "unknown", is_default: idsOf(m).some((id) => defaults.has(id)),
  };
}

// ── the agent's Facebook Pages (a Page is a campaign target only with its numeric id, I4) ──
const pagesOf = (conn) => (Array.isArray(conn && conn.facebook_pages) ? conn.facebook_pages.filter((p) => p && p.url) : []);
// The card's handle for a Page: its id, or a hash of its URL (no URL leaves).
const pageKey = (p) => (p.id ? String(p.id) : `u:${crypto.createHash("sha256").update(String(p.url)).digest("hex").slice(0, 16)}`);
// posting_permission.page_id holds what posting-account.pageTarget() matches: id, else URL.
const storedPageId = (p) => String(p.id || p.url);
const pageByStored = (conn, pid) => (pid ? pagesOf(conn).find((p) => p.id === pid || p.url === pid) || null : null);
const pageByKey = (conn, key) => pagesOf(conn).find((p) => pageKey(p) === key) || null;
// R3: with several Pages, a Page post needs the agent's confirmed choice.
function pageConfirmed(conn, pid = (conn.posting_permission || {}).page_id) {
  const pages = pagesOf(conn);
  return pages.length <= 1 || !!pageByStored(conn, pid);
}
function parseTargets(v) {
  if (v === undefined || v === null) return { targets: null };
  if (!Array.isArray(v) || !v.length || !v.every((t) => TARGETS.includes(t))) return { error: "invalid_input" };
  return { targets: TARGETS.filter((t) => v.includes(t)) };
}

// ── the account's halt state, as posting-campaign.resume() reads it ──
function needsReconnect(conn) {
  return conn.facebook_needs_reconnect === true && !(A.ms(conn.facebook_browser_connected_at) > A.ms(conn.facebook_needs_reconnect_at));
}
function haltState(conn, now) {
  return {
    disabled_until_admin: conn.posting_disabled_until_admin === true,
    owner_review_required: conn.posting_owner_review_required === true,
    penalty_until: A.ms(conn.posting_penalty_until) > now.getTime() ? A.iso(conn.posting_penalty_until) : null,
    needs_reconnect: needsReconnect(conn),
  };
}

function publicPermission(conn) {
  const p = conn.posting_permission;
  if (!p || typeof p !== "object") return { enabled: false, consent_current: false };
  const page = pageByStored(conn, p.page_id);
  return {
    enabled: p.enabled === true, consent_version: p.consent_version || null, consent_current: p.consent_version === CONSENT_VERSION,
    granted_at: p.granted_at || null, targets: Array.isArray(p.targets) ? p.targets : [],
    default_group_ids: Array.isArray(p.default_group_ids) ? p.default_group_ids : [],
    page_id: page ? pageKey(page) : null, auto_mode: p.auto_mode === "per_post" ? "per_post" : "standing",
    allows_visible_interactions: p.allows_visible_interactions === true,
  };
}

// Express 4 does not catch a rejected handler: answer 500 with a code, log no data.
const wrap = (name, fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  const { redact } = require("../driver-browser");
  console.error(redact(`posting route ${name}: ${(e && (e.code || e.name)) || "error"}`));
  if (!res.headersSent) res.status(500).json({ error: "internal" });
});

module.exports = {
  CONSENT_VERSION, PRIVATE_NAME, ACTIONS, ACT_TTL_S, TARGETS, MAX_GROUP_IDS, GROUP_ID_RE, ID_RE,
  publicView, scrub, actionLink, readActionLink, card, allowed,
  hiddenIds, memberList, findMember, isMember, memberUrl, idsOf, parseGroupIds, memberGate, catalogLookup, publicMember,
  pagesOf, pageKey, storedPageId, pageByStored, pageByKey, pageConfirmed, parseTargets,
  needsReconnect, haltState, publicPermission, wrap,
};
