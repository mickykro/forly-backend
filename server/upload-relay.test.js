/*
 * upload-relay.test.js — regressions for the REMOTE_UPLOAD_BASE relay.
 *
 * The security merge made PUT/DELETE /api/upload/:fname forward the caller's
 * session to the remote store. On a dev box with no NADLAN_JWT_SECRET the
 * session is signed with an ephemeral key the remote can't validate, so every
 * upload came back "502 remote upload failed". These tests pin the guards
 * that stop that from recurring. Pure functions — no Express, no network.
 * Run: node server/upload-relay.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const {
  resolveAuthSecret, resolveRemoteUploadBase, relayHeaders, relayUpload, uploadTokenParts,
} = require("./upload-relay");

(async () => {
  const rnd = () => "random-dev-key";

  // ── secret resolution ──
  assert.deepStrictEqual(resolveAuthSecret({ NADLAN_JWT_SECRET: "  real-secret " }, rnd),
    { secret: "real-secret", ephemeral: false });
  assert.deepStrictEqual(resolveAuthSecret({ FORLY_JWT_SECRET: "legacy" }, rnd),
    { secret: "legacy", ephemeral: false }, "back-compat env var still honoured");
  for (const bad of [undefined, "", "change-me-in-env", "changeme", "secret"]) {
    const r = resolveAuthSecret({ NADLAN_JWT_SECRET: bad }, rnd);
    assert.strictEqual(r.ephemeral, true, `placeholder ${JSON.stringify(bad)} must be ephemeral`);
    assert.strictEqual(r.secret, "random-dev-key");
  }

  // ── relay is OFF unless a real shared secret exists ──
  assert.deepStrictEqual(resolveRemoteUploadBase({ raw: "", secretEphemeral: false }),
    { base: "", reason: null });
  assert.deepStrictEqual(resolveRemoteUploadBase({ raw: "https://store.example.com///", secretEphemeral: false }),
    { base: "https://store.example.com", reason: null }, "trailing slashes stripped");
  const off = resolveRemoteUploadBase({ raw: "https://store.example.com", secretEphemeral: true });
  assert.strictEqual(off.base, "", "ephemeral dev key ⇒ relay disabled, uploads stay local");
  assert.match(off.reason, /NADLAN_JWT_SECRET/);

  // ── an instance must never relay to itself ──
  // Cheap to misconfigure by copying one env file onto another; the result is
  // an instance making upload requests to itself.
  const loop = resolveRemoteUploadBase({
    raw: "https://staging.example.com/", secretEphemeral: false,
    selfBase: "https://staging.example.com",
  });
  assert.strictEqual(loop.base, "", "self-referential relay must be refused");
  assert.match(loop.reason, /own BASE_URL/);
  assert.strictEqual(resolveRemoteUploadBase({
    raw: "https://STAGING.example.com", secretEphemeral: false,
    selfBase: "https://staging.example.com",
  }).base, "", "host comparison is case-insensitive");
  assert.strictEqual(resolveRemoteUploadBase({
    raw: "https://staging.example.com", secretEphemeral: false,
    selfBase: "https://dev.example.com",
  }).base, "https://staging.example.com", "a genuinely remote base still relays");

  // ── only credentials are forwarded, nothing else ──
  const req = { headers: { cookie: "forly_session=abc", authorization: "Bearer t", "x-demo-key": "k", host: "h" } };
  assert.deepStrictEqual(relayHeaders(req), { cookie: "forly_session=abc", authorization: "Bearer t" });
  assert.deepStrictEqual(relayHeaders({ headers: {} }), {});

  // The server-to-server case: a relay started by an unauthenticated route has
  // no cookie, so it signs a token scoped to the one filename it is uploading.
  assert.deepStrictEqual(
    relayHeaders({ headers: { "x-upload-token": "tok", "x-demo-key": "k" } }),
    { "x-upload-token": "tok" }, "upload token forwarded, other headers still dropped");

  // ── relayUpload maps remote outcomes ──
  const calls = [];
  const fakeFetch = (status) => async (url, opts) => { calls.push({ url, opts }); return { ok: status < 300, status }; };
  const args = { base: "https://store.example.com", fname: "a.png", req, body: Buffer.from("x"), contentType: "image/png" };

  let out = await relayUpload({ ...args, fetch: fakeFetch(200) });
  assert.deepStrictEqual(out, { status: 200, body: { ok: true, remote: true } });
  assert.strictEqual(calls[0].url, "https://store.example.com/api/upload/a.png");
  assert.strictEqual(calls[0].opts.method, "PUT");
  assert.strictEqual(calls[0].opts.headers.cookie, "forly_session=abc", "session forwarded to remote");
  assert.strictEqual(calls[0].opts.headers["Content-Type"], "image/png");

  out = await relayUpload({ ...args, fetch: fakeFetch(401) });
  assert.strictEqual(out.status, 502);
  assert.match(out.body.error, /401/);
  assert.match(out.body.error, /NADLAN_JWT_SECRET/, "a rejected session names the secret mismatch");

  out = await relayUpload({ ...args, fetch: fakeFetch(403) });
  assert.match(out.body.error, /NADLAN_JWT_SECRET/);

  out = await relayUpload({ ...args, fetch: fakeFetch(500) });
  assert.deepStrictEqual(out, { status: 502, body: { error: "remote upload failed: 500" } });

  out = await relayUpload({ ...args, fetch: async () => { throw new Error("ECONNREFUSED"); } });
  assert.deepStrictEqual(out, { status: 502, body: { error: "remote upload failed: ECONNREFUSED" } });

  // ── an upload token authorizes ONE name, not uploads in general ──
  // Mirrors auth.js signActionToken/verifyActionToken, replicated here rather
  // than required so this file still runs with no npm install (auth.js pulls in
  // express). The property under test is the SCOPE, not the HMAC.
  const sign = (parts, secret) =>
    crypto.createHmac("sha256", secret).update(parts.join(":")).digest("base64url");
  const verify = (parts, token, secret) => {
    const a = Buffer.from(String(token || ""));
    const b = Buffer.from(sign(parts, secret));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const SECRET = "shared-between-instances";
  const tokenForA = sign(uploadTokenParts("aaaa.jpg"), SECRET);

  assert.ok(verify(uploadTokenParts("aaaa.jpg"), tokenForA, SECRET),
    "a token must authorize the name it was signed for");
  assert.ok(!verify(uploadTokenParts("bbbb.jpg"), tokenForA, SECRET),
    "a token for one file must NOT authorize another — this is the whole point of the scope");
  assert.ok(!verify(uploadTokenParts("aaaa.jpg"), tokenForA, "a-different-secret"),
    "a token signed with another secret must be rejected");
  assert.ok(!verify(uploadTokenParts("aaaa.jpg"), "", SECRET), "empty token rejected");
  assert.ok(!verify(uploadTokenParts("aaaa.jpg"), undefined, SECRET), "missing token rejected");
  // A filename is never absent from the parts, so a token can never be generic.
  assert.deepStrictEqual(uploadTokenParts("x.mp4"), ["upload", "x.mp4"]);
  assert.notDeepStrictEqual(uploadTokenParts("x.mp4"), uploadTokenParts("y.mp4"));

  console.log("upload-relay.test.js OK");
})().catch((err) => { console.error(err); process.exit(1); });
