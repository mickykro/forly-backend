/* routes/connections-browser.js — DELETE /:platform and its interaction with
   profile-lifecycle's revoke()/retryDeletes(). Split out of
   connections-browser.test.js to keep both files under the 500-line cap. No
   network: driver, db and locks are fakes (or the real profile-lifecycle
   module, where a fake would just duplicate its own tests). */
process.env.FORLY_ENV = "local";
// Posting is off unless switched on (I5): the connect flow asks the real
// guard, so these run with the env switch on and settings/posting enabled.
process.env.POSTING_ENABLED = "1";
const assert = require("assert");
const express = require("express");
const http = require("http");
const createRouter = require("./connections-browser");
const { profileName } = require("../profile-name");
const lifecycle = require("../profile-lifecycle");

const PHONE = "0500000000";
const requireAuth = () => (req, res, next) => { req.user = { userId: PHONE }; next(); };

function makeApp(overrides) {
  const app = express();
  app.use(express.json());
  app.use("/api/connections/browser", createRouter(Object.assign({ requireAuth, authSecret: "s" }, overrides)));
  return app;
}
function call(app, method, path, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const req = http.request({ port: server.address().port, path, method, headers: { "content-type": "application/json" } }, (res) => {
        let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(d || "{}") }); });
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

// A db fake wide enough for every dependency this route touches through its
// real modules: getSetting (posting-guard) and cancelOpenAttempts /
// savePendingDelete / clearPendingDelete / listPendingDeletes
// (profile-lifecycle), on top of the plain connection get/set every test
// needs. The pending-delete store mirrors db.js's own key scheme
// (`${platform}:${phone}:${gen}`, or the bare `${platform}:${phone}` when
// gen is omitted) so a real profile-lifecycle.retryDeletes() call against
// this same fake behaves exactly as it would against the real store.
function fakeDb(conn = {}) {
  const pending = new Map();
  const idFor = (platform, phone, gen) => (gen === undefined ? `${platform}:${phone}` : `${platform}:${phone}:${gen}`);
  return {
    conn,
    pending,
    getConnection: async () => conn,
    setConnection: async (p, patch) => Object.assign(conn, patch),
    getSetting: async (k) => (k === "posting" ? { enabled: true } : null),
    cancelOpenAttempts: async () => {},
    savePendingDelete: async ({ phone, platform, since, attempts, last_error, gen }) => {
      const id = idFor(platform, phone, gen);
      const rec = { id, phone, platform, since, attempts, last_error };
      if (gen !== undefined) rec.gen = gen;
      pending.set(id, rec);
    },
    listPendingDeletes: async () => [...pending.values()],
    clearPendingDelete: async (phone, platform, gen) => { pending.delete(idFor(platform, phone, gen)); },
  };
}

// A deterministic profile-lock double: one profile slot, an optional session
// budget. Real profile-lock.js has its own tests; this one only has to prove
// the route acquires/releases correctly.
function fakeLocks({ maxSessions = Infinity } = {}) {
  let held = false;
  let sessions = 0;
  return {
    tryAcquire: () => { if (held) return null; held = true; return () => { held = false; }; },
    trySession: () => { if (sessions >= maxSessions) return null; sessions++; return () => { sessions--; }; },
    _isHeld: () => held,
    _sessions: () => sessions,
  };
}

(async () => {
  // ── end-to-end: connect → DELETE (gen0 succeeds) → /start reconnects to
  //    gen1 → DELETE again (gen1's Driver delete FAILS) → retryDeletes (the
  //    real profile-lifecycle module, same fake db+driver) finishes gen1's
  //    delete and clears its pending row. Based on the reviewer's
  //    scratchpad/repro.js. Along the way: reconnecting must not leave the
  //    OLD generation's delete bookkeeping on the connection — a later
  //    failed delete for the NEW generation must still get its own
  //    pending-delete row and retry, not be mistaken for "already deleted"
  //    because a stale <platform>_profile_deleted_at from gen0 was still
  //    sitting there ──
  {
    const conn = {};
    const db = fakeDb(conn);
    let created = null;
    let failDelete = false;
    const deletedNames = [];
    const reconnectRealApp = makeApp({
      driver: {
        createSession: async (opts) => { created = opts; return { sessionId: "sR" + Math.random(), status: "active", cdpUrl: "wss://n/r" }; },
        stopSession: async () => {},
        deleteProfile: async (name) => {
          if (failDelete) return { ok: false, error: "boom" };
          deletedNames.push(name);
          return { ok: true };
        },
      },
      db,
      locks: fakeLocks(),
    });
    const first = await call(reconnectRealApp, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true }); // gen0
    assert.equal(first.status, 200);
    const disc = await call(reconnectRealApp, "DELETE", "/api/connections/browser/facebook"); // gen0 delete succeeds
    assert.equal(disc.status, 200);
    assert.ok(conn.facebook_profile_deleted_at, "gen0's delete is recorded as done");
    assert.ok(conn.facebook_profile_revoked_at);

    const reconnect = await call(reconnectRealApp, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true }); // gen1
    assert.equal(reconnect.status, 200);
    assert.equal(created.profile.name, profileName("facebook", PHONE, 1));
    assert.equal(conn.facebook_profile_gen, 1);
    assert.equal(conn.facebook_profile_state, "active");
    assert.equal(conn.facebook_profile_deleted_at, null, "the OLD generation's deleted_at must not survive onto the new generation");
    assert.equal(conn.facebook_profile_delete_error, null);
    assert.equal(conn.facebook_profile_revoked_at, null);
    assert.equal(conn.facebook_profile_revoke_reason, null);
    assert.equal(conn.facebook_profile_quarantined_at, null);
    assert.equal(conn.facebook_profile_quarantine_class, null);

    // gen1's DELETE: the Driver delete itself fails, but the route always
    // reports success (the failure is tracked for retry, not surfaced) —
    // files its OWN pending-delete row, keyed by gen1, not gen0's leftover.
    failDelete = true;
    const disc2 = await call(reconnectRealApp, "DELETE", "/api/connections/browser/facebook");
    assert.equal(disc2.status, 200);
    assert.ok(conn.facebook_profile_delete_error, "gen1's failed delete is recorded");
    assert.equal(conn.facebook_profile_deleted_at, null);
    const pendingAfterFailure = await db.listPendingDeletes();
    assert.equal(pendingAfterFailure.length, 1);
    assert.equal(pendingAfterFailure[0].gen, 1);

    // retryDeletes (profile-lifecycle, same fake db+driver): Driver now succeeds
    failDelete = false;
    const retryResults = await lifecycle.retryDeletes({ db, driver: { deleteProfile: async (name) => { deletedNames.push(name); return { ok: true }; } } });
    assert.equal(retryResults.length, 1);
    assert.equal(retryResults[0].ok, true);
    assert.ok(deletedNames.includes(profileName("facebook", PHONE, 1)), "retryDeletes deletes the gen1 profile");
    assert.ok(conn.facebook_profile_deleted_at, "gen1's delete is now recorded as done");
    assert.deepEqual(await db.listPendingDeletes(), [], "the pending row is cleared");
  }

  // ── disconnect: revoke() stops the session, deletes the profile, and
  //    clears Facebook-only state; the route relays revoke's advice string ──
  {
    const deleted = [];
    const conn4 = {
      facebook_browser_connected_at: "2026-09-01T00:00:00Z", facebook_pages: [{}], posting_permission: { enabled: true },
      facebook_identity_label: "Dana Cohen",
    };
    const discApp = makeApp({
      driver: { deleteProfile: async (name) => { deleted.push(name); return { ok: true }; }, stopSession: async () => {} },
      db: fakeDb(conn4),
    });
    const disc = await call(discApp, "DELETE", "/api/connections/browser/facebook");
    assert.equal(disc.status, 200);
    assert.equal(disc.body.state, "none");
    assert.ok(disc.body.advice, "revoke's Hebrew advice string is returned");
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0], profileName("facebook", PHONE));
    assert.equal(conn4.facebook_browser_connected_at, null);
    assert.equal(conn4.facebook_profile_state, "revoked");
    assert.equal(conn4.posting_permission, null);
    assert.equal(conn4.facebook_pages, null);
    assert.equal(conn4.facebook_identity_label, null, "the account holder's display name must not survive disconnect");
    assert.ok(conn4.facebook_browser_disconnected_at, "disconnect is recorded");
  }

  // ── disconnect also stops running/paused posting campaigns, through the
  //    injected ctx.campaigns and db.listPostingCampaignsByPhone (Task 16) ──
  {
    const stoppedCampaigns = [];
    const conn5 = { facebook_browser_connected_at: "2026-09-01T00:00:00Z" };
    const db5 = fakeDb(conn5);
    db5.listPostingCampaignsByPhone = async () => [
      { id: "c1", status: "running" },
      { id: "c2", status: "paused" },
      { id: "c3", status: "stopped" },
    ];
    const campApp = makeApp({
      driver: { deleteProfile: async () => ({ ok: true }), stopSession: async () => {} },
      db: db5,
      campaigns: { stop: async (id) => stoppedCampaigns.push(id) },
    });
    const disc = await call(campApp, "DELETE", "/api/connections/browser/facebook");
    assert.equal(disc.status, 200);
    assert.deepEqual(stoppedCampaigns.sort(), ["c1", "c2"], "only running/paused campaigns are stopped");
  }

  // ── ctx.campaigns without db.listPostingCampaignsByPhone (not built yet) is
  //    a harmless no-op, not a crash ──
  {
    const stoppedCampaigns = [];
    const conn6 = { facebook_browser_connected_at: "2026-09-01T00:00:00Z" };
    const noListApp = makeApp({
      driver: { deleteProfile: async () => ({ ok: true }), stopSession: async () => {} },
      db: fakeDb(conn6), // no listPostingCampaignsByPhone
      campaigns: { stop: async (id) => stoppedCampaigns.push(id) },
    });
    const disc = await call(noListApp, "DELETE", "/api/connections/browser/facebook");
    assert.equal(disc.status, 200);
    assert.deepEqual(stoppedCampaigns, []);
  }

  // ── ctx.lifecycle is injectable: the route trusts whatever it returns ──
  {
    const revokeCalls = [];
    const fakeApp = makeApp({
      driver: {},
      db: fakeDb({}),
      lifecycle: { revoke: async (args) => { revokeCalls.push(args); return { advice: "TEST_ADVICE" }; } },
    });
    const disc = await call(fakeApp, "DELETE", "/api/connections/browser/facebook");
    assert.equal(disc.status, 200);
    assert.deepEqual(disc.body, { state: "none", advice: "TEST_ADVICE" });
    assert.deepEqual(revokeCalls, [{ phone: PHONE, platform: "facebook", reason: "agent" }]);
  }

  console.log("routes/connections-browser-delete.test.js ok");
})();
