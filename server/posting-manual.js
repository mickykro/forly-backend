/*
 * posting-manual.js — group posts published by hand (launch, 4 Oct 2026).
 *
 * POSTING_MANUAL=1: the agent approves every group's text up front on the
 * web; an admin publishes it from the admin "פרסום ידני" tab in a live
 * browser on the agent's own profile and ticks each group off here. No
 * automatic posting, no planner, no WhatsApp until the campaign is complete:
 * then one message with the groups it went up in. The campaign's expires_at
 * holds here as in automatic posting: the checklist ends a campaign past it
 * (completed, expired — the sweeper's own housekeeping never runs in manual
 * mode), and markDone refuses one past it. The checklist lists no expired
 * campaign; it ends one only where posting may change state at all
 * (posting-guard.postingEnvAllowed: never from staging, which shares
 * production's Firestore).
 */
const crypto = require("crypto");
const A = require("./posting-account");
const C = require("./posting-campaign");
const L = require("./posting-limits");

const enabled = (env = process.env) => env.POSTING_MANUAL === "1";

// An agent as the admin page sees it: never the phone.
const refOf = (phone) => `acct_${crypto.createHmac("sha256", process.env.PROFILE_KEY || "forly-manual").update(`${phone}|manual-ref`).digest("hex").slice(0, 24)}`;

const DONE = new Set(["posted", "skipped", "pending_group_approval"]);
const expired = (c, now) => Number.isFinite(new Date(c.expires_at).getTime()) && now.getTime() > new Date(c.expires_at).getTime();
// A running campaign past its end: completed (expired), its open posts
// skipped, the agent told — as posting-tick's housekeeping does. The agent
// hears it once: only the call whose transaction made the change says so
// (two checklist polls may meet the same campaign).
async function expire(c, deps, x) {
  if (!require("./posting-guard").postingEnvAllowed(deps.env || process.env)) return null;
  let changed = false;
  const next = await A.mutate(x, c.id, (cur) => {
    if (cur.status !== "running") return null;
    changed = true;
    return {
      status: "completed", pause_reason: "expired",
      posts: (cur.posts || []).map((p) => (["scheduled", "pending_approval"].includes(p.status) ? { ...p, status: "skipped", error_code: "expired", copy: undefined } : p)),
    };
  });
  if (changed && next && next.status === "completed") await A.say(deps, next.phone, "completed", "🎉 הפרסום הושלם", next);
  return next;
}
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

// Every version of the post text for a property, in template order (the
// manual tab offers them all next to the browser). The link is the same one
// the campaign's own text carries.
function versions(page, base) {
  const shareKit = require("./distribution/share-kit");
  const url = base ? require("./posting-destination").previewUrl({ kind: "property" }, { pageBaseUrl: base, pageId: page.page_id }) : "";
  const out = [];
  for (let r = 0; r < shareKit.TEMPLATE_COUNT; r++) {
    out.push(shareKit.buildPostCopy({ property: page.property || {}, agent: page.agent || {} }, url, { variantRound: r, linkInComment: !url }));
  }
  return out;
}

// The groups the agent picked for a property, each with where it stands in
// the current pass: owed, posted or skipped (with the approved text, if any).
function groupsOf(c) {
  if (!c) return [];
  const last = new Map();
  for (const p of A.currentPosts(c)) if (p && p.group_id) last.set(String(p.group_id), p);
  return (c.groups || []).map((g) => {
    const p = last.get(String(g.group_id));
    const status = p && DONE.has(p.status) ? (p.status === "skipped" ? "skipped" : "posted") : "owed";
    return { group_id: String(g.group_id), name: g.name || "", url: urlOf(g), status, copy: g.copy || null, posted_at: status === "posted" ? p.posted_at || null : null };
  });
}

// The admin's checklist: every running campaign (oldest first) with ALL its
// groups and where each stands, so nothing is missed. Owed groups carry the
// text to post (the approved one, else the campaign's own).
async function checklist(deps = {}) {
  const x = A.ctxOf(deps);
  const running = (await x.store.listPostingCampaignsByStatus("running", 500))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const config = await A.configOf(deps, x);
  const now = x.clock();
  const byPhone = new Map(); // the agent's campaigns, connection and other posts, for the group limits
  const agentOf = async (phone) => {
    if (!byPhone.has(phone)) byPhone.set(phone, L.agentPosts(phone, deps, x, now));
    return byPhone.get(phone);
  };
  const out = [];
  const pages = await Promise.all(running.map((c) => x.db.getPage(c.page_id)));
  for (const [i, c] of running.entries()) {
    const page = pages[i];
    if (!page) continue;
    if (expired(c, now)) { await expire(c, deps, x); continue; }
    const agent = await agentOf(c.phone);
    const limits = L.limitsFor(c, agent.campaigns, now, config, agent);
    const byId = new Map((c.groups || []).map((g) => [String(g.group_id), g]));
    out.push({
      ref: refOf(c.phone), campaign_id: c.id, phone_tail: A.tail(c.phone), awaiting_agent: c.awaiting_texts === true,
      agent_name: (page.agent && page.agent.name) || "", page_id: c.page_id,
      title: (page.property && page.property.title) || c.page_id, page_url: pageUrlOf(c.page_id, deps.pageBaseUrl),
      groups: groupsOf(c).map((g) => {
        const withLimit = g.status === "owed" ? { ...g, limit: limits[g.group_id] || null } : g;
        return withLimit.status !== "owed" || withLimit.copy ? withLimit
          : { ...withLimit, copy: C.buildCopy(page, c, { ...byId.get(g.group_id), target: "group" }, "property", deps.pageBaseUrl || "") };
      }),
    });
  }
  return out;
}

// The work list: one item per group still owed, from the checklist.
function queueOf(list) {
  const out = [];
  for (const c of list) {
    for (const g of c.groups) {
      if (g.status !== "owed") continue;
      const { groups, ...head } = c; // eslint-disable-line no-unused-vars
      out.push({ ...head, group_id: g.group_id, group_name: g.name, group_url: g.url, copy: g.copy });
    }
  }
  return out;
}
const queue = async (deps = {}) => queueOf(await checklist(deps));

// One group done by hand: "posted" or "skipped". → the campaign, or null when
// that group is not owed (not in the campaign, already done, campaign over).
async function markDone(campaignId, groupId, status, deps = {}) {
  if (!["posted", "skipped"].includes(status)) return null;
  const x = A.ctxOf(deps), now = A.iso(x.clock());
  const id = crypto.randomUUID();
  let finished = false, past = false;
  const next = await A.mutate(x, String(campaignId), (cur) => {
    if (!cur || cur.status !== "running") return null;
    if (expired(cur, x.clock())) { past = true; return null; }
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
  if (past) { await expire({ id: String(campaignId) }, deps, x); return null; }
  if (!next || !(next.posts || []).some((p) => p && p.id === id)) return null;
  if (finished) await A.say(deps, next.phone, "completed", "🎉 הפרסום הושלם", next);
  return next;
}

module.exports = { enabled, refOf, owed, expired, propertyCard, versions, groupsOf, checklist, queueOf, queue, markDone };
