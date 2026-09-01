/*
 * login-leads.js — decide whether a "not a client yet" OTP attempt should be
 * forwarded to sales, and what to persist to login_leads/{phone}.
 *
 * Self-service signup is gone from the login screen (see the GitHub issue
 * this shipped with) — a phone with no businesses/{phone} doc is a sales
 * lead now, not a dead end. Kept separate from auth.js so the cooldown and
 * document shape are a pure function, testable without Express or Firestore
 * (login-leads.test.js).
 */

// One WhatsApp ping to sales per number per day — the OTP route runs this on
// every attempt, and a phone (or a script) hammering /otp must not turn into
// a flood on a real person's WhatsApp.
const NOTICE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function asMillis(v) {
  if (!v) return 0;
  return (v.toDate ? v.toDate() : new Date(v)).getTime();
}

/*
 * `prev` is the existing login_leads/{phone} doc, or null on a first sighting.
 * Returns { notify, doc }: `doc` is always what to persist for this attempt,
 * `notify` says whether to also message sales this time.
 */
function decideLoginLead(prev, now) {
  const attempts = (prev && prev.attempts) || 0;
  const lastNotifiedAt = asMillis(prev && prev.last_notified_at);
  const notify = !lastNotifiedAt || now.getTime() - lastNotifiedAt >= NOTICE_COOLDOWN_MS;
  return {
    notify,
    doc: {
      first_seen_at: (prev && prev.first_seen_at) || now,
      last_seen_at: now,
      last_notified_at: notify ? now : (prev && prev.last_notified_at) || now,
      attempts: attempts + 1,
    },
  };
}

function leadMessage(phone) {
  return `🔔 ליד חדש: מספר ניסה להתחבר לפורלי ואינו רשום כלקוח\n${phone}\nhttps://wa.me/${phone}`;
}

module.exports = { NOTICE_COOLDOWN_MS, decideLoginLead, leadMessage };
