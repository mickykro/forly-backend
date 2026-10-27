const assert = require("node:assert/strict");
const { readConfig } = require("./config");
assert.equal(readConfig({}).enabled, false);
assert.throws(
  () => readConfig({ OUTREACH_ENABLED: "true" }),
  /OUTREACH_HMAC_SECRET/,
);
const env = {
  OUTREACH_ENABLED: "true",
  OUTREACH_HMAC_SECRET: "a".repeat(32),
  OUTREACH_POLICY_APPROVED: "true",
  FORLY_ENV: "staging",
  CALLBACK_HMAC_SECRET: "b".repeat(32),
  BASE_URL: "https://staging.example",
  GOOGLE_CLOUD_PROJECT: "production",
  OUTREACH_FIREBASE_PROJECT: "staging",
  OUTREACH_PRODUCTION_PROJECT: "production",
};
assert.throws(() => readConfig(env), /isolated/);
assert.equal(
  readConfig({ ...env, GOOGLE_CLOUD_PROJECT: "staging" }).enabled,
  true,
);
assert.throws(
  () =>
    readConfig({
      ...env,
      GOOGLE_CLOUD_PROJECT: "staging",
      OUTREACH_PRIVATE_DIR: "/tmp/uploads/private",
      UPLOAD_DIR: "/tmp/uploads",
    }),
  /outside/,
);
console.log("outreach config tests passed");
assert.throws(
  () =>
    readConfig({
      OUTREACH_ENABLED: "true",
      OUTREACH_HMAC_SECRET: "x".repeat(32),
      CALLBACK_HMAC_SECRET: "y".repeat(32),
      BASE_URL: "https://example.test",
      OUTREACH_PRIVATE_DIR: require("node:path").resolve(
        __dirname,
        "../../public-agent/private",
      ),
    }),
  /outside/,
);
assert.equal(readConfig({}).groupScanEnabled, false);
assert.equal(
  readConfig({ OUTREACH_GROUP_SCAN_ENABLED: "true" }).groupScanEnabled,
  true,
);
