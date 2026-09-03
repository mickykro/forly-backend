/*
 * Unit tests for login-leads.js — the "not a client yet" OTP lead decision.
 * Pure functions only: no Express, no Firestore, no network.
 * Run: node server/login-leads.test.js
 */
const assert = require("assert");
const { NOTICE_COOLDOWN_MS, decideLoginLead, leadMessage } = require("./login-leads");

const T0 = new Date("2026-01-01T00:00:00Z");

// ── first sighting: always notify, attempts starts at 1 ──
{
  const { notify, doc } = decideLoginLead(null, T0);
  assert.equal(notify, true, "a phone seen for the first time must always notify sales");
  assert.equal(doc.attempts, 1);
  assert.equal(doc.first_seen_at, T0);
  assert.equal(doc.last_seen_at, T0);
  assert.equal(doc.last_notified_at, T0);
}

// ── a second attempt seconds later must not re-notify, but must still count ──
{
  const first = decideLoginLead(null, T0).doc;
  const t1 = new Date(T0.getTime() + 5000);
  const { notify, doc } = decideLoginLead(first, t1);
  assert.equal(notify, false, "inside the cooldown window sales must not be pinged again");
  assert.equal(doc.attempts, 2, "the attempt still counts even when not notifying");
  assert.equal(doc.first_seen_at, T0, "first_seen_at is never overwritten");
  assert.equal(doc.last_seen_at, t1, "last_seen_at always advances");
  assert.equal(doc.last_notified_at, first.last_notified_at, "last_notified_at is untouched while in cooldown");
}

// ── the cooldown is pinned at 24h, not just "some duration" ──
assert.equal(NOTICE_COOLDOWN_MS, 24 * 60 * 60 * 1000);

// ── right at the cooldown boundary: still no re-notify ──
{
  const first = decideLoginLead(null, T0).doc;
  const atBoundary = new Date(T0.getTime() + NOTICE_COOLDOWN_MS - 1);
  assert.equal(decideLoginLead(first, atBoundary).notify, false);
}

// ── once the cooldown has fully elapsed, notify again ──
{
  const first = decideLoginLead(null, T0).doc;
  const later = new Date(T0.getTime() + NOTICE_COOLDOWN_MS);
  const { notify, doc } = decideLoginLead(first, later);
  assert.equal(notify, true, "a fresh attempt after the cooldown elapses must notify again");
  assert.equal(doc.attempts, 2);
  assert.equal(doc.last_notified_at, later, "last_notified_at advances on a fresh notify");
  assert.equal(doc.first_seen_at, T0, "first_seen_at survives across cooldown cycles");
}

// ── a Firestore Timestamp-shaped last_notified_at (toDate()) is read correctly ──
{
  const asTimestamp = (d) => ({ toDate: () => d });
  const prev = { attempts: 3, first_seen_at: T0, last_notified_at: asTimestamp(T0) };
  const soon = new Date(T0.getTime() + 1000);
  assert.equal(decideLoginLead(prev, soon).notify, false, "a Timestamp-shaped date must still gate the cooldown");
  const later = new Date(T0.getTime() + NOTICE_COOLDOWN_MS + 1);
  assert.equal(decideLoginLead(prev, later).notify, true);
}

// ── message content: carries the number and a tappable wa.me link ──
{
  const msg = leadMessage("972501234567");
  assert.ok(msg.includes("972501234567"));
  assert.ok(msg.includes("https://wa.me/972501234567"));
}

console.log("login-leads: all tests passed");
