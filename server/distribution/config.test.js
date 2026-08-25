/*
 * Unit tests for distribution/config.js — entitlement precedence.
 * Run: node server/distribution/config.test.js
 */
const assert = require("assert");
const { globallyEnabled, resolve } = require("./config");

// ── global kill switch: absent ⇒ on, only the literal "false" turns it off ──
assert.equal(globallyEnabled({}), true, "absent ⇒ on, no env required");
assert.equal(globallyEnabled({ DISTRIBUTION_ENABLED: "true" }), true);
assert.equal(globallyEnabled({ DISTRIBUTION_ENABLED: "false" }), false);
assert.equal(globallyEnabled({ DISTRIBUTION_ENABLED: " FALSE " }), false);

// ── per-agent flag, resolved live from the business doc ──
const ON = { features: { distribution: true } };
const OFF = { features: { distribution: false } };
assert.deepEqual(resolve(ON, {}), { enabled: true, reason: "agent_on" });
assert.deepEqual(resolve(OFF, {}), { enabled: false, reason: "agent_off" });
assert.deepEqual(resolve({}, {}), { enabled: false, reason: "agent_off" });
assert.equal(resolve(null, {}).enabled, false, "no business ⇒ off, not a crash");

// ── the kill switch outranks the agent flag ──
const off = { DISTRIBUTION_ENABLED: "false" };
assert.deepEqual(resolve(ON, off), { enabled: false, reason: "global_off" });

console.log("config.test.js OK");
