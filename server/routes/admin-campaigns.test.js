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
const campaigns = require("../posting-campaign");

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

    await K.db.savePage(K.page("pg2", AGENT));
    // ── create: no groups and no Page target is refused ──
    const nothing = await call(server, "POST", "/campaigns", Object.assign({}, body, { page_id: "pg2", group_ids: [], targets: ["groups"] }));
    assert.equal(nothing.status, 400); assert.equal(nothing.body.error, "invalid_input");

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

    // ── create on a halted account: 409, nothing created or sent ──
    const nBefore = notes.length, aBefore = (await audits()).length;
    const haltedNew = await call(server, "POST", "/campaigns", Object.assign({}, body, { page_id: "pg2" }));
    assert.equal(haltedNew.status, 409); assert.equal(haltedNew.body.error, "account_halted");
    assert.equal(await K.store.getPostingCampaign(K.store.campaignId(AGENT, "pg2")), null, "no campaign");
    assert.equal(notes.length, nBefore, "nothing sent"); assert.equal((await audits()).length, aBefore, "no audit");

    // ── stopping a completed campaign sends nothing ──
    await K.store.mutatePostingCampaign(row.id, () => ({ status: "completed" }));
    const nDone = notes.length;
    const stopDone = await call(server, "POST", `/campaigns/${row.id}/stop`, {});
    assert.equal(stopDone.status, 200);
    assert.equal(notes.length, nDone, "no admin_stopped for a campaign that was not live");

    // ── audit rows: one per change, no phone, no text ──
    const rows = await audits();
    for (const a of ["create_campaign", "edit_campaign", "stop_campaign", "start_campaign"]) assert.ok(rows.some((r) => r.action === a), a);
    assert.ok(!JSON.stringify(rows).includes(AGENT) && !JSON.stringify(rows).includes("שלום"));

    // ── the duration estimate ──
    const est = await call(server, "POST", "/estimate", { agent: REF, page_id: "pgNew", group_ids: ["111", "222"], days: 30 }, false);
    assert.equal(est.status, 200);
    assert.ok(est.body.posts >= 2); assert.equal(typeof est.body.days, "number"); assert.equal(typeof est.body.fits, "boolean");
    assert.equal((await call(server, "POST", "/estimate", { agent: "acct_nope", group_ids: [] }, false)).status, 400);

    // ── another live campaign's later repeat passes take capacity too ──
    const other = (await K.store.listPostingCampaignsByPhone(AGENT))[0];
    await K.store.mutatePostingCampaign(other.id, () => ({ status: "running", repeat: false, repeat_days: null, expires_at: K.iso(K.NOW.getTime() + 30 * K.DAY) }));
    const estBefore = (await call(server, "POST", "/estimate", { agent: REF, page_id: "pgNew", group_ids: ["111", "222"], days: 30 }, false)).body.posts;
    await K.store.mutatePostingCampaign(other.id, () => ({ repeat: true, repeat_days: 3 }));
    const estRep = await call(server, "POST", "/estimate", { agent: REF, page_id: "pgNew", group_ids: ["111", "222"], days: 30 }, false);
    assert.equal(estRep.body.posts - estBefore, 9 * other.groups.length, "its 9 later passes are counted");
    await K.store.mutatePostingCampaign(other.id, () => ({ status: other.status, repeat: other.repeat, repeat_days: other.repeat_days, expires_at: other.expires_at }));

    // ── the estimate counts every repeat pass and the Page ──
    const est3 = await call(server, "POST", "/estimate", { agent: REF, page_id: "pgNew", group_ids: ["111", "222"], days: 30, repeat_days: 3 }, false);
    assert.equal(est3.body.posts - est.body.posts, 2 * 9, "two groups every 3 days over 30 days: 10 passes, not 1");

    // ── a restart runs as long as the run it repeats; counts are this pass only ──
    await K.db.setConnection(AGENT, { posting_disabled_until_admin: false });
    await K.store.mutatePostingCampaign(row.id, () => ({ status: "stopped", restarted_at: null,
      created_at: K.iso(K.NOW.getTime() - 10 * K.DAY), expires_at: K.iso(K.NOW.getTime() - 3 * K.DAY),
      posts: [{ id: "old1", target: "group", group_id: "111", status: "posted", posted_at: K.iso(K.NOW.getTime() - 5 * K.DAY), created_at: K.iso(K.NOW.getTime() - 5 * K.DAY) }] }));
    const listed = (await call(server, "GET", "/campaigns", undefined, false)).body;
    assert.equal(listed.campaigns.find((c) => c.id === row.id).run_days, 7);
    const again7 = await call(server, "POST", `/campaigns/${row.id}/start`, { consent: CONSENT });
    assert.equal(again7.status, 200);
    assert.equal(new Date(again7.body.campaign.expires_at).getTime(), K.NOW.getTime() + 7 * K.DAY, "7-day run → 7 days, not 30");
    assert.deepEqual(again7.body.campaign.counts, { owed: 2, posted: 0, skipped: 0 }, "the previous run's post is history");

    // ── an edit refused after its row: a second row says so ──
    const curV = (await K.store.getPostingCampaign(row.id)).updated_at;
    const noDest = await call(server, "PATCH", `/campaigns/${row.id}`, { version: curV, remove_group_ids: ["111", "222"] });
    assert.equal(noDest.status, 400); assert.equal(noDest.body.error, "no_destination");
    const edits = (await audits()).filter((r) => r.action === "edit_campaign").slice(-2);
    assert.deepEqual(edits.map((r) => r.detail.outcome), ["requested", "refused"]);
    assert.equal(edits[1].detail.refused, "no_destination");
    assert.equal((await call(server, "PATCH", `/campaigns/${row.id}`, { version: "nope", days: 5 })).status, 409);
    assert.equal((await audits()).filter((r) => r.action === "edit_campaign").pop().detail.refused, "stale_version");

    // ── a restart with nowhere to post is refused ──
    await K.store.mutatePostingCampaign(row.id, () => ({ status: "stopped", groups: [] }));
    const empty = await call(server, "POST", `/campaigns/${row.id}/start`, { consent: CONSENT });
    assert.equal(empty.status, 400); assert.equal(empty.body.error, "no_destination");
    await K.store.mutatePostingCampaign(row.id, () => ({ status: "running", groups: row.groups.map((g) => ({ group_id: g.group_id, name: g.name, url: K.G(g.group_id) })) }));

    // ── no audit row, no change ──
    const realAudit = K.store.addAuditEvent;
    K.store.addAuditEvent = async () => { throw new Error("audit down"); };
    try {
      const nStop = notes.length;
      const r = await call(server, "POST", `/campaigns/${row.id}/stop`, {});
      assert.equal(r.status, 503); assert.equal(r.body.error, "audit_unavailable");
      assert.equal((await K.store.getPostingCampaign(row.id)).status, "running", "the campaign is untouched");
      assert.equal(notes.length, nStop, "nothing sent");
    } finally { K.store.addAuditEvent = realAudit; }

    // ── the admin's consent is on the posting permission too ──
    await K.db.setConnection(AGENT, { posting_permission: null });
    await K.store.mutatePostingCampaign(row.id, () => ({ status: "stopped" }));
    assert.equal((await call(server, "POST", `/campaigns/${row.id}/start`, { consent: CONSENT })).status, 200);
    const perm = (await K.db.getConnection(AGENT)).posting_permission;
    assert.deepEqual([perm.consent_by.by, perm.consent_by.method, perm.consent_by.note], ["admin", "phone", CONSENT.note]);

    // ── manual posting: no Page, no repeat ──
    const mApp = express(); mApp.use(express.json());
    mApp.use("/api/admin/campaigns", createRouter({ requireAdmin, requireStepUp, deps: rdeps, env: Object.assign({}, deps.env, { POSTING_MANUAL: "1" }), catalog: CATALOG }));
    const mServer = mApp.listen(0);
    try {
      assert.equal((await call(mServer, "GET", "/campaigns", undefined, false)).body.manual, true);
      const mBody = Object.assign({}, body, { page_id: "pg3" });
      assert.equal((await call(mServer, "POST", "/campaigns", Object.assign({}, mBody, { targets: ["groups", "page"] }))).body.error, "manual_unsupported");
      assert.equal((await call(mServer, "POST", "/campaigns", Object.assign({}, mBody, { repeat_days: 7 }))).body.error, "manual_unsupported");
      const cur = await K.store.getPostingCampaign(row.id);
      assert.equal((await call(mServer, "PATCH", `/campaigns/${row.id}`, { version: cur.updated_at, repeat_days: 7 })).body.error, "manual_unsupported");
      // an older campaign with a Page or repeat is flagged, and a resume drops them
      await K.store.mutatePostingCampaign(row.id, () => ({ status: "paused", pause_reason: "agent", repeat: true, repeat_days: 7 }));
      const flagged = (await call(mServer, "GET", "/campaigns", undefined, false)).body.campaigns.find((c2) => c2.id === row.id);
      assert.deepEqual(flagged.manual_unsupported, ["repeat"]);
      const resumed = await call(mServer, "POST", `/campaigns/${row.id}/start`, {});
      assert.equal(resumed.status, 200); assert.equal(resumed.body.campaign.repeat, false); assert.deepEqual(resumed.body.campaign.manual_unsupported, []);
      // a page-only paused campaign cannot run by hand: refused, untouched
      await K.store.mutatePostingCampaign(row.id, () => ({ status: "paused", pause_reason: "agent", groups: [], targets: ["page"] }));
      const pageOnly = await call(mServer, "POST", `/campaigns/${row.id}/start`, {});
      assert.equal(pageOnly.status, 400); assert.equal(pageOnly.body.error, "no_destination");
      assert.deepEqual((await K.store.getPostingCampaign(row.id)).targets, ["page"], "untouched");
      // a resume refused (halted) strips nothing and adds a refusal row
      await K.store.mutatePostingCampaign(row.id, () => ({ groups: row.groups.map((g) => ({ group_id: g.group_id, name: g.name, url: K.G(g.group_id) })), repeat: true, repeat_days: 7 }));
      const realGet = rdeps.db.getConnection;
      let reads = 0;
      rdeps.db.getConnection = async (p2) => { const c3 = await realGet.call(rdeps.db, p2); return ++reads > 1 ? Object.assign({}, c3, { posting_disabled_until_admin: true }) : c3; }; // the halt lands after the route's pre-check
      try {
        const halted = await call(mServer, "POST", `/campaigns/${row.id}/start`, {});
        assert.equal(halted.status, 409);
        assert.equal((await K.store.getPostingCampaign(row.id)).repeat, true, "nothing stripped");
        const last = (await audits()).filter((r) => r.action === "start_campaign").slice(-2);
        assert.deepEqual(last.map((r) => r.detail.outcome), ["requested", "refused"]);
        assert.equal(last[1].detail.refused, "account_halted");
      } finally { rdeps.db.getConnection = realGet; }
      // a page-only campaign with groups resumes as groups-only, never with no target at all
      await K.store.mutatePostingCampaign(row.id, () => ({ status: "paused", pause_reason: "agent", repeat: false, repeat_days: null, targets: ["page"] }));
      assert.deepEqual((await call(mServer, "POST", `/campaigns/${row.id}/start`, {})).body.campaign.targets, ["groups"]);
      await K.store.mutatePostingCampaign(row.id, () => ({ status: "running", repeat: false, repeat_days: null, targets: row.targets }));
    } finally { mServer.close(); }

    // ── staging never changes campaigns ──
    const sApp = express(); sApp.use(express.json());
    sApp.use("/api/admin/campaigns", createRouter({ requireAdmin, requireStepUp, deps: rdeps, env: { FORLY_ENV: "staging" }, catalog: CATALOG }));
    const sServer = sApp.listen(0);
    try { assert.equal((await call(sServer, "POST", "/campaigns", body)).status, 503); } finally { sServer.close(); }
    console.log("routes/admin-campaigns.test.js ok");
  } finally { server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
