// server/routes/admin-campaigns.test.js
/* routes/admin-campaigns.js — real admin and step-up guards over signed
   tokens, the memory db and posting store (posting-testkit), WhatsApp captured. */
process.env.PROFILE_KEY = "admin-campaigns-test-key";
process.env.FORLY_ENV = "local";
const assert = require("assert");
const express = require("express");
const http = require("http");
const auth = require("../auth");
const { makeAdminGuard, makeStepUpGuard } = require("../admin-auth");
const K = require("../posting-testkit");
const M = require("../posting-manual");
const createRouter = require("./admin-campaigns");

const SECRET = "admin-campaigns-secret", ADMIN = "972500000009", AGENT = "972500000001";
const { requireAdmin } = makeAdminGuard({ verifySession: auth.verifySession, readToken: auth.readToken, authSecret: SECRET, adminPhones: [ADMIN] });
const { requireStepUp } = makeStepUpGuard({ verifySession: auth.verifySession, authSecret: SECRET });
const headers = (stepup) => {
  const h = { authorization: `Bearer ${auth.signSession(SECRET, ADMIN)}`, "content-type": "application/json" };
  if (stepup) h.cookie = `forly_stepup=${encodeURIComponent(auth.signSession(SECRET, ADMIN, { scope: "stepup", ttlS: 600 }))}`;
  return h;
};
function call(server, method, path, body, stepup = true) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, path: `/api/admin/campaigns${path}`, method, headers: headers(stepup) }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const CATALOG = async () => [
  { url: K.G(111), name: "A", agent_policy: "explicitly_allowed", listing_types: [] },
  { url: K.G(222), name: "B", agent_policy: "explicitly_allowed", listing_types: [] },
];
const CONSENT = { method: "phone", note: "הסוכן אישר בטלפון" };

(async () => {
  const { deps, notes } = await K.setup(AGENT);
  // db.js has no memory path for businesses (setBusiness is a no-op), so serve the agent's name through the deps.
  const rdeps = Object.assign({}, deps, { db: Object.assign(Object.create(deps.db || K.db), { getBusiness: async (p) => (p === AGENT ? { phone: AGENT, full_name: "דנה לוי" } : null) }) });
  const app = express(); app.use(express.json());
  app.use("/api/admin/campaigns", createRouter({ requireAdmin, requireStepUp, deps: rdeps, env: deps.env, catalog: CATALOG }));
  const server = app.listen(0);
  const REF = M.refOf(AGENT);
  const audits = async () => (await K.store.listAuditEvents({ sinceMs: 0, limit: 50 }));
  try {
    // ── pickers ──
    assert.deepEqual((await call(server, "GET", "/agents", undefined, false)).body.agents.map((a) => a.ref), [REF]);
    assert.ok((await call(server, "GET", `/agents/${REF}/properties`, undefined, false)).body.properties.some((p) => p.page_id === "pg1"));
    assert.deepEqual((await call(server, "GET", `/agents/${REF}/groups`, undefined, false)).body.groups.map((g) => g.group_id), ["111", "222"]);

    // ── create: step-up, consent, checks ──
    const body = { agent: REF, page_id: "pg1", group_ids: ["111", "222"], mode: "standing", days: 14, consent: CONSENT };
    assert.equal((await call(server, "POST", "/campaigns", body, false)).status, 401, "step-up required");
    assert.equal((await call(server, "POST", "/campaigns", Object.assign({}, body, { consent: { method: "phone", note: " " } }))).body.error, "consent_note_required");
    assert.equal((await call(server, "POST", "/campaigns", Object.assign({}, body, { page_id: "pgX" }))).status, 404);
    const made = await call(server, "POST", "/campaigns", body);
    assert.equal(made.status, 201);
    const row = made.body.campaign;
    assert.equal(row.created_by, "admin");
    assert.equal(row.consent_by.method, "phone");
    assert.equal(notes.length, 1, "agent told about the new campaign");
    const again = await call(server, "POST", "/campaigns", body);
    assert.equal(again.status, 200); assert.equal(again.body.existing, true);

    // ── list ──
    const list = (await call(server, "GET", `/campaigns?agent=${REF}`, undefined, false)).body.campaigns;
    assert.equal(list.length, 1); assert.equal(list[0].agent_name, "דנה לוי");
    assert.ok(!JSON.stringify(list).includes(AGENT), "no full phone in the list");

    // ── edit: version, remove, text ──
    for (const bad of [{ days: 5 }, { version: "", days: 5 }]) {
      const r = await call(server, "PATCH", `/campaigns/${row.id}`, bad);
      assert.equal(r.status, 400); assert.equal(r.body.error, "invalid_input");
    }
    assert.equal((await call(server, "GET", `/campaigns?agent=${REF}`, undefined, false)).body.campaigns[0].version, row.version, "refused edits leave the campaign unchanged");
    const stale = await call(server, "PATCH", `/campaigns/${row.id}`, { version: "old", days: 5 });
    assert.equal(stale.status, 409); assert.equal(stale.body.error, "stale_version");
    const edited = await call(server, "PATCH", `/campaigns/${row.id}`, { version: row.version, remove_group_ids: ["222"], copies: { 111: "שלום" } });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.body.campaign.groups.map((g) => g.group_id), ["111"]);
    const back = await call(server, "PATCH", `/campaigns/${row.id}`, { version: edited.body.campaign.version, add_group_ids: ["222"] });
    assert.deepEqual(back.body.campaign.groups.map((g) => g.group_id), ["111", "222"]);
    assert.equal(notes.length, 1, "edits are silent");

    // ── stop / start ──
    const stopped = await call(server, "POST", `/campaigns/${row.id}/stop`, {});
    assert.equal(stopped.body.campaign.status, "stopped");
    assert.equal(notes.length, 2, "agent told about the stop");
    assert.equal((await call(server, "POST", `/campaigns/${row.id}/start`, {})).body.error, "consent_note_required", "a restart needs a fresh consent");
    const restarted = await call(server, "POST", `/campaigns/${row.id}/start`, { consent: CONSENT });
    assert.equal(restarted.body.campaign.status, "running");
    await K.db.setConnection(AGENT, { posting_disabled_until_admin: true });
    await K.store.mutatePostingCampaign(row.id, () => ({ status: "paused", pause_reason: "agent" }));
    const halted = await call(server, "POST", `/campaigns/${row.id}/start`, {});
    assert.equal(halted.status, 409); assert.equal(halted.body.error, "account_halted");
    assert.equal(notes.length, 2, "starts are silent");

    // ── audit rows: one per change, no phone, no text ──
    const rows = await audits();
    for (const a of ["create_campaign", "edit_campaign", "stop_campaign", "start_campaign"]) assert.ok(rows.some((r) => r.action === a), a);
    assert.ok(!JSON.stringify(rows).includes(AGENT) && !JSON.stringify(rows).includes("שלום"));

    // ── staging never changes campaigns ──
    const sApp = express(); sApp.use(express.json());
    sApp.use("/api/admin/campaigns", createRouter({ requireAdmin, requireStepUp, deps: rdeps, env: { FORLY_ENV: "staging" }, catalog: CATALOG }));
    const sServer = sApp.listen(0);
    try { assert.equal((await call(sServer, "POST", "/campaigns", body)).status, 503); } finally { sServer.close(); }
    console.log("routes/admin-campaigns.test.js ok");
  } finally { server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
