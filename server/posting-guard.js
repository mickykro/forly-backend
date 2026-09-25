/*
 * posting-guard.js — the one question every browser action asks right before
 * it acts: am I still allowed? Called before reserving work, before opening a
 * session, before navigating, and IMMEDIATELY before any externally visible
 * action (post, like, story), and before any retry. Reads current state every
 * time; nothing is cached, because the whole point is to see a switch that was
 * flipped a second ago.
 */
const dbLive = require("./db");

const VISIBLE_ACTIONS = new Set(["like", "story"]);
const PERMISSIONED_ACTIONS = new Set(["post", "like", "story", "reserve"]);

function deny(reason) {
  const e = new Error(`posting not allowed: ${reason}`);
  e.code = "posting_disabled";
  e.reason = reason;
  throw e;
}

// action ∈ "reserve" | "session" | "navigate" | "post" | "like" | "story" | "dwell" | "retry"
async function assertAllowed({ phone, platform, action }, deps = {}) {
  const db = deps.db || dbLive;
  const env = deps.env || process.env;

  if (env.POSTING_ENABLED === "0") deny("env_off");

  const settings = await db.getSetting("posting");
  if (settings) {
    if (settings.enabled === false) deny("global_off");
    if (settings.platforms && settings.platforms[platform] === false) deny("platform_off");
    if (VISIBLE_ACTIONS.has(action) && settings.visible_interactions_enabled === false) deny("visible_off");
  }

  const conn = (await db.getConnection(phone)) || {};
  if (conn.posting_disabled_until_admin === true) deny("account_disabled");
  if (action === "post" && conn.posting_penalty_until && new Date(conn.posting_penalty_until).getTime() > Date.now()) {
    deny("account_penalty");
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

module.exports = { assertAllowed };
