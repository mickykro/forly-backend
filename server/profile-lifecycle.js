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
const locksLive = require("./profile-lock");

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

// Cancels the phone's open posting attempts for the platform. Called AFTER
// the revoked/quarantined state write, so assertOwnership already refuses the
// profile. A failure is recorded as `<platform>_cancel_error`, never thrown:
// revoke/quarantine must still finish, and the posting reaper cancels any
// pre-submit attempt anyway when its 20-minute lease runs out.
async function cancelAttempts(phone, platform, conn, deps) {
  try {
    await deps.db.cancelOpenAttempts(phone, platform);
  } catch (e) {
    const patch = { [`${platform}_cancel_error`]: String((e && (e.code || e.message)) || "cancel_failed").slice(0, 200) };
    try { await deps.db.setConnection(phone, patch); Object.assign(conn, patch); } catch { /* the reaper is the backstop */ }
  }
}

// What is stored about a failed delete: a code, never the vendor's text —
// the Driver status class (driver_4xx / driver_5xx) when there is one, else
// delete_failed.
const errorCode = (status) => (Number.isInteger(status) && status >= 400 && status < 600 ? `driver_${Math.floor(status / 100)}xx` : "delete_failed");

// Deletes the named Driver profile. Never throws — returns { ok: true } or
// { ok: false, error: <code> }. Pure: no db access, no opinion on what a
// caller should do with the result — see attemptDelete for that.
async function deleteDriverProfile(name, deps) {
  try {
    const r = await deps.driver.deleteProfile(name);
    if (r && r.ok === false) return { ok: false, error: errorCode(r.status) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorCode(e && e.status) };
  }
}

// A delete filed because the profile was in use (I9): the sweeper retries
// those at its next sweep instead of waiting for the daily run.
let deferred = false;
const hasDeferredDeletes = () => deferred;
const BUSY = "profile_busy";

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
// itself (keyed by phone+platform+gen) is updated.
//
// `opts.legacy`: set only by retryDeletes() for a row that predates
// per-generation tracking (no `gen` field, saved under the bare
// `${platform}:${phone}` key). Its save/clear stays under that SAME bare
// key — "exactly as today" — rather than migrating it into the new
// `${platform}:${phone}:${gen}` scheme; every other call (a fresh
// revoke/quarantine, or a gen-tracked retry) always saves/clears under the
// per-generation key, gen 0 included, so two different generations' pending
// deletes for the same phone+platform never collide.
//
// The profile lock (I9): a delete never runs under a live session. When the
// lock for (phone, platform) is held — a post, a re-check or an extract is
// in that browser right now — nothing is deleted now: the pending-delete row
// is filed (last_error profile_busy, attempts unchanged) for retryDeletes().
// When it is free, it is held for the delete.
async function attemptDelete(phone, platform, conn, deps, opts = {}) {
  const { since, attempts = 0, legacy = false } = opts;
  const currentGen = conn[`${platform}_profile_gen`] || 0;
  const gen = opts.gen !== undefined ? opts.gen : currentGen;
  const staleGen = gen !== currentGen;
  const name = profileName(platform, phone, gen);
  const rowGen = legacy ? undefined : gen;
  const release = (deps.locks || locksLive).tryAcquire(phone, platform);
  if (!release) {
    deferred = true;
    if (!staleGen) await deps.db.setConnection(phone, { [`${platform}_profile_delete_error`]: BUSY });
    await deps.db.savePendingDelete({ phone, platform, since: since || nowIso(), attempts, last_error: BUSY, gen: rowGen });
    return { ok: false, error: BUSY, gen, staleGen, deferred: true };
  }
  let del;
  try { del = await deleteDriverProfile(name, deps); } finally { release(); }

  if (del.ok) {
    if (!staleGen) await deps.db.setConnection(phone, { [`${platform}_profile_deleted_at`]: nowIso(), [`${platform}_profile_delete_error`]: null });
    await deps.db.clearPendingDelete(phone, platform, rowGen);
  } else {
    if (!staleGen) await deps.db.setConnection(phone, { [`${platform}_profile_delete_error`]: del.error });
    await deps.db.savePendingDelete({ phone, platform, since: since || nowIso(), attempts: attempts + 1, last_error: del.error, gen: rowGen });
  }
  return { ok: del.ok, error: del.error, gen, staleGen };
}

// Stops the platform's open session, marks the profile revoked
// (assertOwnership refuses it from this point on, whatever name is passed),
// then cancels the phone's open posting attempts for that platform, deletes it at
// Driver, and — for Facebook — clears the Pages/groups/posting state that
// only made sense while the account was connected.
async function revoke({ phone, platform, reason }, deps) {
  const conn = (await deps.db.getConnection(phone)) || {};
  await stopOpenSession(platform, conn, deps);

  const statePatch = Object.assign(
    {
      [`${platform}_profile_state`]: "revoked",
      [`${platform}_profile_revoked_at`]: nowIso(),
      [`${platform}_profile_revoke_reason`]: reason || null,
      [`${platform}_browser_connected_at`]: null,
      [`${platform}_browser_disconnected_at`]: nowIso(),
      [`${platform}_identity_label`]: null, // the account holder's display name must not outlive their consent
      [`browser_session_${platform}`]: null,
      [`${platform}_cancel_error`]: null,
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
  await cancelAttempts(phone, platform, conn, deps);

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

  const statePatch = {
    [`${platform}_profile_state`]: "quarantined",
    [`${platform}_profile_quarantined_at`]: nowIso(),
    [`${platform}_profile_quarantine_class`]: cls,
    [`${platform}_browser_connected_at`]: null,
    [`${platform}_identity_label`]: null, // the next connect re-reads this; must not carry the halted profile's identity
    [`browser_session_${platform}`]: null,
    [`${platform}_cancel_error`]: null,
  };
  // Same intentional split as revoke(): the state write lands first so the
  // profile is refused at once, and the pending-delete row attemptDelete()
  // files on failure makes a crash between the two writes recoverable.
  await deps.db.setConnection(phone, statePatch);
  Object.assign(conn, statePatch);
  await cancelAttempts(phone, platform, conn, deps);

  await attemptDelete(phone, platform, conn, deps);
}

// Called from the posting sweeper once a day. Reads its own work — every row
// in db's profile_deletes collection — retries each, and reports which ones
// have been failing for over ESCALATE_AFTER_DAYS so the caller can notify an
// operator.
const ESCALATE_AFTER_DAYS = 7;
// opts.onlyDeferred: just the rows filed because the profile was busy.
async function retryDeletes(deps, opts = {}) {
  const all = (await deps.db.listPendingDeletes()) || [];
  const pending = opts.onlyDeferred ? all.filter((r) => r && r.last_error === BUSY) : all;
  deferred = false; // every deferred row is tried below; one still busy files itself again
  const results = [];
  for (const row of pending) {
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
      const del = await attemptDelete(phone, platform, conn, deps, { since, attempts, legacy: true });
      const ageMs = since ? Date.now() - new Date(since).getTime() : 0;
      results.push({ phone, platform, gen: del.gen, ok: del.ok, staleGen: del.staleGen, escalate: !del.ok && ageMs >= ESCALATE_AFTER_DAYS * 24 * 60 * 60 * 1000 });
      continue;
    }

    // A gen-tracked row is retried for THAT generation's profile no matter
    // what the connection looks like now — reconnecting after a failed
    // delete must not orphan the old generation's cookies at Driver, and
    // must not let this retry touch the NEW generation's deleted_at/error
    // (attemptDelete's staleGen check handles that half).
    const del = await attemptDelete(phone, platform, conn, deps, { since, attempts, gen: row.gen });
    const ageMs = since ? Date.now() - new Date(since).getTime() : 0;
    results.push({ phone, platform, gen: del.gen, ok: del.ok, staleGen: del.staleGen, escalate: !del.ok && ageMs >= ESCALATE_AFTER_DAYS * 24 * 60 * 60 * 1000 });
  }
  return results;
}

module.exports = { revoke, quarantine, retryDeletes, hasDeferredDeletes, HALT_CLASSES, ESCALATE_AFTER_DAYS };
