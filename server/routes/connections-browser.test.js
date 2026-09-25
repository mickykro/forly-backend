/* routes/connections-browser.js — the embedded login browser. No network:
   driver, db, locks, guard and lifecycle are fakes (or the real modules,
   where a fake would just duplicate their own tests). */
process.env.FORLY_ENV = "local";
const assert = require("assert");
const express = require("express");
const http = require("http");
const createRouter = require("./connections-browser");
const { profileName } = require("../profile-name");

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
// savePendingDelete / clearPendingDelete (profile-lifecycle), on top of the
// plain connection get/set every test needs.
function fakeDb(conn = {}) {
  return {
    conn,
    getConnection: async () => conn,
    setConnection: async (p, patch) => Object.assign(conn, patch),
    getSetting: async () => null,
    cancelOpenAttempts: async () => {},
    savePendingDelete: async () => {},
    clearPendingDelete: async () => {},
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

function fakeGuard(reason) {
  return {
    assertAllowed: async () => {
      if (!reason) return true;
      const e = new Error("posting not allowed"); e.code = "posting_disabled"; e.reason = reason;
      throw e;
    },
  };
}

(async () => {
  // ── start: creates a persisted-profile session and hands back the view URL ──
  let created = null;
  const db1 = fakeDb({});
  const app = makeApp({
    driver: {
      createSession: async (opts) => { created = opts; return { sessionId: "s1", status: "active", cdpUrl: "wss://node/abc" }; },
      getSession: async () => ({ sessionId: "s1", status: "active", cdpUrl: "wss://node/abc" }),
      stopSession: async () => {},
      attachPage: async () => { throw new Error("not used here"); },
    },
    db: db1,
    locks: fakeLocks(),
  });
  const noConsent = await call(app, "POST", "/api/connections/browser/start", { platform: "facebook" });
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.body.error, "consent_required");
  const started = await call(app, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true });
  assert.equal(started.status, 200);
  assert.ok(db1.conn.browser_consent_at, "consent is persisted, not just ticked");
  assert.equal(started.body.session_id, "s1");
  assert.equal(started.body.view_url, "https://viewer.driver.dev?ws=" + encodeURIComponent("wss://node/abc"));
  assert.equal(created.profile.name, profileName("facebook", PHONE));
  assert.equal(created.profile.persist, true);
  assert.equal(created.url, "https://www.facebook.com/login");
  assert.ok(created.duration <= 1500, "long enough for SMS 2FA, not an hour");
  assert.ok(String(created.note).startsWith("forly-connect:"));

  // ── yad2 and madlan: same flow, own profile names, own check URLs ──
  for (const platform of ["yad2", "madlan"]) {
    let created2 = null;
    const appP = makeApp({
      driver: { createSession: async (o) => { created2 = o; return { sessionId: "sx", status: "active", cdpUrl: "wss://n/x" }; } },
      db: fakeDb({}),
      locks: fakeLocks(),
    });
    const r = await call(appP, "POST", "/api/connections/browser/start", { platform, consent: true });
    assert.equal(r.status, 200);
    assert.equal(created2.profile.name, profileName(platform, PHONE));
    assert.ok(created2.url.includes(platform === "yad2" ? "yad2.co.il" : "madlan.co.il"));
  }

  // ── finish for a read-only platform skips Pages discovery entirely ──
  {
    let wentToPages = false;
    const connY = { browser_session_yad2: { session_id: "sy" } };
    const yadApp = makeApp({
      driver: {
        stopSession: async () => {},
        attachPage: async (id, fn) => fn({
          goto: async (url) => { if (String(url).includes("facebook.com")) wentToPages = true; },
          url: () => "https://www.yad2.co.il/my-ads", innerText: async () => "המודעות שלי",
        }),
      },
      db: { getConnection: async () => connY, setConnection: async (p, patch) => Object.assign(connY, patch) },
    });
    const fin = await call(yadApp, "POST", "/api/connections/browser/yad2/finish");
    assert.equal(fin.status, 200);
    assert.deepEqual(fin.body.pages, []);
    assert.equal(wentToPages, false, "Pages discovery is Facebook-only");
  }

  // ── an unknown platform is rejected before any session is created ──
  let touched = false;
  const badApp = makeApp({
    driver: { createSession: async () => { touched = true; return {}; } },
    db: fakeDb({}),
    locks: fakeLocks(),
  });
  const bad = await call(badApp, "POST", "/api/connections/browser/start", { platform: "myspace", consent: true });
  assert.equal(bad.status, 400);
  assert.equal(touched, false);

  // ── status reflects the stored connection, and never leaks a cdpUrl ──
  const st = await call(app, "GET", "/api/connections/browser/facebook/status");
  assert.equal(st.status, 200);
  assert.equal(st.body.state, "open");
  assert.ok(!JSON.stringify(st.body).includes("wss://"), "no cdpUrl in a status response");

  // ── status includes identity_label once connected ──
  {
    const connLabeled = { facebook_browser_connected_at: "2026-09-01T00:00:00Z", facebook_identity_label: "Dana Cohen" };
    const labelApp = makeApp({ db: { getConnection: async () => connLabeled, setConnection: async () => {} } });
    const stLabel = await call(labelApp, "GET", "/api/connections/browser/facebook/status");
    assert.equal(stLabel.status, 200);
    assert.equal(stLabel.body.state, "connected");
    assert.equal(stLabel.body.identity_label, "Dana Cohen");
  }

  // ── profile_busy: the profile lock is held → 409, no session is created ──
  {
    const locks = fakeLocks();
    const release = locks.tryAcquire(); // simulate another holder (e.g. a post in progress)
    assert.ok(release);
    let touchedBusy = false;
    const busyApp = makeApp({
      driver: { createSession: async () => { touchedBusy = true; return {}; } },
      db: fakeDb({}),
      locks,
    });
    const r = await call(busyApp, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "profile_busy");
    assert.equal(touchedBusy, false, "no browser is opened while the profile is busy");
    release();
  }

  // ── the lock is released after /start responds: a second call right after
  //    the first completes is NOT busy (the embedded session stays open, but
  //    the lock itself is only held for the duration of the request) ──
  {
    const locks = fakeLocks();
    const relApp = makeApp({
      driver: { createSession: async () => ({ sessionId: "sB", status: "active", cdpUrl: "wss://n/b" }), stopSession: async () => {} },
      db: fakeDb({}),
      locks,
    });
    const first = await call(relApp, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true });
    assert.equal(first.status, 200);
    assert.equal(locks._isHeld(), false, "lock is released before the response goes out");
    const second = await call(relApp, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true });
    assert.equal(second.status, 200, "not busy: the first request already released the lock");
  }

  // ── an exhausted session budget → 503 driver_busy, and the profile lock is
  //    released too (not leaked because the budget check comes second) ──
  {
    const locks = fakeLocks({ maxSessions: 0 });
    let touchedBudget = false;
    const budgetApp = makeApp({
      driver: { createSession: async () => { touchedBudget = true; return {}; } },
      db: fakeDb({}),
      locks,
    });
    const r = await call(budgetApp, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true });
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: "driver_busy", retry: true });
    assert.equal(touchedBudget, false);
    assert.equal(locks._isHeld(), false, "the profile lock is released when the budget refuses");
  }

  // ── posting_disabled (e.g. global_off) refuses /start before a session is
  //    ever created, unless the reason is profile_revoked (reconnect path) ──
  {
    let touchedGuard = false;
    const guardApp = makeApp({
      driver: { createSession: async () => { touchedGuard = true; return {}; } },
      db: fakeDb({}),
      locks: fakeLocks(),
      guard: fakeGuard("global_off"),
    });
    const r = await call(guardApp, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { error: "posting_disabled", reason: "global_off" });
    assert.equal(touchedGuard, false);
  }

  // ── a quarantined (or revoked) profile reconnects: profile_revoked from the
  //    guard is let through, the gen bumps, the profile name gets "-r1", and
  //    the connection is marked active again ──
  {
    let createdReconnect = null;
    const connQ = { facebook_profile_state: "quarantined", facebook_profile_gen: 0 };
    const dbQ = fakeDb(connQ);
    const reconnectApp = makeApp({
      driver: { createSession: async (opts) => { createdReconnect = opts; return { sessionId: "sq", status: "active", cdpUrl: "wss://n/q" }; }, stopSession: async () => {} },
      db: dbQ,
      locks: fakeLocks(),
      guard: fakeGuard("profile_revoked"),
    });
    const r = await call(reconnectApp, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true });
    assert.equal(r.status, 200);
    assert.equal(createdReconnect.profile.name, profileName("facebook", PHONE, 1));
    assert.equal(connQ.facebook_profile_gen, 1);
    assert.equal(connQ.facebook_profile_state, "active");
  }

  // ── reconnect after a successful DELETE must not leave the OLD generation's
  //    delete bookkeeping on the connection: a later failed delete for the
  //    NEW generation must still get its own pending-delete row and retry,
  //    not be mistaken for "already deleted" because a stale
  //    <platform>_profile_deleted_at from gen0 was still sitting there ──
  {
    const conn = {};
    const db = fakeDb(conn);
    let created = null;
    const reconnectRealApp = makeApp({
      driver: {
        createSession: async (opts) => { created = opts; return { sessionId: "sR" + Math.random(), status: "active", cdpUrl: "wss://n/r" }; },
        stopSession: async () => {},
        deleteProfile: async () => ({ ok: true }),
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
  }

  // ── /start release paths: on a guard refusal, the profile lock and the
  //    session budget are both returned, not leaked ──
  {
    const locks = fakeLocks({ maxSessions: 1 });
    let touchedRefusal = false;
    const refusalApp = makeApp({
      driver: { createSession: async () => { touchedRefusal = true; return {}; } },
      db: fakeDb({}),
      locks,
      guard: fakeGuard("global_off"),
    });
    const r = await call(refusalApp, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true });
    assert.equal(r.status, 409);
    assert.equal(touchedRefusal, false);
    assert.equal(locks._isHeld(), false, "the profile lock is released after a guard refusal");
    assert.equal(locks._sessions(), 0, "the session budget slot is returned after a guard refusal");
  }

  // ── /start release paths: when createSession throws, the response is 503,
  //    the lock and budget are released, and the gen is NOT bumped ──
  {
    const locks = fakeLocks({ maxSessions: 1 });
    const connFail = { facebook_profile_state: "quarantined", facebook_profile_gen: 0 };
    const dbFail = fakeDb(connFail);
    const failApp = makeApp({
      driver: { createSession: async () => { throw new Error("driver down"); }, stopSession: async () => {} },
      db: dbFail,
      locks,
      guard: fakeGuard("profile_revoked"), // let the reconnect path through, so the gen-bump path runs too
    });
    const r = await call(failApp, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "extract_unavailable");
    assert.equal(locks._isHeld(), false, "the profile lock is released when createSession throws");
    assert.equal(locks._sessions(), 0, "the session budget slot is returned when createSession throws");
    assert.equal(connFail.facebook_profile_gen, 0, "a failed createSession must not persist the gen bump");
    assert.notEqual(connFail.facebook_profile_state, "active", "a failed createSession must not persist the reconnect");
  }

  // ── /start stops an already-open login session before starting a new one,
  //    so the same profile is never driven from two browsers at once ──
  {
    const stoppedFirst = [];
    const connOpen = { browser_session_facebook: { session_id: "sOld" } };
    const dbOpen = fakeDb(connOpen);
    const reopenApp = makeApp({
      driver: {
        createSession: async () => ({ sessionId: "sNew", status: "active", cdpUrl: "wss://n/new" }),
        stopSession: async (id) => stoppedFirst.push(id),
      },
      db: dbOpen,
      locks: fakeLocks(),
    });
    const r = await call(reopenApp, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true });
    assert.equal(r.status, 200);
    assert.deepEqual(stoppedFirst, ["sOld"]);
    assert.equal(connOpen.browser_session_facebook.session_id, "sNew");
  }

  // ── finish: logged in → connected, and the session is stopped ──
  const stopped = [];
  const conn2 = { browser_session_facebook: { session_id: "s2", started_at: new Date().toISOString() } };
  const okApp = makeApp({
    driver: {
      getSession: async () => ({ sessionId: "s2", status: "active", cdpUrl: "wss://n/2" }),
      stopSession: async (id) => stopped.push(id),
      attachPage: async (id, fn) => fn({
        goto: async () => {}, url: () => "https://www.facebook.com/me", innerText: async () => "הפיד שלי",
      }),
    },
    db: { getConnection: async () => conn2, setConnection: async (p, patch) => Object.assign(conn2, patch) },
  });
  const fin = await call(okApp, "POST", "/api/connections/browser/facebook/finish");
  assert.equal(fin.status, 200);
  assert.equal(fin.body.state, "connected");
  assert.deepEqual(stopped, ["s2"]);
  assert.ok(conn2.facebook_browser_connected_at);

  // ── finish while still on a login wall → 409, and the session is KEPT: the agent
  //    is probably waiting for an SMS code; killing it forces a second login from a
  //    second IP within minutes ──
  const stopped2 = [];
  const conn3 = { browser_session_facebook: { session_id: "s3" } };
  const wallApp = makeApp({
    driver: {
      getSession: async () => ({ sessionId: "s3", status: "active", cdpUrl: "wss://n/3" }),
      stopSession: async (id) => stopped2.push(id),
      attachPage: async (id, fn) => fn({
        goto: async () => {}, url: () => "https://www.facebook.com/login/?next=%2Fme", innerText: async () => "התחברות",
      }),
    },
    db: { getConnection: async () => conn3, setConnection: async (p, patch) => Object.assign(conn3, patch) },
  });
  const notIn = await call(wallApp, "POST", "/api/connections/browser/facebook/finish");
  assert.equal(notIn.status, 409);
  assert.equal(notIn.body.error, "not_logged_in");
  assert.deepEqual(stopped2, [], "session kept alive for another try");
  assert.ok(conn3.browser_session_facebook, "still recorded as open");

  // ── the local browser budget is full → 503 driver_busy, NOT "session expired"
  //    (which sends the agent to open a second browser on the same profile) ──
  const { DriverError } = require("../driver-browser");
  const stoppedBusy = [];
  const connBusy = { browser_session_facebook: { session_id: "s4" } };
  const busyApp = makeApp({
    driver: {
      getSession: async () => ({ sessionId: "s4", status: "active", cdpUrl: "wss://n/4" }),
      stopSession: async (id) => stoppedBusy.push(id),
      attachPage: async () => { throw new DriverError(429, "local concurrency budget"); },
    },
    db: { getConnection: async () => connBusy, setConnection: async (p, patch) => Object.assign(connBusy, patch) },
  });
  const busy = await call(busyApp, "POST", "/api/connections/browser/facebook/finish");
  assert.equal(busy.status, 503);
  assert.deepEqual(busy.body, { error: "driver_busy", retry: true });
  assert.deepEqual(stoppedBusy, [], "the agent's login browser is kept");
  assert.ok(connBusy.browser_session_facebook, "still recorded as open");

  // ── a session Driver no longer knows is still session_expired ──
  const goneApp = makeApp({
    driver: {
      getSession: async () => { throw new DriverError(404, "not found"); },
      stopSession: async () => {},
      attachPage: async () => { throw new DriverError(404, "session not found"); },
    },
    db: { getConnection: async () => ({ browser_session_facebook: { session_id: "s5" } }), setConnection: async () => {} },
  });
  const gone = await call(goneApp, "POST", "/api/connections/browser/facebook/finish");
  assert.equal(gone.status, 409);
  assert.equal(gone.body.error, "session_expired");
  assert.ok(!conn3.facebook_browser_connected_at);

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

  console.log("routes/connections-browser.test.js ok");
})();
