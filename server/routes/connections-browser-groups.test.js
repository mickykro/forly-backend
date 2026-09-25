/* routes/connections-browser.js — the Facebook group-membership sync run
   inside `finish` (Task 14). Split out of connections-browser.test.js to
   keep both files under the 500-line cap. No network: driver and db are
   fakes; facebook-groups-sync.js is the real module, exercised through a
   fully-faked Playwright `page`, so this proves the wiring, not a duplicate
   of that module's own tests. */
process.env.FORLY_ENV = "local";
process.env.PROFILE_KEY = "k";
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

// A page fake wide enough to run through the WHOLE finish flow, including
// Pages discovery and facebook-groups-sync.syncMembership's own scrape.
function fullFacebookPage(groupLinks, o = {}) {
  return {
    // posting-driver-proof.readSignal's one page read: no dialog, no alert, no captcha frame
    evaluate: o.evaluate || (async () => ({ regions: [[], []], count: 0 })),
    goto: async () => {},
    url: () => "https://www.facebook.com/me",
    innerText: async () => "הפיד שלי",
    title: async () => "Dana Cohen | Facebook",
    mouse: { wheel: async () => {} },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    $$eval: async (sel) => {
      // Pages discovery uses a different selector than the groups scrape;
      // route each call to its own fixture so both run against this one page.
      if (sel.includes("/groups/")) return groupLinks;
      return []; // no managed Pages in this test
    },
  };
}

(async () => {
  // ── finish: a successful scrape stores facebook_groups_member and
  //    facebook_groups_synced_at in the SAME setConnection as the connect ──
  {
    const conn = { browser_session_facebook: { session_id: "s1" } };
    const catalogCalls = [];
    const app = makeApp({
      driver: {
        stopSession: async () => {},
        attachPage: async (id, fn) => fn(fullFacebookPage([
          { href: "https://www.facebook.com/groups/111/?ref=bookmarks", text: "דירות להשכרה בחיפה" },
          { href: "https://www.facebook.com/groups/two.words/", text: "לא רלוונטי" },
        ])),
      },
      db: {
        getConnection: async () => conn,
        setConnection: async (p, patch) => Object.assign(conn, patch),
        listGroupCatalog: async (limit) => { catalogCalls.push(limit); return []; },
      },
    });
    const fin = await call(app, "POST", "/api/connections/browser/facebook/finish");
    assert.equal(fin.status, 200);
    assert.equal(conn.facebook_groups_member.length, 2);
    assert.ok(conn.facebook_groups_synced_at);
    assert.deepEqual(catalogCalls, [500]);

    const byId = Object.fromEntries(conn.facebook_groups_member.map((e) => [e.group_id, e]));
    assert.equal(byId["111"].membership_state, "member");
    assert.equal(byId["111"].name, "דירות להשכרה בחיפה", "real-estate-looking name is kept");
    assert.equal(byId["slug:two.words"].name, undefined, "a name that matches nothing is hashed, not kept");
    assert.ok(byId["slug:two.words"].name_hash);

    // Never a group name/URL in a log line: nothing in this happy path logs
    // at all, since the scrape did not throw.
    assert.equal(fin.body.state, "connected");
  }

  // ── finish: a throwing group scrape does not fail the connect — the rest
  //    of the connection is stored, just with no groups patch ──
  {
    const conn = { browser_session_facebook: { session_id: "s2" } };
    const app = makeApp({
      driver: {
        stopSession: async () => {},
        // A page missing mouse/$$eval/etc: syncMembership throws synchronously.
        attachPage: async (id, fn) => fn({
          goto: async () => {}, url: () => "https://www.facebook.com/me", innerText: async () => "הפיד שלי",
        }),
      },
      db: {
        getConnection: async () => conn,
        setConnection: async (p, patch) => Object.assign(conn, patch),
        listGroupCatalog: async () => { throw new Error("should not be reached"); },
      },
    });
    const fin = await call(app, "POST", "/api/connections/browser/facebook/finish");
    assert.equal(fin.status, 200);
    assert.equal(fin.body.state, "connected");
    assert.ok(conn.facebook_browser_connected_at, "the connect itself still completes");
    assert.equal(conn.facebook_groups_member, undefined, "nothing stored for groups on a sync failure");
    assert.equal(conn.facebook_groups_synced_at, undefined);
  }

  // ── I3: finish never trusts an empty, collapsed or unreadable groups page —
  //    the connect completes, the stored list stays exactly as it was ──
  {
    const prev = Array.from({ length: 10 }, (_, i) => ({ group_id: String(100 + i), membership_state: "member", observed_at: "2026-09-20T00:00:00.000Z", last_confirmed_at: "2026-09-20T00:00:00.000Z" }));
    const cases = [
      ["empty", fullFacebookPage([])],
      ["shrunk", fullFacebookPage([{ href: "https://www.facebook.com/groups/100/", text: "דירות" }, { href: "https://www.facebook.com/groups/101/", text: "דירות" }])],
      ["unreadable", fullFacebookPage([{ href: "https://www.facebook.com/groups/100/", text: "דירות" }], { evaluate: async () => { throw new Error("navigated"); } })],
    ];
    for (const [what, page] of cases) {
      const conn = { browser_session_facebook: { session_id: "s3" }, facebook_groups_member: prev.map((e) => Object.assign({}, e)), facebook_groups_synced_at: "2026-09-20T00:00:00.000Z" };
      const app = makeApp({
        driver: { stopSession: async () => {}, attachPage: async (id, fn) => fn(page) },
        db: { getConnection: async () => conn, setConnection: async (p, patch) => Object.assign(conn, patch), listGroupCatalog: async () => [] },
      });
      const fin = await call(app, "POST", "/api/connections/browser/facebook/finish");
      assert.equal(fin.status, 200, what); assert.equal(fin.body.state, "connected", what);
      assert.deepEqual(conn.facebook_groups_member, prev, `${what}: nothing marked stale`);
      assert.equal(conn.facebook_groups_synced_at, "2026-09-20T00:00:00.000Z", `${what}: not stamped as synced`);
    }
  }

  console.log("routes/connections-browser-groups.test.js ok");
})();
