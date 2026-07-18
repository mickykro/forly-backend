/*
 * Forly Nadlan — session + OTP + action-token crypto (ported from the Cloud
 * Functions path functions/src/nadlan/auth.ts so the standalone VPS server
 * runs the same agent auth as production did on Firebase).
 *
 * Pure helpers only — no DB. The route handlers in index.js supply storage.
 * Session token = base64url({sub,exp}) + "." + HMAC-SHA256, same wire format
 * as the Functions version, so a cookie issued by either is accepted by both.
 */

const crypto = require("crypto");

const SESSION_COOKIE = "fly_session";
const SESSION_TTL_S = 30 * 24 * 60 * 60; // 30 days

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function hmac(data, secret) {
  return b64url(crypto.createHmac("sha256", secret).update(data).digest());
}

function signSession(phone, secret) {
  const payload = b64url(Buffer.from(JSON.stringify({
    sub: phone,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
  }), "utf8"));
  return `${payload}.${hmac(payload, secret)}`;
}

function verifySession(token, secret) {
  const dot = String(token || "").lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    if (!parsed.sub || !parsed.exp || parsed.exp * 1000 < Date.now()) return null;
    return parsed.sub;
  } catch {
    return null;
  }
}

/** Extract the authenticated agent phone from the session cookie, or null. */
function requireAuth(req, secret) {
  if (!secret) return null;
  const cookies = String(req.headers.cookie || "");
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  return verifySession(match[1], secret);
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_S}; Path=/`;
}

/** One-tap action token (e.g. WhatsApp extend links). Self-invalidating when
 *  bound to a value the action changes (like expires_at). */
function signActionToken(parts, secret) {
  return hmac(parts.join(":"), secret);
}
function verifyActionToken(parts, token, secret) {
  const expected = signActionToken(parts, secret);
  const a = Buffer.from(String(token || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashCode(code, secret) {
  return crypto.createHash("sha256").update(code + secret).digest("hex");
}

module.exports = {
  SESSION_COOKIE, SESSION_TTL_S,
  signSession, verifySession, requireAuth, sessionCookie,
  signActionToken, verifyActionToken, hashCode,
};
