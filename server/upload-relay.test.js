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
const {
  resolveAuthSecret, resolveRemoteUploadBase, relayHeaders, relayUpload,
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

  // ── only credentials are forwarded, nothing else ──
  const req = { headers: { cookie: "forly_session=abc", authorization: "Bearer t", "x-demo-key": "k", host: "h" } };
  assert.deepStrictEqual(relayHeaders(req), { cookie: "forly_session=abc", authorization: "Bearer t" });
  assert.deepStrictEqual(relayHeaders({ headers: {} }), {});

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

  console.log("upload-relay.test.js OK");
})().catch((err) => { console.error(err); process.exit(1); });
