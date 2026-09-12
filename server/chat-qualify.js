/*
 * chat-qualify.js — the three qualification fields on the chat lead form:
 * budget (required), timeline and financing (optional selects).
 *
 * Pure functions, no I/O. The model prompt never sees these — asking happens
 * in the form, so the bot cannot be talked out of it and cannot mis-parse a
 * number. Unit-tested in chat-qualify.test.js.
 */

const MAX_BUDGET = 1000000000;

const TIMELINE_LABELS = {
  now: "מיידי",
  "1_3m": "1-3 חודשים",
  "3_6m": "3-6 חודשים",
  "6m_plus": "מעל חצי שנה",
  looking: "רק מתעניין/ת",
};

const FINANCING_LABELS = {
  mortgage: "צריך/ה משכנתא",
  pre_approved: "יש אישור עקרוני",
  cash: "הון עצמי מלא",
  selling_first: "מוכר/ת נכס קודם",
  unsure: "עדיין לא ברור",
};

const money = (n) => "₪" + Number(n).toLocaleString("en-US");

// Budget arrives as a number or as typed text ("2,300,000"). Keep digits only,
// then require a positive integer within the cap. Anything else is a 400 —
// budget is the one required field, and matching is meaningless without it.
function parseBudget(raw) {
  if (raw == null) return null;
  const str = String(raw);
  if (str.includes("-")) return null;
  const digits = str.replace(/[^\d.]/g, "");
  const n = Math.floor(Number(digits));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_BUDGET) return null;
  return n;
}

// Unknown enum values become null rather than rejecting: a stale widget or a
// hand-crafted request must not lose a lead over an optional field.
const pickEnum = (raw, labels) =>
  (typeof raw === "string" && Object.prototype.hasOwnProperty.call(labels, raw)) ? raw : null;

function parseQualification(body) {
  const b = body || {};
  const budget = parseBudget(b.budget);
  if (budget === null) return { ok: false, error: "invalid_budget" };
  return {
    ok: true,
    value: {
      budget,
      timeline: pickEnum(b.timeline, TIMELINE_LABELS),
      financing: pickEnum(b.financing, FINANCING_LABELS),
    },
  };
}

/*
 * The proactive offer: exactly once, on the Nth answered turn, and only when
 * no form has been shown by any path. Exactly N (not ≥ N) so a visitor who
 * ignores it is never nagged on every later turn.
 */
function shouldOfferForm(convo, limits, answered) {
  const n = Number(limits && limits.offer_form_after_msgs);
  if (!answered || !Number.isFinite(n) || n <= 0) return false;
  const c = convo || {};
  if (c.form_offered) return false;
  if (c.lead && c.lead.captured) return false;
  if (c.handoff && c.handoff.triggered) return false;
  return Number(c.message_count) === n;
}

// Hebrew lines for the agent's WhatsApp. Rent budgets are monthly.
function qualificationLines(q, listingType) {
  if (!q || !(Number(q.budget) > 0)) return [];
  const out = [`💰 תקציב: ${money(q.budget)}${listingType === "rent" ? " לחודש" : ""}`];
  if (q.timeline && TIMELINE_LABELS[q.timeline]) out.push(`🗓 לוח זמנים: ${TIMELINE_LABELS[q.timeline]}`);
  if (q.financing && FINANCING_LABELS[q.financing]) out.push(`🏦 מימון: ${FINANCING_LABELS[q.financing]}`);
  return out;
}

module.exports = {
  MAX_BUDGET, TIMELINE_LABELS, FINANCING_LABELS,
  parseQualification, shouldOfferForm, qualificationLines,
};
