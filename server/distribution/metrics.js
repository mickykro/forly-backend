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
// A post the agent deleted on Facebook is never coming back, but "gone" and
// "not visible to this token" arrive as the same code 100, so it is re-checked
// daily rather than written off for good.
const GONE_TTL_MS = 24 * 60 * 60 * 1000;
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

// Backs off against the last ATTEMPT, not the last success — otherwise a post
// that keeps failing is retried on every single load forever.
function isStale(metrics, now, ttlMs = TTL_MS) {
  if (!metrics) return true;
  const last = metrics.checked_at || metrics.fetched_at;
  if (!last) return true;
  const ttl = metrics.missing ? Math.max(ttlMs, GONE_TTL_MS) : ttlMs;
  return Number(now) - asMillis(last) >= ttl;
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
  /*
   * Graph would not serve the post. That is usually a deletion, but code 100
   * also covers "not visible to this token", so the card links out and lets the
   * agent see for themselves rather than asserting the post is gone.
   * Any counts read before the failure are still reported — they were real.
   */
  if (metrics.missing) {
    return { missing: true,
      error_code: metrics.error_code || null,
      error_subcode: metrics.error_subcode || null,
      likes: metrics.likes == null ? null : Number(metrics.likes),
      comments: metrics.comments == null ? null : Number(metrics.comments),
      fetched_at: metrics.fetched_at || null };
  }
  return {
    likes: Number(metrics.likes) || 0,
    comments: Number(metrics.comments) || 0,
    // shares/reach stay null when Graph would not serve them — "unreadable" is
    // not "zero", and a card must not invent a number.
    shares: metrics.shares == null ? null : Number(metrics.shares),
    reach: metrics.reach == null ? null : Number(metrics.reach),
    impressions: metrics.impressions == null ? null : Number(metrics.impressions),
    video_views: metrics.video_views == null ? null : Number(metrics.video_views),
    insights: metrics.insights || "unavailable",
    fetched_at: metrics.fetched_at || null,
  };
}

async function refreshOne(deps, dist, pageToken, pageId) {
  const postId = postIdOf(dist);
  if (!postId || inFlight.has(postId)) return null;
  inFlight.add(postId);
  try {
    // pageId lets a bare video id be addressed as the Page post "{page}_{video}",
    // which is the only form Graph will read for an uploaded video (meta.js).
    const m = await deps.meta.fetchPostMetrics({
      postId, pageId, pageToken, graphVersion: deps.graphVersion, fetchFn: deps.fetchFn,
    });
    const metrics = { ...m, fetched_at: deps.now() };
    await deps.db.updateDistribution(dist.id, {
      "targets.facebook_page.metrics": metrics, updated_at: deps.now(),
    });
    return metrics;
  } catch (err) {
    /*
     * Stamp the failed attempt, MERGED over whatever was last read successfully.
     *
     * Replacing the record instead would destroy the counts: publicMetrics
     * coerces an absent `likes` to 0, so a single socket hang-up on a post with
     * 42 likes rendered "❤️ 0 💬 0" — a fabricated number, which is the one
     * thing this module is not allowed to produce.
     *
     * `fetched_at` therefore stays pinned to the last SUCCESSFUL read (it says
     * how old the displayed numbers are), while `checked_at` records this
     * attempt and is what the TTL backs off against.
     */
    const prev = metricsOf(dist) || {};
    await deps.db.updateDistribution(dist.id, {
      "targets.facebook_page.metrics": {
        ...prev,
        // Code 100 covers "deleted", "not visible to this token" and "node does
        // not support this" — the subcode is the only thing that separates them,
        // so keep it rather than asserting a cause we cannot know.
        missing: (err && err.code) === 100,
        error_code: (err && err.code) || null,
        error_subcode: (err && err.subcode) || null,
        checked_at: deps.now(),
        fetched_at: prev.fetched_at || null,
      },
      updated_at: deps.now(),
    }).catch(() => { /* the throw below is what the caller logs */ });
    throw err;
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
    refreshOne(deps, dist, pageToken, conn.page_id).catch((err) => {
      // Name the post id and Graph's own code — "does not exist" and "missing
      // permissions" share one message, and only the code separates them.
      console.warn("[metrics] refresh failed", dist.id,
        "post_id=" + postIdOf(dist), "page_id=" + conn.page_id,
        "code=" + (err && err.code), "subcode=" + (err && err.subcode),
        "tried=" + JSON.stringify((err && err.tried) || null),
        err && err.message);
    });
  }
  return due;
}

/*
 * First sight of a post: nothing is cached, so the background path would render
 * an empty row and rely on the agent reloading to ever see a number. They don't
 * — they conclude the feature is broken, which is exactly what happened in
 * testing. So a COLD post (no stored metrics at all, not merely stale) is
 * fetched inline.
 *
 * Bounded hard: only the batch on screen, and the whole thing is raced against
 * PRIME_BUDGET_MS so a slow or hanging Graph delays the dashboard by that much
 * and no more. Whatever arrives in time is patched onto the caller's own
 * objects; the rest stays cached-and-background like everything else.
 */
const PRIME_BUDGET_MS = 6000;

async function primeUncached(deps, dists, conn, { limit = MAX_PER_REQUEST,
  budgetMs = PRIME_BUDGET_MS } = {}) {
  const pageToken = conn && conn.page_token;
  if (!pageToken || conn.needs_reconnect) return [];
  const cold = (dists || []).filter((d) => postIdOf(d) && !metricsOf(d)).slice(0, limit);
  if (!cold.length) return [];
  const work = Promise.all(cold.map((d) =>
    refreshOne(deps, d, pageToken, conn.page_id)
      .then((m) => { if (m) d.targets.facebook_page.metrics = m; })
      .catch(() => { /* stamped by refreshOne; the row just stays empty */ })));
  await Promise.race([work, new Promise((r) => setTimeout(r, budgetMs))]);
  return cold;
}

module.exports = {
  TTL_MS, MAX_PER_REQUEST, PRIME_BUDGET_MS, isStale, staleDistributions,
  publicMetrics, refreshOne, refreshStaleInBackground, primeUncached,
  postIdOf, metricsOf,
};
