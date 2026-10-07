/* The manual tab's group limits: the checklist carries them, and marking a
   blocked group "posted" needs a reason, which is audited. */
const assert = require("assert");
const express = require("express");
const http = require("http");
const auth = require("../auth");
const { makeAdminGuard } = require("../admin-auth");
const K = require("../posting-testkit");
const C = require("../posting-campaign");
const createRouter = require("./admin-manual");

const SECRET = "manual-limits-secret", ADMIN = "972500000009", AGENT = "972500000001";
const { requireAdmin } = makeAdminGuard({ verifySession: auth.verifySession, readToken: auth.readToken, authSecret: SECRET, adminPhones: [ADMIN] });
const H = { authorization: `Bearer ${auth.signSession(SECRET, ADMIN)}`, "content-type": "application/json" };
function call(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, path: `/api/admin/manual${path}`, method, headers: H }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }));
    });
    req.on("error", reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
}

(async () => {
  const { deps } = await K.setup(AGENT);
  deps.env = { POSTING_MANUAL: "1", FORLY_ENV: "prod" };
  for (const id of ["pg2", "pg3", "pg4", "pg5"]) await K.db.savePage(K.page(id, AGENT));
  const ids = [];
  for (const id of ["pg1", "pg2", "pg3", "pg4", "pg5"]) ids.push((await C.create(K.base({ page: K.page(id, AGENT) }), deps)).id);
  const app = express(); app.use(express.json());
  app.use("/api/admin/manual", createRouter({ requireAdmin, deps }));
  const server = app.listen(0);
  const done = (id, gid, body) => call(server, "POST", `/campaigns/${id}/groups/${gid}/done`, body);
  const overrides = async () => (await K.store.listAuditEvents({ sinceMs: 0, limit: 50 })).filter((r) => r.action === "manual_limit_override");
  try {
    // three of the agent's posts in group 111 today (pg2..pg4)
    for (const id of ids.slice(1, 4)) assert.equal((await done(id, "111", { status: "posted" })).status, 200);
    const q = (await call(server, "GET", "/queue")).body;
    const g = q.campaigns.find((c) => c.campaign_id === ids[0]).groups.find((x) => x.group_id === "111");
    assert.equal(g.limit.today, 3); assert.equal(g.limit.block.why, "group_daily_cap");
    const free = q.campaigns.find((c) => c.campaign_id === ids[0]).groups.find((x) => x.group_id === "222");
    assert.equal(free.limit.block, null, "an untouched group carries no block");

    // a blocked "posted" without a reason is refused, and audits nothing
    const refused = await done(ids[0], "111", { status: "posted" });
    assert.equal(refused.status, 409); assert.equal(refused.body.error, "group_limit"); assert.equal(refused.body.why, "group_daily_cap");
    assert.equal((await overrides()).length, 0);

    // a skip is never blocked (pg5's 111 is blocked too)
    assert.equal((await done(ids[4], "111", { status: "skipped" })).status, 200, "a skip is never blocked");

    // a reason under 3 characters is refused: 400, nothing audited, nothing posted
    assert.equal((await done(ids[0], "111", { status: "posted", override_reason: "x" })).status, 400, "a reason under 3 characters is refused");
    assert.equal((await done(ids[0], "111", { status: "posted", override_reason: "x".repeat(201) })).status, 400, "a reason over 200 characters is refused");
    assert.equal((await overrides()).length, 0);
    assert.equal((await call(server, "GET", "/queue")).body.items.some((i) => i.campaign_id === ids[0] && i.group_id === "111"), true, "still owed");

    // a free group needs no reason and is not audited
    assert.equal((await done(ids[0], "222", { status: "posted" })).status, 200);
    assert.equal((await overrides()).length, 0);

    // the override: blocked group, a real reason → 200, exactly one audit row, no full phone
    const over = await done(ids[0], "111", { status: "posted", override_reason: "המנהל ביקש" });
    assert.equal(over.status, 200); assert.equal(over.body.ok, true);
    const rows = await overrides();
    assert.equal(rows.length, 1, "exactly one manual_limit_override row");
    assert.equal(rows[0].detail.why, "group_daily_cap");
    assert.equal(rows[0].target_phone_tail, AGENT.slice(-4)); assert.equal(rows[0].operator_tail, ADMIN.slice(-4));
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes(AGENT) && !dump.includes(ADMIN), "no full phone in the audit row");
    assert.ok(!(await call(server, "GET", "/queue")).body.items.some((i) => i.campaign_id === ids[0]), "the campaign is done");
    console.log("routes/admin-manual-limits.test.js ok");
  } finally { server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
