/* posting-store.js / posting-attempts.js — memory path. db.init() is never
   called, so require("./db").db stays null. All times derive from fixed
   instants, never Date.now(). */
process.env.PROFILE_KEY = "test-profile-key-16a";
process.env.FORLY_ENV = "local";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const S = require("./posting-store");
const safety = require("./posting-safety");

const T = (iso) => new Date(iso);
const NOW = T("2026-09-23T07:00:00Z"); // 10:00 in Jerusalem
const MIN = 60000, DAY = 86400000;
const limits = { daily_cap: 3, group_global_daily_cap: 3 };
const fp = (s) => safety.fingerprint({ city: "חיפה", street: s, rooms: 4, price: 2000000, size_sqm: 100 });
const res = (o = {}) => Object.assign({
  phone: "972500000001", page_id: "pg1", campaign_id: "c1", post_id: "p1", target_type: "group", target_id: "111",
  target_url: "https://www.facebook.com/groups/111", publisher: "browser", fingerprint: fp("herzl"), copy_hash: "ab12",
  confirm_membership: false, now: NOW, limits,
}, o);
const code = (c) => (e) => e.code === c;
const walk = async (key, states, at = NOW) => { for (const s of states) await S.transition(key, s, {}, at); };

(async () => {
  // ── duplicate reservation; a different Jerusalem date is a different key ──
  {
    S._test.reset();
    const a = await S.reserveAttempt(res());
    assert.equal(a.ok, true);
    assert.equal(a.attempt.state, "reserved");
    assert.equal(a.attempt.key, S.attemptKey({ phone: "972500000001", page_id: "pg1", target_type: "group", target_id: "111", date: NOW }));
    assert.ok(/^[0-9a-f]{32}$/.test(a.attempt.key));
    assert.deepEqual(await S.getAttempt(a.attempt.key), a.attempt);
    assert.equal(a.attempt.lease_until, new Date(NOW.getTime() + 20 * MIN).toISOString());
    assert.deepEqual(a.attempt.history.map((h) => h.state), ["reserved"]);
    // An orphan (e.g. a commit whose outcome the caller never saw) comes back
    // whole, so the caller can resume, reconcile or cancel it.
    await S.transition(a.attempt.key, "session_started", {}, NOW);
    const again = await S.reserveAttempt(res());
    assert.equal(again.ok, false);
    assert.equal(again.reason, "already_reserved");
    assert.deepEqual(again.attempt, await S.getAttempt(a.attempt.key));
    assert.equal(again.attempt.state, "session_started");
    assert.equal(S._test.maps.posting_budget.get("972500000001|2026-09-23").count, 1, "a refused reservation reserves nothing");
    assert.notEqual(S.attemptKey({ phone: "972500000001", page_id: "pg1", target_type: "group", target_id: "111", date: new Date(NOW.getTime() + DAY) }), a.attempt.key);
    // The same Jerusalem day at another hour is the same key.
    assert.equal(S.attemptKey({ phone: "972500000001", page_id: "pg1", target_type: "group", target_id: "111", date: T("2026-09-23T20:00:00Z") }), a.attempt.key);
  }

  // ── daily cap per phone ──
  {
    S._test.reset();
    for (const g of ["1", "2", "3"]) assert.equal((await S.reserveAttempt(res({ target_id: g }))).ok, true);
    assert.deepEqual(await S.reserveAttempt(res({ target_id: "4" })), { ok: false, reason: "daily_cap" });
    // The next Jerusalem day has its own budget (different group: dedup is forever).
    assert.equal((await S.reserveAttempt(res({ target_id: "4", now: new Date(NOW.getTime() + DAY) }))).ok, true);
  }

  // ── group global cap across different phones; duplicate on a later day ──
  {
    S._test.reset();
    const two = { daily_cap: 3, group_global_daily_cap: 2 };
    assert.equal((await S.reserveAttempt(res({ phone: "972500000001", page_id: "a", limits: two }))).ok, true);
    assert.equal((await S.reserveAttempt(res({ phone: "972500000002", page_id: "b", limits: two }))).ok, true);
    assert.deepEqual(await S.reserveAttempt(res({ phone: "972500000003", page_id: "c", limits: two })), { ok: false, reason: "group_cap" });
    // Same page → same group, a week later, another campaign: never again.
    assert.deepEqual(await S.reserveAttempt(res({ phone: "972500000001", page_id: "a", campaign_id: "other", now: new Date(NOW.getTime() + 7 * DAY) })), { ok: false, reason: "duplicate" });
    // A page target has no group bucket and no group cap.
    assert.equal((await S.reserveAttempt(res({ phone: "972500000003", page_id: "c", target_type: "page", target_id: "fbpage1", limits: { daily_cap: 3 } }))).ok, true);
  }

  // ── pre-submit cancel releases; verified_failed after submit does not ──
  {
    S._test.reset();
    const one = { daily_cap: 1, group_global_daily_cap: 1 };
    const a = (await S.reserveAttempt(res({ limits: one }))).attempt;
    await walk(a.key, ["session_started", "composer_ready"]);
    const c = await S.transition(a.key, "cancelled", { error_code: "posting_disabled" }, NOW);
    assert.equal(c.state, "cancelled");
    assert.equal(c.released, true);
    assert.equal(c.error_code, "posting_disabled");
    assert.equal(c.lease_until, null);
    assert.equal(c.finished_at, NOW.toISOString());
    const ga = (await S.getGroupActivityFor(["111"], NOW))["111"];
    assert.equal(ga.posts_today, 0);
    assert.deepEqual(ga.fingerprints, []);
    assert.equal(S._test.maps.posting_dedup.size, 0);
    assert.equal(S._test.maps.posting_budget.get(`972500000001|2026-09-23`).count, 0);
    // The same key is still taken (the attempt doc stays as the record), but
    // budget, bucket and dedup are free: another group, and another page to this group, succeed.
    const taken = await S.reserveAttempt(res({ limits: one }));
    assert.equal(taken.reason, "already_reserved");
    assert.equal(taken.attempt.state, "cancelled");
    assert.equal((await S.reserveAttempt(res({ limits: one, page_id: "pg2" }))).ok, true);

    // verified_failed from a pre-submit state also releases.
    S._test.reset();
    const b = (await S.reserveAttempt(res({ limits: one }))).attempt;
    await walk(b.key, ["session_started"]);
    const bf = await S.transition(b.key, "verified_failed", { error_code: "destination_mismatch" }, NOW);
    assert.equal(bf.released, true);
    assert.equal(bf.failed_after_submit, undefined);
    assert.equal(S.isCounting(bf), false);
    assert.equal((await S.reserveAttempt(res({ limits: one, page_id: "pg2" }))).ok, true);

    // verified_failed after submit_started keeps counting.
    S._test.reset();
    const d = (await S.reserveAttempt(res({ limits: one }))).attempt;
    await walk(d.key, ["session_started", "composer_ready", "submit_started"]);
    const df = await S.transition(d.key, "verified_failed", { error_code: "not_verified" }, NOW);
    assert.equal(df.failed_after_submit, true);
    assert.equal(df.released, undefined);
    assert.equal(S.isCounting(df), true);
    assert.equal((await S.getGroupActivityFor(["111"], NOW))["111"].posts_today, 1);
    assert.deepEqual(await S.reserveAttempt(res({ limits: one, target_id: "222" })), { ok: false, reason: "daily_cap" });
    assert.deepEqual(await S.reserveAttempt(res({ limits: { daily_cap: 5, group_global_daily_cap: 1 }, phone: "972500000009", page_id: "pg9" })), { ok: false, reason: "group_cap" });
    assert.deepEqual(df.history.map((h) => h.state), ["reserved", "session_started", "composer_ready", "submit_started", "verified_failed"]);
  }

  // ── illegal transitions throw; detail cannot overwrite identity ──
  {
    S._test.reset();
    const a = (await S.reserveAttempt(res())).attempt;
    await assert.rejects(S.transition(a.key, "submit_started", {}, NOW), code("illegal_transition"));
    await walk(a.key, ["session_started", "composer_ready", "submit_started", "outcome_unknown"]);
    await assert.rejects(S.transition(a.key, "submit_started", {}, NOW), code("illegal_transition"));
    await assert.rejects(S.transition(a.key, "cancelled", {}, NOW), code("illegal_transition"));
    const p = await S.transition(a.key, "verified_posted", { permalink: "https://www.facebook.com/groups/111/posts/9" }, NOW);
    assert.equal(p.state, "verified_posted");
    assert.equal(p.permalink, "https://www.facebook.com/groups/111/posts/9");
    for (const to of ["reserved", "session_started", "cancelled", "verified_failed", "outcome_unknown", "verified_posted"]) {
      await assert.rejects(S.transition(a.key, to, {}, NOW), code("illegal_transition"));
    }
    const b = (await S.reserveAttempt(res({ target_id: "222" }))).attempt;
    await assert.rejects(S.transition(b.key, "session_started", { state: "verified_posted" }, NOW), code("invalid_input"));
    await assert.rejects(S.transition(b.key, "session_started", { phone: "x" }, NOW), code("invalid_input"));
    await assert.rejects(S.transition("0".repeat(32), "session_started", {}, NOW), code("not_found"));
    assert.equal((await S.getAttempt(b.key)).state, "reserved");
  }

  // ── reapExpired ──
  {
    S._test.reset();
    const r = (await S.reserveAttempt(res({ target_id: "1" }))).attempt;
    const cs = (await S.reserveAttempt(res({ target_id: "2" }))).attempt;
    await walk(cs.key, ["session_started", "composer_ready"]);
    const sub = (await S.reserveAttempt(res({ target_id: "3", limits: { daily_cap: 5, group_global_daily_cap: 3 } }))).attempt;
    await walk(sub.key, ["session_started", "composer_ready", "submit_started"]);
    const vp = (await S.reserveAttempt(res({ target_id: "4", limits: { daily_cap: 5, group_global_daily_cap: 3 } }))).attempt;
    await walk(vp.key, ["session_started", "composer_ready", "submit_started", "verification_pending"]);
    // Refreshed 15 minutes later: its lease runs to NOW+35min.
    const fresh = (await S.reserveAttempt(res({ target_id: "5", limits: { daily_cap: 5, group_global_daily_cap: 3 } }))).attempt;
    await S.transition(fresh.key, "session_started", {}, new Date(NOW.getTime() + 15 * MIN));

    assert.deepEqual(await S.reapExpired(new Date(NOW.getTime() + 19 * MIN)), []);
    const reaped = await S.reapExpired(new Date(NOW.getTime() + 21 * MIN));
    const by = Object.fromEntries(reaped.map((x) => [x.key, x]));
    assert.equal(reaped.length, 4);
    assert.deepEqual(by[r.key], { key: r.key, from: "reserved", to: "cancelled" });
    assert.deepEqual(by[cs.key], { key: cs.key, from: "composer_ready", to: "cancelled" });
    assert.deepEqual(by[sub.key], { key: sub.key, from: "submit_started", to: "outcome_unknown" });
    assert.deepEqual(by[vp.key], { key: vp.key, from: "verification_pending", to: "outcome_unknown" });
    assert.equal(by[fresh.key], undefined, "a refreshed lease is not reaped");
    const rc = await S.getAttempt(r.key);
    assert.equal(rc.error_code, "lease_expired");
    assert.equal(rc.released, true);
    const ou = await S.getAttempt(sub.key);
    assert.equal(ou.lease_until, null);
    assert.equal(ou.released, undefined);
    // outcome_unknown is parked: never reaped again, never back to submit.
    assert.deepEqual((await S.reapExpired(new Date(NOW.getTime() + 2 * DAY))).map((x) => x.key), [fresh.key]);
    assert.deepEqual((await S.listAttemptsByState("outcome_unknown")).map((a) => a.key).sort(), [sub.key, vp.key].sort());
  }

  // ── one malformed attempt never blocks the reaper or cancelOpenAttempts ──
  {
    S._test.reset();
    const big = { daily_cap: 9, group_global_daily_cap: 9 };
    const v1 = (await S.reserveAttempt(res({ target_id: "1", limits: big }))).attempt;
    const v2 = (await S.reserveAttempt(res({ target_id: "2", limits: big }))).attempt;
    const badKey = "f".repeat(32);
    const bad = Object.assign(structuredClone(S._test.maps.posting_attempts.get(v1.key)), { key: badKey });
    delete bad.budget_key;
    // Inserted first, so it is met before the two valid ones.
    const all = [[badKey, bad], ...S._test.maps.posting_attempts];
    S._test.maps.posting_attempts.clear();
    for (const [k, v] of all) S._test.maps.posting_attempts.set(k, v);
    const reaped = await S.reapExpired(new Date(NOW.getTime() + 21 * MIN));
    assert.deepEqual(reaped.map((x) => x.key).sort(), [v1.key, v2.key].sort());
    assert.deepEqual(reaped.failures, [{ key: badKey, error_code: "corrupt_attempt" }]);
    assert.equal((await S.getAttempt(badKey)).state, "reserved", "the malformed doc is left as it is");

    const v3 = (await S.reserveAttempt(res({ target_id: "3", limits: big }))).attempt;
    await assert.rejects(S.cancelOpenAttempts("972500000001", "facebook"), (e) =>
      e.code === "cancel_incomplete" && e.cancelled === 1 && e.failures.length === 1 && e.failures[0].key === badKey);
    assert.equal((await S.getAttempt(v3.key)).state, "cancelled", "the valid attempt is cancelled despite the bad one");
  }

  // ── cancelOpenAttempts cancels only pre-submit states, only this phone ──
  {
    S._test.reset();
    const big = { daily_cap: 9, group_global_daily_cap: 9 };
    const r = (await S.reserveAttempt(res({ target_id: "1", limits: big }))).attempt;
    const ss = (await S.reserveAttempt(res({ target_id: "2", limits: big }))).attempt;
    await walk(ss.key, ["session_started"]);
    const cr = (await S.reserveAttempt(res({ target_id: "3", limits: big }))).attempt;
    await walk(cr.key, ["session_started", "composer_ready"]);
    const sub = (await S.reserveAttempt(res({ target_id: "4", limits: big }))).attempt;
    await walk(sub.key, ["session_started", "composer_ready", "submit_started"]);
    const other = (await S.reserveAttempt(res({ target_id: "5", phone: "972500000002", limits: big }))).attempt;
    assert.equal(await S.cancelOpenAttempts("972500000001", "yad2"), 0);
    assert.equal(await S.cancelOpenAttempts("972500000001", "facebook"), 3);
    for (const k of [r.key, ss.key, cr.key]) {
      const a = await S.getAttempt(k);
      assert.equal(a.state, "cancelled");
      assert.equal(a.error_code, "revoked");
    }
    assert.equal((await S.getAttempt(sub.key)).state, "submit_started");
    assert.equal((await S.getAttempt(other.key)).state, "reserved");
    // db.js delegates lazily.
    assert.equal(await db.cancelOpenAttempts("972500000002", "facebook"), 1);
    assert.equal((await S.getAttempt(other.key)).state, "cancelled");
    assert.equal((await S.listAttemptsByPhone("972500000001")).length, 4);
    assert.equal((await S.listAttemptsByPhone("972500000001", NOW.getTime() + 1)).length, 0);
  }

  // ── Jerusalem date buckets across the DST switch (R7) ──
  {
    S._test.reset();
    const big = { daily_cap: 9, group_global_daily_cap: 9 };
    const a = (await S.reserveAttempt(res({ page_id: "a", now: T("2026-03-27T22:30:00Z"), limits: big }))).attempt; // IL 03-28 01:30 (UTC 03-27)
    const b = (await S.reserveAttempt(res({ page_id: "b", now: T("2026-03-28T20:30:00Z"), limits: big }))).attempt; // IL 03-28 23:30
    const c = (await S.reserveAttempt(res({ page_id: "c", now: T("2026-03-28T21:30:00Z"), limits: big }))).attempt; // IL 03-29 00:30
    assert.equal(a.activity_key, "111|2026-03-28");
    assert.equal(b.activity_key, "111|2026-03-28");
    assert.equal(c.activity_key, "111|2026-03-29");
    assert.equal(a.budget_key, "972500000001|2026-03-28");
    assert.equal(a.budget_key, b.budget_key);
    assert.equal(S._test.maps.group_activity.get("111|2026-03-28").posts, 2);
    assert.equal(S._test.maps.posting_budget.get("972500000001|2026-03-28").count, 2);
    assert.equal(S._test.maps.posting_budget.get("972500000001|2026-03-29").count, 1);
  }

  // ── getGroupActivityFor: posts_today + the fingerprint window; hex only ──
  {
    S._test.reset();
    const big = { daily_cap: 9, group_global_daily_cap: 9 };
    await S.reserveAttempt(res({ page_id: "old", now: new Date(NOW.getTime() - 8 * DAY), fingerprint: fp("old"), limits: big }));
    await S.reserveAttempt(res({ page_id: "wk", now: new Date(NOW.getTime() - 6 * DAY), fingerprint: fp("wk"), limits: big }));
    await S.reserveAttempt(res({ page_id: "t1", fingerprint: fp("t1"), limits: big }));
    await S.reserveAttempt(res({ page_id: "t2", fingerprint: fp("t2"), limits: big }));
    await S.reserveAttempt(res({ page_id: "nofp", fingerprint: null, limits: big }));
    await S.reserveAttempt(res({ page_id: "t1", target_id: "222", fingerprint: fp("t1"), limits: big }));
    const out = await S.getGroupActivityFor(["111", "222", "333"], NOW);
    assert.equal(out["111"].posts_today, 3);
    assert.equal(out["111"].fingerprints.length, 3, "today's two + six days ago; eight days ago is outside the window");
    assert.deepEqual(new Set(out["111"].fingerprints.map((f) => f.exact)), new Set([fp("t1").exact, fp("t2").exact, fp("wk").exact]));
    assert.equal(out["222"].posts_today, 1);
    assert.deepEqual(out["333"], { posts_today: 0, fingerprints: [] });
    assert.equal((await S.getGroupActivityFor(["111"], NOW, 1))["111"].fingerprints.length, 2);
    for (const b of S._test.maps.group_activity.values()) {
      for (const f of b.fingerprints) {
        assert.deepEqual(Object.keys(f).sort(), ["at", "exact", "strong", "weak"]);
        for (const t of ["exact", "strong", "weak"]) assert.ok(f[t] === null || /^[0-9a-f]+$/.test(f[t]), `${t} is hex`);
      }
    }
    await assert.rejects(S.reserveAttempt(res({ page_id: "bad", fingerprint: { exact: "חיפה הרצל" } })), code("invalid_input"));
  }

  // ── input validation at the boundary ──
  {
    S._test.reset();
    await assert.rejects(S.reserveAttempt(res({ limits: {} })), code("invalid_input"));
    await assert.rejects(S.reserveAttempt(res({ target_type: "profile" })), code("invalid_input"));
    await assert.rejects(S.reserveAttempt(res({ target_id: "a/b" })), code("invalid_input"));
    await assert.rejects(S.reserveAttempt(res({ publisher: null })), code("invalid_input"));
    assert.equal(S._test.maps.posting_attempts.size, 0);
  }

  // ── campaigns ──
  {
    S._test.reset();
    const id = S.campaignId("972500000001", "pg1");
    assert.ok(/^[0-9a-f]{32}$/.test(id));
    assert.notEqual(S.campaignId("972500000001", "pg2"), id);
    const first = await S.createPostingCampaignIfAbsent({ phone: "972500000001", page_id: "pg1", status: "running", groups: [{ group_id: "111" }], posts: [] });
    assert.equal(first.created, true);
    assert.equal(first.campaign.id, id);
    const second = await S.createPostingCampaignIfAbsent({ phone: "972500000001", page_id: "pg1", status: "stopped", groups: [], posts: [{ id: "x" }] });
    assert.equal(second.created, false);
    assert.deepEqual(second.campaign, first.campaign);
    assert.deepEqual(await S.getPostingCampaign(id), first.campaign);
    await assert.rejects(S.createPostingCampaignIfAbsent({ id: "mine", phone: "972500000001", page_id: "pg1" }), code("invalid_input"));

    const upd = await S.updatePostingCampaign(id, { status: "paused", pause_reason: "agent", posts: [{ id: "a", status: "scheduled", copy: undefined }] });
    assert.equal(upd.status, "paused");
    assert.deepEqual(upd.posts, [{ id: "a", status: "scheduled" }]);
    assert.deepEqual(await S.getPostingCampaign(id), upd);
    assert.equal(await S.updatePostingCampaign("missing", { status: "running" }), null);
    assert.equal(await S.getPostingCampaign("missing"), null, "update never creates a campaign");
    await assert.rejects(S.updatePostingCampaign(id, { phone: "x" }), code("invalid_input"));
    // Maps merge, but an explicitly empty map replaces (Firestore's merge mask).
    assert.deepEqual((await S.updatePostingCampaign(id, { meta: { a: 1, n: { x: 1 } } })).meta, { a: 1, n: { x: 1 } });
    assert.deepEqual((await S.updatePostingCampaign(id, { meta: { b: 2, n: { y: 2 } } })).meta, { a: 1, b: 2, n: { x: 1, y: 2 } });
    assert.deepEqual((await S.updatePostingCampaign(id, { meta: { n: {} } })).meta, { a: 1, b: 2, n: {} });
    assert.deepEqual((await S.updatePostingCampaign(id, { meta: {} })).meta, {});
    assert.deepEqual((await S.getPostingCampaign(id)).meta, {});
    await S.updatePostingCampaign(id, { meta: null });
    await S.createPostingCampaignIfAbsent({ phone: "972500000002", page_id: "pg1", status: "running" });
    assert.equal((await S.listPostingCampaignsByStatus("running")).length, 1);
    assert.equal((await S.listPostingCampaignsByStatus("paused")).length, 1);
    assert.deepEqual((await S.listPostingCampaignsByPhone("972500000001")).map((c) => c.id), [id]);
    // Returned objects are copies: mutating one never changes the store.
    (await S.getPostingCampaign(id)).status = "hacked";
    assert.equal((await S.getPostingCampaign(id)).status, "paused");
    assert.equal((await S.getPostingCampaign(id)).meta, null);
  }

  // ── manual posts, connections, halts ──
  {
    db.mem.postActions.length = 0;
    await db.addPostAction({ business_phone: "972500000001", target: "facebook_group", action: "published", at: new Date(NOW.getTime() - 2 * DAY), post_url: "https://www.facebook.com/groups/1" });
    await db.addPostAction({ business_phone: "972500000001", target: "facebook_group", action: "published", at: new Date(NOW.getTime() - 10 * DAY) });
    await db.addPostAction({ business_phone: "972500000002", target: "facebook_group", action: "published", at: NOW });
    const acts = await S.listPostActionsByPhone("972500000001", NOW.getTime() - 7 * DAY);
    assert.equal(acts.length, 1);
    assert.equal(acts[0].at, new Date(NOW.getTime() - 2 * DAY).toISOString());
    assert.equal((await S.listPostActionsByPhone("972500000001")).length, 2);

    await db.setConnection("972500000011", { facebook_browser_connected_at: NOW.toISOString(), posting_last_halt_at: new Date(NOW.getTime() - 30 * MIN).toISOString() });
    await db.setConnection("972500000012", { facebook_browser_connected_at: null, yad2_browser_connected_at: NOW.toISOString(), posting_last_halt_at: new Date(NOW.getTime() - 3 * 3600000).toISOString() });
    await db.setConnection("972500000013", { facebook_page_id: "x" });
    assert.deepEqual(await S.listConnectedPhones(), ["972500000011"]);
    assert.deepEqual(await S.listConnectedPhones("yad2"), ["972500000012"]);
    assert.deepEqual(await S.listPhonesHaltedSince(new Date(NOW.getTime() - 3600000).toISOString()), ["972500000011"]);
    assert.throws(() => S.listConnectedPhones("face book"), code("invalid_input"));
  }

  // ── dwell sessions ──
  {
    S._test.reset();
    const at = NOW.toISOString();
    await assert.rejects(S.saveDwellSession({ phone: "972500000001", platform: "facebook", at, actions_summary: {}, likes: [], text: "דירה יפה" }), code("invalid_input"));
    await assert.rejects(S.saveDwellSession({ phone: "972500000001", platform: "facebook", at, actions_summary: { group: "https://www.facebook.com/groups/1" }, likes: [] }), code("invalid_input"));
    // likes: an array of {post_id, at} — a numeric Facebook id and an ISO instant, nothing else
    await assert.rejects(S.saveDwellSession({ phone: "972500000001", platform: "facebook", at, actions_summary: {}, likes: 1 }), code("invalid_input"), "likes must be an array");
    await assert.rejects(S.saveDwellSession({ phone: "972500000001", platform: "facebook", at, actions_summary: {}, likes: [{ post_id: "not-a-number", at }] }), code("invalid_input"), "post_id must be numeric");
    await assert.rejects(S.saveDwellSession({ phone: "972500000001", platform: "facebook", at, actions_summary: {}, likes: [{ post_id: "123", at }] }), code("invalid_input"), "post_id must be at least 5 digits");
    await assert.rejects(S.saveDwellSession({ phone: "972500000001", platform: "facebook", at, actions_summary: {}, likes: [{ post_id: "1234567890", at: new Date(NOW) }] }), code("invalid_input"), "at must be an ISO string, not a Date");
    await assert.rejects(S.saveDwellSession({ phone: "972500000001", platform: "facebook", at, actions_summary: {}, likes: [{ post_id: "1234567890", at: "not a date" }] }), code("invalid_input"), "at must parse");
    await assert.rejects(S.saveDwellSession({ phone: "972500000001", platform: "facebook", at, actions_summary: {}, likes: [{ post_id: "1234567890", at, author: "Ann" }] }), code("invalid_input"), "no extra fields on a like");
    await assert.rejects(S.saveDwellSession({ phone: "972500000001", platform: "facebook", at, actions_summary: {}, likes: Array.from({ length: 6 }, (_, i) => ({ post_id: String(1000000 + i), at })) }), code("invalid_input"), "at most 5 likes");
    assert.equal(S._test.maps.dwell_sessions.size, 0);
    const id = await S.saveDwellSession({ phone: "972500000001", platform: "facebook", at, actions_summary: { scrolls: 12, posts_viewed: 5, like: 1 }, likes: [{ post_id: "1234567890", at }] });
    const idH = await S.saveDwellSession({ phone: "972500000001", platform: "facebook", at, actions_summary: {}, likes: [], halt_related: true });
    const d = S._test.maps.dwell_sessions.get(id);
    assert.deepEqual(Object.keys(d).sort(), ["actions_summary", "at", "expire_at", "halt_related", "id", "likes", "phone", "platform"]);
    assert.deepEqual(d.likes, [{ post_id: "1234567890", at }]);
    assert.equal(d.expire_at.getTime(), NOW.getTime() + 90 * DAY);
    assert.equal(S._test.maps.dwell_sessions.get(idH).expire_at.getTime(), NOW.getTime() + 365 * DAY);
    const listed = await S.listDwellSessionsByPhone("972500000001", NOW.getTime() - DAY);
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map((x) => x.at), [at, at]);
    assert.deepEqual(listed.map((x) => x.expire_at).sort(), [new Date(NOW.getTime() + 90 * DAY).toISOString(), new Date(NOW.getTime() + 365 * DAY).toISOString()].sort());
    assert.equal((await S.listDwellSessionsByPhone("972500000001", NOW.getTime() + 1)).length, 0);

    // ── listRecentLikedPostIds: the set of post ids liked since sinceMs ──
    await S.saveDwellSession({ phone: "972500000001", platform: "facebook", at: new Date(NOW.getTime() - 2 * DAY).toISOString(), actions_summary: { like: 1 }, likes: [{ post_id: "555555", at: new Date(NOW.getTime() - 2 * DAY).toISOString() }] });
    const recent = await S.listRecentLikedPostIds("972500000001", NOW.getTime() - 3 * DAY);
    assert.ok(recent instanceof Set);
    assert.deepEqual([...recent].sort(), ["1234567890", "555555"]);
    assert.deepEqual([...(await S.listRecentLikedPostIds("972500000001", NOW.getTime() + 1))], []);
    assert.deepEqual([...(await S.listRecentLikedPostIds("972500099999", NOW.getTime() - 3 * DAY))], []);
  }

  // ── the property→target dedup expires after limits.dedup_days (controller ruling 2) ──
  {
    S._test.reset();
    const lim = { daily_cap: 9, group_global_daily_cap: 9, dedup_days: 14 };
    const a = (await S.reserveAttempt(res({ limits: lim }))).attempt;
    await walk(a.key, ["session_started", "composer_ready", "submit_started", "verification_pending", "verified_posted"]);
    const dd = S._test.maps.posting_dedup.get(S._test.dedupKey("pg1", "group", "111"));
    assert.equal(dd.expires_at, new Date(NOW.getTime() + 14 * DAY).toISOString());
    const d10 = new Date(NOW.getTime() + 10 * DAY);
    assert.equal((await S.reserveAttempt(res({ limits: lim, now: d10 }))).reason, "duplicate", "10 days later: still within the cooldown");
    const d15 = new Date(NOW.getTime() + 15 * DAY);
    const again = await S.reserveAttempt(res({ limits: lim, now: d15 }));
    assert.equal(again.ok, true, "15 days later: the expired dedup is treated as absent");
    const dd2 = S._test.maps.posting_dedup.get(S._test.dedupKey("pg1", "group", "111"));
    assert.deepEqual(dd2, { key: again.attempt.key, at: d15.toISOString(), expires_at: new Date(d15.getTime() + 14 * DAY).toISOString() }, "overwritten, not merged");
    // release semantics unchanged: the old attempt no longer owns the doc, so nothing it does removes it
    assert.equal((await S.getAttempt(a.key)).state, "verified_posted");
    await S.transition(again.attempt.key, "cancelled", {}, d15);
    assert.equal(S._test.maps.posting_dedup.has(S._test.dedupKey("pg1", "group", "111")), false, "the owning attempt's release still deletes it");
    // no dedup_days → never expires (fail closed); a bad value is refused
    S._test.reset();
    const p = (await S.reserveAttempt(res())).attempt;
    await walk(p.key, ["session_started", "composer_ready", "submit_started", "verification_pending", "verified_posted"]);
    assert.equal((await S.reserveAttempt(res({ now: new Date(NOW.getTime() + 400 * DAY) }))).reason, "duplicate");
    await assert.rejects(S.reserveAttempt(res({ limits: { daily_cap: 3, group_global_daily_cap: 3, dedup_days: 0 } })), code("invalid_input"));
  }

  // ── no log lines at all in these modules ──
  for (const f of ["posting-store.js", "posting-attempts.js", "posting-tx.js"]) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    assert.ok(!/console\.|process\.std(out|err)/.test(src), `${f} must not log`);
  }

  console.log("posting-store.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
