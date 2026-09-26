/*
 * security.js — dependency-free security middleware.
 *
 * Two pieces the Express app was missing:
 *   securityHeaders  — clickjacking / MIME-sniffing / referrer / HSTS headers.
 *   rateLimit        — small in-memory sliding-window limiter (per key), used to
 *                      throttle abuse-prone endpoints (OTP send/verify).
 *
 * The limiter is per-instance (in-memory). For a single Cloud Run instance that
 * already raises the bar meaningfully; the OTP store in Firestore still enforces
 * per-phone cooldowns and attempt caps as the durable backstop.
 */

// ── security headers ──
// CSP is intentionally limited to frame-ancestors 'self' so it hardens against
// clickjacking WITHOUT breaking the app's existing inline scripts (a full
// script-src policy would need a bigger frontend refactor) or the same-origin
// template-preview iframes on create.html (/tpl/*.html, /previews/*.html).
// X-Frame-Options is kept alongside for older browsers.
function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // Only advertise HSTS when the connection is actually HTTPS (behind the
  // Cloud Run / hosting proxy), never in plain-http local dev.
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  const reqPath = String(req.path || "");
  // The dev browser viewer (routes/dev-driver.js): nothing under it may sit in
  // a cache, and its page does not exist outside a local box (devViewOn).
  if (reqPath.startsWith("/api/dev/")) res.setHeader("Cache-Control", "no-store");
  if (isDevDriverPage(reqPath) && !require("./driver-browser").devViewOn(process.env)) {
    return res.status(404).type("text/plain").send("Not Found");
  }
  next();
}

// Matched the way express.static would resolve it (decoded, normalized, and
// case-folded for case-insensitive dev filesystems), so /dev%2Ddriver.html or
// //DEV-DRIVER.html cannot walk around the check.
function isDevDriverPage(reqPath) {
  let decoded;
  try { decoded = decodeURIComponent(reqPath); } catch (e) { decoded = reqPath; }
  const posix = require("path").posix;
  return posix.basename(posix.normalize(decoded)).toLowerCase() === "dev-driver.html";
}

// ── in-memory rate limiter ──
function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.ip || req.socket?.remoteAddress || "unknown";
}

// rateLimit({ windowMs, max, keyBy? }) → express middleware.
// Returns 429 with Retry-After once a key exceeds `max` hits inside `windowMs`.
function rateLimit({ windowMs = 60_000, max = 30, keyBy = clientIp } = {}) {
  const hits = new Map(); // key → number[] (hit timestamps)
  // Opportunistic sweep so the map can't grow unbounded.
  let lastSweep = Date.now();
  const sweep = (now) => {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, arr] of hits) {
      const live = arr.filter((t) => now - t < windowMs);
      if (live.length) hits.set(k, live); else hits.delete(k);
    }
  };
  return function rateLimiter(req, res, next) {
    const now = Date.now();
    sweep(now);
    const key = keyBy(req);
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      const retry = Math.ceil((windowMs - (now - arr[0])) / 1000);
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json({ error: "rate_limited", retry_after: retry });
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

// Constant-time string comparison for secrets/tokens (avoids leaking length
// match progress via early-exit `===`). Returns false on any length mismatch.
function constantTimeEqual(a, b) {
  const crypto = require("crypto");
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { securityHeaders, rateLimit, clientIp, constantTimeEqual };
