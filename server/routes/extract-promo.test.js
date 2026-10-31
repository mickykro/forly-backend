/* routes/extract.js — /reel promo-scope callers: caps, the scrape admin's
   profile for Facebook group posts only, and the redirect-hop SSRF guard.
   Admin and x-demo-key behaviour is pinned in extract.test.js. */
process.env.FORLY_ENV = "local";
delete process.env.REEL_SCRAPE_DAILY_CAP;
const assert = require("assert");
const express = require("express");
const http = require("http");
// No model in tests: extract.js binds parseListing at load, so stub it first.
require("../listing-extract").parseListing = async () => ({ fields: {}, missing: [] });
const createExtractRouter = require("./extract");
const extractJobs = require("../extract-jobs");
const { profileNameFor } = require("../profile-name");
const { importImage, isGroupPost } = createExtractRouter._test;

const ADMIN = "0501111111";
const VISITOR = "0503333333";

function makeApp(o = {}) {
  const user = o.user || { userId: VISITOR, scope: "promo" };
  const requireAuth = (secret, scopes) => (req, res, next) => {
    if (!scopes || !scopes.includes(user.scope || "session")) return res.status(401).json({ error: "unauthenticated" });
    req.user = user; next();
  };
  const app = express(); app.use(express.json());
  app.use("/api", createExtractRouter({
    requireAuth, authSecret: "s", verifySession: o.verifySession, readToken: () => "t", adminPhones: [ADMIN],
    reelScrapePhone: "reelScrapePhone" in o ? o.reelScrapePhone : ADMIN,
    resolve: o.resolve, db: o.db || { getConnection: async () => ({}) }, extractJobs: o.extractJobs, driverEnabled: true,
  }));
  return app;
}
function call(app, method, path, body, headers) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const req = http.request({ port: server.address().port, path, method, headers: Object.assign({ "content-type": "application/json" }, headers || {}) }, (res) => {
        let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(d || "{}") }); });
      });
      if (body) req.write(JSON.stringify(body)); req.end();
    });
  });
}
const post = (app, path, body, headers) => call(app, "POST", path, body, headers);
const recorder = () => {
  const created = [];
  return { created, create: async (input) => { created.push(input); return { id: `j${created.length}`, status: "queued" }; } };
};

(async () => {
// ── isGroupPost: posts/permalinks only, www./m. forms, anchored host ──
assert.equal(isGroupPost("https://www.facebook.com/groups/1/posts/2"), true);
assert.equal(isGroupPost("https://m.facebook.com/groups/abc/permalink/9/"), true);
assert.equal(isGroupPost("https://facebook.com/groups/1/posts/2"), true);
assert.equal(isGroupPost("https://www.facebook.com/groups/1"), false, "a group home page is not a post");
assert.equal(isGroupPost("https://www.facebook.com/someone"), false);
assert.equal(isGroupPost("https://evilfacebook.com/groups/1/posts/2"), false);
assert.equal(isGroupPost("https://www.instagram.com/p/x"), false);

// ── a promo token extracts text; the 11th extract that day → 429 ──
{
  const app = makeApp();
  const first = await post(app, "/api/properties/extract", { text: "דירה 4 חדרים בחיפה" });
  assert.equal(first.status, 200);
  assert.equal(first.body.source, "text");
  for (let i = 0; i < 9; i++) await post(app, "/api/properties/extract", { text: `x${i}` });
  const over = await post(app, "/api/properties/extract", { text: "over" });
  assert.equal(over.status, 429);
  assert.equal(over.body.error, "extract_limit");
}

// ── a group-post job: the admin's profile + profile_owner, owned by the visitor ──
{
  const jobs = recorder();
  const conns = [];
  const app = makeApp({
    db: { getConnection: async (p) => { conns.push(p); return { facebook_profile_gen: 2 }; } },
    extractJobs: jobs,
  });
  const res = await post(app, "/api/properties/extract", { url: "https://www.facebook.com/groups/1/posts/2" });
  assert.equal(res.status, 202);
  assert.equal(jobs.created[0].phone, VISITOR, "the job belongs to the visitor");
  assert.equal(jobs.created[0].profileOwner, ADMIN);
  assert.equal(jobs.created[0].profileName, profileNameFor("facebook", ADMIN, { facebook_profile_gen: 2 }));
  assert.deepEqual(conns, [ADMIN], "the visitor's connection is never read");
}

// ── no scrape admin configured → 409 for a group post ──
{
  const app = makeApp({ reelScrapePhone: null, extractJobs: { create: async () => { throw new Error("must not queue"); } } });
  const res = await post(app, "/api/properties/extract", { url: "https://www.facebook.com/groups/1/posts/2" });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "login_required_for_browser");
}

// ── Instagram, a FB profile, a group home page → no profile at all ──
{
  const jobs = recorder();
  const app = makeApp({ db: { getConnection: async () => { throw new Error("no connection read"); } }, extractJobs: jobs });
  for (const url of ["https://www.instagram.com/p/abc", "https://www.facebook.com/someone"]) {
    const res = await post(app, "/api/properties/extract", { url });
    assert.equal(res.status, 202, url);
  }
  for (const j of jobs.created) assert.deepEqual([j.profileName, j.profileOwner], [null, null], j.url);
}

// ── a FB page post skips the Graph route: a bare browser job instead of a 409 ──
{
  const jobs = recorder();
  const app = makeApp({ resolve: async () => { throw new Error("graph must not run"); }, extractJobs: jobs });
  const res = await post(app, "/api/properties/extract", { url: "https://www.facebook.com/somepage/posts/123" });
  assert.equal(res.status, 202);
  assert.deepEqual([jobs.created[0].forceSource, jobs.created[0].profileName], ["driver", null]);
}

// ── 3 browser jobs/day per visitor; the admin's own driverLimit is untouched ──
{
  const jobs = recorder();
  let user = { userId: VISITOR, scope: "promo" };
  const requireAuth = (s, scopes) => (req, res, next) => { req.user = user; next(); };
  const app = express(); app.use(express.json());
  app.use("/api", createExtractRouter({ requireAuth, authSecret: "s", adminPhones: [ADMIN], reelScrapePhone: ADMIN, db: { getConnection: async () => ({}) }, extractJobs: jobs, driverEnabled: true }));
  for (let i = 0; i < 3; i++) assert.equal((await post(app, "/api/properties/extract", { url: `https://www.facebook.com/groups/1/posts/${i}` })).status, 202);
  const over = await post(app, "/api/properties/extract", { url: "https://www.facebook.com/groups/1/posts/9" });
  assert.equal(over.status, 429);
  user = { userId: ADMIN };
  for (let i = 0; i < 10; i++) assert.equal((await post(app, "/api/properties/extract", { url: `https://www.yad2.co.il/item/${i}` })).status, 202, "admin still has all 10");
}

// ── the site-wide promo pool (REEL_SCRAPE_DAILY_CAP, default 20) ──
{
  const jobs = recorder();
  let n = 0, user;
  const requireAuth = () => (req, res, next) => { req.user = user; next(); };
  const app = express(); app.use(express.json());
  app.use("/api", createExtractRouter({ requireAuth, authSecret: "s", db: {}, extractJobs: jobs, driverEnabled: true }));
  let last;
  for (let i = 0; i < 21; i++) {
    user = { userId: `05000000${String(n++).padStart(2, "0")}`, scope: "promo" };
    last = await post(app, "/api/properties/extract", { url: "https://www.yad2.co.il/item/1" });
  }
  assert.equal(jobs.created.length, 20);
  assert.equal(last.status, 429);
}

// ── polling: the visitor sees their own job, another phone gets 404 ──
{
  const job = { id: "jp", phone: VISITOR, profile_owner: ADMIN, status: "queued" };
  const db = { getExtractJob: async () => job };
  assert.equal((await call(makeApp({ db }), "GET", "/api/properties/extract/jp")).status, 200);
  const other = await call(makeApp({ db, user: { userId: "0504444444", scope: "promo" } }), "GET", "/api/properties/extract/jp");
  assert.equal(other.status, 404);
  const admin = await call(makeApp({ db, user: { userId: ADMIN } }), "GET", "/api/properties/extract/jp");
  assert.equal(admin.status, 404, "the profile owner does not own the job");
}

// ── an admin session still uses its own profile (no profile_owner) ──
{
  const jobs = recorder();
  const app = makeApp({ user: { userId: ADMIN }, extractJobs: jobs });
  const res = await post(app, "/api/properties/extract", { url: "https://www.facebook.com/groups/1/posts/2" });
  assert.equal(res.status, 202);
  assert.equal(jobs.created[0].phone, ADMIN);
  assert.equal(jobs.created[0].profileOwner, undefined);
}

// ── x-demo-key path is unchanged: anonymous → 409 for a browser host ──
{
  const app = makeApp({ verifySession: () => null, extractJobs: { create: async () => { throw new Error("must not queue"); } } });
  const res = await post(app, "/api/properties/extract", { url: "https://www.yad2.co.il/item/abc" }, { "x-demo-key": "demo" });
  assert.equal(res.body.error, "login_required_for_browser");
}

// ── extract-jobs: profile_owner persisted; lock, connection, name and resolve phone use it ──
{
  const saved = [];
  const deps = { db: { saveExtractJob: async (j) => saved.push(j) } };
  const job = await extractJobs.create({ phone: VISITOR, url: "https://www.facebook.com/groups/1/posts/2", profileName: "facebook-local-x", profileOwner: ADMIN }, deps);
  assert.equal(saved[0].profile_owner, ADMIN);
  assert.equal(saved[0].phone, VISITOR);

  const locked = [], conns = [], resolved = [];
  const runDeps = {
    locks: { tryAcquire: (p, plat) => { locked.push([p, plat]); return () => {}; } },
    db: {
      updateExtractJob: async () => {},
      getConnection: async (p) => { conns.push(p); return {}; },
    },
    resolve: async (input, opts) => { resolved.push(opts.phone); return { source: "driver", text: "t", description: "", photos: [] }; },
    parseListing: async () => ({ fields: {}, missing: [] }),
  };
  const done = await extractJobs.runJob(job, runDeps);
  assert.equal(done.status, "done");
  assert.deepEqual(locked, [[ADMIN, "facebook"]], "the lock key is the profile owner");
  assert.deepEqual(conns, [ADMIN]);
  assert.deepEqual(resolved, [ADMIN]);

  const own = await extractJobs.create({ phone: ADMIN, url: "https://www.facebook.com/groups/1/posts/2", profileName: "facebook-local-x" }, deps);
  assert.equal(saved[1].profile_owner, null);
  locked.length = 0;
  await extractJobs.runJob(own, runDeps);
  assert.deepEqual(locked, [[ADMIN, "facebook"]], "no owner → the job's own phone");
}

// ── import-url: a redirect to 127.0.0.1 is refused; public hops are followed, at most 3 ──
{
  const png = Buffer.from("89504e47", "hex");
  const lookup = async (host) => [{ address: host === "127.0.0.1" ? "127.0.0.1" : "1.2.3.4" }];
  const redirectTo = (loc) => ({ status: 302, ok: false, headers: new Map([["location", loc]]) });
  const okImg = { status: 200, ok: true, headers: new Map([["content-type", "image/png"]]), arrayBuffer: async () => png };
  const seen = [];
  const toLocal = async (u, opts) => { seen.push(opts.redirect); return u.includes("127.0.0.1") ? okImg : redirectTo("http://127.0.0.1/secret.png"); };
  await assert.rejects(importImage("https://c/a.png", { fetchFn: toLocal, lookup }), (e) => e.code === "invalid_input");
  assert.deepEqual(seen, ["manual"], "never fetched the private hop");

  let hops = 0;
  const twoHops = async (u) => (hops++ < 2 ? redirectTo(`/next${hops}`) : okImg);
  const img = await importImage("https://c/a.png", { fetchFn: twoHops, lookup });
  assert.equal(img.contentType, "image/png");

  const loop = async () => redirectTo("/again");
  await assert.rejects(importImage("https://c/a.png", { fetchFn: loop, lookup }), (e) => e.code === "page_unreadable");
}

// ── import-url: promo tokens are accepted, under their own cap (40/day) ──
{
  const app = makeApp();
  const res = await post(app, "/api/photos/import-url", { url: "http://127.0.0.1/x.png" });
  assert.equal(res.status, 400, "reached the handler, refused by the SSRF guard");
  for (let i = 0; i < 39; i++) await post(app, "/api/photos/import-url", { url: "http://127.0.0.1/x.png" });
  const over = await post(app, "/api/photos/import-url", { url: "http://127.0.0.1/x.png" });
  assert.equal(over.status, 429);
}

console.log("routes/extract-promo.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
