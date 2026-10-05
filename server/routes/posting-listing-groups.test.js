/* routes/posting-listing-groups.js: the group picker's API — owner only, the
   WhatsApp link's groups-only sign-in, choose then approve the texts. */
const assert = require("assert");
const express = require("express");
const http = require("http");
const auth = require("../auth");
const K = require("../posting-testkit");
const LG = require("../posting-listing-groups");
const S_ = require("./posting-shared");
const mount = require("./posting-listing-groups");

const SECRET = "lg-secret", PH = "972500000001", OTHER = "972500000002";
function call(server, method, path, { cookie, bearer, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json" };
    if (cookie) headers.cookie = cookie;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const req = http.request({ port: server.address().port, path, method, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let b = d; try { b = JSON.parse(d); } catch { /* text */ } resolve({ status: res.statusCode, headers: res.headers, body: b }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const { deps } = await K.setup(PH);
  await K.db.saveListing({ listing_id: "L1", business_phone: PH, city: "חיפה", listing_type: "sale", rooms: 4, page_id: null, created_at: K.NOW.toISOString() });
  const router = express.Router();
  mount(router, { db: K.db, deps, catalog: async () => [] }, { authSecret: SECRET, requireAuth: auth.requireAuth, pageBaseUrl: "https://f.ly" });
  const app = express();
  app.use(express.json());
  app.use("/api/posting", router);
  const server = app.listen(0);
  try {
    const groupsToken = decodeURIComponent(LG.link("https://f.ly", SECRET, PH, "L1").split("t=")[1].split("&")[0]);

    // ── the WhatsApp link signs in for the picker, then opens it ──
    const bad = await call(server, "GET", "/api/posting/groups-link?t=nope&l=L1");
    assert.equal(bad.status, 401);
    const ok = await call(server, "GET", `/api/posting/groups-link?t=${encodeURIComponent(groupsToken)}&l=L1`);
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.location, "/groups.html?l=L1");
    assert.match(String(ok.headers["set-cookie"]), /forly_session=/);

    // ── owner only; the groups-scoped token works here ──
    assert.equal((await call(server, "GET", "/api/posting/listing-groups/L1")).status, 401);
    assert.equal((await call(server, "GET", "/api/posting/listing-groups/L1", { bearer: auth.signSession(SECRET, OTHER) })).status, 404, "another agent");
    const g = await call(server, "GET", "/api/posting/listing-groups/L1", { bearer: groupsToken });
    assert.equal(g.status, 200);
    assert.equal(g.body.connected, true);
    assert.deepEqual(g.body.groups.map((x) => x.group_id).sort(), ["111", "222"]);
    assert.equal(g.body.page_ready, false);

    // ── choose: consent required, then saved on the listing ──
    assert.equal((await call(server, "PUT", "/api/posting/listing-groups/L1", { bearer: groupsToken, body: { group_ids: ["111"] } })).status, 400);
    const put = await call(server, "PUT", "/api/posting/listing-groups/L1", { bearer: groupsToken, body: { group_ids: ["111"], consent: true, consent_version: S_.CONSENT_VERSION } });
    assert.deepEqual(put.body, { ok: true, choice: ["111"] });
    assert.equal((await call(server, "PUT", "/api/posting/listing-groups/L1/texts", { bearer: groupsToken, body: { copies: { 111: "x" } } })).status, 409, "no page yet");

    // ── the page is built: the text to approve, then approved ──
    await K.db.setListingPageId("L1", "pg1");
    await LG.apply(K.page("pg1", PH), await K.db.getListing("L1"), deps);
    const r = await call(server, "GET", "/api/posting/listing-groups/L1", { bearer: groupsToken });
    assert.equal(r.body.review.awaiting, true);
    assert.equal(r.body.review.groups[0].group_id, "111");
    assert.equal((await call(server, "PUT", "/api/posting/listing-groups/L1/texts", { bearer: groupsToken, body: { copies: { 111: "הטקסט שלי" } } })).status, 200);
    const after = await call(server, "GET", "/api/posting/listing-groups/L1", { bearer: groupsToken });
    assert.equal(after.body.review.awaiting, false);
    assert.equal(after.body.review.groups[0].copy, "הטקסט שלי");

    // ── not connected: the picker shows nothing ──
    await K.db.setConnection(PH, { facebook_browser_connected_at: null });
    assert.deepEqual((await call(server, "GET", "/api/posting/listing-groups/L1", { bearer: groupsToken })).body, { connected: false });
    console.log("routes/posting-listing-groups.test.js ok");
  } finally { server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
