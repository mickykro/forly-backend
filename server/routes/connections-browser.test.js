/* routes/connections-browser.js — the embedded login browser. No network:
   driver and db are fakes. */
process.env.FORLY_ENV = "local";
const assert = require("assert");
const express = require("express");
const http = require("http");
const createRouter = require("./connections-browser");

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

(async () => {
  // ── start: creates a persisted-profile session and hands back the view URL ──
  let created = null;
  const conn = {};
  const app = makeApp({
    driver: {
      createSession: async (opts) => { created = opts; return { sessionId: "s1", status: "active", cdpUrl: "wss://node/abc" }; },
      getSession: async () => ({ sessionId: "s1", status: "active", cdpUrl: "wss://node/abc" }),
      stopSession: async () => {},
      attachPage: async () => { throw new Error("not used here"); },
    },
    db: { getConnection: async () => conn, setConnection: async (p, patch) => Object.assign(conn, patch) },
  });
  const noConsent = await call(app, "POST", "/api/connections/browser/start", { platform: "facebook" });
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.body.error, "consent_required");
  const started = await call(app, "POST", "/api/connections/browser/start", { platform: "facebook", consent: true });
  assert.equal(started.status, 200);
  assert.ok(conn.browser_consent_at, "consent is persisted, not just ticked");
  assert.equal(started.body.session_id, "s1");
  assert.equal(started.body.view_url, "https://viewer.driver.dev?ws=" + encodeURIComponent("wss://node/abc"));
  assert.equal(created.profile.name, require("../profile-name").profileName("facebook", PHONE));
  assert.equal(created.profile.persist, true);
  assert.equal(created.url, "https://www.facebook.com/login");
  assert.ok(created.duration <= 1500, "long enough for SMS 2FA, not an hour");
  assert.ok(String(created.note).startsWith("forly-connect:"));

  // ── yad2 and madlan: same flow, own profile names, own check URLs ──
  for (const platform of ["yad2", "madlan"]) {
    let created2 = null;
    const appP = makeApp({
      driver: { createSession: async (o) => { created2 = o; return { sessionId: "sx", status: "active", cdpUrl: "wss://n/x" }; } },
      db: { getConnection: async () => ({}), setConnection: async () => {} },
    });
    const r = await call(appP, "POST", "/api/connections/browser/start", { platform, consent: true });
    assert.equal(r.status, 200);
    assert.equal(created2.profile.name, require("../profile-name").profileName(platform, PHONE));
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
    db: { getConnection: async () => ({}), setConnection: async () => {} },
  });
  const bad = await call(badApp, "POST", "/api/connections/browser/start", { platform: "myspace", consent: true });
  assert.equal(bad.status, 400);
  assert.equal(touched, false);

  // ── status reflects the stored connection, and never leaks a cdpUrl ──
  const st = await call(app, "GET", "/api/connections/browser/facebook/status");
  assert.equal(st.status, 200);
  assert.equal(st.body.state, "open");
  assert.ok(!JSON.stringify(st.body).includes("wss://"), "no cdpUrl in a status response");

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
  assert.ok(!conn3.facebook_browser_connected_at);

  // ── disconnect: clears the connection and deletes the profile
  //    (campaign-stopping is Phase 3, not implemented here) ──
  const deleted = [];
  const conn4 = { facebook_browser_connected_at: "2026-09-01T00:00:00Z" };
  const discApp = makeApp({
    driver: { deleteProfile: async (name) => deleted.push(name), stopSession: async () => {} },
    db: { getConnection: async () => conn4, setConnection: async (p, patch) => Object.assign(conn4, patch) },
  });
  const disc = await call(discApp, "DELETE", "/api/connections/browser/facebook");
  assert.equal(disc.status, 200);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0], require("../profile-name").profileName("facebook", PHONE));
  assert.equal(conn4.facebook_browser_connected_at, null);
  assert.ok(conn4.facebook_browser_disconnected_at);

  console.log("routes/connections-browser.test.js ok");
})();
