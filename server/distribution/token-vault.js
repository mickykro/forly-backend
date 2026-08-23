/*
 * distribution/token-vault.js — Meta tokens encrypted at rest.
 *
 * Firestore client access is already denied globally, but a Firestore export,
 * backup, or console screenshot would still expose page tokens in plaintext.
 * With META_TOKEN_KEY set (32 bytes: `openssl rand -hex 32`), the connection's
 * token fields are sealed with AES-256-GCM before persistence and opened on
 * read.
 *
 * Migration-friendly by design:
 *  - plaintext values pass through decrypt unchanged (rows written before the
 *    key existed keep working; they get sealed on the next reconnect);
 *  - an encrypted value read WITHOUT a key decrypts to null → the publisher
 *    treats the agent as not-connected instead of posting garbage;
 *  - a dedicated key, never the session-cookie HMAC secret.
 */

const crypto = require("crypto");

const PREFIX = "enc:v1:";
const TOKEN_FIELDS = ["user_token", "page_token"];

function keyFrom(env) {
  const raw = String(((env || process.env).META_TOKEN_KEY) || "").trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;
  // Any other string still yields a stable 32-byte key.
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(plain, key) {
  if (plain == null || !key) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

function decrypt(value, key) {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return value;
  if (!key) return null;
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), "base64url");
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch { return null; }
}

// Seal a connection patch before persistence (idempotent — already-sealed
// values are left alone). pending_pages carries page tokens too.
function sealConnection(patch, key) {
  if (!patch || !key) return patch;
  const out = { ...patch };
  for (const f of TOKEN_FIELDS) {
    if (typeof out[f] === "string" && !out[f].startsWith(PREFIX)) {
      out[f] = encrypt(out[f], key);
    }
  }
  if (Array.isArray(out.pending_pages)) {
    out.pending_pages = out.pending_pages.map((p) => ({
      ...p,
      access_token: (typeof p.access_token === "string" && !p.access_token.startsWith(PREFIX))
        ? encrypt(p.access_token, key) : p.access_token,
    }));
  }
  return out;
}

function openConnection(conn, key) {
  if (!conn) return conn;
  const out = { ...conn };
  for (const f of TOKEN_FIELDS) out[f] = decrypt(out[f], key);
  if (Array.isArray(out.pending_pages)) {
    out.pending_pages = out.pending_pages.map((p) => ({
      ...p, access_token: decrypt(p.access_token, key),
    }));
  }
  return out;
}

module.exports = { PREFIX, keyFrom, encrypt, decrypt, sealConnection, openConnection };
