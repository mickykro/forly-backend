/* routes/extract.js — request validation, error → status mapping, the daily
   cap and the image import guard. Express is not exercised; the handlers'
   pure parts are. */
process.env.FORLY_ENV = "local";
const assert = require("assert");
const { _test } = require("./extract");
const { validateBody, statusFor, DailyLimit, importImage, IMAGE_TYPES } = _test;

// ── body: exactly one of text/url, trimmed, capped ──
assert.deepEqual(validateBody({ text: "  שלום  " }), { text: "שלום" });
assert.deepEqual(validateBody({ url: " https://x.co/1 " }), { url: "https://x.co/1" });
assert.equal(validateBody({}), null);
assert.equal(validateBody({ text: "a", url: "https://x" }), null);
assert.equal(validateBody({ text: "   " }), null);
assert.equal(validateBody({ url: "not a url" }), null);
assert.equal(validateBody({ text: "x".repeat(20000) }).text.length, require("../listing-extract").MAX_INPUT);
assert.equal(validateBody(null), null);

// ── error codes → http status ──
assert.equal(statusFor("invalid_input"), 400);
assert.equal(statusFor("facebook_not_connected"), 409);
assert.equal(statusFor("page_unreadable"), 422);
assert.equal(statusFor("extract_limit"), 429);
assert.equal(statusFor("extract_unavailable"), 503);
assert.equal(statusFor("anything_else"), 500);

// ── daily cap: per key, per UTC day ──
const lim = new DailyLimit(2);
const day1 = new Date("2026-09-08T10:00:00Z");
assert.equal(lim.take("a", day1), true);
assert.equal(lim.take("a", day1), true);
assert.equal(lim.take("a", day1), false);
assert.equal(lim.take("b", day1), true);
assert.equal(lim.take("a", new Date("2026-09-09T00:00:01Z")), true);

// ── image import: public url, image type, size cap ──
(async () => {
  const png = Buffer.from("89504e47", "hex");
  const fetchOk = async () => ({ ok: true, headers: new Map([["content-type", "image/png"]]), arrayBuffer: async () => png });
  const img = await importImage("https://c/a.png", { fetchFn: fetchOk, lookup: async () => [{ address: "1.2.3.4" }] });
  assert.match(img.fname, /^[0-9a-f-]{36}\.png$/);
  assert.equal(img.contentType, "image/png");
  assert.equal(img.buffer.length, png.length);

  await assert.rejects(importImage("http://127.0.0.1/x.png", { fetchFn: fetchOk }), (e) => e.code === "invalid_input");
  const fetchHtml = async () => ({ ok: true, headers: new Map([["content-type", "text/html"]]), arrayBuffer: async () => png });
  await assert.rejects(importImage("https://c/a", { fetchFn: fetchHtml, lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  const big = Buffer.alloc(10 * 1024 * 1024 + 1);
  const fetchBig = async () => ({ ok: true, headers: new Map([["content-type", "image/jpeg"]]), arrayBuffer: async () => big });
  await assert.rejects(importImage("https://c/a.jpg", { fetchFn: fetchBig, lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  const fetch404 = async () => ({ ok: false, status: 404, headers: new Map() });
  await assert.rejects(importImage("https://c/a.jpg", { fetchFn: fetch404, lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  assert.deepEqual(Object.keys(IMAGE_TYPES), ["image/jpeg", "image/png", "image/webp"]);
  // WhatsApp media arrives as octet-stream: the bytes decide
  const jpg = Buffer.from("ffd8ffe0", "hex");
  const fetchOctet = (buf) => async () => ({ ok: true, headers: new Map([["content-type", "application/octet-stream"]]), arrayBuffer: async () => buf });
  const wa = await importImage("https://c/x", { fetchFn: fetchOctet(jpg), lookup: async () => [{ address: "1.2.3.4" }] });
  assert.deepEqual([wa.contentType, wa.fname.endsWith(".jpg")], ["image/jpeg", true]);
  await assert.rejects(importImage("https://c/x", { fetchFn: fetchOctet(Buffer.from("%PDF")), lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  // videos only when asked for, and never as a "photo"
  const mp4 = Buffer.concat([Buffer.from("00000018", "hex"), Buffer.from("ftypmp42")]);
  const vid = await importImage("https://c/v", { fetchFn: fetchOctet(mp4), lookup: async () => [{ address: "1.2.3.4" }], video: true });
  assert.deepEqual([vid.contentType, vid.fname.endsWith(".mp4")], ["video/mp4", true]);
  await assert.rejects(importImage("https://c/v", { fetchFn: fetchOctet(mp4), lookup: async () => [{ address: "1.2.3.4" }] }), (e) => e.code === "page_unreadable");
  await assert.rejects(importImage("https://c/x", { fetchFn: fetchOctet(jpg), lookup: async () => [{ address: "1.2.3.4" }], video: true }), (e) => e.code === "page_unreadable");
})();

// ── the queue/poll/fallback route, built with a real Express app ──
const express = require("express");
const http = require("http");
const createExtractRouter = require("./extract");

function makeApp(o = {}) {
  const phone = o.phone || "0500000000";
  const requireAuth = () => (req, res, next) => { req.user = { userId: phone }; next(); };
  const app = express(); app.use(express.json());
  app.use("/api", createExtractRouter({ requireAuth, authSecret: "s", resolve: o.resolve, db: o.db, extractJobs: o.extractJobs, driverEnabled: o.driverEnabled !== false }));
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
const get = (app, path) => call(app, "GET", path);

(async () => {
// ── a driver-routed URL queues a job instead of answering inline ──
{
  const created = [];
  const app = makeApp({
    extractJobs: { create: async (input) => { created.push(input); return { id: "job-1", status: "queued" }; } },
  });
  const res = await post(app, "/api/properties/extract", { url: "https://www.yad2.co.il/item/abc" });
  assert.equal(res.status, 202);
  assert.equal(res.body.job_id, "job-1");
  assert.equal(res.body.status, "queued");
  assert.equal(created.length, 1);
  assert.equal(created[0].url, "https://www.yad2.co.il/item/abc");
  assert.equal(created[0].forceSource, null, "a driver host needs no forcing");
}

// ── I2: a Facebook group URL queues its job with the CURRENT profile generation's name ──
{
  const created = [];
  const { profileName } = require("../profile-name");
  const app = makeApp({
    db: { getConnection: async () => ({ facebook_profile_gen: 1 }) },
    extractJobs: { create: async (input) => { created.push(input); return { id: "job-g", status: "queued" }; } },
  });
  const res = await post(app, "/api/properties/extract", { url: "https://www.facebook.com/groups/1/posts/2" });
  assert.equal(res.status, 202);
  assert.equal(created[0].profileName, profileName("facebook", "0500000000", 1), "gen 1, never the gen-0 name");
}

// ── firecrawl failing to READ falls back to a driver job, not an error ──
{
  const created = [];
  const app = makeApp({
    resolve: async () => { const e = new Error("challenge page"); e.code = "page_unreadable"; throw e; },
    extractJobs: { create: async (input) => { created.push(input); return { id: "job-2", status: "queued" }; } },
  });
  const res = await post(app, "/api/properties/extract", { url: "https://www.komo.co.il/item/1" });
  assert.equal(res.status, 202);
  assert.equal(res.body.job_id, "job-2");
  assert.equal(created[0].forceSource, "driver");
  assert.equal(created[0].profileName, null, "a fallback scrape NEVER gets a customer's logged-in profile");
}

// ── but firecrawl being UNCONFIGURED is not a reason to spend a browser ──
{
  const app = makeApp({
    resolve: async () => { const e = new Error("no key"); e.code = "extract_unavailable"; throw e; },
    extractJobs: { create: async () => { throw new Error("must not queue"); } },
  });
  const res = await post(app, "/api/properties/extract", { url: "https://www.komo.co.il/item/1" });
  assert.equal(res.status, 503);
}

// ── demo callers never reach a browser: they get told to sign in ──
{
  const app = makeApp({ extractJobs: { create: async () => { throw new Error("must not queue"); } } });
  const res = await post(app, "/api/properties/extract", { url: "https://www.yad2.co.il/item/abc" }, { "x-demo-key": "demo" });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "login_required_for_browser");
}

// ── and with Driver not configured, the answer is an honest 503, not a job that never runs ──
{
  const app = makeApp({ driverEnabled: false, extractJobs: { create: async () => { throw new Error("must not queue"); } } });
  const res = await post(app, "/api/properties/extract", { url: "https://www.yad2.co.il/item/abc" });
  assert.equal(res.status, 503);
}

// ── the default "enabled" decision is driver-browser's: a key alone is not enough ──
{
  const saved = { k: process.env.DRIVER_API_KEY, p: process.env.PROFILE_KEY, e: process.env.FORLY_ENV };
  Object.assign(process.env, { DRIVER_API_KEY: "k", FORLY_ENV: "local" });
  delete process.env.PROFILE_KEY;
  const requireAuth = () => (req, res, next) => { req.user = { userId: "0500000000" }; next(); };
  const mk = () => {
    const app = express(); app.use(express.json());
    app.use("/api", createExtractRouter({ requireAuth, authSecret: "s", db: {}, extractJobs: { create: async () => ({ id: "j", status: "queued" }) } }));
    return app;
  };
  const off = await post(mk(), "/api/properties/extract", { url: "https://www.yad2.co.il/item/abc" });
  assert.equal(off.status, 503, "DRIVER_API_KEY without PROFILE_KEY is not enabled");
  process.env.PROFILE_KEY = "p";
  const on = await post(mk(), "/api/properties/extract", { url: "https://www.yad2.co.il/item/abc" });
  assert.equal(on.status, 202, "all three set → enabled");
  for (const [k, v] of [["DRIVER_API_KEY", saved.k], ["PROFILE_KEY", saved.p], ["FORLY_ENV", saved.e]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

// ── but a bad input is still a 400: the browser cannot fix a malformed URL ──
{
  const app = makeApp({
    resolve: async () => { const e = new Error("bad"); e.code = "invalid_input"; throw e; },
    extractJobs: { create: async () => { throw new Error("must not queue"); } },
  });
  const res = await post(app, "/api/properties/extract", { url: "https://example.com/x" });
  assert.equal(res.status, 400);
}

// ── polling returns the job, and only to its owner ──
{
  const job = { id: "job-3", phone: "0500000000", status: "done", error_code: null,
    result: { source: "driver", description: "דירה", fields: { city: "חיפה" }, missing: ["rooms"], photos: [] } };
  const app = makeApp({ db: { getExtractJob: async (id) => (id === "job-3" ? job : null) } });
  const ok = await get(app, "/api/properties/extract/job-3");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "done");
  assert.deepEqual(ok.body.fields, { city: "חיפה" });
  assert.deepEqual(ok.body.missing, ["rooms"]);

  const missing = await get(app, "/api/properties/extract/nope");
  assert.equal(missing.status, 404);

  const otherApp = makeApp({
    phone: "0509999999",
    db: { getExtractJob: async () => job },
  });
  const stolen = await get(otherApp, "/api/properties/extract/job-3");
  assert.equal(stolen.status, 404, "another agent's job must be indistinguishable from a missing one");
}

// ── a failed job reports its stable code, never vendor text ──
{
  const job = { id: "job-4", phone: "0500000000", status: "failed", error_code: "social_login_required", result: null };
  const app = makeApp({ db: { getExtractJob: async () => job } });
  const res = await get(app, "/api/properties/extract/job-4");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "failed");
  assert.equal(res.body.error_code, "social_login_required");
  assert.ok(!("text" in res.body));
}

// ── the browser cap is separate from, and lower than, the firecrawl cap ──
{
  let queued = 0;
  const app = makeApp({ extractJobs: { create: async () => { queued++; return { id: `j${queued}`, status: "queued" }; } } });
  for (let i = 0; i < 10; i++) await post(app, "/api/properties/extract", { url: `https://www.yad2.co.il/item/${i}` });
  const over = await post(app, "/api/properties/extract", { url: "https://www.yad2.co.il/item/over" });
  assert.equal(over.status, 429);
  assert.equal(over.body.error, "extract_limit");
  assert.equal(queued, 10, "DRIVER_DAILY_CAP is 10");
}

// ── profileFor: anchored, and twitter is x ──
{
  const { profileFor } = createExtractRouter._test;
  assert.equal(profileFor("https://www.facebook.com/groups/1", "05x"), profileFor("https://facebook.com/groups/2", "05x"));
  assert.ok(/^facebook-[a-z]+-[0-9a-f]{20}$/.test(profileFor("https://www.facebook.com/groups/1", "05x")), "hmac, not the phone");
  assert.equal(profileFor("https://twitter.com/a/status/1", "05x"), profileFor("https://x.com/a/status/1", "05x"));
  assert.equal(profileFor("https://netflix.com/x", "05x"), null, "not left-anchored → netflix matched x.com");
  assert.equal(profileFor("https://evilfacebook.com/x", "05x"), null);
  assert.equal(profileFor("https://www.yad2.co.il/item/1", "05x"), null, "no profile for non-social hosts");
}
console.log("routes/extract.test.js ok");
})();
