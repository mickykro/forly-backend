/*
 * distribution/config.js — is content distribution on for this agent?
 *
 * Mirrors chatbot-config.js: a per-agent entitlement
 * (businesses/{phone}.features.distribution, resolved live so flipping it
 * covers the agent's whole catalogue) under an env kill-switch. No per-page
 * override — distribution is per-agent by design (spec §2 "Rollout").
 *
 * Pure functions — no I/O. Unit-tested in config.test.js.
 */

// The global kill switch stays in the environment, not the database: it
// answers "stop all posting right now" even when Firestore is the problem.
// Absent ⇒ on, so no env var is required.
function globallyEnabled(env) {
  return String((env || {}).DISTRIBUTION_ENABLED || "").trim().toLowerCase() !== "false";
}

function resolve(business, env) {
  if (!globallyEnabled(env)) return { enabled: false, reason: "global_off" };
  const on = !!(business && business.features && business.features.distribution);
  return { enabled: on, reason: on ? "agent_on" : "agent_off" };
}

module.exports = { globallyEnabled, resolve };
