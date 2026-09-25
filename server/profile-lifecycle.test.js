/* profile-lifecycle.js — revoke, quarantine, retryDeletes. No network, no
   browser: driver and db are fakes. This is Task 13's acceptance test,
   adapted to this repo's real module names. */
const assert = require("assert");
const L = require("./profile-lifecycle");
const { profileName, assertOwnership } = require("./profile-name");
process.env.FORLY_ENV = "local"; process.env.PROFILE_KEY = "k";

(async () => {
  assert.ok(/^facebook-local-[0-9a-f]{20}$/.test(profileName("facebook", "05x")));
  assert.doesNotThrow(() => assertOwnership(profileName("facebook", "05x"), "05x", "facebook"));
  assert.throws(() => assertOwnership(profileName("facebook", "05x"), "05y", "facebook"), (e) => e.code === "profile_ownership");
  assert.throws(() => assertOwnership(profileName("yad2", "05x"), "05x", "facebook"), (e) => e.code === "profile_ownership");

  // ── revoke: stops the session, cancels open attempts, deletes the profile,
  //    clears Facebook-only state, and records what the agent must still do ──
  const conn = { facebook_browser_connected_at: "2026-09-01", facebook_pages: [{}], facebook_groups_member: [{}], posting_permission: { enabled: true }, browser_session_facebook: { session_id: "s1" } };
  const stopped = [], deleted = [], cancelled = [];
  const result = await L.revoke({ phone: "05x", platform: "facebook", reason: "agent" }, {
    db: { getConnection: async () => conn, setConnection: async (p, patch) => Object.assign(conn, patch), cancelOpenAttempts: async (ph, platform) => cancelled.push([ph, platform]) },
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
  assert.ok(result.advice, "revoke says what the agent should still do at the platform");
  assert.throws(() => assertOwnership(profileName("facebook", "05x"), "05x", "facebook", conn), (e) => e.code === "profile_ownership", "a revoked profile is refused even with the right name");

  // ── Driver refusing the delete is recorded and retried, not swallowed ──
  const conn2 = { yad2_browser_connected_at: "2026-09-01" };
  await L.revoke({ phone: "05x", platform: "yad2", reason: "agent" }, {
    db: { getConnection: async () => conn2, setConnection: async (p, patch) => Object.assign(conn2, patch), cancelOpenAttempts: async () => {} },
    driver: { stopSession: async () => {}, deleteProfile: async () => { throw new Error("503"); } },
  });
  assert.ok(conn2.yad2_profile_delete_error && !conn2.yad2_profile_deleted_at);

  // ── revoke on a non-Facebook platform must not touch Facebook-only fields ──
  assert.equal(conn2.posting_permission, undefined);

  // ── quarantine: sets state, stops the session, cancels attempts, deletes
  //    the profile — and a quarantined profile is refused too ──
  const conn3 = { facebook_browser_connected_at: "2026-09-10", browser_session_facebook: { session_id: "s2" } };
  const stopped3 = [], deleted3 = [], cancelled3 = [];
  await L.quarantine("05x", "facebook", "checkpoint", {
    db: { getConnection: async () => conn3, setConnection: async (p, patch) => Object.assign(conn3, patch), cancelOpenAttempts: async (ph, platform) => cancelled3.push([ph, platform]) },
    driver: { stopSession: async (id) => stopped3.push(id), deleteProfile: async (n) => deleted3.push(n) },
  });
  assert.deepEqual(stopped3, ["s2"]);
  assert.deepEqual(cancelled3, [["05x", "facebook"]]);
  assert.equal(conn3.facebook_profile_state, "quarantined");
  assert.equal(conn3.facebook_profile_quarantine_class, "checkpoint");
  assert.equal(conn3.facebook_browser_connected_at, null);
  assert.equal(deleted3[0], profileName("facebook", "05x"));
  assert.ok(conn3.facebook_profile_deleted_at);
  assert.throws(() => assertOwnership(profileName("facebook", "05x"), "05x", "facebook", conn3), (e) => e.code === "profile_ownership");

  // ── quarantine refuses an unrecognized halt class ──
  await assert.rejects(
    () => L.quarantine("05x", "facebook", "bored", { db: {}, driver: {} }),
    (e) => e.code === "invalid_input",
  );

  // ── retryDeletes: only re-attempts revoked/quarantined rows still missing a
  //    successful delete, and flags one old enough to escalate ──
  const rowA = { yad2_profile_state: "revoked" }; // still failing
  const rowB = { madlan_profile_state: "revoked", madlan_profile_deleted_at: "2026-09-01" }; // already done
  const rowC = { facebook_browser_connected_at: "2026-09-20" }; // reconnected — no longer pending
  const conns = { a: rowA, b: rowB, c: rowC };
  const retryDeleted = [];
  const retryDeps = {
    db: {
      getConnection: async (phone) => conns[phone],
      setConnection: async (phone, patch) => Object.assign(conns[phone], patch),
    },
    driver: { deleteProfile: async (n) => { retryDeleted.push(n); return { ok: true }; } },
  };
  const oldSince = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const results = await L.retryDeletes(
    [
      { phone: "a", platform: "yad2", since: oldSince },
      { phone: "b", platform: "madlan", since: oldSince },
      { phone: "c", platform: "facebook", since: oldSince },
    ],
    retryDeps,
  );
  assert.deepEqual(retryDeleted, [profileName("yad2", "a")], "only the still-pending row is retried");
  assert.ok(rowA.yad2_profile_deleted_at, "the retry recorded success");
  const onlyResult = results.find((r) => r.phone === "a");
  assert.ok(onlyResult && onlyResult.ok, "succeeded this time");
  assert.equal(results.length, 1, "already-done and reconnected rows are skipped, not reported");

  // ── retryDeletes escalates a row that keeps failing past ESCALATE_AFTER_DAYS ──
  const rowD = { facebook_profile_state: "revoked" };
  const escDeps = {
    db: { getConnection: async () => rowD, setConnection: async (p, patch) => Object.assign(rowD, patch) },
    driver: { deleteProfile: async () => { throw new Error("still 503"); } },
  };
  const [esc] = await L.retryDeletes([{ phone: "d", platform: "facebook", since: oldSince }], escDeps);
  assert.equal(esc.ok, false);
  assert.equal(esc.escalate, true, "8 days old and still failing must escalate");

  console.log("profile-lifecycle.test.js ok");
})();
