/*
 * posting-tick.js — one account, one step (posting-sweeper.js calls it).
 *
 * A tick holds the phone's profile lock from planning through reservation
 * and the post itself, so two ticks can never both reserve for one account
 * and nothing else opens that profile meanwhile. First it mirrors attempts
 * onto posts and re-reads reality (page gone, expiry, completion, group
 * eligibility); then it does exactly one of: wait (an attempt in flight),
 * reserve and run the earliest due post, or plan the next one.
 *
 * A post moves scheduled → posting only after its attempt is reserved (R1);
 * the driver (Task 18, `deps.post`) reports every state through
 * deps.attempts.transition, and the post mirrors its attempt's terminal
 * state. Nothing at or past submit_started is ever submitted again: it goes
 * to outcome_unknown and reconciliation.
 */
const crypto = require("crypto");
const safety = require("./posting-safety");
const { redact } = require("./driver-browser");
const { profileName } = require("./profile-name");
const A = require("./posting-account");
const C = require("./posting-campaign");
const H = require("./posting-halts");

const { iso, tail, fail, ms, ctxOf, nowOf, configOf, mutate, say, tellOperator, MS_MIN, MS_HOUR, MS_DAY, ACTIVE_PAGE, OPEN_POST } = A;
const MAX_TICK_ERRORS = 3;
const MAX_RETRIES = 3; // refusals / infrastructure cancels before a post is skipped
const BROWSE_EVERY_MS = 20 * MS_HOUR;
// Clearly below profile-lock's MAX_HOLD_MS (20 min): the profile lock must
// still be ours when a hung driver call is settled (asserted in the tests).
const POST_TIMEOUT_MS = 15 * MS_MIN;
const PRE_SUBMIT = new Set(["reserved", "session_started", "composer_ready"]);
const IN_FLIGHT = new Set(["submit_started", "verification_pending"]);
// A cancel that was nobody's decision about THIS post (the lease ran out,
// Driver failed, no driver installed yet, the kill switch flipped): the Post
// was never clicked, so the post is retried on a later day (today's attempt
// key stays taken, 16a). A kill-switch cancel never uses up a retry, so a
// brief flip can never drop a group for good.
const RETRY_CANCELS = new Set(["lease_expired", "infrastructure", "driver_unavailable", "posting_disabled"]);
const FREE_RETRY = new Set(["posting_disabled"]);
const MISMATCH = new Set(["identity_mismatch", "destination_mismatch", "copy_mismatch"]);
const BLOCKS_GROUP = new Set(["not_member", "group_blocked"]);
const sha = C._test.sha;
const code = (e) => (e && (e.code || e.name)) || "error";

// ── post ⇐ attempt ──
// Pure (it runs inside a campaign transaction that may retry): ctx.retryAt,
// the retry day for a nobody's-decision cancel, is computed by the caller.
const mirrorCtx = (now, config, rand) => ({ now, retryAt: A.nextDayStart(now, config, rand) });
function mirrorPost(p, a, ctx) {
  const status = a && A.POST_STATUS_OF[a.state];
  if (!status || p.attempt_key !== a.key || !["posting", "unknown"].includes(p.status) || status === p.status) return p;
  const free = FREE_RETRY.has(a.error_code);
  if (status === "skipped" && RETRY_CANCELS.has(a.error_code) && ctx.running && (free || (p.retries || 0) < MAX_RETRIES)) {
    return {
      ...p, status: "scheduled", scheduled_at: iso(ctx.retryAt), attempt_key: null,
      prior_attempt_keys: (p.prior_attempt_keys || []).concat([a.key]), retries: (p.retries || 0) + (free ? 0 : 1),
      posting_started_at: null, last_error_code: a.error_code,
    };
  }
  const out = { ...p, status, error_code: status === "posted" || status === "pending_group_approval" ? null : a.error_code || p.error_code || null };
  if (status !== "unknown") out.copy = undefined; // reconciliation may still need the text
  if (status === "posted") { out.posted_at = a.finished_at || iso(ctx.now); out.post_url = a.post_url || p.post_url || null; }
  if (status === "pending_group_approval") out.post_url = a.post_url || null;
  return out;
}

// A `posting` post whose attempt cannot be found would hold the account's
// one in-flight slot forever. Whether it went out is unknowable: unknown.
const orphaned = (p, byKey) => p.status === "posting" && (!p.attempt_key || !byKey.has(p.attempt_key));
function mirrorOne(p, byKey, ctx) {
  if (orphaned(p, byKey)) return { ...p, status: "unknown", error_code: "attempt_missing" };
  return mirrorPost(p, byKey.get(p.attempt_key), ctx);
}

async function mirrorCampaign(c, x, ctx) {
  const keys = (c.posts || []).filter((p) => ["posting", "unknown"].includes(p.status)).map((p) => p.attempt_key);
  if (!keys.length) return c;
  const byKey = new Map();
  for (const k of keys) { const a = k ? await x.store.getAttempt(k) : null; if (a) byKey.set(k, a); }
  const next = (cur) => cur.posts.map((p) => mirrorOne(p, byKey, { ...ctx, running: cur.status === "running" }));
  const changed = (cur) => next(cur).some((p, i) => p !== cur.posts[i]);
  if (!changed(c)) return c;
  return mutate(x, c.id, (cur) => (changed(cur) ? { posts: next(cur) } : null));
}

// Every group has a post that is no longer open, or can never be planned.
function allDone(c, conn) {
  if ((c.posts || []).some((p) => OPEN_POST.has(p.status))) return false;
  const used = new Set(A.currentPosts(c).map((p) => p.group_id));
  const pt = (c.targets || []).includes("page") ? A.pageTarget(conn) : null;
  if (pt && !used.has(pt.group_id)) return false;
  if (!(c.targets || ["groups"]).includes("groups")) return true;
  return (c.groups || []).every((g) => used.has(g.group_id) || g.is_member === false || g.catalog_policy === false || g.listing_type_allowed === false);
}

// Mirror attempts, then re-read reality for running campaigns: the page may
// be gone, the campaign expired or done, a group's eligibility changed.
async function housekeep(phone, conn, deps, x, now, config) {
  const out = [];
  let catalog = null;
  for (let c of await x.store.listPostingCampaignsByPhone(phone)) {
    c = (await mirrorCampaign(c, x, mirrorCtx(now, config, x.rand))) || c;
    if (c.status === "running") {
      const page = await x.db.getPage(c.page_id);
      if (!page || !ACTIVE_PAGE.has(page.status || "active")) { out.push((await C.stop(c.id, deps, "page_gone")) || c); continue; }
      if (now.getTime() > ms(c.expires_at)) {
        c = (await mutate(x, c.id, (cur) => ({
          status: "completed", pause_reason: "expired",
          posts: cur.posts.map((p) => (["scheduled", "pending_approval"].includes(p.status) ? { ...p, status: "skipped", error_code: "expired", copy: undefined } : p)),
        }))) || c;
        await say(deps, phone, "completed", null, c);
        out.push(c);
        continue;
      }
      catalog = catalog || (await A.catalogIndex(x.db));
      const ctx = { conn, catalog, listingType: (page.property || {}).listing_type || null, now };
      const refresh = (gs) => gs.map((g) => ({ ...g, ...A.eligibility(g, ctx) }));
      const stale = JSON.stringify(refresh(c.groups || [])) !== JSON.stringify(c.groups || []);
      const done = !c.repeat && allDone({ ...c, groups: refresh(c.groups || []) }, conn);
      if (stale || done) {
        c = (await mutate(x, c.id, (cur) => Object.assign(stale ? { groups: refresh(cur.groups || []) } : {}, done ? { status: "completed", pause_reason: null } : {}))) || c;
        if (done) await say(deps, phone, "completed", null, c);
      }
    }
    out.push(c);
  }
  return out;
}

async function reschedule(x, id, postId, at, reason, count) {
  await mutate(x, id, (cur) => ({
    wait_reason: reason,
    posts: cur.posts.map((p) => {
      if (p.id !== postId || p.status !== "scheduled") return p;
      const retries = (p.retries || 0) + (count ? 1 : 0);
      if (count && retries >= MAX_RETRIES) return { ...p, status: "skipped", error_code: reason, retries, copy: undefined };
      return { ...p, scheduled_at: iso(at), retries, ...(count ? { last_error_code: reason } : {}) };
    }),
  }));
  return reason;
}
async function skip(x, id, postId, reason) {
  await mutate(x, id, (cur) => ({ posts: cur.posts.map((p) => (p.id === postId && OPEN_POST.has(p.status) && p.status !== "posting" ? { ...p, status: "skipped", error_code: reason, copy: undefined } : p)) }));
  return reason;
}

function duplicateIn(ga, fp, now, config) {
  const within = (f) => now.getTime() - ms(f.at) < config.fingerprint_window_days * MS_DAY;
  return (ga.fingerprints || []).some((f) => within(f) && ((fp.exact && f.exact === fp.exact) || (fp.strong && f.strong === fp.strong)));
}

// ── a due post: re-check, reserve (R1), run ──
async function runDue(c, post, st, deps, x, now) {
  const { phone, conn, config } = st;
  const page = await x.db.getPage(c.page_id);
  // Safety is re-checked at the moment of posting, not only at scheduling.
  if (!safety.isActiveTime(now, config)) return reschedule(x, c.id, post.id, safety.nextActiveTime(now, config), "inactive_time", false);
  const account = await A.accountView(phone, conn, deps, now, { campaigns: st.campaigns, exclude: post.id });
  const past = account.posts.map((p) => ms(p.at)).filter((t) => Number.isFinite(t) && t <= now.getTime());
  const lastAny = Math.max(0, ...past);
  if (now.getTime() - lastAny < config.min_gap_minutes * MS_MIN) return reschedule(x, c.id, post.id, safety.nextActiveTime(new Date(lastAny + config.min_gap_minutes * MS_MIN), config), "min_gap", false);
  const freshPenalty = ms(account.penalty_until) > now.getTime() && account.halts.some((h) => safety.SIGNAL_PENALISES.has(h.code) && now.getTime() - ms(h.at) < MS_DAY);
  const weekly = past.filter((t) => now.getTime() - t < 7 * MS_DAY).length >= safety.weeklyCapFor(account, now, config);
  if (freshPenalty || weekly) return reschedule(x, c.id, post.id, A.nextDayStart(now, config, x.rand), freshPenalty ? "penalty" : "weekly_cap", false);

  let target, aliases = [];
  const fp = safety.fingerprint((page && page.property) || {});
  if (post.target === "page") {
    target = A.pageTarget(conn);
    if (!target || target.group_id !== post.group_id) return skip(x, c.id, post.id, "ineligible");
  } else {
    const g = (c.groups || []).find((q) => q.group_id === post.group_id);
    const ctx = { conn, catalog: await A.catalogIndex(x.db), listingType: ((page && page.property) || {}).listing_type || null, now };
    if (!g || !A.isEligible(A.eligibility(g, ctx))) return skip(x, c.id, post.id, "ineligible");
    // Another Forly account may have posted this listing here since it was planned.
    aliases = A.groupIdsOf(g, conn).slice(1); // a resolved slug's history is this group's (Task 18)
    const ga = (await x.store.getGroupActivityFor([g.group_id], now, undefined, { [g.group_id]: aliases }))[g.group_id] || {};
    if (duplicateIn(ga, fp, now, config)) return skip(x, c.id, post.id, "duplicate");
    target = { ...g, target: "group", target_id: g.group_id };
  }

  // Standing: the copy is rebuilt from the page as it is now. Per-post: the
  // agent approved exact text — if the page changed since, ask again.
  const fresh = C._test.buildCopy(page, c, target);
  if (c.mode === "per_post" && fresh !== post.copy) {
    const next = await mutate(x, c.id, (cur) => ({ posts: cur.posts.map((p) => (p.id === post.id && p.status === "scheduled" ? { ...p, status: "pending_approval", copy: fresh, copy_hash: sha(fresh), approved_at: null } : p)) }));
    const p2 = next && next.posts.find((p) => p.id === post.id);
    if (p2) await say(deps, phone, "approve", `📣 פרטי הנכס השתנו — פוסט מעודכן לאישור:\n──────────\n${fresh}\n──────────`, next, p2);
    return "reapproval";
  }
  const copy = c.mode === "per_post" ? post.copy : fresh;

  try { await x.guard.assertAllowed({ phone, platform: "facebook", action: "reserve" }, A.guardDeps(deps, x)); }
  catch (e) {
    if (!e || e.code !== "posting_disabled") throw e;
    await mutate(x, c.id, (cur) => (cur.wait_reason === `posting_disabled:${e.reason}` ? null : { wait_reason: `posting_disabled:${e.reason}` }));
    return "guard";
  }
  const r = await x.store.reserveAttempt({
    phone, page_id: c.page_id, target_type: target.target, target_id: target.target_id, target_url: target.url, target_aliases: aliases,
    // R6: the Page's publisher is bound to the attempt; a group has no Graph path.
    publisher: target.target === "page" ? conn.page_publisher || "browser" : "browser",
    fingerprint: fp, campaign_id: c.id, post_id: post.id, copy_hash: sha(copy),
    confirm_membership: A.needsMembershipCheck(conn, target, now),
    click_id: crypto.randomBytes(16).toString("hex"), // R4: ?c= on this attempt's link
    limits: A.limitsFor(account, now, config, target.target), now,
  });
  if (r.ok) return startAttempt(r.attempt, { c, post, copy, target, conn, lock: st.lock }, deps, x, now);

  if (r.reason === "already_reserved" && r.attempt) {
    const a = r.attempt;
    const ours = a.campaign_id === c.id && a.post_id === post.id;
    if (ours && a.state === "reserved" && a.copy_hash === sha(copy)) return startAttempt(a, { c, post, copy, target, conn, lock: st.lock }, deps, x, now);
    if (ours && a.state !== "cancelled" && !a.released) {
      // An orphan of ours past `reserved`: adopt it; the reaper and the mirror finish it.
      await mutate(x, c.id, (cur) => ({ posts: cur.posts.map((p) => (p.id === post.id && p.status === "scheduled" ? { ...p, status: "posting", attempt_key: a.key, posting_started_at: a.reserved_at } : p)) }));
      return "adopted";
    }
  }
  // daily_cap, group_cap, duplicate, or today's key already used: this post
  // stays scheduled, for a later day — never failed.
  return reschedule(x, c.id, post.id, A.nextDayStart(now, config, x.rand), r.reason, true);
}

async function startAttempt(attempt, st, deps, x, now) {
  const { c, post, copy } = st;
  // The campaign's slot: scheduled → posting, with attempt_key, in one campaign transaction.
  const next = await mutate(x, c.id, (cur) => {
    const p = cur.posts.find((q) => q.id === post.id);
    if (cur.status !== "running" || !p || p.status !== "scheduled") return null;
    return { wait_reason: null, posts: cur.posts.map((q) => (q.id === post.id ? { ...q, status: "posting", attempt_key: attempt.key, posting_started_at: iso(now), copy, copy_hash: sha(copy) } : q)) };
  });
  const p = next && next.posts.find((q) => q.id === post.id);
  if (!p || p.status !== "posting" || p.attempt_key !== attempt.key) {
    // Stopped or skipped between the read and the reservation: release it.
    // Already cancelled (by that STOP) is not a failure.
    await x.store.transition(attempt.key, "cancelled", { error_code: "stopped" }, x.clock())
      .catch((e) => { if (!e || e.code !== "illegal_transition") A.noteCancelFailure(1); });
    return "stopped";
  }
  return runAttempt(attempt, { ...st, c: next, post: p }, deps, now);
}

function codeOf(result, err) {
  if (err) return err.code && err.code !== "posting_disabled" ? String(err.code) : null;
  const state = typeof result === "string" ? result : result && typeof result === "object" ? result.error_code || result.code || result.state : null;
  const m = typeof state === "string" ? state.match(/^verified_failed:(.+)$/) : null;
  if (m) return m[1];
  return result && typeof result === "object" && result.error_code ? String(result.error_code) : null;
}
const isInfra = (err) => !!err && err.code !== "posting_disabled" && !H.classOf(err.code) && (typeof err.status === "number" || !err.code || err.code === "profile_busy");

// Runs one reserved attempt through the injected driver (Task 18).
async function runAttempt(attempt, st, deps, now) {
  const x = ctxOf(deps);
  const { c, post, copy, target, conn } = st;
  const phone = attempt.phone;
  const gd = A.guardDeps(deps, x);
  // R2: before creating a session.
  try { await x.guard.assertAllowed({ phone, platform: "facebook", action: "session" }, gd); }
  catch (e) { if (!e || e.code !== "posting_disabled") throw e; return settle(attempt.key, null, e, st, deps, x, now); }
  const fn = post.target === "page" ? deps.postToPage || deps.post : deps.post;
  if (typeof fn !== "function") return "no_driver"; // stays reserved → the reaper cancels it → retried later
  // Last look before the driver: a STOP (or anything else) may have landed
  // since startAttempt committed `posting`. The driver runs only for an
  // attempt still `reserved` in a campaign still `running`. (Task 18 writes
  // session_started before opening a browser, which closes what is left.)
  const current = await x.store.getAttempt(attempt.key);
  const camp = await x.store.getPostingCampaign(c.id);
  if (!current || current.state !== "reserved" || !camp || camp.status !== "running") {
    if (current && current.state === "reserved") {
      await x.store.transition(attempt.key, "cancelled", { error_code: "stopped" }, x.clock())
        .catch((e) => { if (!e || e.code !== "illegal_transition") A.noteCancelFailure(1); });
    }
    return settle(attempt.key, null, null, st, deps, x, now);
  }
  const args = {
    attempt, copy, comment: `${deps.pageBaseUrl || ""}/p/${c.page_id}?c=${attempt.click_id}`,
    profileName: profileName("facebook", phone, conn.facebook_profile_gen || 0),
    dryRun: deps.dryRun === true, campaignId: c.id, phone,
    [post.target === "page" ? "pageUrl" : "groupUrl"]: target.url,
  };
  const postDeps = {
    attempts: {
      transition: (k, state, detail) => (k === attempt.key ? x.store.transition(k, state, detail, x.clock()) : Promise.reject(fail("invalid_input", "foreign attempt"))),
      annotate: (k, detail) => (k === attempt.key ? x.store.annotateAttempt(k, detail, x.clock()) : Promise.reject(fail("invalid_input", "foreign attempt"))),
    },
    // R2 inside the driver: navigate, and immediately before Post.
    guard: (action) => x.guard.assertAllowed({ phone, platform: "facebook", action }, gd),
    lockHeld: true, phone, platform: "facebook", conn,
  };
  // A driver call that never returns must not hold the sweep (and the reaper)
  // forever: past POST_TIMEOUT_MS it is settled like an infrastructure error —
  // cancelled before submit, outcome_unknown after — and any late transition
  // the driver still tries is refused by the attempt's edges.
  // The profile lock, however, is NOT given back at the timeout: the driver
  // may still hold the browser. It is released when the driver's promise
  // finally settles (st.lock.defer), with profile-lock's MAX_HOLD_MS expiry as
  // the backstop; meanwhile the phone's ticks see profile_busy.
  let result = null, err = null, timer = null, timedOut = false;
  const running = Promise.resolve().then(() => fn(args, postDeps));
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(Object.assign(new Error("driver timeout"), { status: 504 })); }, deps.postTimeoutMs || POST_TIMEOUT_MS); });
  try { result = await Promise.race([running, timeout]); } catch (e) { err = e; } finally { clearTimeout(timer); }
  if (timedOut && st.lock) st.lock.defer(running);
  if (result && result.noop === true) return "no_driver";
  const state = await settle(attempt.key, result, err, st, deps, x, now);
  await A.applyFindings(result, st, x, now);
  return state;
}

// Closes the attempt if the driver left it open, mirrors it onto the post,
// and applies the consequences: counters, group blocks, halts (R5).
async function settle(key, result, err, st, deps, x, now) {
  const { c, post } = st;
  const phone = c.phone;
  const config = await configOf(deps, x);
  const hint = codeOf(result, err);
  let a = await x.store.getAttempt(key);
  if (a && (PRE_SUBMIT.has(a.state) || IN_FLIGHT.has(a.state))) {
    let to, detail;
    if (IN_FLIGHT.has(a.state)) { to = "outcome_unknown"; detail = { error_code: hint || (err && err.code === "posting_disabled" ? "posting_disabled" : "driver_incomplete") }; } // never re-submitted
    else if (err && err.code === "posting_disabled") { to = "cancelled"; detail = { error_code: "posting_disabled", reason: String(err.reason || "").slice(0, 60) }; }
    else if (isInfra(err)) { to = "cancelled"; detail = { error_code: "infrastructure" }; }
    else { to = a.state === "reserved" ? "cancelled" : "verified_failed"; detail = { error_code: hint || "driver_incomplete" }; }
    try { a = await x.store.transition(key, to, detail, x.clock()); }
    catch (e) { console.error(redact(`posting settle …${key.slice(-6)}: ${code(e)}`)); a = await x.store.getAttempt(key); }
  }
  if (!a) return "missing";
  const errCode = a.error_code || hint || null;
  const cls = H.classOf(errCode);
  const ok = a.state === "verified_posted" || a.state === "submitted_for_approval";
  let failed = false;
  if (a.state === "verified_failed" && !cls) {
    if (MISMATCH.has(errCode)) await tellOperator(deps, `posting: ${errCode} on attempt …${key.slice(-6)} (account ${tail(phone)}) — no retry (R3)`);
    failed = !safety.SIGNAL_SKIPS.has(errCode);
  }
  const max = config.max_consecutive_failures;
  const mctx = mirrorCtx(now, config, x.rand);
  const next = await mutate(x, c.id, (cur) => {
    const patch = { posts: cur.posts.map((p) => mirrorPost(p, a, { ...mctx, running: cur.status === "running" })) };
    if (ok) Object.assign(patch, { consecutive_failures: 0, selector_failures: 0, wait_reason: null });
    if (a.state === "cancelled" && a.error_code === "infrastructure") patch.wait_reason = "infrastructure";
    if (a.state === "verified_failed" && BLOCKS_GROUP.has(errCode)) {
      patch.groups = (cur.groups || []).map((g) => (g.group_id === post.group_id ? { ...g, blocked_code: errCode, blocked_at: iso(now) } : g));
    }
    if (failed) {
      patch.consecutive_failures = (cur.consecutive_failures || 0) + 1;
      if (patch.consecutive_failures >= max && cur.status === "running") Object.assign(patch, { status: "paused", pause_reason: "consecutive_failures" });
    }
    return patch;
  });
  // no `now`: the halt is stamped with the clock as it runs, not the tick's start (the post took minutes)
  if (cls) await H.haltAccount(phone, cls, deps, Object.assign({ campaignId: c.id }, cls === "confirmed_removed" ? { group_id: post.group_id } : {}));
  const mine = next && next.posts.find((p) => p.id === post.id);
  if (ok && mine) await say(deps, phone, "posted", null, next, mine);
  if (failed && next && next.status === "paused" && next.pause_reason === "consecutive_failures") {
    await say(deps, phone, "paused", "⏸ הפרסום האוטומטי הושהה אחרי כמה ניסיונות שלא הצליחו. אפשר להמשיך מעמוד הנכס.", next);
  }
  return a.state;
}

// ── nothing due: plan the next post, or browse on a warm-up day ──
async function browse(phone, conn, deps, x, now) {
  if (typeof deps.dwell !== "function") return;
  if (now.getTime() - Math.max(ms(conn.last_browse_at) || 0, ms(conn.last_browse_attempt_at) || 0) < BROWSE_EVERY_MS) return;
  try { await x.guard.assertAllowed({ phone, platform: "facebook", action: "dwell" }, A.guardDeps(deps, x)); } catch (e) { if (e && e.code === "posting_disabled") return; throw e; }
  await x.db.setConnection(phone, { last_browse_attempt_at: iso(now) });
  const r = await deps.dwell({ phone, profileName: profileName("facebook", phone, conn.facebook_profile_gen || 0), note: "forly-dwell:" }, { lockHeld: true, phone, platform: "facebook", conn });
  if (r && r.noop === true) return;
  await x.db.setConnection(phone, { last_browse_at: iso(now) });
  const cls = H.classOf(r && r.signal);
  if (cls) await H.haltAccount(phone, cls, deps); // stamped with the clock as it runs
}

async function planNext(phone, st, deps, x, now) {
  const decision = await C.planAccount(phone, deps, now, { conn: st.conn, config: st.config, campaigns: st.campaigns });
  if (!decision) return "idle";
  if (decision.campaignId) { await C.schedulePost(decision, deps, now); return "scheduled"; }
  if (decision.reason === "browse_only") await browse(phone, st.conn, deps, x, now);
  for (const c of st.campaigns) {
    if (c.status === "running" && !(c.posts || []).some((p) => OPEN_POST.has(p.status)) && c.wait_reason !== decision.reason) {
      await mutate(x, c.id, (cur) => (cur.status === "running" ? { wait_reason: decision.reason } : null));
    }
  }
  return decision.reason;
}

// ── one account ──
async function tickLocked(phone, deps, x, now, lock) {
  const config = await configOf(deps, x);
  const conn = (await x.db.getConnection(phone)) || {};
  const campaigns = await housekeep(phone, conn, deps, x, now, config);
  const running = campaigns.filter((c) => c.status === "running");
  if (!running.length) return "idle";
  if (C._test.accountBlocked(conn)) {
    for (const c of running) await mutate(x, c.id, (cur) => (cur.status === "running" ? { status: "paused", pause_reason: "account" } : null));
    return "account_blocked";
  }
  let outcome;
  if (running.some((c) => c.posts.some((p) => p.status === "posting"))) outcome = "in_flight"; // one attempt per account at a time
  else {
    const due = running.flatMap((c) => c.posts.filter((p) => p.status === "scheduled" && ms(p.scheduled_at) <= now.getTime()).map((p) => ({ c, p })))
      .sort((a, b) => ms(a.p.scheduled_at) - ms(b.p.scheduled_at))[0];
    const st = { phone, conn, config, campaigns, lock };
    outcome = due ? await runDue(due.c, due.p, st, deps, x, now) : await planNext(phone, st, deps, x, now);
  }
  for (const c of running) if (c.tick_errors) await mutate(x, c.id, () => ({ tick_errors: 0 }));
  return outcome;
}

async function tickAccount(phone, deps = {}, now) {
  const x = ctxOf(deps);
  now = now || nowOf(deps, x);
  const release = x.locks.tryAcquire(phone, "facebook");
  if (!release) return "profile_busy"; // an extract, the login browser or a hung post has the profile: next sweep
  // A timed-out driver call defers the release until its promise settles.
  let pending = null;
  const lock = { defer: (p) => { pending = p; } };
  try { return await tickLocked(phone, deps, x, now, lock); }
  catch (e) {
    console.error(redact(`posting tick ${tail(phone)}: ${code(e)}`));
    try {
      for (const c of await x.store.listPostingCampaignsByPhone(phone)) {
        if (c.status !== "running") continue;
        await mutate(x, c.id, (cur) => { const n = (cur.tick_errors || 0) + 1; return n >= MAX_TICK_ERRORS ? { tick_errors: n, status: "paused", pause_reason: "internal" } : { tick_errors: n }; });
      }
    } catch { /* the next sweep tries again */ }
    return "error";
  } finally {
    if (pending) pending.then(release, release);
    else release();
  }
}

// tick(campaign) — one step for the campaign's whole account; → the campaign as it is now.
async function tick(campaign, deps = {}, now) {
  const x = ctxOf(deps);
  const c = campaign && campaign.id ? await x.store.getPostingCampaign(campaign.id) : null;
  if (!c) return null;
  await tickAccount(c.phone, deps, now || nowOf(deps, x));
  return x.store.getPostingCampaign(c.id);
}

module.exports = {
  tick, tickAccount, runAttempt, settle, mirrorPost, mirrorCtx, MAX_RETRIES, POST_TIMEOUT_MS,
  _test: { mirrorPost, mirrorOne, allDone, codeOf, isInfra, housekeep, duplicateIn },
};
