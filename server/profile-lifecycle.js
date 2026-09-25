/*
 * profile-lifecycle.js — one profile, one account, one platform, and a way out.
 *
 * A persisted Driver profile holds the agent's authentication cookies,
 * remembered-device state and browser storage for that platform. The profile
 * lock (profile-lock.js) prevents concurrent use; it says nothing about who
 * may open the profile, how it ends, or what happens when it is suspected
 * compromised. This file does, for Facebook, Yad2 and Madlan alike.
 *
 * Nothing about a profile is stored in Forly except its state and
 * timestamps — the cookies live only at Driver, and revoke()/quarantine()
 * ask Driver to delete them at once.
 */
const { profileName } = require("./profile-name");

const HALT_CLASSES = new Set(["captcha", "checkpoint", "restricted", "suspected_compromise"]);

const nowIso = () => new Date().toISOString();

// What the agent should still do BY HAND at the platform — Forly revokes its
// own access, but cannot force a remote sign-out everywhere else the account
// is logged in.
const AGENT_ADVICE = { facebook: "כדאי גם לצאת מכל ההתקנים בהגדרות פייסבוק" };

async function stopOpenSession(platform, conn, deps) {
  const open = conn[`browser_session_${platform}`];
  if (open && open.session_id) await deps.driver.stopSession(open.session_id);
}

// Deletes the profile at Driver. Never throws — returns { ok: true, patch }
// with `<platform>_profile_deleted_at` set, or { ok: false, error, patch }
// with `<platform>_profile_delete_error` set, so the caller can persist the
// connection patch AND decide whether to file/clear a profile_deletes row.
async function deleteAndRecord(phone, platform, conn, deps) {
  const name = profileName(platform, phone, conn[`${platform}_profile_gen`] || 0);
  try {
    const r = await deps.driver.deleteProfile(name);
    if (r && r.ok === false) throw new Error(r.error || "delete failed");
    return { ok: true, patch: { [`${platform}_profile_deleted_at`]: nowIso(), [`${platform}_profile_delete_error`]: null } };
  } catch (e) {
    const error = e.message || String(e);
    return { ok: false, error, patch: { [`${platform}_profile_delete_error`]: error } };
  }
}

// Runs a delete attempt and files/clears the pending-delete row that
// retryDeletes() later drains. `since`/`attempts` carry over an existing
// retry's own history when passed in; a first attempt (revoke/quarantine)
// omits them and starts a fresh row.
async function attemptDelete(phone, platform, conn, deps, { since, attempts = 0 } = {}) {
  const del = await deleteAndRecord(phone, platform, conn, deps);
  await deps.db.setConnection(phone, del.patch);
  if (del.ok) await deps.db.clearPendingDelete(phone, platform);
  else await deps.db.savePendingDelete({ phone, platform, since: since || nowIso(), attempts: attempts + 1, last_error: del.error });
  return del;
}

// Stops the platform's open session, cancels the phone's open posting
// attempts for that platform, marks the profile revoked (assertOwnership
// refuses it from this point on, whatever name is passed), deletes it at
// Driver, and — for Facebook — clears the Pages/groups/posting state that
// only made sense while the account was connected.
async function revoke({ phone, platform, reason }, deps) {
  const conn = (await deps.db.getConnection(phone)) || {};
  await stopOpenSession(platform, conn, deps);
  await deps.db.cancelOpenAttempts(phone, platform);

  const statePatch = Object.assign(
    {
      [`${platform}_profile_state`]: "revoked",
      [`${platform}_profile_revoked_at`]: nowIso(),
      [`${platform}_profile_revoke_reason`]: reason || null,
      [`${platform}_browser_connected_at`]: null,
      [`browser_session_${platform}`]: null,
    },
    platform === "facebook" ? { facebook_pages: null, facebook_groups_member: null, posting_permission: null } : {},
  );
  // Two setConnection writes, deliberately not merged into one: the state
  // write lands FIRST so the profile is refused (assertOwnership) at once,
  // before the Driver delete even runs; the pending-delete row that
  // attemptDelete() files on failure makes a crash between the two writes
  // recoverable — retryDeletes() will still find and finish the delete.
  await deps.db.setConnection(phone, statePatch);
  Object.assign(conn, statePatch);

  await attemptDelete(phone, platform, conn, deps);

  return { advice: AGENT_ADVICE[platform] || null };
}

// A platform-side halt (captcha, checkpoint, restricted, suspected
// compromise): the profile is quarantined — assertOwnership refuses it —
// and deleted at Driver like a revoke. Reconnecting after quarantine is a
// separate, not-yet-built flow that bumps `<platform>_profile_gen` so the
// new profile gets a fresh name (profileName's `-r<n>` suffix); this
// function does not do that bump itself.
async function quarantine(phone, platform, cls, deps) {
  if (!HALT_CLASSES.has(cls)) { const e = new Error(`unknown halt class: ${cls}`); e.code = "invalid_input"; throw e; }
  const conn = (await deps.db.getConnection(phone)) || {};
  await stopOpenSession(platform, conn, deps);
  await deps.db.cancelOpenAttempts(phone, platform);

  const statePatch = {
    [`${platform}_profile_state`]: "quarantined",
    [`${platform}_profile_quarantined_at`]: nowIso(),
    [`${platform}_profile_quarantine_class`]: cls,
    [`${platform}_browser_connected_at`]: null,
    [`browser_session_${platform}`]: null,
  };
  // Same intentional split as revoke(): the state write lands first so the
  // profile is refused at once, and the pending-delete row attemptDelete()
  // files on failure makes a crash between the two writes recoverable.
  await deps.db.setConnection(phone, statePatch);
  Object.assign(conn, statePatch);

  await attemptDelete(phone, platform, conn, deps);
}

// Called from the posting sweeper once a day. Reads its own work — every row
// in db's profile_deletes collection — retries each, and reports which ones
// have been failing for over ESCALATE_AFTER_DAYS so the caller can notify an
// operator.
const ESCALATE_AFTER_DAYS = 7;
async function retryDeletes(deps) {
  const pending = await deps.db.listPendingDeletes();
  const results = [];
  for (const row of pending || []) {
    const { phone, platform, since, attempts } = row;
    const conn = (await deps.db.getConnection(phone)) || {};
    if (!["revoked", "quarantined"].includes(conn[`${platform}_profile_state`])) continue; // reconnected past it
    if (conn[`${platform}_profile_deleted_at`]) continue; // already succeeded elsewhere
    const del = await attemptDelete(phone, platform, conn, deps, { since, attempts });
    const ageMs = since ? Date.now() - new Date(since).getTime() : 0;
    results.push({ phone, platform, ok: del.ok, escalate: !del.ok && ageMs >= ESCALATE_AFTER_DAYS * 24 * 60 * 60 * 1000 });
  }
  return results;
}

module.exports = { revoke, quarantine, retryDeletes, HALT_CLASSES, ESCALATE_AFTER_DAYS };
