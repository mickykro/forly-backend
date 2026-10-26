/*
 * posting-live.js — the automatic posting sessions open right now, for the
 * admin's live panel (routes/admin-posting-live.js). In memory, per process,
 * like the browsers themselves: one entry per account while its posting
 * browser is open (posting-driver.run).
 *
 * The admin's three levers, read by the driver and the chain:
 *   hold      finish the post in hand, then end the session (posting-chain)
 *   skip      the post in hand is dropped at its next guard — never after
 *             the click (the guard is the last await before it)
 *   takeover  the automation stops at its next guard; the browser stays open
 *             for the admin until they release it (done / skipped / timeout)
 */
const live = new Map(); // phone → entry
const TAKEOVER_MAX_MS = 30 * 60000;
const STEPS = new Set(["session_started", "composer_ready", "submit_started", "verification_pending", "verified_posted", "submitted_for_approval", "verified_failed", "outcome_unknown", "cancelled"]);

function open(phone, sessionId, now = Date.now()) {
  const e = { phone, sessionId, started_at: new Date(now).toISOString(), posts: 0, attempt_key: null, campaign_id: null, target_url: null, step: null,
    hold: false, skip: null, takeover: null };
  live.set(phone, e);
  return e;
}
function close(phone, e) {
  if (live.get(phone) !== e) return;
  if (e.takeover && e.takeover.release) e.takeover.release("closed");
  live.delete(phone);
}
const get = (phone) => live.get(phone) || null;

// The driver's progress on the post in hand (posting-driver context.step).
function step(phone, attempt, to) {
  const e = live.get(phone);
  if (!e || !attempt || !STEPS.has(to)) return;
  if (e.attempt_key !== attempt.key) { e.attempt_key = attempt.key; e.posts++; e.skip = null; }
  Object.assign(e, { campaign_id: attempt.campaign_id || null, target_url: attempt.target_url || null, step: to });
}

// → the admin's stop for this attempt ("admin_skipped" | "admin_takeover") or null.
function denial(phone, attemptKey) {
  const e = live.get(phone);
  if (!e) return null;
  if (e.takeover) return "admin_takeover";
  if (e.skip && e.skip === attemptKey) return "admin_skipped";
  return null;
}
// No next post in this session (posting-chain session.more).
const held = (phone) => { const e = live.get(phone); return !!(e && (e.hold || e.takeover)); };

function hold(phone) { const e = live.get(phone); if (!e) return null; e.hold = true; return e; }
function skip(phone) { const e = live.get(phone); if (!e || !e.attempt_key) return null; e.skip = e.attempt_key; return e; }
function takeover(phone) {
  const e = live.get(phone);
  if (!e) return null;
  if (!e.takeover) {
    let release;
    const done = new Promise((r) => { release = r; });
    e.takeover = { at: new Date().toISOString(), attempt_key: e.attempt_key, release, done, stopped: false };
  }
  return e;
}
// The driver has stopped and waits for the admin: → the release reason.
// renew() keeps the account's profile lock while the admin works (posting-tick).
function awaitRelease(phone, e, maxMs = TAKEOVER_MAX_MS, renew = null) {
  if (live.get(phone) !== e || !e.takeover) return Promise.resolve(null);
  e.takeover.stopped = true;
  let timer;
  const keep = renew ? setInterval(() => { try { renew(); } catch { /* the lock's own expiry is the backstop */ } }, 60000) : null;
  if (keep && keep.unref) keep.unref();
  const late = new Promise((r) => { timer = setTimeout(() => r("timeout"), maxMs || TAKEOVER_MAX_MS); if (timer.unref) timer.unref(); });
  return Promise.race([e.takeover.done, late]).finally(() => { clearTimeout(timer); clearInterval(keep); });
}
function release(phone, why) { const e = live.get(phone); if (!e || !e.takeover) return null; e.takeover.release(why); return e; }

const view = (e, refOf) => ({
  ref: refOf(e.phone), phone_tail: String(e.phone).replace(/\D/g, "").slice(-4), started_at: e.started_at, posts: e.posts,
  campaign_tail: e.campaign_id ? String(e.campaign_id).slice(-6) : null, campaign_id: e.campaign_id, target_url: e.target_url, step: e.step,
  state: e.takeover ? (e.takeover.stopped ? "taken" : "taking") : e.skip ? "skipping" : e.hold ? "holding" : "running",
});
const list = (refOf) => [...live.values()].map((e) => view(e, refOf));

module.exports = { open, close, get, step, denial, held, hold, skip, takeover, awaitRelease, release, list, view, TAKEOVER_MAX_MS, _live: live };
