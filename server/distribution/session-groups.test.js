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

/*
 * listShareSessionsByPhone must return the agent's sessions NEWEST FIRST: the
 * dashboard's group progress takes the first session it sees per page as the
 * live one, so a stale run sorting to the top would report last week's counts.
 */
(async () => {
  const mine = "972500000001", theirs = "972500000002";
  await db.saveShareSession({ id: "old", business_phone: mine, page_id: "p1",
    created_at: "2026-08-01T00:00:00Z", groups: [{ key: "a", state: "posted" }] });
  await db.saveShareSession({ id: "new", business_phone: mine, page_id: "p1",
    created_at: "2026-08-20T00:00:00Z", groups: [{ key: "a", state: "ready" }] });
  await db.saveShareSession({ id: "other", business_phone: theirs, page_id: "p9",
    created_at: "2026-08-05T00:00:00Z", groups: [] });

  const list = await db.listShareSessionsByPhone(mine);
  assert.deepEqual(list.map((s) => s.id), ["new", "old"], "newest session first");
  assert.ok(!list.some((s) => s.business_phone === theirs), "never another agent's sessions");
  assert.ok(list.every((s) => Array.isArray(s.groups)), "groups healed to arrays on read");

  console.log("session-groups.test.js OK");
})();
