/*
 * Unit tests for distribution/metrics.js — staleness, the public shape, and
 * the background refresh, against injected fakes.
 * Run: node server/distribution/metrics.test.js
 */
const assert = require("assert");
const metrics = require("./metrics");

const NOW = new Date("2026-08-27T12:00:00Z");
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60 * 1000);
const dist = (id, postId, m) => ({
  id, targets: { facebook_page: { post_id: postId, metrics: m || undefined } },
});

// ── staleness ──
assert.equal(metrics.isStale(null, NOW.getTime()), true, "never fetched ⇒ stale");
assert.equal(metrics.isStale({ likes: 1 }, NOW.getTime()), true, "no fetched_at ⇒ stale");
assert.equal(metrics.isStale({ fetched_at: minutesAgo(5) }, NOW.getTime()), false, "fresh");
assert.equal(metrics.isStale({ fetched_at: minutesAgo(45) }, NOW.getTime()), true, "past TTL");
// Firestore hands back Timestamps, not Dates — asMillis covers both.
assert.equal(metrics.isStale(
  { fetched_at: { toMillis: () => minutesAgo(5).getTime() } }, NOW.getTime()), false);

// ── which distributions are worth a Graph read, stalest first ──
{
  const due = metrics.staleDistributions([
    dist("a", "P1", { fetched_at: minutesAgo(90) }),        // stale ⇒ yes
    dist("b", "P2", { fetched_at: minutesAgo(2) }),         // fresh ⇒ no
    dist("c", "P3"),                                        // never fetched ⇒ yes, first
    dist("d", null, { fetched_at: minutesAgo(90) }),        // no live post ⇒ never
    dist("e", "P5", { fetched_at: minutesAgo(200) }),       // stalest of the fetched
  ], NOW.getTime());
  assert.deepEqual(due.map((d) => d.id), ["c", "e", "a"],
    "never-fetched first, then oldest — this ordering is what makes the cap drain");
  assert.deepEqual(metrics.staleDistributions(null, NOW.getTime()), []);
}

// ── public shape: numbers coerced, reach honestly null, no internals ──
{
  assert.equal(metrics.publicMetrics(null), null);
  const p = metrics.publicMetrics({ likes: 12, comments: 3, shares: 2,
    reach: null, impressions: null, video_views: null,
    insights: "not_permitted", fetched_at: NOW });
  assert.deepEqual(p, { likes: 12, comments: 3, shares: 2, reach: null,
    impressions: null, video_views: null, insights: "not_permitted", fetched_at: NOW });
  // A blank reach must stay null, never render as a fabricated 0.
  assert.strictEqual(p.reach, null);
  assert.equal(metrics.publicMetrics({}).likes, 0, "missing counts read as 0");
  assert.equal(metrics.publicMetrics({}).insights, "unavailable");
}

(async () => {
  const fakeDeps = (fetchImpl) => {
    const writes = [];
    return {
      deps: {
        db: { updateDistribution: async (id, patch) => writes.push({ id, patch }) },
        meta: { fetchPostMetrics: fetchImpl },
        now: () => NOW,
        graphVersion: "v21.0",
      },
      writes,
    };
  };
  const payload = { likes: 12, comments: 3, shares: 2, reach: 340,
    impressions: 512, video_views: 87, insights: "ok" };

  // ── refreshOne writes the numbers plus a fetch stamp ──
  {
    const { deps, writes } = fakeDeps(async () => payload);
    const out = await metrics.refreshOne(deps, dist("a", "P1"), "PT");
    assert.equal(out.likes, 12);
    assert.deepEqual(out.fetched_at, NOW, "stamped so the TTL can expire it");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].id, "a");
    assert.equal(writes[0].patch["targets.facebook_page.metrics"].reach, 340);
  }

  // ── a post with no live id is never fetched ──
  {
    const { deps, writes } = fakeDeps(async () => { throw new Error("must not call"); });
    assert.equal(await metrics.refreshOne(deps, dist("a", null), "PT"), null);
    assert.equal(writes.length, 0);
  }

  // ── background refresh: only the stale ones, and never awaited ──
  {
    const asked = [];
    const { deps, writes } = fakeDeps(async ({ postId }) => { asked.push(postId); return payload; });
    const due = metrics.refreshStaleInBackground(deps, [
      dist("a", "P1", { fetched_at: minutesAgo(90) }),
      dist("b", "P2", { fetched_at: minutesAgo(2) }),
    ], { page_token: "PT" });
    assert.deepEqual(due.map((d) => d.id), ["a"], "returns what it queued, not results");
    await new Promise((r) => setImmediate(r));   // let the detached work settle
    assert.deepEqual(asked, ["P1"], "fresh post left alone");
    assert.equal(writes.length, 1);
  }

  // ── one dashboard load never storms the Graph API ──
  {
    const asked = [];
    const { deps } = fakeDeps(async ({ postId }) => { asked.push(postId); return payload; });
    // 25 listings, all never fetched — an agent's first load after onboarding.
    const many = Array.from({ length: 25 }, (_, i) => dist("d" + i, "P" + i));
    const due = metrics.refreshStaleInBackground(deps, many, { page_token: "PT" });
    assert.equal(due.length, metrics.MAX_PER_REQUEST, "capped per request");
    await new Promise((r) => setImmediate(r));
    assert.equal(asked.length, metrics.MAX_PER_REQUEST, "and only that many Graph reads");
  }

  // ── no usable connection ⇒ no Graph reads at all ──
  {
    const { deps } = fakeDeps(async () => { throw new Error("must not call"); });
    const stale = [dist("a", "P1", { fetched_at: minutesAgo(90) })];
    assert.deepEqual(metrics.refreshStaleInBackground(deps, stale, null), []);
    assert.deepEqual(metrics.refreshStaleInBackground(deps, stale, {}), []);
    // A token flagged for reconnect is not retried by a background READ — the
    // publish path owns the reconnect nudge, so a dashboard view stays silent.
    assert.deepEqual(metrics.refreshStaleInBackground(deps, stale,
      { page_token: "PT", needs_reconnect: true }), []);
  }

  // ── a failing refresh must never reject into the request that fired it ──
  {
    const { deps, writes } = fakeDeps(async () => { throw new Error("graph down"); });
    metrics.refreshStaleInBackground(deps,
      [dist("a", "P1", { fetched_at: minutesAgo(90) })], { page_token: "PT" });
    await new Promise((r) => setImmediate(r));
    assert.equal(writes.length, 0, "nothing written, and no unhandled rejection");
  }

  console.log("metrics.test.js OK");
})().catch((e) => { console.error(e); process.exit(1); });
