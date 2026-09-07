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

// resolveRemoteUploadBase({ raw, secretEphemeral }) → { base, reason }
// base is "" (relay off, store locally) when nothing is configured OR the
// session secret is ephemeral (the remote could never validate our cookie).
function resolveRemoteUploadBase({ raw, secretEphemeral }) {
  const base = String(raw || "").trim().replace(/\/+$/, "");
  if (!base) return { base: "", reason: null };
  if (secretEphemeral) {
    return {
      base: "",
      reason: "REMOTE_UPLOAD_BASE is set but NADLAN_JWT_SECRET is not — the remote " +
        "cannot validate relayed sessions, so uploads are stored locally instead.",
    };
  }
  return { base, reason: null };
}

// Forward only the caller's credentials — never arbitrary headers.
function relayHeaders(req) {
  const h = {};
  if (req.headers.cookie) h.cookie = req.headers.cookie;
  if (req.headers.authorization) h.authorization = req.headers.authorization;
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

module.exports = { PLACEHOLDER_SECRETS, resolveAuthSecret, resolveRemoteUploadBase, relayHeaders, relayUpload };
