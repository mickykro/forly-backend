/* routes/connections-browser.js — GET /:platform/view and POST /:platform/view/input.
   The viewer is a fake; connect-viewer.test.js covers the relay itself. */
process.env.FORLY_ENV = "local";
const assert = require("assert");
const express = require("express");
const http = require("http");
const createRouter = require("./connections-browser");

const PHONE = "0500000000";
const requireAuth = () => (req, res, next) => { req.user = { userId: PHONE }; next(); };

function fakeViewer() {
  const v = { attached: [], closed: [], inputs: [], subs: new Set(), attachError: null, inputError: null };
  v.hub = { last: null };
  v.attach = async (key, sid) => { if (v.attachError) { const e = new Error(v.attachError); e.code = v.attachError; throw e; } v.attached.push([key, sid]); return v.hub; };
  v.subscribe = (hub, fn) => { v.subs.add(fn); return () => v.subs.delete(fn); };
  v.pipe = (req, res, hub) => require("../connect-viewer").pipe(req, res, hub, v.subscribe);
  v.emit = (evt) => { for (const fn of [...v.subs]) fn(evt); };
  v.close = async (key, reason) => { v.closed.push([key, reason]); };
  v.input = async (key, body) => { if (v.inputError) { const e = new Error(v.inputError); e.code = v.inputError; throw e; } v.inputs.push([key, body]); return { editable: true }; };
  return v;
}
function listen(app) { return new Promise((ok) => { const s = app.listen(0, () => ok(s)); }); }
function request(port, method, path, body) {
  return new Promise((resolve) => {
    const req = http.request({ port, path, method, headers: { "content-type": "application/json" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: d ? JSON.parse(d) : {} }));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const conn = { browser_session_madlan: { session_id: "sM" } };
  const db = { getConnection: async () => conn, setConnection: async (p, patch) => Object.assign(conn, patch) };
  const viewer = fakeViewer();
  const app = express(); app.use(express.json());
  app.use("/api/connections/browser", createRouter({ requireAuth, authSecret: "s", db, viewer, driver: { stopSession: async () => {} } }));
  const server = await listen(app);
  const port = server.address().port;

  // ── no open login browser → 409; unknown platform → 400 ──
  assert.equal((await request(port, "GET", "/api/connections/browser/yad2/view")).status, 409);
  assert.equal((await request(port, "GET", "/api/connections/browser/instagram/view")).status, 400);

  // ── attach failures map to codes the page understands ──
  viewer.attachError = "session_expired";
  let r = await request(port, "GET", "/api/connections/browser/madlan/view");
  assert.deepEqual([r.status, r.body.error], [409, "session_expired"]);
  viewer.attachError = "driver_busy";
  r = await request(port, "GET", "/api/connections/browser/madlan/view");
  assert.deepEqual([r.status, r.body.error], [503, "driver_busy"]);
  viewer.attachError = "something_else";
  r = await request(port, "GET", "/api/connections/browser/madlan/view");
  assert.deepEqual([r.status, r.body.error], [503, "viewer_unavailable"]);
  viewer.attachError = null;

  // ── the stream: this phone's own session, SSE, frames then end ──
  const text = await new Promise((resolve) => {
    http.get({ port, path: "/api/connections/browser/madlan/view" }, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"], /^text\/event-stream/);
      assert.match(res.headers["cache-control"], /no-store/);
      let d = "";
      res.on("data", (c) => {
        d += c;
        if (d.includes(": open") && !d.includes("frame")) {
          viewer.emit({ t: "frame", d: "AAAA", w: 800, h: 600, u: "https://www.madlan.co.il/" });
          viewer.emit({ t: "end", reason: "connected" });
        }
      });
      res.on("end", () => resolve(d));
    });
  });
  assert.deepEqual(viewer.attached[0], [`${PHONE}|madlan`, "sM"]);
  const events = text.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  assert.deepEqual(events.map((e) => e.t), ["frame", "end"]);
  assert.ok(!text.includes("wss://"));
  await new Promise((r2) => setTimeout(r2, 20));
  assert.equal(viewer.subs.size, 0, "the viewer unsubscribes when the stream ends");

  // ── input: keyed by the signed-in phone, errors mapped ──
  r = await request(port, "POST", "/api/connections/browser/madlan/view/input", { t: "click", x: 0.1, y: 0.2 });
  assert.deepEqual([r.status, r.body], [200, { editable: true }]);
  assert.deepEqual(viewer.inputs[0], [`${PHONE}|madlan`, { t: "click", x: 0.1, y: 0.2 }]);
  for (const [code, status] of [["no_viewer", 409], ["invalid_input", 400], ["slow_down", 429], ["input_failed", 502], ["weird", 502]]) {
    viewer.inputError = code;
    r = await request(port, "POST", "/api/connections/browser/madlan/view/input", { t: "back" });
    assert.equal(r.status, status, code);
  }
  viewer.inputError = null;
  assert.equal((await request(port, "POST", "/api/connections/browser/nope/view/input", { t: "back" })).status, 400);

  // ── disconnect closes the viewer before revoking ──
  const app2 = express(); app2.use(express.json());
  const v2 = fakeViewer();
  app2.use("/api/connections/browser", createRouter({ requireAuth, authSecret: "s", db, viewer: v2,
    lifecycle: { revoke: async () => ({ advice: null }) } }));
  const s2 = await listen(app2);
  r = await request(s2.address().port, "DELETE", "/api/connections/browser/madlan");
  assert.equal(r.status, 200);
  assert.deepEqual(v2.closed[0], [`${PHONE}|madlan`, "closed"]);
  s2.close();

  server.close();
  console.log("connections-browser-view.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
