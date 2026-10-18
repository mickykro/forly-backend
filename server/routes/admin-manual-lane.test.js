/* routes/admin-manual-lane.js through routes/admin-manual.js: ▶, "הבא"
   (posted / not posted / unsure / failed), the pushed lane events and the
   flag list. The browser work itself is a fake prep (posting-manual-prep has its own test). */
const assert = require("assert");
const express = require("express");
const http = require("http");
const auth = require("../auth");
const { makeAdminGuard } = require("../admin-auth");
const K = require("../posting-testkit");
const C = require("../posting-campaign");
const M = require("../posting-manual");
const createRouter = require("./admin-manual");

const SECRET = "admin-manual-lane-secret", ADMIN = "972500000009", AGENT = "972500000001";
const { requireAdmin } = makeAdminGuard({ verifySession: auth.verifySession, readToken: auth.readToken, authSecret: SECRET, adminPhones: [ADMIN] });
const H = { authorization: `Bearer ${auth.signSession(SECRET, ADMIN)}`, "content-type": "application/json" };
function call(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, path, method, headers: H }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let b = d; try { b = JSON.parse(d); } catch { /* text */ } resolve({ status: res.statusCode, body: b }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const tick = () => new Promise((r) => setTimeout(r, 10));

(async () => {
  const { deps } = await K.setup(AGENT);
  deps.env = { POSTING_MANUAL: "1", FORLY_ENV: "prod" };
  const c = await C.create(K.base(), deps);
  const REF = M.refOf(AGENT);

  const fakePage = { url: () => "https://www.facebook.com/", on: () => {} };
  const hubs = new Map(), events = [];
  const viewer = {
    _hubs: hubs,
    attach: async (k) => { hubs.set(k, { page: fakePage, context: { pages: () => [], on: () => {} } }); return hubs.get(k); },
    emit: (h, evt) => events.push(evt),
    close: async (k) => { hubs.delete(k); },
  };
  const driver = { createSession: async () => ({ sessionId: "s1" }), stopSession: async () => {} };
  const prepared = [];
  const prep = { results: [], seen: "posted",
    prepare: async (page, item) => { prepared.push(item.group_id); return prep.results.shift() || { ok: true, pendingBefore: false }; },
    check: async () => prep.seen };

  const app = express();
  app.use(express.json());
  app.use("/api/admin/manual", createRouter({ requireAdmin, deps, driver, viewer, media: {}, lanePrep: prep }));
  const server = app.listen(0);
  const B = `/api/admin/manual/agents/${REF}/browser`;
  const stateOf = async () => (await call(server, "GET", `${B}/state`)).body.lane;
  const until = async (want) => { for (let i = 0; i < 200; i++) { const l = await stateOf(); if (l && l.state === want) return l; await tick(); } throw new Error(`lane never ${want}: ${JSON.stringify(await stateOf())}`); };
  try {
    assert.equal((await call(server, "POST", `${B}/run`)).status, 409, "no browser open");
    assert.equal((await call(server, "POST", B)).status, 200);
    await tick();
    assert.equal((await stateOf()), null, "nothing runs until ▶");
    assert.equal((await call(server, "POST", `${B}/next`, {})).status, 409, "not running");

    // ▶: the first owed group is prepared; the change is pushed down the viewer's stream.
    await call(server, "POST", `${B}/run`);
    let l = await until("ready");
    assert.equal(l.item.group_id, "111");
    assert.ok(events.some((e) => e.t === "lane" && e.lane.state === "ready"), "pushed");
    // "הבא" after Post: seen → posted, and the next group is prepared.
    let r = await call(server, "POST", `${B}/next`, {});
    assert.equal(r.body.recorded, "posted");
    l = await until("ready");
    assert.equal(l.item.group_id, "222");
    assert.equal((await K.store.getPostingCampaign(c.id)).posts.find((p) => p.group_id === "111").status, "posted");
    // "הבא" with no post: asks why; a bad "other" is refused; a reason records the skip and ends the list.
    prep.seen = "not_posted";
    r = await call(server, "POST", `${B}/next`, {});
    assert.equal(r.body.need, "reason");
    assert.equal((await call(server, "POST", `${B}/next`, { reason: "other", note: "x" })).status, 400);
    assert.equal((await call(server, "POST", `${B}/next`, { reason: "prep_failed" })).status, 400, "the server's own reason");
    r = await call(server, "POST", `${B}/next`, { reason: "posting_method" });
    assert.equal(r.body.recorded, "skipped");
    assert.equal(r.body.completed, true, "the last group: the campaign is complete");
    await until("empty");
    assert.deepEqual(prepared, ["111", "222"]);

    // A failed preparation: "הבא" skips it with the failure as the reason. Unsure: the admin confirms.
    await K.db.savePage(K.page("pg2", AGENT));
    const c2 = await C.create(K.base({ page: K.page("pg2", AGENT) }), deps);
    prep.results.push({ ok: false, code: "not_member" });
    await call(server, "POST", `${B}/run`);
    l = await until("failed");
    assert.equal(l.code, "not_member");
    r = await call(server, "POST", `${B}/next`, {});
    assert.equal(r.body.recorded, "skipped");
    await until("ready");
    prep.seen = "unsure";
    r = await call(server, "POST", `${B}/next`, {});
    assert.equal(r.body.need, "confirm");
    r = await call(server, "POST", `${B}/next`, { posted: true });
    assert.equal(r.body.recorded, "posted");
    const posts = (await K.store.getPostingCampaign(c2.id)).posts;
    assert.deepEqual(posts.map((p) => [p.group_id, p.status, p.skip_reason || null]), [["111", "skipped", "prep_failed"], ["222", "posted", null]]);

    // The global list: every skip, most flagged first.
    const flags = (await call(server, "GET", "/api/admin/manual/flags")).body.flags;
    assert.deepEqual(flags.map((f) => [f.group_id, f.total]).sort(), [["111", 1], ["222", 1]]);
    assert.equal(flags.find((f) => f.group_id === "111").recent[0].note, "not_member");
    assert.ok(!JSON.stringify(flags).includes(AGENT), "never the phone");
  } finally { server.close(); }
  console.log("routes/admin-manual-lane.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
