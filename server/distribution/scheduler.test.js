/*
 * Unit tests for distribution/scheduler.js — fair rotation across many
 * properties and few group slots.
 * Run: node server/distribution/scheduler.test.js
 */
const assert = require("assert");
const S = require("./scheduler");

const NOW = new Date("2026-08-25T09:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;
const COOLDOWN = 48 * 60 * 60 * 1000;
const ago = (ms) => new Date(NOW - ms).toISOString();

const prop = (id, daysOld, city = "תל אביב", type = "sale") =>
  ({ page_id: id, created_at: ago(daysOld * DAY), city, listing_type: type });
const group = (url, members = 50000, city = "תל אביב", types = ["sale"]) =>
  ({ url, members, city, listing_types: types });

const base = { now: NOW, groupCooldownMs: COOLDOWN };

// ── fairness dominates: every property gets its FIRST group before any
//    property gets its second ──
{
  const properties = [prop("A", 1), prop("B", 2), prop("C", 3)];
  const groups = [group("g1"), group("g2"), group("g3"), group("g4")];
  const history = [];
  const picks = [];
  for (let i = 0; i < 3; i++) {
    // Each group rests after use, so advance time enough to keep slots open.
    const r = S.planNext({ properties, groups, history, ...base,
      now: NOW + i * 60 * 60 * 1000 });
    assert.ok(!r.none, `pick ${i} should exist`);
    picks.push(r.page_id);
    history.push({ at: new Date(NOW + i * 60 * 60 * 1000).toISOString(),
      page_id: r.page_id, group_url: r.group_url });
  }
  assert.deepEqual([...new Set(picks)].sort(), ["A", "B", "C"],
    "all three properties served before any repeats");
}

// ── a property is never posted to the same group twice ──
{
  const properties = [prop("A", 1)];
  const groups = [group("g1")];
  const history = [{ at: ago(5 * DAY), page_id: "A", group_url: "g1" }];
  const r = S.planNext({ properties, groups, history, ...base });
  assert.ok(r.none, "no pair left");
  assert.equal(r.reason, "all_distributed");
}

// ── a resting group is skipped, and reported honestly when all are resting ──
{
  const properties = [prop("A", 1), prop("B", 1)];
  const groups = [group("g1"), group("g2")];
  const history = [
    { at: ago(60 * 60 * 1000), page_id: "A", group_url: "g1" },
    { at: ago(60 * 60 * 1000), page_id: "A", group_url: "g2" },
  ];
  const r = S.planNext({ properties, groups, history, ...base });
  assert.equal(r.none, true);
  assert.equal(r.reason, "groups_resting");
  assert.ok(new Date(r.retry_at).getTime() > NOW, "says when a slot reopens");
  // once one group has rested, B goes out
  const later = S.planNext({ properties, groups, history, ...base, now: NOW + COOLDOWN + 1000 });
  assert.equal(later.page_id, "B", "the unserved property goes first");
}

// ── the per-property cap stops one listing eating the week ──
{
  const properties = [prop("A", 1), prop("B", 30)];
  const groups = ["g1", "g2", "g3", "g4", "g5", "g6"].map((u) => group(u));
  const history = ["g1", "g2", "g3", "g4"].map((g, i) => ({
    at: ago((i + 3) * DAY), page_id: "A", group_url: g }));
  const r = S.planNext({ properties, groups, history, ...base });
  assert.equal(r.page_id, "B", "A hit the 4-group cap, so B gets the slot");
}

// ── fit: same city and matching listing type wins over a bigger mismatch ──
{
  const sale = prop("A", 1, "חיפה", "sale");
  const rentalGiant = group("g-rent", 250000, "חיפה", ["rent"]);
  const saleLocal = group("g-sale", 20000, "חיפה", ["sale"]);
  const r = S.planNext({ properties: [sale], groups: [rentalGiant, saleLocal], ...base });
  assert.equal(r.group_url, "g-sale", "a rental-only group loses to a fitting one");
  assert.ok(S.fitScore(sale, saleLocal) > S.fitScore(sale, rentalGiant));
}

// ── freshness breaks ties between equally-unserved properties ──
{
  const properties = [prop("old", 40), prop("new", 1)];
  const groups = [group("g1")];
  const r = S.planNext({ properties, groups, history: [], ...base });
  assert.equal(r.page_id, "new", "newest listing first");
}

// ── empty inputs are answered, not crashed ──
assert.equal(S.planNext({ properties: [], groups: [group("g1")], ...base }).reason, "no_properties");
assert.equal(S.planNext({ properties: [prop("A", 1)], groups: [], ...base }).reason, "no_groups");

// ── forecast: the honest ETA the dashboard shows ──
{
  // 50 properties, 10 groups, 8 posts/day → groups are the binding constraint
  const f = S.forecast({ propertyCount: 50, groupCount: 10, dailyCap: 8,
    groupCooldownMs: COOLDOWN });
  assert.equal(f.per_property_groups, 4);
  assert.equal(f.total_posts, 200);
  assert.equal(f.limited_by, "groups", "10 groups × 1 per 48h = 5/day < 8/day");
  assert.equal(f.days, 40);
  // with more groups the agent's own daily cap becomes the limit
  const g = S.forecast({ propertyCount: 50, groupCount: 40, dailyCap: 8,
    groupCooldownMs: COOLDOWN });
  assert.equal(g.limited_by, "daily_cap");
  assert.equal(g.days, 25);
  // a small agent finishes fast
  const s = S.forecast({ propertyCount: 3, groupCount: 6, dailyCap: 8,
    groupCooldownMs: COOLDOWN });
  assert.equal(s.total_posts, 12);
  assert.ok(s.days <= 4);
}

console.log("scheduler.test.js OK");
