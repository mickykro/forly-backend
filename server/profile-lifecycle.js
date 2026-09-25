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

// Deletes the named Driver profile. Never throws — returns { ok: true } or
// { ok: false, error }. Pure: no db access, no opinion on what a caller
// should do with the result — see attemptDelete for that.
async function deleteDriverProfile(name, deps) {
  try {
    const r = await deps.driver.deleteProfile(name);
    if (r && r.ok === false) throw new Error(r.error || "delete failed");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Runs a delete attempt for `opts.gen` (default: the connection's CURRENT
// gen) and files/clears the pending-delete row that retryDeletes() later
// drains. `since`/`attempts` carry over an existing retry's own history when
// passed in; a first attempt (revoke/quarantine) omits them and starts a
// fresh row.
//
// `staleGen` (gen !== the connection's current gen): true only when
// retryDeletes() is finishing off an OLD generation's delete after a
// reconnect already moved the connection on to a new one. In that case the
// connection's own `<platform>_profile_deleted_at` / `_delete_error` must
// NOT be touched — those fields describe the live (new-generation) profile,
// which this delete has nothing to do with. Only the pending-delete row
// itself (keyed by phone+platform, carrying its own gen) is updated.
async function attemptDelete(phone, platform, conn, deps, opts = {}) {
  const { since, attempts = 0 } = opts;
  const currentGen = conn[`${platform}_profile_gen`] || 0;
  const gen = opts.gen !== undefined ? opts.gen : currentGen;
  const staleGen = gen !== currentGen;
  const name = profileName(platform, phone, gen);
  const del = await deleteDriverProfile(name, deps);

  if (del.ok) {
    if (!staleGen) await deps.db.setConnection(phone, { [`${platform}_profile_deleted_at`]: nowIso(), [`${platform}_profile_delete_error`]: null });
    await deps.db.clearPendingDelete(phone, platform);
  } else {
    if (!staleGen) await deps.db.setConnection(phone, { [`${platform}_profile_delete_error`]: del.error });
    await deps.db.savePendingDelete({ phone, platform, since: since || nowIso(), attempts: attempts + 1, last_error: del.error, gen });
  }
  return { ok: del.ok, error: del.error, gen, staleGen };
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
      [`${platform}_browser_disconnected_at`]: nowIso(),
      [`${platform}_identity_label`]: null, // the account holder's display name must not outlive their consent
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
    [`${platform}_identity_label`]: null, // the next connect re-reads this; must not carry the halted profile's identity
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

    // A legacy row (saved before per-generation tracking existed, so it has
    // no `gen`) keeps the old behaviour: it always refers to whatever the
    // connection's CURRENT generation is, so it is safe to skip once that
    // connection has moved past revoked/quarantined (reconnected) or already
    // shows a successful delete.
    if (row.gen === undefined) {
      if (!["revoked", "quarantined"].includes(conn[`${platform}_profile_state`])) continue; // reconnected past it
      if (conn[`${platform}_profile_deleted_at`]) continue; // already succeeded elsewhere
      const del = await attemptDelete(phone, platform, conn, deps, { since, attempts });
      const ageMs = since ? Date.now() - new Date(since).getTime() : 0;
      results.push({ phone, platform, ok: del.ok, staleGen: del.staleGen, escalate: !del.ok && ageMs >= ESCALATE_AFTER_DAYS * 24 * 60 * 60 * 1000 });
      continue;
    }

    // A gen-tracked row is retried for THAT generation's profile no matter
    // what the connection looks like now — reconnecting after a failed
    // delete must not orphan the old generation's cookies at Driver, and
    // must not let this retry touch the NEW generation's deleted_at/error
    // (attemptDelete's staleGen check handles that half).
    const del = await attemptDelete(phone, platform, conn, deps, { since, attempts, gen: row.gen });
    const ageMs = since ? Date.now() - new Date(since).getTime() : 0;
    results.push({ phone, platform, ok: del.ok, staleGen: del.staleGen, escalate: !del.ok && ageMs >= ESCALATE_AFTER_DAYS * 24 * 60 * 60 * 1000 });
  }
  return results;
}

module.exports = { revoke, quarantine, retryDeletes, HALT_CLASSES, ESCALATE_AFTER_DAYS };
