/*
 * posting-manual.js — posts published by hand (launch, 4 Oct 2026).
 *
 * POSTING_MANUAL=1: the agent approves every group's text up front on the
 * web; an admin publishes it from the admin "פרסום ידני" tab in a live
 * browser on the agent's own profile and ticks each target off here. No
 * automatic posting, no planner, no WhatsApp until the campaign is complete:
 * then one message with the groups it went up in. A campaign's targets are
 * the same as in automatic posting: its groups, its Page when targeted, and
 * — for a repeating campaign — each group again every repeat_days (the Page
 * every 30 days) until expires_at; by hand there is nothing Facebook could
 * tell from the agent's own posting. The campaign's expires_at
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
const safety = require("./posting-safety");

const enabled = (env = process.env) => env.POSTING_MANUAL === "1";

// An agent as the admin page sees it: never the phone.
const refOf = (phone) => `acct_${crypto.createHmac("sha256", process.env.PROFILE_KEY || "forly-manual").update(`${phone}|manual-ref`).digest("hex").slice(0, 24)}`;

const DONE = new Set(["posted", "skipped", "pending_group_approval"]);
const MS_DAY = 86400000, MS_HOUR = 3600000, PAGE_DAYS = 30;
const expired = (c, now) => Number.isFinite(new Date(c.expires_at).getTime()) && now.getTime() > new Date(c.expires_at).getTime();
// A running campaign past its end: completed (expired), its open posts
// skipped, the agent told — as posting-tick's housekeeping does. The agent
// hears it once: only the call whose transaction made the change says so
// (two checklist polls may meet the same campaign). The flag is reset on
// every run of the callback: Firestore re-runs it on contention, and the
// re-run on a campaign another call just ended must leave it false.
async function expire(c, deps, x) {
  if (!require("./posting-guard").postingEnvAllowed(deps.env || process.env)) return null;
  let changed = false;
  const next = await A.mutate(x, c.id, (cur) => {
    changed = false;
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

// The campaign's targets by hand: its Page first when targeted and known
// (A.pageTarget: the agent's explicit choice, with its numeric id), then its
// groups in campaign order. Each carries `kind` ("page" | "group").
function targetsOf(c, conn) {
  const out = (c.groups || []).filter((g) => g && g.group_id).map((g) => ({ ...g, kind: "group" }));
  const pt = (c.targets || []).includes("page") ? A.pageTarget(conn) : null;
  if (pt) out.unshift({ group_id: pt.group_id, url: pt.url, name: pt.name || "", target: "page", target_id: pt.target_id, kind: "page" });
  return out;
}
// The targets still owed a post now, in order (groupsOf's "owed").
const owed = (c, conn, now, config) => groupsOf(c, conn, now, config).filter((g) => g.status === "owed");

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

// The campaign's targets, each with where it stands now: owed, posted or
// skipped (with the approved text, if any). A target with no post this pass
// is owed. A repeating campaign owes a group again when the pacer would let
// the property back in (posting-safety.groupBlock's property cooldown:
// repeat_days, an hour short, never under property_group_cooldown_days) and
// the Page after 30 days; a campaign that does not repeat owes nothing
// twice. `now` is needed only for a repeating campaign; `config` for its
// cooldown floor (the defaults otherwise).
function groupsOf(c, conn = null, now = null, config = null) {
  if (!c) return [];
  const at = (p) => new Date(p.posted_at || p.scheduled_at || p.created_at || 0).getTime();
  const last = new Map();
  for (const p of A.currentPosts(c)) {
    if (!p || !p.group_id || !DONE.has(p.status)) continue;
    const k = String(p.group_id), prev = last.get(k);
    if (!prev || at(p) >= at(prev)) last.set(k, p);
  }
  const t = now ? now.getTime() : null;
  const floor = ((config || safety.DEFAULTS).property_group_cooldown_days || 0) * MS_DAY;
  const again = (g) => (!c.repeat ? Infinity : g.kind === "page" ? PAGE_DAYS * MS_DAY : Math.max((Number(c.repeat_days) || 0) * MS_DAY - MS_HOUR, floor, MS_HOUR));
  return targetsOf(c, conn).map((g) => {
    const p = last.get(String(g.group_id));
    const due = !!p && t !== null && t - at(p) >= again(g);
    const status = !p || due ? "owed" : p.status === "skipped" ? "skipped" : "posted";
    return { group_id: String(g.group_id), kind: g.kind, name: g.name || "", url: g.kind === "page" ? g.url : urlOf(g), status, copy: g.kind === "page" ? null : g.copy || null,
      posted_at: p && p.status !== "skipped" ? p.posted_at || null : null };
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
    const byId = new Map(targetsOf(c, agent.conn).map((g) => [String(g.group_id), g]));
    out.push({
      ref: refOf(c.phone), campaign_id: c.id, phone_tail: A.tail(c.phone), awaiting_agent: c.awaiting_texts === true,
      agent_name: (page.agent && page.agent.name) || "", page_id: c.page_id,
      title: (page.property && page.property.title) || c.page_id, page_url: pageUrlOf(c.page_id, deps.pageBaseUrl),
      repeat_days: c.repeat ? c.repeat_days || null : null,
      groups: groupsOf(c, agent.conn, now, config).map((g) => {
        const withLimit = g.status === "owed" && g.kind === "group" ? { ...g, limit: limits[g.group_id] || null } : g;
        const tg = byId.get(g.group_id);
        return withLimit.status !== "owed" || withLimit.copy ? withLimit
          : { ...withLimit, copy: C.buildCopy(page, c, { ...tg, target: tg.kind === "page" ? "page" : "group" }, "property", deps.pageBaseUrl || "") };
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

// One target done by hand: "posted" or "skipped". → the campaign, or null
// when that target is not owed (not in the campaign, already done, campaign
// over). A campaign that does not repeat completes with its last target; a
// repeating one runs until expires_at.
async function markDone(campaignId, groupId, status, deps = {}) {
  if (!["posted", "skipped"].includes(status)) return null;
  const x = A.ctxOf(deps), at = x.clock(), now = A.iso(at);
  const head = await x.store.getPostingCampaign(String(campaignId));
  if (!head) return null;
  const conn = (await x.db.getConnection(head.phone)) || {};
  const config = await A.configOf(deps, x);
  const id = crypto.randomUUID();
  let finished = false, past = false;
  const next = await A.mutate(x, String(campaignId), (cur) => {
    finished = false; past = false;
    if (!cur || cur.status !== "running") return null;
    if (expired(cur, at)) { past = true; return null; }
    const g = owed(cur, conn, at, config).find((q) => String(q.group_id) === String(groupId));
    if (!g) return null;
    // created_at: what A.currentPosts keys a restarted campaign's pass on — without it the post is not this pass's.
    const post = {
      id, target: g.kind === "page" ? "page" : "group", group_id: String(g.group_id), group_url: g.url, group_name: g.name || null, manual: true,
      status, created_at: now, scheduled_at: now, posted_at: status === "posted" ? now : null, error_code: status === "skipped" ? "manual_skip" : null,
    };
    const posts = (cur.posts || []).concat([post]);
    finished = !cur.repeat && owed({ ...cur, posts }, conn, at, config).length === 0;
    return finished ? { posts, status: "completed" } : { posts };
  });
  if (past) { await expire({ id: String(campaignId) }, deps, x); return null; }
  if (!next || !(next.posts || []).some((p) => p && p.id === id)) return null;
  if (finished) await A.say(deps, next.phone, "completed", "🎉 הפרסום הושלם", next);
  return next;
}

module.exports = { enabled, refOf, owed, targetsOf, expired, propertyCard, versions, groupsOf, checklist, queueOf, queue, markDone };
