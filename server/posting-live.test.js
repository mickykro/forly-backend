/* posting-live.js and routes/admin-posting-live.js: the admin's live panel —
   the registry, the driver's guard stopping a skipped or taken-over post, the
   chain holding after the post in hand, and the routes (list, input only once
   taken over, release recording the admin's post). */
const assert = require("assert");
const express = require("express");
const http = require("http");
const live = require("./posting-live");
const D = require("./posting-driver");
const chain = require("./posting-chain");

process.env.PROFILE_KEY = process.env.PROFILE_KEY || "posting-live-test-key";
const PHONE = "972500000001";
function call(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, path, method, headers: { "content-type": "application/json" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let b = d; try { b = JSON.parse(d); } catch { /* text */ } resolve({ status: res.statusCode, body: b }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  // ── the registry ──
  {
    const e = live.open(PHONE, "s1");
    live.step(PHONE, { key: "k1", campaign_id: "camp_abcdef", target_url: "https://www.facebook.com/groups/1" }, "composer_ready");
    assert.equal(live.list(() => "r")[0].state, "running");
    assert.equal(live.denial(PHONE, "k1"), null);
    live.skip(PHONE);
    assert.equal(live.denial(PHONE, "k1"), "admin_skipped", "the post in hand is stopped");
    live.step(PHONE, { key: "k2" }, "session_started");
    assert.equal(live.denial(PHONE, "k2"), null, "a skip is for one post only");
    assert.equal(live.held(PHONE), false);
    live.hold(PHONE);
    assert.equal(live.held(PHONE), true);
    live.takeover(PHONE);
    assert.equal(live.denial(PHONE, "k2"), "admin_takeover");
    const waiting = live.awaitRelease(PHONE, e, 5000);
    assert.equal(live.list(() => "r")[0].state, "taken");
    live.release(PHONE, "posted");
    assert.equal(await waiting, "posted");
    assert.equal(await live.awaitRelease(PHONE, live.open(PHONE, "s2"), 5000), null, "no takeover: no wait");
    live.close(PHONE, live.get(PHONE));
    assert.equal(live.list(() => "r").length, 0);
  }

  // ── the driver: a skip stops the post at its next guard, cancelled, not retried ──
  for (const [lever, code] of [["skip", "admin_skipped"], ["takeover", "admin_takeover"]]) {
    const moves = [];
    const attempt = { key: "k9", phone: PHONE, campaign_id: "c1", target_url: "u" };
    const x = D._test.context("group", { attempt }, { guard: async () => {}, attempts: { transition: async (k, s, d) => { moves.push([s, d]); } } });
    const e = live.open(PHONE, "s3");
    await x.step("session_started");
    await x.guard("navigate");
    live[lever](PHONE);
    let thrown = null;
    try { await x.guard("post"); } catch (err) { thrown = err; }
    assert.ok(thrown && thrown.denied && thrown.admin === code, `${lever}: the guard refuses`);
    assert.equal(await x.allows("post"), false);
    const out = await D._test.settleError(x, thrown);
    assert.equal(out.state, "cancelled");
    assert.deepEqual(moves.pop(), ["cancelled", { error_code: code, reason: code }], `${lever}: recorded as the admin's, not the switches'`);
    live.close(PHONE, e);
  }

  // ── the chain: held → no next post in this session ──
  {
    const e = live.open(PHONE, "s4");
    const s = chain.session(PHONE, { env: {} }, {}, null);
    assert.equal(s.more("verified_posted"), true);
    live.hold(PHONE);
    assert.equal(s.more("verified_posted"), false, "finish, then hold");
    live.close(PHONE, e);
  }

  // ── the routes ──
  {
    const attempts = new Map([["kA", { key: "kA", state: "cancelled", error_code: "admin_takeover", campaign_id: "cmp1" }]]);
    let campaign = { id: "cmp1", status: "running", posts: [{ id: "p1", attempt_key: "kA", status: "skipped", error_code: "admin_takeover" }] };
    const audits = [], inputs = [];
    const store = {
      getAttempt: async (k) => attempts.get(k) || null,
      addAuditEvent: async (a) => { audits.push(a.action); },
      mutatePostingCampaign: async (id, fn) => { const p = fn(campaign); if (p) campaign = Object.assign({}, campaign, p); return campaign; },
    };
    const viewer = { _hubs: new Map([["post|" + PHONE, { closed: false }]]), pipe: (req, res) => res.json({ piped: true }), input: async (k, b) => { inputs.push(b); return {}; } };
    const user = (req, res, next) => { req.user = { userId: "972500000009" }; next(); };
    const app = express();
    app.use(express.json());
    app.use("/live", require("./routes/admin-posting-live")({ requireAdmin: user, requireStepUp: (q, r, n) => n(), store, deps: { store }, env: { FORLY_ENV: "prod", POSTING_ENABLED: "1" }, viewer, liveKey: (p) => "post|" + p }));
    const server = app.listen(0);
    try {
      const e = live.open(PHONE, "s5");
      live.step(PHONE, { key: "kA", campaign_id: "cmp1" }, "composer_ready");
      const list = (await call(server, "GET", "/live/sessions")).body.sessions;
      assert.equal(list.length, 1);
      assert.equal(list[0].phone_tail, "0001");
      assert.ok(!JSON.stringify(list).includes(PHONE), "no phone leaves");
      const ref = list[0].ref;
      assert.equal((await call(server, "GET", `/live/sessions/${ref}/view`)).body.piped, true);
      assert.equal((await call(server, "POST", `/live/sessions/${ref}/view/input`, { t: "click", x: 1, y: 1 })).status, 409, "no mouse before the takeover");
      assert.equal((await call(server, "POST", `/live/sessions/${ref}/release`, { outcome: "posted" })).status, 409);
      assert.equal((await call(server, "POST", `/live/sessions/nope/hold`)).status, 404);
      assert.equal((await call(server, "POST", `/live/sessions/${ref}/takeover`)).status, 200);
      const waiting = live.awaitRelease(PHONE, e, 5000); // the driver stopped
      assert.equal((await call(server, "POST", `/live/sessions/${ref}/view/input`, { t: "click", x: 1, y: 1 })).status, 200);
      assert.equal(inputs.length, 1);
      assert.equal((await call(server, "POST", `/live/sessions/${ref}/release`, { outcome: "maybe" })).status, 400);
      const r = await call(server, "POST", `/live/sessions/${ref}/release`, { outcome: "posted" });
      assert.equal(r.body.recorded, "posted");
      assert.equal(await waiting, "posted", "the browser is let go");
      assert.equal(campaign.posts[0].status, "posted", "the admin's post is on the campaign");
      assert.deepEqual(audits, ["live_takeover", "live_release"]);
      live.close(PHONE, e);
      assert.equal((await call(server, "POST", `/live/sessions/${ref}/hold`)).status, 404, "an ended session is not addressable");
    } finally { server.close(); }
  }
  console.log("posting-live.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
