/*
 * profile-lock.js — one browser per persisted profile, one process.
 *
 * Extract (a Facebook group URL), the login browser, and posting all open the
 * SAME Driver profile for a phone+platform. Two of them at once means one
 * cookie set live from two IPs — the pattern that gets an account
 * checkpointed. This is the single place that rule is enforced.
 * Single-container deployment, so an in-process map is exact; a second
 * container is a documented non-goal.
 *
 * Keyed by phone+platform (not phone alone): an agent can have a Facebook
 * session and a Yad2 session open at once — different profiles, different
 * Driver browsers, no conflict. Release is owner-bound: `tryAcquire` hands
 * back a token-bound release() so a release that fires after MAX_HOLD_MS has
 * already let someone else in cannot free that new holder's lock.
 *
 * Also the Driver concurrency budget: every session, of any kind, counts.
 */
const crypto = require("crypto");

const held = new Map();          // "phone|platform" → { until, owner }
const MAX_HOLD_MS = 20 * 60 * 1000; // longer than any session we create
let sessions = 0;

const keyFor = (phone, platform) => `${phone}|${platform}`;

function tryAcquire(phone, platform = "facebook") {
  const now = Date.now();
  const k = keyFor(phone, platform);
  const entry = held.get(k);
  if (entry && entry.until > now) return null;
  const owner = crypto.randomBytes(8).toString("hex");
  held.set(k, { until: now + MAX_HOLD_MS, owner });
  return () => {
    const cur = held.get(k);
    if (cur && cur.owner === owner) held.delete(k);
  };
}
function acquire(phone, platform = "facebook") {
  const release = tryAcquire(phone, platform);
  if (!release) { const e = new Error(`profile ${phone}/${platform} is busy`); e.code = "profile_busy"; throw e; }
  return release;
}
function isHeld(phone, platform = "facebook") {
  const entry = held.get(keyFor(phone, platform));
  return !!entry && entry.until > Date.now();
}

const budget = () => Number(process.env.DRIVER_MAX_CONCURRENT || 2);
function trySession() { if (sessions >= budget()) return null; sessions++; return () => { sessions = Math.max(0, sessions - 1); }; }
function activeSessions() { return sessions; }

module.exports = { tryAcquire, acquire, isHeld, trySession, activeSessions, _test: { held, reset: () => { held.clear(); sessions = 0; } } };
