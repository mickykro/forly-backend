/*
 * profile-lock.js — one browser per persisted profile, one process.
 *
 * Extract (a Facebook group URL), the login browser, and posting all open the
 * SAME Driver profile for a phone. Two of them at once means one cookie set
 * live from two IPs — the pattern that gets an account checkpointed. This is
 * the single place that rule is enforced. Single-container deployment, so an
 * in-process map is exact; a second container is a documented non-goal.
 *
 * Also the Driver concurrency budget: every session, of any kind, counts.
 */
const held = new Map();          // phone → expiresAt
const MAX_HOLD_MS = 20 * 60 * 1000; // longer than any session we create
let sessions = 0;

function tryAcquire(phone) {
  const now = Date.now();
  const until = held.get(phone);
  if (until && until > now) return null;
  held.set(phone, now + MAX_HOLD_MS);
  return () => { if (held.get(phone)) held.delete(phone); };
}
function acquire(phone) { const r = tryAcquire(phone); if (!r) throw new Error(`profile ${phone} is busy`); return r; }
function isHeld(phone) { const u = held.get(phone); return !!u && u > Date.now(); }

const budget = () => Number(process.env.DRIVER_MAX_CONCURRENT || 2);
function trySession() { if (sessions >= budget()) return null; sessions++; return () => { sessions = Math.max(0, sessions - 1); }; }
function activeSessions() { return sessions; }

module.exports = { tryAcquire, acquire, isHeld, trySession, activeSessions, _test: { held, reset: () => { held.clear(); sessions = 0; } } };
