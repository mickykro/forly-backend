/*
 * posting-reconcile.js — the outcome_unknown lifecycle (R1, I7).
 *
 * An attempt at or past submit_started whose result is unknown is never
 * submitted again. Instead:
 *   - reconcileOne() (the sweeper, once per sweep): the longest-waiting due
 *     attempt (next_reconcile_at, set when it became outcome_unknown) gets
 *     one reconciliation session that only LOOKS for the post. At most
 *     MAX_TRIES sessions, GAP_MS apart; each try is recorded on the attempt
 *     BEFORE the session opens, so a crash uses the try and never runs it
 *     twice at once. A Driver or infrastructure error just waits for the
 *     next try. After the last one it is left for the operator.
 *   - resolveUnknown() (the admin route): the operator's verdict — posted or
 *     not posted — moves it to verified_posted / verified_failed. Nothing is
 *     ever submitted here.
 *   - unknownSummary() (the admin overview): how many, and the oldest.
 * Never skipped silently: an attempt that cannot be reconciled (no campaign
 * post, the agent revoked consent) is taken out of the queue with a note.
 */
const safety = require("./posting-safety");
const { redact } = require("./driver-browser");
const { loginOpen } = require("./profile-lock");
const A = require("./posting-account");
const H = require("./posting-halts");

const { iso, fail, mutate, tellOperator, MS_HOUR } = A;
const MAX_TRIES = 3;
const GAP_MS = 6 * MS_HOUR;
const code = (e) => (e && (e.code || e.name)) || "error";
const log = (what, a, e) => console.error(redact(`posting reconcile ${what} …${String(a.key).slice(-6)}: ${code(e)}`));
const consented = (conn) => !!(conn && conn.posting_permission && conn.posting_permission.enabled === true);

// The campaign post mirrors its attempt (posting-tick's rule).
async function mirror(x, c, fresh, now) {
  if (!c || !fresh || fresh.state === "outcome_unknown") return;
  const T = require("./posting-tick");
  const mctx = T.mirrorCtx(now, safety.DEFAULTS, x.rand);
  await mutate(x, c.id, (cur) => ({ posts: cur.posts.map((p) => T.mirrorPost(p, fresh, { ...mctx, running: cur.status === "running" })) }));
}

// → true when a reconciliation session ran. Never throws for one attempt's trouble.
async function reconcileOne(deps, x, now) {
  if (typeof deps.reconcile !== "function") return false;
  // Out of the queue, for the operator (resolve in the admin overview).
  const park = async (a, note) => {
    try { await x.store.recordReconcile(a.key, { next_reconcile_at: null }, now); await x.store.annotateAttempt(a.key, { reconcile_note: note }, x.clock()); }
    catch (e) { log("park", a, e); }
  };
  for (const a of await x.store.listReconcileDue(now, 50)) {
    const c = a.campaign_id ? await x.store.getPostingCampaign(a.campaign_id) : null;
    const post = c && (c.posts || []).find((p) => p.id === a.post_id);
    if (!post) { await park(a, "no_campaign_post"); continue; }
    try { await x.guard.assertAllowed({ phone: a.phone, platform: "facebook", action: "retry" }, A.guardDeps(deps, x)); }
    catch (e) {
      if (!e || e.code !== "posting_disabled") throw e;
      // Not now (a switch, a disabled account): later, without using a try.
      await x.store.recordReconcile(a.key, { next_reconcile_at: iso(now.getTime() + GAP_MS) }, now).catch((e2) => log("defer", a, e2));
      continue;
    }
    const pre = (await x.db.getConnection(a.phone)) || {};
    // I10: the agent withdrew consent — their profile is not opened again, not even to look.
    if (!consented(pre)) { await park(a, "consent_revoked"); continue; }
    if (loginOpen(pre, "facebook", now.getTime())) continue; // the agent is logging in: a later sweep
    const release = x.locks.tryAcquire(a.phone, "facebook");
    if (!release) continue;
    const tries = (a.reconcile_tries || 0) + 1;
    let result = null, recorded = false;
    try {
      await x.store.recordReconcile(a.key, { reconcile_tries: tries, reconcile_attempted_at: iso(now), next_reconcile_at: tries < MAX_TRIES ? iso(now.getTime() + GAP_MS) : null }, now);
      recorded = true;
      const conn = (await x.db.getConnection(a.phone)) || {};
      result = await deps.reconcile(a, {
        attempts: {
          transition: (k, state, detail) => (k === a.key ? x.store.transition(k, state, detail, x.clock()) : Promise.reject(fail("invalid_input", "foreign attempt"))),
          annotate: (k, detail) => (k === a.key ? x.store.annotateAttempt(k, detail, x.clock()) : Promise.reject(fail("invalid_input", "foreign attempt"))),
        },
        guard: (action) => x.guard.assertAllowed({ phone: a.phone, platform: "facebook", action }, A.guardDeps(deps, x)),
        lockHeld: true, phone: a.phone, platform: "facebook", conn, copy: post.copy || null,
      });
    } catch (e) { log("session", a, e); } // Driver/infrastructure: the next try is already scheduled
    finally { release(); }
    if (!recorded) continue;
    // A halting signal the reconcile session saw (a checkpoint, a login wall…)
    // halts the account exactly as it would after a post (R5). Never throws.
    const cls = H.classOf(result && result.signal);
    if (cls) {
      try { await H.haltAccount(a.phone, cls, deps, { campaignId: c.id }); } // stamped with the clock now, not the sweep's start
      catch (e) { log("halt", a, e); }
    }
    if (result && result.noop === true) {
      // No reconciler installed: it has not really run — the try is given back.
      await x.store.recordReconcile(a.key, { reconcile_tries: tries - 1, next_reconcile_at: iso(now) }, now).catch((e) => log("undo", a, e));
      return false;
    }
    const fresh = await x.store.getAttempt(a.key);
    await mirror(x, c, fresh, now);
    if (fresh && fresh.state === "outcome_unknown" && tries >= MAX_TRIES) {
      await tellOperator(deps, `posting: attempt …${a.key.slice(-6)} still outcome_unknown after ${MAX_TRIES} reconciliations — resolve it in the admin overview`);
    }
    return true;
  }
  return false;
}

// The operator's verdict. → { ok: true, attempt } | { error, status }.
// outcome: "posted" | "not_posted". Only outcome_unknown moves; never a submit.
async function resolveUnknown(key, outcome, { by, reason }, deps = {}) {
  const x = A.ctxOf(deps);
  const a = await x.store.getAttempt(key);
  if (!a) return { status: 404, error: "not_found" };
  if (a.state !== "outcome_unknown") return { status: 409, error: "not_outcome_unknown", state: a.state };
  const to = outcome === "posted" ? "verified_posted" : "verified_failed";
  const detail = Object.assign({ resolved_by_tail: by || null, resolution_reason: reason, resolved_at: iso(x.clock()) }, to === "verified_failed" ? { error_code: "operator_not_posted" } : {});
  let fresh;
  try { fresh = await x.store.transition(key, to, detail, x.clock()); }
  catch (e) {
    if (e && e.code === "illegal_transition") return { status: 409, error: "not_outcome_unknown" }; // it moved meanwhile
    throw e;
  }
  const c = a.campaign_id ? await x.store.getPostingCampaign(a.campaign_id) : null;
  await mirror(x, c, fresh, x.clock()).catch((e) => log("resolve mirror", a, e));
  return { ok: true, attempt: fresh };
}

// For the admin overview: how many are waiting, the oldest, and the 20 oldest.
// When an attempt became outcome_unknown: its history, else its last update.
const sinceOf = (a) => ((a.history || []).filter((h) => h && h.state === "outcome_unknown").pop() || {}).at || a.updated_at || null;
async function unknownSummary(store, now, limit = 500) {
  const rows = await store.listAttemptsByState("outcome_unknown", limit);
  const list = rows.map((a) => ({ a, since: sinceOf(a) })).sort((p, q) => (String(p.since) < String(q.since) ? -1 : 1));
  const oldest = list[0] ? list[0].since : null;
  return {
    count: rows.length, count_capped: rows.length >= limit, oldest_at: oldest,
    oldest_age_h: oldest ? Math.max(0, Math.floor((now.getTime() - Date.parse(oldest)) / MS_HOUR)) : null,
    oldest_items: list.slice(0, 20),
  };
}

module.exports = { reconcileOne, resolveUnknown, unknownSummary, MAX_TRIES, GAP_MS };
