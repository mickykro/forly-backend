/*
 * Unit tests for chat-qualify.js — form validation, the proactive offer
 * decision, and the Hebrew lines the agent sees.
 * Run: node server/chat-qualify.test.js
 */
const assert = require("assert");
const {
  parseQualification, shouldOfferForm, qualificationLines,
  TIMELINE_LABELS, FINANCING_LABELS, MAX_BUDGET,
} = require("./chat-qualify");

// ── parseQualification: budget ──
assert.deepEqual(parseQualification({ budget: 2300000 }).value,
  { budget: 2300000, timeline: null, financing: null });
assert.equal(parseQualification({ budget: "2,300,000" }).value.budget, 2300000, "digits-only coercion");
assert.equal(parseQualification({ budget: " 6000 " }).value.budget, 6000);
assert.equal(parseQualification({ budget: 2300000.7 }).value.budget, 2300000, "floors");
assert.equal(parseQualification({}).ok, false);
assert.equal(parseQualification({}).error, "invalid_budget");
assert.equal(parseQualification({ budget: 0 }).ok, false);
assert.equal(parseQualification({ budget: -5 }).ok, false);
assert.equal(parseQualification({ budget: "abc" }).ok, false);
assert.equal(parseQualification({ budget: MAX_BUDGET + 1 }).ok, false);
assert.equal(parseQualification({ budget: MAX_BUDGET }).ok, true);

// ── parseQualification: enums normalised, unknowns become null, never reject ──
let q = parseQualification({ budget: 1, timeline: "1_3m", financing: "cash" }).value;
assert.equal(q.timeline, "1_3m");
assert.equal(q.financing, "cash");
q = parseQualification({ budget: 1, timeline: "soon", financing: 42 }).value;
assert.equal(q.timeline, null);
assert.equal(q.financing, null);
for (const k of Object.keys(TIMELINE_LABELS)) assert.equal(parseQualification({ budget: 1, timeline: k }).value.timeline, k);
for (const k of Object.keys(FINANCING_LABELS)) assert.equal(parseQualification({ budget: 1, financing: k }).value.financing, k);

// ── shouldOfferForm ──
const lim = { offer_form_after_msgs: 3 };
const base = () => ({ message_count: 3, lead: { captured: false }, handoff: { triggered: false }, form_offered: false });
assert.equal(shouldOfferForm(base(), lim, true), true, "3rd answered turn ⇒ offer");
assert.equal(shouldOfferForm({ ...base(), message_count: 2 }, lim, true), false, "too early");
assert.equal(shouldOfferForm({ ...base(), message_count: 4 }, lim, true), false, "only exactly at N — never nags");
assert.equal(shouldOfferForm(base(), lim, false), false, "unanswered turn is the handoff path, not the offer");
assert.equal(shouldOfferForm({ ...base(), form_offered: true }, lim, true), false, "once per conversation");
assert.equal(shouldOfferForm({ ...base(), handoff: { triggered: true } }, lim, true), false, "handoff already showed a form");
assert.equal(shouldOfferForm({ ...base(), lead: { captured: true } }, lim, true), false, "lead already in");
assert.equal(shouldOfferForm({ message_count: 3 }, lim, true), true, "missing fields default safely");
assert.equal(shouldOfferForm(base(), {}, true), false, "no limit ⇒ never offer");

// ── qualificationLines ──
let lines = qualificationLines({ budget: 2300000, timeline: "now", financing: "mortgage" }, "sale");
assert.deepEqual(lines, ["💰 תקציב: ₪2,300,000", "🗓 לוח זמנים: מיידי", "🏦 מימון: צריך/ה משכנתא"]);
lines = qualificationLines({ budget: 6000, timeline: null, financing: null }, "rent");
assert.deepEqual(lines, ["💰 תקציב: ₪6,000 לחודש"]);
assert.deepEqual(qualificationLines(null, "sale"), []);
assert.deepEqual(qualificationLines({ budget: 0 }, "sale"), []);

console.log("chat-qualify.test.js ✓");
