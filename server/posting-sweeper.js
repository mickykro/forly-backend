/*
 * posting-sweeper.js — the clock that moves campaigns.
 *
 * Every sweep, in order:
 *   1. reap expired attempt leases (R1) — always, even with posting off —
 *      and record what could not be reaped (settings/posting_health);
 *   2. the fleet-level kill switch (R2: env + global + platform) — off means
 *      nothing else happens;
 *   3. the fleet breaker: enough accounts disabled within the hour means
 *      Facebook changed something, not that several agents did — the global
 *      switch goes off (compare-and-set) and the operator is told;
 *   4. at most one stale group-membership sync (Task 14);
 *   5. at most one reconciliation of an outcome_unknown attempt (never a
 *      second submit: the reconcile session only looks);
 *   6. one tick (posting-tick.js) per phone with a running campaign.
 * No step's failure aborts the sweep.
 */
const safety = require("./posting-safety");
const { redact } = require("./driver-browser");
const A = require("./posting-account");
const T = require("./posting-tick");
const H = require("./posting-halts");

const { iso, tail, fail, ms, ctxOf, nowOf, mutate, tellOperator, MS_HOUR } = A;
const SWEEP_MS = 60 * 1000;
const FLEET_WINDOW_MS = MS_HOUR;
const FLEET_BREAKER_DEFAULT = 3;
const SYNC_RETRY_MS = 6 * MS_HOUR;
const code = (e) => (e && (e.code || e.name)) || "error";

// 1. → the failures ({ key, error_code }) the reaper could not move.
async function reap(x, now) {
  let reaped;
  try { reaped = await x.store.reapExpired(now); }
  catch (e) { console.error(redact(`posting reaper failed: ${code(e)}`)); return [{ key: "", error_code: code(e) }]; }
  const failures = (reaped && reaped.failures) || [];
  if (failures.length) {
    console.error(redact(`posting reaper: ${failures.length} attempt(s) not reaped: ${failures.slice(0, 10).map((f) => `${f.error_code}@…${String(f.key).slice(-6)}`).join(", ")}`));
  }
  return failures;
}

// settings/posting_health: what the admin overview (Task 21) shows. A plain merge.
async function writeHealth(x, now, reapFailures) {
  const prev = (await x.db.getSetting("posting_health")) || {};
  const seen = new Map((prev.reap_failures || []).map((f) => [f.key_tail, f.first_seen_at]));
  const at = iso(now);
  const reap_failures = reapFailures.slice(0, 50).map((f) => {
    const key_tail = String(f.key || "").slice(-6);
    return { key_tail, error_code: String(f.error_code || "error").slice(0, 60), first_seen_at: seen.get(key_tail) || at };
  });
  const cancelled = A.drainCancelFailures();
  await x.db.setSetting("posting_health", { last_sweep_at: at, reap_failures, cancel_failures_count: (prev.cancel_failures_count || 0) + cancelled });
}

// 3. → true when the breaker is (now) tripped. Halts count from the later of
// "an hour ago" and settings/posting.enabled_at (the last re-enable, set by
// the operator UI, Task 21) — halts from before a re-enable were already
// judged. OFF is reported only once it is true: after our compare-and-set
// write succeeded, or when the switch is already seen off.
async function fleetBreaker(setting, deps, x, now) {
  const sinceMs = Math.max(now.getTime() - FLEET_WINDOW_MS, ms(setting.enabled_at) || 0);
  const since = iso(sinceMs);
  const phones = await x.store.listPhonesHaltedSince(since);
  let n = 0;
  for (const phone of phones) {
    const conn = (await x.db.getConnection(phone)) || {};
    if ((conn.posting_halts || []).some((h) => h && safety.SIGNAL_DISABLES.has(h.code) && ms(h.at) >= sinceMs)) n++;
  }
  const t = Number(setting.fleet_breaker_threshold);
  const threshold = Number.isInteger(t) && t > 0 ? t : FLEET_BREAKER_DEFAULT;
  if (n < threshold) return false;
  let off = false;
  for (let i = 0; i < 3 && !off; i++) {
    const cur = (await x.db.getSetting("posting")) || {};
    if (cur.enabled === false) { off = true; break; }
    try {
      await x.db.setSetting("posting", { enabled: false, disabled_reason: "fleet_breaker", disabled_at: iso(now) }, { expectVersion: cur.version || 0 });
      off = true;
    } catch (e) { if (!e || e.code !== "version_conflict") throw e; }
  }
  if (!off) {
    // Not OFF, so not reported as OFF — but no account is ticked this sweep either.
    console.error(`posting: fleet breaker condition met (${n} accounts) but the switch could not be written; skipping this sweep`);
    return true;
  }
  console.error(`posting: FLEET BREAKER tripped — ${n} accounts disabled within the window; posting is OFF`);
  await tellOperator(deps, `posting: FLEET BREAKER — ${n} accounts disabled within an hour; posting is OFF until an operator turns it back on`);
  return true;
}

// 4. At most one per sweep, behind the profile lock, only for accounts that
// opted into posting, and not again within SYNC_RETRY_MS of a failed try.
async function syncOneStale(deps, x, now) {
  const sync = deps.groupsSync;
  if (!sync || typeof sync.isStale !== "function" || typeof sync.runSync !== "function") return false;
  for (const phone of await x.store.listConnectedPhones("facebook")) {
    const conn = (await x.db.getConnection(phone)) || {};
    if (!conn.posting_permission || conn.posting_permission.enabled !== true || !sync.isStale(conn, now)) continue;
    if (now.getTime() - (ms(conn.facebook_groups_sync_attempted_at) || 0) < SYNC_RETRY_MS) continue;
    const release = x.locks.tryAcquire(phone, "facebook");
    if (!release) continue;
    try {
      await x.db.setConnection(phone, { facebook_groups_sync_attempted_at: iso(now) });
      await sync.runSync({ phone }, { db: x.db, guard: x.guard, env: deps.env, withPage: deps.withPage, lockHeld: true });
    } catch (e) { console.error(redact(`posting groups sync ${tail(phone)}: ${code(e)}`)); }
    finally { release(); }
    return true;
  }
  return false;
}

// 5. outcome_unknown → one reconciliation session, marked on the post BEFORE
// it runs so a crash can never run it twice; after that, operator review.
async function reconcileOne(deps, x, now) {
  if (typeof deps.reconcile !== "function") return false;
  for (const a of await x.store.listAttemptsByState("outcome_unknown", 50)) {
    if (!a.campaign_id || !a.post_id) continue;
    const c = await x.store.getPostingCampaign(a.campaign_id);
    const post = c && (c.posts || []).find((p) => p.id === a.post_id);
    if (!post || post.reconcile_at) continue;
    try { await x.guard.assertAllowed({ phone: a.phone, platform: "facebook", action: "retry" }, A.guardDeps(deps, x)); }
    catch (e) { if (e && e.code === "posting_disabled") continue; throw e; }
    const release = x.locks.tryAcquire(a.phone, "facebook");
    if (!release) continue;
    let result = null;
    try {
      await mutate(x, c.id, (cur) => ({ posts: cur.posts.map((p) => (p.id === post.id ? { ...p, reconcile_at: iso(now) } : p)) }));
      const conn = (await x.db.getConnection(a.phone)) || {};
      result = await deps.reconcile(a, {
        attempts: {
          transition: (k, state, detail) => (k === a.key ? x.store.transition(k, state, detail, x.clock()) : Promise.reject(fail("invalid_input", "foreign attempt"))),
          annotate: (k, detail) => (k === a.key ? x.store.annotateAttempt(k, detail, x.clock()) : Promise.reject(fail("invalid_input", "foreign attempt"))),
        },
        guard: (action) => x.guard.assertAllowed({ phone: a.phone, platform: "facebook", action }, A.guardDeps(deps, x)),
        lockHeld: true, phone: a.phone, platform: "facebook", conn, copy: post.copy || null,
      });
    } catch (e) { console.error(redact(`posting reconcile …${a.key.slice(-6)}: ${code(e)}`)); }
    finally { release(); }
    // A halting signal the reconcile session saw (a checkpoint, a login wall…)
    // halts the account exactly as it would after a post (R5). Never throws.
    const cls = H.classOf(result && result.signal);
    if (cls) {
      try { await H.haltAccount(a.phone, cls, deps, { campaignId: c.id, now }); }
      catch (e) { console.error(redact(`posting reconcile halt …${a.key.slice(-6)}: ${code(e)}`)); }
    }
    if (result && result.noop === true) {
      // No reconciler installed yet: it has not really run, so it may run later.
      await mutate(x, c.id, (cur) => ({ posts: cur.posts.map((p) => (p.id === post.id ? { ...p, reconcile_at: null } : p)) }));
      return false;
    }
    const fresh = await x.store.getAttempt(a.key);
    if (fresh && fresh.state !== "outcome_unknown") {
      const mctx = T.mirrorCtx(now, safety.DEFAULTS, x.rand);
      await mutate(x, c.id, (cur) => ({ posts: cur.posts.map((p) => T.mirrorPost(p, fresh, { ...mctx, running: cur.status === "running" })) }));
    }
    return true;
  }
  return false;
}

let sweeping = false;
// → the number of accounts ticked (0 when the switch is off or the breaker tripped).
async function sweep(deps = {}, now) {
  if (sweeping) return 0;
  sweeping = true;
  const x = ctxOf(deps);
  const fixed = now instanceof Date ? now : null;
  const at = () => fixed || x.clock();
  const start = at();
  let reapFailures = [];
  try {
    reapFailures = await reap(x, start);
    let setting;
    try { setting = await x.guard.assertFleetAllowed({ platform: "facebook" }, A.guardDeps(deps, x)); }
    catch (e) { if (e && e.code === "posting_disabled") return 0; throw e; }
    if (await fleetBreaker(setting || {}, deps, x, start)) return 0;
    await syncOneStale(deps, x, at()).catch((e) => console.error(redact(`posting sync step: ${code(e)}`)));
    await reconcileOne(deps, x, at()).catch((e) => console.error(redact(`posting reconcile step: ${code(e)}`)));
    // Paused accounts are ticked too: their housekeeping still mirrors attempts
    // (a tick with nothing running does nothing else).
    const live = (await x.store.listPostingCampaignsByStatus("running", 500)).concat(await x.store.listPostingCampaignsByStatus("paused", 500));
    const phones = [...new Set(live.map((c) => c.phone))];
    for (const phone of phones) await T.tickAccount(phone, deps, at());
    return phones.length;
  } catch (e) {
    console.error(redact(`posting sweep: ${code(e)}`));
    return 0;
  } finally {
    await writeHealth(x, start, reapFailures).catch((e) => console.error(redact(`posting health write: ${code(e)}`)));
    sweeping = false;
  }
}

function startSweeper(deps = {}) {
  const t = setInterval(() => { sweep(deps).catch((e) => console.error(redact(`posting sweep: ${code(e)}`))); }, deps.sweepMs || SWEEP_MS);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

// A function from a module that may not exist yet (Tasks 17, 18, 20). Resolved
// at CALL time, never at load time; a missing module → null.
function optionalFn(mod, name) {
  try { const m = require(mod); return typeof m[name] === "function" ? m[name] : null; }
  catch (e) { if (e && e.code === "MODULE_NOT_FOUND" && String(e.message).includes(mod.slice(2))) return null; throw e; }
}
// The driver's fallback is a no-op: the attempt stays `reserved`, the reaper
// cancels it when its lease runs out, and the post is retried on a later day.
const optionalCall = (mod, name) => async (...args) => {
  const fn = optionalFn(mod, name);
  return fn ? fn(...args) : { noop: true };
};

function liveDeps({ greenInstance, greenToken, pageBaseUrl, authSecret, operatorPhone } = {}) {
  const db = require("./db");
  const { sendWhatsApp } = require("./utils");
  const build = optionalFn("./posting-messages", "build");
  const operator = operatorPhone || process.env.POSTING_OPERATOR_PHONE || null;
  return {
    db, store: require("./posting-store"), pageBaseUrl,
    post: optionalCall("./posting-driver", "postToGroup"),
    postToPage: optionalCall("./posting-driver", "postToPage"),
    reconcile: optionalCall("./posting-driver", "reconcile"), // Task 18 must export posting-driver.reconcile(attempt, deps)
    dwell: optionalCall("./social-dwell", "browseSession"),
    groupsSync: require("./facebook-groups-sync"),
    notify: (phone, text) => sendWhatsApp(phone, text, greenInstance, greenToken),
    notifyOperator: operator ? (text) => sendWhatsApp(operator, text, greenInstance, greenToken) : null,
    messages: build ? build({ pageBaseUrl, authSecret }) : undefined,
  };
}

module.exports = {
  sweep, startSweeper, liveDeps, SWEEP_MS,
  tick: T.tick, tickAccount: T.tickAccount, runAttempt: T.runAttempt, haltAccount: H.haltAccount,
  _test: { reap, writeHealth, fleetBreaker, syncOneStale, reconcileOne, optionalFn, reset: () => { sweeping = false; } },
};
