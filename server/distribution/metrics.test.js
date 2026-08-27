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

  /*
   * ── a post the agent deleted on Facebook ──
   * Graph answers a deleted object with code 100. Without a stamp the doc looks
   * permanently stale, so every dashboard load would re-fetch it forever.
   */
  {
    const gone = Object.assign(
      new Error("Unsupported get request. Object with ID '1' does not exist"), { code: 100 });
    const { deps, writes } = fakeDeps(async () => { throw gone; });
    await assert.rejects(() => metrics.refreshOne(deps, dist("a", "P1"), "PT", "PAGE"),
      (e) => e.code === 100, "the caller still hears it, so the log fires");
    assert.equal(writes.length, 1, "the failed attempt is recorded, not dropped");
    const stamp = writes[0].patch["targets.facebook_page.metrics"];
    assert.equal(stamp.missing, true);
    assert.equal(stamp.error_code, 100);
    assert.deepEqual(stamp.fetched_at, NOW);

    // ...and that stamp keeps it out of the next 24h of refreshes.
    assert.equal(metrics.isStale(stamp, NOW.getTime()), false, "not retried immediately");
    assert.equal(metrics.isStale(stamp, NOW.getTime() + 60 * 60 * 1000), false,
      "nor an hour later, unlike the normal 30-minute TTL");
    assert.equal(metrics.isStale(stamp, NOW.getTime() + 25 * 60 * 60 * 1000), true,
      "but re-checked daily — 'gone' and 'not visible' share one Graph code");

    // The card shows no counts for it: zeroes would read as "nobody engaged".
    assert.deepEqual(metrics.publicMetrics(stamp),
      { missing: true, error_code: 100, fetched_at: NOW });
  }

  // A transient failure is NOT written off — it retries at the normal cadence.
  {
    const { deps, writes } = fakeDeps(async () => { throw new Error("network"); });
    await assert.rejects(() => metrics.refreshOne(deps, dist("b", "P2"), "PT", "PAGE"));
    const stamp = writes[0].patch["targets.facebook_page.metrics"];
    assert.equal(stamp.missing, false, "only code 100 means the object is gone");
    assert.equal(metrics.isStale(stamp, NOW.getTime() + 31 * 60 * 1000), true,
      "back on the normal 30-minute TTL");
  }

  /*
   * ── an unpublished listing never reaches Facebook ──
   * There is no post to measure, so there is nothing to ask about. This holds
   * however stale the doc looks: staleness is only a question once a post id
   * exists. A dashboard full of drafts must cost zero Graph calls.
   */
  {
    const asked = [];
    const { deps, writes } = fakeDeps(async ({ postId }) => { asked.push(postId); return payload; });
    const drafts = [
      dist("never-published", null),
      dist("offered-not-posted", null, { fetched_at: minutesAgo(999) }),
      dist("also-draft", undefined),
    ];
    assert.deepEqual(metrics.refreshStaleInBackground(deps, drafts, { page_token: "PT" }), []);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(asked, [], "no Graph call for a listing that was never posted");
    assert.equal(writes.length, 0);
    // And the mixed case: only the published one is asked about.
    const mixed = drafts.concat([dist("live", "P_LIVE")]);
    metrics.refreshStaleInBackground(deps, mixed, { page_token: "PT" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(asked, ["P_LIVE"], "only the published listing is measured");
  }

  /*
   * ── the FIRST view of a post must not be blank ──
   * Background-only refresh means load 1 renders nothing and only a reload
   * fills it in. Agents do not reload; they conclude the feature is broken.
   */
  {
    const payload2 = { ...payload };
    const { deps } = fakeDeps(async () => payload2);
    const cold = dist("cold", "P1");                                   // never measured
    const warm = dist("warm", "P2", { likes: 1, fetched_at: minutesAgo(90) }); // stale, not cold
    const draft = dist("draft", null);
    const primed = await metrics.primeUncached(deps, [cold, warm, draft], { page_token: "PT" });
    assert.deepEqual(primed.map((d) => d.id), ["cold"], "only genuinely cold posts block");
    assert.equal(cold.targets.facebook_page.metrics.likes, 12,
      "patched onto the caller's object, so THIS response carries it");
    assert.equal(warm.targets.facebook_page.metrics.likes, 1,
      "a stale post keeps its cached value and refreshes in the background");
  }

  // A hanging Graph delays the dashboard by the budget and no more.
  // NOTE: distinct post id — this refresh never settles, so it stays in the
  // in-flight set for the rest of the file and would suppress a later fetch.
  {
    const { deps } = fakeDeps(() => new Promise(() => { /* never settles */ }));
    const started = Date.now();
    await metrics.primeUncached(deps, [dist("c", "HANGING")], { page_token: "PT" },
      { budgetMs: 120 });
    const waited = Date.now() - started;
    assert.ok(waited < 1000, `gave up after ${waited}ms rather than hanging the request`);
  }

  // No connection ⇒ nothing is primed and nothing is awaited.
  assert.deepEqual(await metrics.primeUncached(fakeDeps(async () => payload).deps,
    [dist("c", "NOCONN")], null), []);

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
    // The rejection is swallowed by the caller (this is fire-and-forget), but
    // the attempt is still stamped so the post is not re-fetched on every load.
    assert.equal(writes.length, 1, "the attempt is recorded");
    assert.equal(writes[0].patch["targets.facebook_page.metrics"].missing, false,
      "a transient failure is not written off as a deleted post");
  }

  console.log("metrics.test.js OK");
})().catch((e) => { console.error(e); process.exit(1); });
