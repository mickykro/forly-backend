/*
 * Unit tests for chatbot-config.js — the enable/disable precedence.
 * Run: node server/chatbot-config.test.js
 */
const assert = require("assert");
const { DEFAULTS, DEMO_MONTHLY_CAP, resolve, adminState, globallyEnabled } = require("./chatbot-config");

const ON = { features: { chatbot: true } };
const OFF = { features: { chatbot: false } };
const NONE = {};                               // agent with no features map at all
const page = (enabled) => (enabled === undefined ? {} : { chatbot: { enabled } });
const r = (p, b, env) => resolve(p, b, env || {});

// ── global kill switch ──
assert.equal(globallyEnabled({}), true, "absent ⇒ on, so no env is required");
assert.equal(globallyEnabled({ CHATBOT_ENABLED: "true" }), true);
assert.equal(globallyEnabled({ CHATBOT_ENABLED: "yes" }), true);
assert.equal(globallyEnabled({ CHATBOT_ENABLED: "false" }), false);
assert.equal(globallyEnabled({ CHATBOT_ENABLED: " FALSE " }), false);

// ── the agent flag drives every page that doesn't override ──
assert.equal(r(page(), ON).enabled, true);
assert.equal(r(page(), ON).reason, "agent_on");
assert.equal(r(page(), OFF).enabled, false);
assert.equal(r(page(), NONE).enabled, false);
assert.equal(r(page(), null).enabled, false, "no business ⇒ off, not a crash");
assert.equal(r(page(), NONE).reason, "agent_off");

// ── explicit null on the page still means inherit ──
assert.equal(r(page(null), ON).enabled, true);
assert.equal(r(page(null), OFF).enabled, false);

// ── the two cases the user actually asked for ──
// "just some pages" for an agent who is on:
assert.equal(r(page(false), ON).enabled, false, "page off must beat agent on");
assert.equal(r(page(false), ON).reason, "page_off");
// piloting one page for an agent who is not entitled:
assert.equal(r(page(true), OFF).enabled, true, "page on must beat agent off");
assert.equal(r(page(true), NONE).enabled, true);
assert.equal(r(page(true), NONE).reason, "page_on");

// ── the kill switch outranks both ──
const off = { CHATBOT_ENABLED: "false" };
assert.equal(r(page(true), ON, off).enabled, false);
assert.equal(r(page(true), ON, off).reason, "global_off");

// ── the public half must never carry server-only settings ──
const pub = r(page(true), ON).public;
assert.deepEqual(Object.keys(pub).sort(), ["enabled", "greeting"]);
assert.equal(pub.model, undefined);
assert.equal(pub.limits, undefined);

// ── settings fall back page → business → constant ──
assert.equal(r(page(), ON).model, DEFAULTS.model);
assert.equal(r({ chatbot: { model: "page-model" } }, ON).model, "page-model");
assert.equal(r(page(), { features: { chatbot: true }, chatbot_defaults: { model: "biz-model" } }).model, "biz-model");
assert.equal(
  r({ chatbot: { model: "page-model" } },
    { features: { chatbot: true }, chatbot_defaults: { model: "biz-model" } }).model,
  "page-model", "the page wins over the business"
);
assert.equal(r(page(), ON).limits.max_msgs_per_convo, DEFAULTS.limits.max_msgs_per_convo);
assert.equal(r({ chatbot: { limits: { max_msgs_per_convo: 2 } } }, ON).limits.max_msgs_per_convo, 2);
assert.equal(
  r({ chatbot: { limits: { max_msgs_per_convo: 2 } } }, ON).limits.max_msgs_per_ip_hour,
  DEFAULTS.limits.max_msgs_per_ip_hour,
  "overriding one limit must not drop the others"
);
assert.equal(r(page(), { features: { chatbot: true }, chatbot_defaults: { greeting: "היי" } }).public.greeting, "היי");
assert.equal(r(page(), ON).public.greeting, null);

// ── demo accounts get a tighter monthly cap, unless one was set explicitly ──
const demo = { features: { chatbot: true }, source: "demo" };
assert.equal(r(page(), demo).limits.max_msgs_per_agent_month, DEMO_MONTHLY_CAP);
assert.equal(r(page(), { features: { chatbot: true }, onboarding_state: "demo_partial" })
  .limits.max_msgs_per_agent_month, DEMO_MONTHLY_CAP);
assert.equal(r(page(), ON).limits.max_msgs_per_agent_month, DEFAULTS.limits.max_msgs_per_agent_month);
assert.equal(
  r({ chatbot: { limits: { max_msgs_per_agent_month: 9000 } } }, demo).limits.max_msgs_per_agent_month,
  9000, "an explicit cap beats the demo default"
);

// ── adminState: what the selector renders from ──
assert.deepEqual(adminState(page(), ON, {}), { page: null, effective: true, reason: "agent_on" });
assert.deepEqual(adminState(page(false), ON, {}), { page: false, effective: false, reason: "page_off" });
assert.deepEqual(adminState(page(true), OFF, {}), { page: true, effective: true, reason: "page_on" });
assert.equal(adminState({ chatbot: {} }, ON, {}).page, null);

console.log("chatbot-config: all tests passed");
