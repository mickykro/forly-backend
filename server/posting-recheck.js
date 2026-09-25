/*
 * posting-recheck.js — the 24 h look at the agent's own group posts (Task 22).
 * posting-sweeper.js calls recheckOne() once per sweep.
 *
 * A group attempt that reached verified_posted / submitted_for_approval gets
 * recheck_due_at = +24 h (posting-attempts.js). Per sweep: ONE account (not
 * disabled, penalised, awaiting an owner review or a reconnect), behind its
 * profile lock and the guard's `session` check (R2), one Driver session
 * (note `forly-recheck:`, ≤ 14 min) that visits up to 3 of its due posts
 * with social-dwell.recheckPost(page, postUrl, deps) — deps carries `phone`,
 * so every navigation is guarded (R2).
 *
 * Visibility (stored on the attempt, with reactions/comments aggregates and
 * checked_at — never who reacted):
 *   visible            the post is there (final)
 *   pending_approval   the group has not approved it yet
 *   not_found          absent after a clean load, the group reachable: first sighting (first_absent_at)
 *   confirmed_removed  absent again ≥ 24 h after first_absent_at (final) → haltAccount(confirmed_removed)
 *   access_denied      the group itself is closed to the account (not a member, blocked, Join shown)
 *   session_failure    the session did not open, or a login wall / checkpoint / captcha … was shown
 *   selector_failure   the page loaded but nothing on it could be read
 *   unknown            the destination could not be proven
 * Only confirmed_removed feeds a penalty; every other state but visible adds
 * one to settings/posting_health.recheck_anomalies[state] and nothing else.
 * A non-final state is looked at again (6 h later; a first absence 24 h
 * later), at most MAX_TRIES sessions and never past a week after posting.
 */
const { redact } = require("./driver-browser");
const { profileName } = require("./profile-name");
const A = require("./posting-account");
const H = require("./posting-halts");

const { iso, tail, ms, MS_HOUR, MS_DAY } = A;
const MAX_POSTS = 3;
const SESSION_S = 10 * 60; // ≤ 14 min, and well inside profile-lock's hold
const MAX_TRIES = 3;
const RETRY_MS = 6 * MS_HOUR;
const CONFIRM_GAP_MS = 24 * MS_HOUR;
const DEFER_MS = 24 * MS_HOUR; // an account that may not be looked at now
const GIVE_UP_MS = 7 * MS_DAY;
const FINAL = new Set(["visible", "confirmed_removed"]);
const GROUP_CLOSED = new Set(["not_member", "group_blocked"]);
const code = (e) => (e && (e.code || e.name)) || "error";

// The account may not be looked at: disabled, owner review, penalised, or waiting for a reconnect.
function accountSkipped(conn, now) {
  return conn.posting_disabled_until_admin === true || conn.posting_owner_review_required === true
    || ms(conn.posting_penalty_until) > now.getTime()
    || (conn.facebook_needs_reconnect === true && !(ms(conn.facebook_browser_connected_at) > ms(conn.facebook_needs_reconnect_at)));
}

// Is the permalink under this group (any of its ids)?
function permalinkInGroup(postUrl, ids) {
  const m = String(postUrl || "").match(/^https:\/\/(?:www\.|m\.|web\.)?facebook\.com\/groups\/([^/?#]+)\//i);
  return !!m && ids.some((id) => String(id).replace(/^slug:/, "") === m[1]);
}

// In the session, after a clean "not found": is the group itself reachable?
// → accessible | access_denied | session_failure | unknown | posting_disabled
async function groupState(page, a, ids, pageDeps) {
  const P = require("./posting-driver-proof");
  try { await pageDeps.guard.assertAllowed({ phone: pageDeps.phone, platform: "facebook", action: "navigate" }, pageDeps); } // R2
  catch (e) { if (e && e.code === "posting_disabled") return "posting_disabled"; throw e; }
  if (!a.target_url) return "unknown";
  const loaded = await page.goto(a.target_url, { waitUntil: "domcontentloaded", timeout: 30000 }).then(() => true, () => false);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  if (!loaded) return "session_failure";
  const sig = await P.readSignal(page, "");
  if (GROUP_CLOSED.has(sig)) return "access_denied";
  if (sig !== "ok") return "session_failure";
  const id = await P.readTargetId(page, "group");
  if (!id || !ids.includes(id)) return "unknown";
  const join = await P.countOf(page, P.SELECTORS.joinGroup);
  return join > 0 ? "access_denied" : join < 0 ? "unknown" : "accessible";
}

// Pure: one observation → the visibility state and the first-absence time,
// or null when nothing was observed (the kill switch, or not visited).
function classify(a, obs, now) {
  const r = obs && obs.r;
  if (obs && obs.err) return { visibility: "session_failure" };
  if (!r || r.signal === "posting_disabled" || obs.g === "posting_disabled") return null;
  if (r.state === "visible") return { visibility: "visible" };
  if (r.state === "unknown") {
    if (GROUP_CLOSED.has(r.signal)) return { visibility: "access_denied" };
    if (r.signal === "pending_approval") return { visibility: "pending_approval" };
    return { visibility: r.signal && r.signal !== "ok" ? "session_failure" : "selector_failure" };
  }
  if (r.state !== "not_found") return { visibility: "unknown" };
  if (a.state === "submitted_for_approval") return { visibility: "pending_approval" }; // declined or waiting: never a removal
  if (!obs.inGroup || obs.g !== "accessible") return { visibility: obs.g === "access_denied" || obs.g === "session_failure" ? obs.g : "unknown" };
  const first = ms(a.first_absent_at);
  if (Number.isFinite(first) && now.getTime() - first >= CONFIRM_GAP_MS) return { visibility: "confirmed_removed" };
  return { visibility: "not_found", first_absent_at: Number.isFinite(first) ? a.first_absent_at : iso(now) };
}

// The attempt's patch for an observation (null → deferred, no try used).
function patchFor(a, obs, now) {
  const c = classify(a, obs, now);
  if (!c) return { recheck_due_at: iso(now.getTime() + RETRY_MS) };
  const tries = (a.recheck_tries || 0) + 1;
  const patch = Object.assign({ recheck_tries: tries, recheck_attempted_at: iso(now), checked_at: iso(now) }, c);
  const n = (v) => (Number.isInteger(v) && v >= 0 && v < 1e9 ? v : null);
  if (c.visibility === "visible") Object.assign(patch, { reactions: n(obs.r.reactions), comments: n(obs.r.comments) });
  let next = null;
  if (!FINAL.has(c.visibility) && tries < MAX_TRIES) {
    next = c.visibility === "not_found" ? ms(patch.first_absent_at) + CONFIRM_GAP_MS
      : now.getTime() + (c.visibility === "pending_approval" ? CONFIRM_GAP_MS : RETRY_MS);
  }
  patch.recheck_due_at = next === null ? null : iso(Math.max(next, now.getTime() + 60000));
  return patch;
}

async function noteAnomalies(x, counts, now) {
  if (!Object.keys(counts).length) return;
  const prev = (await x.db.getSetting("posting_health")) || {};
  const cur = Object.assign({}, prev.recheck_anomalies || {});
  for (const [k, n] of Object.entries(counts)) cur[k] = (cur[k] || 0) + n;
  await x.db.setSetting("posting_health", { recheck_anomalies: cur, recheck_last_anomaly_at: iso(now) });
}

// One session for one account's due posts → the observations.
async function visit(phone, due, conn, deps, x) {
  const withPage = deps.withPage || require("./driver-browser").withPage;
  const recheck = deps.recheckPost || require("./social-dwell").recheckPost;
  const pageDeps = { phone, platform: "facebook", conn, lockHeld: true, guard: x.guard, db: x.db, env: deps.env || process.env };
  const idsOf = new Map();
  for (const a of due) idsOf.set(a.key, await x.store.groupIdsFor(a.target_id).catch(() => [a.target_id]));
  const opts = {
    duration: SESSION_S, type: deps.browserType || process.env.POSTING_BROWSER_TYPE || "hosted",
    note: `forly-recheck:${due[0].campaign_id || "adhoc"}`,
    profile: { name: profileName("facebook", phone, conn.facebook_profile_gen || 0), persist: true },
  };
  try {
    return await withPage(opts, async (page) => {
      const out = [];
      for (const a of due) {
        const r = await recheck(page, a.post_url, pageDeps);
        const ids = idsOf.get(a.key);
        const obs = { a, r, inGroup: permalinkInGroup(a.post_url, ids) };
        if (r && r.state === "not_found" && a.state !== "submitted_for_approval" && obs.inGroup) obs.g = await groupState(page, a, ids, pageDeps);
        out.push(obs);
        // The kill switch, or a page that is not the group's (a login wall, a checkpoint…): stop here.
        if (!r || obs.g === "posting_disabled" || obs.g === "session_failure" || (r.signal && !GROUP_CLOSED.has(r.signal) && r.signal !== "pending_approval")) break;
      }
      return out;
    }, pageDeps);
  } catch (e) {
    console.error(redact(`posting recheck ${tail(phone)}: ${code(e)}`));
    return due.map((a) => ({ a, err: code(e) }));
  }
}

// → "rechecked" | "skipped" | "none". Never throws for one account's trouble.
async function recheckOne(deps = {}, now) {
  const x = A.ctxOf(deps);
  now = now || A.nowOf(deps, x);
  const due = (await x.store.listRecheckDue(now, 50)).filter((a) => a && a.key && a.phone);
  const byPhone = new Map();
  for (const a of due) {
    const stale = !a.post_url || !a.campaign_id || now.getTime() - ms(a.finished_at || a.reserved_at) > GIVE_UP_MS;
    if (stale) { await x.store.recordRecheck(a.key, { recheck_due_at: null }, now); continue; } // nothing (more) to look at
    if (!byPhone.has(a.phone)) byPhone.set(a.phone, []);
    byPhone.get(a.phone).push(a);
  }
  for (const [phone, list] of byPhone) {
    const batch = list.slice(0, MAX_POSTS);
    const defer = (d) => Promise.all(batch.map((a) => x.store.recordRecheck(a.key, { recheck_due_at: iso(now.getTime() + d) }, now)));
    const conn = (await x.db.getConnection(phone)) || {};
    if (accountSkipped(conn, now)) { await defer(DEFER_MS); continue; }
    try { await x.guard.assertAllowed({ phone, platform: "facebook", action: "session" }, A.guardDeps(deps, x)); } // R2: before the session
    catch (e) { if (e && e.code === "posting_disabled") { await defer(RETRY_MS); continue; } throw e; }
    const release = x.locks.tryAcquire(phone, "facebook");
    if (!release) continue; // a post or an extract has the profile: a later sweep
    let seen;
    try { seen = await visit(phone, batch, conn, deps, x); } finally { release(); }
    const byKey = new Map(seen.map((o) => [o.a.key, o]));
    const anomalies = {};
    for (const a of batch) {
      const obs = byKey.get(a.key) || null;
      const patch = patchFor(a, obs, now);
      if (patch.visibility === "confirmed_removed") {
        // The penalty first: if it fails, the post stays due and is confirmed again.
        try { await H.haltAccount(phone, "confirmed_removed", deps, { campaignId: a.campaign_id, group_id: a.target_id }); }
        catch (e) { console.error(redact(`posting recheck halt …${a.key.slice(-6)}: ${code(e)}`)); continue; }
      } else if (patch.visibility && patch.visibility !== "visible") anomalies[patch.visibility] = (anomalies[patch.visibility] || 0) + 1;
      await x.store.recordRecheck(a.key, patch, now);
    }
    await noteAnomalies(x, anomalies, now).catch((e) => console.error(redact(`posting recheck health: ${code(e)}`)));
    return "rechecked";
  }
  return byPhone.size ? "skipped" : "none";
}

module.exports = { recheckOne, MAX_POSTS, SESSION_S, MAX_TRIES, _test: { classify, patchFor, accountSkipped, permalinkInGroup, groupState } };
