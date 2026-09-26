/*
 * posting-sweeper.js — the clock that moves campaigns.
 *
 * Every sweep, in order:
 *   1. reap expired attempt leases (R1) — always, even with posting off —
 *      and record what could not be reaped (settings/posting_health);
 *   2. the fleet-level kill switch (R2: env + global + platform) — off means
 *      nothing else happens;
 *   3. the fleet breaker: enough accounts disabled within the window means
 *      Facebook changed something, not that several agents did — the global
 *      switch goes off (compare-and-set) and the operator is told;
 *   4. at most one stale group-membership sync (Task 14);
 *   5. at most one reconciliation of an outcome_unknown attempt (never a
 *      second submit: the reconcile session only looks; bounded tries,
 *      posting-reconcile.js);
 *   5b. at most one 24 h re-check session (posting-recheck.js, Task 22);
 *   6. one tick (posting-tick.js) per phone with a running campaign.
 * No step's failure aborts the sweep.
 */
const safety = require("./posting-safety");
const { redact } = require("./driver-browser");
const A = require("./posting-account");
const T = require("./posting-tick");
const H = require("./posting-halts");
const R = require("./posting-recheck");

const { iso, tail, ms, ctxOf, tellOperator, MS_HOUR } = A;
const SWEEP_MS = 60 * 1000;
// The fleet breaker's window: settings/posting.fleet_breaker_window_h (I6), default 24 h.
const FLEET_WINDOW_DEFAULT_H = 24;
const fleetWindowH = (setting) => { const h = Number(setting && setting.fleet_breaker_window_h); return Number.isFinite(h) && h > 0 && h <= 24 * 30 ? h : FLEET_WINDOW_DEFAULT_H; };
const FLEET_BREAKER_DEFAULT = 3;
const SYNC_RETRY_MS = 6 * MS_HOUR;
const code = (e) => (e && (e.code || e.name)) || "error";
const { loginOpen } = require("./profile-lock");

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
// "the window ago" (fleet_breaker_window_h, default 24 h) and
// settings/posting.enabled_at (the last re-enable, set by the operator UI,
// Task 21) — halts from before a re-enable were already judged. OFF is
// reported only once it is true: after our compare-and-set write succeeded,
// or when the switch is already seen off.
async function fleetBreaker(setting, deps, x, now) {
  const windowH = fleetWindowH(setting);
  const sinceMs = Math.max(now.getTime() - windowH * MS_HOUR, ms(setting.enabled_at) || 0);
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
  // Compare-and-set against the version the count was made from (Task 21 fix
  // round 1): the count used THAT doc's enabled_at. If the switch moved in
  // between (an operator turned posting on, with a new enabled_at), the
  // count is stale: it is never written over the operator's change, and the
  // next sweep recounts against the new doc.
  try {
    await x.db.setSetting("posting", { enabled: false, disabled_reason: "fleet_breaker", disabled_at: iso(now) }, { expectVersion: setting.version || 0 });
  } catch (e) {
    if (!e || e.code !== "version_conflict") throw e;
    // Not OFF, so not reported as OFF — but no account is ticked this sweep either.
    console.error(`posting: fleet breaker condition met (${n} accounts) but the switch changed since it was read; recounting next sweep`);
    return true;
  }
  console.error(`posting: FLEET BREAKER tripped — ${n} accounts disabled within the window; posting is OFF`);
  await tellOperator(deps, `posting: FLEET BREAKER — ${n} accounts disabled within ${windowH} h; posting is OFF until an operator turns it back on`);
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
    if (loginOpen(conn, "facebook", now.getTime())) continue; // the agent is logging in on this profile right now
    const release = x.locks.tryAcquire(phone, "facebook");
    if (!release) continue;
    try {
      await x.db.setConnection(phone, { facebook_groups_sync_attempted_at: iso(now) });
      // The whole deps: a halting signal on the groups page halts the account (posting-halts).
      await sync.runSync({ phone }, Object.assign({}, deps, { db: x.db, store: x.store, guard: x.guard, env: deps.env, withPage: deps.withPage, lockHeld: true }));
    } catch (e) { console.error(redact(`posting groups sync ${tail(phone)}: ${code(e)}`)); }
    finally { release(); }
    return true;
  }
  return false;
}

// 5. outcome_unknown → reconciliation: bounded tries, oldest due first
// (posting-reconcile.js, I7). Never a second submit.
const reconcileOne = (deps, x, now) => require("./posting-reconcile").reconcileOne(deps, x, now);

// 1b. Profile deletes that failed, or were deferred because the profile was
// in use (profile-lifecycle, I9): every row once per Jerusalem day
// (settings/posting_health.last_delete_retry_day, stamped BEFORE the run so
// a failing run never repeats within the day), and in between only the
// deferred ones, as soon as this process has filed one. Runs with posting
// off too — a delete is the agent's right, not a post. Deletes failing for
// 7+ days go to the operator. → the results, or null when nothing ran.
async function retryProfileDeletes(deps, x, now) {
  const lc = deps.lifecycle || require("./profile-lifecycle");
  if (typeof lc.retryDeletes !== "function") return null;
  const day = safety.jerusalemDate(now);
  const health = (await x.db.getSetting("posting_health")) || {};
  const daily = health.last_delete_retry_day !== day;
  if (!daily && !(typeof lc.hasDeferredDeletes === "function" && lc.hasDeferredDeletes())) return null;
  if (daily) await x.db.setSetting("posting_health", { last_delete_retry_day: day });
  const results = await lc.retryDeletes({ db: x.db, driver: deps.driver || require("./driver-browser"), locks: x.locks }, { onlyDeferred: !daily });
  // Escalate from the daily run only: a busy-only retry every sweep would re-alert every minute.
  const late = daily ? (results || []).filter((r) => r && r.escalate) : [];
  if (late.length) {
    await tellOperator(deps, `posting: ${late.length} browser-profile delete(s) failing for 7+ days (${late.slice(0, 5).map((r) => `${r.platform} ${tail(r.phone)}`).join(", ")}) — the cookies are still at Driver`);
  }
  return results;
}

let sweeping = false;
// What the sweeper last did, for the local monitor (routes/dev-driver.js):
// the last sweep's result and each account's last tick outcome. In memory.
const state = { started: false, last: null, accounts: new Map() };
const stamp = () => new Date().toISOString();
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
    await retryProfileDeletes(deps, x, start).catch((e) => console.error(redact(`posting profile delete retry: ${code(e)}`)));
    let setting;
    try { setting = await x.guard.assertFleetAllowed({ platform: "facebook" }, A.guardDeps(deps, x)); }
    catch (e) { if (e && e.code === "posting_disabled") { state.last = { at: stamp(), result: "off", reason: e.reason || null }; return 0; } throw e; }
    if (await fleetBreaker(setting || {}, deps, x, start)) { state.last = { at: stamp(), result: "breaker" }; return 0; }
    await syncOneStale(deps, x, at()).catch((e) => console.error(redact(`posting sync step: ${code(e)}`)));
    await reconcileOne(deps, x, at()).catch((e) => console.error(redact(`posting reconcile step: ${code(e)}`)));
    await R.recheckOne(deps, at()).catch((e) => console.error(redact(`posting recheck step: ${code(e)}`)));
    // Paused accounts are ticked too: their housekeeping still mirrors attempts
    // (a tick with nothing running does nothing else).
    const live = (await x.store.listPostingCampaignsByStatus("running", 500)).concat(await x.store.listPostingCampaignsByStatus("paused", 500));
    const phones = [...new Set(live.map((c) => c.phone))];
    for (const phone of phones) state.accounts.set(phone, { at: stamp(), outcome: await T.tickAccount(phone, deps, at()) });
    // Connected accounts with nothing running still warm up — at most one new
    // browse per sweep, so a fleet of fresh connections is spread out.
    const idle = (await x.store.listConnectedPhones("facebook").catch(() => [])).filter((p) => !phones.includes(p));
    for (const phone of idle) {
      const outcome = await T.warmIdle(phone, deps, at()).catch((e) => { console.error(redact(`posting warm-up ${tail(phone)}: ${code(e)}`)); return "error"; });
      state.accounts.set(phone, { at: stamp(), outcome });
      if (outcome === "browse_started") break;
    }
    state.last = { at: stamp(), result: "ticked", accounts: phones.length };
    return phones.length;
  } catch (e) {
    state.last = { at: stamp(), result: "error", code: code(e) };
    console.error(redact(`posting sweep: ${code(e)}`));
    return 0;
  } finally {
    await writeHealth(x, start, reapFailures).catch((e) => console.error(redact(`posting health write: ${code(e)}`)));
    sweeping = false;
  }
}

function startSweeper(deps = {}) {
  state.started = true;
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
    // No Green API on a local box: the message goes to the console instead,
    // so an approval request can still be seen (phone tail only).
    notify: (greenInstance && greenToken) || process.env.FORLY_ENV !== "local"
      ? (phone, text) => sendWhatsApp(phone, text, greenInstance, greenToken)
      : async (phone, text) => { console.log(`[whatsapp → ${tail(phone)} · not sent: no GREENAPI_TOKEN]\n${text}`); },
    notifyOperator: operator ? (text) => sendWhatsApp(operator, text, greenInstance, greenToken) : null,
    messages: build ? build({ pageBaseUrl, authSecret }) : undefined,
  };
}

module.exports = {
  sweep, startSweeper, liveDeps, SWEEP_MS,
  status: () => ({ started: state.started, last: state.last, accounts: [...state.accounts].map(([phone, v]) => Object.assign({ phone }, v)) }),
  tick: T.tick, tickAccount: T.tickAccount, runAttempt: T.runAttempt, haltAccount: H.haltAccount,
  _test: { reap, writeHealth, fleetBreaker, syncOneStale, reconcileOne, retryProfileDeletes, optionalFn, reset: () => { sweeping = false; } },
};
