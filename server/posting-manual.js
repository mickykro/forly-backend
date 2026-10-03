/*
 * posting-manual.js — group posts published by hand (launch, 4 Oct 2026).
 *
 * POSTING_MANUAL=1: the agent approves every group's text up front on the
 * web; an admin publishes it from the admin "פרסום ידני" tab in a live
 * browser on the agent's own profile and ticks each group off here. No
 * automatic posting, no planner, no WhatsApp until the campaign is complete:
 * then one message with the groups it went up in.
 */
const crypto = require("crypto");
const A = require("./posting-account");
const C = require("./posting-campaign");

const enabled = (env = process.env) => env.POSTING_MANUAL === "1";

// An agent as the admin page sees it: never the phone.
const refOf = (phone) => `acct_${crypto.createHmac("sha256", process.env.PROFILE_KEY || "forly-manual").update(`${phone}|manual-ref`).digest("hex").slice(0, 24)}`;

const DONE = new Set(["posted", "skipped", "pending_group_approval"]);
const urlOf = (g) => g.url || g.canonical_url || `https://www.facebook.com/groups/${g.group_id}`;
const pageUrlOf = (pageId, base) => `${String(base || "").replace(/\/+$/, "")}/p/${pageId}`;

// The campaign's groups this pass still owes a post, in campaign order.
function owed(c) {
  const done = new Set(A.currentPosts(c).filter((p) => p && DONE.has(p.status)).map((p) => String(p.group_id)));
  return (c.groups || []).filter((g) => g && !done.has(String(g.group_id)));
}

// What the session is sharing, for the admin's header. video_url is what the
// browser can play; the server uploads from C.videoOf(page) itself.
function propertyCard(page, base) {
  const p = (page && page.property) || {};
  const v = C.videoView(C.videoOf(page));
  return {
    page_id: page.page_id, title: p.title || page.page_id, address: [p.neighborhood, p.city].filter(Boolean).join(", "),
    price: Number(p.price) > 0 ? Number(p.price) : null, rooms: p.rooms || null, size_sqm: p.size_sqm || null, floor: p.floor || null,
    listing_type: p.listing_type || null, page_url: pageUrlOf(page.page_id, base), video_url: v.video_url, poster_url: v.poster_url,
  };
}

// The admin's work list: one item per group still owed, oldest campaign first.
async function queue(deps = {}) {
  const x = A.ctxOf(deps);
  const running = (await x.store.listPostingCampaignsByStatus("running", 500))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const out = [];
  for (const c of running) {
    const page = await x.db.getPage(c.page_id);
    if (!page) continue;
    for (const g of owed(c)) {
      out.push({
        ref: refOf(c.phone), campaign_id: c.id, phone_tail: A.tail(c.phone),
        agent_name: (page.agent && page.agent.name) || "", page_id: c.page_id,
        title: (page.property && page.property.title) || c.page_id, page_url: pageUrlOf(c.page_id, deps.pageBaseUrl),
        group_id: String(g.group_id), group_name: g.name || "", group_url: urlOf(g),
        copy: g.copy || C.buildCopy(page, c, { ...g, target: "group" }, "property", deps.pageBaseUrl || ""),
      });
    }
  }
  return out;
}

// One group done by hand: "posted" or "skipped". → the campaign, or null when
// that group is not owed (not in the campaign, already done, campaign over).
async function markDone(campaignId, groupId, status, deps = {}) {
  if (!["posted", "skipped"].includes(status)) return null;
  const x = A.ctxOf(deps), now = A.iso(x.clock());
  const id = crypto.randomUUID();
  let finished = false;
  const next = await A.mutate(x, String(campaignId), (cur) => {
    if (!cur || cur.status !== "running") return null;
    const g = owed(cur).find((q) => String(q.group_id) === String(groupId));
    if (!g) return null;
    const post = {
      id, target: "group", group_id: String(g.group_id), group_url: urlOf(g), group_name: g.name || null, manual: true,
      status, scheduled_at: now, posted_at: status === "posted" ? now : null, error_code: status === "skipped" ? "manual_skip" : null,
    };
    const posts = (cur.posts || []).concat([post]);
    finished = owed({ ...cur, posts }).length === 0;
    return finished ? { posts, status: "completed" } : { posts };
  });
  if (!next || !(next.posts || []).some((p) => p && p.id === id)) return null;
  if (finished) await A.say(deps, next.phone, "completed", "🎉 הפרסום הושלם", next);
  return next;
}

module.exports = { enabled, refOf, owed, propertyCard, queue, markDone };
