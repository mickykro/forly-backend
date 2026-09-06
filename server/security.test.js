/*
 * security.test.js — regressions for the security hardening:
 *   SSRF guard, upload content sniffing, constant-time compare, rate limiter,
 *   and the admin allowlist guard.
 * Plain-node test (no framework), matching the rest of server/*.test.js.
 */

const assert = require("assert");
const { assertPublicHttpUrl, sniffMatchesExt } = require("./utils");
const { constantTimeEqual, rateLimit } = require("./security");
const { makeAdminGuard } = require("./admin-auth");

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

  console.log("security.test.js OK");
})().catch((err) => { console.error(err); process.exit(1); });
