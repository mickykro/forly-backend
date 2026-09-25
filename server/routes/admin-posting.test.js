/* routes/admin-posting.js — the operator's switches, overview, per-class
   re-enable, profile revoke, audit and retention. Real admin and step-up
   guards over real signed tokens; the in-memory db and posting store; a fake
   profile lifecycle (no Driver). No network. */
process.env.PROFILE_KEY = "admin-posting-test-profile-key";
process.env.FORLY_ENV = "local";
delete process.env.META_TOKEN_KEY;
const assert = require("assert");
const express = require("express");
const http = require("http");
const auth = require("../auth");
const { makeAdminGuard, makeStepUpGuard } = require("../admin-auth");
const db = require("../db");
const store = require("../posting-store");
const halts = require("../posting-halts");
const createRouter = require("./admin-posting");

const SECRET = "admin-posting-secret";
const ADMIN = "972500000001";
const OWNER = "972500000009";
const NOT_ADMIN = "972500000077";
const P = { captcha: "972521110001", restricted: "972521110002", review: "972521110003", compromised: "972521110004", penalty: "972521110005", fine: "972521110006", legacy: "972521110007", downgraded: "972521110010", scCaptcha: "972521110011" };
const ALL_PHONES = [ADMIN, OWNER, NOT_ADMIN, ...Object.values(P)];
const DAY = 86400000;

const { requireAdmin } = makeAdminGuard({ verifySession: auth.verifySession, readToken: auth.readToken, authSecret: SECRET, adminPhones: [ADMIN, OWNER] });
const { requireStepUp } = makeStepUpGuard({ verifySession: auth.verifySession, authSecret: SECRET });
const revokes = [];
const quarantines = [];
const lifecycle = {
  revoke: async (a) => { revokes.push(a); await db.setConnection(a.phone, { facebook_profile_state: "revoked" }); return { advice: null }; },
  quarantine: async (phone, platform, cls) => { quarantines.push({ phone, cls }); },
};
const env = { FORLY_ENV: "prod", POSTING_ENABLED: "1" };
const app = express();
app.use(express.json());
app.use("/api/admin/posting", createRouter({ requireAdmin, requireStepUp, db, store, lifecycle, env, deps: { driver: {} } }));

const headersFor = (phone, { stepup = false } = {}) => {
  const h = { authorization: `Bearer ${auth.signSession(SECRET, phone)}`, "content-type": "application/json" };
  if (stepup) h.cookie = `forly_stepup=${encodeURIComponent(auth.signSession(SECRET, phone, { scope: "stepup", ttlS: 600 }))}`;
  return h;
};
function call(server, method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, path, method, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let b = d; try { b = JSON.parse(d); } catch { /* text */ } resolve({ status: res.statusCode, headers: res.headers, raw: d, body: b }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const noFullPhone = (raw, what) => {
  for (const p of ALL_PHONES) assert.ok(!raw.includes(p) && !raw.includes(p.slice(3)), `${what} leaks a full phone`);
  const rest = raw.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "").replace(/acct_[0-9a-f]{24}/g, "").replace(/"id":"[0-9a-f]{24}"/g, "");
  assert.ok(!/\d{7,}/.test(rest), `${what}: a long digit run`);
};

(async () => {
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const as = (phone, stepup = true) => headersFor(phone, { stepup });
  const post = (path, body, h = as(ADMIN)) => call(server, "POST", `/api/admin/posting${path}`, h, body);
  const overview = async () => { const r = await call(server, "GET", "/api/admin/posting/overview", as(ADMIN, false)); assert.equal(r.status, 200, r.raw); return r; };
  try {
    const now = Date.now();
    const ago = (m) => new Date(now - m).toISOString();
    const halt = (code, m) => ({ at: ago(m), code });
    await db.setConnection(P.captcha, { posting_disabled_until_admin: true, posting_disabled_class: "captcha", posting_disabled_at: ago(3600e3), posting_last_halt_at: ago(3600e3), posting_halts: [halt("captcha", 3600e3)], facebook_browser_first_connected_at: ago(90 * DAY) });
    await db.setConnection(P.restricted, { posting_disabled_until_admin: true, posting_disabled_class: "restricted", posting_disabled_at: ago(2 * DAY), posting_last_halt_at: ago(2 * DAY), posting_halts: [halt("restricted", 2 * DAY)] });
    await db.setConnection(P.review, { posting_disabled_until_admin: true, posting_owner_review_required: true, posting_disabled_class: "checkpoint", posting_disabled_at: ago(7200e3), posting_last_halt_at: ago(7200e3), posting_halts: [halt("captcha", 10 * DAY), halt("checkpoint", 7200e3)] });
    await db.setConnection(P.compromised, { posting_disabled_until_admin: true, posting_disabled_class: "suspected_compromise", posting_disabled_at: ago(600e3), posting_disabled_profile_gen: 0, facebook_profile_gen: 0, posting_last_halt_at: ago(600e3), posting_halts: [halt("suspected_compromise", 600e3)] });
    // Halted before the profile generation was recorded: a reconnect can never be proven.
    await db.setConnection(P.legacy, { posting_disabled_until_admin: true, posting_disabled_class: "suspected_compromise", posting_disabled_at: ago(3 * DAY), posting_last_halt_at: ago(3 * DAY), posting_halts: [halt("suspected_compromise", 3 * DAY)], facebook_profile_gen: 4, facebook_browser_connected_at: ago(DAY) });
    await db.setConnection(P.penalty, { posting_penalty_until: new Date(now + 13 * DAY).toISOString(), posting_penalty_class: "rate_limited", posting_last_halt_at: ago(1800e3), posting_halts: [halt("rate_limited", 1800e3)] });
    await db.setConnection(P.fine, { facebook_browser_connected_at: ago(DAY) });
    await db.setSetting("posting_health", { last_sweep_at: ago(60e3), reap_failures: [{ key_tail: "abc123", error_code: "tx_failed", first_seen_at: ago(120e3) }], cancel_failures_count: 2 });

    // ── the guards: a session, an admin, and a fresh step-up for every POST ──
    assert.equal((await call(server, "GET", "/api/admin/posting/overview")).status, 401);
    assert.equal((await call(server, "GET", "/api/admin/posting/overview", as(NOT_ADMIN, false))).status, 403);
    const noStep = await post("/switch", { enabled: false, reason: "dom change", version: 0 }, as(ADMIN, false));
    assert.equal(noStep.status, 401); assert.equal(noStep.body.error, "stepup_required");
    const mixed = as(ADMIN, false); mixed.cookie = as(OWNER).cookie;
    assert.equal((await post("/switch", { enabled: false, reason: "x", version: 0 }, mixed)).status, 401, "another admin's step-up is not mine");
    for (const path of ["/switch/platform", "/switch/visible", `/accounts/${P.captcha}/reenable`, `/accounts/${P.compromised}/revoke-profile`]) {
      assert.equal((await post(path, { reason: "x" }, as(ADMIN, false))).status, 401, path);
    }

    // ── a missing switch doc (I5): off at version 0; the first "on" creates it ──
    {
      assert.equal(await db.getSetting("posting"), null);
      const ov0 = await overview();
      assert.equal(ov0.body.enabled, false, "no doc is off, never on"); assert.equal(ov0.body.version, 0); assert.equal(ov0.body.env_forced_off, false);
      const first = await post("/switch", { enabled: true, reason: "launch", version: 0 });
      assert.equal(first.status, 200, first.raw); assert.equal(first.body.enabled, true); assert.equal(first.body.version, 1);
      const made = await db.getSetting("posting");
      assert.equal(made.enabled, true); assert.ok(made.enabled_at, "the first on stamps enabled_at");
      db.mem.settings.delete("posting");
      // enabled must be strictly true
      db.mem.settings.set("posting", { enabled: "true", version: 4 });
      assert.equal((await overview()).body.enabled, false);
      db.mem.settings.delete("posting");
    }
    // ── the env: POSTING_ENABLED other than "1" is forced off; outside prod every POST is 503 (C1), GETs stay ──
    for (const [e, allowed] of [[{ FORLY_ENV: "staging", POSTING_SWEEPER: "1", POSTING_ENABLED: "1" }, false], [{ FORLY_ENV: "local" }, false], [{ FORLY_ENV: "local", POSTING_SWEEPER: "1" }, true]]) {
      const appE = express();
      appE.use(express.json());
      appE.use("/p", createRouter({ requireAdmin, requireStepUp, db, store, lifecycle, env: e, deps: { driver: {} } }));
      const sE = await new Promise((r) => { const sv = appE.listen(0, () => r(sv)); });
      try {
        const g = await call(sE, "GET", "/p/overview", as(ADMIN, false));
        assert.equal(g.status, 200); assert.equal(g.body.env_forced_off, e.POSTING_ENABLED !== "1");
        // Allowed: reaches the route (a stale version → 409, nothing written). Refused: 503 before anything.
        const paths = allowed ? ["/switch"] : ["/switch", "/switch/platform", "/switch/visible", `/accounts/${P.captcha}/reenable`, `/accounts/${P.compromised}/revoke-profile`];
        for (const path of paths) {
          const r = await call(sE, "POST", `/p${path}`, as(ADMIN), { enabled: true, reason: "x", version: 99 });
          if (allowed) assert.equal(r.status, 409, path);
          else assert.deepEqual([r.status, r.body], [503, { error: "posting_unavailable_in_env" }], `${JSON.stringify(e)} ${path}`);
        }
      } finally { sE.close(); }
    }
    assert.equal(await db.getSetting("posting"), null, "nothing was written by a refused POST");

    // ── global switch: validated, compare-and-set, audited ──
    assert.equal((await post("/switch", { enabled: "no", reason: "x", version: 0 })).status, 400);
    assert.equal((await post("/switch", { enabled: false, reason: "x" })).body.field, "version");
    assert.equal((await post("/switch", { enabled: false, reason: "   ", version: 0 })).body.error, "reason_required");
    const off = await post("/switch", { enabled: false, reason: "dom change, call 0521234567", version: 0 });
    assert.equal(off.status, 200, off.raw);
    let s = await db.getSetting("posting");
    assert.equal(s.enabled, false); assert.equal(s.version, 1);
    assert.equal(s.disabled_reason, "dom change, call …4567", "no phone in a stored reason");
    assert.equal(s.changed_by, "0001"); assert.ok(s.changed_at); assert.ok(s.disabled_at);
    assert.equal(s.enabled_at, undefined, "turning off never stamps enabled_at");
    const stale = await post("/switch", { enabled: true, reason: "retry", version: 0 });
    assert.equal(stale.status, 409); assert.equal(stale.body.error, "version_conflict"); assert.equal(stale.body.version, 1);
    assert.equal((await db.getSetting("posting")).enabled, false, "a stale write changes nothing");
    const on = await post("/switch", { enabled: true, reason: "fixed selectors", version: 1 });
    assert.equal(on.status, 200); assert.equal(on.body.enabled, true); assert.equal(on.body.version, 2);
    s = await db.getSetting("posting");
    assert.ok(s.enabled_at && s.enabled_at === s.changed_at, "turning on stamps enabled_at (the fleet breaker's start)");
    assert.equal(s.disabled_reason, null);
    // A racing writer (the fleet breaker) between the read and the CAS: still a 409.
    const realSet = db.setSetting;
    db.setSetting = async (k, v, o) => { db.setSetting = realSet; await realSet("posting", { enabled: false, disabled_reason: "fleet_breaker" }); return realSet(k, v, o); };
    const raced = await post("/switch", { enabled: true, reason: "again", version: 2 });
    assert.equal(raced.status, 409); assert.equal(raced.body.version, 3);
    assert.equal((await db.getSetting("posting")).disabled_reason, "fleet_breaker");
    assert.equal((await post("/switch", { enabled: true, reason: "after breaker", version: 3 })).status, 200);

    // ── platform and visible-interaction switches: same CAS, own last_change ──
    assert.equal((await post("/switch/platform", { platform: "tiktok", enabled: false, reason: "x", version: 4 })).status, 400);
    const yad2 = await post("/switch/platform", { platform: "yad2", enabled: false, reason: "yad2 layout", version: 4 });
    assert.equal(yad2.status, 200, yad2.raw); assert.deepEqual(yad2.body.platforms, { facebook: true, yad2: false, madlan: true });
    assert.equal((await post("/switch/platform", { platform: "madlan", enabled: false, reason: "x", version: 4 })).status, 409);
    assert.equal((await post("/switch/platform", { platform: "madlan", enabled: false, reason: "madlan too", version: 5 })).status, 200);
    s = await db.getSetting("posting");
    assert.deepEqual(s.platforms, { yad2: false, madlan: false }, "one platform's flip keeps the other's");
    assert.equal(s.reason, "after breaker", "a platform flip leaves the global switch's reason alone");
    const vis = await post("/switch/visible", { enabled: false, reason: "likes paused", version: 6 });
    assert.equal(vis.status, 200); assert.equal((await db.getSetting("posting")).visible_interactions_enabled, false);
    assert.deepEqual(vis.body.last_change && [vis.body.last_change.what, vis.body.last_change.by_tail], ["visible", "0001"]);

    // ── overview: counts, halts by class with only the allowed actions, health; tails only ──
    const cid = (await store.createPostingCampaignIfAbsent({ phone: P.fine, page_id: "pg1", status: "running", posts: [], created_at: ago(0), updated_at: ago(0) })).campaign.id;
    await store.createPostingCampaignIfAbsent({ phone: P.fine, page_id: "pg2", status: "paused", posts: [] });
    let ov = await overview();
    noFullPhone(ov.raw, "overview");
    assert.equal(ov.headers["cache-control"], "no-store");
    assert.deepEqual(ov.body.campaigns, { running: 1, paused: 1, stopped: 0, completed: 0 });
    assert.equal(ov.body.enabled, true); assert.equal(ov.body.version, 7); assert.equal(ov.body.visible_interactions_enabled, false);
    assert.equal(ov.body.changed_by_tail, "0001"); assert.equal(ov.body.reason, "after breaker");
    assert.equal(ov.body.accounts_disabled, 5); assert.deepEqual(ov.body.warnings, []); assert.equal(ov.body.owner_review, 1); assert.equal(ov.body.owner_configured, false);
    const byClass = ov.body.halts_by_class;
    const row = (cls) => { assert.equal(byClass[cls].length, 1, cls); return byClass[cls][0]; };
    assert.deepEqual(row("captcha").allowed_actions, ["reenable"]);
    assert.deepEqual(row("restricted").allowed_actions, ["owner_reenable"]);
    assert.deepEqual(row("checkpoint").allowed_actions, ["owner_reenable"], "an owner review is owner-only, whatever the class");
    assert.equal(row("checkpoint").owner_review, true);
    const compRow = byClass.suspected_compromise.find((a) => a.phone_tail === "0004");
    assert.deepEqual(compRow.allowed_actions, ["revoke_profile", "reenable_after_reconnect"]);
    assert.equal(compRow.reconnected_after_halt, false);
    assert.deepEqual(row("rate_limited").allowed_actions, [], "a penalty lifts itself");
    assert.equal(row("captcha").phone_tail, "0001"); assert.ok(/^acct_[0-9a-f]{24}$/.test(row("captcha").ref));
    assert.ok(!byClass.unknown, "a connected account with no halt is not listed");
    assert.ok(ov.body.halts_24h.some((h) => h.code === "captcha" && h.phone_tail === "0001"));
    assert.ok(!ov.body.halts_24h.some((h) => h.code === "restricted"), "the 24 h list is 24 h");
    assert.equal(ov.body.posting_health.reap_failures_count, 1); assert.equal(ov.body.posting_health.cancel_failures_count, 2);

    // ── captcha: the agent's confirmation first; clears, stamps, restarts warm-up ──
    const capRef = row("captcha").ref;
    assert.equal((await post(`/accounts/${capRef}/reenable`, { agent_confirmed: true })).body.error, "reason_required");
    const unconfirmed = await post(`/accounts/${capRef}/reenable`, { reason: "agent solved it" });
    assert.equal(unconfirmed.status, 400); assert.equal(unconfirmed.body.error, "agent_confirmation_required");
    assert.equal((await db.getConnection(P.captcha)).posting_disabled_until_admin, true);
    assert.equal((await post("/accounts/acct_000000000000000000000000/reenable", { reason: "x", agent_confirmed: true })).status, 404);
    const cap = await post(`/accounts/${capRef}/reenable`, { reason: "agent solved it", agent_confirmed: true });
    assert.equal(cap.status, 200, cap.raw); noFullPhone(cap.raw, "re-enable");
    let c = await db.getConnection(P.captcha);
    assert.equal(c.posting_disabled_until_admin, false);
    assert.ok(c.posting_reenabled_at && Date.now() - Date.parse(c.posting_reenabled_at) < 60e3);
    assert.equal(c.facebook_browser_first_connected_at, c.posting_reenabled_at, "warm-up restarts");
    assert.equal(c.posting_reenabled_by, "0001"); assert.equal(c.posting_reenabled_as, "operator"); assert.equal(c.posting_agent_confirmed_at, c.posting_reenabled_at);
    assert.equal((await post(`/accounts/${P.captcha}/reenable`, { reason: "again", agent_confirmed: true })).body.error, "not_disabled");
    // posting_reenabled_at lifts the 24 h duplicate: a new captcha today is a new halt.
    const again = await halts.haltAccount(P.captcha, "captcha", { db, store, lifecycle });
    assert.ok(!again.duplicate && again.disabled, "a halt after a re-enable is not a duplicate");
    assert.equal(again.owner_review, true, "and it is the second in 30 days: owner review");
    assert.deepEqual(quarantines.map((q) => q.cls), ["captcha"]);

    // ── restricted and owner review: owner only; POSTING_OWNER_PHONES unset refuses everyone ──
    const resRef = row("restricted").ref;
    let r = await post(`/accounts/${resRef}/reenable`, { reason: "owner call" }, as(OWNER));
    assert.equal(r.status, 403); assert.equal(r.body.error, "owner_not_configured");
    env.POSTING_OWNER_PHONES = " 0500000009 , ";
    r = await post(`/accounts/${resRef}/reenable`, { reason: "owner call" });
    assert.equal(r.status, 403); assert.equal(r.body.error, "owner_required", "an admin is not an owner");
    assert.equal((await db.getConnection(P.restricted)).posting_disabled_until_admin, true);
    r = await post(`/accounts/${resRef}/reenable`, { reason: "appeal accepted" }, as(OWNER));
    assert.equal(r.status, 200, r.raw); assert.equal(r.body.as, "owner");
    c = await db.getConnection(P.restricted);
    assert.equal(c.posting_disabled_until_admin, false); assert.equal(c.posting_owner_review_required, false); assert.ok(c.posting_reenabled_at);
    // The review account: a checkpoint class, but owner-only; an agent confirmation does not bypass it.
    r = await post(`/accounts/${P.review}/reenable`, { reason: "checked", agent_confirmed: true });
    assert.equal(r.body.error, "owner_required");
    r = await post(`/accounts/${P.review}/reenable`, { reason: "owner reviewed" }, as(OWNER));
    assert.equal(r.status, 400); assert.equal(r.body.error, "agent_confirmation_required", "the owner path still needs the agent's confirmation for a captcha/checkpoint");
    r = await post(`/accounts/${P.review}/reenable`, { reason: "owner reviewed", agent_confirmed: true }, as(OWNER));
    assert.equal(r.status, 200);
    c = await db.getConnection(P.review);
    assert.equal(c.posting_disabled_until_admin, false); assert.equal(c.posting_owner_review_required, false, "owner re-enable clears both flags");
    assert.equal(c.posting_reenabled_as, "owner");

    // ── suspected compromise: the profile is revoked; the owner lifts it only after a reconnect ──
    r = await post(`/accounts/${P.compromised}/reenable`, { reason: "x" }, as(OWNER));
    assert.equal(r.status, 409); assert.equal(r.body.error, "reconnect_required", "before the reconnect, not even the owner");
    assert.equal((await post(`/accounts/${P.compromised}/revoke-profile`, {})).body.error, "reason_required");
    r = await post(`/accounts/${P.compromised}/revoke-profile`, { reason: "identity mismatch seen" });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(revokes.pop(), { phone: P.compromised, platform: "facebook", reason: "suspected_compromise" });
    // A connect on the SAME profile generation is not a new profile.
    await db.setConnection(P.compromised, { facebook_browser_connected_at: new Date().toISOString() });
    assert.equal((await post(`/accounts/${P.compromised}/reenable`, { reason: "x" }, as(OWNER))).body.error, "reconnect_required");
    // The agent reconnects: routes/connections-browser.js bumps the generation, finish stamps connected_at.
    await db.setConnection(P.compromised, { facebook_profile_gen: 1, facebook_profile_state: "active", facebook_browser_connected_at: new Date(Date.now() + 1000).toISOString() });
    ov = await overview();
    assert.equal(ov.body.halts_by_class.suspected_compromise.find((a) => a.phone_tail === "0004").reconnected_after_halt, true);
    r = await post(`/accounts/${P.compromised}/reenable`, { reason: "new profile, identity checked" });
    assert.equal(r.status, 403); assert.equal(r.body.error, "owner_required", "after the reconnect, still owner only");
    r = await post(`/accounts/${P.compromised}/reenable`, { reason: "new profile, identity checked" }, as(OWNER));
    assert.equal(r.status, 200, r.raw); assert.equal(r.body.as, "owner"); assert.equal(r.body.class, "suspected_compromise");
    c = await db.getConnection(P.compromised);
    assert.equal(c.posting_disabled_until_admin, false); assert.equal(c.posting_owner_review_required, false);
    assert.ok(c.posting_reenabled_at); assert.equal(c.facebook_browser_first_connected_at, c.posting_reenabled_at, "warm-up restarts");
    assert.equal(c.posting_reenabled_as, "owner");
    r = await post(`/accounts/${P.legacy}/reenable`, { reason: "x" }, as(OWNER));
    assert.equal(r.body.error, "reconnect_required", "no recorded generation: refused");

    // ── fix round 1: a weaker halt never downgrades the lift; every live halt counts ──
    await db.setConnection(P.scCaptcha, { facebook_profile_gen: 1, facebook_profile_state: "active", facebook_browser_connected_at: ago(DAY) });
    await halts.haltAccount(P.scCaptcha, "suspected_compromise", { db, store, lifecycle });
    await halts.haltAccount(P.scCaptcha, "captcha", { db, store, lifecycle });
    c = await db.getConnection(P.scCaptcha);
    assert.equal(c.posting_disabled_class, "suspected_compromise", "a captcha after a suspected compromise keeps the stronger class");
    assert.deepEqual(c.posting_halts.map((h) => h.code), ["suspected_compromise", "captcha"]);
    r = await post(`/accounts/${P.scCaptcha}/reenable`, { reason: "x", agent_confirmed: true });
    assert.equal(r.status, 403); assert.equal(r.body.error, "owner_required");
    r = await post(`/accounts/${P.scCaptcha}/reenable`, { reason: "x", agent_confirmed: true }, as(OWNER));
    assert.equal(r.status, 409); assert.equal(r.body.error, "reconnect_required");
    // A class field already downgraded (written before this fix): the halts still decide.
    await db.setConnection(P.downgraded, { posting_disabled_until_admin: true, posting_disabled_class: "captcha", posting_disabled_at: ago(3600e3), posting_last_halt_at: ago(3600e3), posting_halts: [halt("restricted", 7200e3), halt("captcha", 3600e3)] });
    r = await post(`/accounts/${P.downgraded}/reenable`, { reason: "x", agent_confirmed: true });
    assert.equal(r.status, 403); assert.equal(r.body.error, "owner_required", "restricted then captcha: owner required");
    r = await post(`/accounts/${P.downgraded}/reenable`, { reason: "appeal accepted" }, as(OWNER));
    assert.equal(r.body.error, "agent_confirmation_required");
    r = await post(`/accounts/${P.downgraded}/reenable`, { reason: "appeal accepted", agent_confirmed: true }, as(OWNER));
    assert.equal(r.status, 200, r.raw);
    c = await db.getConnection(P.downgraded);
    assert.equal(c.posting_disabled_until_admin, false); assert.equal(c.posting_agent_confirmed_at, c.posting_reenabled_at);
    const rule = createRouter._test.reenableRule;
    const conn = (o) => Object.assign({ posting_disabled_until_admin: true, posting_disabled_class: "captcha" }, o);
    assert.equal(rule(conn({ posting_halts: [halt("suspected_compromise", 9e3), halt("captcha", 1e3)] })), "compromise");
    assert.equal(rule(conn({ posting_reenabled_at: ago(5e3), posting_halts: [halt("suspected_compromise", 9e3), halt("captcha", 1e3)] })), "agent_confirmed", "a halt lifted by an earlier re-enable no longer counts");
    // Operator judgement on an account not halted: halted as suspected_compromise, which revokes.
    r = await post(`/accounts/${P.fine}/revoke-profile`, { reason: "agent reports takeover" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(revokes.pop().phone, P.fine);
    c = await db.getConnection(P.fine);
    assert.equal(c.posting_disabled_until_admin, true); assert.equal(c.posting_disabled_class, "suspected_compromise");
    assert.equal(c.posting_disabled_profile_gen, 0, "the halt records the profile generation it caught");
    assert.equal((await store.getPostingCampaign(cid)).status, "paused", "its running campaign stops (R2)");

    // ── every mutation wrote an audit event, tails only, kept a year ──
    const events = await store.listAuditEvents({ limit: 100 });
    const actions = events.map((e) => e.action).sort();
    assert.deepEqual(actions, ["reenable", "reenable", "reenable", "reenable", "reenable", "revoke_profile", "revoke_profile", "switch_global", "switch_global", "switch_global", "switch_global", "switch_platform", "switch_platform", "switch_visible"]);
    for (const e of events) {
      assert.ok(/^\d{4}$/.test(e.operator_tail), JSON.stringify(e));
      assert.ok(e.target_phone_tail === null || /^\d{4}$/.test(e.target_phone_tail));
      assert.ok(e.reason);
      assert.ok(Math.abs(Date.parse(e.expire_at) - Date.parse(e.at) - 365 * DAY) < 1000);
    }
    assert.equal(events.find((e) => e.action === "reenable" && e.detail.as === "owner" && e.target_phone_tail === "0002").operator_tail, "0009");
    noFullPhone(JSON.stringify(events), "audit");
    await assert.rejects(store.addAuditEvent({ action: "x", target_phone_tail: P.fine }), (e) => e.code === "invalid_input", "a full phone is refused");
    ov = await overview();
    noFullPhone(ov.raw, "overview after");
    assert.equal(ov.body.is_owner, false, "an admin who is not an owner");
    const scRow = ov.body.halts_by_class.suspected_compromise.find((a) => a.phone_tail === "0011");
    assert.equal(scRow.needs_agent_confirmation, true); assert.equal(scRow.reconnected_after_halt, false);
    assert.equal((await call(server, "GET", "/api/admin/posting/overview", as(OWNER, false))).body.is_owner, true);
    assert.equal(ov.body.recent_audit.length, 14);

    // ── the overview degrades: a failing section is named in warnings, the rest loads, 200 ──
    {
      const missing = Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index."), { code: 9 });
      const store2 = Object.assign({}, store, { listDisabledPhones: async () => { throw missing; }, listAuditEvents: async () => { throw new Error("boom"); } });
      const app2 = express();
      app2.use(express.json());
      app2.use("/p", createRouter({ requireAdmin, requireStepUp, db, store: store2, lifecycle, env }));
      const s2 = await new Promise((res2) => { const sv = app2.listen(0, () => res2(sv)); });
      try {
        const d = await call(s2, "GET", "/p/overview", as(ADMIN, false));
        assert.equal(d.status, 200, d.raw);
        assert.deepEqual(d.body.warnings, ["index_missing:accounts_disabled", "query_failed:audit"]);
        assert.equal(d.body.accounts_disabled, null, "unknown, not zero");
        assert.equal(d.body.enabled, true); assert.ok(d.body.campaigns); assert.ok(d.body.posting_health);
        assert.ok(d.body.halts_by_class.captcha, "the 24 h halts still load");
        assert.deepEqual(d.body.recent_audit, []);
        noFullPhone(d.raw, "degraded overview");
        // A ref still resolves through the halt list alone.
        const ref = d.body.halts_by_class.captcha[0].ref;
        const found = await call(s2, "POST", `/p/accounts/${ref}/reenable`, as(ADMIN), { reason: "x", agent_confirmed: true });
        assert.equal(found.body.error, "owner_required", "found (it is under owner review now), not a 404");
      } finally { s2.close(); }
      const db3 = Object.assign({}, db, { getSetting: async (k) => { if (k === "posting") throw missing; return db.getSetting(k); } });
      const app3 = express();
      app3.use("/p", createRouter({ requireAdmin, requireStepUp, db: db3, store, lifecycle, env }));
      const s3 = await new Promise((res3) => { const sv = app3.listen(0, () => res3(sv)); });
      try {
        const d = await call(s3, "GET", "/p/overview", as(ADMIN, false));
        assert.equal(d.status, 200); assert.deepEqual(d.body.warnings, ["index_missing:switch"]);
        assert.equal(d.body.enabled, null, "an unread switch is unknown, never shown as on"); assert.equal(d.body.version, null);
        assert.equal(d.body.accounts_disabled, 4);
      } finally { s3.close(); }
      // One account read fails: the counts are unknown, not partial.
      const db4 = Object.assign({}, db, { getConnection: async (ph) => { if (ph === P.penalty) throw new Error("unavailable"); return db.getConnection(ph); } });
      const app4 = express();
      app4.use("/p", createRouter({ requireAdmin, requireStepUp, db: db4, store, lifecycle, env }));
      const s4 = await new Promise((res4) => { const sv = app4.listen(0, () => res4(sv)); });
      try {
        const d = await call(s4, "GET", "/p/overview", as(ADMIN, false));
        assert.equal(d.status, 200); assert.deepEqual(d.body.warnings, ["query_failed:accounts"]);
        assert.equal(d.body.accounts_disabled, null); assert.equal(d.body.owner_review, null);
        assert.ok(d.body.halts_by_class.suspected_compromise, "the rows that did load are shown");
      } finally { s4.close(); }
    }

    // ── retention: a campaign that ends gets expire_at = updated_at + 30 d; a restart clears it ──
    const campaigns = require("../posting-campaign");
    const A = require("../posting-account");
    const stopped = await campaigns.stop(cid, { db, store });
    assert.equal(stopped.status, "stopped");
    const kept = await store.getPostingCampaign(cid);
    assert.ok(kept.expire_at instanceof Date, "a Date, stored as a Timestamp");
    assert.equal(kept.expire_at.getTime() - Date.parse(kept.updated_at), 30 * DAY);
    const x = A.ctxOf({ db, store });
    await A.mutate(x, cid, () => ({ tick_errors: 0 }));
    assert.equal((await store.getPostingCampaign(cid)).expire_at.getTime(), kept.expire_at.getTime(), "a later write to an ended campaign keeps its expiry");
    await A.mutate(x, cid, () => ({ status: "running" }));
    assert.equal((await store.getPostingCampaign(cid)).expire_at, null, "a restart clears it");
    const done = await A.mutate(x, cid, () => ({ status: "completed" }));
    assert.equal(done.expire_at.getTime() - Date.parse(done.updated_at), 30 * DAY);
    const job = await require("../extract-jobs").create({ phone: P.fine, url: "https://www.yad2.co.il/item/a" }, { db: { saveExtractJob: async () => {} } });
    assert.equal(job.expire_at.getTime() - Date.parse(job.created_at), 7 * DAY, "extract jobs: created_at + 7 d");

    console.log("routes/admin-posting.test.js ok");
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
