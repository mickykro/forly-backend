/*
 * security.test.js — regressions for the security hardening:
 *   SSRF guard, upload content sniffing, constant-time compare, rate limiter,
 *   and the admin allowlist guard.
 * Plain-node test (no framework), matching the rest of server/*.test.js.
 */

const assert = require("assert");
const { assertPublicHttpUrl, sniffMatchesExt } = require("./utils");
const { constantTimeEqual, rateLimit, securityHeaders } = require("./security");
const { makeAdminGuard, makeStepUpGuard } = require("./admin-auth");
const auth = require("./auth");

(async () => {
  // ── SSRF guard: private / loopback / metadata / bad scheme are blocked ──
  const blocked = [
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://127.0.0.1:8080/", "http://[::1]/", "http://10.0.0.5/", "http://192.168.1.1/",
    "http://172.16.0.1/", "http://100.64.0.1/", "http://0.0.0.0/",
    "ftp://example.com/x", "file:///etc/passwd",
    "http://user:pass@example.com/", "not a url",
  ];
  for (const url of blocked) {
    let threw = false;
    try { await assertPublicHttpUrl(url); } catch { threw = true; }
    assert.ok(threw, `should block ${url}`);
  }
  // A public literal IP passes (no DNS needed).
  assert.strictEqual(await assertPublicHttpUrl("http://8.8.8.8/x"), "http://8.8.8.8/x");

  // ── upload sniffing: content must match the claimed extension ──
  assert.ok(sniffMatchesExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "png"));
  assert.ok(sniffMatchesExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), "jpg"));
  assert.ok(!sniffMatchesExt(Buffer.from("<html><script>"), "png")); // HTML-as-png rejected
  assert.ok(!sniffMatchesExt(Buffer.from("GIF89a"), "png"));
  assert.ok(!sniffMatchesExt(Buffer.from([1, 2]), "jpg")); // too short

  // ── constant-time compare ──
  assert.ok(constantTimeEqual("s3cret", "s3cret"));
  assert.ok(!constantTimeEqual("s3cret", "s3creT"));
  assert.ok(!constantTimeEqual("short", "longer-value"));
  assert.ok(!constantTimeEqual("", "x"));

  // ── frame headers: same-origin only, so create.html's /tpl/*.html preview
  //    iframes still render (DENY / 'none' blanked all four template cards) ──
  const hdrs = {};
  securityHeaders({ headers: {} }, { setHeader(k, v) { hdrs[k] = v; } }, () => {});
  assert.strictEqual(hdrs["X-Frame-Options"], "SAMEORIGIN");
  assert.strictEqual(hdrs["Content-Security-Policy"], "frame-ancestors 'self'");

  // ── /api/dev/* is never cached; the dev viewer page exists only with its flag ──
  const through = (path) => {
    const h = {}; let status = null; let nexted = false;
    const res = { setHeader(k, v) { h[k] = v; }, status(c) { status = c; return this; }, type() { return this; }, send() { return this; } };
    securityHeaders({ headers: {}, path }, res, () => { nexted = true; });
    return { h, status, nexted };
  };
  assert.strictEqual(through("/api/dev/driver/sessions").h["Cache-Control"], "no-store");
  assert.strictEqual(through("/api/devices").h["Cache-Control"], undefined);
  const savedDevView = process.env.DRIVER_DEV_VIEW;
  delete process.env.DRIVER_DEV_VIEW;
  for (const p of ["/dev-driver.html", "/dev%2Ddriver.html", "//dev-driver.html", "/./dev-driver.html", "/DEV-DRIVER.HTML"]) {
    const r = through(p);
    assert.strictEqual(r.status, 404, p);
    assert.strictEqual(r.nexted, false, p);
  }
  assert.strictEqual(through("/index.html").nexted, true);
  process.env.DRIVER_DEV_VIEW = "1";
  assert.strictEqual(through("/dev-driver.html").nexted, true);
  if (savedDevView === undefined) delete process.env.DRIVER_DEV_VIEW; else process.env.DRIVER_DEV_VIEW = savedDevView;

  // ── rate limiter: allows `max` then 429s ──
  const mw = rateLimit({ windowMs: 60_000, max: 2, keyBy: () => "k" });
  const run = () => new Promise((resolve) => {
    let status = 200;
    const res = { setHeader() {}, status(c) { status = c; return this; }, json() { resolve(status); return this; } };
    mw({ headers: {}, ip: "1.1.1.1" }, res, () => resolve(200));
  });
  assert.strictEqual(await run(), 200);
  assert.strictEqual(await run(), 200);
  assert.strictEqual(await run(), 429); // third hit blocked

  // ── admin allowlist guard ──
  const guard = makeAdminGuard({
    verifySession: (_s, t) => (t ? { userId: t } : null),
    readToken: (req) => req.token,
    authSecret: "x",
    adminPhones: ["972500000000", "050-111-2222"],
  });
  assert.ok(guard.isAdmin({ userId: "972500000000" }));
  assert.ok(guard.isAdmin({ userId: "972501112222" })); // normalized match
  assert.ok(!guard.isAdmin({ userId: "972599999999" }));
  // requireAdmin: no session → 401, non-admin → 403, admin → next()
  const call = (token) => new Promise((resolve) => {
    let status = 0;
    const res = { status(c) { status = c; return this; }, json() { resolve({ status }); return this; } };
    guard.requireAdmin({ token, headers: {} }, res, () => resolve({ status: "next" }));
  });
  assert.deepStrictEqual(await call(null), { status: 401 });
  assert.deepStrictEqual(await call("972599999999"), { status: 403 });
  assert.deepStrictEqual(await call("972500000000"), { status: "next" });

  // ── step-up: a fresh OTP login's "stepup" token, for the same admin ──
  const SECRET = "stepup-secret";
  const ADMIN = "972500000000";
  const realGuard = makeAdminGuard({ verifySession: auth.verifySession, readToken: auth.readToken, authSecret: SECRET, adminPhones: [ADMIN] });
  const { requireStepUp } = makeStepUpGuard({ verifySession: auth.verifySession, authSecret: SECRET });
  const stepUpCall = (headers) => new Promise((resolve) => {
    let status = 0, body = null;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; resolve({ status, body }); return this; } };
    const req = { headers };
    realGuard.requireAdmin(req, res, () => {
      assert.equal(req.user.userId, ADMIN, "requireAdmin sets req.user");
      requireStepUp(req, res, () => resolve({ status: "next" }));
    });
  });
  const session = auth.signSession(SECRET, ADMIN);
  const stepup = auth.signSession(SECRET, ADMIN, { scope: "stepup", ttlS: 600 });
  const bearer = { authorization: `Bearer ${session}` };
  assert.deepStrictEqual(await stepUpCall({ ...bearer, cookie: `forly_stepup=${encodeURIComponent(stepup)}` }), { status: "next" });
  assert.deepStrictEqual(await stepUpCall({ ...bearer, cookie: `a=1; forly_stepup=${stepup}; b=2` }), { status: "next" });
  assert.deepStrictEqual(await stepUpCall({ ...bearer, "x-stepup-token": stepup }), { status: "next" });
  assert.deepStrictEqual(await stepUpCall(bearer), { status: 401, body: { error: "stepup_required" } });
  // a plain session token is not a step-up
  assert.deepStrictEqual(await stepUpCall({ ...bearer, "x-stepup-token": session }), { status: 401, body: { error: "stepup_required" } });
  assert.deepStrictEqual(await stepUpCall({ ...bearer, cookie: `forly_stepup=${session}` }), { status: 401, body: { error: "stepup_required" } });
  // a step-up for someone else is not this admin's step-up
  const otherStepup = auth.signSession(SECRET, "972500000001", { scope: "stepup", ttlS: 600 });
  assert.deepStrictEqual(await stepUpCall({ ...bearer, "x-stepup-token": otherStepup }), { status: 401, body: { error: "stepup_required" } });
  // an expired step-up
  const expired = auth.signSession(SECRET, ADMIN, { scope: "stepup", ttlS: -1 });
  assert.deepStrictEqual(await stepUpCall({ ...bearer, "x-stepup-token": expired }), { status: 401, body: { error: "stepup_required" } });
  // a stepup token cannot stand in for the session itself
  const asSession = await new Promise((resolve) => {
    const res = { status(c) { resolve(c); return this; }, json() { return this; } };
    realGuard.requireAdmin({ headers: { authorization: `Bearer ${stepup}` } }, res, () => resolve("next"));
  });
  assert.equal(asSession, 401);

  // ── a successful OTP verify also sets the 10-minute step-up cookie ──
  const express = require("express");
  const http = require("http");
  const crypto = require("crypto");
  const mem = {};
  const app = express();
  app.use(express.json());
  app.use("/api/auth", auth({ db: null, mem, sendWhatsApp: async () => {}, secret: SECRET }));
  mem.otps.set(ADMIN, {
    code_hash: crypto.createHmac("sha256", SECRET).update(`${ADMIN}:123456`).digest("base64url"),
    expires_at: new Date(Date.now() + 60_000), attempts: 0,
  });
  const verified = await new Promise((resolve) => {
    const server = app.listen(0, () => {
      const req = http.request({ port: server.address().port, path: "/api/auth/otp/verify", method: "POST", headers: { "content-type": "application/json" } }, (r) => {
        let d = ""; r.on("data", (c) => (d += c));
        r.on("end", () => { server.close(); resolve({ status: r.statusCode, headers: r.headers, body: JSON.parse(d) }); });
      });
      req.end(JSON.stringify({ phone: ADMIN, code: "123456" }));
    });
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.stepup_expires_in, 600);
  const cookies = verified.headers["set-cookie"] || [];
  const su = cookies.find((c) => c.startsWith("forly_stepup="));
  assert.ok(su, "forly_stepup cookie set");
  assert.ok(/HttpOnly/i.test(su) && /Max-Age=600/i.test(su) && /SameSite=Lax/i.test(su), su);
  const suToken = decodeURIComponent(su.split(";")[0].slice("forly_stepup=".length));
  const suPayload = auth.verifySession(SECRET, suToken, ["stepup"]);
  assert.equal(suPayload.userId, ADMIN);
  assert.equal(auth.verifySession(SECRET, suToken), null, "not usable as a session");
  assert.ok(cookies.some((c) => c.startsWith("forly_session=")), "the session cookie is still set");

  console.log("security.test.js OK");
})().catch((err) => { console.error(err); process.exit(1); });
