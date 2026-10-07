/* profile-name.js — HMAC naming, host anchoring, twitter→x, both call shapes
   (a social URL from extract, a bare platform from connections-browser),
   FORLY_ENV validation, the generation suffix, and assertOwnership. */
process.env.FORLY_ENV = "local"; // set AFTER require would still work: read at call time
const assert = require("assert");
const { profileName, assertOwnership, ENV } = require("./profile-name");

process.env.PROFILE_KEY = "k";

// ── URL call shape (extract.js's use) ──
assert.equal(
  profileName("https://www.facebook.com/groups/1", "05x"),
  profileName("https://facebook.com/groups/2", "05x"),
);
assert.ok(/^facebook-local-[0-9a-f]{20}$/.test(profileName("https://www.facebook.com/groups/1", "05x")), "hmac, not the phone, tagged with FORLY_ENV");
assert.equal(
  profileName("https://twitter.com/a/status/1", "05x"),
  profileName("https://x.com/a/status/1", "05x"),
);
assert.equal(profileName("https://netflix.com/x", "05x"), null, "not left-anchored → netflix matched x.com");
assert.equal(profileName("https://evilfacebook.com/x", "05x"), null);
assert.equal(profileName("https://www.yad2.co.il/item/1", "05x"), null, "no profile for non-social hosts");

// ── phone changes the hmac ──
assert.notEqual(profileName("https://facebook.com/x", "05x"), profileName("https://facebook.com/x", "05y"));

// ── PROFILE_KEY changes the hmac ──
process.env.PROFILE_KEY = "k1";
const withK1 = profileName("https://facebook.com/x", "05x");
process.env.PROFILE_KEY = "k2";
const withK2 = profileName("https://facebook.com/x", "05x");
assert.notEqual(withK1, withK2);
process.env.PROFILE_KEY = "k";

// ── bare-platform call shape (connections-browser.js's use) ──
assert.equal(profileName("facebook", "05x"), profileName("https://www.facebook.com/x", "05x"));
assert.equal(profileName("twitter", "05x"), profileName("x", "05x"), "twitter→x here too");

// ── generation suffix ──
assert.ok(/^facebook-local-[0-9a-f]{20}-r1$/.test(profileName("facebook", "05x", 1)));
assert.notEqual(profileName("facebook", "05x", 1), profileName("facebook", "05x"));
assert.equal(profileName("facebook", "05x", 0), profileName("facebook", "05x"), "gen 0 has no suffix");

// ── FORLY_ENV must be prod|staging|local, checked at CALL time ──
for (const bad of [undefined, "", "dev", "production"]) {
  const prev = process.env.FORLY_ENV;
  if (bad === undefined) delete process.env.FORLY_ENV; else process.env.FORLY_ENV = bad;
  assert.throws(() => profileName("facebook", "05x"), /FORLY_ENV must be prod\|staging\|local/);
  process.env.FORLY_ENV = prev;
}
assert.doesNotThrow(() => { process.env.FORLY_ENV = "prod"; profileName("facebook", "05x"); });
assert.doesNotThrow(() => { process.env.FORLY_ENV = "staging"; profileName("facebook", "05x"); });
process.env.FORLY_ENV = "local";
assert.equal(ENV(), "local");

// ── assertOwnership ──
assert.doesNotThrow(() => assertOwnership(profileName("facebook", "05x"), "05x", "facebook"));
assert.throws(() => assertOwnership(profileName("facebook", "05x"), "05y", "facebook"), (e) => e.code === "profile_ownership", "wrong phone");
assert.throws(() => assertOwnership(profileName("yad2", "05x"), "05x", "facebook"), (e) => e.code === "profile_ownership", "wrong platform");

// ── assertOwnership honors the connection's generation ──
const conn = { facebook_profile_gen: 2 };
assert.throws(() => assertOwnership(profileName("facebook", "05x"), "05x", "facebook", conn), (e) => e.code === "profile_ownership", "gen-0 name refused once conn is on gen 2");
assert.doesNotThrow(() => assertOwnership(profileName("facebook", "05x", 2), "05x", "facebook", conn));

// ── assertOwnership refuses a revoked/quarantined profile even with the right name ──
for (const state of ["revoked", "quarantined"]) {
  const c = { [state]: true, facebook_profile_state: state };
  assert.throws(() => assertOwnership(profileName("facebook", "05x"), "05x", "facebook", c), (e) => e.code === "profile_ownership", state);
}

console.log("profile-name.test.js ok");
