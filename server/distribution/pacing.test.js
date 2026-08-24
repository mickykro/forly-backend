/*
 * Unit tests for distribution/pacing.js — the group-posting safety engine.
 * Every rule here exists to keep an agent's personal account safe, so each
 * one gets an explicit test.
 * Run: node server/distribution/pacing.test.js
 */
const assert = require("assert");
const P = require("./pacing");

// A weekday at 12:00 Israel time — safely inside posting hours.
const NOON = new Date("2026-08-25T09:00:00Z").getTime();   // 12:00 IDT
const ago = (ms) => new Date(NOON - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const G = { groupUrl: "https://www.facebook.com/groups/a", pageId: "pg1" };

// ── quiet hours: nothing at 04:00, even with a clean history ──
{
  const night = new Date("2026-08-25T01:00:00Z").getTime();   // 04:00 IDT
  assert.equal(P.canPost({}, G, { now: night }).reason, "quiet_hours");
  assert.equal(P.localHour(new Date(NOON)), 12);
}

// ── warm-up: a brand-new agent is capped at 2/day, ramping to 8 ──
assert.equal(P.dailyCap(null, NOON), P.WARMUP_START);
assert.equal(P.dailyCap(ago(0), NOON), P.WARMUP_START, "day 0 ⇒ starting cap");
assert.equal(P.dailyCap(ago(14 * DAY), NOON), P.DAILY_CAP, "fully warmed up");
assert.ok(P.dailyCap(ago(7 * DAY), NOON) > P.WARMUP_START, "ramps in between");
assert.ok(P.dailyCap(ago(7 * DAY), NOON) < P.DAILY_CAP);

// ── first post of the day on a clean slate is allowed ──
{
  const r = P.canPost({}, G, { now: NOON });
  assert.equal(r.ok, true);
  assert.equal(r.remaining_today, P.WARMUP_START);
}

// ── velocity: two posts inside the minimum gap is refused ──
{
  const state = { first_post_at: ago(30 * DAY),
    posts: [{ at: ago(60 * 1000), group_url: "https://www.facebook.com/groups/z", page_id: "pg9" }] };
  const r = P.canPost(state, G, { now: NOON });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "too_soon");
  assert.ok(new Date(r.retry_at).getTime() > NOON, "tells the client when to retry");
}

// ── daily cap for a warmed-up agent ──
{
  const posts = Array.from({ length: P.DAILY_CAP }, (_, i) => ({
    at: ago((i + 1) * 30 * 60 * 1000),
    group_url: `https://www.facebook.com/groups/g${i}`, page_id: "pgX",
  }));
  const state = { first_post_at: ago(30 * DAY), posts };
  const r = P.canPost(state, G, { now: NOON });
  assert.equal(r.reason, "daily_cap");
  assert.equal(r.cap, P.DAILY_CAP);
}

// ── the same property never goes to the same group twice ──
{
  const state = { first_post_at: ago(30 * DAY),
    posts: [{ at: ago(3 * DAY), group_url: G.groupUrl, page_id: G.pageId }] };
  assert.equal(P.canPost(state, G, { now: NOON }).reason, "already_posted_here");
}

// ── per-group cooldown, even for a different property ──
{
  const state = { first_post_at: ago(30 * DAY),
    posts: [{ at: ago(2 * DAY), group_url: G.groupUrl, page_id: "other" }] };
  const r = P.canPost(state, G, { now: NOON });
  assert.equal(r.reason, "group_cooldown");
  // ...and it clears once the cooldown has elapsed
  const old = { first_post_at: ago(30 * DAY),
    posts: [{ at: ago((P.COOLDOWN_DAYS + 1) * DAY), group_url: G.groupUrl, page_id: "other" }] };
  assert.equal(P.canPost(old, G, { now: NOON }).ok, true);
}

// ── a reported block freezes the agent for 24h, whatever else is true ──
{
  const locked = P.lock({ first_post_at: ago(30 * DAY), posts: [] }, "checkpoint", { now: NOON });
  const r = P.canPost(locked, G, { now: NOON });
  assert.equal(r.reason, "locked");
  assert.equal(P.canPost(locked, G, { now: NOON + P.LOCKOUT_MS + 1000 }).ok, true,
    "unfreezes after the lockout");
}

// ── cross-agent: one group receives one Forly post every few hours, total ──
{
  const clean = { first_post_at: ago(30 * DAY), posts: [] };
  const busy = P.canPost(clean, { ...G, groupLastPostAt: ago(30 * 60 * 1000) }, { now: NOON });
  assert.equal(busy.reason, "group_busy", "another agent just posted there");
  assert.ok(new Date(busy.retry_at).getTime() > NOON);
  const settled = P.canPost(clean,
    { ...G, groupLastPostAt: ago(P.GROUP_GLOBAL_GAP_MS + 60000) }, { now: NOON });
  assert.equal(settled.ok, true, "clears once the global gap has passed");
}

// ── a group the agent only just added is off-limits for a week ──
{
  const clean = { first_post_at: ago(30 * DAY), posts: [] };
  assert.equal(P.canPost(clean, { ...G, groupAddedAt: ago(2 * DAY) }, { now: NOON }).reason,
    "too_new_in_group");
  assert.equal(P.canPost(clean, { ...G, groupAddedAt: ago(10 * DAY) }, { now: NOON }).ok, true);
}

// ── the gap is randomized, never a constant cadence ──
{
  assert.equal(P.nextGapMs(() => 0), P.MIN_GAP_MS);
  assert.equal(P.nextGapMs(() => 1), P.MAX_GAP_MS);
  const gaps = new Set(Array.from({ length: 20 }, (_, i) => P.nextGapMs(() => i / 20)));
  assert.ok(gaps.size > 15, "spread across the window, not a fixed value");
}

// ── recordPost stamps the first post, appends, and clears any lock ──
{
  const s1 = P.recordPost({}, G, { now: NOON });
  assert.equal(s1.posts.length, 1);
  assert.ok(s1.first_post_at);
  const s2 = P.recordPost(s1, { groupUrl: "https://www.facebook.com/groups/b", pageId: "pg2" },
    { now: NOON + 60000 });
  assert.equal(s2.posts.length, 2);
  assert.equal(s2.first_post_at, s1.first_post_at, "warm-up anchor never moves");
  // ancient history is pruned so the doc can't grow forever
  const stale = { posts: [{ at: ago(60 * DAY), group_url: "x", page_id: "y" }] };
  assert.equal(P.recordPost(stale, G, { now: NOON }).posts.length, 1);
}

console.log("pacing.test.js OK");
