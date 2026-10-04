const assert = require("assert");
const L = require("./posting-local");

const good = {
  FORLY_ENV: "local", POSTING_LOCAL_TEST: "1", POSTING_SWEEPER: "1",
  POSTING_ENABLED: "1", DRIVER_DEV_VIEW: "1",
};

assert.equal(L.problem({}), null, "ordinary runs are unaffected");
assert.equal(L.enabled({}), false);
assert.equal(L.problem(good), null);
assert.equal(L.enabled(good), true);
assert.equal(L.requireApproval(good), true);
assert.equal(L.skipWarmup(good), true);
assert.equal(L.sessionPreflightSeconds(good), 20);
assert.equal(L.sessionPreflightSeconds({ ...good, POSTING_LOCAL_PREFLIGHT_SECONDS: "45" }), 45);
assert.equal(L.sessionPreflightSeconds({ ...good, POSTING_LOCAL_PREFLIGHT_SECONDS: "0" }), 0);
assert.equal(L.sessionPreflightSeconds({}), 0);

for (const env of [
  { ...good, FORLY_ENV: "prod" },
  { ...good, FORLY_ENV: "staging" },
  { ...good, NODE_ENV: "production" },
  { ...good, POSTING_SWEEPER: "0" },
  { ...good, POSTING_ENABLED: "0" },
  { ...good, DRIVER_DEV_VIEW: "0" },
  { ...good, POSTING_LOCAL_PREFLIGHT_SECONDS: "-1" },
  { ...good, POSTING_LOCAL_PREFLIGHT_SECONDS: "91" },
  { ...good, POSTING_LOCAL_PREFLIGHT_SECONDS: "1.5" },
  { ...good, POSTING_LOCAL_PREFLIGHT_SECONDS: "abc" },
]) {
  assert.ok(L.problem(env), JSON.stringify(env));
  assert.equal(L.enabled(env), false);
}

console.log("posting-local.test.js ok");
