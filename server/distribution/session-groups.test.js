/*
 * The share session's groups must stay an ARRAY. A Firestore patch of
 * `groups.0.state` silently turns it into a map, which broke every later
 * read of the queue — db.healGroups converts those docs back on read.
 * Run: node server/distribution/session-groups.test.js
 */
const assert = require("assert");
const db = require("../db");

const healed = db.healGroups({ groups: { 1: { key: "b" }, 0: { key: "a" }, 10: { key: "c" } } });
assert.deepEqual(healed.groups.map((g) => g.key), ["a", "b", "c"]);
assert.ok(Array.isArray(db.healGroups({ groups: [{ key: "a" }] }).groups));
assert.equal(db.healGroups(null), null);
console.log("session-groups.test.js OK");
