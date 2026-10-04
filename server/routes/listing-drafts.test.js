/* routes/listing-drafts.js — review, create, dismiss. No network: db and
   sweep are fakes. */
const assert = require("assert");
const express = require("express");
const http = require("http");
const createRouter = require("./listing-drafts");

const PHONE = "0500000000";
const requireAuth = () => (req, res, next) => { req.user = { userId: PHONE }; next(); };
const PLATFORMS = { yad2: {}, madlan: {} };

function fakeDb(drafts) {
  return {
    drafts,
    listListingDraftsByPhone: async (phone) => [...drafts.values()].filter((d) => d.phone === phone),
    getListingDraft: async (id) => drafts.get(id) || null,
    updateListingDraft: async (id, patch) => { const d = drafts.get(id); if (d) Object.assign(d, patch); },
    getConnection: async () => ({ yad2_browser_connected_at: "2026-01-01T00:00:00.000Z" }),
  };
}

function makeApp(overrides) {
  const app = express();
  app.use(express.json());
  app.use("/api", createRouter(Object.assign({ requireAuth, authSecret: "s", platforms: PLATFORMS }, overrides)));
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
  // ── list excludes dismissed and created ──
  {
    const drafts = new Map([
      ["a", { id: "a", phone: PHONE, status: "queued" }],
      ["b", { id: "b", phone: PHONE, status: "ready" }],
      ["c", { id: "c", phone: PHONE, status: "dismissed", dismissed_at: "x" }],
      ["d", { id: "d", phone: PHONE, status: "created", page_id: "p1" }],
      ["e", { id: "e", phone: "other-phone", status: "queued" }],
    ]);
    const app = makeApp({ db: fakeDb(drafts) });
    const r = await call(app, "GET", "/api/listing-drafts");
    assert.equal(r.status, 200);
    const ids = r.body.drafts.map((d) => d.id).sort();
    assert.deepEqual(ids, ["a", "b"]);
  }

  // ── ownership: another phone's draft reads as 404, on GET and dismiss ──
  {
    const drafts = new Map([["x", { id: "x", phone: "someone-else", status: "queued" }]]);
    const app = makeApp({ db: fakeDb(drafts) });
    const getR = await call(app, "GET", "/api/listing-drafts/x");
    assert.equal(getR.status, 404);
    const dismissR = await call(app, "POST", "/api/listing-drafts/x/dismiss");
    assert.equal(dismissR.status, 404);
  }

  // ── GET :id returns the agent's own draft ──
  {
    const drafts = new Map([["a", { id: "a", phone: PHONE, status: "ready", title: "דירה" }]]);
    const app = makeApp({ db: fakeDb(drafts) });
    const r = await call(app, "GET", "/api/listing-drafts/a");
    assert.equal(r.status, 200);
    assert.equal(r.body.title, "דירה");
  }

  // ── dismiss flips status and stamps dismissed_at ──
  {
    const drafts = new Map([["a", { id: "a", phone: PHONE, status: "queued" }]]);
    const app = makeApp({ db: fakeDb(drafts) });
    const r = await call(app, "POST", "/api/listing-drafts/a/dismiss");
    assert.equal(r.status, 200);
    assert.equal(drafts.get("a").status, "dismissed");
    assert.ok(drafts.get("a").dismissed_at);
  }

  // ── sweep runs only connected platforms and aggregates the totals ──
  {
    const drafts = new Map();
    const seen = [];
    const sweep = async ({ platform }) => { seen.push(platform); return { found: 1, queued: 1, skipped: 0 }; };
    const app = makeApp({ db: fakeDb(drafts), sweep });
    const r = await call(app, "POST", "/api/listing-drafts/sweep");
    assert.equal(r.status, 200);
    assert.deepEqual(seen, ["yad2"], "madlan is not connected in fakeDb, so it is skipped");
    assert.deepEqual(r.body, { found: 1, queued: 1, skipped: 0 });
  }

  // ── I11: a store error is a 500 JSON answer, never a crashed process ──
  {
    const down = async () => { throw Object.assign(new Error("14 UNAVAILABLE"), { code: 14 }); };
    const app = makeApp({ db: { listListingDraftsByPhone: down, getListingDraft: down, getConnection: down, updateListingDraft: down } });
    for (const [m, path] of [["GET", "/api/listing-drafts"], ["GET", "/api/listing-drafts/d1"], ["POST", "/api/listing-drafts/sweep"], ["POST", "/api/listing-drafts/d1/dismiss"]]) {
      const r = await call(app, m, path);
      assert.equal(r.status, 500, `${m} ${path}`); assert.equal(r.body.error, "internal");
    }
  }

  console.log("routes/listing-drafts.test.js ok");
})();
