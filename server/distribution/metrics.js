/*
 * distribution/metrics.js — engagement on the agent's live Page posts.
 *
 * Facebook is the only source for these numbers, and the Graph call is far too
 * slow to sit inside a dashboard render. So the numbers are CACHED on the
 * distribution doc (`targets.facebook_page.metrics`) — the same doc /status
 * already loads, so reading them costs nothing — and refreshed in the
 * BACKGROUND when a request notices they have gone stale.
 *
 * The consequence, stated plainly: a dashboard load returns the previous
 * numbers and triggers the refresh; the fresher ones appear on the next load.
 * That is the trade for never blocking a page render on Meta.
 *
 * Groups have no equivalent and never will — Forly only knows that the agent
 * said they posted (docs/distribution/DECISION-no-automation.md). Nothing here
 * applies to them.
 */

const { asMillis } = require("../utils");

const TTL_MS = 30 * 60 * 1000;   // refresh at most twice an hour per post
const MAX_PER_REQUEST = 10;      // never let one dashboard load storm the Graph API
// ponytail: one container, so an in-process set is enough to stop a double
// dashboard load firing two refreshes for the same post. A second container
// would just mean one wasted Graph read, not a wrong number.
const inFlight = new Set();

const postIdOf = (dist) =>
  (dist && dist.targets && dist.targets.facebook_page &&
    dist.targets.facebook_page.post_id) || null;

const metricsOf = (dist) =>
  (dist && dist.targets && dist.targets.facebook_page &&
    dist.targets.facebook_page.metrics) || null;

function isStale(metrics, now, ttlMs = TTL_MS) {
  if (!metrics || !metrics.fetched_at) return true;
  return Number(now) - asMillis(metrics.fetched_at) >= ttlMs;
}

/*
 * The distributions worth a Graph read right now: a live post, and numbers
 * that are missing or past their TTL — STALEST FIRST.
 *
 * The order is what makes the per-request cap safe. An agent onboarding with
 * 40 listings would otherwise fire 40 parallel Graph calls on their first
 * dashboard load; capped and sorted, each load takes the oldest slice and the
 * backlog drains over a few loads instead of arriving as one burst.
 */
function staleDistributions(dists, now, ttlMs = TTL_MS) {
  return (dists || [])
    .filter((d) => postIdOf(d) && isStale(metricsOf(d), now, ttlMs))
    .sort((a, b) => asMillis((metricsOf(a) || {}).fetched_at) -
      asMillis((metricsOf(b) || {}).fetched_at));
}

// Public shape — what the dashboard is allowed to see. `insights: "not_permitted"`
// is the honest reason reach is blank: the app has no read_insights grant yet,
// which is an App Review item, not an agent problem.
function publicMetrics(metrics) {
  if (!metrics) return null;
  return {
    likes: Number(metrics.likes) || 0,
    comments: Number(metrics.comments) || 0,
    shares: Number(metrics.shares) || 0,
    reach: metrics.reach == null ? null : Number(metrics.reach),
    impressions: metrics.impressions == null ? null : Number(metrics.impressions),
    video_views: metrics.video_views == null ? null : Number(metrics.video_views),
    insights: metrics.insights || "unavailable",
    fetched_at: metrics.fetched_at || null,
  };
}

async function refreshOne(deps, dist, pageToken) {
  const postId = postIdOf(dist);
  if (!postId || inFlight.has(postId)) return null;
  inFlight.add(postId);
  try {
    const m = await deps.meta.fetchPostMetrics({
      postId, pageToken, graphVersion: deps.graphVersion, fetchFn: deps.fetchFn,
    });
    const metrics = { ...m, fetched_at: deps.now() };
    await deps.db.updateDistribution(dist.id, {
      "targets.facebook_page.metrics": metrics, updated_at: deps.now(),
    });
    return metrics;
  } finally {
    inFlight.delete(postId);
  }
}

/*
 * Fire-and-forget refresh for whatever has gone stale. Never awaited by a
 * request handler, and never throws into one.
 *
 * A dead token is deliberately NOT escalated here: needs_reconnect is set by
 * the publish path, which is where the agent has an action to take. Making a
 * background READ nudge them would send "reconnect Facebook" WhatsApps to
 * agents who were only looking at their dashboard.
 */
function refreshStaleInBackground(deps, dists, conn, ttlMs = TTL_MS) {
  const pageToken = conn && conn.page_token;
  if (!pageToken || (conn && conn.needs_reconnect)) return [];
  const due = staleDistributions(dists, asMillis(deps.now()), ttlMs)
    .slice(0, MAX_PER_REQUEST);
  for (const dist of due) {
    refreshOne(deps, dist, pageToken).catch((err) => {
      console.warn("post metrics refresh failed:", dist.id, err && err.message);
    });
  }
  return due;
}

module.exports = {
  TTL_MS, MAX_PER_REQUEST, isStale, staleDistributions, publicMetrics, refreshOne,
  refreshStaleInBackground, postIdOf, metricsOf,
};
