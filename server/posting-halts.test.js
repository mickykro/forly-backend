/* posting-halts.js, fix round 5 — a halt is a duplicate only while the
   CURRENT disable or penalty is that halt's own (the shared flag is set by
   every disabling class), and every halt is stamped with the clock as it
   runs, never a sweep's or a tick's start. posting-sweeper.test.js holds the
   rest of the halt tests; it is at its line budget. */
const assert = require("assert");
const K = require("./posting-testkit");
const C = require("./posting-campaign");
const S = require("./posting-sweeper");
const H = require("./posting-halts");

const { db, store, NOW, MIN, HOUR, iso, base, dueOf, setup, fakePost } = K;
const PH = "972500000001";
const at = (h) => new Date(NOW.getTime() + h * HOUR);
const conn = async () => (await db.getConnection(PH)) || {};
const with_ = (deps, o) => Object.assign({}, deps, o);

(async () => {
  // ── the r4halt sequence: checkpoint → flag cleared (with or without a timestamp) → restricted → checkpoint ──
  for (const withTs of [false, true]) {
    const { deps, notes, ops } = await setup();
    const c = await C.create(base(), deps);
    await H.haltAccount(PH, "checkpoint", deps, { campaignId: c.id, now: at(0) });
    let k = await conn();
    assert.equal(k.posting_disabled_class, "checkpoint");
    assert.equal(k.posting_disabled_at, iso(at(0)));
    assert.equal(k.facebook_profile_state, "quarantined");
    await db.setConnection(PH, Object.assign({ posting_disabled_until_admin: false, facebook_profile_state: "active" }, withTs ? { posting_reenabled_at: iso(at(1)) } : {}));
    assert.equal((await C.resume(c.id, deps)).status, "running");
    let r = await H.haltAccount(PH, "restricted", deps, { campaignId: c.id, now: at(2) });
    assert.ok(!r.duplicate, "restricted is a new halt");
    k = await conn();
    assert.equal(k.posting_disabled_class, "restricted", "the disable now belongs to the restricted halt");
    assert.equal(k.posting_disabled_at, iso(at(2)));
    await db.setConnection(PH, { facebook_profile_state: "active" }); // restricted does not quarantine; make the next one visible
    const n0 = notes.length, o0 = ops.length;
    r = await H.haltAccount(PH, "checkpoint", deps, { campaignId: c.id, now: at(3) });
    assert.ok(!r.duplicate, `withTs=${withTs}: the checkpoint is a new halt, not folded into the restricted disable`);
    assert.equal(r.disabled, true);
    assert.equal(r.owner_review, true, "a third disabling halt within 30 days");
    k = await conn();
    assert.deepEqual(k.posting_halts.map((h) => h.code), ["checkpoint", "restricted", "checkpoint"]);
    // Task 21 fix round 1: a weaker class never replaces a stronger disable in force.
    assert.equal(k.posting_disabled_class, "restricted", "the restricted disable keeps its class");
    assert.equal(k.posting_disabled_at, iso(at(2)), "and its date");
    assert.equal(k.facebook_profile_state, "quarantined", "the profile is quarantined again");
    assert.ok(notes.length > n0, "the agent is told");
    assert.ok(ops.length > o0, "the operator is told");
    // while the disable that covers that checkpoint stands, another checkpoint is the same halt
    const n1 = notes.length;
    r = await H.haltAccount(PH, "checkpoint", deps, { now: at(4) });
    assert.equal(r.duplicate, true);
    assert.equal(notes.length, n1);
    assert.equal((await conn()).posting_halts.length, 3);
  }

  // ── a disable re-set by another class (never cleared) no longer belongs to the earlier halt;
  //    the stronger restricted class stays (Task 21 fix round 1) ──
  {
    const { deps } = await setup();
    await H.haltAccount(PH, "checkpoint", deps, { now: at(0) });
    await H.haltAccount(PH, "restricted", deps, { now: at(1) });
    const r = await H.haltAccount(PH, "checkpoint", deps, { now: at(2) });
    assert.ok(!r.duplicate);
    assert.equal((await conn()).posting_disabled_class, "restricted");
    assert.deepEqual((await conn()).posting_halts.map((h) => h.code), ["checkpoint", "restricted", "checkpoint"], "the halt is still appended");
  }

  // ── Task 21 fix round 1: a weaker halt never downgrades a suspected compromise ──
  {
    const { deps } = await setup();
    await db.setConnection(PH, { facebook_profile_gen: 2 });
    await H.haltAccount(PH, "suspected_compromise", deps, { now: at(0) });
    await db.setConnection(PH, { facebook_profile_gen: 3 }); // even if the generation moved, the halt's stays
    let r = await H.haltAccount(PH, "captcha", deps, { now: at(1) });
    assert.ok(!r.duplicate); assert.equal(r.disabled, true);
    let k = await conn();
    assert.equal(k.posting_disabled_class, "suspected_compromise");
    assert.equal(k.posting_disabled_at, iso(at(0)));
    assert.equal(k.posting_disabled_profile_gen, 2);
    assert.deepEqual(k.posting_halts.map((h) => h.code), ["suspected_compromise", "captcha"]);
    r = await H.haltAccount(PH, "captcha", deps, { now: at(2) });
    assert.equal(r.duplicate, true, "the captcha is covered by the stronger disable it arrived under");
    // equal strength still takes over: a checkpoint after a captcha
    const { deps: d2 } = await setup();
    await H.haltAccount(PH, "captcha", d2, { now: at(0) });
    await H.haltAccount(PH, "checkpoint", d2, { now: at(1) });
    k = await conn();
    assert.equal(k.posting_disabled_class, "checkpoint"); assert.equal(k.posting_disabled_at, iso(at(1)));
  }

  // ── a disable with no class or date (written before these fields existed) is never folded into ──
  {
    const { deps } = await setup();
    await db.setConnection(PH, { posting_disabled_until_admin: true, posting_halts: [{ at: iso(at(0)), code: "captcha" }] });
    const r = await H.haltAccount(PH, "captcha", deps, { now: at(1) });
    assert.ok(!r.duplicate, "fail-safe: a halt that cannot be tied to the current disable is new");
    assert.equal((await conn()).posting_disabled_class, "captcha");
  }

  // ── the same rule for penalties: the penalty must be the halt's own, set by it or later ──
  {
    const { deps, notes } = await setup();
    let r = await H.haltAccount(PH, "rate_limited", deps, { now: at(0) });
    let k = await conn();
    assert.equal(k.posting_penalty_class, "rate_limited");
    assert.equal(k.posting_penalty_at, iso(at(0)));
    r = await H.haltAccount(PH, "rate_limited", deps, { now: at(1) });
    assert.equal(r.duplicate, true, "its own penalty still runs: the same halt");
    // the operator lifts the penalty; a feature_blocked sets a new one
    await db.setConnection(PH, { posting_penalty_until: null });
    r = await H.haltAccount(PH, "feature_blocked", deps, { now: at(2) });
    assert.ok(!r.duplicate);
    k = await conn();
    assert.equal(k.posting_penalty_class, "feature_blocked");
    const n0 = notes.length;
    r = await H.haltAccount(PH, "rate_limited", deps, { now: at(3) });
    assert.ok(!r.duplicate, "the running penalty is feature_blocked's, not the earlier rate_limited's");
    assert.ok(r.penalty_until);
    k = await conn();
    assert.equal(k.posting_penalty_class, "rate_limited");
    assert.equal(k.posting_penalty_at, iso(at(3)));
    assert.equal(k.posting_halts.filter((h) => h.code === "rate_limited").length, 2);
    assert.ok(notes.length > n0, "the agent is told");
    // a second removal in 7 days penalises the account: that penalty is confirmed_removed's
    await setup();
    await H.haltAccount(PH, "confirmed_removed", deps, { group_id: "111", now: at(0) });
    r = await H.haltAccount(PH, "confirmed_removed", deps, { group_id: "222", now: at(1) });
    assert.ok(r.penalty_until);
    assert.equal((await conn()).posting_penalty_class, "confirmed_removed");
    // a penalty with no class (written before these fields existed) is never folded into
    await setup();
    await db.setConnection(PH, { posting_penalty_until: iso(at(24 * 14)), posting_halts: [{ at: iso(at(0)), code: "rate_limited" }] });
    assert.ok(!(await H.haltAccount(PH, "rate_limited", deps, { now: at(1) })).duplicate);
  }

  // ── every halt is stamped with the clock as it runs, not the tick's start: the post took minutes ──
  {
    const { deps, at: setAt, clk } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, setAt(NOW));
    const due = dueOf(c);
    const inner = fakePost("verified_failed:checkpoint");
    const slow = async (args, d) => { clk.t = new Date(clk.t.getTime() + 7 * MIN); return inner(args, d); };
    c = await S.tick(c, with_(deps, { post: slow }), setAt(due));
    const k = await conn();
    const stamp = iso(due.getTime() + 7 * MIN);
    assert.deepEqual(k.posting_halts.map((h) => [h.code, h.at]), [["checkpoint", stamp]]);
    assert.equal(k.posting_disabled_at, stamp);
    assert.equal(k.posting_last_halt_at, stamp);
  }

  // ── … and not the sweep's start: the reconcile session took minutes ──
  {
    const { deps, at: setAt, clk } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, setAt(NOW));
    const crash = async (args, d) => { for (const s of ["session_started", "composer_ready", "submit_started"]) await d.attempts.transition(args.attempt.key, s); return { noop: true }; };
    c = await S.tick(c, with_(deps, { post: crash }), setAt(dueOf(c)));
    const later = new Date(dueOf(c).getTime() + 25 * MIN);
    await S.sweep(deps, setAt(later));
    assert.equal((await store.getAttempt(c.posts[0].attempt_key)).state, "outcome_unknown");
    const start = new Date(later.getTime() + MIN);
    const reconcile = async () => { clk.t = new Date(clk.t.getTime() + 5 * MIN); return { state: "outcome_unknown", error_code: "restricted", signal: "restricted" }; };
    await S.sweep(with_(deps, { reconcile }), setAt(start));
    const k = await conn();
    const stamp = iso(start.getTime() + 5 * MIN);
    assert.deepEqual(k.posting_halts.map((h) => [h.code, h.at]), [["restricted", stamp]]);
    assert.equal(k.posting_disabled_at, stamp);
    assert.equal(k.posting_last_halt_at, stamp);
  }

  // ── (posting-sweeper.js; its test file is at its line budget) Task 21 fix round 1: the breaker's CAS uses the version it counted from, so an
  //    operator turning posting on between its read and its write is not undone ──
  {
    const { deps, at, ops } = await setup();
    await C.create(base(), deps);
    const t = iso(NOW.getTime() - 30 * MIN);
    for (const ph of ["9725041", "9725042", "9725043"]) await db.setConnection(ph, { posting_halts: [{ at: t, code: "checkpoint" }], posting_last_halt_at: t });
    let raced = false;
    const racing = Object.assign({}, db, { setSetting: async (k, v, o) => {
      if (k === "posting" && o && o.expectVersion !== undefined && !raced) {
        raced = true; // the operator's switch-on lands first
        await db.setSetting("posting", { enabled: true, enabled_at: iso(NOW), reason: "operator back on" });
      }
      return db.setSetting(k, v, o);
    } });
    assert.equal(await S.sweep(with_(deps, { db: racing }), at(NOW)), 0, "stale count: nothing ticked this sweep");
    assert.ok(raced);
    const s = await db.getSetting("posting");
    assert.equal(s.enabled, true, "the operator's switch-on is not undone");
    assert.equal(s.reason, "operator back on");
    assert.equal(ops.filter((m) => /FLEET BREAKER/.test(m)).length, 0);
    assert.equal(await S.sweep(deps, at(NOW)), 1, "recounted from the new enabled_at: the breaker stays closed");
    assert.equal((await db.getSetting("posting")).enabled, true);
  }

  console.log("posting-halts.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
