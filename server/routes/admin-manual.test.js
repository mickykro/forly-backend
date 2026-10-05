/* routes/admin-manual.js: the "פרסום ידני" tab's API, with a fake Driver,
   viewer and browser page (its file chooser fired by hand). */
const assert = require("assert");
const express = require("express");
const http = require("http");
const auth = require("../auth");
const { makeAdminGuard } = require("../admin-auth");
const K = require("../posting-testkit");
const C = require("../posting-campaign");
const M = require("../posting-manual");
const createRouter = require("./admin-manual");

const SECRET = "admin-manual-secret", ADMIN = "972500000009", AGENT = "972500000001";
const { requireAdmin } = makeAdminGuard({ verifySession: auth.verifySession, readToken: auth.readToken, authSecret: SECRET, adminPhones: [ADMIN] });
const H = { authorization: `Bearer ${auth.signSession(SECRET, ADMIN)}`, "content-type": "application/json" };
function call(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, path, method, headers: H }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let b = d; try { b = JSON.parse(d); } catch { /* text */ } resolve({ status: res.statusCode, body: b, raw: d }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const { deps } = await K.setup(AGENT);
  deps.env = { POSTING_MANUAL: "1" };
  deps.pageBaseUrl = "https://f.ly";
  const page = Object.assign(K.page("pg1", AGENT), { hero: { video_url: "https://f.ly/files/pages/pg1/walkthrough.mp4" } });
  await K.db.savePage(page);
  await K.db.savePage(K.page("other", "972500000002"));
  await K.db.savePage(K.page("idle", AGENT)); // the agent's, but no campaign
  const c = await C.create(K.base({ copies: { 111: "שורה ראשונה\nשורה שנייה" } }), deps);
  const REF = M.refOf(AGENT);

  // A fake browser page: keyboard, goto, the composer's file input (absent), and its file chooser.
  const typed = [], gotos = [], chosen = [], stopped = [];
  const listeners = {};
  const fakePage = {
    url: () => "https://www.facebook.com/groups/111",
    goto: async (u) => { gotos.push(u); },
    keyboard: { insertText: async (t) => typed.push(["text", t]), press: async (k) => typed.push(["key", k]) },
    locator: () => ({ first() { return this; }, count: async () => 0, setInputFiles: async () => { throw new Error("no input"); } }),
    on: (ev, fn) => { listeners[ev] = fn; },
  };
  const context = { pages: () => [fakePage], on: () => {} };
  const hubs = new Map();
  const viewer = {
    _hubs: hubs,
    attach: async (k) => { hubs.set(k, { page: fakePage, context }); return hubs.get(k); },
    pipe: (req, res) => res.json({ streaming: true }),
    input: async () => ({}),
    close: async (k) => { hubs.delete(k); },
  };
  const sessions = [];
  const driver = { createSession: async (o) => { sessions.push(o); return { sessionId: "s1" }; }, stopSession: async (id) => { stopped.push(id); } };
  const media = { fetchVideo: async (u) => ({ name: "property.mp4", mimeType: "video/mp4", buffer: Buffer.from(u) }) };

  const app = express();
  app.use(express.json());
  app.use("/api/admin/manual", createRouter({ requireAdmin, deps, driver, viewer, media }));
  const server = app.listen(0);
  const B = `/api/admin/manual/agents/${REF}/browser`;
  try {
    // ── the work list and the agents: refs, never phones ──
    const q = await call(server, "GET", "/api/admin/manual/queue");
    assert.deepEqual(q.body.items.map((i) => i.group_id), ["111", "222"]);
    const ag = await call(server, "GET", "/api/admin/manual/agents");
    assert.equal(ag.body.agents[0].ref, REF);
    assert.equal(ag.body.agents[0].owed, 2);
    for (const r of [q, ag]) assert.ok(!r.raw.includes(AGENT), "no full phone");
    assert.equal((await call(server, "GET", "/api/admin/manual/agents/acct_nope/properties")).status, 404);
    // ── the checklist: every group of every running campaign, with its status ──
    assert.deepEqual(q.body.campaigns.map((x) => [x.page_id, x.groups.map((g) => [g.group_id, g.status])]), [["pg1", [["111", "owed"], ["222", "owed"]]]]);
    assert.ok(q.body.campaigns[0].groups.every((g) => g.copy && /^https:\/\/www\.facebook\.com\/groups\//.test(g.url)), "each group: its text and its link");
    // ── properties: only those with a running campaign ──
    assert.deepEqual((await call(server, "GET", `/api/admin/manual/agents/${REF}/properties`)).body.properties.map((x) => x.page_id), ["pg1"]);

    // ── a browser action before one is open ──
    assert.equal((await call(server, "POST", `${B}/type`, { text: "x" })).status, 409);

    // ── open (twice reuses), view, property ──
    assert.equal((await call(server, "POST", B, { group_url: "https://evil.example/groups/1" })).status, 400, "groups on Facebook only");
    const opened = await call(server, "POST", B, { group_url: "https://www.facebook.com/groups/111" });
    assert.deepEqual(opened.body, { open: true, at_group: true });
    assert.equal(sessions[0].url, "https://www.facebook.com/groups/111", "the browser starts on the group");
    assert.deepEqual((await call(server, "POST", B)).body, { open: true, at_group: false }, "opening again reuses it");
    await call(server, "GET", `${B}/view`);
    assert.equal((await call(server, "POST", `${B}/property`, { page_id: "other" })).status, 404, "another agent's property is refused");
    const prop = await call(server, "POST", `${B}/property`, { page_id: "pg1" });
    assert.equal(prop.body.property.page_id, "pg1");
    assert.equal((await call(server, "GET", `${B}/state`)).body.property.page_id, "pg1", "the session shows what it shares");

    // ── goto: Facebook groups only ──
    assert.equal((await call(server, "POST", `${B}/goto`, { group_url: "https://evil.example/groups/1" })).status, 400);
    assert.equal((await call(server, "POST", `${B}/goto`, { group_url: "https://www.facebook.com/groups/111" })).status, 200);
    assert.deepEqual(gotos, ["https://www.facebook.com/groups/111"]);

    // ── type: lines as text, Enter between ──
    await call(server, "POST", `${B}/type`, { text: "שורה ראשונה\nשורה שנייה" });
    assert.deepEqual(typed, [["text", "שורה ראשונה"], ["key", "Enter"], ["text", "שורה שנייה"]]);

    // ── video: refused until Facebook's file chooser opens, then into it ──
    assert.equal((await call(server, "POST", `${B}/video`)).body.error, "chooser_not_open");
    assert.equal((await call(server, "GET", `${B}/state`)).body.chooser_open, false);
    listeners.filechooser({ setFiles: async (f) => chosen.push(f) }); // the admin clicked "תמונה/סרטון"
    assert.equal((await call(server, "GET", `${B}/state`)).body.chooser_open, true);
    assert.equal((await call(server, "POST", `${B}/video`)).status, 200);
    assert.equal(chosen.length, 1);
    assert.equal(chosen[0].buffer.toString(), "https://f.ly/files/pages/pg1/walkthrough.mp4", "the session property's video");
    assert.equal((await call(server, "GET", `${B}/state`)).body.chooser_open, false, "a chooser is used once");

    // ── tick off ──
    const d1 = await call(server, "POST", `/api/admin/manual/campaigns/${c.id}/groups/111/done`, { status: "posted" });
    assert.deepEqual(d1.body, { ok: true, completed: false });
    assert.equal((await call(server, "POST", `/api/admin/manual/campaigns/${c.id}/groups/111/done`, { status: "posted" })).status, 404);
    assert.equal((await call(server, "POST", `/api/admin/manual/campaigns/${c.id}/groups/222/done`, { status: "nope" })).status, 400);
    const q2 = await call(server, "GET", "/api/admin/manual/queue");
    assert.deepEqual(q2.body.campaigns[0].groups.map((g) => g.status), ["posted", "owed"], "a ticked group stays on the checklist, as posted");
    assert.deepEqual(q2.body.items.map((i) => i.group_id), ["222"]);
    assert.ok(q2.body.campaigns[0].groups[0].posted_at && !q2.body.campaigns[0].groups[1].posted_at, "when it went up, posted groups only");

    // ── one property in full: every text version, the agent's groups and where each stands ──
    const full = await call(server, "GET", `/api/admin/manual/agents/${REF}/properties/pg1`);
    assert.equal(full.status, 200);
    assert.equal(full.body.versions.length, require("../distribution/share-kit").TEMPLATE_COUNT);
    assert.equal(new Set(full.body.versions).size, full.body.versions.length, "every version differs");
    assert.ok(full.body.versions.every((t) => t.includes("https://f.ly/p/pg1")), "each carries the property link");
    assert.deepEqual(full.body.groups.map((g) => [g.group_id, g.status]), [["111", "posted"], ["222", "owed"]]);
    assert.equal(full.body.groups[0].copy, "שורה ראשונה\nשורה שנייה", "the approved text rides with its group");
    assert.equal((await call(server, "GET", `/api/admin/manual/agents/${REF}/properties/other`)).status, 404, "another agent's property");

    // ── close ──
    assert.equal((await call(server, "DELETE", B)).status, 200);
    assert.deepEqual(stopped, ["s1"]);
    assert.equal((await call(server, "GET", `${B}/state`)).status, 409, "closed");
    console.log("routes/admin-manual.test.js ok");
  } finally { server.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
