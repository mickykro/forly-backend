/* Shared fixtures for routes/posting*.test.js. Real db.js (memory path),
   real posting-store, posting-campaign and posting-guard (../posting-testkit.js);
   the catalog, the groups sync and WhatsApp are fakes. Not a test itself. */
const express = require("express");
const http = require("http");
const K = require("../posting-testkit");
const createRouter = require("./posting");

const PH = "972500000001";
const OTHER = "972500000009";
const AUTH = "test-auth-secret";
const G = K.G;

// A catalog as mergedCatalog() returns it: 111 and 222 curated, 999 not.
const CATALOG = [
  { url: G(111), name: "דירות בחיפה", city: "חיפה", members: 5000, agent_policy: "explicitly_allowed", listing_types: ["sale", "rent"] },
  { url: G(222), name: "נדלן קריות", city: "קריות", members: 800, agent_policy: "unknown", listing_types: [] },
  { url: G(333), name: "חיפה והסביבה", city: "Haifa", members: 9000, agent_policy: "explicitly_allowed", listing_types: [] },
  { url: G(444), name: "תל אביב דירות", city: "תל אביב", members: 20000, agent_policy: "explicitly_allowed", listing_types: [] },
  { url: G("haifa.homes"), name: "בתים בחיפה", city: "חיפה", members: 100, agent_policy: "explicitly_allowed", listing_types: [] },
];

// Members: 111 and 222 (named), 999 (hashed, not curated), 555 (left), and a
// vanity slug resolved to 777 (its old id stays an alias).
function members() {
  return [
    K.member("111"), K.member("222"),
    K.member("999", { name: undefined, name_hash: "abcd" }),
    K.member("555", { membership_state: "left" }),
    K.member("777", { slug: "haifa.homes", canonical_url: G("haifa.homes"), aliases: ["slug:haifa.homes"], name: "בתים בחיפה" }),
  ];
}

async function setup(o = {}) {
  const env = await K.setup(PH, { conn: Object.assign({ facebook_groups_member: members() }, o.conn || {}) });
  if (o.noPermission) await K.db.setConnection(PH, { posting_permission: null });
  await K.db.savePage(K.page("pg2", PH));
  await K.db.savePage(K.page("pgX", OTHER));
  const syncs = [];
  const deps = Object.assign({}, env.deps, {
    groupsSync: o.groupsSync || { runSync: async (a) => { syncs.push(a.phone); return 2; } },
  }, o.deps || {});
  const app = makeApp({ deps, phone: o.phone, planNow: o.planNow });
  return Object.assign(env, { deps, app, syncs, as: (phone) => makeApp({ deps, phone, planNow: o.planNow }) });
}

// planNow: the route's immediate plan. Stubbed (a no-op) unless a test passes
// its own, or null for the real posting-tick plan.
function makeApp({ deps, phone = PH, catalog = async () => CATALOG, planNow = async () => "stubbed" }) {
  const requireAuth = () => (req, res, next) => { req.user = { userId: phone }; next(); };
  const app = express();
  app.use(express.json());
  app.use("/api/posting", createRouter({ requireAuth, authSecret: AUTH, pageBaseUrl: "https://f.ly", deps, catalog, planNow: planNow || undefined }));
  return app;
}

function call(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({ port: server.address().port, path, method, headers: { "content-type": "application/json" } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          server.close();
          let json = {};
          try { json = d.startsWith("{") ? JSON.parse(d) : {}; } catch { json = {}; }
          resolve({ status: res.statusCode, body: json, raw: d, headers: res.headers });
        });
      });
      req.on("error", (e) => { server.close(); reject(e); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

const consented = (b) => Object.assign({ consent: true, consent_version: createRouter.CONSENT_VERSION, page_id: "pg1", group_ids: ["111"], mode: "standing" }, b);
const globalOff = () => K.db.mem.settings.set("posting", { enabled: false, version: 2 });
const globalOn = () => K.db.mem.settings.set("posting", { enabled: true, version: 3 });

// A per_post campaign on pg1 with one post waiting for approval.
async function pendingCampaign(env, over = {}) {
  const C = require("../posting-campaign");
  const c = await C.create(K.base({ mode: "per_post" }), env.deps);
  const post = Object.assign({ id: "p1", target: "group", group_id: "111", group_url: G(111), group_name: "דירות בחיפה", status: "pending_approval",
    scheduled_at: K.iso(K.NOW.getTime() + K.HOUR), created_at: K.iso(K.NOW), copy: "דירה בחיפה", copy_hash: "h".repeat(32), attempt_key: null }, over);
  return K.store.mutatePostingCampaign(c.id, () => ({ posts: [post] }));
}

module.exports = { K, PH, OTHER, AUTH, G, CATALOG, members, setup, makeApp, call, consented, globalOff, globalOn, pendingCampaign, createRouter };
