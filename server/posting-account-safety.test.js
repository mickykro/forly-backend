/* The account-safety rules that cut across the posting modules (final fix
   wave, area B): a withdrawn consent stops every session (I10), the agent's
   open login browser keeps everything else off the profile (F3), a stale
   membership never completes a campaign (I3), and failed or deferred
   profile deletes are retried by the sweep and escalated (I1). Real db
   (memory), store, guard and lifecycle; the driver and Driver are fakes. */
const assert = require("assert");
const K = require("./posting-testkit");
const C = require("./posting-campaign");
const S = require("./posting-sweeper");
const R = require("./posting-recheck");
const T = require("./posting-tick");

const { db, store, NOW, MIN, HOUR, DAY, iso, base, dueOf, setup } = K;
const PH = "972500000001";
const with_ = (deps, o) => Object.assign({}, deps, o);

// A campaign whose one post went out, re-check due a day later.
async function postedCampaign() {
  const w = await setup();
  let c = await C.create(base({ groups: [{ url: K.G(111), name: "A", agent_policy: "explicitly_allowed" }] }), w.deps);
  c = await S.tick(c, w.deps, w.at(NOW));
  c = await S.tick(c, w.deps, w.at(dueOf(c)));
  assert.equal(c.posts[0].status, "posted");
  return Object.assign(w, { c });
}
// A campaign whose one post is outcome_unknown (a crash after the click).
async function unknownCampaign() {
  const w = await setup();
  let c = await C.create(base({ groups: [{ url: K.G(111), name: "A", agent_policy: "explicitly_allowed" }] }), w.deps);
  c = await S.tick(c, w.deps, w.at(NOW));
  const crash = async (args, d) => { for (const s of ["session_started", "composer_ready", "submit_started"]) await d.attempts.transition(args.attempt.key, s); return { noop: true }; };
  c = await S.tick(c, with_(w.deps, { post: crash }), w.at(dueOf(c)));
  const later = new Date(dueOf(c).getTime() + 25 * MIN);
  S._test.reset();
  await S.sweep(w.deps, w.at(later));
  const key = (await store.getPostingCampaign(c.id)).posts[0].attempt_key;
  assert.equal((await store.getAttempt(key)).state, "outcome_unknown");
  return Object.assign(w, { c, key, later });
}
const recheckDeps = (deps, opened) => with_(deps, { withPage: async (o, fn) => { opened.push(o.note); return fn({}); }, recheckPost: async () => ({ state: "visible", reactions: 1, comments: 0, signal: "ok" }) });
const loginNow = (t) => ({ browser_session_facebook: { session_id: "login1", started_at: iso(t) } });

(async () => {
  // ── I10: the agent revoked consent → the 24 h re-check opens nothing on their profile ──
  {
    const { deps, at } = await postedCampaign();
    await db.setConnection(PH, { posting_permission: { enabled: false, revoked_at: iso(NOW) } });
    const opened = [];
    const t = new Date(NOW.getTime() + 2 * DAY);
    assert.equal(await R.recheckOne(recheckDeps(deps, opened), at(t)), "skipped");
    assert.deepEqual(opened, [], "no session after a revoke");
    const a = (await store.listAttemptsByPhone(PH))[0];
    assert.ok(Date.parse(a.recheck_due_at) >= t.getTime() + 23 * HOUR, "deferred, not looked at");
    // consent given again: the re-check runs
    await db.setConnection(PH, { posting_permission: structuredClone(K.PERM) });
    assert.equal(await R.recheckOne(recheckDeps(deps, opened), at(new Date(t.getTime() + 2 * DAY))), "rechecked");
    assert.equal(opened.length, 1);
  }

  // ── I10: …and reconcile of an outcome_unknown attempt does not run after the agent revoked:
  //    no session, the attempt stays outcome_unknown for operator review ──
  {
    const { deps, at, key, later } = await unknownCampaign();
    await C.revokePermission(PH, deps);
    await db.setConnection(PH, { posting_permission: { enabled: false, revoked_at: iso(later) } });
    let ran = 0;
    S._test.reset();
    await S.sweep(with_(deps, { reconcile: async () => { ran++; return { state: "outcome_unknown" }; } }), at(new Date(later.getTime() + HOUR)));
    assert.equal(ran, 0, "the agent's profile is not opened, not even to look");
    const a = await store.getAttempt(key);
    assert.equal(a.state, "outcome_unknown", "left for the operator");
    assert.equal(a.reconcile_note, "consent_revoked");
  }

  // ── F3: the agent's login browser is open on the profile → no tick, no reconcile, no re-check, no sync ──
  {
    // tick: nothing posts while the login browser is young; it runs once the login is over
    const w = await setup();
    let c = await C.create(base(), w.deps);
    c = await S.tick(c, w.deps, w.at(NOW));
    const due = dueOf(c);
    await db.setConnection(PH, loginNow(new Date(due.getTime() - 5 * MIN)));
    assert.equal(await T.tickAccount(PH, w.deps, w.at(due)), "login_open");
    assert.equal(w.deps.post.calls.length, 0, "no post while the agent is logging in");
    assert.equal(await T.tickAccount(PH, w.deps, w.at(new Date(due.getTime() + 30 * MIN))), "verified_posted", "25 min later the login record is stale");
  }
  {
    const { deps, at, key, later } = await unknownCampaign();
    const t = new Date(later.getTime() + HOUR);
    await db.setConnection(PH, loginNow(new Date(t.getTime() - MIN)));
    let ran = 0;
    const reconcile = async (a, d) => { ran++; await d.attempts.transition(a.key, "verified_posted", { post_url: `${K.G(111)}/posts/1` }); };
    S._test.reset();
    await S.sweep(with_(deps, { reconcile }), at(t));
    assert.equal(ran, 0, "reconcile waits for the login to end");
    assert.equal((await store.getAttempt(key)).state, "outcome_unknown");
    S._test.reset();
    await S.sweep(with_(deps, { reconcile }), at(new Date(t.getTime() + 30 * MIN)));
    assert.equal(ran, 1, "and runs after it");
  }
  {
    const { deps, at } = await postedCampaign();
    const t = new Date(NOW.getTime() + 2 * DAY);
    await db.setConnection(PH, loginNow(new Date(t.getTime() - MIN)));
    const opened = [];
    assert.equal(await R.recheckOne(recheckDeps(deps, opened), at(t)), "skipped");
    assert.deepEqual(opened, []);
    assert.equal((await store.listAttemptsByPhone(PH))[0].recheck_tries || 0, 0, "no try used");
    assert.equal(await R.recheckOne(recheckDeps(deps, opened), at(new Date(t.getTime() + 30 * MIN))), "rechecked");
  }
  {
    const w = await setup();
    const t = new Date(NOW.getTime() + 8 * DAY); // the membership list is stale
    await db.setConnection(PH, loginNow(new Date(t.getTime() - MIN)));
    const runs = [];
    const groupsSync = { isStale: () => true, runSync: async (a) => { runs.push(a.phone); return 0; } };
    assert.equal(await S._test.syncOneStale(with_(w.deps, { groupsSync }), require("./posting-account").ctxOf(w.deps), t), false);
    assert.deepEqual(runs, [], "the weekly sync waits for the login to end");
    assert.equal(await S._test.syncOneStale(with_(w.deps, { groupsSync }), require("./posting-account").ctxOf(w.deps), new Date(t.getTime() + 30 * MIN)), true);
    assert.deepEqual(runs, [PH]);
  }

  // ── I3: a sync alone never completes a campaign — a "stale" membership (missing
  //    from one scrape) keeps it running; positive evidence ("left") ends it ──
  {
    const w = await setup();
    let c = await C.create(base({ groups: [{ url: K.G(111), name: "A", agent_policy: "explicitly_allowed" }] }), w.deps);
    const stale = (await db.getConnection(PH)).facebook_groups_member.map((m) => Object.assign({}, m, { membership_state: "stale" }));
    await db.setConnection(PH, { facebook_groups_member: stale });
    await T.tickAccount(PH, w.deps, w.at(NOW));
    c = await store.getPostingCampaign(c.id);
    assert.equal(c.status, "running", "a scrape that missed the group is not the end of the campaign");
    assert.equal(c.groups[0].is_member, false, "…the group is not planned meanwhile");
    assert.equal(c.posts.length, 0);
    await db.setConnection(PH, { facebook_groups_member: stale.map((m) => Object.assign({}, m, { membership_state: "left" })) });
    await T.tickAccount(PH, w.deps, w.at(new Date(NOW.getTime() + MIN)));
    assert.equal((await store.getPostingCampaign(c.id)).status, "completed", "the agent left: genuinely ineligible");
  }

  // ── I1: the sweep retries failed profile deletes once per Jerusalem day (even with
  //    posting off), escalates 7+ days to the operator, and retries a busy-deferred one next sweep ──
  {
    const w = await setup();
    const calls = [];
    let fail = true;
    const driver = { stopSession: async () => {}, deleteProfile: async (n) => { calls.push(n); return fail ? { ok: false, status: 502 } : { ok: true }; } };
    const deps = with_(w.deps, { driver });
    await db.savePendingDelete({ phone: "972500000002", platform: "facebook", since: new Date(Date.now() - 8 * DAY).toISOString(), attempts: 7, last_error: "driver_5xx", gen: 0 });
    await db.setSetting("posting", { enabled: false }); // posting off: deletes still run
    S._test.reset();
    await S.sweep(deps, w.at(NOW));
    assert.equal(calls.length, 1);
    assert.equal((await db.getSetting("posting_health")).last_delete_retry_day, "2026-09-23");
    assert.equal(w.ops.filter((m) => /profile delete/.test(m)).length, 1, "7+ days failing → the operator hears");
    assert.ok(!w.ops.some((m) => m.includes("972500000002")), "no full phone in the notice");
    S._test.reset();
    await S.sweep(deps, w.at(new Date(NOW.getTime() + HOUR)));
    assert.equal(calls.length, 1, "once per Jerusalem day");
    // 23:30 Jerusalem → 00:30 the next day: a new day, even though under 24 h passed
    fail = false;
    S._test.reset();
    await S.sweep(deps, w.at(new Date("2026-09-23T20:30:00Z")));
    assert.equal(calls.length, 1, "still the 23rd in Jerusalem (23:30)");
    S._test.reset();
    await S.sweep(deps, w.at(new Date("2026-09-23T21:30:00Z")));
    assert.equal(calls.length, 2, "00:30 on the 24th: the next day's run");
    assert.deepEqual(await db.listPendingDeletes(), [], "the retry succeeded and cleared the row");
    // a delete deferred because the profile was busy is retried at the next sweep, not tomorrow
    const L = require("./profile-lifecycle");
    const hold = K.locks.acquire("972500000003", "facebook");
    await db.setConnection("972500000003", { facebook_browser_connected_at: iso(NOW) });
    await L.revoke({ phone: "972500000003", platform: "facebook", reason: "agent" }, { db, driver });
    assert.equal(calls.length, 2, "not deleted under the live session");
    assert.equal(L.hasDeferredDeletes(), true);
    hold();
    S._test.reset();
    await S.sweep(deps, w.at(new Date("2026-09-23T21:31:00Z")));
    assert.equal(calls.length, 3, "the next sweep does it");
    assert.deepEqual(await db.listPendingDeletes(), []);
    assert.equal(L.hasDeferredDeletes(), false);
  }

  console.log("posting-account-safety.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
