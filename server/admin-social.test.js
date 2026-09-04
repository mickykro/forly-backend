/* Unit tests for the admin cross-agent social metrics report. */
const assert = require("assert");
const { buildSocialReport, refreshStaleAcrossAgents } = require("./admin-social");
const metrics = require("./distribution/metrics");

const NOW = Date.parse("2026-09-04T10:00:00Z");
const fresh = new Date(NOW - 60 * 1000).toISOString();
const old = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();

const dist = (over) => ({
  id: over.id, page_id: over.page_id, business_phone: over.phone, status: "done",
  updated_at: over.updated_at || fresh,
  targets: { facebook_page: { status: "posted", post_id: over.post_id || over.id,
    post_url: "https://fb.com/" + over.id, metrics: over.metrics } },
});

const listings = [
  { listing_id: "L1", page_id: "P1", business_phone: "9721", rooms: 3, city: "חיפה", status: "active" },
  { listing_id: "L2", page_id: "P2", business_phone: "9722", rooms: 4, city: "תל אביב", status: "active" },
  { listing_id: "L3", page_id: "P3", business_phone: "9721", status: "active" },     // never posted
  { listing_id: "L4", page_id: "P4", business_phone: "9721", status: "deleted" },
  { listing_id: "L5", business_phone: "9721", status: "active" },                    // no page yet
];
const businesses = [{ phone: "9721", business_name: "Yael Realty" }];

(async () => {
  // ── report: joins, election of the current post, totals, honest nulls ──
  const distributions = [
    dist({ id: "d1", page_id: "P1", phone: "9721", updated_at: old,
      metrics: { likes: 1, comments: 0, fetched_at: old } }),
    // a later re-post supersedes d1 for P1
    dist({ id: "d2", page_id: "P1", phone: "9721", updated_at: fresh,
      metrics: { likes: 10, comments: 2, shares: 3, reach: 100, fetched_at: fresh } }),
    dist({ id: "d3", page_id: "P2", phone: "9722", updated_at: fresh,
      metrics: { missing: true, error_code: 100, likes: 5, checked_at: fresh } }),
    dist({ id: "d4", page_id: "P4", phone: "9721", metrics: { likes: 99, fetched_at: fresh } }),
  ];
  const r = buildSocialReport({ listings, businesses, distributions, pageBaseUrl: "https://x", now: NOW });

  assert.deepEqual(r.properties.map((p) => p.page_id), ["P1", "P2"],
    "only posted, non-deleted properties with a page appear");
  const p1 = r.properties[0];
  assert.equal(p1.post_url, "https://fb.com/d2", "the newest post wins for a page");
  assert.equal(p1.agent_name, "Yael Realty");
  assert.equal(p1.page_url, "https://x/p/P1");
  assert.deepEqual(p1.metrics, { likes: 10, comments: 2, shares: 3, reach: 100,
    impressions: null, video_views: null, insights: "unavailable", fetched_at: fresh });
  const p2 = r.properties[1];
  assert.equal(p2.agent_name, "—", "unknown business falls back rather than crashing");
  assert.equal(p2.metrics.missing, true);

  assert.equal(r.stats.posted_properties, 2);
  assert.equal(r.stats.posting_agents, 2);
  assert.equal(r.stats.unreadable_posts, 1);
  assert.equal(r.stats.total_likes, 10, "unreadable posts never contribute to totals");
  assert.equal(r.stats.total_shares, 3);
  assert.equal(r.stats.total_reach, 100);
  assert.equal(r.stats.total_impressions, 0);
  assert.equal(r.stats.stale_posts, 0, "both surviving posts were checked within the TTL");

  // ── empty input ──
  const empty = buildSocialReport({ listings: [], businesses: [], distributions: [] });
  assert.deepEqual(empty.properties, []);
  assert.equal(empty.stats.posted_properties, 0);

  // ── background refresh: global cap, per-owner connection, skips no token ──
  const many = [];
  for (let i = 0; i < 15; i++) {
    many.push(dist({ id: "s" + i, page_id: "SP" + i, phone: i < 12 ? "9721" : "9723",
      metrics: { likes: 0, fetched_at: new Date(NOW - (i + 3) * 60 * 60 * 1000).toISOString() } }));
  }
  const fetched = [];
  const deps = {
    now: () => new Date(NOW), graphVersion: "v1",
    db: { updateDistribution: async () => {} },
    meta: { fetchPostMetrics: async ({ postId }) => { fetched.push(postId); return { likes: 1 }; } },
  };
  const connReads = [];
  const getConnection = async (phone) => {
    connReads.push(phone);
    return phone === "9721" ? { page_token: "t", page_id: "pg" } : null;
  };
  const started = await refreshStaleAcrossAgents(deps, many, getConnection);
  await new Promise((r) => setTimeout(r, 10));
  // The ten oldest reads are s5..s14; s12..s14 belong to 9723, who has no
  // token, so seven start — the cap bounds the batch, the token bounds the rest.
  assert.equal(metrics.MAX_PER_REQUEST, 10);
  assert.deepEqual(connReads.sort(), ["9721", "9723"], "one connection read per owner in the batch");
  assert.ok(started.every((d) => d.business_phone === "9721"), "owner without a token is skipped");
  assert.equal(started.length, 7, "never more than the global cap per load");
  assert.deepEqual(fetched.sort(), ["s10", "s11", "s5", "s6", "s7", "s8", "s9"],
    "oldest-read posts go first, whoever owns them");

  // ── nothing stale → nothing read ──
  const quiet = [];
  const none = await refreshStaleAcrossAgents(deps,
    [dist({ id: "q", page_id: "Q", phone: "9721", metrics: { likes: 0, fetched_at: fresh } })],
    async (p) => { quiet.push(p); return { page_token: "t" }; });
  assert.deepEqual(none, []);
  assert.deepEqual(quiet, [], "no connection read when nothing is due");

  console.log("admin-social.test.js: ok");
})().catch((e) => { console.error(e); process.exit(1); });
