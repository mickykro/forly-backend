// The landing templates validate the lead phone in the browser so a visitor is
// told about a bad number instead of losing the lead to a silent 400. That
// client-side copy only helps while it agrees with the server — this pins them
// together by running the actual source of both over the same inputs.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { normalizePhone } = require("./utils");

const src = fs.readFileSync(path.join(__dirname, "..", "public-nadlan", "templates", "runtime.js"), "utf8");
const fn = /function normalizePhone\(raw\) \{[\s\S]*?\n  \}/.exec(src);
assert.ok(fn, "runtime.js no longer defines normalizePhone — did the lead form stop validating?");
const clientNormalize = new Function(fn[0] + "; return normalizePhone;")();

const CASES = [
  "0501234567", "050-123-4567", "+972 50 123 4567", "972501234567", "501234567",
  "05012345678", "0301234567", "1234", "", "not a phone", "05012345",
];
for (const raw of CASES) {
  assert.strictEqual(clientNormalize(raw), normalizePhone(raw), `client/server disagree on ${JSON.stringify(raw)}`);
}
assert.strictEqual(clientNormalize("050-123-4567"), "972501234567");
assert.strictEqual(clientNormalize("0301234567"), null);

console.log("lead-phone: all tests passed");
