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
// CSP is intentionally limited to frame-ancestors 'none' so it hardens against
// clickjacking WITHOUT breaking the app's existing inline scripts (a full
// script-src policy would need a bigger frontend refactor). X-Frame-Options is
// kept alongside for older browsers.
function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // Only advertise HSTS when the connection is actually HTTPS (behind the
  // Cloud Run / hosting proxy), never in plain-http local dev.
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
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
