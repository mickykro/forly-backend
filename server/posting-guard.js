/*
 * posting-guard.js — the one question every browser action asks right before
 * it acts: am I still allowed? Called before reserving work, before opening a
 * session, before navigating, and IMMEDIATELY before any externally visible
 * action (post, like, story), and before any retry. Reads current state every
 * time; nothing is cached, because the whole point is to see a switch that was
 * flipped a second ago.
 */
const dbLive = require("./db");
const { SIGNAL_PENALISES } = require("./posting-signals");

const DAY_MS = 86400000;

const VISIBLE_ACTIONS = new Set(["like", "story"]);
const PERMISSIONED_ACTIONS = new Set(["post", "like", "story", "reserve"]);

function deny(reason) {
  const e = new Error(`posting not allowed: ${reason}`);
  e.code = "posting_disabled";
  e.reason = reason;
  throw e;
}

// Which environment may run automated posting at all (C1): staging shares
// production's Firestore and GreenAPI, so it never may. Production does; a
// local box only with POSTING_SWEEPER=1. index.js starts the sweeper on it,
// and the mutating /api/posting and /api/admin/posting routes answer 503
// posting_unavailable_in_env without it. Pure.
function postingEnvAllowed(env = {}) {
  if (!env || env.FORLY_ENV === "staging") return false;
  return env.FORLY_ENV === "prod" || env.POSTING_SWEEPER === "1";
}

// The fleet-level half: the env switch, the global switch and the platform
// switch — no account involved. The sweeper asks this before anything else
// (after reaping); assertAllowed() asks it first, in the same order.
// Off unless switched on (I5): the env must say POSTING_ENABLED=1, and the
// settings/posting doc must exist with enabled === true — a missing doc, or
// any other value, is global_off. → the settings/posting doc.
async function assertFleetAllowed({ platform } = {}, deps = {}) {
  const db = deps.db || dbLive;
  const env = deps.env || process.env;

  if (env.POSTING_ENABLED !== "1") deny("env_off");

  const settings = await db.getSetting("posting");
  if (!settings || settings.enabled !== true) deny("global_off");
  if (platform && settings.platforms && settings.platforms[platform] === false) deny("platform_off");
  return settings;
}

// action ∈ "reserve" | "session" | "navigate" | "post" | "like" | "story" | "dwell" | "retry"
async function assertAllowed({ phone, platform, action }, deps = {}) {
  const db = deps.db || dbLive;

  const settings = await assertFleetAllowed({ platform }, deps);
  if (VISIBLE_ACTIONS.has(action) && settings.visible_interactions_enabled === false) deny("visible_off");

  const nowMs = deps.now instanceof Date ? deps.now.getTime() : Date.now();
  const conn = (await db.getConnection(phone)) || {};
  // An owner-level review (R5: a second disabling halt in 30 days) is a
  // disabled account too, whatever the standard re-enable flag says.
  if (conn.posting_disabled_until_admin === true || conn.posting_owner_review_required === true) deny("account_disabled");
  // R5: a penalty halves the caps (posting-safety); it stops posting only on
  // day one — while the newest penalising halt is under 24 h old.
  if (action === "post" && conn.posting_penalty_until && new Date(conn.posting_penalty_until).getTime() > nowMs) {
    const lastPenalising = Math.max(0, ...(conn.posting_halts || []).filter((h) => h && SIGNAL_PENALISES.has(h.code)).map((h) => new Date(h.at).getTime()).filter(Number.isFinite));
    if (nowMs - lastPenalising < DAY_MS) deny("account_penalty");
  }
  if (["revoked", "quarantined"].includes(conn[`${platform}_profile_state`])) deny("profile_revoked");

  if (PERMISSIONED_ACTIONS.has(action)) {
    const perm = conn.posting_permission;
    if (!perm || perm.enabled !== true) deny("no_permission");
    if (!Array.isArray(perm.platforms) || !perm.platforms.includes(platform)) deny("permission_scope");
    if (VISIBLE_ACTIONS.has(action) && perm.allows_visible_interactions !== true) deny("visible_not_allowed");
  }

  return true;
}

module.exports = { assertAllowed, assertFleetAllowed, postingEnvAllowed };
