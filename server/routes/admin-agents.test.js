/* routes/admin-agents.js — pause/resume one agent's automatic posting, and
   their recent activity. Real admin and step-up guards, the in-memory db and
   posting store, the real posting-guard. No network. */
process.env.PROFILE_KEY = "admin-agents-test-profile-key";
const assert = require("assert");
const express = require("express");
const http = require("http");
const auth = require("../auth");
const { makeAdminGuard, makeStepUpGuard } = require("../admin-auth");
const db = require("../db");
const store = require("../posting-store");
const guard = require("../posting-guard");
const M = require("../posting-manual");
const createRouter = require("./admin-agents");

const SECRET = "admin-agents-secret";
const ADMIN = "972500000001", AGENT = "972521230001";
const { requireAdmin } = makeAdminGuard({ verifySession: auth.verifySession, readToken: auth.readToken, authSecret: SECRET, adminPhones: [ADMIN] });
const { requireStepUp } = makeStepUpGuard({ verifySession: auth.verifySession, authSecret: SECRET });
const mount = (env) => { const app = express(); app.use(express.json()); app.use("/a", createRouter({ requireAdmin, requireStepUp, env, deps: { shots: { enabled: () => false } } })); return app; };
const h = (stepup) => Object.assign({ authorization: `Bearer ${auth.signSession(SECRET, ADMIN)}`, "content-type": "application/json" },
  stepup ? { cookie: `forly_stepup=${encodeURIComponent(auth.signSession(SECRET, ADMIN, { scope: "stepup", ttlS: 600 }))}` } : {});
function call(server, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, path, method, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let b = d; try { b = JSON.parse(d); } catch { /* text */ } resolve({ status: res.statusCode, raw: d, body: b }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  await db.setConnection(AGENT, { facebook_browser_connected_at: new Date().toISOString(), posting_permission: { enabled: true, platforms: ["facebook"] } });
  const ref = M.refOf(AGENT);
  const server = mount({ FORLY_ENV: "prod", POSTING_ENABLED: "1" }).listen(0);
  const staging = mount({ FORLY_ENV: "staging", POSTING_ENABLED: "1" }).listen(0);
  try {
    assert.equal((await call(server, "POST", `/a/${ref}/pause`, h(false), { paused: true, reason: "x" })).status, 401, "a change needs a fresh step-up");
    assert.equal((await call(server, "POST", `/a/${ref}/pause`, h(true), { paused: true, reason: " " })).body.error, "reason_required");
    assert.equal((await call(server, "POST", `/a/${ref}/pause`, h(true), { paused: "yes", reason: "x" })).body.field, "paused");
    assert.equal((await call(server, "POST", "/a/acct_nope/pause", h(true), { paused: true, reason: "x" })).status, 404);
    assert.equal((await call(staging, "POST", `/a/${ref}/pause`, h(true), { paused: true, reason: "x" })).status, 503, "never from staging");

    const p = await call(server, "POST", `/a/${ref}/pause`, h(true), { paused: true, reason: "checking the account 0521234567" });
    assert.equal(p.status, 200, p.raw);
    const conn = await db.getConnection(AGENT);
    assert.equal(conn.posting_paused_by_admin.reason, "checking the account …", "no phone in a stored reason");
    await assert.rejects(guard.assertAccountAllowed({ phone: AGENT, platform: "facebook", action: "post" }, { db }), (e) => e.code === "posting_disabled" && e.reason === "paused_by_admin");
    const act = await call(server, "GET", `/a/${ref}/activity`, h(false));
    assert.equal(act.status, 200, act.raw);
    assert.ok(act.body.paused && act.body.paused.at);
    assert.ok(Array.isArray(act.body.attempts) && Array.isArray(act.body.halts));
    assert.ok(!act.raw.includes(AGENT), "no full phone in the activity");

    assert.equal((await call(server, "POST", `/a/${ref}/pause`, h(true), { paused: false, reason: "all good" })).status, 200);
    assert.equal((await db.getConnection(AGENT)).posting_paused_by_admin, null);
    assert.equal(await guard.assertAccountAllowed({ phone: AGENT, platform: "facebook", action: "post" }, { db }), true, "resumed: allowed again");
    const audit = await store.listAuditEvents({ limit: 10 });
    assert.ok(audit.some((e) => e.action === "agent_pause") && audit.some((e) => e.action === "agent_resume"), "both changes audited");
    // ── the agent's own rules: validated, saved whole, applied over the global ones ──
    assert.equal((await call(server, "POST", `/a/${ref}/rules`, h(true), { rules: { nope: 1 } })).body.field, "nope");
    const far = await call(server, "POST", `/a/${ref}/rules`, h(true), { rules: { daily_cap: 0 } });
    assert.deepEqual([far.status, far.body.error, far.body.min], [400, "out_of_range", 1], "prod: no unlimited for an agent either");
    const ok = await call(server, "POST", `/a/${ref}/rules`, h(true), { rules: { daily_cap: 40, min_gap_minutes: 60, weekly_cap: null } });
    assert.equal(ok.status, 200, ok.raw);
    assert.deepEqual((await db.getConnection(AGENT)).posting_rules, { daily_cap: 40, min_gap_minutes: 60 });
    const v = (await call(server, "GET", `/a/${ref}/activity`, h(false))).body.rules;
    assert.deepEqual([v.daily_cap.set, v.daily_cap.applies, v.daily_cap.global, v.weekly_cap.set, v.weekly_cap.applies], [40, 40, 20, null, 100]);
    const cfg = await require("../posting-account").configOf({}, require("../posting-account").ctxOf({ db }), AGENT);
    assert.deepEqual([cfg.daily_cap, cfg.min_gap_minutes], [40, 60], "the posting engine reads the agent's rules");
    await call(server, "POST", `/a/${ref}/rules`, h(true), { rules: {} });
    assert.equal((await db.getConnection(AGENT)).posting_rules, null, "cleared: back to the global rules");
    console.log("routes/admin-agents.test.js ok");
  } finally { server.close(); staging.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
