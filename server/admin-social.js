/*
 * admin-social.js — social (Facebook Page post) engagement across EVERY agent.
 *
 * The agent dashboard shows each agent their own post metrics, cached on the
 * distribution doc by distribution/metrics.js. The admin panel wants the same
 * numbers for all properties at once. Nothing here calls Meta inline: the
 * report is built from the cached numbers, and whatever is stale is refreshed
 * in the background with one GLOBAL cap — an admin load must not fan out into
 * one Graph storm per agent.
 */

const metrics = require("./distribution/metrics");
const { asMillis } = require("./utils");

// One row per property: the current live post is the most recently updated
// distribution that still carries a post id — same election as /status.
function currentPostByPage(distributions) {
  const byPage = new Map();
  for (const d of distributions || []) {
    if (!metrics.postIdOf(d) || !d.page_id) continue;
    const prev = byPage.get(d.page_id);
    if (!prev || asMillis(d.updated_at) > asMillis(prev.updated_at)) byPage.set(d.page_id, d);
  }
  return byPage;
}

const SUMMED = ["likes", "comments", "shares", "reach", "impressions", "video_views"];

function buildSocialReport({ listings, businesses, distributions, pageBaseUrl = "", now = Date.now() }) {
  const bizByPhone = new Map((businesses || []).map((b) => [b.phone, b]));
  const postByPage = currentPostByPage(distributions);
  const rows = [];
  const totals = Object.fromEntries(SUMMED.map((k) => [k, 0]));
  const agents = new Set();
  let unreadable = 0;
  let stale = 0;

  for (const l of listings || []) {
    if (l.status === "deleted" || !l.page_id) continue;
    const dist = postByPage.get(l.page_id);
    if (!dist) continue;
    const biz = bizByPhone.get(l.business_phone);
    const fb = dist.targets.facebook_page;
    const m = metrics.publicMetrics(metrics.metricsOf(dist));
    if (l.business_phone) agents.add(l.business_phone);
    if (m && m.missing) unreadable += 1;
    if (metrics.isStale(metrics.metricsOf(dist), now)) stale += 1;
    if (m && !m.missing) {
      for (const k of SUMMED) totals[k] += Number(m[k]) || 0;
    }
    rows.push({
      listing_id: l.listing_id,
      page_id: l.page_id,
      page_url: pageBaseUrl ? `${pageBaseUrl}/p/${l.page_id}` : null,
      business_phone: l.business_phone || null,
      agent_name: (biz && (biz.business_name || biz.full_name)) ||
        (l.agent && (l.agent.brand_name || l.agent.name)) || "—",
      title: `${l.rooms || ""} חד׳ ב${l.neighborhood || l.city || ""}`.trim(),
      address: [l.address, l.city].filter(Boolean).join(", "),
      thumb_url: (l.photos_urls && l.photos_urls[0]) || null,
      post_url: fb.post_url || null,
      posted_at: asMillis(dist.updated_at || dist.confirmed_at) || null,
      instagram_url: (dist.targets.instagram && dist.targets.instagram.permalink) || null,
      metrics: m,
    });
  }
  rows.sort((a, b) => (b.posted_at || 0) - (a.posted_at || 0));

  return {
    properties: rows,
    stats: {
      posted_properties: rows.length,
      posting_agents: agents.size,
      unreadable_posts: unreadable,
      stale_posts: stale,
      ...Object.fromEntries(SUMMED.map((k) => [`total_${k}`, totals[k]])),
    },
  };
}

/*
 * Background refresh across agents, capped at MAX_PER_REQUEST posts IN TOTAL.
 * The oldest-read posts go first, whoever owns them; only the owners of that
 * batch have their connection loaded (one read each), and an agent with no
 * usable token is skipped exactly as their own dashboard would skip them.
 * Never awaited by the route; never throws into it.
 */
async function refreshStaleAcrossAgents(deps, distributions, getConnection) {
  const due = metrics.staleDistributions(distributions, asMillis(deps.now()))
    .slice(0, metrics.MAX_PER_REQUEST);
  const byPhone = new Map();
  for (const d of due) {
    if (!d.business_phone) continue;
    if (!byPhone.has(d.business_phone)) byPhone.set(d.business_phone, []);
    byPhone.get(d.business_phone).push(d);
  }
  const started = [];
  await Promise.all([...byPhone].map(async ([phone, dists]) => {
    try {
      const conn = await getConnection(phone);
      started.push(...metrics.refreshStaleInBackground(deps, dists, conn));
    } catch (err) {
      console.warn("[admin-social] connection read failed", phone, err && err.message);
    }
  }));
  return started;
}

module.exports = { buildSocialReport, refreshStaleAcrossAgents, currentPostByPage };
