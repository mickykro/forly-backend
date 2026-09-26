/* routes/dev-driver.js — the dev live-session viewer. No network: the real
   driver-browser registry is fed by a stubbed fetch; the guards are the real
   admin and step-up guards over real signed tokens. */
process.env.FORLY_ENV = "local";
const assert = require("assert");
const express = require("express");
const http = require("http");
const auth = require("../auth");
const { makeAdminGuard, makeStepUpGuard } = require("../admin-auth");
const D = require("../driver-browser");
const createRouter = require("./dev-driver");

const SECRET = "dev-driver-secret";
const ADMIN_A = "972500000001";
const ADMIN_B = "972500000002";
const CDP = "wss://node.driver.dev/secret-session-path";

const { requireAdmin } = makeAdminGuard({ verifySession: auth.verifySession, readToken: auth.readToken, authSecret: SECRET, adminPhones: [ADMIN_A, ADMIN_B] });
const { requireStepUp } = makeStepUpGuard({ verifySession: auth.verifySession, authSecret: SECRET });

const app = express();
app.use(express.json());
app.use("/api/dev/driver", createRouter({ requireAdmin, requireStepUp, driver: D }));

const headersFor = (phone, { stepup = false } = {}) => {
  const h = { authorization: `Bearer ${auth.signSession(SECRET, phone)}` };
  if (stepup) h.cookie = `forly_stepup=${encodeURIComponent(auth.signSession(SECRET, phone, { scope: "stepup", ttlS: 600 }))}`;
  return h;
};

function call(server, method, path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ port: server.address().port, path, method, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        let body = d;
        try { body = JSON.parse(d); } catch (e) { /* text */ }
        resolve({ status: res.statusCode, headers: res.headers, raw: d, body });
      });
    });
    req.end();
  });
}

(async () => {
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    // A live session in the real registry, as createSession records it.
    D._test.setDevView(true);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => null } });
    await D.createSession({ note: "forly-connect:facebook" }, { apiKey: "k", fetchFn: async () => ok({ sessionId: "sess-1", status: "active", cdpUrl: CDP }) });

    // ── the list: admin only, and never a cdpUrl ──
    assert.equal((await call(server, "GET", "/api/dev/driver/sessions")).status, 401);
    const list = await call(server, "GET", "/api/dev/driver/sessions", headersFor(ADMIN_A));
    assert.equal(list.status, 200);
    assert.equal(list.body.sessions.length, 1);
    assert.equal(list.body.sessions[0].sessionId, "sess-1");
    assert.equal(list.body.sessions[0].platform, "facebook");
    assert.ok(!/wss?:\/\//.test(list.raw) && !list.raw.includes("secret-session-path"), list.raw);

    // ── a grant needs a fresh step-up ──
    const noStep = await call(server, "POST", "/api/dev/driver/sessions/sess-1/grant", headersFor(ADMIN_A));
    assert.equal(noStep.status, 401);
    assert.equal(noStep.body.error, "stepup_required");
    const unknown = await call(server, "POST", "/api/dev/driver/sessions/nope/grant", headersFor(ADMIN_A, { stepup: true }));
    assert.equal(unknown.status, 404);

    const grant = await call(server, "POST", "/api/dev/driver/sessions/sess-1/grant", headersFor(ADMIN_A, { stepup: true }));
    assert.equal(grant.status, 200);
    assert.equal(grant.headers["cache-control"], "no-store");
    assert.equal(grant.body.expires_in, 300);
    assert.ok(/^\/api\/dev\/driver\/view\/[0-9a-f]{32}$/.test(grant.body.open_url), grant.body.open_url);
    assert.ok(!grant.raw.includes("wss") && !grant.raw.includes("viewer.driver.dev"), grant.raw);

    // ── the grant redirects once, then is gone ──
    const view = await call(server, "GET", grant.body.open_url, headersFor(ADMIN_A));
    assert.equal(view.status, 302);
    assert.equal(view.headers.location, "https://viewer.driver.dev?ws=" + encodeURIComponent(CDP));
    assert.equal(view.headers["cache-control"], "no-store");
    assert.equal(view.headers["referrer-policy"], "no-referrer");
    const again = await call(server, "GET", grant.body.open_url, headersFor(ADMIN_A));
    assert.equal(again.status, 410);
    assert.equal(again.raw, "expired");

    // ── another admin cannot spend someone else's grant ──
    const g2 = await call(server, "POST", "/api/dev/driver/sessions/sess-1/grant", headersFor(ADMIN_A, { stepup: true }));
    assert.equal((await call(server, "GET", g2.body.open_url)).status, 401, "not even without a session");
    const stolen = await call(server, "GET", g2.body.open_url, headersFor(ADMIN_B));
    assert.equal(stolen.status, 410);
    assert.ok(!stolen.headers.location);

    // ── ADMIN_B's own step-up does not make ADMIN_A's session a step-up ──
    const mixed = headersFor(ADMIN_A);
    mixed.cookie = headersFor(ADMIN_B, { stepup: true }).cookie;
    assert.equal((await call(server, "POST", "/api/dev/driver/sessions/sess-1/grant", mixed)).status, 401);

    // ── in-page view: any admin, no step-up, no browser address; live sessions only ──
    {
      const attached = [], inputs = [];
      const fake = {
        attach: async (key, id) => { attached.push([key, id]); return { last: null }; },
        pipe: (req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ t: "end", reason: "closed" })}\n\n`); },
        input: async (key, body) => { inputs.push([key, body]); return {}; },
      };
      const app2 = express(); app2.use(express.json());
      app2.use("/api/dev/driver", createRouter({ requireAdmin, requireStepUp, driver: D, viewer: fake }));
      const s2 = await new Promise((r) => { const x = app2.listen(0, () => r(x)); });
      try {
        assert.equal((await call(s2, "GET", "/api/dev/driver/sessions/sess-1/view")).status, 401, "admins only");
        assert.equal((await call(s2, "GET", "/api/dev/driver/sessions/nope/view", headersFor(ADMIN_B))).status, 404, "only a browser this server opened");
        const v = await call(s2, "GET", "/api/dev/driver/sessions/sess-1/view", headersFor(ADMIN_B));
        assert.equal(v.status, 200); assert.match(v.headers["content-type"], /event-stream/);
        assert.deepEqual(attached[0], ["dev|sess-1", "sess-1"]);
        assert.ok(!v.raw.includes("wss") && !v.raw.includes("viewer.driver.dev"));
        const inp = await new Promise((resolve) => {
          const req = http.request({ port: s2.address().port, path: "/api/dev/driver/sessions/sess-1/view/input", method: "POST", headers: Object.assign({ "content-type": "application/json" }, headersFor(ADMIN_B)) }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
          req.end(JSON.stringify({ t: "click", x: 0.5, y: 0.5 }));
        });
        assert.equal(inp, 200); assert.deepEqual(inputs[0], ["dev|sess-1", { t: "click", x: 0.5, y: 0.5 }]);
      } finally { s2.close(); }
    }

    // ── the posting panel: why nothing happens; run a sweep; browse now ──
    {
      const conn = { facebook_browser_connected_at: "2026-09-26T08:00:00.000Z", last_browse_at: "2026-09-26T09:00:00.000Z" };
      let blocked = null, lockFree = true, released = 0, swept = 0;
      const dwellCalls = [];
      const posting = {
        deps: { env: {} },
        sweeper: { status: () => ({ started: true, last: { at: "t", result: "off", reason: "global_off" }, accounts: [{ phone: ADMIN_A, at: "t2", outcome: "browse_only" }] }), sweep: async () => { swept++; return 1; } },
        guard: {
          assertAllowed: async () => { if (blocked) throw Object.assign(new Error("off"), { code: "posting_disabled", reason: blocked }); },
          assertFleetAllowed: async () => { if (blocked) throw Object.assign(new Error("off"), { code: "posting_disabled", reason: blocked }); },
        },
        db: { getConnection: async (p) => (p === ADMIN_A ? conn : null) },
        store: {
          listPostingCampaignsByPhone: async () => [{ status: "running" }],
          listDwellSessionsByPhone: async () => [
            { at: "2026-09-26T08:00:00.000Z", actions_summary: { scroll: 1 }, likes: [] },
            { at: "2026-09-26T09:00:00.000Z", actions_summary: { scroll: 12, open_post: 3, like: 0 }, likes: [], halt_related: false },
          ],
        },
        locks: { tryAcquire: () => (lockFree ? () => { released++; } : null) },
        dwell: async (args, deps) => { dwellCalls.push([args, deps]); },
      };
      const app3 = express(); app3.use(express.json());
      app3.use("/api/dev/driver", createRouter({ requireAdmin, requireStepUp, driver: D, posting }));
      const app4 = express(); app4.use("/api/dev/driver", createRouter({ requireAdmin, requireStepUp, driver: D }));
      const s3 = await new Promise((r) => { const x = app3.listen(0, () => r(x)); });
      const s4 = await new Promise((r) => { const x = app4.listen(0, () => r(x)); });
      try {
        assert.deepEqual((await call(s4, "GET", "/api/dev/driver/posting", headersFor(ADMIN_A))).body, { enabled: false }, "Driver off: the panel says so");
        assert.equal((await call(s3, "GET", "/api/dev/driver/posting")).status, 401, "admins only");
        blocked = "global_off";
        const st = (await call(s3, "GET", "/api/dev/driver/posting", headersFor(ADMIN_A))).body;
        assert.equal(st.fleet_off, "global_off"); assert.equal(st.sweeper.last.reason, "global_off");
        assert.equal(st.me.connected, true); assert.equal(st.me.running, 1); assert.equal(st.me.dwell_blocked, "global_off");
        assert.equal(st.me.last_tick.outcome, "browse_only");
        assert.deepEqual(st.me.last_session, { at: "2026-09-26T09:00:00.000Z", actions: { scroll: 12, open_post: 3, like: 0 }, likes: 0, halt_related: false }, "the newest browse, counts only");
        assert.equal(st.me.next_browse_at, "2026-09-27T05:00:00.000Z", "20 h after the last browse");
        assert.ok(!JSON.stringify(st).includes(ADMIN_A), "phone tails only");

        const post = (path, who) => call(s3, "POST", `/api/dev/driver/posting/${path}`, headersFor(who));
        const r1 = await post("browse", ADMIN_A);
        assert.equal(r1.status, 409); assert.equal(r1.body.reason, "global_off"); assert.equal(dwellCalls.length, 0);
        blocked = null;
        assert.equal((await post("browse", ADMIN_B)).body.error, "facebook_not_connected");
        lockFree = false;
        assert.equal((await post("browse", ADMIN_A)).body.error, "profile_busy");
        lockFree = true;
        assert.equal((await post("browse", ADMIN_A)).status, 202);
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(dwellCalls.length, 1); assert.equal(dwellCalls[0][1].lockHeld, true); assert.equal(dwellCalls[0][0].note, "forly-dwell:");
        assert.equal(released, 1, "the profile lock is released when the browse ends");
        assert.equal((await post("sweep", ADMIN_A)).body.ticked, 1); assert.equal(swept, 1);
      } finally { s3.close(); s4.close(); }
    }

    console.log("routes/dev-driver.test.js ok");
  } finally {
    D._test.setDevView(false);
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
