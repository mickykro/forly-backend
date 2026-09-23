/*
 * upload-relay.js — pure helpers for the REMOTE_UPLOAD_BASE relay.
 *
 * When this server fronts a remote file store it forwards the caller's own
 * session so the remote (running this same code) re-authorizes the write.
 * That only works when BOTH instances sign sessions with the same
 * NADLAN_JWT_SECRET. A dev box without a real secret signs with an ephemeral
 * random key, so every relayed request would come back 401 and surface to the
 * browser as "502 remote upload failed: 401". These helpers make that
 * impossible: the relay is disabled (files stay local) unless a real shared
 * secret is configured, and a rejected relay says why.
 *
 * No Express here so upload-relay.test.js runs with no npm install.
 */

const PLACEHOLDER_SECRETS = new Set(["", "change-me-in-env", "changeme", "secret"]);

// resolveAuthSecret(env) → { secret, ephemeral }
// NADLAN_JWT_SECRET is canonical; FORLY_JWT_SECRET accepted for back-compat.
// Caller decides what to do in production (index.js refuses to boot).
function resolveAuthSecret(env, randomSecret) {
  const raw = String(env.NADLAN_JWT_SECRET || env.FORLY_JWT_SECRET || "").trim();
  if (!PLACEHOLDER_SECRETS.has(raw)) return { secret: raw, ephemeral: false };
  return { secret: randomSecret(), ephemeral: true };
}

// resolveRemoteUploadBase({ raw, secretEphemeral, selfBase }) → { base, reason }
// base is "" (relay off, store locally) when nothing is configured, when the
// session secret is ephemeral (the remote could never validate our cookie), or
// when the configured remote IS this instance.
function resolveRemoteUploadBase({ raw, secretEphemeral, selfBase }) {
  const base = String(raw || "").trim().replace(/\/+$/, "");
  if (!base) return { base: "", reason: null };
  if (secretEphemeral) {
    return {
      base: "",
      reason: "REMOTE_UPLOAD_BASE is set but NADLAN_JWT_SECRET is not — the remote " +
        "cannot validate relayed sessions, so uploads are stored locally instead.",
    };
  }
  // Pointing an instance at itself makes every upload a request to itself,
  // which either loops or deadlocks the single-threaded event loop under load.
  // Cheap to misconfigure (copying staging's env onto staging), so refuse it.
  const self = String(selfBase || "").trim().replace(/\/+$/, "");
  if (self && base.toLowerCase() === self.toLowerCase()) {
    return {
      base: "",
      reason: `REMOTE_UPLOAD_BASE (${base}) is this instance's own BASE_URL — ` +
        "an instance cannot relay to itself; uploads are stored locally instead.",
    };
  }
  return { base, reason: null };
}

// The parts an upload token is HMAC'd over. Defined once so the signer
// (routes/pages.js, rehosting page media) and the verifier (routes/intake.js)
// cannot drift apart — if they did, every relayed upload would 401 and the
// cause would look like a secret mismatch rather than a scope mismatch.
// Including the filename is the point: a token authorizes ONE upload of ONE
// name, so a leaked one cannot be replayed against anything else.
const uploadTokenParts = (fname) => ["upload", String(fname || "")];

// Forward only the caller's credentials — never arbitrary headers.
// x-upload-token is the server-to-server case: a relay started by an
// UNauthenticated route (createPropertyPage, which n8n calls with no session)
// has no cookie to forward, so it signs a token bound to the one filename it
// is uploading. See routes/intake.js for the verifying side.
function relayHeaders(req) {
  const h = {};
  if (req.headers.cookie) h.cookie = req.headers.cookie;
  if (req.headers.authorization) h.authorization = req.headers.authorization;
  if (req.headers["x-upload-token"]) h["x-upload-token"] = req.headers["x-upload-token"];
  return h;
}

// relayUpload({ fetch, base, fname, req, body, contentType }) → { status, body }
// Maps every failure to 502 with a message that names the cause; a remote
// 401/403 is called out explicitly as a secret mismatch so it is not mistaken
// for a network fault.
async function relayUpload({ fetch, base, fname, req, body, contentType, timeoutMs = 120000 }) {
  try {
    const r = await fetch(`${base}/api/upload/${fname}`, {
      method: "PUT",
      headers: { ...relayHeaders(req), "Content-Type": contentType || "application/octet-stream" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.ok) return { status: 200, body: { ok: true, remote: true } };
    if (r.status === 401 || r.status === 403) {
      return { status: 502, body: { error: `remote upload failed: ${r.status} — relayed session rejected ` +
        "(NADLAN_JWT_SECRET must match the remote instance)" } };
    }
    return { status: 502, body: { error: `remote upload failed: ${r.status}` } };
  } catch (err) {
    return { status: 502, body: { error: `remote upload failed: ${err.message}` } };
  }
}

module.exports = {
  PLACEHOLDER_SECRETS, resolveAuthSecret, resolveRemoteUploadBase,
  relayHeaders, relayUpload, uploadTokenParts,
};
