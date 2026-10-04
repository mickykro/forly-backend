/* posting-reconcile.js — the outcome_unknown lifecycle (I7): bounded
   reconciliation tries (3, 6 h apart) recorded before each session, a Driver
   error waits for the next try instead of ending it, the oldest due first
   (nothing starves behind the first 50 by id), and the operator's verdict,
   which never submits. Real db (memory), store, guard; the reconcile
   session and Driver are fakes. */
const assert = require("assert");
const K = require("./posting-testkit");
const C = require("./posting-campaign");
const S = require("./posting-sweeper");
const R = require("./posting-reconcile");

const { db, store, NOW, MIN, HOUR, DAY, base, dueOf, setup } = K;
const PH = "972500000001";
const with_ = (deps, o) => Object.assign({}, deps, o);
const sweep = async (deps, t) => { S._test.reset(); return S.sweep(deps, t); };

// A campaign whose one post is outcome_unknown (a crash after the click).
async function unknownCampaign() {
  const w = await setup();
  let c = await C.create(base({ groups: [{ url: K.G(111), name: "A", agent_policy: "explicitly_allowed" }] }), w.deps);
  c = await S.tick(c, w.deps, w.at(NOW));
  const crash = async (args, d) => { for (const s of ["session_started", "composer_ready", "submit_started"]) await d.attempts.transition(args.attempt.key, s); return { noop: true }; };
  c = await S.tick(c, with_(w.deps, { post: crash }), w.at(dueOf(c)));
  const later = new Date(dueOf(c).getTime() + 25 * MIN);
  await sweep(w.deps, w.at(later));
  const key = (await store.getPostingCampaign(c.id)).posts[0].attempt_key;
  return Object.assign(w, { c, key, later });
}

(async () => {
  // ── bounded tries: a Driver error schedules the next try (6 h), never a permanent one-shot;
  //    after the third the attempt is left for the operator, who is told once ──
  {
    const { deps, at, key, later, ops } = await unknownCampaign();
    const a0 = await store.getAttempt(key);
    assert.equal(a0.reconcile_tries, 0); assert.ok(a0.next_reconcile_at, "queued the moment it became outcome_unknown");
    let runs = 0;
    const flaky = async () => { runs++; throw Object.assign(new Error("Driver 503: capacity"), { status: 503 }); };
    const d = with_(deps, { reconcile: flaky });
    let t = new Date(later.getTime() + MIN);
    await sweep(d, at(t));
    let a = await store.getAttempt(key);
    assert.equal(runs, 1); assert.equal(a.reconcile_tries, 1);
    assert.equal(a.next_reconcile_at, new Date(t.getTime() + 6 * HOUR).toISOString(), "recorded before the session; the next try in 6 h");
    await sweep(d, at(new Date(t.getTime() + HOUR)));
    assert.equal(runs, 1, "not before the next try is due");
    t = new Date(t.getTime() + 6 * HOUR + MIN);
    await sweep(d, at(t));
    assert.equal(runs, 2); assert.equal((await store.getAttempt(key)).reconcile_tries, 2);
    t = new Date(t.getTime() + 6 * HOUR + MIN);
    await sweep(d, at(t));
    a = await store.getAttempt(key);
    assert.equal(runs, 3); assert.equal(a.reconcile_tries, 3); assert.equal(a.next_reconcile_at, null, "no fourth try: operator review");
    assert.equal(a.state, "outcome_unknown", "never re-submitted, never guessed");
    assert.equal(ops.filter((m) => /outcome_unknown after 3/.test(m)).length, 1);
    await sweep(d, at(new Date(t.getTime() + DAY)));
    assert.equal(runs, 3);
    assert.equal(deps.post.calls.length, 0, "the driver's post was never called again");
  }

  // ── a reconcile that finds the post ends it: the post mirrors verified_posted, the queue is empty ──
  {
    const { deps, at, key, later, c } = await unknownCampaign();
    const found = async (a, d) => { await d.attempts.transition(a.key, "verified_posted", { post_url: `${K.G(111)}/posts/1` }); return { state: "verified_posted" }; };
    await sweep(with_(deps, { reconcile: found }), at(new Date(later.getTime() + MIN)));
    const a = await store.getAttempt(key);
    assert.equal(a.state, "verified_posted"); assert.equal(a.next_reconcile_at, null);
    assert.equal((await store.getPostingCampaign(c.id)).posts[0].status, "posted");
  }

  // ── the kill switch defers without using a try ──
  {
    const { deps, at, key, later } = await unknownCampaign();
    let runs = 0;
    await db.setSetting("posting", { platforms: { facebook: false } });
    await S._test.reconcileOne(with_(deps, { reconcile: async () => { runs++; } }), require("./posting-account").ctxOf(deps), at(new Date(later.getTime() + MIN)));
    const a = await store.getAttempt(key);
    assert.equal(runs, 0); assert.equal(a.reconcile_tries, 0); assert.ok(Date.parse(a.next_reconcile_at) > later.getTime() + 5 * HOUR);
  }

  // ── nothing starves: 50 attempts ahead in id order that cannot be reconciled are
  //    parked (with a note), and the one behind them runs at the next sweep ──
  {
    const { deps, at, key, later } = await unknownCampaign();
    for (let i = 0; i < 50; i++) {
      const r = await store.reserveAttempt({ phone: `97250001${String(i).padStart(4, "0")}`, page_id: `pgz${i}`, target_type: "group", target_id: "555", target_url: K.G(555), publisher: "browser",
        campaign_id: "gone", post_id: "p", now: NOW, limits: { daily_cap: 99, group_global_daily_cap: 99 } });
      for (const s of ["session_started", "composer_ready", "submit_started"]) await store.transition(r.attempt.key, s, {}, NOW);
      await store.transition(r.attempt.key, "outcome_unknown", {}, new Date(NOW.getTime() - HOUR)); // due before ours
    }
    let runs = 0;
    const d = with_(deps, { reconcile: async () => { runs++; return { state: "outcome_unknown" }; } });
    await sweep(d, at(new Date(later.getTime() + MIN)));
    await sweep(d, at(new Date(later.getTime() + 2 * MIN)));
    assert.equal(runs, 1, "ours ran once the 50 ahead were parked");
    assert.equal((await store.getAttempt(key)).reconcile_tries, 1);
    const parked = (await store.listAttemptsByState("outcome_unknown", 100)).filter((a) => a.campaign_id === "gone");
    assert.equal(parked.length, 50); assert.ok(parked.every((a) => a.next_reconcile_at === null && a.reconcile_note === "no_campaign_post"));
  }

  // ── the operator's verdict: only outcome_unknown moves, to verified_posted or
  //    verified_failed, the post mirrors it, and nothing is submitted ──
  {
    const { deps, key, c } = await unknownCampaign();
    const out = await R.resolveUnknown(key, "not_posted", { by: "0001", reason: "checked the group by hand" }, deps);
    assert.equal(out.ok, true);
    const a = await store.getAttempt(key);
    assert.equal(a.state, "verified_failed"); assert.equal(a.error_code, "operator_not_posted"); assert.equal(a.resolved_by_tail, "0001");
    assert.equal(a.next_reconcile_at, null);
    assert.equal((await store.getPostingCampaign(c.id)).posts[0].status, "failed");
    assert.deepEqual(await R.resolveUnknown(key, "posted", { by: "0001", reason: "x" }, deps), { status: 409, error: "not_outcome_unknown", state: "verified_failed" });
    assert.deepEqual(await R.resolveUnknown("f".repeat(64), "posted", { by: "0001", reason: "x" }, deps), { status: 404, error: "not_found" });
    assert.equal(deps.post.calls.length, 0);
    const u2 = await unknownCampaign();
    assert.equal((await R.resolveUnknown(u2.key, "posted", { by: "0009", reason: "found it" }, u2.deps)).attempt.state, "verified_posted");
    assert.equal((await store.getPostingCampaign(u2.c.id)).posts[0].status, "posted");
    const sum = await R.unknownSummary(store, new Date(NOW.getTime() + 2 * DAY));
    assert.equal(sum.count, 0);
  }

  // ── the overview's summary: how many, and the oldest ──
  {
    const { key, later } = await unknownCampaign();
    const sum = await R.unknownSummary(store, new Date(later.getTime() + 5 * HOUR));
    assert.equal(sum.count, 1); assert.equal(sum.count_capped, false); assert.equal(sum.oldest_age_h, 5);
    assert.equal(sum.oldest_items[0].a.key, key);
  }

  console.log("posting-reconcile.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
