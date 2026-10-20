/*
 * posting-metrics.js — what a campaign's group posts did (Task 22), one row
 * per post that went out:
 *   visits     tracked-link visits (portal_events group_visit, R4 ?c=)
 *   leads      leads attributed through that link (fly_ref → lead_submissions.attribution)
 *   reactions, comments, visibility, checked_at
 *              the 24 h re-check's aggregates on the attempt (posting-recheck.js)
 * Keyed by the post's attempt, never by anything the visitor sent. Reach and
 * impressions exist only through Graph (metrics.js, Page posts); a group has
 * none, and the card says so.
 */
const attribution = require("./posting-attribution");

const SHOWN = new Set(["posted", "pending_group_approval"]);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

// forCampaign(campaign, deps) → { [postId]: { visits, leads, reactions, comments, visibility, checked_at } }
async function forCampaign(c, deps = {}) {
  const posts = (c && Array.isArray(c.posts) ? c.posts : []).filter((p) => p && p.id && p.attempt_key && SHOWN.has(p.status));
  if (!posts.length) return {};
  const store = deps.store || require("./posting-store");
  const [visits, leads, attempts] = await Promise.all([
    attribution.countGroupVisits(c.id), attribution.countLeadsByAttribution(c.id),
    Promise.all(posts.map((p) => store.getAttempt(p.attempt_key))), // concurrent, never one round trip per post in turn
  ]);
  const out = {};
  posts.forEach((p, i) => {
    const a = attempts[i] || {};
    out[p.id] = {
      visits: visits[p.attempt_key] || 0, leads: leads[p.attempt_key] || 0,
      reactions: count(a.reactions), comments: count(a.comments),
      visibility: typeof a.visibility === "string" ? a.visibility : null, checked_at: a.checked_at || null,
    };
  });
  return out;
}

module.exports = { forCampaign };
