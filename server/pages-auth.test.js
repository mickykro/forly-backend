/*
 * Unit tests for page-auth.js — the /api/page/update ownership check.
 * Pure functions only: no Express, no Firestore, no network.
 * Run: node server/pages-auth.test.js
 */
const assert = require("assert");
// from utils, not auth: keeps this test runnable with no npm install, same as
// overlay.test.js. auth.js re-exports the very same function.
const { normalizeAuthPhone } = require("./utils");
const {
  MODE_LOG, MODE_ENFORCE, readMode, normalizeSet, checkPageAccess, denialLog,
} = require("./page-auth");

const norm = normalizeAuthPhone;
const page = (phone) => ({ business_phone: phone, page_id: "p1" });
const session = (phone) => ({ userId: phone, scope: "session" });
const check = (opts) => checkPageAccess({ normalize: norm, adminSet: new Set(), ...opts });

// ── rollout mode: enforce unless "log" is explicitly asked for ──
assert.equal(readMode(undefined), MODE_ENFORCE);
assert.equal(readMode(""), MODE_ENFORCE);
assert.equal(readMode("enforce"), MODE_ENFORCE);
assert.equal(readMode("nonsense"), MODE_ENFORCE, "an unrecognised value must not open the endpoint");
assert.equal(readMode("log"), MODE_LOG);
assert.equal(readMode("  LOG  "), MODE_LOG);

// ── no session ⇒ 401 ──
let v = check({ session: null, page: page("972501234567") });
assert.equal(v.ok, false);
assert.equal(v.status, 401);
assert.equal(v.error, "unauthenticated");

v = check({ session: {}, page: page("972501234567") });
assert.equal(v.status, 401, "a session without a userId is not a session");

// ── missing page ⇒ 404, and never leaks as a 403 ──
v = check({ session: session("972501234567"), page: null });
assert.equal(v.status, 404);

// ── owner match ──
v = check({ session: session("972501234567"), page: page("972501234567") });
assert.equal(v.ok, true);
assert.equal(v.via, "owner");

// ── owner match across differing phone formats. This is the regression the
//    whole normalize step exists for: a raw string compare 403s the real owner.
const SAME = ["972501234567", "0501234567", "+972-50-123-4567", "00972501234567", "501234567"];
for (const a of SAME) {
  for (const b of SAME) {
    assert.equal(
      check({ session: session(a), page: page(b) }).ok, true,
      `owner ${a} must be able to edit a page stored as ${b}`
    );
  }
}

// ── different agent ⇒ 403 ──
v = check({ session: session("972501234567"), page: page("972529998888") });
assert.equal(v.ok, false);
assert.equal(v.status, 403);
assert.equal(v.error, "not_owner");
assert.equal(v.reason, "phone_mismatch");

// ── admin bypass, also format-insensitive ──
const admins = normalizeSet(["052-999-8888", "+972521112222"], norm);
assert.equal(admins.has("972529998888"), true);
assert.equal(admins.has("972521112222"), true);

v = checkPageAccess({
  session: session("0529998888"), page: page("972501234567"),
  adminSet: admins, normalize: norm,
});
assert.equal(v.ok, true);
assert.equal(v.via, "admin");

// a non-admin, non-owner is still refused even when an allowlist exists
v = checkPageAccess({
  session: session("972537776666"), page: page("972501234567"),
  adminSet: admins, normalize: norm,
});
assert.equal(v.status, 403);

// ── fail closed on a page with no owner recorded ──
v = check({ session: session("972501234567"), page: page("") });
assert.equal(v.ok, false);
assert.equal(v.status, 403);
assert.equal(v.reason, "page_has_no_owner");

// ── unparsable caller ⇒ 401, not a crash and not a pass ──
v = check({ session: session("abc"), page: page("972501234567") });
assert.equal(v.status, 401);
assert.equal(v.reason, "unparsable_caller");

// ── log line carries what an operator needs, and no secrets ──
v = check({ session: session("972501234567"), page: page("972529998888") });
const line = denialLog("p1", v, MODE_LOG);
assert.ok(line.includes("page=p1"));
assert.ok(line.includes("reason=phone_mismatch"));
assert.ok(line.includes("mode=log"));
assert.ok(!line.includes("scope"), "the session object must not be dumped into logs");

console.log("page-auth: all tests passed");
