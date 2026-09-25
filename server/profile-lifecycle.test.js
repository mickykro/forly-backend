/* profile-lifecycle.js — revoke, quarantine, retryDeletes, and the
   profile_deletes pending-retry store. No network, no browser: driver and db
   are fakes. Starts from Task 13's acceptance test (revoke, adapted to this
   repo's real module names), then covers quarantine and the self-contained
   retryDeletes(deps) added in review-round-1. */
const assert = require("assert");
const L = require("./profile-lifecycle");
const { profileName, assertOwnership } = require("./profile-name");
process.env.FORLY_ENV = "local"; process.env.PROFILE_KEY = "k";

// A minimal fake of db.js's connection + profile_deletes surface, shared by
// every scenario below so retryDeletes can be exercised against the SAME
// kind of store revoke()/quarantine() write into.
function fakeDb(conns = {}) {
  const pending = new Map();
  return {
    conns,
    pending,
    getConnection: async (phone) => conns[phone] || null,
    setConnection: async (phone, patch) => { conns[phone] = Object.assign(conns[phone] || {}, patch); },
    cancelOpenAttempts: async () => {},
    savePendingDelete: async ({ phone, platform, since, attempts, last_error, gen }) => {
      const rec = { phone, platform, since, attempts, last_error };
      if (gen !== undefined) rec.gen = gen;
      pending.set(`${platform}:${phone}`, rec);
    },
    listPendingDeletes: async () => [...pending.values()],
    clearPendingDelete: async (phone, platform) => { pending.delete(`${platform}:${phone}`); },
  };
}

(async () => {
  assert.ok(/^facebook-local-[0-9a-f]{20}$/.test(profileName("facebook", "05x")));
  assert.doesNotThrow(() => assertOwnership(profileName("facebook", "05x"), "05x", "facebook"));
  assert.throws(() => assertOwnership(profileName("facebook", "05x"), "05y", "facebook"), (e) => e.code === "profile_ownership");
  assert.throws(() => assertOwnership(profileName("yad2", "05x"), "05x", "facebook"), (e) => e.code === "profile_ownership");

  // ── revoke: stops the session, cancels open attempts, deletes the profile,
  //    clears Facebook-only state, and records what the agent must still do ──
  const conn = { facebook_browser_connected_at: "2026-09-01", facebook_pages: [{}], facebook_groups_member: [{}], posting_permission: { enabled: true }, browser_session_facebook: { session_id: "s1" } };
  const db1 = fakeDb({ "05x": conn });
  const stopped = [], deleted = [], cancelled = [];
  db1.cancelOpenAttempts = async (ph, platform) => cancelled.push([ph, platform]);
  const result = await L.revoke({ phone: "05x", platform: "facebook", reason: "agent" }, {
    db: db1,
    driver: { stopSession: async (id) => stopped.push(id), deleteProfile: async (n) => deleted.push(n) },
  });
  assert.deepEqual(stopped, ["s1"]);
  assert.deepEqual(cancelled, [["05x", "facebook"]]);
  assert.equal(deleted[0], profileName("facebook", "05x"));
  assert.equal(conn.facebook_profile_state, "revoked");
  assert.equal(conn.facebook_browser_connected_at, null);
  assert.equal(conn.posting_permission, null);
  assert.equal(conn.facebook_pages, null);
  assert.equal(conn.facebook_groups_member, null);
  assert.ok(conn.facebook_profile_deleted_at);
  assert.equal(conn.facebook_identity_label, null, "the account holder's display name must not outlive revoke()");
  assert.ok(conn.facebook_browser_disconnected_at, "revoke() records when access was taken back");
  assert.ok(result.advice, "revoke says what the agent should still do at the platform");
  assert.throws(() => assertOwnership(profileName("facebook", "05x"), "05x", "facebook", conn), (e) => e.code === "profile_ownership", "a revoked profile is refused even with the right name");
  assert.deepEqual(await db1.listPendingDeletes(), [], "a successful delete leaves no pending row");

  // ── Driver refusing the delete is recorded and retried, not swallowed —
  //    AND files a profile_deletes row so retryDeletes() can find it later ──
  const conn2 = { yad2_browser_connected_at: "2026-09-01" };
  const db2 = fakeDb({ "05x": conn2 });
  await L.revoke({ phone: "05x", platform: "yad2", reason: "agent" }, {
    db: db2,
    driver: { stopSession: async () => {}, deleteProfile: async () => { throw new Error("503"); } },
  });
  assert.ok(conn2.yad2_profile_delete_error && !conn2.yad2_profile_deleted_at);
  assert.equal(conn2.posting_permission, undefined, "revoke on a non-Facebook platform must not touch Facebook-only fields");
  {
    const rows = await db2.listPendingDeletes();
    assert.equal(rows.length, 1, "a failed delete creates a pending record");
    assert.equal(rows[0].phone, "05x");
    assert.equal(rows[0].platform, "yad2");
    assert.equal(rows[0].attempts, 1);
    assert.equal(rows[0].last_error, "503");
    assert.ok(rows[0].since);
  }

  // ── a later successful retry clears the pending record ──
  {
    const okDb = fakeDb({ "05x": conn2 }); // same conn2: still revoked, still undeleted
    okDb.pending.set("yad2:05x", { phone: "05x", platform: "yad2", since: db2.pending.get("yad2:05x").since, attempts: 1, last_error: "503" });
    const results = await L.retryDeletes({ db: okDb, driver: { deleteProfile: async () => ({ ok: true }) } });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.ok(conn2.yad2_profile_deleted_at, "the retry recorded success on the connection");
    assert.deepEqual(await okDb.listPendingDeletes(), [], "success clears the pending row");
  }

  // ── quarantine: sets state, stops the session, cancels attempts, deletes
  //    the profile — and a quarantined profile is refused too ──
  const conn3 = { facebook_browser_connected_at: "2026-09-10", browser_session_facebook: { session_id: "s2" } };
  const db3 = fakeDb({ "05x": conn3 });
  const stopped3 = [], deleted3 = [], cancelled3 = [];
  db3.cancelOpenAttempts = async (ph, platform) => cancelled3.push([ph, platform]);
  await L.quarantine("05x", "facebook", "checkpoint", {
    db: db3,
    driver: { stopSession: async (id) => stopped3.push(id), deleteProfile: async (n) => deleted3.push(n) },
  });
  assert.deepEqual(stopped3, ["s2"]);
  assert.deepEqual(cancelled3, [["05x", "facebook"]]);
  assert.equal(conn3.facebook_profile_state, "quarantined");
  assert.equal(conn3.facebook_profile_quarantine_class, "checkpoint");
  assert.equal(conn3.facebook_browser_connected_at, null);
  assert.equal(deleted3[0], profileName("facebook", "05x"));
  assert.ok(conn3.facebook_profile_deleted_at);
  assert.equal(conn3.facebook_identity_label, null, "quarantine() clears the identity label too — the next connect re-reads it");
  assert.throws(() => assertOwnership(profileName("facebook", "05x"), "05x", "facebook", conn3), (e) => e.code === "profile_ownership");

  // ── quarantine refuses an unrecognized halt class ──
  await assert.rejects(
    () => L.quarantine("05x", "facebook", "bored", { db: fakeDb(), driver: {} }),
    (e) => e.code === "invalid_input",
  );

  // ── retryDeletes: reads its own work from db.listPendingDeletes(); skips a
  //    row whose connection already succeeded and one that reconnected past
  //    quarantine/revocation, without attempting a delete for either ──
  {
    const conns = {
      a: { yad2_profile_state: "revoked" }, // still pending — should be retried
      b: { madlan_profile_state: "revoked", madlan_profile_deleted_at: "2026-09-01" }, // already done
      c: { facebook_browser_connected_at: "2026-09-20" }, // reconnected — no longer pending
    };
    const db4 = fakeDb(conns);
    const since = new Date().toISOString();
    db4.pending.set("yad2:a", { phone: "a", platform: "yad2", since, attempts: 0, last_error: null });
    db4.pending.set("madlan:b", { phone: "b", platform: "madlan", since, attempts: 0, last_error: null });
    db4.pending.set("facebook:c", { phone: "c", platform: "facebook", since, attempts: 0, last_error: null });
    const attemptedDeletes = [];
    const results = await L.retryDeletes({ db: db4, driver: { deleteProfile: async (n) => { attemptedDeletes.push(n); return { ok: true }; } } });
    assert.deepEqual(attemptedDeletes, [profileName("yad2", "a")], "only the still-pending row is retried");
    assert.equal(results.length, 1, "already-done and reconnected rows are skipped, not reported");
    assert.equal(results[0].phone, "a");
    assert.ok(conns.a.yad2_profile_deleted_at);
  }

  // ── retryDeletes escalates a row that keeps failing past ESCALATE_AFTER_DAYS,
  //    and keeps the pending row (with attempts incremented) when it does ──
  {
    const conns = { d: { facebook_profile_state: "revoked" } };
    const db5 = fakeDb(conns);
    const oldSince = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    db5.pending.set("facebook:d", { phone: "d", platform: "facebook", since: oldSince, attempts: 3, last_error: "503" });
    const results = await L.retryDeletes({ db: db5, driver: { deleteProfile: async () => { throw new Error("still 503"); } } });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].escalate, true, "8 days old and still failing must escalate");
    const row = db5.pending.get("facebook:d");
    assert.equal(row.attempts, 4, "attempts increments, since is preserved across retries");
    assert.equal(row.since, oldSince);
  }

  // ── retryDeletes: a gen-tracked row whose gen still matches the
  //    connection's current gen works exactly like before — deletes that
  //    profile, records success on the connection, clears the pending row ──
  {
    const conns = { e: { facebook_profile_state: "revoked", facebook_profile_gen: 0 } };
    const db6 = fakeDb(conns);
    db6.pending.set("facebook:e", { phone: "e", platform: "facebook", since: new Date().toISOString(), attempts: 1, last_error: "503", gen: 0 });
    const attempted = [];
    const results = await L.retryDeletes({ db: db6, driver: { deleteProfile: async (n) => { attempted.push(n); return { ok: true }; } } });
    assert.deepEqual(attempted, [profileName("facebook", "e", 0)]);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.ok(conns.e.facebook_profile_deleted_at, "gen matches current: the connection is marked deleted");
    assert.deepEqual(await db6.listPendingDeletes(), []);
  }

  // ── retryDeletes: reconnecting after a failed delete bumps the connection's
  //    gen (routes/connections-browser.js's /start) while the OLD gen's
  //    delete is still pending. The retry must delete the OLD generation's
  //    profile — never the new, live one — and must NOT stamp the
  //    connection's deleted_at/delete_error, which now describe the live
  //    profile, not the orphaned one this retry is cleaning up ──
  {
    const conns = { f: { facebook_profile_state: "active", facebook_profile_gen: 1 } }; // reconnected to gen1
    const db7 = fakeDb(conns);
    db7.pending.set("facebook:f", { phone: "f", platform: "facebook", since: new Date().toISOString(), attempts: 1, last_error: "503", gen: 0 }); // gen0's delete never finished
    const attempted = [];
    const results = await L.retryDeletes({ db: db7, driver: { deleteProfile: async (n) => { attempted.push(n); return { ok: true }; } } });
    assert.deepEqual(attempted, [profileName("facebook", "f", 0)], "deletes the OLD (gen0) profile, never the live gen1 one");
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].staleGen, true);
    assert.equal(conns.f.facebook_profile_deleted_at, undefined, "the live gen1 connection must not be marked deleted by an old generation's cleanup");
    assert.equal(conns.f.facebook_profile_delete_error, undefined);
    assert.deepEqual(await db7.listPendingDeletes(), [], "the gen0 pending row is still cleared once its own delete succeeds");
  }

  console.log("profile-lifecycle.test.js ok");
})();
