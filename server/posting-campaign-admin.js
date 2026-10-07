// server/posting-campaign-admin.js
/*
 * posting-campaign-admin.js — an admin's edit of a live campaign, in one
 * campaign transaction: groups added and removed, per-group texts, end date,
 * repeat, targets, mode. `version` is the campaign's updated_at as the admin
 * loaded it; a campaign changed since is refused (stale_version), never
 * overwritten. Removing a group drops its not-yet-started posts (skipped,
 * error_code "removed") and keeps its history; a group with an attempt past
 * reservation is refused (busy) — that post is already on its way.
 */
const A = require("./posting-account");
const C = require("./posting-campaign");
const shareKit = require("./distribution/share-kit");
const localMode = require("./posting-local");

const { iso, fail, ctxOf, nowOf, MS_DAY } = A;
const LIVE = new Set(["running", "paused"]);
const NOT_STARTED = new Set(["scheduled", "pending_approval"]);

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

  let refused = null;
  const out = await A.mutate(x, id, (cur) => {
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
    return patch;
  });
  if (refused) throw fail(refused);
  return out;
}

module.exports = { update };
