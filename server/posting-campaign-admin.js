// server/posting-campaign-admin.js
/*
 * posting-campaign-admin.js — an admin's edit of a live campaign, in one
 * campaign transaction: groups added and removed, per-group texts, end date,
 * repeat, targets, mode. `version` is the campaign's updated_at as the admin
 * loaded it; a campaign changed since is refused (stale_version), never
 * overwritten. Removing a group drops its not-yet-started posts (skipped,
 * error_code "removed") and keeps its history; a group with an attempt past
 * reservation is refused (busy) — that post is already on its way. An edit
 * that leaves nowhere to post (no group, no Page; manual posting has no
 * Page) is refused (no_destination).
 * Targets and mode reconcile the posts already planned: a post to a target
 * no longer wanted is skipped (target_removed; one already posting refuses
 * the edit, busy); standing → per_post sends unapproved scheduled posts back
 * to the agent (pending_approval); per_post → standing schedules the posts
 * still waiting for approval.
 */
const A = require("./posting-account");
const C = require("./posting-campaign");
const shareKit = require("./distribution/share-kit");
const localMode = require("./posting-local");

const { iso, fail, ctxOf, nowOf, MS_DAY } = A;
const LIVE = new Set(["running", "paused"]);
const NOT_STARTED = new Set(["scheduled", "pending_approval"]);
const kindOf = (p) => (p.target === "page" ? "page" : "groups");

function withCopy(g, text) {
  const t = C.cleanCopy(text);
  if (t) return Object.assign({}, g, { copy: t });
  const { copy, ...rest } = g; // an emptied text: back to the generated copy
  return rest;
}

async function update(id, edit = {}, deps = {}, { version, by = "admin" } = {}) {
  const x = ctxOf(deps);
  const now = nowOf(deps, x);
  const c = await x.store.getPostingCampaign(id);
  if (!c) throw fail("not_found");
  if (!LIVE.has(c.status)) throw fail("not_live");
  const remove = new Set((edit.remove_group_ids || []).map(String));
  if (remove.size) {
    const open = await x.store.listOpenAttemptsByCampaign(id);
    if (open.some((a) => a.target_type === "group" && remove.has(String(a.target_id)))) throw fail("busy");
  }
  const page = (await x.db.getPage(c.page_id)) || {};
  const conn = (await x.db.getConnection(c.phone)) || {};
  const ctx = { conn, catalog: await A.catalogIndex(x.db), listingType: (page.property || {}).listing_type || null, now };
  const added = Array.isArray(edit.add_groups) && edit.add_groups.length ? C.normalizeGroups(edit.add_groups, ctx) : [];
  const env = deps.env || process.env;
  const manual = require("./posting-manual").enabled(env);

  let refused = null, sentBack = [];
  const out = await A.mutate(x, id, (cur) => {
    sentBack = [];
    if (!LIVE.has(cur.status)) { refused = "not_live"; return null; }
    if (version && cur.updated_at !== version) { refused = "stale_version"; return null; }
    if ((cur.posts || []).some((p) => p.status === "posting" && remove.has(String(p.group_id)))) { refused = "busy"; return null; }
    let groups = (cur.groups || []).filter((g) => !remove.has(String(g.group_id)));
    const have = new Set(groups.map((g) => g.group_id));
    groups = groups.concat(added.filter((g) => !have.has(g.group_id))).slice(0, shareKit.MAX_GROUPS);
    if (edit.copies) groups = groups.map((g) => (typeof edit.copies[g.group_id] === "string" ? withCopy(g, edit.copies[g.group_id]) : g));
    const patch = { groups, wait_reason: null, last_changed_by: { by, at: iso(now) } };
    if (remove.size) {
      patch.posts = (cur.posts || []).map((p) => (remove.has(String(p.group_id)) && NOT_STARTED.has(p.status)
        ? { ...p, status: "skipped", error_code: "removed", copy: undefined } : p));
    }
    // A re-added group is owed again: its "removed" posts of this pass would read as done.
    const readded = new Set(added.map((g) => String(g.group_id)).filter((id) => !(cur.groups || []).some((g) => String(g.group_id) === id)));
    if (readded.size) {
      const stale = new Set(A.currentPosts(cur).filter((p) => p.error_code === "removed" && readded.has(String(p.group_id))).map((p) => p.id));
      if (stale.size) patch.posts = (patch.posts || cur.posts || []).filter((p) => !stale.has(p.id));
    }
    if (edit.days !== undefined) patch.expires_at = iso(now.getTime() + Math.min(Math.max(Number(edit.days) || 30, 1), 30) * MS_DAY);
    if (edit.repeat_days !== undefined) {
      const n = Number(edit.repeat_days) || 0;
      patch.repeat = n > 0;
      patch.repeat_days = n > 0 ? Math.min(30, Math.max(3, Math.round(n))) : null;
    }
    if (Array.isArray(edit.targets)) patch.targets = A.targetsFor(conn, edit.targets);
    if (edit.mode) patch.mode = localMode.requireApproval(env) || edit.mode === "per_post" ? "per_post" : "standing";
    const targets = patch.targets || cur.targets || ["groups"];
    const pageOn = targets.includes("page") && !manual && !!A.pageTarget(conn);
    if (!groups.length && !pageOn) { refused = "no_destination"; return null; }
    const mode = patch.mode || cur.mode;
    const posts = patch.posts || cur.posts || [];
    if (posts.some((p) => p.status === "posting" && !targets.includes(kindOf(p)))) { refused = "busy"; return null; }
    const toApprove = mode === "per_post" && cur.mode !== "per_post";
    const toSchedule = mode !== "per_post" && cur.mode === "per_post";
    if (patch.targets || toApprove || toSchedule) {
      patch.posts = posts.map((p) => {
        if (!NOT_STARTED.has(p.status)) return p;
        if (!targets.includes(kindOf(p))) return { ...p, status: "skipped", error_code: "target_removed", copy: undefined };
        if (toApprove && p.status === "scheduled" && !p.approved_at) { sentBack.push(p.id); return { ...p, status: "pending_approval" }; }
        if (toSchedule && p.status === "pending_approval") return { ...p, status: "scheduled", scheduled_at: iso(Math.max(now.getTime(), new Date(p.scheduled_at).getTime() || 0)) };
        return p;
      });
    }
    return patch;
  });
  if (refused) throw fail(refused);
  // Posts sent back for approval: the agent gets each one, as the planner sends them.
  for (const p of (out && out.posts) || []) {
    if (p.status === "pending_approval" && sentBack.includes(p.id)) {
      await A.say(deps, out.phone, "approve", `📣 פוסט מוכן לאישור ל${p.target === "page" ? "דף העסקי" : `קבוצה "${p.group_name || p.group_url}"`}:\n──────────\n${p.copy}\n──────────`, out, p);
    }
  }
  return out;
}

module.exports = { update };
