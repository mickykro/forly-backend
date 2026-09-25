/* profile-name.js — HMAC naming, host anchoring, twitter→x, both call shapes
   (a social URL from extract, a bare platform from connections-browser). */
const assert = require("assert");
const { profileName } = require("./profile-name");

// ── URL call shape (extract.js's use) ──
assert.equal(
  profileName("https://www.facebook.com/groups/1", "05x", "k"),
  profileName("https://facebook.com/groups/2", "05x", "k"),
);
assert.ok(/^facebook-[a-z]+-[0-9a-f]{20}$/.test(profileName("https://www.facebook.com/groups/1", "05x", "k")), "hmac, not the phone");
assert.equal(
  profileName("https://twitter.com/a/status/1", "05x", "k"),
  profileName("https://x.com/a/status/1", "05x", "k"),
);
assert.equal(profileName("https://netflix.com/x", "05x", "k"), null, "not left-anchored → netflix matched x.com");
assert.equal(profileName("https://evilfacebook.com/x", "05x", "k"), null);
assert.equal(profileName("https://www.yad2.co.il/item/1", "05x", "k"), null, "no profile for non-social hosts");

// ── phone changes the hmac, key changes the hmac ──
assert.notEqual(profileName("https://facebook.com/x", "05x", "k"), profileName("https://facebook.com/x", "05y", "k"));
assert.notEqual(profileName("https://facebook.com/x", "05x", "k1"), profileName("https://facebook.com/x", "05x", "k2"));

// ── bare-platform call shape (connections-browser.js's use) ──
assert.equal(profileName("facebook", "05x", "k"), profileName("https://www.facebook.com/x", "05x", "k"));
assert.equal(profileName("twitter", "05x", "k"), profileName("x", "05x", "k"), "twitter→x here too");

console.log("profile-name.test.js ok");
