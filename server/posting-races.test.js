/* STOP racing a tick, and the profile lock around a hung driver (16b fix
   rounds 1–2). Same fixtures as posting-sweeper.test.js. */
const assert = require("assert");
const K = require("./posting-testkit");
const C = require("./posting-campaign");
const S = require("./posting-sweeper");
const guardLive = require("./posting-guard");

const { store, locks, NOW, page, base, dueOf, setup, fakePost } = K;
const PH = "972500000001";
const with_ = (deps, o) => Object.assign({}, deps, o);

(async () => {
  // ── STOP racing a reservation (fix round 1): stop lands after reserveAttempt
  //    but before startAttempt's commit → the attempt is cancelled, never run ──
  {
    const { deps, at } = await setup();
    const A = require("./posting-account");
    A.drainCancelFailures();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    const racing = Object.assign({}, store, { reserveAttempt: async (input) => { const r = await store.reserveAttempt(input); await C.stop(c.id, deps); return r; } });
    c = await S.tick(c, with_(deps, { store: racing }), at(dueOf(c)));
    const [a] = await store.listAttemptsByPhone(PH);
    assert.equal(a.state, "cancelled", "no attempt past composer_ready");
    assert.equal(a.error_code, "stopped");
    assert.equal(deps.post.calls.length, 0, "zero driver calls");
    assert.equal(c.status, "stopped");
    assert.equal(c.posts[0].status, "skipped");
    assert.equal(A.drainCancelFailures(), 0, "the tick's own cancel of an already-cancelled attempt is not a failure");
  }
  // …and the reviewer's case: STOP read the campaign before startAttempt committed, and lands during the post
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    const stale = await store.getPostingCampaign(c.id);
    const inner = fakePost();
    const post = async (args, d) => {
      const staleStore = Object.assign({}, store, { getPostingCampaign: async () => structuredClone(stale) });
      await C.stop(c.id, with_(deps, { store: staleStore }));
      return inner(args, d);
    };
    c = await S.tick(c, with_(deps, { post }), at(dueOf(c)));
    const a = await store.getAttempt(c.posts[0].attempt_key);
    assert.equal(a.state, "cancelled", "the stop cancelled the committed posting post's attempt");
    assert.deepEqual(a.history.map((h) => h.state), ["reserved", "cancelled"], "nothing past reserved");
    assert.equal(c.status, "stopped");
    assert.equal(c.posts[0].status, "skipped", "no post stays posting");
    // schedulePost never appends to a campaign stopped after its read
    const staleRunning = Object.assign({}, store, { getPostingCampaign: async () => Object.assign(structuredClone(stale), { status: "running", posts: [] }) });
    const r = await C.schedulePost({ campaignId: c.id, target: "group", group_id: "222", at: NOW }, with_(deps, { store: staleRunning }), NOW);
    assert.equal(r.status, "stopped");
    assert.equal((await store.getPostingCampaign(c.id)).posts.length, 1);
  }

  // ── fix round 2: STOP returns after startAttempt committed `posting`, before
  //    the driver is called → the driver is never called ──
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    let stopReturned = false, callsAfterStop = 0;
    const inner = fakePost();
    const post = async (args, d) => { if (stopReturned) callsAfterStop++; return inner(args, d); };
    const guard = { assertFleetAllowed: guardLive.assertFleetAllowed, assertAllowed: async (o, d) => {
      if (o.action === "session") { await C.stop(c.id, deps); stopReturned = true; }
      return guardLive.assertAllowed(o, d);
    } };
    c = await S.tick(c, with_(deps, { post, guard }), at(dueOf(c)));
    assert.ok(stopReturned);
    assert.equal(callsAfterStop, 0, "0 driver calls after STOP returned");
    assert.equal(inner.calls.length, 0);
    const a = await store.getAttempt(c.posts[0].attempt_key);
    assert.deepEqual(a.history.map((h) => h.state), ["reserved", "cancelled"]);
    assert.equal(c.status, "stopped");
    assert.equal(c.posts[0].status, "skipped");
  }

  // ── fix round 2: the attempt listing fails → STOP still cancels the committed
  //    doc's attempt, mirrors the post, and tells the agent ──
  {
    const { deps, at, notes } = await setup();
    const A = require("./posting-account");
    A.drainCancelFailures();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    const broken = Object.assign({}, store, { listOpenAttemptsByCampaign: async () => { throw Object.assign(new Error("index"), { code: "failed-precondition" }); } });
    let clicked = false, stopErr = null;
    const post = async (args, d) => {
      const k = args.attempt.key;
      await d.attempts.transition(k, "session_started");
      try { await C.stop(c.id, with_(deps, { store: broken })); } catch (e) { stopErr = e; }
      await d.attempts.transition(k, "composer_ready");
      await d.attempts.transition(k, "submit_started");
      clicked = true;
      return "verified_posted";
    };
    c = await S.tick(c, with_(deps, { post }), at(dueOf(c)));
    assert.equal(stopErr, null, "stop does not throw");
    assert.equal(clicked, false, "the driver's next transition is refused: no click");
    assert.equal((await store.getAttempt(c.posts[0].attempt_key)).state, "cancelled");
    assert.equal(c.status, "stopped");
    assert.equal(c.posts[0].status, "skipped");
    assert.ok(notes.some((n) => /נעצר/.test(n)), "the stop notification is sent");
    assert.equal(A.drainCancelFailures(), 1, "the failed listing counts as a cancel failure");
  }

  // ── fix round 2: a hung driver keeps the profile lock after the timeout settles
  //    the attempt; the next tick for the phone sees profile_busy ──
  {
    const { deps, at } = await setup();
    const T = require("./posting-tick");
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    const never = async (args, d) => { await d.attempts.transition(args.attempt.key, "session_started"); return new Promise(() => {}); };
    c = await S.tick(c, with_(deps, { post: never, postTimeoutMs: 20 }), at(dueOf(c)));
    const settled = await store.getAttempt(c.posts[0].prior_attempt_keys[0]);
    assert.deepEqual([settled.state, settled.error_code], ["cancelled", "infrastructure"], "settled at the timeout");
    assert.equal(c.posts[0].status, "scheduled");
    assert.equal(locks.isHeld(PH), true, "the lock outlives the timeout while the driver may still hold the browser");
    assert.equal(await T.tickAccount(PH, deps, at(new Date(dueOf(c).getTime()))), "profile_busy", "the next tick skips, without error");

    // a driver that settles late gives the lock back when it does
    await setup();
    let late = await C.create(base(), deps);
    late = await S.tick(late, deps, at(NOW));
    let finish;
    const slow = async (args, d) => { await d.attempts.transition(args.attempt.key, "session_started"); return new Promise((r) => { finish = r; }); };
    await S.tick(late, with_(deps, { post: slow, postTimeoutMs: 20 }), at(dueOf(late)));
    assert.equal(locks.isHeld(PH), true);
    finish("verified_posted");
    await new Promise((r) => setImmediate(r));
    assert.equal(locks.isHeld(PH), false, "released when the driver finally settled");
  }

  // ── fix round 2: an agent STOP after page_gone overwrites the reason, so enrollment never restarts it ──
  {
    const { deps } = await setup();
    const c = await C.enrollNewPage(page(), deps);
    await store.updatePostingCampaign(c.id, { status: "stopped", pause_reason: "page_gone" });
    const s2 = await C.stop(c.id, deps);
    assert.equal(s2.pause_reason, "agent");
    assert.equal((await C.enrollNewPage(page(), deps)).status, "stopped");
    await C.stop(c.id, deps, "page_gone");
    assert.equal((await store.getPostingCampaign(c.id)).pause_reason, "agent", "an agent reason is never overwritten");
  }

  // ── the post timeout stays clearly below the profile lock's hold ──
  assert.ok(require("./posting-tick").POST_TIMEOUT_MS < locks.MAX_HOLD_MS, "a hung driver call is settled while the lock is still ours");

  console.log("posting-races.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
