/* posting-sweeper.js / posting-tick.js / posting-halts.js — attempts through
   their durable states (R1), the kill switch at every step (R2), halts per
   class (R5), the fleet breaker, reaping and its health record. The driver
   is a fake that walks the attempt's states; Driver itself is a fake. */
const assert = require("assert");
const K = require("./posting-testkit");
const C = require("./posting-campaign");
const S = require("./posting-sweeper");
const H = require("./posting-halts");
const guardLive = require("./posting-guard");

const { db, store, locks, NOW, MIN, HOUR, DAY, iso, cfg, page, base, dueOf, setup, fakePost } = K;
const PH = "972500000001";
const with_ = (deps, o) => Object.assign({}, deps, o);
const conn = async (ph = PH) => (await db.getConnection(ph)) || {};

(async () => {
  // ── a checkpoint DISABLES the account and quarantines the profile; every campaign pauses ──
  {
    const { deps, at, notes, ops } = await setup();
    await db.savePage(page("pg2"));
    let c = await C.create(base(), deps);
    const other = await C.create(base({ page: page("pg2") }), deps);
    c = await S.tick(c, deps, at(NOW));
    c = await S.tick(c, with_(deps, { post: fakePost("verified_failed:checkpoint") }), at(dueOf(c)));
    assert.equal(c.status, "paused");
    assert.equal(c.pause_reason, "account");
    assert.equal(c.posts[0].status, "failed");
    assert.equal(c.posts[0].error_code, "checkpoint");
    const k = await conn();
    assert.equal(k.posting_disabled_until_admin, true);
    assert.deepEqual(k.posting_halts.map((h) => h.code), ["checkpoint"]);
    assert.ok(k.posting_last_halt_at);
    assert.equal(k.facebook_profile_state, "quarantined", "captcha/checkpoint quarantine the profile");
    assert.equal((await store.getPostingCampaign(other.id)).status, "paused", "the other campaign on the account pauses too");
    assert.ok(notes.some((m) => /פייסבוק/.test(m)), "the agent hears about it on WhatsApp");
    assert.ok(ops.some((m) => /disabled/.test(m) && !m.includes(PH)), "the operator is told, with no full phone");
    assert.equal((await C.resume(c.id, deps)).status, "paused", "the agent cannot resume a disabled account");
    // a pre-submit verified_failed released its reservation (R1)
    assert.equal((await store.getAttempt(c.posts[0].attempt_key)).released, true);
  }

  // ── haltAccount per class (R5) ──
  {
    const { deps, at } = await setup();
    const c = await C.create(base(), deps);
    let r = await H.haltAccount(PH, "rate_limited", deps, { now: NOW });
    assert.equal(r.penalty_until, iso(NOW.getTime() + 14 * DAY));
    assert.ok(!(await conn()).posting_disabled_until_admin);
    assert.equal((await store.getPostingCampaign(c.id)).status, "running", "a penalty slows the account; campaigns keep running");
    r = await H.haltAccount(PH, "feature_blocked", deps, { now: NOW });
    assert.ok(r.penalty_until && !r.disabled);

    r = await H.haltAccount(PH, "restricted", deps, { now: NOW });
    assert.equal(r.disabled, true);
    assert.equal(r.owner_review, false);
    assert.notEqual((await conn()).facebook_profile_state, "quarantined", "restricted: disabled, profile kept");
    r = await H.haltAccount(PH, "captcha", deps, { now: new Date(NOW.getTime() + 5 * DAY) });
    assert.equal(r.owner_review, true, "a second disabling halt within 30 days → owner review");
    assert.equal((await conn()).posting_owner_review_required, true);
    assert.equal((await conn()).facebook_profile_state, "quarantined");

    await setup();
    const c2 = await C.create(base(), deps);
    r = await H.haltAccount(PH, "login_required", deps, { now: NOW });
    assert.equal(r.reconnect, true);
    assert.equal(r.penalty_until, null, "login_required: no penalty");
    assert.equal((await conn()).facebook_needs_reconnect, true);
    assert.equal((await store.getPostingCampaign(c2.id)).pause_reason, "account");
    assert.equal((await C.resume(c2.id, deps)).status, "paused", "not before the agent reconnects");
    await db.setConnection(PH, { facebook_browser_connected_at: iso(Date.now() + DAY) });
    assert.equal((await C.resume(c2.id, deps)).status, "running", "after a reconnect the agent may resume");

    for (let i = 1; i <= 3; i++) {
      r = await H.haltAccount(PH, "selector_failure", deps, { campaignId: c2.id, now: NOW });
      assert.equal(r.campaign_paused, i === 3);
    }
    assert.equal((await store.getPostingCampaign(c2.id)).pause_reason, "internal", "3 selector failures pause the campaign");

    r = await H.haltAccount(PH, "confirmed_removed", deps, { group_id: "111", now: NOW });
    assert.equal(r.penalty_until, null);
    assert.ok((await conn()).posting_group_penalties["111"].until > iso(NOW.getTime() + 29 * DAY));
    r = await H.haltAccount(PH, "confirmed_removed", deps, { group_id: "222", now: new Date(NOW.getTime() + 2 * DAY) });
    assert.ok(r.penalty_until, "two removals in 7 days → account penalty");

    await setup();
    r = await H.haltAccount(PH, "suspected_compromise", deps, { now: NOW });
    assert.equal(r.disabled, true);
    assert.equal((await conn()).facebook_profile_state, "revoked");
    await assert.rejects(H.haltAccount(PH, "bogus", deps), (e) => e.code === "invalid_input");
    void at;
  }

  // ── rate_limited from the driver: penalty, campaign keeps running ──
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    c = await S.tick(c, with_(deps, { post: fakePost("verified_failed:rate_limited") }), at(dueOf(c)));
    const k = await conn();
    assert.ok(k.posting_penalty_until && !k.posting_disabled_until_admin);
    assert.equal(c.status, "running");
  }

  // ── pending admin approval is its own outcome: counted, not a failure ──
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    c = await S.tick(c, with_(deps, { post: fakePost("submitted_for_approval") }), at(dueOf(c)));
    assert.equal(c.posts[0].status, "pending_group_approval");
    assert.equal(c.consecutive_failures, 0);
    assert.equal((await store.getAttempt(c.posts[0].attempt_key)).state, "submitted_for_approval");
  }

  // ── an infrastructure failure (Driver 503) is not the agent's: released, retried another day ──
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    c = await S.tick(c, with_(deps, { post: fakePost({ throwAt: "reserved", err: Object.assign(new Error("cap"), { status: 503 }) }) }), at(dueOf(c)));
    const a = await store.getAttempt(c.posts[0].prior_attempt_keys[0]);
    assert.equal(a.state, "cancelled");
    assert.equal(a.released, true, "the budget and bucket are given back");
    assert.equal(c.posts[0].status, "scheduled", "rescheduled, not failed");
    assert.equal(K.safety.jerusalemDate(c.posts[0].scheduled_at), "2026-09-24", "today's key is used; tomorrow");
    assert.equal(c.wait_reason, "infrastructure");
    assert.equal(c.status, "running");
    assert.equal(c.consecutive_failures, 0);
    c = await S.tick(c, deps, at(dueOf(c)));
    assert.equal(c.posts[0].status, "posted", "tomorrow it goes out");
  }

  // ── consecutive real failures trip the breaker ──
  {
    const { deps, at } = await setup();
    const bad = with_(deps, { post: fakePost("verified_failed:post_failed") });
    let c = await C.create(base(), deps);
    for (let i = 0; i < 2; i++) {
      c = await S.tick(c, bad, at(new Date(NOW.getTime() + i * DAY)));
      c = await S.tick(c, bad, at(dueOf(c, i)));
    }
    assert.equal(c.status, "paused");
    assert.equal(c.pause_reason, "consecutive_failures");
  }

  // ── a reservation refused (daily_cap, group_cap, duplicate) leaves the post scheduled for a later slot ──
  for (const reason of ["daily_cap", "group_cap", "duplicate"]) {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(new Date("2026-09-23T07:00:00+03:00"))); // planned for 09:00
    const lim = { daily_cap: 9, group_global_daily_cap: 9 };
    if (reason === "daily_cap") await store.reserveAttempt({ phone: PH, page_id: "other", target_type: "group", target_id: "999", publisher: "browser", limits: lim, now: new Date("2026-09-23T06:30:00+03:00") });
    if (reason === "group_cap") for (const ph of ["9725001", "9725002", "9725003"]) await store.reserveAttempt({ phone: ph, page_id: `p${ph}`, target_type: "group", target_id: "111", publisher: "browser", limits: lim, now: NOW });
    if (reason === "duplicate") await store.reserveAttempt({ phone: PH, page_id: "pg1", target_type: "group", target_id: "111", publisher: "browser", limits: lim, now: new Date(NOW.getTime() - 20 * DAY) });
    c = await S.tick(c, deps, at(dueOf(c)));
    assert.equal(c.posts[0].status, "scheduled", `${reason}: still scheduled, not failed`);
    assert.equal(c.posts[0].retries, 1);
    assert.equal(c.wait_reason, reason);
    assert.ok(new Date(c.posts[0].scheduled_at) > dueOf({ posts: [{ scheduled_at: "2026-09-23T23:00:00+03:00" }] }), "a later day");
    assert.equal(deps.post.calls.length, 0);
  }

  // ── the kill switch flipped between reserve and session → the attempt is cancelled ──
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    const flip = { assertAllowed: async (o, d) => { if (o.action === "session") await db.setSetting("posting", { enabled: false }); return guardLive.assertAllowed(o, d); }, assertFleetAllowed: guardLive.assertFleetAllowed };
    c = await S.tick(c, with_(deps, { guard: flip }), at(dueOf(c)));
    const a = await store.getAttempt(c.posts[0].attempt_key);
    assert.equal(a.state, "cancelled");
    assert.equal(a.error_code, "posting_disabled");
    assert.equal(a.reason, "global_off");
    assert.equal(c.posts[0].status, "skipped");
    assert.equal(deps.post.calls.length, 0, "no session was opened");
  }

  // ── the guard at the Post click (inside the driver) before submit → cancelled, never posted ──
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    const post = async (args, d) => { await d.attempts.transition(args.attempt.key, "session_started"); await d.attempts.transition(args.attempt.key, "composer_ready"); await db.setSetting("posting", { platforms: { facebook: false } }); await d.guard("post"); };
    c = await S.tick(c, with_(deps, { post }), at(dueOf(c)));
    assert.equal((await store.getAttempt(c.posts[0].attempt_key)).state, "cancelled");
  }

  // ── crash after submit_started → reaper → outcome_unknown → never re-submitted; reconciled once ──
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    // The process dies mid-post: the driver got as far as the click.
    const crash = async (args, d) => { for (const s of ["session_started", "composer_ready", "submit_started"]) await d.attempts.transition(args.attempt.key, s); return { noop: true }; };
    c = await S.tick(c, with_(deps, { post: crash }), at(dueOf(c)));
    assert.equal(c.posts[0].status, "posting");
    assert.equal((await store.getAttempt(c.posts[0].attempt_key)).state, "submit_started");
    const later = new Date(dueOf(c).getTime() + 25 * MIN);
    await S.sweep(deps, at(later));
    c = await store.getPostingCampaign(c.id);
    assert.equal((await store.getAttempt(c.posts[0].attempt_key)).state, "outcome_unknown");
    assert.equal(c.posts[0].status, "unknown");
    for (let d = 1; d <= 3; d++) await S.sweep(deps, at(new Date(later.getTime() + d * DAY)));
    c = await store.getPostingCampaign(c.id);
    assert.equal(deps.post.calls.filter((a) => a.groupUrl === K.G(111)).length, 0, "group 111 is never submitted again");
    assert.ok(c.posts.every((p, i) => i === 0 || p.group_id !== "111"));
    // one reconciliation session, once: it finds the post and upgrades the attempt
    let seen = 0;
    const reconcile = async (a, d) => { seen++; await d.attempts.transition(a.key, "verified_posted", { post_url: `${K.G(111)}/posts/1` }); };
    await S.sweep(with_(deps, { reconcile }), at(new Date(later.getTime() + 4 * DAY)));
    await S.sweep(with_(deps, { reconcile }), at(new Date(later.getTime() + 4 * DAY + MIN)));
    assert.equal(seen, 1);
    assert.equal((await store.getPostingCampaign(c.id)).posts[0].status, "posted");
  }

  // ── the profile lock is respected: nothing posts while an extract or login holds it ──
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    const release = locks.acquire(PH);
    const held = await S.tick(c, deps, at(dueOf(c)));
    assert.equal(held.posts[0].status, "scheduled");
    assert.equal(deps.post.calls.length, 0);
    release();
  }

  // ── browse-only (warm-up) days run one dwell session a day, not a post ──
  {
    const { deps, at } = await setup(PH, { conn: { facebook_browser_first_connected_at: iso(NOW.getTime() - DAY) } });
    let dwelt = 0;
    const d2 = with_(deps, { dwell: async (o) => { dwelt++; assert.equal(o.note, "forly-dwell:", "no phone in a Driver note"); return { log: [], signal: null }; } });
    let c = await C.create(base(), d2);
    c = await S.tick(c, d2, at(NOW));
    c = await S.tick(c, d2, at(new Date(NOW.getTime() + HOUR)));
    assert.equal(c.posts.length, 0);
    assert.equal(dwelt, 1, "one browse session today");
    assert.equal(c.wait_reason, "browse_only");
  }

  // ── the kill switch: nothing but reaping happens while it is off ──
  {
    const { deps, at } = await setup();
    const c = await C.create(base(), deps);
    await db.setSetting("posting", { enabled: false });
    assert.equal(await S.sweep(deps, at(NOW)), 0);
    assert.equal((await store.getPostingCampaign(c.id)).posts.length, 0);
    assert.equal(await S.sweep(with_(deps, { env: { POSTING_ENABLED: "0" } }), at(NOW)), 0);
    await db.setSetting("posting", { enabled: true });
    assert.equal(await S.sweep(deps, at(NOW)), 1);
    assert.equal((await store.getPostingCampaign(c.id)).posts.length, 1);
  }

  // ── the fleet breaker: three accounts disabled within the hour → the switch goes off (CAS) ──
  {
    const { deps, at, ops } = await setup();
    const t = iso(NOW.getTime() - 10 * MIN);
    for (const ph of ["9725011", "9725012"]) await db.setConnection(ph, { posting_halts: [{ at: t, code: "checkpoint" }], posting_last_halt_at: t });
    await db.setConnection("9725013", { posting_halts: [{ at: t, code: "rate_limited" }], posting_last_halt_at: t });
    await S.sweep(deps, at(NOW));
    assert.equal((await db.getSetting("posting")).enabled, true, "a penalty is not a disabling halt: 2 < 3");
    await db.setConnection("9725014", { posting_halts: [{ at: t, code: "captcha" }], posting_last_halt_at: t });
    const before = (await db.getSetting("posting")).version;
    assert.equal(await S.sweep(deps, at(NOW)), 0);
    const s = await db.getSetting("posting");
    assert.equal(s.enabled, false);
    assert.equal(s.disabled_reason, "fleet_breaker");
    assert.equal(s.version, before + 1, "one compare-and-set write");
    assert.equal(ops.filter((m) => /FLEET BREAKER/.test(m)).length, 1);
  }

  // ── reaper failures and cancel failures are recorded in settings/posting_health ──
  {
    const { deps, at } = await setup();
    const lim = { daily_cap: 9, group_global_daily_cap: 9 };
    const v = (await store.reserveAttempt({ phone: PH, page_id: "x", target_type: "group", target_id: "1", publisher: "browser", limits: lim, now: NOW })).attempt;
    const badKey = "e".repeat(32);
    const bad = Object.assign(structuredClone(store._test.maps.posting_attempts.get(v.key)), { key: badKey });
    delete bad.budget_key;
    store._test.maps.posting_attempts.set(badKey, bad);
    const failing = Object.assign({}, store, { cancelOpenAttempts: async () => { throw Object.assign(new Error("x"), { code: "cancel_incomplete", cancelled: 0, failures: [{ key: badKey, error_code: "corrupt_attempt" }] }); } });
    await H.haltAccount(PH, "restricted", with_(deps, { store: failing }), { now: NOW });
    await S.sweep(deps, at(new Date(NOW.getTime() + 25 * MIN)));
    const h = await db.getSetting("posting_health");
    assert.deepEqual(h.reap_failures.map((f) => [f.key_tail, f.error_code]), [["eeeeee", "corrupt_attempt"]]);
    assert.equal(h.cancel_failures_count, 1);
    const first = h.reap_failures[0].first_seen_at;
    await S.sweep(deps, at(new Date(NOW.getTime() + 30 * MIN)));
    assert.equal((await db.getSetting("posting_health")).reap_failures[0].first_seen_at, first, "first_seen_at is kept");
    assert.equal((await store.getAttempt(v.key)).state, "cancelled", "the valid attempt was still reaped");
  }

  // ── at most one stale group sync per sweep, behind the lock, only for opted-in accounts ──
  {
    const { deps, at } = await setup(PH, { conn: { facebook_groups_synced_at: null } });
    await db.setConnection("9725021", { facebook_browser_connected_at: iso(NOW), posting_permission: K.PERM });
    await db.setConnection("9725022", { facebook_browser_connected_at: iso(NOW) }); // not opted in
    const synced = [];
    const groupsSync = { isStale: require("./facebook-groups-sync").isStale, runSync: async ({ phone }, d) => { assert.equal(d.lockHeld, true); assert.ok(locks.isHeld(phone)); synced.push(phone); } };
    await S.sweep(with_(deps, { groupsSync }), at(NOW));
    assert.equal(synced.length, 1);
    await S.sweep(with_(deps, { groupsSync }), at(new Date(NOW.getTime() + MIN)));
    assert.equal(synced.length, 2);
    assert.notEqual(synced[0], synced[1]);
    await S.sweep(with_(deps, { groupsSync }), at(new Date(NOW.getTime() + 2 * MIN)));
    assert.equal(synced.length, 2, "a tried account waits before the next try; the un-opted one is never synced");
  }

  // ── a driver that never returns is settled after postTimeoutMs; a post whose
  //    attempt vanished never holds the account; repeated tick errors pause `internal` ──
  {
    const { deps, at } = await setup();
    let c = await C.create(base(), deps);
    c = await S.tick(c, deps, at(NOW));
    const hang = async (args, d) => { await d.attempts.transition(args.attempt.key, "session_started"); return new Promise(() => {}); };
    c = await S.tick(c, with_(deps, { post: hang, postTimeoutMs: 20 }), at(dueOf(c)));
    assert.equal((await store.getAttempt(c.posts[0].prior_attempt_keys[0])).error_code, "infrastructure");
    assert.equal(c.posts[0].status, "scheduled", "pre-submit timeout: retried another day");

    await setup();
    let o = await C.create(base(), deps);
    o = await S.tick(o, deps, at(NOW));
    await store.updatePostingCampaign(o.id, { posts: [Object.assign({}, o.posts[0], { status: "posting", attempt_key: "a".repeat(32) })] });
    o = await S.tick(o, deps, at(new Date(NOW.getTime() + MIN)));
    assert.equal(o.posts[0].status, "unknown");
    assert.equal(o.posts[0].error_code, "attempt_missing");

    await setup();
    const e = await C.create(base(), deps);
    const broken = with_(deps, { config: null, db: Object.assign({}, db, { getSetting: async () => { throw Object.assign(new Error("down"), { code: "unavailable" }); } }) });
    for (let i = 0; i < 3; i++) await S.tick(e, broken, at(NOW));
    const after = await store.getPostingCampaign(e.id);
    assert.equal(after.status, "paused");
    assert.equal(after.pause_reason, "internal");
  }

  // ── liveDeps never requires a module that does not exist yet ──
  {
    const live = S.liveDeps({ pageBaseUrl: "https://f.ly" });
    assert.equal(typeof live.post, "function");
    const fs = require("fs");
    if (!fs.existsSync(require("path").join(__dirname, "posting-driver.js"))) assert.deepEqual(await live.post({}, {}), { noop: true });
    assert.equal(S._test.optionalFn("./no-such-module", "x"), null);
  }

  console.log("posting-sweeper.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
